//! `liquidate(position_id)`: permissionless, by position transfer (decided
//! 2026-09-26, `05` §2).
//!
//! The liquidator's own `UserAccount` takes over the slice that
//! `plan_liquidation` picks (partial, never over-liquidating, `11` L9) at the
//! mark, like a fill between the two accounts, so OI stays balanced and
//! conservation stays exact. Then, in order:
//! 1. the user pays the penalty (`liquidation_fee_bps` of the closed
//!    notional); the liquidator gets `min(penalty, max_reward_bps)` and the
//!    rest goes to the insurance fund;
//! 2. the user's shortfall must strictly shrink (`05` §7.5);
//! 3. a negative settlement balance is covered first by the user's other
//!    collateral, sold to the liquidator at its haircut value (Stellar
//!    `seize_for_deficit`, lowest haircut first);
//! 4. if equity is still negative, the insurance fund covers it and any
//!    remainder is written off as recorded bad debt (Stellar
//!    `absorb_bad_debt`), which only `adl` pays down;
//! 5. the liquidator must meet initial margin afterwards (or only have
//!    reduced its own exposure without worsening health).
//!
//! Halted markets are not liquidated (`07` §2): their mark is a stale price.
//!
//! Remaining accounts: the user's risk accounts, then the liquidator's, each
//! in the `crate::health` layout, skipping this market.

use crate::constants::*;
use crate::error::{CoreResultExt, KryonError};
use crate::events::{BadDebt, Liquidated, PositionChanged, SharesRetired};
use crate::health::{health, load_risk_inputs, market_view, plan_liquidation, CollateralPrice};
use crate::instructions::insurance::cover_deficit;
use crate::mark::observe;
use crate::position::{apply_side, to_whole_units, SideOutcome};
use crate::state::*;
use anchor_lang::prelude::*;
use protocol_core::{
    apply_bps, checked_add, checked_sub, collateral_value_after_haircut, mul_div_ceil,
    mul_div_floor, notional, PRECISION,
};
use risk_engine::MarketSession;

#[event_cpi]
#[derive(Accounts)]
pub struct Liquidate<'info> {
    #[account(seeds = [EXCHANGE_SEED], bump = exchange.bump)]
    pub exchange: Box<Account<'info, Exchange>>,
    #[account(mut, seeds = [INSURANCE_SEED], bump = insurance.bump)]
    pub insurance: Box<Account<'info, Insurance>>,
    pub liquidator: Signer<'info>,
    /// The liquidator's sub-account: it takes the position.
    #[account(
        mut,
        seeds = [USER_SEED, liquidator.key().as_ref(), &[liquidator_account.load()?.sub_id]],
        bump = liquidator_account.load()?.bump,
        constraint = liquidator_account.load()?.owner == liquidator.key() @ KryonError::Unauthorized,
    )]
    pub liquidator_account: AccountLoader<'info, UserAccount>,
    /// The account being liquidated.
    #[account(mut)]
    pub user_account: AccountLoader<'info, UserAccount>,
    #[account(mut, seeds = [MARKET_SEED, &market.load()?.market_id.to_le_bytes()], bump = market.load()?.bump)]
    pub market: AccountLoader<'info, Market>,
    /// CHECK: address, owner, discriminator and feed id are verified in `oracle::read_pyth`.
    pub price_update: UncheckedAccount<'info>,
}

