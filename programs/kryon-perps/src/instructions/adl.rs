//! `adl`: auto-deleveraging, a response to bad debt that has already
//! happened, never a speculative control (`05` §2, Stellar KRY-Q4, `11` L12).
//!
//! The keeper names a position in profit and an opposite position in the
//! same market; both close against each other at the mark (so OI stays
//! two-sided, decided 2026-09-26) and the winner's realized PnL is cut by up
//! to `Insurance.bad_debt`, which pays the debt down. Stellar credited the
//! winner in full and then reduced `bad_debt` by the same amount, which
//! moved the shortfall between ledgers without closing it.
//!
//! Checks that need no global index: refused unless `bad_debt > 0`; the
//! winner's position must be in profit at the mark; the close is capped at
//! the size whose profit covers the debt, so a wrong or malicious target
//! costs at most one bounded call. The other side closes at the mark, which
//! costs it nothing against the mark.

use crate::constants::*;
use crate::error::{CoreResultExt, KryonError};
use crate::events::{Adl, PositionChanged};
use crate::health::market_view;
use crate::mark::observe;
use crate::position::{apply_side, SideOutcome};
use crate::state::*;
use anchor_lang::prelude::*;
use protocol_core::{checked_add, checked_sub, mul_div_ceil, PRECISION};
use risk_engine::MarketSession;

#[event_cpi]
#[derive(Accounts)]
pub struct AutoDeleverage<'info> {
    #[account(seeds = [EXCHANGE_SEED], bump = exchange.bump)]
    pub exchange: Box<Account<'info, Exchange>>,
    #[account(mut, seeds = [INSURANCE_SEED], bump = insurance.bump)]
    pub insurance: Box<Account<'info, Insurance>>,
    /// Anyone: the safety comes from the checks, not from who calls.
    pub keeper: Signer<'info>,
    /// Holds the position in profit.
    #[account(mut)]
    pub winner_account: AccountLoader<'info, UserAccount>,
    /// Holds the opposite position.
    #[account(mut)]
    pub counterparty_account: AccountLoader<'info, UserAccount>,
    #[account(mut, seeds = [MARKET_SEED, &market.load()?.market_id.to_le_bytes()], bump = market.load()?.bump)]
    pub market: AccountLoader<'info, Market>,
    /// CHECK: address, owner, discriminator and feed id are verified in `oracle::read_pyth`.
    pub price_update: UncheckedAccount<'info>,
}

pub fn handle_adl(
    ctx: Context<AutoDeleverage>,
    winner_position_id: u64,
    counterparty_position_id: u64,
) -> Result<()> {
    let ex = &ctx.accounts.exchange;
    require!(!ex.paused, KryonError::Paused);
    require!(
        ex.insurance == ctx.accounts.insurance.key(),
        KryonError::InsuranceNotInitialized
    );
    let bad_debt = ctx.accounts.insurance.bad_debt;
    require!(bad_debt > 0, KryonError::NoBadDebtToOffset);
    require_keys_neq!(
        ctx.accounts.winner_account.key(),
        ctx.accounts.counterparty_account.key(),
        KryonError::SelfTrade
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
    let (mark, mid) = (view.mark, view.market_id);

    let find = |u: &UserAccount, id: u64| -> Result<PositionSlot> {
        let slot = *u
            .positions
            .iter()
            .find(|p| p.in_use != 0 && p.position_id == id)
            .ok_or(KryonError::PositionNotFound)?;
        require!(slot.market_id == mid, KryonError::PositionNotFound);
        Ok(slot)
    };
    let w = find(&*ctx.accounts.winner_account.load()?, winner_position_id)?;
    let c = find(
        &*ctx.accounts.counterparty_account.load()?,
        counterparty_position_id,
    )?;
    let w_long = w.is_long != 0;
    require!(w_long != (c.is_long != 0), KryonError::DirectionMismatch);

    // In profit at the mark, per unit.
    let entry = w.entry_price.get();
    let per_unit = if w_long {
        checked_sub(mark, entry)
    } else {
        checked_sub(entry, mark)
    }
    .core()?;
    require!(per_unit > 0, KryonError::PositionNotInProfit);
    // Never close more than the debt needs.
    let needed = mul_div_ceil(bad_debt, PRECISION, per_unit).core()?;
    let size = w.size.get().min(c.size.get()).min(needed);
    require!(size > 0, KryonError::NoBadDebtToOffset);

    let (fl, fs) = {
        let m = ctx.accounts.market.load()?;
        (m.funding_long_index.get(), m.funding_short_index.get())
    };
    let w_out: SideOutcome;
    let c_out: SideOutcome;
    let haircut;
    {
        let mut u = ctx.accounts.winner_account.load_mut()?;
        w_out = apply_side(&mut u, mid, !w_long, true, size, mark, fl, fs)?;
        haircut = w_out.pnl.max(0).min(bad_debt);
        u.apply_balance(si, checked_sub(w_out.pnl, haircut).core()?)?;
    }
    {
        let mut u = ctx.accounts.counterparty_account.load_mut()?;
        c_out = apply_side(&mut u, mid, w_long, true, size, mark, fl, fs)?;
        u.apply_balance(si, c_out.pnl)?;
    }
    {
        let mut m = ctx.accounts.market.load_mut()?;
        let long = checked_add(
            m.oi_long.get(),
            checked_add(w_out.oi.long, c_out.oi.long).core()?,
        )
        .core()?;
        let short = checked_add(
            m.oi_short.get(),
            checked_add(w_out.oi.short, c_out.oi.short).core()?,
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
    ins.bad_debt = checked_sub(ins.bad_debt, haircut).core()?;
    let bad_debt_after = ins.bad_debt;

    let (w_owner, w_sub) = {
        let u = ctx.accounts.winner_account.load()?;
        (u.owner, u.sub_id)
    };
    let (c_owner, c_sub) = {
        let u = ctx.accounts.counterparty_account.load()?;
        (u.owner, u.sub_id)
    };
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
    emit_cpi!(Adl {
        winner: w_owner,
        winner_sub_id: w_sub,
        counterparty: c_owner,
        counterparty_sub_id: c_sub,
        market_id: mid,
        size,
        price: mark,
        haircut,
        bad_debt_before: bad_debt,
        bad_debt_after,
    });
    emit_cpi!(change(w_owner, w_sub, &w_out));
    emit_cpi!(change(c_owner, c_sub, &c_out));
    Ok(())
}
