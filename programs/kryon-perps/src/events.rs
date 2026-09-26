//! Events for the indexer (`05` §3). User-facing flows use `emit_cpi!` so the
//! event survives log truncation.

use anchor_lang::prelude::*;

#[event]
pub struct ExchangeInitialized {
    pub admin: Pubkey,
    pub domain: [u8; 32],
}

#[event]
pub struct AdminNominated {
    pub admin: Pubkey,
    pub pending_admin: Pubkey,
}

#[event]
pub struct AdminAccepted {
    pub admin: Pubkey,
}

#[event]
pub struct RolesUpdated {
    pub guardian: Pubkey,
    pub operators: [Pubkey; crate::constants::MAX_OPERATORS],
    pub calendar_authority: Pubkey,
}

#[event]
pub struct PauseChanged {
    pub paused: bool,
    pub by: Pubkey,
}

#[event]
pub struct MarketCreated {
    pub market_id: u16,
    pub pyth_feed_id: [u8; 32],
}

#[event]
pub struct CollateralAdded {
    pub mint: Pubkey,
    pub index: u8,
    pub is_settlement: bool,
}

#[event]
pub struct Deposit {
    pub owner: Pubkey,
    pub sub_id: u8,
    pub mint: Pubkey,
    pub amount: u64,
}

#[event]
pub struct Withdraw {
    pub owner: Pubkey,
    pub sub_id: u8,
    pub mint: Pubkey,
    pub amount: u64,
}

#[event]
pub struct DelegateSet {
    pub owner: Pubkey,
    pub sub_id: u8,
    pub delegate: Pubkey,
    pub expiry: i64,
}

#[event]
pub struct OrderCancelled {
    pub owner: Pubkey,
    pub sub_id: u8,
    pub nonce: u64,
    pub below_nonce: u64,
}

#[event]
pub struct FillSettled {
    pub market_id: u16,
    pub maker: Pubkey,
    pub taker: Pubkey,
    pub size: i128,
    pub price: i128,
    pub maker_fee: i128,
    pub taker_fee: i128,
}

#[event]
pub struct PositionChanged {
    pub owner: Pubkey,
    pub sub_id: u8,
    pub market_id: u16,
    pub position_id: u64,
    pub is_long: bool,
    pub size: i128,
    pub entry_price: i128,
    pub realized_pnl: i128,
}

#[event]
pub struct SessionChanged {
    pub market_id: u16,
    pub session: u8,
}

#[event]
pub struct MarkPosted {
    pub market_id: u16,
    /// The posted mid after clamping to the band.
    pub mid: i128,
    pub mark_ema: i128,
}

#[event]
pub struct FundingUpdated {
    pub market_id: u16,
    pub session: u8,
    /// PRECISION-scaled premium of the book over the index.
    pub premium: i128,
    pub rate_per_hour: i128,
    pub long_index: i128,
    pub short_index: i128,
}

#[event]
pub struct Staked {
    pub staker: Pubkey,
    pub amount: u64,
    pub shares: i128,
    pub fund: i128,
}

#[event]
pub struct UnstakeRequested {
    pub staker: Pubkey,
    pub shares: i128,
    pub unlock_ts: u64,
}

#[event]
pub struct Unstaked {
    pub staker: Pubkey,
    pub shares: i128,
    pub amount: u64,
    pub fund: i128,
}

/// A loss took the fund to zero with shares outstanding: they are retired.
#[event]
pub struct SharesRetired {
    pub epoch: u32,
    pub retired_shares: i128,
}

#[event]
pub struct Liquidated {
    pub owner: Pubkey,
    pub sub_id: u8,
    pub liquidator: Pubkey,
    pub market_id: u16,
    pub position_id: u64,
    pub size: i128,
    pub price: i128,
    pub penalty: i128,
    pub reward: i128,
    pub to_insurance: i128,
    /// Settlement credit from the user's other collateral, sold to the liquidator.
    pub seized_credit: i128,
}

#[event]
pub struct BadDebt {
    pub owner: Pubkey,
    pub sub_id: u8,
    /// Drawn from the insurance fund.
    pub covered: i128,
    /// Beyond the fund: recorded as bad debt.
    pub written_off: i128,
    pub total_bad_debt: i128,
}
