//! Live CLOB for one market. PDA `["book", market_id u16 LE]`.
//!
//! Resting limit orders live here. `place_order` matches against the opposite
//! side and rests any remainder. Position settlement still goes through
//! `settle_fills` + Ed25519; this account is the on-chain book the UI reads.

use crate::constants::BOOK_DEPTH;
use crate::error::FloyDexError;
use anchor_lang::prelude::*;

/// One resting order. `size == 0` is an empty slot.
#[zero_copy]
#[derive(Default, Debug, PartialEq, Eq)]
pub struct BookOrder {
    pub owner: Pubkey,
    /// Limit price, 1e9-scaled (`WIRE_TO_PRECISION`).
    pub price: u64,
    /// Remaining size, 1e9-scaled.
    pub size: u64,
    pub nonce: u64,
    pub expiry_ts: u64,
    pub sub_id: u8,
    /// 1 = bid (long / buy), 0 = ask (short / sell).
    pub is_long: u8,
    pub _pad: [u8; 6],
}

impl BookOrder {
    pub fn is_empty(&self) -> bool {
        self.size == 0
    }
}

/// Price-time book. Bids are best-first (high price), asks best-first (low).
#[account(zero_copy)]
#[derive(Debug)]
pub struct MarketBook {
    pub seq: u64,
    pub market_id: u16,
    pub bump: u8,
    pub bid_count: u8,
    pub ask_count: u8,
    pub _pad: [u8; 3],
    pub bids: [BookOrder; BOOK_DEPTH],
    pub asks: [BookOrder; BOOK_DEPTH],
}

impl MarketBook {
    pub fn bids_mut(&mut self) -> &mut [BookOrder] {
        &mut self.bids[..self.bid_count as usize]
    }

    pub fn asks_mut(&mut self) -> &mut [BookOrder] {
        &mut self.asks[..self.ask_count as usize]
    }

    /// Insert a bid, highest price first. Same price: FIFO (append after equals).
    pub fn insert_bid(&mut self, order: BookOrder) -> Result<()> {
        insert_sorted(&mut self.bids, &mut self.bid_count, order, |a, b| {
            a.price > b.price
        })
    }

    /// Insert an ask, lowest price first. Same price: FIFO.
    pub fn insert_ask(&mut self, order: BookOrder) -> Result<()> {
        insert_sorted(&mut self.asks, &mut self.ask_count, order, |a, b| {
            a.price < b.price
        })
    }

    pub fn remove_owner_nonce(&mut self, owner: &Pubkey, nonce: u64) -> bool {
        let bid = remove_nonce(&mut self.bids, &mut self.bid_count, owner, nonce);
        let ask = remove_nonce(&mut self.asks, &mut self.ask_count, owner, nonce);
        bid || ask
    }

    pub fn compact_expired(&mut self, now: u64) {
        compact_expired(&mut self.bids, &mut self.bid_count, now);
        compact_expired(&mut self.asks, &mut self.ask_count, now);
    }

    pub fn bump_seq(&mut self) {
        self.seq = self.seq.saturating_add(1);
    }
}

fn insert_sorted<F>(
    side: &mut [BookOrder; BOOK_DEPTH],
    count: &mut u8,
    order: BookOrder,
    better: F,
) -> Result<()>
where
    F: Fn(&BookOrder, &BookOrder) -> bool,
{
    require!(order.size > 0, FloyDexError::InvalidAmount);
    let n = *count as usize;
    if n >= BOOK_DEPTH {
        let worst = &side[BOOK_DEPTH - 1];
        require!(better(&order, worst), FloyDexError::BookFull);
        // Drop the worst resting order so a more aggressive quote can land.
        *count = (BOOK_DEPTH - 1) as u8;
    }
    let n = *count as usize;
    let mut i = n;
    while i > 0 && better(&order, &side[i - 1]) {
        side[i] = side[i - 1];
        i -= 1;
    }
    side[i] = order;
    *count = (n + 1) as u8;
    Ok(())
}

