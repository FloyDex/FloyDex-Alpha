//! Admin (Squads + time lock), guardian and bootstrap instructions.

use crate::constants::*;
use crate::error::KryonError;
use crate::events::*;
use crate::state::*;
use anchor_lang::prelude::*;
use risk_engine::SessionPolicy;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct InitExchangeArgs {
    pub domain: [u8; 32],
    pub guardian: Pubkey,
    pub calendar_authority: Pubkey,
    pub fee_config: FeeConfig,
    pub max_total_oi_policy_bps: u32,
}

/// Only the program's upgrade authority may create the exchange, so nobody
/// can front-run the deploy and make themselves admin.
#[derive(Accounts)]
pub struct InitializeExchange<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + Exchange::INIT_SPACE,
        seeds = [EXCHANGE_SEED],
        bump,
    )]
    pub exchange: Account<'info, Exchange>,
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(constraint = program.programdata_address()? == Some(program_data.key()) @ KryonError::NotUpgradeAuthority)]
    pub program: Program<'info, crate::program::KryonPerps>,
    #[account(constraint = program_data.upgrade_authority_address == Some(authority.key()) @ KryonError::NotUpgradeAuthority)]
    pub program_data: Account<'info, ProgramData>,
    pub system_program: Program<'info, System>,
}

pub fn handle_initialize_exchange(
    ctx: Context<InitializeExchange>,
    args: InitExchangeArgs,
) -> Result<()> {
    validate_fees(&args.fee_config)?;
    require!(
        args.max_total_oi_policy_bps <= 1_000_000,
        KryonError::InvalidConfig
    );
    let ex = &mut ctx.accounts.exchange;
    ex.admin = ctx.accounts.authority.key();
    ex.pending_admin = Pubkey::default();
    ex.guardian = args.guardian;
    ex.operators = [Pubkey::default(); MAX_OPERATORS];
    ex.calendar_authority = args.calendar_authority;
    ex.paused = false;
    ex.fee_config = args.fee_config;
    ex.insurance = Pubkey::default();
    ex.domain = args.domain;
    ex.max_total_oi_policy_bps = args.max_total_oi_policy_bps;
    ex.total_oi_policy_bps = 0;
    ex.settlement_mint = Pubkey::default();
    ex.collateral_count = 0;
    ex.bump = ctx.bumps.exchange;
    emit!(ExchangeInitialized {
        admin: ex.admin,
        domain: ex.domain
    });
    Ok(())
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    #[account(mut, seeds = [EXCHANGE_SEED], bump = exchange.bump, has_one = admin @ KryonError::Unauthorized)]
    pub exchange: Account<'info, Exchange>,
    pub admin: Signer<'info>,
}

pub fn handle_nominate_admin(ctx: Context<AdminOnly>, pending_admin: Pubkey) -> Result<()> {
    let ex = &mut ctx.accounts.exchange;
    ex.pending_admin = pending_admin;
    emit!(AdminNominated {
        admin: ex.admin,
        pending_admin
    });
    Ok(())
}

#[derive(Accounts)]
pub struct AcceptAdmin<'info> {
    #[account(mut, seeds = [EXCHANGE_SEED], bump = exchange.bump)]
    pub exchange: Account<'info, Exchange>,
    pub pending_admin: Signer<'info>,
}

pub fn handle_accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
    let ex = &mut ctx.accounts.exchange;
    let signer = ctx.accounts.pending_admin.key();
    require!(
        ex.pending_admin != Pubkey::default() && ex.pending_admin == signer,
        KryonError::NotPendingAdmin
    );
    ex.admin = signer;
    ex.pending_admin = Pubkey::default();
    emit!(AdminAccepted { admin: signer });
    Ok(())
}

fn emit_roles(ex: &Exchange) {
    emit!(RolesUpdated {
        guardian: ex.guardian,
        operators: ex.operators,
        calendar_authority: ex.calendar_authority,
    });
}

pub fn handle_set_operators(
    ctx: Context<AdminOnly>,
    operators: [Pubkey; MAX_OPERATORS],
) -> Result<()> {
    let ex = &mut ctx.accounts.exchange;
    ex.operators = operators;
    emit_roles(ex);
    Ok(())
}

