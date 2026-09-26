//! Boundary between on-chain accounts and `risk-engine`.
//!
//! Health needs every market an account trades and a price for every
//! non-settlement collateral it holds. Those arrive as `remaining_accounts`
//! in a fixed order, so the program never trusts the caller to say which
//! account is which:
//!
//! 1. for each distinct market in the user's position slots (slot order),
//!    except a market the instruction already has loaded: `[Market, PriceUpdateV2]`
//! 2. for each non-settlement balance slot with a non-zero amount (slot
//!    order): `[Collateral, PriceUpdateV2]`

use crate::constants::MAX_POSITIONS;
use crate::error::{CoreResultExt, KryonError};
use crate::oracle::{read_pyth, read_pyth_checked};
use crate::state::*;
use anchor_lang::prelude::*;
use protocol_core::{
    mul_div_floor, AccountSnapshot, CollateralBalance, MarketSnapshot, OracleGuard, OracleSnapshot,
    Position, PRECISION,
};
use risk_engine::{
    closed_mark_price, resolve_session, session_margin_bps, AccountHealth, MarketSession,
    SessionWindow,
};

/// A market as the risk engine sees it right now.
#[derive(Clone, Copy, Debug)]
pub struct MarketView {
    pub market_id: u16,
    pub session: MarketSession,
    /// Price used for health and the execution band.
    pub mark: i128,
    /// The fresh, validated oracle reading, when the session has one.
    pub oracle: Option<OracleSnapshot>,
    /// Snapshot with session-scaled margins, priced at `mark`.
    pub snapshot: MarketSnapshot,
}

/// Resolve a market's session and mark from its account and its Pyth feed.
///
/// - Regular / Extended: the oracle must be fresh and tight; mark = oracle.
/// - Closed: mark = `closed_mark_price(last_oracle, last_oracle, t)` until the
///   Phase 2 book EMA exists (`05` §2); the feed may be stale.
/// - Halted: mark = last valid oracle price; reduce-only is enforced by the
///   caller through `may_increase_exposure`.
pub fn market_view(m: &Market, price_ai: &AccountInfo, now: u64) -> Result<MarketView> {
    require!(m.active != 0, KryonError::AssetDisabled);
    let raw = read_pyth(price_ai, &m.pyth_feed_id, m.pyth_shard_id)?;
    let mut windows = [SessionWindow {
        start: 0,
        end: 0,
        session: MarketSession::Closed,
    }; crate::constants::CALENDAR_LEN];
    let n = m.windows(&mut windows);
    let session = resolve_session(&windows[..n], now, raw.publish_time, m.max_oracle_age_secs);
    let policy = m.session_policy();
    let (mark, oracle) = match session {
        MarketSession::Regular | MarketSession::Extended => {
            let guard = OracleGuard {
                max_age_secs: m.max_oracle_age_secs,
                max_confidence_bps: m.max_oracle_confidence_bps,
            };
            raw.validate(now, &guard).core()?;
            (raw.price, Some(raw))
        }
        MarketSession::Closed => {
            let last = m.last_oracle_price.get();
            require!(last > 0, KryonError::StaleOracle);
            let secs_closed = if m.closed_since == 0 {
                0
            } else {
                now.saturating_sub(m.closed_since)
            };
            (
                closed_mark_price(last, last, secs_closed, &policy).core()?,
                None,
            )
        }
        MarketSession::Halted => {
            let last = m.last_oracle_price.get();
            require!(last > 0, KryonError::StaleOracle);
            (last, None)
        }
    };
    let initial = session_margin_bps(m.initial_margin_bps, session, &policy).core()?;
    let maintenance = session_margin_bps(m.maintenance_margin_bps, session, &policy).core()?;
    Ok(MarketView {
        market_id: m.market_id,
        session,
        mark,
        oracle,
        snapshot: m.snapshot(mark, initial, maintenance),
    })
}

/// Everything `risk-engine` needs about one user, loaded from accounts.
pub struct UserRisk {
    pub positions: Vec<Position>,
    pub collateral: Vec<CollateralBalance>,
    /// Market snapshots for every position except those in `known` markets,
    /// which the caller supplies.
    pub markets: Vec<MarketSnapshot>,
    /// PRECISION price per collateral index seen (settlement = 1.0).
    pub prices: Vec<(u8, i128)>,
}

impl UserRisk {
    pub fn price_of(&self, collateral_index: u8) -> Option<i128> {
        self.prices
            .iter()
            .find(|(i, _)| *i == collateral_index)
            .map(|(_, p)| *p)
    }
}