fn remove_nonce(
    side: &mut [BookOrder; BOOK_DEPTH],
    count: &mut u8,
    owner: &Pubkey,
    nonce: u64,
) -> bool {
    let n = *count as usize;
    for i in 0..n {
        if side[i].owner == *owner && side[i].nonce == nonce {
            for j in i..n.saturating_sub(1) {
                side[j] = side[j + 1];
            }
            if n > 0 {
                side[n - 1] = BookOrder::default();
            }
            *count = n.saturating_sub(1) as u8;
            return true;
        }
    }
    false
}

fn compact_expired(side: &mut [BookOrder; BOOK_DEPTH], count: &mut u8, now: u64) {
    let n = *count as usize;
    let mut w = 0;
    for r in 0..n {
        let keep = side[r].size > 0 && (side[r].expiry_ts == 0 || side[r].expiry_ts > now);
        if keep {
            if w != r {
                side[w] = side[r];
            }
            w += 1;
        }
    }
    for slot in side.iter_mut().skip(w) {
        *slot = BookOrder::default();
    }
    *count = w as u8;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn empty() -> MarketBook {
        bytemuck::Zeroable::zeroed()
    }

    fn bid(price: u64, size: u64, nonce: u64) -> BookOrder {
        BookOrder {
            owner: Pubkey::new_from_array([1; 32]),
            price,
            size,
            nonce,
            expiry_ts: 0,
            sub_id: 0,
            is_long: 1,
            _pad: [0; 6],
        }
    }

    #[test]
    fn bids_sort_high_to_low() {
        let mut b = empty();
        b.insert_bid(bid(10, 1, 1)).unwrap();
        b.insert_bid(bid(30, 1, 2)).unwrap();
        b.insert_bid(bid(20, 1, 3)).unwrap();
        assert_eq!(b.bid_count, 3);
        assert_eq!(b.bids[0].price, 30);
        assert_eq!(b.bids[1].price, 20);
        assert_eq!(b.bids[2].price, 10);
    }

    #[test]
    fn cancel_by_nonce() {
        let mut b = empty();
        b.insert_bid(bid(10, 1, 7)).unwrap();
        assert!(b.remove_owner_nonce(&Pubkey::new_from_array([1; 32]), 7));
        assert_eq!(b.bid_count, 0);
    }
}

/// Walk the opposite side, fill while prices cross, compact empties.
/// Returns (filled_size, last_fill_price).
pub fn match_against(
    opposite: &mut [BookOrder],
    opposite_count: &mut u8,
    taker: &Pubkey,
    limit: u64,
    mut remaining: u64,
    taker_is_long: bool,
    now: u64,
    mut on_fill: impl FnMut(BookOrder, u64),
) -> Result<(u64, u64)> {
    let mut filled = 0u64;
    let mut last_px = 0u64;
    let n = *opposite_count as usize;
    let mut r = 0;
    while r < n && remaining > 0 {
        let maker = opposite[r];
        if maker.size == 0 || (maker.expiry_ts != 0 && maker.expiry_ts <= now) {
            r += 1;
            continue;
        }
        let crosses = if taker_is_long {
            maker.price <= limit
        } else {
            maker.price >= limit
        };
        if !crosses {
            break;
        }
        require!(maker.owner != *taker, FloyDexError::SelfTrade);
        let qty = core::cmp::min(remaining, maker.size);
        on_fill(maker, qty);
        opposite[r].size = maker.size.saturating_sub(qty);
        remaining = remaining.saturating_sub(qty);
        filled = filled.saturating_add(qty);
        last_px = maker.price;
        r += 1;
    }
    // Compact consumed / expired makers to the front.
    let mut w = 0;
    for i in 0..n {
        if opposite[i].size > 0 && (opposite[i].expiry_ts == 0 || opposite[i].expiry_ts > now) {
            if w != i {
                opposite[w] = opposite[i];
            }
            w += 1;
        }
    }
    for slot in opposite.iter_mut().skip(w) {
        *slot = BookOrder::default();
    }
    *opposite_count = w as u8;
    Ok((filled, last_px))
}
