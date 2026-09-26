//! (f) Position effects, fees, OI, margin, sessions, order records,
//! reclaim, multi-fill, and conservation.

mod common;
use common::*;
use kryon_integration::*;
use kryon_perps::error::KryonError;
use solana_signer::Signer;

#[test]
fn reduce_increase_and_flip_through_fills() {
    let mut b = Book::new();
    assert_ok(b.trade(true, 2 * W, PX)); // alice long 2 @ 250
    assert_ok(b.trade(true, 2 * W, 251 * W)); // +2 @ 251 → 4 @ 250.5
    let a = b.position(&b.alice).unwrap();
    assert_eq!(
        (a.size.get(), a.entry_price.get()),
        (4 * P, 250 * P + P / 2)
    );
    let before = b.w.user(&b.alice).balance(0);
    // Alice sells 6 @ 252: closes 4 (+6.0), opens 2 short @ 252.
    assert_ok(b.trade(false, 6 * W, 252 * W));
    let a = b.position(&b.alice).unwrap();
    assert_eq!(
        (a.is_long, a.size.get(), a.entry_price.get()),
        (0, 2 * P, 252 * P)
    );
    let fee = 6 * 252 * P * 2 / 10_000; // maker 2 bps on 1,512
    assert_eq!(b.w.user(&b.alice).balance(0) - before, 6 * P - fee);
    // Bob mirrors: long 2 @ 252.
    let c = b.position(&b.bob).unwrap();
    assert_eq!((c.is_long, c.size.get()), (1, 2 * P));
    let m = b.w.market(1);
    assert_eq!((m.oi_long.get(), m.oi_short.get()), (2 * P, 2 * P));
}

#[test]
fn reduce_only_orders_cannot_open_or_flip() {
    let mut b = Book::new();
    let (mut mo, to) = b.pair(true, W, PX);
    mo.flags |= protocol_core::FLAG_REDUCE_ONLY;
    assert_err(b.fill(mo, to, W, PX), KryonError::PositionNotFound);
    assert_ok(b.trade(true, W, PX));
    let (mut mo, to) = b.pair(false, 2 * W, PX);
    mo.flags |= protocol_core::FLAG_REDUCE_ONLY;
    assert_err(b.fill(mo, to, 2 * W, PX), KryonError::InvalidAmount);
    assert_ok(b.fill(mo, to, W, PX)); // exactly closes
    assert!(b.position(&b.alice).is_none());
}

#[test]
fn a_fill_that_breaks_initial_margin_is_refused() {
    let mut b = Book::new();
    // 10,000 USDC at 20% IM supports 50,000 of notional = 200 shares at $250,
    // minus fees. 199 fits, 200 does not (the fee tips it over).
    assert_err(
        b.trade(true, 200 * W, PX),
        KryonError::InsufficientCollateral,
    );
    assert_ok(b.trade(true, 199 * W, PX));
}

/// Alice long / Bob short 100 @ $250 on 10k each, then the market closes:
/// margin doubles to 40%, so both need 10,000 and are just below it.
fn below_initial_margin_after_the_close() -> Book {
    let mut b = Book::new();
    assert_ok(b.trade(true, 100 * W, PX));
    patch_zc::<kryon_perps::state::Market>(&mut b.w.svm, &market_pda(1), |m| {
        m.calendar = Default::default()
    });
    b
}

#[test]
fn below_initial_margin_a_reduce_that_improves_health_goes_through() {
    let mut b = below_initial_margin_after_the_close();
    // Adding is refused…
    assert_err(b.trade(true, W, PX), KryonError::InsufficientCollateral);
    // …a small reduce is fine even though the account stays below initial margin.
    assert_ok(b.trade(false, W, PX));
    assert_eq!(b.position(&b.alice).unwrap().size.get(), 99 * P);
}

#[test]
fn below_initial_margin_a_reduce_that_worsens_health_is_refused() {
    let mut b = below_initial_margin_after_the_close();
    // Widen the band so a terrible price is otherwise acceptable.
    patch_zc::<kryon_perps::state::Market>(&mut b.w.svm, &market_pda(1), |m| {
        m.max_execution_deviation_bps = 5_000
    });
    // Alice sells 1 at $140 while the mark is $250: she realizes −110 and
    // frees only 100 of margin (40% of 250), so her health falls.
    assert_err(
        b.trade(false, W, 140 * W),
        KryonError::InsufficientCollateral,
    );
    // At $200 she loses 50 and frees 100: health improves, allowed.
    assert_ok(b.trade(false, W, 200 * W));
}

#[test]
fn below_initial_margin_a_flip_gets_no_relief() {
    let mut b = below_initial_margin_after_the_close();
    // Selling 201 closes the long and opens 101 short, which needs 10,100 of
    // margin: new exposure gets no reduce-only relief.
    assert_err(
        b.trade(false, 201 * W, PX),
        KryonError::InsufficientCollateral,
    );
}

