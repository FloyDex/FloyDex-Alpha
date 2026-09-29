use anchor_lang::prelude::*;

/// One accepted collateral mint. PDA `["collateral", mint]`; its token
/// account is the PDA `["vault", mint]`, owned by this account.
#[account]
#[derive(InitSpace, Debug)]
pub struct Collateral {
    pub mint: Pubkey,
    /// SPL Token or Token-2022, whichever owns `mint`.
    pub token_program: Pubkey,
    pub vault: Pubkey,
    pub decimals: u8,
    /// Index into balance slots; assigned in `add_collateral` order.
    pub index: u8,
    /// The settlement asset: PnL, fees and funding settle in it and it is
    /// valued at par (no oracle). Exactly one collateral has this set.
    pub is_settlement: bool,
    pub active: bool,
    pub haircut_bps: u32,
    /// Pyth feed for non-settlement collateral. Zero for the settlement asset.
    pub pyth_feed_id: [u8; 32],
    /// Pyth push-feed shard for `pyth_feed_id` (0 = sponsored feeds).
    pub pyth_shard_id: u16,
    pub max_oracle_age_secs: u64,
    pub max_oracle_confidence_bps: u32,
    /// Max `total_deposited`, in token base units.
    pub deposit_cap: u64,
    /// Deposits net of withdrawals, in token base units. Drives the cap.
    pub total_deposited: u64,
    /// Trading fees collected, PRECISION-scaled (settlement collateral only).
    pub fees_accrued: i128,
    pub bump: u8,
    pub vault_bump: u8,
    /// Extra haircut while the price is from a closed market (`06` §6: the
    /// feed is past `max_oracle_age_secs` but within `max_closed_age_secs`).
    pub closed_haircut_bps: u32,
    /// How old a price may be and still value this collateral, at the closed
    /// haircut. 0 = never: a stale price blocks valuation.
    pub max_closed_age_secs: u64,
    pub _reserved: [u8; 20],
}

impl Collateral {
    /// Token base units → PRECISION (1e18) units.
    pub fn scale(&self) -> i128 {
        10i128.pow(u32::from(crate::constants::MAX_DECIMALS - self.decimals))
    }
}
