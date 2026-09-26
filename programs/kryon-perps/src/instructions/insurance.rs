//! The insurance fund and its stakers, ported from Stellar `perp-insurance`
//! (`05` §1–2).
//!
//! - `stake`: USDC into the settlement vault, shares minted against the
//!   fund's NAV (1:1 for the first staker or after a wipe).
//! - `request_unstake` → cooldown → `withdraw_unstaked`, redeemed at the NAV
//!   *at withdrawal*, so a staker who sees a loss coming cannot dodge it by
//!   requesting first. Shares in a pending request still absorb losses.
//! - `cover_deficit` (internal, from `liquidate`): draws the fund down; when
//!   a loss takes it to zero with shares outstanding, the epoch is bumped and
//!   every outstanding share is retired, so the next staker is not diluted by
//!   shares with no claim on anything.

use crate::constants::*;
use crate::error::{CoreResultExt, KryonError};
use crate::events::{SharesRetired, Staked, UnstakeRequested, Unstaked};
use crate::state::*;
use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};
use protocol_core::{checked_add, checked_sub, mul_div_floor};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct LiquidationConfig {
    /// Liquidator reward cap, bps of closed notional, `0 < x ≤ 1_000`.
    pub max_reward_bps: u32,
    /// Share of a position one liquidation step may close, `0 < x ≤ 10_000`.
    pub partial_liquidation_bps: u32,
}

fn validate_liquidation_config(c: &LiquidationConfig) -> Result<()> {
    // A zero reward disables liquidation economically: no keeper runs at a
    // loss (a Stellar testnet drill found exactly that).
    require!(
        c.max_reward_bps > 0
            && c.max_reward_bps <= MAX_REWARD_BPS_CEILING
            && c.partial_liquidation_bps > 0
            && c.partial_liquidation_bps <= 10_000,
        KryonError::InvalidConfig
    );
    Ok(())
}

#[derive(Accounts)]
pub struct InitInsurance<'info> {
    #[account(mut, seeds = [EXCHANGE_SEED], bump = exchange.bump, has_one = admin @ KryonError::Unauthorized)]
    pub exchange: Box<Account<'info, Exchange>>,
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        init,
        payer = admin,
        space = 8 + Insurance::INIT_SPACE,
        seeds = [INSURANCE_SEED],
        bump,
    )]
    pub insurance: Box<Account<'info, Insurance>>,
    #[account(
        seeds = [COLLATERAL_SEED, exchange.settlement_mint.as_ref()],
        bump = settlement_collateral.bump,
    )]
    pub settlement_collateral: Box<Account<'info, Collateral>>,
    pub system_program: Program<'info, System>,
}

pub fn handle_init_insurance(
    ctx: Context<InitInsurance>,
    unstake_cooldown_secs: u64,
    config: LiquidationConfig,
) -> Result<()> {
    require!(
        unstake_cooldown_secs <= MAX_UNSTAKE_COOLDOWN_SECS,
        KryonError::InvalidConfig
    );
    validate_liquidation_config(&config)?;
    let ins = &mut ctx.accounts.insurance;
    ins.usdc_vault = ctx.accounts.settlement_collateral.vault;
    ins.fund = 0;
    ins.total_shares = 0;
    ins.bad_debt = 0;
    ins.epoch = 0;
    ins.unstake_cooldown_secs = unstake_cooldown_secs;
    ins.bump = ctx.bumps.insurance;
    let ex = &mut ctx.accounts.exchange;
    ex.insurance = ins.key();
    ex.max_reward_bps = config.max_reward_bps;
    ex.partial_liquidation_bps = config.partial_liquidation_bps;
    Ok(())
}

pub fn handle_set_liquidation_config(
    ctx: Context<crate::instructions::admin::AdminOnly>,
    config: LiquidationConfig,
) -> Result<()> {
    validate_liquidation_config(&config)?;
    let ex = &mut ctx.accounts.exchange;
    require!(
        ex.insurance != Pubkey::default(),
        KryonError::InsuranceNotInitialized
    );
    ex.max_reward_bps = config.max_reward_bps;
    ex.partial_liquidation_bps = config.partial_liquidation_bps;
    Ok(())
}

