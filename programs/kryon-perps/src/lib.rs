use anchor_lang::prelude::*;

declare_id!("2vgBHV763RtsBZGNpnuvbkGDKJdtt1DxP9tUDo4NZxUB");

pub mod constants;
pub mod error;
pub mod events;
pub mod health;
pub mod instructions;
pub mod oracle;
pub mod order;
pub mod state;

pub use constants::MAX_OPERATORS;
pub use instructions::*;
pub use state::FeeConfig;

#[cfg(feature = "bench")]
pub mod bench;

// Anchor 0.31's generated dispatcher calls the deprecated `AccountInfo::realloc`.
#[allow(deprecated)]
#[program]
pub mod kryon_perps {
    use super::*;

    // --- admin & bootstrap ---

    pub fn initialize_exchange(
        ctx: Context<InitializeExchange>,
        args: InitExchangeArgs,
    ) -> Result<()> {
        instructions::admin::handle_initialize_exchange(ctx, args)
    }

    pub fn nominate_admin(ctx: Context<AdminOnly>, pending_admin: Pubkey) -> Result<()> {
        instructions::admin::handle_nominate_admin(ctx, pending_admin)
    }

    pub fn accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
        instructions::admin::handle_accept_admin(ctx)
    }

    pub fn set_operators(
        ctx: Context<AdminOnly>,
        operators: [Pubkey; MAX_OPERATORS],
    ) -> Result<()> {
        instructions::admin::handle_set_operators(ctx, operators)
    }

    pub fn set_guardian(ctx: Context<AdminOnly>, guardian: Pubkey) -> Result<()> {
        instructions::admin::handle_set_guardian(ctx, guardian)
    }

    pub fn set_calendar_authority(ctx: Context<AdminOnly>, authority: Pubkey) -> Result<()> {
        instructions::admin::handle_set_calendar_authority(ctx, authority)
    }

    pub fn set_fee_config(ctx: Context<AdminOnly>, fee_config: FeeConfig) -> Result<()> {
        instructions::admin::handle_set_fee_config(ctx, fee_config)
    }

    pub fn pause(ctx: Context<Pause>) -> Result<()> {
        instructions::admin::handle_pause(ctx)
    }

    pub fn unpause(ctx: Context<AdminOnly>) -> Result<()> {
        instructions::admin::handle_unpause(ctx)
    }

    pub fn create_market(
        ctx: Context<CreateMarket>,
        market_id: u16,
        params: MarketParams,
    ) -> Result<()> {
        instructions::admin::handle_create_market(ctx, market_id, params)
    }

    pub fn add_collateral(ctx: Context<AddCollateral>, params: CollateralParams) -> Result<()> {
        instructions::collateral::handle_add_collateral(ctx, params)
    }

    // --- user ---

    pub fn init_user(ctx: Context<InitUser>, sub_id: u8) -> Result<()> {
        instructions::user::handle_init_user(ctx, sub_id)
    }

    pub fn deposit(ctx: Context<MoveCollateral>, amount: u64) -> Result<()> {
        instructions::user::handle_deposit(ctx, amount)
    }

    pub fn set_delegate(ctx: Context<OwnerOnly>, delegate: Pubkey, expiry: i64) -> Result<()> {
        instructions::delegate::handle_set_delegate(ctx, delegate, expiry)
    }

    pub fn revoke_delegate(ctx: Context<OwnerOnly>) -> Result<()> {
        instructions::delegate::handle_revoke_delegate(ctx)
    }

    /// Remaining accounts: see `health` (only needed with positions or debt).
    pub fn withdraw<'info>(
        ctx: Context<'_, '_, 'info, 'info, MoveCollateral<'info>>,
        amount: u64,
    ) -> Result<()> {
        instructions::user::handle_withdraw(ctx, amount)
    }

    /// Compute-unit benchmark for `protocol_core::mul_div`. Only compiled with
    /// the `bench` feature; never part of a deployable build.
    #[cfg(feature = "bench")]
    pub fn bench_mul_div(_ctx: Context<Bench>, a: i128, b: i128, denominator: i128) -> Result<()> {
        bench::mul_div(a, b, denominator)
    }
}

#[cfg(feature = "bench")]
#[derive(Accounts)]
pub struct Bench {}

#[cfg(test)]
mod layout_tests;
