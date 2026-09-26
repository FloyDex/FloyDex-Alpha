use super::pod::PodI128;
use crate::constants::{MAX_BALANCES, MAX_POSITIONS};
use anchor_lang::prelude::*;
use protocol_core::{MarginMode, Position};

/// One collateral balance, PRECISION-scaled. May go negative (realized losses
/// on an account whose collateral is not the settlement asset).
#[zero_copy]
#[derive(Default, Debug, PartialEq, Eq)]
pub struct BalanceSlot {
    pub amount: PodI128,
    pub collateral_index: u8,
    pub in_use: u8,
    pub _pad: [u8; 6],
}

/// One open position. Always cross margin: isolated stays disabled until a
/// real per-position margin ledger exists (`11` L10).
#[zero_copy]
#[derive(Default, Debug, PartialEq, Eq)]
pub struct PositionSlot {
    pub position_id: u64,
    pub size: PodI128,
    pub entry_price: PodI128,
    pub last_funding_index: PodI128,
    pub market_id: u16,
    pub is_long: u8,
    pub in_use: u8,
    pub _pad: [u8; 4],
}

impl PositionSlot {
    pub fn to_position(&self, owner: &Pubkey) -> Position {
        Position {
            position_id: self.position_id,
            owner: owner.to_bytes(),
            market_id: u32::from(self.market_id),
            size: self.size.get(),
            entry_price: self.entry_price.get(),
            margin: 0,
            is_long: self.is_long != 0,
            last_funding_index: self.last_funding_index.get(),
            mode: MarginMode::Cross,
        }
    }
}

/// A trader's sub-account. PDA `["user", owner, sub_id]`. Zero-copy.
#[account(zero_copy)]
#[derive(Debug)]
pub struct UserAccount {
    pub owner: Pubkey,
    /// Session key allowed to sign orders (never withdrawals). Default = none.
    pub delegate: Pubkey,
    pub delegate_expiry: i64,
    /// Every order with a lower nonce is cancelled.
    pub cancel_all_below_nonce: u64,
    pub next_position_id: u64,
    pub balances: [BalanceSlot; MAX_BALANCES],
    pub positions: [PositionSlot; MAX_POSITIONS],
    pub sub_id: u8,
    pub bump: u8,
    pub open_positions: u8,
    pub _pad: [u8; 5],
    /// When a fill last opened or grew exposure. An account that has not
    /// added exposure since a close's margin ramp began gets the grace
    /// window at liquidation (`07` §2).
    pub last_increase_ts: u64,
    pub _reserved: [u8; 56],
}

impl UserAccount {
    /// True if `signer` may sign orders for this account at `now`.
    pub fn can_sign_orders(&self, signer: &Pubkey, now: i64) -> bool {
        *signer == self.owner
            || (*signer == self.delegate
                && self.delegate != Pubkey::default()
                && now < self.delegate_expiry)
    }

    pub fn balance(&self, collateral_index: u8) -> i128 {
        self.balances
            .iter()
            .find(|b| b.in_use != 0 && b.collateral_index == collateral_index)
            .map_or(0, |b| b.amount.get())
    }

    /// Add `delta` to a balance, taking a free slot if needed. A slot that
    /// returns to exactly zero is released.
    pub fn apply_balance(&mut self, collateral_index: u8, delta: i128) -> Result<i128> {
        let slot = match self
            .balances
            .iter()
            .position(|b| b.in_use != 0 && b.collateral_index == collateral_index)
        {
            Some(i) => i,
            None => {
                if delta == 0 {
                    return Ok(0);
                }
                let i = self
                    .balances
                    .iter()
                    .position(|b| b.in_use == 0)
                    .ok_or(crate::error::KryonError::TooManyBalances)?;
                self.balances[i] = BalanceSlot {
                    amount: PodI128::ZERO,
                    collateral_index,
                    in_use: 1,
                    _pad: [0; 6],
                };
                i
            }
        };
        let b = &mut self.balances[slot];
        let next = b
            .amount
            .get()
            .checked_add(delta)
            .ok_or(crate::error::KryonError::MathOverflow)?;
        b.amount.set(next);
        if next == 0 {
            *b = BalanceSlot::default();
        }
        Ok(next)
    }

    pub fn find_position(&self, market_id: u16) -> Option<usize> {
        self.positions
            .iter()
            .position(|p| p.in_use != 0 && p.market_id == market_id)
    }

    /// Copy open positions into `out` for `risk-engine`; returns the count.
    pub fn positions_into(&self, out: &mut [Position; MAX_POSITIONS]) -> usize {
        let mut n = 0;
        for p in self.positions.iter().filter(|p| p.in_use != 0) {
            out[n] = p.to_position(&self.owner);
            n += 1;
        }
        n
    }
}
