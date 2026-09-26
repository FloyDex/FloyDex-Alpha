//! (f) One test per `validate_fill` rule (05 §2), plus the happy path.

mod common;
use common::*;
use kryon_integration::*;
use kryon_perps::error::KryonError;
use solana_signer::Signer;

#[test]
fn a_fill_opens_both_sides_charges_fees_and_records_orders() {
    let mut b = Book::new();
    let (mo, to) = b.pair(true, 2 * W, PX);
    let meta = assert_ok(b.fill(mo, to, 2 * W, PX));
    println!(
        "settle_fills, 1 fill, fresh positions: {} CU",
        meta.compute_units_consumed
    );

    let a = b.position(&b.alice).unwrap();
    let c = b.position(&b.bob).unwrap();
    assert_eq!(
        (a.is_long, a.size.get(), a.entry_price.get()),
        (1, 2 * P, 250 * P)
    );
    assert_eq!(
        (c.is_long, c.size.get(), c.entry_price.get()),
        (0, 2 * P, 250 * P)
    );
    // Notional 500: maker 2 bps = 0.1, taker 5 bps = 0.25.
    assert_eq!(b.w.user(&b.alice).balance(0), 10_000 * P - P / 10);
    assert_eq!(b.w.user(&b.bob).balance(0), 10_000 * P - P / 4);
    assert_eq!(b.w.collateral(&b.usdc).fees_accrued, P / 10 + P / 4);
    let m = b.w.market(1);
    assert_eq!((m.oi_long.get(), m.oi_short.get()), (2 * P, 2 * P));
    assert_eq!(
        m.last_oracle_price.get(),
        250 * P,
        "a Regular fill records the oracle price"
    );

    let r: kryon_perps::state::OrderRecord =
        fetch(&b.w.svm, &order_pda(&b.alice.key(), 0, mo.nonce));
    assert_eq!(r.filled, 2 * P);
    assert_eq!(r.expiry_ts, mo.expiry_ts);
    assert_eq!(
        r.payer,
        b.w.operator.pubkey(),
        "the operator pays order rent"
    );
    assert!(!r.is_cancelled());
}

#[test]
fn owner_keys_sign_too() {
    let mut b = Book::new();
    let (mo, to) = b.pair(false, W, PX);
    let plan = plan(&b.alice, &b.bob, mo, to, W, PX);
    let (ak, bk) = (b.alice.kp.insecure_clone(), b.bob.kp.insecure_clone());
    assert_ok(b.w.settle(1, &[plan], &[(&ak, &bk)]));
}

// --- the validate_fill table, one rule each ---

#[test]
fn rule_fill_size_and_price_must_be_positive() {
    let mut b = Book::new();
    let (mo, to) = b.pair(true, W, PX);
    assert_err(b.fill(mo, to, 0, PX), KryonError::InvalidAmount);
    assert_err(b.fill(mo, to, W, 0), KryonError::InvalidAmount);
    // An order with zero size is invalid too (Stellar validate_order).
    let e = b.expiry();
    let zero = order_args(1, true, 0, PX, 99, e);
    assert_err(b.fill(zero, to, W, PX), KryonError::InvalidAmount);
}

#[test]
fn rule_self_trade_is_refused_across_sub_accounts() {
    let mut b = Book::new();
    // Alice's sub-account 1 trades against her sub-account 0: same wallet.
    let alice1 = {
        let k = b.alice.kp.insecure_clone();
        let user = user_pda(&k.pubkey(), 1);
        let i = ix(
            ka::InitUser {
                owner: k.pubkey(),
                user_account: user,
                system_program: anchor_lang::system_program::ID,
            },
            ki::InitUser { sub_id: 1 },
        );
        assert_ok(send(&mut b.w.svm, &[i], &k, &[]));
        Trader {
            kp: k,
            sub_id: 1,
            user,
        }
    };
    let (mo, to) = b.pair(true, W, PX);
    let plan = plan(&b.alice, &alice1, mo, to, W, PX);
    let (ak, ok) = (b.alice.kp.insecure_clone(), b.alice.kp.insecure_clone());
    assert_err(b.w.settle(1, &[plan], &[(&ak, &ok)]), KryonError::SelfTrade);
}

#[test]
fn rule_both_orders_must_be_for_this_nonzero_market() {
    let mut b = Book::new();
    let i = b.w.create_market_ix(2, default_market_params());
    assert_ok(b.w.admin_send(&[i]));
    let (mo, mut to) = b.pair(true, W, PX);
    to.market_id = 2;
    assert_err(b.fill(mo, to, W, PX), KryonError::InvalidConfig);
    // Both for market 2 but settled in market 1.
    let (mut mo, mut to) = b.pair(true, W, PX);
    mo.market_id = 2;
    to.market_id = 2;
    assert_err(b.fill(mo, to, W, PX), KryonError::InvalidConfig);
    // Market id 0 is never valid.
    let (mut mo, mut to) = b.pair(true, W, PX);
    mo.market_id = 0;
    to.market_id = 0;
    assert_err(b.fill(mo, to, W, PX), KryonError::InvalidConfig);
}

#[test]
fn rule_directions_must_differ() {
    let mut b = Book::new();
    let (mo, mut to) = b.pair(true, W, PX);
    to.flags = mo.flags; // both long
    assert_err(b.fill(mo, to, W, PX), KryonError::DirectionMismatch);
}

