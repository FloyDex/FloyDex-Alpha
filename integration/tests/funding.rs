//! Phase 2 (c): `update_funding`, premium-based, elapsed-capped (`05` §2,
//! `07` §4, `11` L8).

mod common;
use common::*;
use kryon_integration::*;
use kryon_perps::error::KryonError;

/// Default market: coefficient 1.0, max 0.1%/h. A 1% premium clamps to
/// the max, 1e15 per unit per hour.
const MAX_RATE: i128 = P / 1_000;

#[test]
fn funding_is_non_zero_when_the_perp_trades_rich() {
    // L8: on Stellar the OI-imbalance formula was structurally zero.
    let mut b = Book::new();
    assert_ok(b.trade(true, 10 * W, 2525 * W / 10)); // 1% over the 250 oracle
    b.w.tick(600, 250.0);
    assert_ok(b.w.update_funding(1));
    let m = b.w.market(1);
    assert_eq!(m.funding_rate_per_hour.get(), MAX_RATE);
    let delta = MAX_RATE * 600 / 3_600;
    assert_eq!(m.funding_long_index.get(), delta, "longs pay");
    assert_eq!(m.funding_short_index.get(), -delta, "shorts receive");
    assert_eq!(m.funding_last_update, b.w.now() as u64);
}

#[test]
fn a_cheap_perp_pays_longs_and_funding_settles_on_the_next_touch() {
    let mut b = Book::new();
    assert_ok(b.trade(true, 10 * W, 248 * W)); // alice long 10, 0.8% cheap
    b.w.tick(900, 250.0);
    assert_ok(b.w.update_funding(1));
    let m = b.w.market(1);
    let prem = (248 * P - 250 * P) * P / (250 * P);
    let rate = prem.max(-MAX_RATE);
    assert_eq!(m.funding_rate_per_hour.get(), rate);
    let delta = rate * 900 / 3_600;
    assert!(delta < 0);
    assert_eq!(m.funding_long_index.get(), delta);
    // Alice (long) receives, Bob (short) pays, when their positions are next
    // touched: a zero-PnL close at the entry price leaves only funding.
    let (a0, b0) = (b.w.user(&b.alice).balance(0), b.w.user(&b.bob).balance(0));
    assert_ok(b.trade(false, 10 * W, 248 * W));
    let fee_a = 10 * 248 * P * 2 / 10_000;
    let fee_b = 10 * 248 * P * 5 / 10_000;
    let funding = -10 * delta; // size · −Δindex, exact here
    assert_eq!(b.w.user(&b.alice).balance(0) - a0, funding - fee_a);
    assert_eq!(b.w.user(&b.bob).balance(0) - b0, -funding - fee_b);
    assert_conserved_flat(&b.w, &b.usdc, &[&b.alice, &b.bob]);
}

#[test]
fn no_premium_without_a_recent_book() {
    let mut b = Book::new();
    assert_ok(b.trade(true, 10 * W, 2525 * W / 10));
    b.w.tick(901, 250.0); // the EMA is now older than 15 minutes
    assert_ok(b.w.update_funding(1));
    let m = b.w.market(1);
    assert_eq!(m.funding_rate_per_hour.get(), 0);
    assert_eq!(m.funding_long_index.get(), 0);
    assert_eq!(
        m.funding_last_update,
        b.w.now() as u64,
        "the clock still advances"
    );
}

#[test]
fn a_late_keeper_charges_at_most_one_hour() {
    let mut b = Book::new();
    assert_ok(b.trade(true, 10 * W, 2525 * W / 10));
    // A day passes; the matcher kept the EMA alive with posted mids.
    for _ in 0..(24 * 6) {
        b.w.tick(600, 250.0);
        assert_ok(b.w.post_mark(1, 2525 * W / 10));
    }
    assert_ok(b.w.update_funding(1));
    assert_eq!(b.w.market(1).funding_long_index.get(), MAX_RATE);
}

#[test]
fn closed_funding_uses_the_weekend_book_against_the_last_close() {
    let mut b = Book::new();
    assert_ok(b.trade(true, 10 * W, PX)); // close at 250, EMA 250
    b.w.close_market(1);
    // Friday night, the book trades 1.2% rich; the matcher posts mids.
    for _ in 0..30 {
        b.w.warp(60);
        assert_ok(b.w.post_mark(1, 253 * W));
    }
    assert_ok(b.w.update_funding(1));
    let m = b.w.market(1);
    let ema = m.mark_ema.get();
    let prem = (ema - 250 * P) * P / (250 * P);
    assert!(prem > 0);
    assert_eq!(m.funding_rate_per_hour.get(), prem.min(MAX_RATE));
    assert!(m.funding_long_index.get() > 0, "weekend longs pay");
}

#[test]
fn halted_markets_accrue_no_premium() {
    let mut b = Book::new();
    assert_ok(b.trade(true, 10 * W, 2525 * W / 10));
    b.w.warp(60);
    let now = b.w.now();
    mock_usd(&mut b.w.svm, FEED_TSLA, 250.0, now - 600);
    assert_ok(b.w.update_funding(1));
    assert_eq!(b.w.market(1).funding_long_index.get(), 0);
}

#[test]
fn funding_is_permissionless_but_stops_while_paused() {
    let mut b = Book::new();
    assert_ok(b.trade(true, W, PX));
    b.w.tick(60, 250.0);
    let anyone = funded(&mut b.w.svm);
    assert_ok(b.w.update_funding_as(1, &anyone));
    let g = b.w.guardian.insecure_clone();
    let i = ix(
        ka::Pause {
            exchange: exchange_pda(),
            guardian: solana_signer::Signer::pubkey(&g),
        },
        ki::Pause {},
    );
    assert_ok(send(&mut b.w.svm, &[i], &g, &[]));
    b.w.tick(60, 250.0);
    assert_err(b.w.update_funding(1), KryonError::Paused);
}

#[test]
fn solvency_holds_with_funding_open_and_after_closing() {
    let mut b = Book::new();
    assert_ok(b.trade(true, 37 * W, 2521 * W / 10));
    for k in 0..12 {
        b.w.tick(300, 250.0 + k as f64 * 0.3);
        assert_ok(b.w.post_mark(1, 2523 * W / 10));
        assert_ok(b.w.update_funding(1));
        let px = (250 * P) + k * 3 * P / 10;
        assert_solvent(&b.w, &b.usdc, &[&b.alice, &b.bob], 1, px);
    }
    let pos = b.position(&b.alice).unwrap().size.get();
    let mark = 2533 * W / 10;
    assert_ok(b.trade(false, (pos / 1_000_000_000) as u64, mark));
    assert_conserved_flat(&b.w, &b.usdc, &[&b.alice, &b.bob]);
}
