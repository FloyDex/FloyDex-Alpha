//! Order state the owner controls (cancels) and the permissionless cleanup
//! of records that can never matter again.

use crate::constants::*;
use crate::error::KryonError;
use crate::events::OrderCancelled;
use crate::state::*;
use anchor_lang::prelude::*;

#[event_cpi]
#[derive(Accounts)]
#[instruction(sub_id: u8, nonce: u64)]
pub struct CancelOrder<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        seeds = [USER_SEED, owner.key().as_ref(), &[sub_id]],
        bump = user_account.load()?.bump,
    )]
    pub user_account: AccountLoader<'info, UserAccount>,
    #[account(
        init_if_needed,
        payer = owner,
        space = 8 + OrderRecord::INIT_SPACE,
        seeds = [ORDER_SEED, owner.key().as_ref(), &[sub_id], &nonce.to_le_bytes()],
        bump,
    )]
    pub order_record: Account<'info, OrderRecord>,
    pub system_program: Program<'info, System>,
}

/// Tombstone one order. `expiry_ts` is clamped UP to `now + MAX_ORDER_TTL`
/// (Stellar fix): a caller passing an early expiry must not get a tombstone
/// that can be reclaimed while the signed order could still fill.
pub fn handle_cancel_order(
    ctx: Context<CancelOrder>,
    sub_id: u8,
    nonce: u64,
    expiry_ts: u64,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp as u64;
    let floor = now.saturating_add(MAX_ORDER_TTL_SECS);
    let r = &mut ctx.accounts.order_record;
    if r.payer == Pubkey::default() {
        // Fresh record created by this cancel.
        r.payer = ctx.accounts.owner.key();
        r.bump = ctx.bumps.order_record;
    }
    r.cancelled_until = core::cmp::max(r.cancelled_until, core::cmp::max(expiry_ts, floor));
    emit_cpi!(OrderCancelled {
        owner: ctx.accounts.owner.key(),
        sub_id,
        nonce,
        below_nonce: 0
    });
    Ok(())
}

pub fn handle_cancel_all(
    ctx: Context<crate::instructions::delegate::OwnerOnly>,
    below_nonce: u64,
) -> Result<()> {
    let sub_id = {
        let mut u = ctx.accounts.user_account.load_mut()?;
        // The watermark only moves forward: lowering it would revive orders.
        u.cancel_all_below_nonce = core::cmp::max(u.cancel_all_below_nonce, below_nonce);
        u.sub_id
    };
    emit_cpi!(OrderCancelled {
        owner: ctx.accounts.owner.key(),
        sub_id,
        nonce: 0,
        below_nonce
    });
    Ok(())
}

#[derive(Accounts)]
#[instruction(owner: Pubkey, sub_id: u8, nonce: u64)]
pub struct ReclaimOrderState<'info> {
    #[account(
        mut,
        close = payer,
        seeds = [ORDER_SEED, owner.as_ref(), &[sub_id], &nonce.to_le_bytes()],
        bump = order_record.bump,
        has_one = payer,
    )]
    pub order_record: Account<'info, OrderRecord>,
    /// CHECK: receives the rent; must be the record's payer (`has_one`).
    #[account(mut)]
    pub payer: UncheckedAccount<'info>,
}

/// Permissionless: close a record once no order under it can fill again
/// (`now > max(expiry, tombstone)`), refunding rent to whoever paid it.
pub fn handle_reclaim_order_state(
    ctx: Context<ReclaimOrderState>,
    _owner: Pubkey,
    _sub_id: u8,
    _nonce: u64,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp as u64;
    require!(
        now > ctx.accounts.order_record.reclaimable_at(),
        KryonError::NotReclaimable
    );
    Ok(())
}