pub fn handle_set_guardian(ctx: Context<AdminOnly>, guardian: Pubkey) -> Result<()> {
    let ex = &mut ctx.accounts.exchange;
    ex.guardian = guardian;
    emit_roles(ex);
    Ok(())
}

pub fn handle_set_calendar_authority(ctx: Context<AdminOnly>, authority: Pubkey) -> Result<()> {
    let ex = &mut ctx.accounts.exchange;
    ex.calendar_authority = authority;
    emit_roles(ex);
    Ok(())
}

/// Trading fees are capped at 1% a side as a fat-finger guard.
fn validate_fees(fee: &FeeConfig) -> Result<()> {
    require!(
        fee.maker_fee_bps <= 100 && fee.taker_fee_bps <= 100,
        KryonError::InvalidConfig
    );
    Ok(())
}

pub fn handle_set_fee_config(ctx: Context<AdminOnly>, fee_config: FeeConfig) -> Result<()> {
    validate_fees(&fee_config)?;
    ctx.accounts.exchange.fee_config = fee_config;
    Ok(())
}

/// KRY-Q11: the ceiling on the sum of every market's `oi_policy_bps`. It may
/// not drop below the sum already committed.
pub fn handle_set_max_total_oi_policy_bps(ctx: Context<AdminOnly>, max_total: u32) -> Result<()> {
    let ex = &mut ctx.accounts.exchange;
    require!(max_total <= 1_000_000, KryonError::InvalidConfig);
    require!(
        max_total >= ex.total_oi_policy_bps,
        KryonError::AggregateOiPolicyExceeded
    );
    ex.max_total_oi_policy_bps = max_total;
    Ok(())
}

pub fn handle_unpause(ctx: Context<AdminOnly>) -> Result<()> {
    let ex = &mut ctx.accounts.exchange;
    ex.paused = false;
    emit!(PauseChanged {
        paused: false,
        by: ctx.accounts.admin.key()
    });
    Ok(())
}

/// The guardian can pause; only the admin can unpause.
#[derive(Accounts)]
pub struct Pause<'info> {
    #[account(mut, seeds = [EXCHANGE_SEED], bump = exchange.bump, has_one = guardian @ KryonError::Unauthorized)]
    pub exchange: Account<'info, Exchange>,
    pub guardian: Signer<'info>,
}

pub fn handle_pause(ctx: Context<Pause>) -> Result<()> {
    let ex = &mut ctx.accounts.exchange;
    ex.paused = true;
    emit!(PauseChanged {
        paused: true,
        by: ctx.accounts.guardian.key()
    });
    Ok(())
}

// --- markets ---

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SessionPolicyArgs {
    pub extended_margin_mult_bps: u32,
    pub closed_margin_mult_bps: u32,
    pub closed_band_base_bps: u32,
    pub closed_band_per_hour_bps: u32,
    pub closed_band_max_bps: u32,
    pub closed_oi_cap_bps: u32,
    pub close_ramp_secs: u32,
    pub close_grace_secs: u32,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct MarketParams {
    pub base_asset: [u8; 16],
    pub pyth_feed_id: [u8; 32],
    pub pyth_shard_id: u16,
    pub max_leverage_bps: u32,
    pub initial_margin_bps: u32,
    pub maintenance_margin_bps: u32,
    pub liquidation_fee_bps: u32,
    pub max_open_interest: i128,
    pub max_oracle_age_secs: u64,
    pub max_oracle_confidence_bps: u32,
    pub max_execution_deviation_bps: u32,
    pub oi_policy_bps: u32,
    pub session_policy: SessionPolicyArgs,
    pub funding_imbalance_coeff: i128,
    pub funding_max_rate_per_hour: i128,
}

/// Every rule from the Stellar vault's `validate_market_config`, plus the
/// Solana-side session, funding and oracle fields.
pub fn validate_market_params(market_id: u16, p: &MarketParams) -> Result<()> {
    let ok = market_id != 0
        && p.initial_margin_bps > 0
        && p.initial_margin_bps <= 10_000
        && p.maintenance_margin_bps > 0
        && p.maintenance_margin_bps <= p.initial_margin_bps
        && p.max_leverage_bps > 0
        && p.liquidation_fee_bps <= 1_000
        && p.max_open_interest > 0
        && p.max_oracle_age_secs > 0
        && p.max_oracle_confidence_bps <= 10_000
        && p.max_execution_deviation_bps > 0
        && p.max_execution_deviation_bps <= 10_000
        && p.pyth_feed_id != [0; 32]
        && p.funding_imbalance_coeff >= 0
        && p.funding_max_rate_per_hour > 0;
    require!(ok, KryonError::InvalidConfig);
    // KRY-Q8: a declared leverage cap may be tighter than the margin implies,
    // never looser.
    let implied = protocol_core::implied_max_leverage_bps(p.initial_margin_bps)
        .map_err(|e| error!(KryonError::from(e)))?;
    require!(p.max_leverage_bps <= implied, KryonError::InvalidConfig);
    let s = &p.session_policy;
    let session_ok = s.extended_margin_mult_bps >= 10_000
        && s.closed_margin_mult_bps >= 10_000
        && s.closed_band_base_bps <= s.closed_band_max_bps
        && s.closed_band_max_bps <= 10_000
        && s.closed_oi_cap_bps <= 10_000
        && s.close_ramp_secs <= MAX_CLOSE_RAMP_SECS
        && s.close_grace_secs <= MAX_CLOSE_GRACE_SECS;
    require!(session_ok, KryonError::InvalidConfig);
    Ok(())
}

#[derive(Accounts)]
#[instruction(market_id: u16)]
pub struct CreateMarket<'info> {
    #[account(mut, seeds = [EXCHANGE_SEED], bump = exchange.bump, has_one = admin @ KryonError::Unauthorized)]
    pub exchange: Account<'info, Exchange>,
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        init,
        payer = admin,
        space = 8 + core::mem::size_of::<Market>(),
        seeds = [MARKET_SEED, &market_id.to_le_bytes()],
        bump,
    )]
    pub market: AccountLoader<'info, Market>,
    pub system_program: Program<'info, System>,
}