#[test]
fn halted_markets_are_reduce_only() {
    let mut b = Book::new();
    assert_ok(b.trade(true, 2 * W, PX));
    // Oracle goes stale inside the Regular window → Halted.
    let now = b.w.now();
    mock_usd(&mut b.w.svm, FEED_TSLA, 250.0, now - 600);
    assert_err(b.trade(true, W, PX), KryonError::SessionExposureBlocked);
    // Reducing is allowed (at the last valid price, margin ×2).
    assert_ok(b.trade(false, W, PX));
    assert_eq!(b.position(&b.alice).unwrap().size.get(), P);
}

#[test]
fn closed_markets_cap_open_interest_and_double_margin() {
    let mut b = Book::new();
    assert_ok(b.trade(true, W, PX)); // records the last oracle price
                                     // Remove the calendar: outside every window is Closed.
    patch_zc::<kryon_perps::state::Market>(&mut b.w.svm, &market_pda(1), |m| {
        m.calendar = Default::default();
        m.max_open_interest.set(10 * P);
    });
    // Closed OI cap = 50% of 10 = 5 total (long + short); 2 open now.
    assert_err(b.trade(true, 2 * W, PX), KryonError::OpenInterestExceeded);
    assert_ok(b.trade(true, W, PX)); // total 4
    let m = b.w.market(1);
    assert_ne!(m.closed_since, 0, "the close time is recorded");
    // Closed margin is 40%: 10,000 supports 25,000 notional ≈ 100 shares.
    patch_zc::<kryon_perps::state::Market>(&mut b.w.svm, &market_pda(1), |m| {
        m.max_open_interest.set(1_000_000 * P)
    });
    assert_err(
        b.trade(true, 100 * W, PX),
        KryonError::InsufficientCollateral,
    );
}

#[test]
fn regular_markets_cap_open_interest() {
    let mut b = Book::new();
    patch_zc::<kryon_perps::state::Market>(&mut b.w.svm, &market_pda(1), |m| {
        m.max_open_interest.set(4 * P)
    });
    assert_ok(b.trade(true, 2 * W, PX)); // long 2 + short 2 = 4
    assert_err(b.trade(true, W, PX), KryonError::OpenInterestExceeded);
    assert_ok(b.trade(false, W, PX)); // reducing is always fine
}

#[test]
fn only_operators_settle_and_pause_stops_them() {
    let mut b = Book::new();
    let (mo, to) = b.pair(true, W, PX);
    let entries = [
        SigEntry::sign(&b.alice_key, &order_message(DOMAIN, &b.alice, &mo)),
        SigEntry::sign(&b.bob_key, &order_message(DOMAIN, &b.bob, &to)),
    ];
    let stranger = funded(&mut b.w.svm);
    let mut settle = b.w.settle_ix(1, &[plan(&b.alice, &b.bob, mo, to, W, PX)]);
    settle.accounts[1].pubkey = stranger.pubkey();
    let r = send(
        &mut b.w.svm,
        &[compute_budget(1_400_000), ed25519_ix(&entries), settle],
        &stranger,
        &[],
    );
    assert_err(r, KryonError::NotOperator);

    let g = b.w.guardian.insecure_clone();
    let i = ix(
        ka::Pause {
            exchange: exchange_pda(),
            guardian: g.pubkey(),
        },
        ki::Pause {},
    );
    assert_ok(send(&mut b.w.svm, &[i], &g, &[]));
    assert_err(b.fill(mo, to, W, PX), KryonError::Paused);
}

#[test]
fn two_fills_in_one_instruction() {
    let mut b = Book::new();
    let (m1, t1) = b.pair(true, W, PX);
    let (m2, t2) = b.pair(true, W, 251 * W);
    let plans = [
        plan(&b.alice, &b.bob, m1, t1, W, PX),
        plan(&b.alice, &b.bob, m2, t2, W, 251 * W),
    ];
    let (ak, bk) = (b.alice_key.insecure_clone(), b.bob_key.insecure_clone());
    let meta = assert_ok(b.w.settle(1, &plans, &[(&ak, &bk), (&ak, &bk)]));
    println!("settle_fills, 2 fills: {} CU", meta.compute_units_consumed);
    assert_eq!(b.position(&b.alice).unwrap().size.get(), 2 * P);
}

