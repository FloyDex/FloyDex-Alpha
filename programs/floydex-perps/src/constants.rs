//! Seeds and protocol-wide limits.

use anchor_lang::prelude::Pubkey;

pub const EXCHANGE_SEED: &[u8] = b"exchange";
pub const MARKET_SEED: &[u8] = b"market";
pub const BOOK_SEED: &[u8] = b"book";
pub const COLLATERAL_SEED: &[u8] = b"collateral";
pub const VAULT_SEED: &[u8] = b"vault";
pub const USER_SEED: &[u8] = b"user";
pub const ORDER_SEED: &[u8] = b"order";
pub const INSURANCE_SEED: &[u8] = b"insurance";
pub const STAKE_SEED: &[u8] = b"stake";

/// Resting orders per side on a `MarketBook`.
pub const BOOK_DEPTH: usize = 16;

/// Operator keys the matcher may rotate between.
pub const MAX_OPERATORS: usize = 4;
/// Collateral balances one `UserAccount` can hold at once.
pub const MAX_BALANCES: usize = 8;
/// Open positions one `UserAccount` can hold at once. Well under
/// `risk_engine::MAX_POSITIONS_PER_ACCOUNT` so health stays bounded.
pub const MAX_POSITIONS: usize = 16;
/// Posted session windows a market keeps (a ring).
pub const CALENDAR_LEN: usize = 16;

/// Longest lifetime a signed order may have, from the Stellar gateway.
pub const MAX_ORDER_TTL_SECS: u64 = 7 * 86_400;

/// Token amounts are converted to `PRECISION` (1e18) at the vault edge, so a
/// mint may have at most 18 decimals.
pub const MAX_DECIMALS: u8 = 18;
/// Order sizes and prices travel as u64 at 1e9; widen by this to reach 1e18.
pub const WIRE_TO_PRECISION: i128 = 1_000_000_000;

/// Liquidator reward ceiling (`05` §2: `max_reward_bps` ≤ 10%).
pub const MAX_REWARD_BPS_CEILING: u32 = 1_000;
/// Longest unstake cooldown the admin may set.
pub const MAX_UNSTAKE_COOLDOWN_SECS: u64 = 90 * 86_400;

/// Longest margin ramp before a close, and grace after it, a market may set.
pub const MAX_CLOSE_RAMP_SECS: u32 = 4 * 3_600;
pub const MAX_CLOSE_GRACE_SECS: u32 = 4 * 3_600;

/// Oldest price a collateral may be valued at (a long weekend plus a
/// holiday), at its closed haircut.
pub const MAX_CLOSED_PRICE_AGE_SECS: u64 = 5 * 86_400;

/// Largest move of the mark EMA per update, from a fill or a posted mid.
pub const MARK_MAX_STEP_BPS: u32 = 50;
/// `post_mark` rate limit per market.
pub const POST_MARK_MIN_INTERVAL_SECS: u64 = 10;
/// Funding treats an EMA older than this as no premium (no recent book).
pub const MARK_EMA_MAX_AGE_SECS: u64 = 900;

/// Platform trading fee on every fill, both sides (buy and sell). 100 bps = 1%.
pub const PLATFORM_FEE_BPS: u32 = 100;
/// USDC destination for collected platform fees.
pub const FEE_COLLECTOR: Pubkey =
    anchor_lang::solana_program::pubkey!("HPXzdeaarrnLL8PKGi11PT2BBd8HY5yty7WwDBZavCbn");

const _: () = assert!(MAX_POSITIONS <= risk_engine::MAX_POSITIONS_PER_ACCOUNT);
