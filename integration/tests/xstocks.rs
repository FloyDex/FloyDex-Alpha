//! Phase 2 (g): xStocks collateral: the Token-2022 extension allow-list, the
//! scaled-UI multiplier in valuation, and the extra haircut while the
//! underlying's market is closed (`06` §6–7, `07` §6).

use kryon_integration::*;
use kryon_perps::error::KryonError;
use solana_signer::Signer;

const FEED_X: [u8; 32] = [0x42; 32];
const XU: u64 = 100_000_000; // 8 decimals

fn list(w: &mut World, mint: Pubkey, p: kryon_perps::CollateralParams) -> TxResult {
    let i = w.add_collateral_ix(&mint, spl_token_2022::ID, p);
    w.admin_send(&[i])
}

use anchor_lang::prelude::Pubkey;
use anchor_spl::token_2022::spl_token_2022;

#[test]
fn issuer_controls_and_accounting_breakers_are_refused() {
    let mut w = World::new();
    let _usdc = w.add_usdc(u64::MAX);
    let admin = w.admin.pubkey();
    let refused: [(u16, usize); 9] = [
        (ext::TRANSFER_HOOK, 64),
        (ext::PERMANENT_DELEGATE, 32),
        (ext::PAUSABLE, 33),
        (ext::TRANSFER_FEE_CONFIG, 108),
        (ext::INTEREST_BEARING_CONFIG, 52),
        (ext::NON_TRANSFERABLE, 0),
        (ext::DEFAULT_ACCOUNT_STATE, 1),
        (ext::CONFIDENTIAL_TRANSFER_MINT, 65),
        (99, 8), // a type from the future
    ];
    for (ty, len) in refused {
        let mint = crafted_mint(&mut w.svm, &admin, 8, &[(ty, vec![0; len])]);
        assert_err(
            list(&mut w, mint, xstock_params(FEED_X, 1_000)),
            KryonError::UnsupportedMintExtension,
        );
    }
    // A scaled-UI mint with metadata, as xStocks ship, is accepted.
    let mint = crafted_mint(
        &mut w.svm,
        &admin,
        8,
        &[scaled_ui(1.0, 0, 1.0), (ext::METADATA_POINTER, vec![0; 64])],
    );
    assert_ok(list(&mut w, mint, xstock_params(FEED_X, 1_000)));
}

#[test]
fn closed_haircut_config_is_validated() {
    let mut w = World::new();
    let _usdc = w.add_usdc(u64::MAX);
    let admin = w.admin.pubkey();
    let mut p = xstock_params(FEED_X, 9_500);
    p.closed_haircut_bps = 600; // 95% + 6% > 100%
    let m = crafted_mint(&mut w.svm, &admin, 8, &[]);
    assert_err(list(&mut w, m, p.clone()), KryonError::InvalidConfig);
    let mut p = xstock_params(FEED_X, 1_000);
    p.max_closed_age_secs = 60; // must exceed the fresh age (70)
    let m = crafted_mint(&mut w.svm, &admin, 8, &[]);
    assert_err(list(&mut w, m, p.clone()), KryonError::InvalidConfig);
    p.max_closed_age_secs = 6 * 86_400; // over the 5-day ceiling
    let m = crafted_mint(&mut w.svm, &admin, 8, &[]);
    assert_err(list(&mut w, m, p), KryonError::InvalidConfig);
}

/// A trader holding 10 xStock tokens of `mint` (priced $100) and long
/// 10 TSLA @ 250 (IM 500). Returns (world, trader, asset, wallet, TSLA feed).
fn holder(
    extensions: &[(u16, Vec<u8>)],
    closed_haircut_bps: u32,
    max_closed_age_secs: u64,
) -> (World, Trader, Asset, Pubkey, Pubkey) {
    let mut w = World::new();
    let _usdc = w.add_usdc(u64::MAX);
    let admin = w.admin.insecure_clone();
    let mint = crafted_mint(&mut w.svm, &admin.pubkey(), 8, extensions);
    let mut p = xstock_params(FEED_X, 0);
    p.closed_haircut_bps = closed_haircut_bps;
    p.max_closed_age_secs = max_closed_age_secs;
    assert_ok(list(&mut w, mint, p));
    let x = Asset {
        mint,
        token_program: spl_token_2022::ID,
    };
    let tsla = w.open_market(1, 250.0);
    let t = w.trader(0);
    let wallet = plain_token_account(&mut w.svm, &admin, &mint, &t.key());
    mint_to(
        &mut w.svm,
        &admin,
        spl_token_2022::ID,
        &mint,
        &wallet,
        10 * XU,
    );
    assert_ok(w.deposit(&t, &x, &wallet, 10 * XU));
    inject_position(&mut w.svm, &t.user, 1, true, 10 * P, 250 * P);
    (w, t, x, wallet, tsla)
}