#[test]
fn positions_in_other_markets_need_their_accounts() {
    let mut b = Book::new();
    // Alice also holds a market-2 position (priced by another feed).
    let feed2 = [0x22; 32];
    let mut p2 = default_market_params();
    p2.pyth_feed_id = feed2;
    let i = b.w.create_market_ix(2, p2);
    assert_ok(b.w.admin_send(&[i]));
    let now = b.w.now();
    patch_zc::<kryon_perps::state::Market>(&mut b.w.svm, &market_pda(2), |m| {
        m.calendar[0] = kryon_perps::state::SessionWindowPod {
            start: (now - 60) as u64,
            end: (now + 86_400) as u64,
            session: 0,
            _pad: [0; 7],
        };
    });
    let price2 = mock_usd(&mut b.w.svm, feed2, 100.0, now);
    inject_position(&mut b.w.svm, &b.alice.user, 2, true, 10 * P, 100 * P);

    let (mo, to) = b.pair(true, W, PX);
    assert_err(b.fill(mo, to, W, PX), KryonError::InvalidRemainingAccounts);
    let mut p = plan(&b.alice, &b.bob, mo, to, W, PX);
    p.maker_risk = vec![meta(market_pda(2), false), meta(price2, false)];
    let (ak, bk) = (b.alice_key.insecure_clone(), b.bob_key.insecure_clone());
    let m = assert_ok(b.w.settle(1, &[p], &[(&ak, &bk)]));
    println!(
        "settle_fills, maker with a second market: {} CU",
        m.compute_units_consumed
    );
}

#[test]
fn order_records_are_reclaimed_only_after_expiry() {
    let mut b = Book::new();
    let (mo, to) = b.pair(true, W, PX);
    assert_ok(b.fill(mo, to, W, PX));
    let rec = order_pda(&b.alice.key(), 0, mo.nonce);
    let op = b.w.operator.pubkey();
    let reclaim = |b: &mut Book| {
        let i = ix(
            ka::ReclaimOrderState {
                order_record: rec,
                payer: op,
            },
            ki::ReclaimOrderState {
                owner: b.alice.key(),
                sub_id: 0,
                nonce: mo.nonce,
            },
        );
        let anyone = funded(&mut b.w.svm);
        send(&mut b.w.svm, &[i], &anyone, &[])
    };
    assert_err(reclaim(&mut b), KryonError::NotReclaimable);
    let before = b.w.svm.get_balance(&op).unwrap();
    b.w.warp_to(mo.expiry_ts as i64 + 1);
    assert_ok(reclaim(&mut b));
    assert!(
        b.w.svm.get_account(&rec).map_or(true, |a| a.lamports == 0),
        "record closed"
    );
    assert!(
        b.w.svm.get_balance(&op).unwrap() > before,
        "rent refunded to the operator"
    );
}

#[test]
fn a_tombstone_outlives_the_order_it_cancels() {
    // Stellar fix: a cancel with an early expiry is clamped to now + 7d, so
    // the tombstone cannot be reclaimed while the order could still fill.
    let mut b = Book::new();
    let (mo, _) = b.pair(true, W, PX);
    let k = b.alice.kp.insecure_clone();
    let rec = order_pda(&k.pubkey(), 0, mo.nonce);
    let i = ix(
        ka::CancelOrder {
            owner: k.pubkey(),
            user_account: b.alice.user,
            order_record: rec,
            system_program: anchor_lang::system_program::ID,
            event_authority: event_authority(),
            program: kryon_perps::ID,
        },
        ki::CancelOrder {
            sub_id: 0,
            nonce: mo.nonce,
            expiry_ts: 1,
        },
    );
    assert_ok(send(&mut b.w.svm, &[i], &k, &[]));
    let r: kryon_perps::state::OrderRecord = fetch(&b.w.svm, &rec);
    assert!(
        r.cancelled_until >= mo.expiry_ts,
        "tombstone reaches past the order's expiry"
    );
    assert_eq!(r.payer, k.pubkey());
}

/// Tiny deterministic PRNG so the test is reproducible without extra deps.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn range(&mut self, lo: u64, hi: u64) -> u64 {
        lo + self.next() % (hi - lo + 1)
    }
}

#[test]
fn conservation_holds_across_random_fills() {
    let mut b = Book::new();
    let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
    let mut settled = 0;
    for _ in 0..120 {
        let alice_long = rng.next() % 2 == 0;
        let size = rng.range(1, 40) * W / 10 + rng.range(0, 999); // odd sizes
        let price = rng.range(248 * 100, 252 * 100) * W / 100 + rng.range(0, 999);
        if b.trade(alice_long, size, price).is_ok() {
            settled += 1;
        }
        let users = [&b.alice, &b.bob];
        for mark in [240 * P, 250 * P, 260 * P + 7] {
            assert_solvent(&b.w, &b.usdc, &users, 1, mark);
        }
    }
    assert!(settled > 100, "most random fills should settle ({settled})");
    // Flatten both sides, then the strict check.
    if let Some(p) = b.position(&b.alice) {
        let size = (p.size.get() / 1_000_000_000) as u64;
        assert_ok(b.trade(p.is_long == 0, size, PX));
    }
    assert_conserved_flat(&b.w, &b.usdc, &[&b.alice, &b.bob]);
}
