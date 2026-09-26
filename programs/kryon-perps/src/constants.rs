//! Seeds and protocol-wide limits.

pub const EXCHANGE_SEED: &[u8] = b"exchange";
pub const MARKET_SEED: &[u8] = b"market";
pub const COLLATERAL_SEED: &[u8] = b"collateral";
pub const VAULT_SEED: &[u8] = b"vault";
pub const USER_SEED: &[u8] = b"user";
pub const ORDER_SEED: &[u8] = b"order";

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

const _: () = assert!(MAX_POSITIONS <= risk_engine::MAX_POSITIONS_PER_ACCOUNT);
