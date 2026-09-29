//! Phase 2 (b): the book mark EMA, `post_mark`, the reopen, and the margin
//! ramp before a scheduled close (`07` §2, §4, §5).

mod common;
use common::*;
use floydex_integration::*;
use floydex_perps::error::FloyDexError;
use solana_signer::Signer;

fn ema(b: &Book) -> i128 {
    b.w.market(1).mark_ema.get()
}

#[test]
fn fills_drive_a_time_weighted_ema() {
    let mut b = Book::new();
    assert_ok(b.trade(true, W, PX));
    assert_eq!(ema(&b), 250 * P, "the first fill seeds the EMA");
    // More fills in the same second do not move it.
    assert_ok(b.trade(true, W, 252 * W));
    assert_eq!(ema(&b), 250 * P);
    // One half-life later a fill at 251 pulls it halfway.
    b.w.warp(300);
    let now = b.w.now();
    mock_usd(&mut b.w.svm, FEED_TSLA, 250.0, now);
    assert_ok(b.trade(true, W, 251 * W));
    assert_eq!(ema(&b), 2505 * P / 10);
    assert_eq!(b.w.market(1).mark_ema_updated, now as u64);
}

#[test]
fn a_fill_moves_the_ema_by_at_most_the_step_bound() {
    let mut b = Book::new();
    assert_ok(b.trade(true, W, PX));
    b.w.warp(3_000); // ten half-lives: the next sample would carry ~all the weight
    let now = b.w.now();
    mock_usd(&mut b.w.svm, FEED_TSLA, 250.0, now);
    assert_ok(b.trade(true, W, 2524 * W / 10)); // +0.96%, inside the 1% band
    assert_eq!(ema(&b), 25125 * P / 100, "capped at +50 bps of 250");
}

#[test]
fn post_mark_is_operator_only_rate_limited_and_clamped_while_closed() {
    let mut b = Book::new();
    assert_ok(b.trade(true, W, PX)); // oracle 250 recorded, EMA 250
    b.w.close_market(1);
    // Not an operator.
    let stranger = funded(&mut b.w.svm);
    assert_err(
        b.w.post_mark_as(1, 251 * W, &stranger),
        FloyDexError::NotOperator,
    );
    b.w.warp(600);
    assert_ok(b.w.post_mark(1, 300 * W)); // far outside the 2% band
                                          // Clamped to 255 first, then the 50 bps step bound: 250 → 251.25.
    assert_eq!(ema(&b), 25125 * P / 100);
    assert_err(b.w.post_mark(1, 300 * W), FloyDexError::PostMarkTooSoon);
    b.w.warp(9);
    assert_err(b.w.post_mark(1, 300 * W), FloyDexError::PostMarkTooSoon);
    b.w.warp(1);
    assert_ok(b.w.post_mark(1, 300 * W));
    assert!(ema(&b) > 25125 * P / 100);
    // Walk it up: it converges on the band edge (2% + 0.25%/h), never past it.
    for _ in 0..200 {
        b.w.warp(60);
        assert_ok(b.w.post_mark(1, 300 * W));
    }
    let m = b.w.market(1);
    let secs = b.w.now() as u64 - m.closed_since;
    let band_bps = 200 + 25 * (secs / 3_600) as i128;
    assert!(ema(&b) <= 250 * P + 250 * P * band_bps / 10_000);
    assert!(
        ema(&b) > 255 * P,
        "the band widened past 2% as hours passed"
    );
}

#[test]
fn the_closed_mark_follows_the_ema_inside_the_band() {
    let mut b = Book::new();
    assert_ok(b.trade(true, 10 * W, PX));
    b.w.close_market(1);
    for _ in 0..60 {
        b.w.warp(60);
        assert_ok(b.w.post_mark(1, 254 * W));
    }
    let e = ema(&b);
    assert!(e > 2539 * P / 10 && e <= 254 * P, "ema {e}");
    // The execution band (1%) is now centred on the EMA mark, not on 250:
    // 256 is inside it, 251 is not.
    assert_ok(b.trade(true, W, 256 * W));
    assert_err(b.trade(true, W, 251 * W), FloyDexError::PriceOutsideBand);
}