#[test]
fn rule_expiry_must_be_between_now_and_seven_days() {
    let mut b = Book::new();
    let now = b.w.now() as u64;
    let (mut mo, to) = b.pair(true, W, PX);
    mo.expiry_ts = now - 1;
    assert_err(b.fill(mo, to, W, PX), KryonError::OrderExpired);
    mo.expiry_ts = now + 7 * 86_400 + 1;
    assert_err(b.fill(mo, to, W, PX), KryonError::OrderExpired);
    // Exactly now and exactly now + 7d are both fine.
    mo.expiry_ts = now;
    let (_, to) = b.pair(true, W, PX);
    assert_ok(b.fill(mo, to, W, PX));
    let (mut mo, to) = b.pair(true, W, PX);
    mo.expiry_ts = now + 7 * 86_400;
    assert_ok(b.fill(mo, to, W, PX));
}

#[test]
fn rule_cancelled_orders_never_fill() {
    let mut b = Book::new();
    let (mo, to) = b.pair(true, W, PX);
    // Tombstone the maker order.
    let k = b.alice.kp.insecure_clone();
    let i = ix(
        ka::CancelOrder {
            owner: k.pubkey(),
            user_account: b.alice.user,
            order_record: order_pda(&k.pubkey(), 0, mo.nonce),
            system_program: anchor_lang::system_program::ID,
            event_authority: event_authority(),
            program: kryon_perps::ID,
        },
        ki::CancelOrder {
            sub_id: 0,
            nonce: mo.nonce,
            expiry_ts: mo.expiry_ts,
        },
    );
    assert_ok(send(&mut b.w.svm, &[i], &k, &[]));
    assert_err(b.fill(mo, to, W, PX), KryonError::OrderCancelled);

    // cancel_all: every nonce below the watermark is dead.
    let (mo, to) = b.pair(true, W, PX);
    let i = ix(
        ka::OwnerOnly {
            owner: k.pubkey(),
            user_account: b.alice.user,
            event_authority: event_authority(),
            program: kryon_perps::ID,
        },
        ki::CancelAll {
            below_nonce: mo.nonce + 1,
        },
    );
    assert_ok(send(&mut b.w.svm, &[i], &k, &[]));
    assert_err(b.fill(mo, to, W, PX), KryonError::OrderCancelled);
    // The watermark never moves back.
    let i = ix(
        ka::OwnerOnly {
            owner: k.pubkey(),
            user_account: b.alice.user,
            event_authority: event_authority(),
            program: kryon_perps::ID,
        },
        ki::CancelAll { below_nonce: 0 },
    );
    assert_ok(send(&mut b.w.svm, &[i], &k, &[]));
    assert_eq!(b.w.user(&b.alice).cancel_all_below_nonce, mo.nonce + 1);
    // A nonce at the watermark still fills.
    let e = b.expiry();
    let mo = order_args(1, true, W, PX, mo.nonce + 1, e);
    let to = order_args(1, false, W, PX, 1_000, e);
    assert_ok(b.fill(mo, to, W, PX));
}

#[test]
fn rule_an_order_cannot_be_overfilled() {
    let mut b = Book::new();
    let (mo, to) = b.pair(true, 3 * W, PX);
    assert_err(b.fill(mo, to, 3 * W + 1, PX), KryonError::OrderOverfilled);
    // Partial fills add up to exactly the size, then stop.
    assert_ok(b.fill(mo, to, 2 * W, PX));
    assert_ok(b.fill(mo, to, W, PX));
    let r: kryon_perps::state::OrderRecord =
        fetch(&b.w.svm, &order_pda(&b.alice.key(), 0, mo.nonce));
    assert_eq!(r.filled, 3 * P);
    // Replaying the same signed orders fails.
    assert_err(b.fill(mo, to, 1, PX), KryonError::OrderOverfilled);
}

#[test]
fn rule_fill_price_respects_both_limits() {
    let mut b = Book::new();
    // Long limit 250, fill at 250.01: pays more than signed.
    let (mo, to) = b.pair(true, W, PX);
    assert_err(
        b.fill(mo, to, W, PX + W / 100),
        KryonError::PriceOutsideBand,
    );
    // Short limit 250, fill at 249.99: receives less than signed.
    let (mo, to) = b.pair(false, W, PX);
    assert_err(
        b.fill(mo, to, W, PX - W / 100),
        KryonError::PriceOutsideBand,
    );
    // Inside both limits fills.
    let e = b.expiry();
    let mo = order_args(1, true, W, 251 * W, b.nonce(), e);
    let to = order_args(1, false, W, 249 * W, b.nonce(), e);
    assert_ok(b.fill(mo, to, W, PX));
}

#[test]
fn rule_fill_price_stays_within_the_band_around_the_mark() {
    let mut b = Book::new();
    // Band is 100 bps around the $250 mark: [247.5, 252.5].
    let e = b.expiry();
    let mo = order_args(1, true, 2 * W, 260 * W, b.nonce(), e);
    let to = order_args(1, false, 2 * W, 240 * W, b.nonce(), e);
    assert_err(
        b.fill(mo, to, W, 252 * W + W / 2 + 1),
        KryonError::PriceOutsideBand,
    );
    assert_err(
        b.fill(mo, to, W, 247 * W + W / 2 - 1),
        KryonError::PriceOutsideBand,
    );
    assert_ok(b.fill(mo, to, W, 252 * W + W / 2));
    assert_ok(b.fill(mo, to, W, 247 * W + W / 2));
}
