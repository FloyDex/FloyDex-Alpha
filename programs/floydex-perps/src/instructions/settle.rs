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
use crate::error::{CoreResultExt, FloyDexError};
use crate::events::{FillSettled, PositionChanged};
use crate::health::{health, load_risk_inputs, market_view, MarketView};
use crate::mark::{fold_mark, observe};
use crate::position::{apply_side, trade_fee, SideOutcome};
use crate::state::*;
use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar::instructions as ix_sysvar;
use anchor_lang::system_program;
use protocol_core::{
    apply_bps, checked_add, checked_sub, mul_div, notional, wire_to_precision, OrderMsg,
    BPS_DENOMINATOR, FLAGS_KNOWN, FLAG_IS_LONG, FLAG_REDUCE_ONLY,
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
    /// Needed when the market caps OI against the fund (`oi_policy_bps > 0`).
    #[account(seeds = [INSURANCE_SEED], bump = insurance.bump)]
    pub insurance: Option<Box<Account<'info, Insurance>>>,
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
        FloyDexError::NotOperator
    );
    require!(!ex.paused, FloyDexError::Paused);
    require!(!fills.is_empty(), FloyDexError::InvalidAmount);
    let now = Clock::get()?.unix_timestamp as u64;

    // The market view (session, mark, oracle) once per instruction.
    let view = {
        let m = ctx.accounts.market.load()?;
        market_view(&m, &ctx.accounts.price_update, now)?
    };
    let changed = observe(&mut *ctx.accounts.market.load_mut()?, &view, now);
    if let Some(changed) = changed {
        emit_cpi!(changed);
    }

    let mut accs: &'info [AccountInfo<'info>] = ctx.remaining_accounts;
    let mut fees = 0i128;
    for fill in fills.iter() {
        let (event, maker_change, taker_change) = settle_one(&ctx, fill, &view, now, &mut accs)?;
        fold_mark(&mut *ctx.accounts.market.load_mut()?, event.price, now)?;
        fees = checked_add(fees, checked_add(event.maker_fee, event.taker_fee).core()?).core()?;
        emit_cpi!(event);
        emit_cpi!(maker_change);
        emit_cpi!(taker_change);
    }
    require!(accs.is_empty(), FloyDexError::InvalidRemainingAccounts);
    let c = &mut ctx.accounts.settlement_collateral;
    c.fees_accrued = checked_add(c.fees_accrued, fees).core()?;
    Ok(())
}

