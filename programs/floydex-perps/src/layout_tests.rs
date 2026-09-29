//! Account layouts are part of the client ABI: pin their sizes, and check
//! that the boundary conversions into `protocol-core` types are lossless.

use crate::state::*;
use anchor_lang::prelude::Pubkey;
use core::mem::size_of;
use protocol_core::{MarginMode, PRECISION};

#[test]
fn zero_copy_sizes_are_pinned() {
    assert_eq!(size_of::<PodI128>(), 16);
    assert_eq!(size_of::<BalanceSlot>(), 24);
    assert_eq!(size_of::<PositionSlot>(), 64);
    assert_eq!(size_of::<SessionWindowPod>(), 24);
    assert_eq!(size_of::<UserAccount>(), 1_376);
    assert_eq!(size_of::<Market>(), 824);
    assert_eq!(size_of::<BookOrder>(), 72);
    assert_eq!(size_of::<MarketBook>(), 2_320);
    // 05 §1 targets: UserAccount ~2.2 KB, Market ~1.5 KB.
    const _: () = assert!(8 + size_of::<UserAccount>() <= 2_300);
    const _: () = assert!(8 + size_of::<Market>() <= 1_536);
}

#[test]
fn borsh_account_sizes_fit_the_targets() {
    use anchor_lang::Space;
    const _: () = assert!(8 + Exchange::INIT_SPACE < 1_024);
    const _: () = assert!(8 + Collateral::INIT_SPACE < 300);
    const _: () = assert!(8 + OrderRecord::INIT_SPACE <= 80);
}

#[test]
fn pod_i128_round_trips_extremes() {
    for v in [0, 1, -1, i128::MAX, i128::MIN, 123 * PRECISION] {
        let mut p = PodI128::ZERO;
        p.set(v);
        assert_eq!(p.get(), v);
        assert_eq!(PodI128::from(v).get(), v);
    }
}

#[test]
fn position_slot_converts_to_a_cross_position() {
    let owner = Pubkey::new_unique();
    let slot = PositionSlot {
        position_id: 7,
        size: (3 * PRECISION).into(),
        entry_price: (250 * PRECISION).into(),
        last_funding_index: (-5).into(),
        market_id: 2,
        is_long: 1,
        in_use: 1,
        _pad: [0; 4],
    };
    let p = slot.to_position(&owner);
    assert_eq!(p.position_id, 7);
    assert_eq!(p.owner, owner.to_bytes());
    assert_eq!(p.market_id, 2);
    assert_eq!(p.size, 3 * PRECISION);
    assert_eq!(p.entry_price, 250 * PRECISION);
    assert_eq!(p.last_funding_index, -5);
    assert!(p.is_long);
    assert_eq!(p.mode, MarginMode::Cross);
    assert_eq!(p.margin, 0);
}

fn empty_user() -> UserAccount {
    bytemuck::Zeroable::zeroed()
}

#[test]
fn balances_take_a_slot_and_release_it_at_zero() {
    let mut u = empty_user();
    assert_eq!(u.apply_balance(3, 10).unwrap(), 10);
    assert_eq!(u.balance(3), 10);
    assert_eq!(u.balances.iter().filter(|b| b.in_use != 0).count(), 1);
    assert_eq!(u.apply_balance(3, -10).unwrap(), 0);
    assert_eq!(u.balances.iter().filter(|b| b.in_use != 0).count(), 0);
    // Negative balances are allowed (realized loss without settlement collateral).
    assert_eq!(u.apply_balance(0, -4).unwrap(), -4);
}

#[test]
fn a_ninth_collateral_is_rejected() {
    let mut u = empty_user();
    for i in 0..8 {
        u.apply_balance(i, 1).unwrap();
    }
    assert!(u.apply_balance(8, 1).is_err());
    // A zero delta on a missing slot never takes a slot.
    assert_eq!(u.apply_balance(9, 0).unwrap(), 0);
}

#[test]
fn delegate_signs_only_until_expiry_and_never_when_unset() {
    let mut u = empty_user();
    u.owner = Pubkey::new_unique();
    let d = Pubkey::new_unique();
    assert!(u.can_sign_orders(&u.owner.clone(), 0));
    assert!(!u.can_sign_orders(&d, 0));
    u.delegate = d;
    u.delegate_expiry = 100;
    assert!(u.can_sign_orders(&d, 99));
    assert!(!u.can_sign_orders(&d, 100));
    // The default key never counts as a delegate.
    let mut v = empty_user();
    v.owner = Pubkey::new_unique();
    v.delegate_expiry = i64::MAX;
    assert!(!v.can_sign_orders(&Pubkey::default(), 0));
}

#[test]
fn order_record_reclaims_after_the_later_of_expiry_and_tombstone() {
    let r = OrderRecord {
        filled: 0,
        cancelled_until: 500,
        expiry_ts: 300,
        payer: Pubkey::default(),
        bump: 0,
    };
    assert!(r.is_cancelled());
    assert_eq!(r.reclaimable_at(), 500);
}
