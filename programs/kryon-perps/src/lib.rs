use anchor_lang::prelude::*;

declare_id!("2vgBHV763RtsBZGNpnuvbkGDKJdtt1DxP9tUDo4NZxUB");

pub mod constants;
pub mod ed25519;
pub mod error;
pub mod events;
pub mod health;
pub mod instructions;
pub mod oracle;
pub mod order;
pub mod position;
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

    pub fn set_market_oracle(
        ctx: Context<SetMarketOracle>,
        market_id: u16,
        pyth_shard_id: u16,
        max_oracle_age_secs: u64,
        max_oracle_confidence_bps: u32,
    ) -> Result<()> {
        instructions::market_ops::handle_set_market_oracle(
            ctx,
            market_id,
            pyth_shard_id,
            max_oracle_age_secs,
            max_oracle_confidence_bps,
        )
    }

    // --- calendar authority (keeper) ---

    pub fn post_session_calendar(
        ctx: Context<PostSessionCalendar>,
        windows: Vec<SessionWindowArgs>,
    ) -> Result<()> {
        instructions::market_ops::handle_post_session_calendar(ctx, windows)
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

    pub fn cancel_order(
        ctx: Context<CancelOrder>,
        sub_id: u8,
        nonce: u64,
        expiry_ts: u64,
    ) -> Result<()> {
        instructions::orders::handle_cancel_order(ctx, sub_id, nonce, expiry_ts)
    }

    pub fn cancel_all(ctx: Context<OwnerOnly>, below_nonce: u64) -> Result<()> {
        instructions::orders::handle_cancel_all(ctx, below_nonce)
    }

    /// Permissionless.
    pub fn reclaim_order_state(
        ctx: Context<ReclaimOrderState>,
        owner: Pubkey,
        sub_id: u8,
        nonce: u64,
    ) -> Result<()> {
        instructions::orders::handle_reclaim_order_state(ctx, owner, sub_id, nonce)
    }

    // --- operator ---

    /// Remaining accounts: see `instructions::settle`.
    pub fn settle_fills<'info>(
        ctx: Context<'_, '_, 'info, 'info, SettleFills<'info>>,
        fills: Vec<FillArgs>,
    ) -> Result<()> {
        instructions::settle::handle_settle_fills(ctx, fills)
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