#[test]
fn post_mark_is_refused_while_halted() {
    let mut b = Book::new();
    assert_ok(b.trade(true, W, PX));
    let now = b.w.now();
    mock_usd(&mut b.w.svm, FEED_TSLA, 250.0, now - 600); // stale in session
    b.w.warp(20);
    assert_err(b.w.post_mark(1, PX), FloyDexError::MarketHalted);
}

#[test]
fn in_session_post_mark_is_clamped_to_the_execution_band() {
    let mut b = Book::new();
    assert_ok(b.trade(true, W, PX));
    b.w.warp(3_000);
    let now = b.w.now();
    mock_usd(&mut b.w.svm, FEED_TSLA, 250.0, now);
    assert_ok(b.w.post_mark(1, 200 * W));
    assert_eq!(ema(&b), 24875 * P / 100, "clamped to 247.5, then the step");
}

#[test]
fn the_reopen_snaps_the_ema_to_the_oracle_and_clears_the_close() {
    let mut b = Book::new();
    assert_ok(b.trade(true, 10 * W, PX));
    b.w.close_market(1);
    for _ in 0..30 {
        b.w.warp(60);
        assert_ok(b.w.post_mark(1, 254 * W));
    }
    assert!(ema(&b) > 253 * P);
    assert_ne!(b.w.market(1).closed_since, 0);
    // Monday: a Regular window and a fresh oracle at 262.
    b.w.warp(60);
    let now = b.w.now();
    b.w.post_regular_window(1, now - 10, now + 20_000);
    mock_usd(&mut b.w.svm, FEED_TSLA, 262.0, now);
    b.w.warp(10);
    assert_ok(b.w.post_mark(1, 262 * W));
    let m = b.w.market(1);
    assert_eq!(m.closed_since, 0);
    assert_eq!(m.mark_ema.get(), 262 * P, "snapped, then 262 again");
    assert_eq!(m.last_oracle_price.get(), 262 * P);
    assert_eq!(m.last_session, floydex_perps::state::SESSION_REGULAR + 1);
}

#[test]
fn initial_margin_ramps_up_before_the_close() {
    // 10,000 USDC. Regular IM 20% supports ~199 shares at $250.
    let mut b = Book::new();
    let now = b.w.now();
    // The window closes in 30 minutes with nothing after it: halfway up the
    // ramp, IM is 20% × 1.5 = 30%, so 10,000 supports ~133 shares.
    b.w.post_regular_window(1, now - 3_600, now + 1_800);
    assert_err(
        b.trade(true, 134 * W, PX),
        FloyDexError::InsufficientCollateral,
    );
    assert_ok(b.trade(true, 132 * W, PX));
    // Ten minutes later (IM 33.4%) she cannot add, but can still reduce.
    b.w.warp(600);
    let now = b.w.now();
    mock_usd(&mut b.w.svm, FEED_TSLA, 250.0, now);
    assert_err(b.trade(true, W, PX), FloyDexError::InsufficientCollateral);
    assert_ok(b.trade(false, W, PX));
}

#[test]
fn fills_record_when_an_account_last_added_exposure() {
    let mut b = Book::new();
    assert_eq!(b.w.user(&b.alice).last_increase_ts, 0);
    assert_ok(b.trade(true, 2 * W, PX));
    let t = b.w.now() as u64;
    assert_eq!(b.w.user(&b.alice).last_increase_ts, t);
    assert_eq!(b.w.user(&b.bob).last_increase_ts, t);
    b.w.warp(5);
    let now = b.w.now();
    mock_usd(&mut b.w.svm, FEED_TSLA, 250.0, now);
    assert_ok(b.trade(false, W, PX)); // both reduce
    assert_eq!(b.w.user(&b.alice).last_increase_ts, t);
    let _ = b.alice.kp.pubkey();
}