pub fn handle_liquidate<'info>(
    ctx: Context<'_, '_, 'info, 'info, Liquidate<'info>>,
    position_id: u64,
) -> Result<()> {
    let ex = &ctx.accounts.exchange;
    require!(!ex.paused, KryonError::Paused);
    require!(
        ex.insurance == ctx.accounts.insurance.key() && ex.max_reward_bps > 0,
        KryonError::InsuranceNotInitialized
    );
    require_keys_neq!(
        ctx.accounts.user_account.key(),
        ctx.accounts.liquidator_account.key(),
        KryonError::SelfLiquidation
    );
    require_keys_neq!(
        ctx.accounts.user_account.load()?.owner,
        ctx.accounts.liquidator.key(),
        KryonError::SelfLiquidation
    );
    let now = Clock::get()?.unix_timestamp as u64;
    let si = ex.settlement_collateral_index;

    let view = {
        let m = ctx.accounts.market.load()?;
        market_view(&m, &ctx.accounts.price_update, now)?
    };
    let changed = observe(&mut *ctx.accounts.market.load_mut()?, &view, now);
    if let Some(changed) = changed {
        emit_cpi!(changed);
    }
    require!(
        view.session != MarketSession::Halted,
        KryonError::MarketHalted
    );
    let mark = view.mark;
    let mid = view.market_id;

    // --- risk inputs, before any mutation ---
    let mut accs: &'info [AccountInfo<'info>] = ctx.remaining_accounts;
    let user_inputs = {
        let u = ctx.accounts.user_account.load()?;
        load_risk_inputs(&u, &mut accs, si, &[mid], now, true)?
    };
    let mut liq_inputs = {
        let u = ctx.accounts.liquidator_account.load()?;
        load_risk_inputs(&u, &mut accs, si, &[mid], now, false)?
    };
    require!(accs.is_empty(), KryonError::InvalidRemainingAccounts);
    // The liquidator may receive the user's collateral: it needs its prices.
    for p in user_inputs.prices.iter() {
        if liq_inputs.price_of(p.index).is_none() {
            liq_inputs.prices.push(*p);
        }
    }
    let user_last_increase = ctx.accounts.user_account.load()?.last_increase_ts;
    let mut user_markets = user_inputs.markets.clone();
    user_markets.push(view.liquidation_snapshot(user_last_increase));
    let mut liq_markets = liq_inputs.markets.clone();
    liq_markets.push(view.snapshot);

    let before = health(
        &*ctx.accounts.user_account.load()?,
        &user_inputs,
        &user_markets,
    )?;
    require!(before.liquidatable, KryonError::NotLiquidatable);
    let liq_before = health(
        &*ctx.accounts.liquidator_account.load()?,
        &liq_inputs,
        &liq_markets,
    )?;

    let (slot_long, plan) = {
        let u = ctx.accounts.user_account.load()?;
        let slot = u
            .positions
            .iter()
            .find(|p| p.in_use != 0 && p.position_id == position_id)
            .ok_or(KryonError::PositionNotFound)?;
        require!(slot.market_id == mid, KryonError::PositionNotFound);
        let plan = plan_liquidation(
            &u,
            &user_inputs,
            &user_markets,
            position_id,
            ex.partial_liquidation_bps,
        )?;
        (slot.is_long != 0, plan)
    };
    let position_size = {
        let u = ctx.accounts.user_account.load()?;
        u.positions
            .iter()
            .find(|p| p.in_use != 0 && p.position_id == position_id)
            .map_or(0, |p| p.size.get())
    };
    let size = to_whole_units(plan.close_size, position_size);
    require!(size > 0, KryonError::InvalidAmount);
    // The penalty on the slice actually closed (same rule as the plan's).
    let penalty = apply_bps(
        notional(size, mark).core()?,
        ctx.accounts.market.load()?.liquidation_fee_bps,
    )
    .core()?;
    let reward = penalty.min(apply_bps(notional(size, mark).core()?, ex.max_reward_bps).core()?);
    let to_fund = checked_sub(penalty, reward).core()?;

    // --- the transfer at the mark ---
    let (fl, fs) = {
        let m = ctx.accounts.market.load()?;
        (m.funding_long_index.get(), m.funding_short_index.get())
    };
    let user_out: SideOutcome;
    let liq_out: SideOutcome;
    {
        let mut u = ctx.accounts.user_account.load_mut()?;
        user_out = apply_side(&mut u, mid, !slot_long, true, size, mark, fl, fs)?;
        u.apply_balance(si, checked_sub(user_out.pnl, penalty).core()?)?;
    }
    {
        let mut l = ctx.accounts.liquidator_account.load_mut()?;
        liq_out = apply_side(&mut l, mid, slot_long, false, size, mark, fl, fs)?;
        l.apply_balance(si, checked_add(liq_out.pnl, reward).core()?)?;
        if liq_out.increased {
            l.last_increase_ts = now;
        }
    }
    {
        let mut m = ctx.accounts.market.load_mut()?;
        let long = checked_add(
            m.oi_long.get(),
            checked_add(user_out.oi.long, liq_out.oi.long).core()?,
        )
        .core()?;
        let short = checked_add(
            m.oi_short.get(),
            checked_add(user_out.oi.short, liq_out.oi.short).core()?,
        )
        .core()?;
        require!(
            long >= 0 && short >= 0 && long == short,
            KryonError::MathOverflow
        );
        m.oi_long.set(long);
        m.oi_short.set(short);
    }
    let ins = &mut ctx.accounts.insurance;
    ins.fund = checked_add(ins.fund, to_fund).core()?;

    // --- 05 §7.5: the shortfall must strictly shrink ---
    let after = health(
        &*ctx.accounts.user_account.load()?,
        &user_inputs,
        &user_markets,
    )?;
    let shortfall =
        |h: &risk_engine::AccountHealth| h.maintenance_margin_required.saturating_sub(h.equity);
    require!(
        shortfall(&after) < shortfall(&before),
        KryonError::LiquidationWouldNotImproveHealth
    );

    // --- deficit: the user's own collateral, then insurance, then bad debt ---
    let seized = {
        let mut u = ctx.accounts.user_account.load_mut()?;
        let mut l = ctx.accounts.liquidator_account.load_mut()?;
        seize_to_liquidator(&mut u, &mut l, &user_inputs.prices, si)?
    };
    let mut bad_debt_event = None;
    let mut retired: Option<SharesRetired> = None;
    {
        let h = health(
            &*ctx.accounts.user_account.load()?,
            &user_inputs,
            &user_markets,
        )?;
        let mut u = ctx.accounts.user_account.load_mut()?;
        let balance = u.balance(si);
        if h.equity < 0 && balance < 0 {
            // Bring equity back to zero, never beyond what the settlement
            // balance actually owes (other positions may still be in profit).
            let need = (-h.equity).min(-balance);
            let ins = &mut ctx.accounts.insurance;
            let (covered, r) = cover_deficit(ins, need)?;
            retired = r;
            let written_off = checked_sub(need, covered).core()?;
            ins.bad_debt = checked_add(ins.bad_debt, written_off).core()?;
            u.apply_balance(si, need)?;
            bad_debt_event = Some(BadDebt {
                owner: u.owner,
                sub_id: u.sub_id,
                covered,
                written_off,
                total_bad_debt: ins.bad_debt,
            });
        }
    }

    // --- the liquidator took on risk like a fill: it must stay margined ---
    let liq_after = health(
        &*ctx.accounts.liquidator_account.load()?,
        &liq_inputs,
        &liq_markets,
    )?;
    let meets_initial = liq_after.equity >= liq_after.initial_margin_required;
    let reduce_ok = !liq_out.increased && liq_after.free_collateral >= liq_before.free_collateral;
    require!(
        meets_initial || reduce_ok,
        KryonError::InsufficientCollateral
    );

    // --- events ---
    let (user_owner, user_sub) = {
        let u = ctx.accounts.user_account.load()?;
        (u.owner, u.sub_id)
    };
    let liq_sub = ctx.accounts.liquidator_account.load()?.sub_id;
    let change = |owner: Pubkey, sub_id: u8, o: &SideOutcome| PositionChanged {
        owner,
        sub_id,
        market_id: mid,
        position_id: o.position_id,
        is_long: o.is_long_after,
        size: o.size_after,
        entry_price: o.entry_after,
        realized_pnl: o.pnl,
    };
    emit_cpi!(Liquidated {
        owner: user_owner,
        sub_id: user_sub,
        liquidator: ctx.accounts.liquidator.key(),
        market_id: mid,
        position_id,
        size,
        price: mark,
        penalty,
        reward,
        to_insurance: to_fund,
        seized_credit: seized,
    });
    emit_cpi!(change(user_owner, user_sub, &user_out));
    emit_cpi!(change(ctx.accounts.liquidator.key(), liq_sub, &liq_out));
    if let Some(e) = bad_debt_event {
        emit_cpi!(e);
    }
    if let Some(e) = retired {
        emit_cpi!(e);
    }
    Ok(())
}

