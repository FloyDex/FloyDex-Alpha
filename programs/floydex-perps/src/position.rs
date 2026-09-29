//! Position effects of one side of a fill, ported from the Stellar gateway's
//! `settle_user_side` and the engine's open/increase/reduce:
//!
//! - an opposite position is reduced first; any residual opens a new
//!   position in the fill's direction (refused if reduce-only);
//! - a same-side position increases, with a volume-weighted entry;
//! - otherwise a new position opens.
//!
//! Rounding goes against the user (decided 2026-09-26): realized PnL and
//! funding round toward −∞, fees round up, and a VWAP entry rounds up for a
//! long and down for a short.

use crate::error::{CoreResultExt, FloyDexError};
use crate::state::*;
use anchor_lang::prelude::*;
use protocol_core::{
    checked_add, checked_sub, mul_div_ceil, mul_div_floor, BPS_DENOMINATOR, PRECISION,
};

/// Open-interest change of one side, split by direction.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct OiDelta {
    pub long: i128,
    pub short: i128,
}

impl OiDelta {
    fn add(&mut self, is_long: bool, v: i128) -> Result<()> {
        let slot = if is_long {
            &mut self.long
        } else {
            &mut self.short
        };
        *slot = checked_add(*slot, v).core()?;
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct SideOutcome {
    /// Realized trade PnL plus settled funding, credited to the settlement balance.
    pub pnl: i128,
    /// Whether this side opened or grew exposure.
    pub increased: bool,
    pub oi: OiDelta,
    /// The position after the fill (size 0 if closed).
    pub position_id: u64,
    pub size_after: i128,
    pub entry_after: i128,
    pub is_long_after: bool,
}

/// Funding owed on a position since its last settlement, rounded against
/// the holder: `-(size · (index − last))`, toward −∞.
fn funding_pnl(slot: &PositionSlot, index: i128) -> Result<i128> {
    let delta = checked_sub(index, slot.last_funding_index.get()).core()?;
    mul_div_floor(-slot.size.get(), delta, PRECISION).core()
}

/// PnL of closing `size` of `slot` at `price`, toward −∞.
fn realized_pnl(slot: &PositionSlot, size: i128, price: i128) -> Result<i128> {
    let entry = slot.entry_price.get();
    let per_unit = if slot.is_long != 0 {
        checked_sub(price, entry)
    } else {
        checked_sub(entry, price)
    }
    .core()?;
    mul_div_floor(size, per_unit, PRECISION).core()
}

/// Apply one side of a fill to `u`. `size` and `price` are PRECISION-scaled
/// and already validated positive. `funding_long/short` are the market's
/// current indexes.
#[allow(clippy::too_many_arguments)]
pub fn apply_side(
    u: &mut UserAccount,
    market_id: u16,
    is_long: bool,
    reduce_only: bool,
    size: i128,
    price: i128,
    funding_long: i128,
    funding_short: i128,
) -> Result<SideOutcome> {
    let index_for = |long: bool| if long { funding_long } else { funding_short };
    let mut out = SideOutcome {
        is_long_after: is_long,
        ..Default::default()
    };
    match u.find_position(market_id) {
        Some(i) if (u.positions[i].is_long != 0) != is_long => {
            // Reduce the opposite position, then open the residual.
            let slot = u.positions[i];
            let slot_long = slot.is_long != 0;
            let close = core::cmp::min(slot.size.get(), size);
            let funding = funding_pnl(&slot, index_for(slot_long))?;
            let realized = realized_pnl(&slot, close, price)?;
            out.pnl = checked_add(funding, realized).core()?;
            out.oi.add(slot_long, -close)?;
            let remaining = checked_sub(slot.size.get(), close).core()?;
            out.position_id = slot.position_id;
            if remaining == 0 {
                u.positions[i] = PositionSlot::default();
                u.open_positions = u.open_positions.saturating_sub(1);
            } else {
                let p = &mut u.positions[i];
                p.size.set(remaining);
                p.last_funding_index.set(index_for(slot_long));
                out.size_after = remaining;
                out.entry_after = slot.entry_price.get();
                out.is_long_after = slot_long;
            }
            let residual = checked_sub(size, close).core()?;
            if residual > 0 {
                // Stellar: a reduce-only order may not flip the position.
                require!(!reduce_only, FloyDexError::InvalidAmount);
                open(
                    u,
                    market_id,
                    is_long,
                    residual,
                    price,
                    index_for(is_long),
                    &mut out,
                )?;
            }
        }
        Some(i) => {
            require!(!reduce_only, FloyDexError::PositionNotFound);
            let slot = u.positions[i];
            let funding = funding_pnl(&slot, index_for(is_long))?;
            let old_size = slot.size.get();
            let old_entry = slot.entry_price.get();
            let new_size = checked_add(old_size, size).core()?;
            // entry' = entry + (price − entry) · size / new_size, one rounding,
            // against the holder (a higher entry hurts a long).
            let diff = checked_sub(price, old_entry).core()?;
            let step = if is_long {
                mul_div_ceil(diff, size, new_size)
            } else {
                mul_div_floor(diff, size, new_size)
            }
            .core()?;
            let new_entry = checked_add(old_entry, step).core()?;
            let p = &mut u.positions[i];
            p.size.set(new_size);
            p.entry_price.set(new_entry);
            p.last_funding_index.set(index_for(is_long));
            out.pnl = funding;
            out.increased = true;
            out.oi.add(is_long, size)?;
            out.position_id = slot.position_id;
            out.size_after = new_size;
            out.entry_after = new_entry;
        }
        None => {
            require!(!reduce_only, FloyDexError::PositionNotFound);
            open(
                u,
                market_id,
                is_long,
                size,
                price,
                index_for(is_long),
                &mut out,
            )?;
        }
    }
    Ok(out)
}

fn open(
    u: &mut UserAccount,
    market_id: u16,
    is_long: bool,
    size: i128,
    price: i128,
    funding_index: i128,
    out: &mut SideOutcome,
) -> Result<()> {
    let i = u
        .positions
        .iter()
        .position(|p| p.in_use == 0)
        .ok_or(FloyDexError::TooManyPositions)?;
    let id = u.next_position_id;
    u.next_position_id = id.checked_add(1).ok_or(FloyDexError::MathOverflow)?;
    u.positions[i] = PositionSlot {
        position_id: id,
        size: size.into(),
        entry_price: price.into(),
        last_funding_index: funding_index.into(),
        market_id,
        is_long: u8::from(is_long),
        in_use: 1,
        _pad: [0; 4],
    };
    u.open_positions = u.open_positions.saturating_add(1);
    out.increased = true;
    out.oi.add(is_long, size)?;
    out.position_id = id;
    out.size_after = size;
    out.entry_after = price;
    out.is_long_after = is_long;
    Ok(())
}

/// Round a PRECISION size up to whole order units (1e-9 of a share, the
/// wire scale), capped at `max`. Positions only ever change by whole units,
/// so every position stays closable by a signed order; a liquidation or ADL
/// slice computed at 1e18 would otherwise leave dust no order can express.
pub fn to_whole_units(size: i128, max: i128) -> i128 {
    let unit = crate::constants::WIRE_TO_PRECISION;
    let whole = size.checked_add(unit - 1).map_or(max, |v| v / unit * unit);
    whole.min(max)
}

/// Trading fee on `size` at `price`, rounded up.
pub fn trade_fee(size: i128, price: i128, fee_bps: u32) -> Result<i128> {
    if fee_bps == 0 {
        return Ok(0);
    }
    let notional = mul_div_ceil(size, price, PRECISION).core()?;
    mul_div_ceil(notional, i128::from(fee_bps), BPS_DENOMINATOR).core()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn user() -> UserAccount {
        let mut u: UserAccount = bytemuck::Zeroable::zeroed();
        u.next_position_id = 1;
        u
    }

    const P: i128 = PRECISION;

    #[test]
    fn opens_then_increases_with_a_vwap_entry() {
        let mut u = user();
        let a = apply_side(&mut u, 1, true, false, 2 * P, 100 * P, 0, 0).unwrap();
        assert!(a.increased);
        assert_eq!((a.size_after, a.entry_after), (2 * P, 100 * P));
        let b = apply_side(&mut u, 1, true, false, 2 * P, 110 * P, 0, 0).unwrap();
        assert_eq!((b.size_after, b.entry_after), (4 * P, 105 * P));
        assert_eq!(
            b.oi,
            OiDelta {
                long: 2 * P,
                short: 0
            }
        );
        assert_eq!(u.open_positions, 1);
    }

    #[test]
    fn vwap_rounds_against_the_holder() {
        // 1 @ 100 + 2 @ 101 → 100.666…: a long's entry rounds up, a short's down.
        let mut l = user();
        apply_side(&mut l, 1, true, false, P, 100 * P, 0, 0).unwrap();
        let long = apply_side(&mut l, 1, true, false, 2 * P, 101 * P, 0, 0).unwrap();
        let mut s = user();
        apply_side(&mut s, 1, false, false, P, 100 * P, 0, 0).unwrap();
        let short = apply_side(&mut s, 1, false, false, 2 * P, 101 * P, 0, 0).unwrap();
        assert_eq!(long.entry_after - short.entry_after, 1);
        assert_eq!(short.entry_after, 100 * P + 666_666_666_666_666_666);
    }

    #[test]
    fn reduces_then_opens_the_residual() {
        let mut u = user();
        apply_side(&mut u, 1, true, false, 3 * P, 100 * P, 0, 0).unwrap();
        // Sell 5 at 110: close 3 long (+30), open 2 short at 110.
        let o = apply_side(&mut u, 1, false, false, 5 * P, 110 * P, 0, 0).unwrap();
        assert_eq!(o.pnl, 30 * P);
        assert!(o.increased);
        assert_eq!(
            o.oi,
            OiDelta {
                long: -3 * P,
                short: 2 * P
            }
        );
        let slot = u.positions[u.find_position(1).unwrap()];
        assert_eq!(
            (slot.is_long, slot.size.get(), slot.entry_price.get()),
            (0, 2 * P, 110 * P)
        );
        assert_eq!(u.open_positions, 1);
        assert_eq!(
            slot.position_id, 2,
            "the flipped position is a new position"
        );
    }

    #[test]
    fn a_full_close_frees_the_slot() {
        let mut u = user();
        apply_side(&mut u, 1, false, false, 3 * P, 100 * P, 0, 0).unwrap();
        let o = apply_side(&mut u, 1, true, true, 3 * P, 90 * P, 0, 0).unwrap();
        assert_eq!(o.pnl, 30 * P, "short from 100 closed at 90");
        assert!(!o.increased);
        assert_eq!(u.find_position(1), None);
        assert_eq!(u.open_positions, 0);
    }

    #[test]
    fn reduce_only_never_opens_or_flips() {
        let mut u = user();
        assert_eq!(
            apply_side(&mut u, 1, true, true, P, 100 * P, 0, 0).unwrap_err(),
            error!(FloyDexError::PositionNotFound)
        );
        apply_side(&mut u, 1, true, false, P, 100 * P, 0, 0).unwrap();
        assert_eq!(
            apply_side(&mut u, 1, true, true, P, 100 * P, 0, 0).unwrap_err(),
            error!(FloyDexError::PositionNotFound)
        );
        assert_eq!(
            apply_side(&mut u, 1, false, true, 2 * P, 100 * P, 0, 0).unwrap_err(),
            error!(FloyDexError::InvalidAmount)
        );
    }

    #[test]
    fn realized_losses_round_toward_minus_infinity() {
        let mut u = user();
        apply_side(&mut u, 1, true, false, 3, 100 * P, 0, 0).unwrap(); // 3 wei of size
                                                                       // Close at 99.5: exact pnl = 3 · (−0.5) / 1 = −1.5 wei → −2.
        let o = apply_side(&mut u, 1, false, false, 3, 99 * P + P / 2, 0, 0).unwrap();
        assert_eq!(o.pnl, -2);
    }

    #[test]
    fn funding_settles_on_every_touch() {
        let mut u = user();
        apply_side(&mut u, 1, true, false, 2 * P, 100 * P, 0, 0).unwrap();
        // Long index rose by 0.5 per unit: the long pays 1.0.
        let o = apply_side(&mut u, 1, true, false, P, 100 * P, P / 2, -P / 2).unwrap();
        assert_eq!(o.pnl, -P);
        assert_eq!(u.positions[0].last_funding_index.get(), P / 2);
    }

    #[test]
    fn slices_round_up_to_whole_order_units() {
        let u = 1_000_000_000;
        assert_eq!(to_whole_units(1, 10 * P), u);
        assert_eq!(to_whole_units(u, 10 * P), u);
        assert_eq!(to_whole_units(u + 1, 10 * P), 2 * u);
        assert_eq!(to_whole_units(10 * P - 1, 10 * P), 10 * P, "capped");
        assert_eq!(to_whole_units(i128::MAX, 10 * P), 10 * P);
    }

    #[test]
    fn fees_round_up() {
        assert_eq!(trade_fee(P, 100 * P, 5).unwrap(), P / 20);
        assert_eq!(
            trade_fee(P, 100 * P, 100).unwrap(),
            P,
            "1% of 100 notional is 1"
        );
        assert_eq!(
            trade_fee(1, 1, 1).unwrap(),
            1,
            "any non-zero fee is at least 1 wei"
        );
        assert_eq!(trade_fee(P, 100 * P, 0).unwrap(), 0);
    }

    #[test]
    fn a_seventeenth_market_is_refused() {
        let mut u = user();
        for m in 1..=16 {
            apply_side(&mut u, m, true, false, P, P, 0, 0).unwrap();
        }
        assert_eq!(
            apply_side(&mut u, 17, true, false, P, P, 0, 0).unwrap_err(),
            error!(FloyDexError::TooManyPositions)
        );
    }
}
