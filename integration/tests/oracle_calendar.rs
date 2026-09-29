//! (g) Pyth read → OracleSnapshot → guard: feed id from the Market, shard
//! configurable; and the session calendar the keeper posts.

mod common;
use anchor_lang::AccountSerialize;
use common::*;
use floydex_integration::*;
use floydex_perps::error::FloyDexError;
use floydex_perps::state::{SESSION_CLOSED, SESSION_EXTENDED, SESSION_REGULAR};
use pyth_solana_receiver_sdk::price_update::{PriceFeedMessage, PriceUpdateV2, VerificationLevel};
use solana_signer::Signer;

fn set_oracle(b: &mut Book, shard: u16, age: u64, conf: u32) -> TxResult {
    let admin = b.w.admin.pubkey();
    let i = ix(
        ka::SetMarketOracle {
            exchange: exchange_pda(),
            admin,
            market: market_pda(1),
        },
        ki::SetMarketOracle {
            market_id: 1,
            pyth_shard_id: shard,
            max_oracle_age_secs: age,
            max_oracle_confidence_bps: conf,
        },
    );
    b.w.admin_send(&[i])
}

#[test]
fn the_shard_is_configurable_and_binds_the_price_account() {
    let mut b = Book::new();
    // Move from the sponsored shard 0 to our own shard 1.
    assert_ok(set_oracle(&mut b, 1, 10, 50));
    let m = b.w.market(1);
    assert_eq!(
        (
            m.pyth_shard_id,
            m.max_oracle_age_secs,
            m.max_oracle_confidence_bps
        ),
        (1, 10, 50)
    );
    // Only shard 1's account exists yet: settle_accounts derives it from the market.
    let now = b.w.now();
    mock_price(
        &mut b.w.svm,
        1,
        FEED_TSLA,
        250_0000_0000,
        1_0000_0000,
        -8,
        now,
    );
    assert_ok(b.trade(true, W, PX));
    // Passing the (still fresh) shard-0 account instead is refused.
    let (mo, to) = b.pair(true, W, PX);
    let mut settle = b.w.settle_ix(1, &[plan(&b.alice, &b.bob, mo, to, W, PX)]);
    settle.accounts[3].pubkey = floydex_perps::oracle::push_feed_address(0, &FEED_TSLA);
    let entries = [
        SigEntry::sign(&b.alice_key, &order_message(DOMAIN, &b.alice, &mo)),
        SigEntry::sign(&b.bob_key, &order_message(DOMAIN, &b.bob, &to)),
    ];
    let op = b.w.operator.insecure_clone();
    let r = send(
        &mut b.w.svm,
        &[compute_budget(1_400_000), ed25519_ix(&entries), settle],
        &op,
        &[],
    );
    assert_err(r, FloyDexError::InvalidOracleAccount);
}

#[test]
fn only_the_admin_changes_the_oracle_source() {
    let mut b = Book::new();
    let s = funded(&mut b.w.svm);
    let i = ix(
        ka::SetMarketOracle {
            exchange: exchange_pda(),
            admin: s.pubkey(),
            market: market_pda(1),
        },
        ki::SetMarketOracle {
            market_id: 1,
            pyth_shard_id: 1,
            max_oracle_age_secs: 10,
            max_oracle_confidence_bps: 50,
        },
    );
    assert_err(send(&mut b.w.svm, &[i], &s, &[]), FloyDexError::Unauthorized);
    assert_err(set_oracle(&mut b, 1, 0, 50), FloyDexError::InvalidConfig);
}

#[test]
fn partially_verified_updates_are_refused() {
    let mut b = Book::new();
    let now = b.w.now();
    let u = PriceUpdateV2 {
        write_authority: Default::default(),
        verification_level: VerificationLevel::Partial { num_signatures: 5 },
        price_message: PriceFeedMessage {
            feed_id: FEED_TSLA,
            price: 250_0000_0000,
            conf: 1,
            exponent: -8,
            publish_time: now,
            prev_publish_time: now - 1,
            ema_price: 250_0000_0000,
            ema_conf: 1,
        },
        posted_slot: 0,
    };
    let mut data = Vec::new();
    u.try_serialize(&mut data).unwrap();
    mock_price_with(
        &mut b.w.svm,
        floydex_perps::oracle::push_feed_address(0, &FEED_TSLA),
        pyth_solana_receiver_sdk::ID,
        data,
    );
    assert_err(b.trade(true, W, PX), FloyDexError::OracleNotFullyVerified);
}

#[test]
fn any_pyth_exponent_rescales_to_precision() {
    let mut b = Book::new();
    let now = b.w.now();
    // $250 at exponent -5 instead of -8.
    mock_price(&mut b.w.svm, 0, FEED_TSLA, 250_00000, 10, -5, now);
    assert_ok(b.trade(true, W, PX));
    assert_eq!(b.w.market(1).last_oracle_price.get(), 250 * P);
    // $1 at exponent -18: the band is around $1, so $250 is refused.
    mock_price(
        &mut b.w.svm,
        0,
        FEED_TSLA,
        1_000_000_000_000_000_000,
        0,
        -18,
        now,
    );
    assert_err(b.trade(true, W, PX), FloyDexError::PriceOutsideBand);
}

#[test]
fn a_publish_time_in_the_future_is_never_fresh() {
    let mut b = Book::new();
    assert_ok(b.trade(true, W, PX)); // records a last valid price
    let now = b.w.now();
    mock_usd(&mut b.w.svm, FEED_TSLA, 250.0, now + 30);
    // In a scheduled window a not-fresh oracle means Halted: reduce-only.
    assert_err(b.trade(true, W, PX), FloyDexError::SessionExposureBlocked);
}

