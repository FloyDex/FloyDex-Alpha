//! `settle_fills`: the matcher submits fills of signed orders in one market.
//!
//! Per fill (`05` §2):
//! 1. operator + not paused (once per instruction);
//! 2. maker and taker signatures via Ed25519 introspection (`crate::ed25519`);
//! 3. the full `validate_fill` table, in the Stellar gateway's order;
//! 4. session: fills that add exposure need `may_increase_exposure`;
//! 5. position effects; 6. fees, OI, session-scaled initial margin per side;
//! 7. `OrderRecord` create/update (the operator pays rent).
//!
//! Remaining accounts, per fill, in order:
//! `[maker_user, taker_user, maker_order, taker_order, maker risk…, taker risk…]`
//! where "risk" is the layout in `crate::health`, skipping this market.

use crate::constants::*;
use crate::ed25519::{verified_signer, SigRef};
use crate::error::{CoreResultExt, KryonError};
use crate::events::{FillSettled, PositionChanged, SessionChanged};
use crate::health::{load_risk_inputs, market_view, require_initial_margin, MarketView};
use crate::position::{apply_side, trade_fee, SideOutcome};
use crate::state::*;
use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar::instructions as ix_sysvar;
use anchor_lang::system_program;
use protocol_core::{
    apply_bps, checked_add, checked_sub, wire_to_precision, OrderMsg, FLAGS_KNOWN, FLAG_IS_LONG,
    FLAG_REDUCE_ONLY,
};
use risk_engine::{may_increase_exposure, MarketSession};

/// The signed fields of one order, minus what the program already knows:
/// the domain (from `Exchange`) and the owner and sub-account (from the
/// verified `UserAccount`). Sizes and prices are u64 at 1e9.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct OrderArgs {
    pub market_id: u16,
    pub flags: u8,
    pub size: u64,
    pub limit_price: u64,
    pub nonce: u64,
    pub expiry_ts: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct FillArgs {
    pub maker: OrderArgs,
    pub taker: OrderArgs,
    /// u64 at 1e9.
    pub fill_size: u64,
    /// u64 at 1e9.
    pub fill_price: u64,
    pub maker_sig: SigRef,
    pub taker_sig: SigRef,
}

#[event_cpi]
#[derive(Accounts)]
pub struct SettleFills<'info> {
    #[account(seeds = [EXCHANGE_SEED], bump = exchange.bump)]
    pub exchange: Box<Account<'info, Exchange>>,
    /// Matcher key; pays `OrderRecord` rent.
    #[account(mut)]
    pub operator: Signer<'info>,
    #[account(mut, seeds = [MARKET_SEED, &market.load()?.market_id.to_le_bytes()], bump = market.load()?.bump)]
    pub market: AccountLoader<'info, Market>,
    /// Pyth feed for this market; checked against `Market` in `market_view`.
    /// CHECK: address, owner, discriminator and feed id are verified in `oracle::read_pyth`.
    pub price_update: UncheckedAccount<'info>,
    /// Settlement collateral: fees accrue here.
    #[account(
        mut,
        seeds = [COLLATERAL_SEED, exchange.settlement_mint.as_ref()],
        bump = settlement_collateral.bump,
    )]
    pub settlement_collateral: Box<Account<'info, Collateral>>,
    /// CHECK: the Instructions sysvar, pinned by address.
    #[account(address = ix_sysvar::ID)]
    pub instructions: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

/// One side of a fill after signature checks.
struct Side<'a, 'info> {
    user: &'a AccountLoader<'info, UserAccount>,
    order: OrderArgs,
    owner: Pubkey,
    sub_id: u8,
    record: &'info AccountInfo<'info>,
    filled_before: i128,
}

