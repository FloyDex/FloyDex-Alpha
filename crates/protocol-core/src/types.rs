//! Chain-agnostic domain types.
//!
//! Ported from the Soroban version: `Address` became a raw 32-byte key (a
//! Solana `Pubkey` is exactly `[u8; 32]`), `Symbol` became a fixed 16-byte
//! asset code, and the Soroban `Vec`/`Map` host types became borrowed slices,
//! so the math runs unchanged inside an Anchor program, an off-chain keeper,
//! or a unit test.

/// A 32-byte account key. On Solana this is `Pubkey::to_bytes()`.
pub type AccountKey = [u8; 32];

/// A fixed-width, zero-padded asset code such as `b"TSLA"`.
pub type AssetCode = [u8; 16];

/// Build an [`AssetCode`] from a short ASCII string, zero-padded.
pub const fn asset_code(s: &str) -> AssetCode {
    let bytes = s.as_bytes();
    let mut out = [0u8; 16];
    let mut i = 0;
    while i < bytes.len() && i < 16 {
        out[i] = bytes[i];
        i += 1;
    }
    out
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MarginMode {
    Cross,
    Isolated,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct MarketId(pub u32);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct MarketConfig {
    pub market_id: u32,
    pub base_asset: AssetCode,
    pub settlement_asset: AccountKey,
    pub max_leverage_bps: u32,
    pub initial_margin_bps: u32,
    pub maintenance_margin_bps: u32,
    pub liquidation_fee_bps: u32,
    pub max_open_interest: i128,
    pub max_oracle_age_secs: u64,
    pub max_oracle_confidence_bps: u32,
    pub active: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Position {
    pub position_id: u64,
    pub owner: AccountKey,
    pub market_id: u32,
    pub size: i128,
    pub entry_price: i128,
    pub margin: i128,
    pub is_long: bool,
    pub last_funding_index: i128,
    pub mode: MarginMode,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CollateralBalance {
    pub asset: AccountKey,
    pub amount: i128,
    pub value: i128,
    pub haircut_bps: u32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CollateralConfig {
    pub asset: AccountKey,
    pub oracle_asset: AssetCode,
    pub haircut_bps: u32,
    pub active: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct AccountSnapshot<'a> {
    pub owner: AccountKey,
    pub collateral: &'a [CollateralBalance],
    pub positions: &'a [Position],
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct MarketSnapshot {
    pub config: MarketConfig,
    pub oracle_price: i128,
    pub funding_index_long: i128,
    pub funding_index_short: i128,
}

/// Replaces the Soroban `Map<u32, MarketSnapshot>`: anything that can resolve
/// a market id to its snapshot. A slice is searched linearly, which is the
/// right trade-off on-chain where an account touches a handful of markets.
pub trait MarketLookup {
    fn market(&self, market_id: u32) -> Option<&MarketSnapshot>;
}

impl MarketLookup for [MarketSnapshot] {
    fn market(&self, market_id: u32) -> Option<&MarketSnapshot> {
        self.iter().find(|m| m.config.market_id == market_id)
    }
}

impl<const N: usize> MarketLookup for [MarketSnapshot; N] {
    fn market(&self, market_id: u32) -> Option<&MarketSnapshot> {
        self.as_slice().market(market_id)
    }
}