/// Cover a negative settlement balance with the user's other collateral,
/// sold to the liquidator at its haircut value, lowest haircut first (the
/// most liquid first; Stellar `seize_for_deficit`). The liquidator pays in
/// settlement units and receives the tokens' claim, so every mint's ledger
/// still balances; the haircut is the liquidator's discount. Returns the
/// settlement credit.
pub fn seize_to_liquidator(
    user: &mut UserAccount,
    liq: &mut UserAccount,
    prices: &[CollateralPrice],
    settlement_index: u8,
) -> Result<i128> {
    let balance = user.balance(settlement_index);
    if balance >= 0 {
        return Ok(0);
    }
    let mut remaining = -balance;
    let mut order: Vec<CollateralPrice> = prices
        .iter()
        .filter(|p| p.index != settlement_index && user.balance(p.index) > 0)
        .copied()
        .collect();
    order.sort_by_key(|p| (p.haircut_bps, p.index));
    let mut credited = 0i128;
    for p in order.iter() {
        if remaining <= 0 {
            break;
        }
        let amount = user.balance(p.index);
        let gross = mul_div_floor(amount, p.price, PRECISION).core()?;
        let net = collateral_value_after_haircut(gross, p.haircut_bps).core()?;
        if net <= 0 {
            continue; // fully haircut: settles no debt
        }
        // All of it, or just enough: a partial take rounds up (against the
        // user) and credits exactly the debt, so the account ends at zero
        // rather than a few wei short; the liquidator gets collateral worth
        // the credit to within rounding.
        let (take, credit) = if net <= remaining {
            (amount, net)
        } else {
            let take = mul_div_ceil(amount, remaining, net).core()?.min(amount);
            (take, remaining)
        };
        if take <= 0 || credit <= 0 {
            continue;
        }
        user.apply_balance(p.index, -take)?;
        liq.apply_balance(p.index, take)?;
        user.apply_balance(settlement_index, credit)?;
        liq.apply_balance(settlement_index, -credit)?;
        credited = checked_add(credited, credit).core()?;
        remaining = checked_sub(remaining, credit).core()?;
    }
    Ok(credited)
}
