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
//!    order): `[Collateral, PriceUpdateV2, Mint]`. The mint carries the
//!    Token-2022 scaled-UI multiplier (splits and dividends, `06` §7): a
//!    raw token is worth `multiplier × price`.

use crate::error::{CoreResultExt, FloyDexError};
use crate::oracle::read_pyth;
use crate::state::*;
use anchor_lang::prelude::*;
use protocol_core::{
    mul_div_floor, AccountSnapshot, CollateralBalance, MarketSnapshot, OracleGuard, OracleSnapshot,
    Position, PRECISION,
};
use risk_engine::{
    close_grace, closed_mark_price, resolve_session, scale_margin_bps, session_margin_bps_at,
    AccountHealth, MarketSession, SessionWindow,
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
    /// Snapshot with session-scaled (and ramped) margins, priced at `mark`.
    pub snapshot: MarketSnapshot,
    /// Inside a close's grace window: the maintenance bps at the pre-close
    /// multiplier, and when the ramp began (`07` §2). Liquidation only.
    pub grace: Option<(u32, u64)>,
}

impl MarketView {
    /// The snapshot liquidation should use for an account that last added
    /// exposure at `last_increase_ts`: inside the grace window, and with no
    /// exposure added since the ramp began, maintenance stays at the
    /// pre-close multiplier, so the multiplier alone cannot liquidate it.
    pub fn liquidation_snapshot(&self, last_increase_ts: u64) -> MarketSnapshot {
        let mut s = self.snapshot;
        if let Some((bps, ramp_start)) = self.grace {
            if last_increase_ts < ramp_start && bps < s.config.maintenance_margin_bps {
                s.config.maintenance_margin_bps = bps;
            }
        }
        s
    }
}

/// Resolve a market's session and mark from its account and its Pyth feed.
///
/// - Regular / Extended: the oracle must be fresh and tight; mark = oracle.
///   Margins ramp up over the hour before a scheduled close (`07` §2).
/// - Closed: mark = `closed_mark_price(last_oracle, mark_ema, t)`: the book
///   EMA clamped to a band around the last close (`07` §4); the feed may be
///   stale. Before any fill or posted mid the EMA is unset and the mark is
///   the last close.
/// - Halted: mark = last valid oracle price; reduce-only is enforced by the
///   caller through `may_increase_exposure`.
pub fn market_view(m: &Market, price_ai: &AccountInfo, now: u64) -> Result<MarketView> {
    require!(m.active != 0, FloyDexError::AssetDisabled);
    let raw = read_pyth(price_ai, &m.pyth_feed_id, m.pyth_shard_id)?;
    let mut windows = [SessionWindow {
        start: 0,
        end: 0,
        session: MarketSession::Closed,
    }; crate::constants::CALENDAR_LEN];
    let n = m.windows(&mut windows);
    let windows = &windows[..n];
    let session = resolve_session(windows, now, raw.publish_time, m.max_oracle_age_secs);
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
            require!(last > 0, FloyDexError::StaleOracle);
            let ema = m.mark_ema.get();
            let book = if ema > 0 { ema } else { last };
            (
                closed_mark_price(last, book, secs_closed(m, now), &policy).core()?,
                None,
            )
        }
        MarketSession::Halted => {
            let last = m.last_oracle_price.get();
            require!(last > 0, FloyDexError::StaleOracle);
            (last, None)
        }
    };
    let initial =
        session_margin_bps_at(m.initial_margin_bps, windows, now, session, &policy).core()?;
    let maintenance =
        session_margin_bps_at(m.maintenance_margin_bps, windows, now, session, &policy).core()?;
    let grace = match close_grace(windows, now, &policy) {
        Some((mult, ramp_start)) => Some((
            scale_margin_bps(m.maintenance_margin_bps, mult).core()?,
            ramp_start,
        )),
        None => None,
    };
    Ok(MarketView {
        market_id: m.market_id,
        session,
        mark,
        oracle,
        snapshot: m.snapshot(mark, initial, maintenance),
        grace,
    })
}

/// Seconds since the market was first seen Closed (0 if not closed).
pub fn secs_closed(m: &Market, now: u64) -> u64 {
    if m.closed_since == 0 {
        0
    } else {
        now.saturating_sub(m.closed_since)
    }
}

/// A collateral price seen while loading risk inputs.
#[derive(Clone, Copy, Debug)]
pub struct CollateralPrice {
    pub index: u8,
    pub price: i128,
    pub haircut_bps: u32,
}