fn next<'info>(accs: &mut &'info [AccountInfo<'info>]) -> Result<&'info AccountInfo<'info>> {
    let (head, tail) = accs
        .split_first()
        .ok_or(FloyDexError::InvalidRemainingAccounts)?;
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
        FloyDexError::InvalidRemainingAccounts
    );
    if record.owner == &system_program::ID {
        return Ok((0, false));
    }
    require_keys_eq!(
        *record.owner,
        crate::ID,
        FloyDexError::InvalidRemainingAccounts
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
        .map_err(|_| error!(FloyDexError::InvalidRemainingAccounts))?;
    let taker_loader: AccountLoader<'info, UserAccount> = AccountLoader::try_from(taker_ai)
        .map_err(|_| error!(FloyDexError::InvalidRemainingAccounts))?;
    require_keys_neq!(maker_ai.key(), taker_ai.key(), FloyDexError::SelfTrade);
    require!(
        maker_ai.is_writable && taker_ai.is_writable,
        FloyDexError::InvalidRemainingAccounts
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
            FloyDexError::Ed25519PubkeyMismatch
        );
    }

    // --- 3. validate_fill (05 §2), exactly the Stellar gateway's checks ---
    let (maker, taker) = (&sides[0].order, &sides[1].order);
    let fill_size = wire_to_precision(fill.fill_size).core()?;
    let fill_price = wire_to_precision(fill.fill_price).core()?;
    require!(fill_size > 0 && fill_price > 0, FloyDexError::InvalidAmount);
    require_keys_neq!(sides[0].owner, sides[1].owner, FloyDexError::SelfTrade);
    require!(
        maker.market_id != 0
            && maker.market_id == taker.market_id
            && maker.market_id == view.market_id,
        FloyDexError::InvalidConfig
    );
    let maker_long = maker.flags & FLAG_IS_LONG != 0;
    let taker_long = taker.flags & FLAG_IS_LONG != 0;
    require!(maker_long != taker_long, FloyDexError::DirectionMismatch);
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
        FloyDexError::PriceOutsideBand
    );

    // --- risk inputs for each side's *other* markets, before any mutation ---
    let settlement_index = ex.settlement_collateral_index;
    let known = [view.market_id];
    let maker_inputs = load_risk_inputs(
        &*sides[0].user.load()?,
        accs,
        settlement_index,
        &known,
        now,
        false,
    )?;
    let taker_inputs = load_risk_inputs(
        &*sides[1].user.load()?,
        accs,
        settlement_index,
        &known,
        now,
        false,
    )?;
    let markets_for = |inputs: &crate::health::RiskInputs| {
        let mut m = inputs.markets.clone();
        m.push(view.snapshot);
        m
    };
    let maker_markets = markets_for(&maker_inputs);
    let taker_markets = markets_for(&taker_inputs);
    // Health before the fill, the yardstick for reduce-only relief below.
    let before = [
        health(&*sides[0].user.load()?, &maker_inputs, &maker_markets)?,
        health(&*sides[1].user.load()?, &taker_inputs, &taker_markets)?,
    ];

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
        if o.increased {
            u.last_increase_ts = now;
        }
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
            FloyDexError::MathOverflow
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
                    error!(FloyDexError::SessionExposureBlocked)
                } else {
                    error!(FloyDexError::OpenInterestExceeded)
                });
            }
            // Stellar `require_insurance_headroom` (KRY-Q4/Q11): new exposure
            // must stay within `oi_policy_bps` of what the fund can stand
            // behind, net of recorded bad debt. Exits are never blocked.
            if m.oi_policy_bps > 0 {
                let ins = ctx
                    .accounts
                    .insurance
                    .as_ref()
                    .ok_or(FloyDexError::InsuranceNotInitialized)?;
                let backing = checked_sub(ins.fund, ins.bad_debt).core()?.max(0);
                let cap = mul_div(backing, i128::from(m.oi_policy_bps), BPS_DENOMINATOR).core()?;
                let oi_notional = if long > 0 {
                    notional(long, view.mark).core()?
                } else {
                    0
                };
                require!(oi_notional <= cap, FloyDexError::InsuranceFundInsufficient);
            }
        }
    }

    // --- session-scaled initial margin for each side, after the fill ---
    // A side that opened, grew or flipped exposure must meet initial margin.
    // A side that only reduced may also pass if its health did not worsen
    // (free collateral after >= before), so an account caught below the
    // requirement, e.g. when margin doubles at the close, can still de-risk
    // through the book (decided 2026-09-26).
    //
    // A liquidatable side gets that relief only at or better than the mark
    // (decided 2026-09-26, `05` §2): its equity then falls by at most the fee.
    // Otherwise a colluding counterparty could buy its position below mark,
    // because the margin a reduce releases outweighs the equity it gives away,
    // and the insurance fund would eat the difference at liquidation.
    let inputs = [
        (&maker_inputs, &maker_markets),
        (&taker_inputs, &taker_markets),
    ];
    for (k, s) in sides.iter().enumerate() {
        let (i, m) = inputs[k];
        let h = health(&*s.user.load()?, i, m)?;
        let meets_initial = h.equity >= h.initial_margin_required;
        let reduce_ok = !outcomes[k].increased && h.free_collateral >= before[k].free_collateral;
        require!(
            meets_initial || reduce_ok,
            FloyDexError::InsufficientCollateral
        );
        if !meets_initial && before[k].liquidatable {
            // The side sold if it is short the fill, bought if long.
            let sold = s.order.flags & FLAG_IS_LONG == 0;
            let at_or_better = if sold {
                fill_price >= view.mark
            } else {
                fill_price <= view.mark
            };
            require!(at_or_better, FloyDexError::LiquidatableReduceOffMark);
        }
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
        FloyDexError::InvalidOrderFlags
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
    require!(size > 0 && limit > 0, FloyDexError::InvalidAmount);
    // now <= expiry_ts <= now + 7d
    require!(now <= o.expiry_ts, FloyDexError::OrderExpired);
    require!(
        o.expiry_ts <= now.saturating_add(MAX_ORDER_TTL_SECS),
        FloyDexError::OrderExpired
    );
    // Not tombstoned, and not under the cancel-all watermark.
    let (filled, cancelled) = read_record(s.record, &s.owner, s.sub_id, o.nonce)?;
    require!(!cancelled, FloyDexError::OrderCancelled);
    require!(
        o.nonce >= s.user.load()?.cancel_all_below_nonce,
        FloyDexError::OrderCancelled
    );
    // filled + fill_size <= size
    require!(
        checked_add(filled, fill_size).core()? <= size,
        FloyDexError::OrderOverfilled
    );
    // Limit price: a long never pays more, a short never receives less.
    let long = o.flags & FLAG_IS_LONG != 0;
    require!(
        if long {
            fill_price <= limit
        } else {
            fill_price >= limit
        },
        FloyDexError::PriceOutsideBand
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
    require!(record.is_writable, FloyDexError::InvalidRemainingAccounts);
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