pub fn handle_settle_fills<'info>(
    ctx: Context<'_, '_, 'info, 'info, SettleFills<'info>>,
    fills: Vec<FillArgs>,
) -> Result<()> {
    let ex = &ctx.accounts.exchange;
    require!(
        ex.is_operator(&ctx.accounts.operator.key()),
        KryonError::NotOperator
    );
    require!(!ex.paused, KryonError::Paused);
    require!(!fills.is_empty(), KryonError::InvalidAmount);
    let now = Clock::get()?.unix_timestamp as u64;

    // The market view (session, mark, oracle) once per instruction.
    let view = {
        let m = ctx.accounts.market.load()?;
        market_view(&m, &ctx.accounts.price_update, now)?
    };
    record_market_observation(&ctx.accounts.market, &view, now)?;
    if let Some(changed) = session_change(&ctx.accounts.market, &view)? {
        emit_cpi!(changed);
    }

    let mut accs: &'info [AccountInfo<'info>] = ctx.remaining_accounts;
    let mut fees = 0i128;
    for fill in fills.iter() {
        let (event, maker_change, taker_change) = settle_one(&ctx, fill, &view, now, &mut accs)?;
        fees = checked_add(fees, checked_add(event.maker_fee, event.taker_fee).core()?).core()?;
        emit_cpi!(event);
        emit_cpi!(maker_change);
        emit_cpi!(taker_change);
    }
    require!(accs.is_empty(), KryonError::InvalidRemainingAccounts);
    let c = &mut ctx.accounts.settlement_collateral;
    c.fees_accrued = checked_add(c.fees_accrued, fees).core()?;
    Ok(())
}

/// Keep the last trusted oracle price (the anchor for Closed and Halted
/// marks) and when the market closed.
fn record_market_observation(
    market: &AccountLoader<Market>,
    view: &MarketView,
    now: u64,
) -> Result<()> {
    let mut m = market.load_mut()?;
    match view.session {
        MarketSession::Regular | MarketSession::Extended => {
            if let Some(o) = view.oracle {
                if o.publish_time >= m.last_oracle_publish_time {
                    m.last_oracle_price.set(o.price);
                    m.last_oracle_publish_time = o.publish_time;
                }
            }
            m.closed_since = 0;
        }
        MarketSession::Closed => {
            if m.closed_since == 0 {
                m.closed_since = now;
            }
        }
        MarketSession::Halted => {}
    }
    Ok(())
}

fn session_code(s: MarketSession) -> u8 {
    match s {
        MarketSession::Regular => SESSION_REGULAR,
        MarketSession::Extended => SESSION_EXTENDED,
        MarketSession::Closed => SESSION_CLOSED,
        MarketSession::Halted => SESSION_HALTED,
    }
}

fn session_change(
    market: &AccountLoader<Market>,
    view: &MarketView,
) -> Result<Option<SessionChanged>> {
    let mut m = market.load_mut()?;
    // `last_session` stores code + 1 so a fresh market (0) always reports.
    let code = session_code(view.session);
    if m.last_session == code + 1 {
        return Ok(None);
    }
    m.last_session = code + 1;
    Ok(Some(SessionChanged {
        market_id: m.market_id,
        session: code,
    }))
}

fn next<'info>(accs: &mut &'info [AccountInfo<'info>]) -> Result<&'info AccountInfo<'info>> {
    let (head, tail) = accs
        .split_first()
        .ok_or(KryonError::InvalidRemainingAccounts)?;
    *accs = tail;
    Ok(head)
}

fn encode(
    domain: [u8; 32],
    owner: &Pubkey,
    sub_id: u8,
    o: &OrderArgs,
) -> [u8; protocol_core::ORDER_MSG_LEN] {
    OrderMsg {
        domain,
        owner: owner.to_bytes(),
        sub_id,
        market_id: o.market_id,
        flags: o.flags,
        size: o.size,
        limit_price: o.limit_price,
        nonce: o.nonce,
        expiry_ts: o.expiry_ts,
    }
    .encode()
}

fn order_record_address(owner: &Pubkey, sub_id: u8, nonce: u64) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[ORDER_SEED, owner.as_ref(), &[sub_id], &nonce.to_le_bytes()],
        &crate::ID,
    )
}

/// Current `(filled, cancelled)` of an order's record; a missing record is
/// `(0, false)`. Checks the record's address.
fn read_record(
    record: &AccountInfo,
    owner: &Pubkey,
    sub_id: u8,
    nonce: u64,
) -> Result<(i128, bool)> {
    require_keys_eq!(
        record.key(),
        order_record_address(owner, sub_id, nonce).0,
        KryonError::InvalidRemainingAccounts
    );
    if record.owner == &system_program::ID {
        return Ok((0, false));
    }
    require_keys_eq!(
        *record.owner,
        crate::ID,
        KryonError::InvalidRemainingAccounts
    );
    let r = OrderRecord::try_deserialize(&mut &record.try_borrow_data()?[..])?;
    Ok((r.filled, r.is_cancelled()))
}