#[test]
fn the_last_trusted_price_only_moves_forward_in_time() {
    let mut b = Book::new();
    assert_ok(b.trade(true, W, PX));
    let t0 = b.w.market(1).last_oracle_publish_time;
    // An older (but still fresh) update does not overwrite a newer one.
    mock_usd(&mut b.w.svm, FEED_TSLA, 249.0, t0 as i64 - 5);
    assert_ok(b.trade(true, W, 249 * W));
    let m = b.w.market(1);
    assert_eq!(
        (m.last_oracle_price.get(), m.last_oracle_publish_time),
        (250 * P, t0)
    );
}

// --- calendar ---

#[test]
fn only_the_calendar_authority_posts() {
    let mut b = Book::new();
    let s = funded(&mut b.w.svm);
    let now = b.w.now();
    let i = ix(
        ka::PostSessionCalendar {
            exchange: exchange_pda(),
            calendar_authority: s.pubkey(),
            market: market_pda(1),
        },
        ki::PostSessionCalendar {
            windows: vec![window(now + 10, now + 20, SESSION_REGULAR)],
        },
    );
    assert_err(send(&mut b.w.svm, &[i], &s, &[]), FloyDexError::Unauthorized);
}

#[test]
fn windows_must_be_future_sorted_and_disjoint() {
    let mut b = Book::new();
    let now = b.w.now();
    // The fixture's current window runs until now + 7d.
    let cur_end = b.w.market(1).calendar[0].end as i64;
    let bad = [
        vec![window(now - 10, cur_end + 10, SESSION_REGULAR)], // starts in the past
        vec![window(now + 10, now + 20, SESSION_REGULAR)],     // overlaps the current window
        vec![window(cur_end + 20, cur_end + 10, SESSION_REGULAR)], // end before start
        vec![
            window(cur_end + 10, cur_end + 20, SESSION_REGULAR),
            window(cur_end + 15, cur_end + 30, SESSION_REGULAR),
        ],
        vec![window(cur_end + 10, cur_end + 20, 9)], // unknown session code
    ];
    for ws in bad {
        assert_err(b.w.post_calendar(1, ws), FloyDexError::InvalidSessionWindow);
    }
    // 15 future windows fit next to the current one; 16 do not.
    let many = |n: i64| {
        (0..n)
            .map(|k| {
                window(
                    cur_end + 10 + 100 * k,
                    cur_end + 60 + 100 * k,
                    SESSION_REGULAR,
                )
            })
            .collect::<Vec<_>>()
    };
    assert_err(
        b.w.post_calendar(1, many(16)),
        FloyDexError::InvalidSessionWindow,
    );
    assert_ok(b.w.post_calendar(1, many(15)));
}

#[test]
fn posting_never_rewrites_the_window_in_effect() {
    let mut b = Book::new();
    let current = b.w.market(1).calendar[0];
    let end = current.end as i64;
    assert_ok(b.w.post_calendar(1, vec![window(end, end + 3_600, SESSION_EXTENDED)]));
    let m = b.w.market(1);
    assert_eq!(m.calendar[0], current, "the current window is kept as is");
    assert_eq!(
        (m.calendar[1].start as i64, m.calendar[1].session),
        (end, SESSION_EXTENDED)
    );
    // A second post replaces the future windows, not the current one.
    assert_ok(b.w.post_calendar(1, vec![window(end + 7_200, end + 9_000, SESSION_CLOSED)]));
    let m = b.w.market(1);
    assert_eq!(m.calendar[0], current);
    assert_eq!(m.calendar[1].start as i64, end + 7_200);
    assert_eq!(m.calendar[2].end, 0, "old future windows are gone");
}

#[test]
fn sessions_follow_the_posted_calendar() {
    // Start with no calendar at all: the market is Closed (fail-safe), so a
    // first fill needs a last trusted price.
    let mut b = Book::new();
    patch_zc::<floydex_perps::state::Market>(&mut b.w.svm, &market_pda(1), |m| {
        m.calendar = Default::default()
    });
    assert_err(b.trade(true, W, PX), FloyDexError::StaleOracle);
    // The keeper posts: Regular in 60 s for an hour, then Extended.
    let now = b.w.now();
    assert_ok(b.w.post_calendar(
        1,
        vec![
            window(now + 60, now + 3_660, SESSION_REGULAR),
            window(now + 3_660, now + 7_260, SESSION_EXTENDED),
        ],
    ));
    b.w.warp_to(now + 61);
    mock_usd(&mut b.w.svm, FEED_TSLA, 250.0, now + 61);
    assert_ok(b.trade(true, 100 * W, PX)); // Regular: 20% IM, 25k notional is fine
                                           // Extended: margin ×1.5 → 30%; a further 100 shares needs 15k of the 20k equity… per side
    b.w.warp_to(now + 3_700);
    mock_usd(&mut b.w.svm, FEED_TSLA, 250.0, now + 3_700);
    assert_err(
        b.trade(true, 100 * W, PX),
        FloyDexError::InsufficientCollateral,
    );
    assert_ok(b.trade(true, 10 * W, PX));
    // After the last window: Closed at the last trusted price, margin ×2
    // (40%). 110 shares need 11,000 > equity, yet a small reduce goes
    // through because it does not worsen health.
    b.w.warp_to(now + 8_000);
    assert_ok(b.trade(false, 10 * W, PX));
    assert_ne!(b.w.market(1).closed_since, 0);
}
