//! Session keys (`03` A3): the owner lets a browser key sign orders, and
//! nothing else, until an expiry. Withdrawals always need the owner.

use crate::constants::*;
use crate::error::FloyDexError;
use crate::events::DelegateSet;
use crate::state::*;
use anchor_lang::prelude::*;

#[event_cpi]
#[derive(Accounts)]
pub struct OwnerOnly<'info> {
    pub owner: Signer<'info>,
    #[account(
        mut,
        seeds = [USER_SEED, owner.key().as_ref(), &[user_account.load()?.sub_id]],
        bump = user_account.load()?.bump,
        constraint = user_account.load()?.owner == owner.key() @ FloyDexError::Unauthorized,
    )]
    pub user_account: AccountLoader<'info, UserAccount>,
}

pub fn handle_set_delegate(ctx: Context<OwnerOnly>, delegate: Pubkey, expiry: i64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(expiry > now, FloyDexError::InvalidDelegateExpiry);
    require!(
        delegate != Pubkey::default() && delegate != ctx.accounts.owner.key(),
        FloyDexError::InvalidConfig
    );
    let sub_id = {
        let mut u = ctx.accounts.user_account.load_mut()?;
        u.delegate = delegate;
        u.delegate_expiry = expiry;
        u.sub_id
    };
    emit_cpi!(DelegateSet {
        owner: ctx.accounts.owner.key(),
        sub_id,
        delegate,
        expiry
    });
    Ok(())
}

pub fn handle_revoke_delegate(ctx: Context<OwnerOnly>) -> Result<()> {
    let sub_id = {
        let mut u = ctx.accounts.user_account.load_mut()?;
        u.delegate = Pubkey::default();
        u.delegate_expiry = 0;
        u.sub_id
    };
    emit_cpi!(DelegateSet {
        owner: ctx.accounts.owner.key(),
        sub_id,
        delegate: Pubkey::default(),
        expiry: 0
    });
    Ok(())
}