fn settle_one<'info>(
    ctx: &Context<'_, '_, 'info, 'info, SettleFills<'info>>,
    fill: &FillArgs,
    view: &MarketView,
    now: u64,
    accs: &mut &'info [AccountInfo<'info>],
) -> Result<(FillSettled, PositionChanged, PositionChanged)> {
    let ex = &ctx.accounts.exchange;
    let maker_ai = next(accs)?;
    let taker_ai = next(accs)?;
    let maker_record = next(accs)?;
    let taker_record = next(accs)?;
    let maker_loader: AccountLoader<'info, UserAccount> = AccountLoader::try_from(maker_ai)
        .map_err(|_| error!(KryonError::InvalidRemainingAccounts))?;
    let taker_loader: AccountLoader<'info, UserAccount> = AccountLoader::try_from(taker_ai)
        .map_err(|_| error!(KryonError::InvalidRemainingAccounts))?;
    require_keys_neq!(maker_ai.key(), taker_ai.key(), KryonError::SelfTrade);
    require!(
        maker_ai.is_writable && taker_ai.is_writable,
        KryonError::InvalidRemainingAccounts
    );

    // --- 2. signatures: the signer must be the owner or a live delegate ---
    let mut sides: [Side; 2] = [
        side(&maker_loader, fill.maker, maker_record)?,
        side(&taker_loader, fill.taker, taker_record)?,
    ];
    for (s, sig) in sides.iter().zip([fill.maker_sig, fill.taker_sig]) {
        let msg = encode(ex.domain, &s.owner, s.sub_id, &s.order);
        let signer = verified_signer(&ctx.accounts.instructions, sig, &msg)?;
        let u = s.user.load()?;
        require!(
            u.can_sign_orders(&signer, now as i64),
            KryonError::Ed25519PubkeyMismatch
        );
    }

    // --- 3. validate_fill (05 §2), exactly the Stellar gateway's checks ---
    let (maker, taker) = (&sides[0].order, &sides[1].order);
    let fill_size = wire_to_precision(fill.fill_size).core()?;
    let fill_price = wire_to_precision(fill.fill_price).core()?;
    require!(fill_size > 0 && fill_price > 0, KryonError::InvalidAmount);
    require_keys_neq!(sides[0].owner, sides[1].owner, KryonError::SelfTrade);
    require!(
        maker.market_id != 0
            && maker.market_id == taker.market_id
            && maker.market_id == view.market_id,
        KryonError::InvalidConfig
    );
    let maker_long = maker.flags & FLAG_IS_LONG != 0;
    let taker_long = taker.flags & FLAG_IS_LONG != 0;
    require!(maker_long != taker_long, KryonError::DirectionMismatch);
    for s in sides.iter_mut() {
        validate_order(s, fill_size, fill_price, now)?;
    }
    // Execution band around the mark (Stellar `validate_execution_price`).
    let max_delta = apply_bps(
        view.mark,
        ctx.accounts.market.load()?.max_execution_deviation_bps,
    )
    .core()?;
    let lower = checked_sub(view.mark, max_delta).core()?;
    let upper = checked_add(view.mark, max_delta).core()?;
    require!(
        fill_price >= lower && fill_price <= upper,
        KryonError::PriceOutsideBand
    );

    // --- risk inputs for each side's *other* markets, before any mutation ---
    let settlement_index = ex.settlement_collateral_index;
    let known = [view.market_id];
    let maker_inputs =
        load_risk_inputs(&*sides[0].user.load()?, accs, settlement_index, &known, now)?;
    let taker_inputs =
        load_risk_inputs(&*sides[1].user.load()?, accs, settlement_index, &known, now)?;

    // --- 5. position effects, 6. fees ---
    let (funding_long, funding_short) = {
        let m = ctx.accounts.market.load()?;
        (m.funding_long_index.get(), m.funding_short_index.get())
    };
    let fees = ex.fee_config;
    let mut outcomes: [SideOutcome; 2] = [SideOutcome::default(); 2];
    let mut fee_amounts = [0i128; 2];
    for (k, s) in sides.iter().enumerate() {
        let long = s.order.flags & FLAG_IS_LONG != 0;
        let reduce_only = s.order.flags & FLAG_REDUCE_ONLY != 0;
        let mut u = s.user.load_mut()?;
        let o = apply_side(
            &mut u,
            view.market_id,
            long,
            reduce_only,
            fill_size,
            fill_price,
            funding_long,
            funding_short,
        )?;
        let bps = if k == 0 {
            fees.maker_fee_bps
        } else {
            fees.taker_fee_bps
        };
        let fee = trade_fee(fill_size, fill_price, bps)?;
        u.apply_balance(settlement_index, checked_sub(o.pnl, fee).core()?)?;
        outcomes[k] = o;
        fee_amounts[k] = fee;
    }

    // --- OI and the session's exposure rule ---
    {
        let mut m = ctx.accounts.market.load_mut()?;
        let mut long = m.oi_long.get();
        let mut short = m.oi_short.get();
        for o in outcomes.iter() {
            long = checked_add(long, o.oi.long).core()?;
            short = checked_add(short, o.oi.short).core()?;
        }
        require!(
            long >= 0 && short >= 0 && long == short,
            KryonError::MathOverflow
        );
        m.oi_long.set(long);
        m.oi_short.set(short);
        if outcomes.iter().any(|o| o.increased) {
            let total = checked_add(long, short).core()?;
            let allowed = may_increase_exposure(
                view.session,
                total,
                m.max_open_interest.get(),
                &m.session_policy(),
            )
            .core()?;
            if !allowed {
                return Err(if view.session == MarketSession::Halted {
                    error!(KryonError::SessionExposureBlocked)
                } else {
                    error!(KryonError::OpenInterestExceeded)
                });
            }
        }
    }

    // --- session-scaled initial margin for each side, after the fill ---
    for (s, inputs) in sides.iter().zip([&maker_inputs, &taker_inputs]) {
        let mut markets = inputs.markets.clone();
        markets.push(view.snapshot);
        require_initial_margin(&*s.user.load()?, inputs, &markets)?;
    }

    // --- 7. order records ---
    for s in sides.iter() {
        let filled = checked_add(s.filled_before, fill_size).core()?;
        upsert_record(ctx, s, filled)?;
    }

    let change = |s: &Side, o: &SideOutcome| PositionChanged {
        owner: s.owner,
        sub_id: s.sub_id,
        market_id: view.market_id,
        position_id: o.position_id,
        is_long: o.is_long_after,
        size: o.size_after,
        entry_price: o.entry_after,
        realized_pnl: o.pnl,
    };
    Ok((
        FillSettled {
            market_id: view.market_id,
            maker: sides[0].owner,
            taker: sides[1].owner,
            size: fill_size,
            price: fill_price,
            maker_fee: fee_amounts[0],
            taker_fee: fee_amounts[1],
        },
        change(&sides[0], &outcomes[0]),
        change(&sides[1], &outcomes[1]),
    ))
}

