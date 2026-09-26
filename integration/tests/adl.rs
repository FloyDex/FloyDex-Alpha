//! Phase 2 (f): `adl` only against recorded bad debt and only from a
//! position in profit (Stellar Q4, `11` L12), two-sided at the mark
//! (decided 2026-09-26); and the OI caps against the fund (Q11).

mod common;
use common::*;
use kryon_integration::*;
use kryon_perps::error::KryonError;

/// Alice goes bankrupt at $140 with an empty fund: all of it is bad debt.
/// Carol (keeper) ends up holding Alice's long; Bob holds the short.
fn with_bad_debt() -> (Book, Trader) {
    let mut b = Book::new();
    assert_ok(b.w.init_insurance(7 * 86_400, 20, 5_000));
    let usdc = Asset {
        mint: b.usdc.mint,
        token_program: b.usdc.token_program,
    };
    let carol = b.w.funded_trader(&usdc, 50_000);
    assert_ok(b.trade(true, 100 * W, PX));
    b.w.tick(1, 140.0);
    let id = b.position(&b.alice).unwrap().position_id;
    while b.position(&b.alice).is_some() {
        assert_ok(b.w.liquidate(&carol, &b.alice, 1, id, vec![]));
    }
    assert!(b.w.insurance().bad_debt > 0);
    (b, carol)
}

fn pid(b: &Book, t: &Trader) -> u64 {
    b.position(t).unwrap().position_id
}

#[test]
fn adl_cuts_the_winner_just_enough_and_clears_the_bad_debt() {
    let (mut b, carol) = with_bad_debt();
    let debt = b.w.insurance().bad_debt;
    let (bob_id, carol_id) = (pid(&b, &b.bob), pid(&b, &carol));
    let bob0 = b.w.user(&b.bob).balance(0);
    let carol0 = b.w.user(&carol).balance(0);
    // Bob's short from 250 makes 110 a share at 140: close ⌈debt / 110⌉.
    let size = protocol_core::mul_div_ceil(debt, P, 110 * P).unwrap();
    assert_ok(b.w.adl(&b.bob, bob_id, &carol, carol_id, 1));
    assert_eq!(b.w.insurance().bad_debt, 0);
    assert_eq!(b.position(&b.bob).unwrap().size.get(), 100 * P - size);
    assert_eq!(b.position(&carol).unwrap().size.get(), 100 * P - size);
    let realized = protocol_core::mul_div_floor(size, 110 * P, P).unwrap();
    assert_eq!(b.w.user(&b.bob).balance(0) - bob0, realized - debt);
    // Carol closed at the mark she entered at: no gain, no loss.
    assert_eq!(b.w.user(&carol).balance(0), carol0);
    let m = b.w.market(1);
    assert_eq!(m.oi_long.get(), m.oi_short.get());
    // No bad debt left: the vault alone covers every liability.
    for px in [100, 140, 250] {
        assert_solvent(&b.w, &b.usdc, &[&b.alice, &b.bob, &carol], 1, px * P);
    }
    // Nothing left to offset.
    assert_err(
        b.w.adl(&b.bob, bob_id, &carol, carol_id, 1),
        KryonError::NoBadDebtToOffset,
    );
}

#[test]
fn adl_needs_recorded_bad_debt() {
    let mut b = Book::new();
    assert_ok(b.w.init_insurance(7 * 86_400, 20, 5_000));
    assert_ok(b.trade(true, 10 * W, PX));
    b.w.tick(1, 260.0);
    let (a, bo) = (pid(&b, &b.alice), pid(&b, &b.bob));
    assert_err(
        b.w.adl(&b.alice, a, &b.bob, bo, 1),
        KryonError::NoBadDebtToOffset,
    );
}

#[test]
fn adl_only_takes_from_a_position_in_profit() {
    let (mut b, carol) = with_bad_debt();
    let (bob_id, carol_id) = (pid(&b, &b.bob), pid(&b, &carol));
    // Carol's long from 140 is under water at 139: not a winner.
    b.w.tick(1, 139.0);
    assert_err(
        b.w.adl(&carol, carol_id, &b.bob, bob_id, 1),
        KryonError::PositionNotInProfit,
    );
    // A position is not its own counterparty.
    assert_err(
        b.w.adl(&b.bob, bob_id, &b.bob, bob_id, 1),
        KryonError::SelfTrade,
    );
}

#[test]
fn adl_is_refused_while_halted() {
    let (mut b, carol) = with_bad_debt();
    let (bob_id, carol_id) = (pid(&b, &b.bob), pid(&b, &carol));
    b.w.warp(1);
    let now = b.w.now();
    mock_usd(&mut b.w.svm, FEED_TSLA, 140.0, now - 600);
    assert_err(
        b.w.adl(&b.bob, bob_id, &carol, carol_id, 1),
        KryonError::MarketHalted,
    );
}

// --- OI against the fund (Stellar require_insurance_headroom, Q11) ---

fn set_oi_policy(b: &mut Book, bps: u32) {
    patch_zc::<kryon_perps::state::Market>(&mut b.w.svm, &market_pda(1), |m| m.oi_policy_bps = bps);
}

#[test]
fn new_exposure_is_capped_by_what_the_fund_can_stand_behind() {
    let mut b = Book::new();
    set_oi_policy(&mut b, 20_000); // 2x the fund
                                   // No insurance yet: a capped market cannot add exposure.
    assert_err(b.trade(true, W, PX), KryonError::InsuranceNotInitialized);
    assert_ok(b.w.init_insurance(7 * 86_400, 20, 5_000));
    assert_err(b.trade(true, W, PX), KryonError::InsuranceFundInsufficient);
    // 1,000 staked → 2,000 of notional → 8 shares at $250.
    let s = funded(&mut b.w.svm);
    let st = Trader {
        kp: s.insecure_clone(),
        sub_id: 0,
        user: user_pda(&solana_signer::Signer::pubkey(&s), 0),
    };
    let usdc = Asset {
        mint: b.usdc.mint,
        token_program: b.usdc.token_program,
    };
    let wallet = b.w.wallet(&st, &usdc, 1_000 * USDC);
    assert_ok(b.w.stake(&s, &usdc, &wallet, 1_000 * USDC));
    assert_ok(b.trade(true, 8 * W, PX));
    assert_err(b.trade(true, W, PX), KryonError::InsuranceFundInsufficient);
    // Exits are never blocked.
    assert_ok(b.trade(false, 3 * W, PX));
    assert_ok(b.trade(true, 3 * W, PX));
}

#[test]
fn the_aggregate_ceiling_cannot_drop_below_what_markets_committed() {
    let mut w = World::new();
    let mut p = default_market_params();
    p.oi_policy_bps = 40_000;
    let i = w.create_market_ix(1, p);
    assert_ok(w.admin_send(&[i]));
    let i = w.admin_ix(ki::SetMaxTotalOiPolicyBps { max_total: 39_999 });
    assert_err(w.admin_send(&[i]), KryonError::AggregateOiPolicyExceeded);
    let i = w.admin_ix(ki::SetMaxTotalOiPolicyBps { max_total: 50_000 });
    assert_ok(w.admin_send(&[i]));
    assert_eq!(w.exchange().max_total_oi_policy_bps, 50_000);
    // Now a second market can commit at most 10,000 more.
    let mut p = default_market_params();
    p.oi_policy_bps = 10_001;
    let i = w.create_market_ix(2, p);
    assert_err(w.admin_send(&[i]), KryonError::AggregateOiPolicyExceeded);
}