/// Accounts shared by `stake` and `withdraw_unstaked`.
#[event_cpi]
#[derive(Accounts)]
pub struct MoveStake<'info> {
    #[account(seeds = [EXCHANGE_SEED], bump = exchange.bump)]
    pub exchange: Box<Account<'info, Exchange>>,
    #[account(mut, seeds = [INSURANCE_SEED], bump = insurance.bump)]
    pub insurance: Box<Account<'info, Insurance>>,
    #[account(mut)]
    pub staker: Signer<'info>,
    #[account(
        init_if_needed,
        payer = staker,
        space = 8 + StakePosition::INIT_SPACE,
        seeds = [STAKE_SEED, staker.key().as_ref()],
        bump,
    )]
    pub stake_position: Box<Account<'info, StakePosition>>,
    #[account(
        seeds = [COLLATERAL_SEED, exchange.settlement_mint.as_ref()],
        bump = settlement_collateral.bump,
        has_one = mint,
        has_one = vault,
        has_one = token_program,
    )]
    pub settlement_collateral: Box<Account<'info, Collateral>>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    /// The staker's USDC account (source on stake, destination on withdraw).
    #[account(mut, token::mint = mint, token::token_program = token_program)]
    pub staker_token: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

/// A position from a retired epoch holds nothing: reset it before use.
fn refresh(pos: &mut StakePosition, owner: Pubkey, bump: u8, epoch: u32) {
    if pos.owner == Pubkey::default() {
        pos.owner = owner;
        pos.bump = bump;
        pos.epoch = epoch;
    }
    if pos.epoch != epoch {
        pos.shares = 0;
        pos.pending_unstake_shares = 0;
        pos.unlock_ts = 0;
        pos.epoch = epoch;
    }
}

pub fn handle_stake(ctx: Context<MoveStake>, amount: u64) -> Result<()> {
    require!(!ctx.accounts.exchange.paused, KryonError::Paused);
    require!(amount > 0, KryonError::InvalidAmount);
    let value = i128::from(amount)
        .checked_mul(ctx.accounts.settlement_collateral.scale())
        .ok_or(KryonError::MathOverflow)?;

    let before = ctx.accounts.vault.amount;
    token_interface::transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.staker_token.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.staker.to_account_info(),
            },
        ),
        amount,
        ctx.accounts.mint.decimals,
    )?;
    ctx.accounts.vault.reload()?;
    let received = ctx
        .accounts
        .vault
        .amount
        .checked_sub(before)
        .ok_or(KryonError::MathOverflow)?;
    require!(received == amount, KryonError::TransferAmountMismatch);

    let ins = &mut ctx.accounts.insurance;
    // Price against NAV before the deposit; the first staker (or the first
    // after a wipe) mints 1:1.
    let minted = if ins.total_shares <= 0 || ins.fund <= 0 {
        value
    } else {
        mul_div_floor(value, ins.total_shares, ins.fund).core()?
    };
    require!(minted > 0, KryonError::InvalidAmount);
    ins.fund = checked_add(ins.fund, value).core()?;
    ins.total_shares = checked_add(ins.total_shares, minted).core()?;
    let epoch = ins.epoch;
    let pos = &mut ctx.accounts.stake_position;
    refresh(
        pos,
        ctx.accounts.staker.key(),
        ctx.bumps.stake_position,
        epoch,
    );
    pos.shares = checked_add(pos.shares, minted).core()?;
    emit_cpi!(Staked {
        staker: ctx.accounts.staker.key(),
        amount,
        shares: minted,
        fund: ctx.accounts.insurance.fund,
    });
    Ok(())
}

#[event_cpi]
#[derive(Accounts)]
pub struct RequestUnstake<'info> {
    #[account(seeds = [INSURANCE_SEED], bump = insurance.bump)]
    pub insurance: Box<Account<'info, Insurance>>,
    pub staker: Signer<'info>,
    #[account(
        mut,
        seeds = [STAKE_SEED, staker.key().as_ref()],
        bump = stake_position.bump,
        constraint = stake_position.owner == staker.key() @ KryonError::Unauthorized,
    )]
    pub stake_position: Box<Account<'info, StakePosition>>,
}