/// Pull the next `n` remaining accounts, or fail.
fn take<'info>(
    accs: &mut &'info [AccountInfo<'info>],
    n: usize,
) -> Result<&'info [AccountInfo<'info>]> {
    require!(accs.len() >= n, KryonError::InvalidRemainingAccounts);
    let (head, tail) = accs.split_at(n);
    *accs = tail;
    Ok(head)
}

/// Load a user's risk inputs, consuming their remaining accounts from `accs`.
/// Markets whose id is in `known` are skipped (no accounts consumed); the
/// caller adds their snapshots.
pub fn load_user_risk<'info>(
    user: &UserAccount,
    accs: &mut &'info [AccountInfo<'info>],
    settlement_index: u8,
    known: &[u16],
    now: u64,
) -> Result<UserRisk> {
    let mut positions = Vec::with_capacity(MAX_POSITIONS);
    let mut markets: Vec<MarketSnapshot> = Vec::with_capacity(4);
    for slot in user.positions.iter().filter(|p| p.in_use != 0) {
        positions.push(slot.to_position(&user.owner));
        let id = slot.market_id;
        if known.contains(&id) || markets.iter().any(|s| s.config.market_id == u32::from(id)) {
            continue;
        }
        let pair = take(accs, 2)?;
        let loader = AccountLoader::<Market>::try_from(&pair[0])
            .map_err(|_| error!(KryonError::InvalidRemainingAccounts))?;
        let m = loader.load()?;
        require!(m.market_id == id, KryonError::InvalidRemainingAccounts);
        markets.push(market_view(&m, &pair[1], now)?.snapshot);
    }

    let mut collateral = Vec::with_capacity(crate::constants::MAX_BALANCES);
    let mut prices = Vec::with_capacity(crate::constants::MAX_BALANCES);
    for b in user.balances.iter().filter(|b| b.in_use != 0) {
        let amount = b.amount.get();
        if amount == 0 {
            continue;
        }
        let (price, haircut_bps) = if b.collateral_index == settlement_index {
            (PRECISION, 0)
        } else {
            let pair = take(accs, 2)?;
            require_keys_eq!(
                *pair[0].owner,
                crate::ID,
                KryonError::InvalidRemainingAccounts
            );
            let c = Collateral::try_deserialize(&mut &pair[0].try_borrow_data()?[..])
                .map_err(|_| error!(KryonError::InvalidRemainingAccounts))?;
            require!(
                c.index == b.collateral_index,
                KryonError::InvalidRemainingAccounts
            );
            let guard = OracleGuard {
                max_age_secs: c.max_oracle_age_secs,
                max_confidence_bps: c.max_oracle_confidence_bps,
            };
            let snap = read_pyth_checked(&pair[1], &c.pyth_feed_id, c.pyth_shard_id, now, &guard)?;
            (snap.price, c.haircut_bps)
        };
        // Value rounds toward −∞, so both assets and debts are counted conservatively.
        let value = mul_div_floor(amount, price, PRECISION).core()?;
        collateral.push(CollateralBalance {
            asset: [b.collateral_index; 32],
            amount,
            value,
            haircut_bps,
        });
        prices.push((b.collateral_index, price));
    }
    Ok(UserRisk {
        positions,
        collateral,
        markets,
        prices,
    })
}

/// True if the user has an open position or owes anything.
pub fn has_risk(user: &UserAccount) -> bool {
    user.positions.iter().any(|p| p.in_use != 0)
        || user
            .balances
            .iter()
            .any(|b| b.in_use != 0 && b.amount.get() < 0)
}

pub fn health(
    user: &UserAccount,
    risk: &UserRisk,
    markets: &[MarketSnapshot],
) -> Result<AccountHealth> {
    let snapshot = AccountSnapshot {
        owner: user.owner.to_bytes(),
        collateral: &risk.collateral,
        positions: &risk.positions,
    };
    risk_engine::account_health(&snapshot, markets).core()
}

pub fn validate_withdrawal(
    user: &UserAccount,
    risk: &UserRisk,
    markets: &[MarketSnapshot],
    withdrawal_value: i128,
) -> Result<AccountHealth> {
    let snapshot = AccountSnapshot {
        owner: user.owner.to_bytes(),
        collateral: &risk.collateral,
        positions: &risk.positions,
    };
    risk_engine::validate_withdrawal(&snapshot, markets, withdrawal_value).core()
}
