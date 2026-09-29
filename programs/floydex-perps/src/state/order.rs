use anchor_lang::prelude::*;

/// Fill and cancel state for one signed order.
/// PDA `["order", owner, sub_id, nonce LE]`. Closed by `reclaim_order_state`.
#[account]
#[derive(InitSpace, Debug)]
pub struct OrderRecord {
    /// Size filled so far, PRECISION-scaled.
    pub filled: i128,
    /// Tombstone: the order is cancelled and the record must survive until
    /// this time. Zero = not cancelled.
    pub cancelled_until: u64,
    /// The signed order's expiry (0 while only a tombstone exists).
    pub expiry_ts: u64,
    /// Who paid rent; `reclaim_order_state` refunds it here.
    pub payer: Pubkey,
    pub bump: u8,
}

impl OrderRecord {
    pub fn is_cancelled(&self) -> bool {
        self.cancelled_until != 0
    }

    /// The record can be closed once no order under it can ever fill again
    /// and any tombstone has served its purpose.
    pub fn reclaimable_at(&self) -> u64 {
        core::cmp::max(self.expiry_ts, self.cancelled_until)
    }
}
