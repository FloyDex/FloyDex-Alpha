use anchor_lang::prelude::*;

/// The insurance fund. PDA `["insurance"]`.
///
/// Its money lives in the settlement collateral's vault as a ledger entry,
/// like trading fees, so conservation stays one equation per mint:
/// `vault + bad_debt ≥ balances + fees + fund + Σ unrealized` (`05` §7).
/// `fund` is the stakers' NAV: stakes add to it, the insurance share of
/// liquidation penalties grows it, and covering deficits draws it down.
#[account]
#[derive(InitSpace, Debug)]
pub struct Insurance {
    /// The settlement collateral's vault (where the fund's tokens sit).
    pub usdc_vault: Pubkey,
    /// NAV, PRECISION-scaled settlement units.
    pub fund: i128,
    /// Shares outstanding in the current epoch.
    pub total_shares: i128,
    /// Losses the fund could not cover, PRECISION-scaled. Only `adl` pays
    /// it down.
    pub bad_debt: i128,
    /// Bumped when a loss takes the fund to zero with shares outstanding:
    /// every share from an older epoch is worthless (retired in one write).
    pub epoch: u32,
    pub unstake_cooldown_secs: u64,
    pub bump: u8,
    pub _reserved: [u8; 64],
}

/// One staker's shares. PDA `["stake", owner]`.
#[account]
#[derive(InitSpace, Debug)]
pub struct StakePosition {
    pub owner: Pubkey,
    /// Shares held, valid only while `epoch == Insurance.epoch`.
    pub shares: i128,
    /// Shares in a pending unstake request (still counted in `shares`, and
    /// still exposed to losses, until withdrawn).
    pub pending_unstake_shares: i128,
    pub unlock_ts: u64,
    pub epoch: u32,
    pub bump: u8,
}

impl StakePosition {
    /// Shares that still count: zero if a loss retired their epoch.
    pub fn live_shares(&self, epoch: u32) -> i128 {
        if self.epoch == epoch {
            self.shares
        } else {
            0
        }
    }
}