pub fn handle_create_market(
    ctx: Context<CreateMarket>,
    market_id: u16,
    p: MarketParams,
) -> Result<()> {
    validate_market_params(market_id, &p)?;
    let ex = &mut ctx.accounts.exchange;
    let total = ex
        .total_oi_policy_bps
        .checked_add(p.oi_policy_bps)
        .ok_or(KryonError::MathOverflow)?;
    require!(
        total <= ex.max_total_oi_policy_bps,
        KryonError::AggregateOiPolicyExceeded
    );
    ex.total_oi_policy_bps = total;

    let mut m = ctx.accounts.market.load_init()?;
    m.market_id = market_id;
    m.bump = ctx.bumps.market;
    m.active = 1;
    m.base_asset = p.base_asset;
    m.pyth_feed_id = p.pyth_feed_id;
    m.pyth_shard_id = p.pyth_shard_id;
    m.max_leverage_bps = p.max_leverage_bps;
    m.initial_margin_bps = p.initial_margin_bps;
    m.maintenance_margin_bps = p.maintenance_margin_bps;
    m.liquidation_fee_bps = p.liquidation_fee_bps;
    m.max_open_interest.set(p.max_open_interest);
    m.max_oracle_age_secs = p.max_oracle_age_secs;
    m.max_oracle_confidence_bps = p.max_oracle_confidence_bps;
    m.max_execution_deviation_bps = p.max_execution_deviation_bps;
    m.oi_policy_bps = p.oi_policy_bps;
    let s = p.session_policy;
    m.session_policy = SessionPolicyPod {
        extended_margin_mult_bps: s.extended_margin_mult_bps,
        closed_margin_mult_bps: s.closed_margin_mult_bps,
        closed_band_base_bps: s.closed_band_base_bps,
        closed_band_per_hour_bps: s.closed_band_per_hour_bps,
        closed_band_max_bps: s.closed_band_max_bps,
        closed_oi_cap_bps: s.closed_oi_cap_bps,
        close_ramp_secs: s.close_ramp_secs,
        close_grace_secs: s.close_grace_secs,
    };
    // Sanity: the policy must round-trip into the risk-engine type.
    let _: SessionPolicy = m.session_policy.into();
    m.funding_imbalance_coeff.set(p.funding_imbalance_coeff);
    m.funding_max_rate_per_hour.set(p.funding_max_rate_per_hour);
    m.funding_last_update = Clock::get()?.unix_timestamp as u64;
    emit!(MarketCreated {
        market_id,
        pyth_feed_id: p.pyth_feed_id
    });
    Ok(())
}