/// Prices and market snapshots a user's health needs, loaded once from
/// accounts. Health itself is recomputed from the user's *current* state,
/// so settlement can check it again after mutating positions and balances.
pub struct RiskInputs {
    /// Snapshots for every position market except `known` ones.
    pub markets: Vec<MarketSnapshot>,
    pub prices: Vec<CollateralPrice>,
}

impl RiskInputs {
    pub fn price_of(&self, collateral_index: u8) -> Option<i128> {
        self.prices
            .iter()
            .find(|p| p.index == collateral_index)
            .map(|p| p.price)
    }
}

/// Pull the next `n` remaining accounts, or fail.
fn take<'info>(
    accs: &mut &'info [AccountInfo<'info>],
    n: usize,
) -> Result<&'info [AccountInfo<'info>]> {
    require!(accs.len() >= n, FloyDexError::InvalidRemainingAccounts);
    let (head, tail) = accs.split_at(n);
    *accs = tail;
    Ok(head)
}

/// Load a user's risk inputs, consuming their remaining accounts from `accs`
/// in the order documented at the top of this module. Markets whose id is in
/// `known` consume nothing; the caller supplies their snapshots.
///
/// `for_liquidation` applies each market's close grace window to this
/// account (see [`MarketView::liquidation_snapshot`]).
pub fn load_risk_inputs<'info>(
    user: &UserAccount,
    accs: &mut &'info [AccountInfo<'info>],
    settlement_index: u8,
    known: &[u16],
    now: u64,
    for_liquidation: bool,
) -> Result<RiskInputs> {
    let mut markets: Vec<MarketSnapshot> = Vec::with_capacity(usize::from(user.open_positions) + 1);
    for slot in user.positions.iter().filter(|p| p.in_use != 0) {
        let id = slot.market_id;
        if known.contains(&id) || markets.iter().any(|s| s.config.market_id == u32::from(id)) {
            continue;
        }
        let pair = take(accs, 2)?;
        let loader = AccountLoader::<Market>::try_from(&pair[0])
            .map_err(|_| error!(FloyDexError::InvalidRemainingAccounts))?;
        let m = loader.load()?;
        require!(m.market_id == id, FloyDexError::InvalidRemainingAccounts);
        let view = market_view(&m, &pair[1], now)?;
        markets.push(if for_liquidation {
            view.liquidation_snapshot(user.last_increase_ts)
        } else {
            view.snapshot
        });
    }

    let mut prices = Vec::with_capacity(user.balances.iter().filter(|b| b.in_use != 0).count() + 1);
    prices.push(CollateralPrice {
        index: settlement_index,
        price: PRECISION,
        haircut_bps: 0,
    });
    for b in user.balances.iter().filter(|b| b.in_use != 0) {
        if b.amount.get() == 0 || b.collateral_index == settlement_index {
            continue;
        }
        let triple = take(accs, 3)?;
        require_keys_eq!(
            *triple[0].owner,
            crate::ID,
            FloyDexError::InvalidRemainingAccounts
        );
        let c = Collateral::try_deserialize(&mut &triple[0].try_borrow_data()?[..])
            .map_err(|_| error!(FloyDexError::InvalidRemainingAccounts))?;
        require!(
            c.index == b.collateral_index,
            FloyDexError::InvalidRemainingAccounts
        );
        require_keys_eq!(
            triple[2].key(),
            c.mint,
            FloyDexError::InvalidRemainingAccounts
        );
        prices.push(collateral_price(&c, &triple[1], &triple[2], now)?);
    }
    Ok(RiskInputs { markets, prices })
}

