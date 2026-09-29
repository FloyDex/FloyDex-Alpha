//! User-signed instructions: sub-accounts, deposits and withdrawals.
//! Withdrawals always need the owner; a session key can never move funds.

use crate::constants::*;
use crate::error::{CoreResultExt, FloyDexError};
use crate::events::{Deposit as DepositEvent, Withdraw as WithdrawEvent};
use crate::health::{has_risk, load_risk_inputs, validate_withdrawal};
use crate::state::*;
use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};
use protocol_core::{mul_div_ceil, PRECISION};

#[derive(Accounts)]
#[instruction(sub_id: u8)]
pub struct InitUser<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        init,
        payer = owner,
        space = 8 + core::mem::size_of::<UserAccount>(),
        seeds = [USER_SEED, owner.key().as_ref(), &[sub_id]],
        bump,
    )]
    pub user_account: AccountLoader<'info, UserAccount>,
    pub system_program: Program<'info, System>,
}

pub fn handle_init_user(ctx: Context<InitUser>, sub_id: u8) -> Result<()> {
    let mut u = ctx.accounts.user_account.load_init()?;
    u.owner = ctx.accounts.owner.key();
    u.sub_id = sub_id;
    u.bump = ctx.bumps.user_account;
    u.next_position_id = 1;
    Ok(())
}

/// Accounts shared by deposit and withdraw.
#[event_cpi]
#[derive(Accounts)]
pub struct MoveCollateral<'info> {
    #[account(seeds = [EXCHANGE_SEED], bump = exchange.bump)]
    pub exchange: Box<Account<'info, Exchange>>,
    pub owner: Signer<'info>,
    #[account(
        mut,
        seeds = [USER_SEED, owner.key().as_ref(), &[user_account.load()?.sub_id]],
        bump = user_account.load()?.bump,
        constraint = user_account.load()?.owner == owner.key() @ FloyDexError::Unauthorized,
    )]
    pub user_account: AccountLoader<'info, UserAccount>,
    #[account(
        mut,
        seeds = [COLLATERAL_SEED, mint.key().as_ref()],
        bump = collateral.bump,
        has_one = mint,
        has_one = vault,
        has_one = token_program,
    )]
    pub collateral: Box<Account<'info, Collateral>>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    /// The owner's token account (source for deposits, destination for
    /// withdrawals).
    #[account(mut, token::mint = mint, token::token_program = token_program)]
    pub user_token: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
}

fn to_precision(c: &Collateral, amount: u64) -> Result<i128> {
    i128::from(amount)
        .checked_mul(c.scale())
        .ok_or_else(|| error!(FloyDexError::MathOverflow))
}

pub fn handle_deposit(ctx: Context<MoveCollateral>, amount: u64) -> Result<()> {
    require!(!ctx.accounts.exchange.paused, FloyDexError::Paused);
    require!(amount > 0, FloyDexError::InvalidAmount);
    let c = &ctx.accounts.collateral;
    require!(c.active, FloyDexError::AssetDisabled);
    let next_total = c
        .total_deposited
        .checked_add(amount)
        .ok_or(FloyDexError::MathOverflow)?;
    require!(
        next_total <= c.deposit_cap,
        FloyDexError::DepositCapExceeded
    );
    let credit = to_precision(c, amount)?;

    let before = ctx.accounts.vault.amount;
    token_interface::transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.user_token.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.owner.to_account_info(),
            },
        ),
        amount,
        ctx.accounts.mint.decimals,
    )?;
    // Credit exactly what arrived. add_collateral refuses fee/hook mints, but
    // the ledger must never trust a transfer it did not observe.
    ctx.accounts.vault.reload()?;
    let received = ctx
        .accounts
        .vault
        .amount
        .checked_sub(before)
        .ok_or(FloyDexError::MathOverflow)?;
    require!(received == amount, FloyDexError::TransferAmountMismatch);

    ctx.accounts.collateral.total_deposited = next_total;
    let index = ctx.accounts.collateral.index;
    let sub_id = {
        let mut u = ctx.accounts.user_account.load_mut()?;
        u.apply_balance(index, credit)?;
        u.sub_id
    };
    emit_cpi!(DepositEvent {
        owner: ctx.accounts.owner.key(),
        sub_id,
        mint: ctx.accounts.mint.key(),
        amount
    });
    Ok(())
}

pub fn handle_withdraw<'info>(
    ctx: Context<'_, '_, 'info, 'info, MoveCollateral<'info>>,
    amount: u64,
) -> Result<()> {
    require!(amount > 0, FloyDexError::InvalidAmount);
    let c = &ctx.accounts.collateral;
    require!(c.active, FloyDexError::AssetDisabled);
    let debit = to_precision(c, amount)?;
    let index = c.index;
    let now = Clock::get()?.unix_timestamp as u64;
    let ex = &ctx.accounts.exchange;

    let sub_id = {
        let u = ctx.accounts.user_account.load()?;
        require!(
            u.balance(index) >= debit,
            FloyDexError::InsufficientCollateral
        );
        if has_risk(&u) {
            // Paused: only idle collateral may leave (05 §7.6, decided 2026-09-26).
            require!(!ex.paused, FloyDexError::Paused);
            let mut accs: &'info [AccountInfo<'info>] = ctx.remaining_accounts;
            let risk = load_risk_inputs(
                &u,
                &mut accs,
                ex.settlement_collateral_index,
                &[],
                now,
                false,
            )?;
            require!(accs.is_empty(), FloyDexError::InvalidRemainingAccounts);
            let price = risk
                .price_of(index)
                .ok_or(FloyDexError::InvalidRemainingAccounts)?;
            // Round the withdrawn value up: rounding must never free margin.
            let value = mul_div_ceil(debit, price, PRECISION).core()?;
            validate_withdrawal(&u, &risk, &risk.markets, value)?;
        }
        // No positions and no debt: equity after is the remaining positive
        // collateral, which is >= the zero margin requirement. No oracle needed.
        u.sub_id
    };

    ctx.accounts
        .user_account
        .load_mut()?
        .apply_balance(index, -debit)?;
    let c = &mut ctx.accounts.collateral;
    c.total_deposited = c.total_deposited.saturating_sub(amount);

    let mint_key = ctx.accounts.mint.key();
    let seeds: &[&[u8]] = &[
        COLLATERAL_SEED,
        mint_key.as_ref(),
        &[ctx.accounts.collateral.bump],
    ];
    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.vault.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.user_token.to_account_info(),
                authority: ctx.accounts.collateral.to_account_info(),
            },
            &[seeds],
        ),
        amount,
        ctx.accounts.mint.decimals,
    )?;
    emit_cpi!(WithdrawEvent {
        owner: ctx.accounts.owner.key(),
        sub_id,
        mint: mint_key,
        amount
    });
    Ok(())
}