fn side<'a, 'info>(
    user: &'a AccountLoader<'info, UserAccount>,
    order: OrderArgs,
    record: &'info AccountInfo<'info>,
) -> Result<Side<'a, 'info>> {
    require!(
        order.flags & !FLAGS_KNOWN == 0,
        KryonError::InvalidOrderFlags
    );
    let (owner, sub_id) = {
        let u = user.load()?;
        (u.owner, u.sub_id)
    };
    Ok(Side {
        user,
        order,
        owner,
        sub_id,
        record,
        filled_before: 0,
    })
}

/// Per-order rows of the `validate_fill` table.
fn validate_order(s: &mut Side, fill_size: i128, fill_price: i128, now: u64) -> Result<()> {
    let o = &s.order;
    let size = wire_to_precision(o.size).core()?;
    let limit = wire_to_precision(o.limit_price).core()?;
    require!(size > 0 && limit > 0, KryonError::InvalidAmount);
    // now <= expiry_ts <= now + 7d
    require!(now <= o.expiry_ts, KryonError::OrderExpired);
    require!(
        o.expiry_ts <= now.saturating_add(MAX_ORDER_TTL_SECS),
        KryonError::OrderExpired
    );
    // Not tombstoned, and not under the cancel-all watermark.
    let (filled, cancelled) = read_record(s.record, &s.owner, s.sub_id, o.nonce)?;
    require!(!cancelled, KryonError::OrderCancelled);
    require!(
        o.nonce >= s.user.load()?.cancel_all_below_nonce,
        KryonError::OrderCancelled
    );
    // filled + fill_size <= size
    require!(
        checked_add(filled, fill_size).core()? <= size,
        KryonError::OrderOverfilled
    );
    // Limit price: a long never pays more, a short never receives less.
    let long = o.flags & FLAG_IS_LONG != 0;
    require!(
        if long {
            fill_price <= limit
        } else {
            fill_price >= limit
        },
        KryonError::PriceOutsideBand
    );
    s.filled_before = filled;
    Ok(())
}