/// Start the cooldown on `shares`. One request at a time.
pub fn handle_request_unstake(ctx: Context<RequestUnstake>, shares: i128) -> Result<()> {
    let now = Clock::get()?.unix_timestamp as u64;
    let epoch = ctx.accounts.insurance.epoch;
    let cooldown = ctx.accounts.insurance.unstake_cooldown_secs;
    let pos = &mut ctx.accounts.stake_position;
    let (owner, bump) = (pos.owner, pos.bump);
    refresh(pos, owner, bump, epoch);
    require!(shares > 0, KryonError::InvalidAmount);
    require!(pos.pending_unstake_shares == 0, KryonError::UnstakePending);
    require!(shares <= pos.shares, KryonError::InsufficientShares);
    pos.pending_unstake_shares = shares;
    pos.unlock_ts = now.saturating_add(cooldown);
    emit_cpi!(UnstakeRequested {
        staker: owner,
        shares,
        unlock_ts: pos.unlock_ts,
    });
    Ok(())
}

/// Redeem a matured request at the NAV now. A request that outlived its
/// epoch redeems nothing: a loss already wrote those shares off.
pub fn handle_withdraw_unstaked(ctx: Context<MoveStake>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp as u64;
    let staker = ctx.accounts.staker.key();
    let ins = &mut ctx.accounts.insurance;
    let pos = &mut ctx.accounts.stake_position;
    require!(pos.owner == staker, KryonError::NoPendingUnstake);
    if pos.epoch != ins.epoch {
        let bump = pos.bump;
        refresh(pos, staker, bump, ins.epoch);
        emit_cpi!(Unstaked {
            staker,
            shares: 0,
            amount: 0,
            fund: ins.fund,
        });
        return Ok(());
    }
    let shares = pos.pending_unstake_shares;
    require!(shares > 0, KryonError::NoPendingUnstake);
    require!(now >= pos.unlock_ts, KryonError::UnstakeLocked);

    let scale = ctx.accounts.settlement_collateral.scale();
    let value = mul_div_floor(shares, ins.fund, ins.total_shares)
        .core()?
        .min(ins.fund);
    // Whole token units only; the sub-unit remainder stays in the fund.
    let amount = u64::try_from(value / scale).map_err(|_| error!(KryonError::MathOverflow))?;
    let paid = i128::from(amount) * scale;
    ins.fund = checked_sub(ins.fund, paid).core()?;
    ins.total_shares = checked_sub(ins.total_shares, shares).core()?;
    pos.shares = checked_sub(pos.shares, shares).core()?;
    pos.pending_unstake_shares = 0;
    pos.unlock_ts = 0;
    let fund = ins.fund;

    if amount > 0 {
        let mint_key = ctx.accounts.mint.key();
        let seeds: &[&[u8]] = &[
            COLLATERAL_SEED,
            mint_key.as_ref(),
            &[ctx.accounts.settlement_collateral.bump],
        ];
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.vault.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.staker_token.to_account_info(),
                    authority: ctx.accounts.settlement_collateral.to_account_info(),
                },
                &[seeds],
            ),
            amount,
            ctx.accounts.mint.decimals,
        )?;
    }
    emit_cpi!(Unstaked {
        staker,
        shares,
        amount,
        fund,
    });
    Ok(())
}

/// Draw up to `amount` from the fund; returns what it covered. Retires the
/// shares if the loss takes the fund to zero with shares outstanding.
pub fn cover_deficit(ins: &mut Insurance, amount: i128) -> Result<(i128, Option<SharesRetired>)> {
    if amount <= 0 || ins.fund <= 0 {
        return Ok((0, None));
    }
    let covered = amount.min(ins.fund);
    ins.fund = checked_sub(ins.fund, covered).core()?;
    Ok((covered, retire_if_wiped(ins)))
}

fn retire_if_wiped(ins: &mut Insurance) -> Option<SharesRetired> {
    if ins.fund > 0 || ins.total_shares <= 0 {
        return None;
    }
    let retired = ins.total_shares;
    ins.epoch = ins.epoch.wrapping_add(1);
    ins.total_shares = 0;
    Some(SharesRetired {
        epoch: ins.epoch,
        retired_shares: retired,
    })
}