fn risk(
    w: &mut World,
    x: &Asset,
    tsla: Pubkey,
    price_age: i64,
) -> Vec<anchor_lang::prelude::AccountMeta> {
    let now = w.now();
    let xfeed = mock_usd(&mut w.svm, FEED_X, 100.0, now - price_age);
    let mut v = vec![meta(market_pda(1), false), meta(tsla, false)];
    v.extend(collateral_risk(x, xfeed));
    v
}

#[test]
fn the_scaled_ui_multiplier_values_each_raw_token() {
    // Multiplier 2: 10 raw tokens are 20 shares, $2,000. IM 500 leaves
    // 1,500 free: 7.5 raw tokens may leave, not a unit more.
    let (mut w, t, x, wallet, tsla) = holder(&[scaled_ui(2.0, 0, 2.0)], 0, 0);
    let r = risk(&mut w, &x, tsla, 0);
    assert_err(
        w.withdraw(&t, &x, &wallet, 7 * XU + XU / 2 + 1, r.clone()),
        KryonError::InsufficientCollateral,
    );
    assert_ok(w.withdraw(&t, &x, &wallet, 7 * XU + XU / 2, r));
    assert_eq!(token_balance(&w.svm, &wallet), 7 * XU + XU / 2);
}

#[test]
fn a_scheduled_split_takes_effect_at_its_timestamp() {
    // ×1 today, ×2 from `at` (a 2-for-1 split).
    let at = GENESIS_TS + 3_600;
    let (mut w, t, x, wallet, tsla) = holder(&[scaled_ui(1.0, at, 2.0)], 0, 0);
    // Before: $1,000 of collateral, 500 free → 5 tokens.
    let r = risk(&mut w, &x, tsla, 0);
    assert_err(
        w.withdraw(&t, &x, &wallet, 5 * XU + 1, r.clone()),
        KryonError::InsufficientCollateral,
    );
    // After the split the same raw balance is worth twice as much.
    w.warp_to(at);
    let now = w.now();
    let tsla = mock_usd(&mut w.svm, FEED_TSLA, 250.0, now);
    let r = risk(&mut w, &x, tsla, 0);
    assert_ok(w.withdraw(&t, &x, &wallet, 7 * XU, r));
}

#[test]
fn a_closed_market_price_is_used_with_the_extra_haircut_until_it_is_too_old() {
    // No multiplier; 10% extra haircut while closed, prices up to 4 days old.
    let (mut w, t, x, wallet, tsla) = holder(&[], 1_000, 4 * 86_400);
    // Fresh: $1,000, 500 free → 5 tokens (not tested here). A Friday price
    // two days later: $900 after the closed haircut, 400 free → 4 tokens.
    let r = risk(&mut w, &x, tsla, 2 * 86_400);
    assert_err(
        w.withdraw(&t, &x, &wallet, 4 * XU + 1, r.clone()),
        KryonError::InsufficientCollateral,
    );
    assert_ok(w.withdraw(&t, &x, &wallet, 4 * XU, r));
    // Five days old: too old to value at all.
    let r = risk(&mut w, &x, tsla, 5 * 86_400);
    assert_err(w.withdraw(&t, &x, &wallet, 1, r), KryonError::StaleOracle);
}

#[test]
fn the_mint_account_must_match_the_collateral() {
    let (mut w, t, x, wallet, tsla) = holder(&[scaled_ui(2.0, 0, 2.0)], 0, 0);
    let mut r = risk(&mut w, &x, tsla, 0);
    let other = crafted_mint(
        &mut w.svm,
        &Pubkey::new_unique(),
        8,
        &[scaled_ui(9.0, 0, 9.0)],
    );
    let n = r.len();
    r[n - 1] = meta(other, false);
    assert_err(
        w.withdraw(&t, &x, &wallet, XU, r),
        KryonError::InvalidRemainingAccounts,
    );
}