/// One non-settlement collateral's price per raw token, and its haircut.
///
/// - A fresh, tight price: `multiplier × price` at `haircut_bps`.
/// - Stale, but no older than `max_closed_age_secs`: the underlying's market
///   is closed (or its feed is out), so the last price is used with
///   `closed_haircut_bps` on top (`06` §6; decided 2026-09-26: staleness is
///   the signal, so an outage in session is covered the same way).
/// - Older than that: `StaleOracle`.
pub fn collateral_price(
    c: &Collateral,
    price_ai: &AccountInfo,
    mint_ai: &AccountInfo,
    now: u64,
) -> Result<CollateralPrice> {
    let snap = read_pyth(price_ai, &c.pyth_feed_id, c.pyth_shard_id)?;
    let fresh = OracleGuard {
        max_age_secs: c.max_oracle_age_secs,
        max_confidence_bps: c.max_oracle_confidence_bps,
    };
    let haircut_bps = match snap.validate(now, &fresh) {
        Ok(()) => c.haircut_bps,
        Err(protocol_core::CoreError::StaleOracle) if c.max_closed_age_secs > 0 => {
            let closed = OracleGuard {
                max_age_secs: c.max_closed_age_secs,
                max_confidence_bps: c.max_oracle_confidence_bps,
            };
            snap.validate(now, &closed).core()?;
            core::cmp::min(c.haircut_bps.saturating_add(c.closed_haircut_bps), 10_000)
        }
        Err(e) => return Err(error!(FloyDexError::from(e))),
    };
    let multiplier = crate::token_ext::ui_multiplier(mint_ai, now as i64)?;
    Ok(CollateralPrice {
        index: c.index,
        price: mul_div_floor(snap.price, multiplier, PRECISION).core()?,
        haircut_bps,
    })
}

/// Positions and valued collateral from the user's current state.
fn snapshot_parts(
    user: &UserAccount,
    inputs: &RiskInputs,
) -> Result<(Vec<Position>, Vec<CollateralBalance>)> {
    // Exact capacities: the SBF heap is a 32 KB bump allocator that never frees.
    let open = user.positions.iter().filter(|p| p.in_use != 0).count();
    let mut positions = Vec::with_capacity(open);
    for slot in user.positions.iter().filter(|p| p.in_use != 0) {
        positions.push(slot.to_position(&user.owner));
    }
    let held = user.balances.iter().filter(|b| b.in_use != 0).count();
    let mut collateral = Vec::with_capacity(held);
    for b in user.balances.iter().filter(|b| b.in_use != 0) {
        let amount = b.amount.get();
        if amount == 0 {
            continue;
        }
        let p = inputs
            .prices
            .iter()
            .find(|p| p.index == b.collateral_index)
            .ok_or(FloyDexError::InvalidRemainingAccounts)?;
        // Value rounds toward −∞, so assets and debts are both counted conservatively.
        let value = mul_div_floor(amount, p.price, PRECISION).core()?;
        collateral.push(CollateralBalance {
            asset: [b.collateral_index; 32],
            amount,
            value,
            haircut_bps: p.haircut_bps,
        });
    }
    Ok((positions, collateral))
}

/// True if the user has an open position or owes anything.
pub fn has_risk(user: &UserAccount) -> bool {
    user.positions.iter().any(|p| p.in_use != 0)
        || user
            .balances
            .iter()
            .any(|b| b.in_use != 0 && b.amount.get() < 0)
}

/// Health of the user's current state. `markets` must cover every position.
pub fn health(
    user: &UserAccount,
    inputs: &RiskInputs,
    markets: &[MarketSnapshot],
) -> Result<AccountHealth> {
    let (positions, collateral) = snapshot_parts(user, inputs)?;
    let snapshot = AccountSnapshot {
        owner: user.owner.to_bytes(),
        collateral: &collateral,
        positions: &positions,
    };
    risk_engine::account_health(&snapshot, markets).core()
}

pub fn validate_withdrawal(
    user: &UserAccount,
    inputs: &RiskInputs,
    markets: &[MarketSnapshot],
    withdrawal_value: i128,
) -> Result<AccountHealth> {
    let (positions, collateral) = snapshot_parts(user, inputs)?;
    let snapshot = AccountSnapshot {
        owner: user.owner.to_bytes(),
        collateral: &collateral,
        positions: &positions,
    };
    risk_engine::validate_withdrawal(&snapshot, markets, withdrawal_value).core()
}

/// `risk_engine::plan_liquidation` on the user's current state.
pub fn plan_liquidation(
    user: &UserAccount,
    inputs: &RiskInputs,
    markets: &[MarketSnapshot],
    position_id: u64,
    partial_liquidation_bps: u32,
) -> Result<risk_engine::LiquidationPlan> {
    let (positions, collateral) = snapshot_parts(user, inputs)?;
    let snapshot = AccountSnapshot {
        owner: user.owner.to_bytes(),
        collateral: &collateral,
        positions: &positions,
    };
    risk_engine::plan_liquidation(&snapshot, markets, position_id, partial_liquidation_bps).core()
}
