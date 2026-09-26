use crate::constants::MAX_OPERATORS;
use anchor_lang::prelude::*;

#[derive(
    AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Default, PartialEq, Eq, InitSpace,
)]
pub struct FeeConfig {
    pub maker_fee_bps: u32,
    pub taker_fee_bps: u32,
}

/// Global configuration. PDA `["exchange"]`.
#[account]
#[derive(InitSpace, Debug)]
pub struct Exchange {
    /// Squads vault on mainnet. Everything admin-only checks this key.
    pub admin: Pubkey,
    /// Set by `nominate_admin`, cleared by `accept_admin`. Default = none.
    pub pending_admin: Pubkey,
    /// Hot key that can only pause.
    pub guardian: Pubkey,
    /// Matcher keys allowed to call `settle_fills`. Default = empty slot.
    pub operators: [Pubkey; MAX_OPERATORS],
    /// Keeper key that posts session windows.
    pub calendar_authority: Pubkey,
    pub paused: bool,
    pub fee_config: FeeConfig,
    /// `Insurance` PDA (Phase 2). Default until then.
    pub insurance: Pubkey,
    /// `sha256(genesis_hash || program_id)`, computed off-chain (a program
    /// cannot read the genesis hash). Bound into every signed order.
    pub domain: [u8; 32],
    /// Ceiling on the sum of every market's `oi_policy_bps` (`11` L11).
    pub max_total_oi_policy_bps: u32,
    /// Running sum of every market's `oi_policy_bps`.
    pub total_oi_policy_bps: u32,
    /// Mint of the settlement collateral (USDC). Default until added.
    pub settlement_mint: Pubkey,
    /// `Collateral.index` of the settlement asset (valid once it is added).
    pub settlement_collateral_index: u8,
    /// Collaterals added so far; the next one gets this index.
    pub collateral_count: u8,
    pub bump: u8,
    pub _reserved: [u8; 64],
}

impl Exchange {
    pub fn is_operator(&self, key: &Pubkey) -> bool {
        *key != Pubkey::default() && self.operators.contains(key)
    }
}