/// Create the order's record on its first fill (the operator pays rent), or
/// bump `filled` on an existing one.
fn upsert_record<'info>(
    ctx: &Context<'_, '_, 'info, 'info, SettleFills<'info>>,
    s: &Side<'_, 'info>,
    filled: i128,
) -> Result<()> {
    let record = s.record;
    require!(record.is_writable, KryonError::InvalidRemainingAccounts);
    if record.owner == &system_program::ID {
        let (_, bump) = order_record_address(&s.owner, s.sub_id, s.order.nonce);
        let space = 8 + OrderRecord::INIT_SPACE;
        let nonce = s.order.nonce.to_le_bytes();
        let seeds: &[&[u8]] = &[ORDER_SEED, s.owner.as_ref(), &[s.sub_id], &nonce, &[bump]];
        create_pda(
            &ctx.accounts.operator.to_account_info(),
            record,
            &ctx.accounts.system_program.to_account_info(),
            space,
            seeds,
        )?;
        let r = OrderRecord {
            filled,
            cancelled_until: 0,
            expiry_ts: s.order.expiry_ts,
            payer: ctx.accounts.operator.key(),
            bump,
        };
        r.try_serialize(&mut &mut record.try_borrow_mut_data()?[..])?;
    } else {
        let mut r = OrderRecord::try_deserialize(&mut &record.try_borrow_data()?[..])?;
        r.filled = filled;
        r.expiry_ts = s.order.expiry_ts;
        r.try_serialize(&mut &mut record.try_borrow_mut_data()?[..])?;
    }
    Ok(())
}

/// Anchor's `init` for an account at a PDA, tolerating lamports someone
/// pre-sent to the address (a plain create_account would fail on them).
pub fn create_pda<'info>(
    payer: &AccountInfo<'info>,
    target: &AccountInfo<'info>,
    system: &AccountInfo<'info>,
    space: usize,
    seeds: &[&[u8]],
) -> Result<()> {
    let rent = Rent::get()?.minimum_balance(space);
    let signer = &[seeds];
    if target.lamports() == 0 {
        system_program::create_account(
            CpiContext::new_with_signer(
                system.clone(),
                system_program::CreateAccount {
                    from: payer.clone(),
                    to: target.clone(),
                },
                signer,
            ),
            rent,
            space as u64,
            &crate::ID,
        )?;
    } else {
        let top_up = rent.saturating_sub(target.lamports());
        if top_up > 0 {
            system_program::transfer(
                CpiContext::new(
                    system.clone(),
                    system_program::Transfer {
                        from: payer.clone(),
                        to: target.clone(),
                    },
                ),
                top_up,
            )?;
        }
        system_program::allocate(
            CpiContext::new_with_signer(
                system.clone(),
                system_program::Allocate {
                    account_to_allocate: target.clone(),
                },
                signer,
            ),
            space as u64,
        )?;
        system_program::assign(
            CpiContext::new_with_signer(
                system.clone(),
                system_program::Assign {
                    account_to_assign: target.clone(),
                },
                signer,
            ),
            &crate::ID,
        )?;
    }
    Ok(())
}
