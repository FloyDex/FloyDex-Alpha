//! Phase 2 (d): `liquidate` by position transfer (decided 2026-09-26), the
//! penalty split, the deficit waterfall (collateral → insurance → bad debt),
//! grace, and conservation (`05` §2, §7; `07` §2; `11` L5, L9).

mod common;
use common::*;
use kryon_integration::*;
use kryon_perps::error::KryonError;
use protocol_core::{apply_bps, mul_div, notional};

/// Book + insurance (7-day cooldown, reward cap 20 bps, 50% per step) + a
/// keeper, Carol, with 50k USDC.
fn setup() -> (Book, Trader) {
    let mut b = Book::new();
    assert_ok(b.w.init_insurance(7 * 86_400, 20, 5_000));
    let usdc = Asset {
        mint: b.usdc.mint,
        token_program: b.usdc.token_program,
    };
    let carol = b.w.funded_trader(&usdc, 50_000);
    (b, carol)
}

fn pid(b: &Book, t: &Trader) -> u64 {
    b.position(t).unwrap().position_id
}

#[test]
fn a_healthy_account_is_not_liquidatable() {
    let (mut b, carol) = setup();
    assert_ok(b.trade(true, 100 * W, PX));
    let id = pid(&b, &b.alice);
    assert_err(
        b.w.liquidate(&carol, &b.alice, 1, id, vec![]),
        KryonError::NotLiquidatable,
    );
}

#[test]
fn insurance_must_exist_first() {
    let mut b = Book::new();
    let usdc = Asset {
        mint: b.usdc.mint,
        token_program: b.usdc.token_program,
    };
    let carol = b.w.funded_trader(&usdc, 50_000);
    assert_ok(b.trade(true, 100 * W, PX));
    b.w.tick(1, 165.0);
    let id = pid(&b, &b.alice);
    // The insurance PDA does not exist yet: the account constraint fails.
    assert!(b.w.liquidate(&carol, &b.alice, 1, id, vec![]).is_err());
}

#[test]
fn a_partial_liquidation_transfers_the_minimum_slice_at_the_mark() {
    let (mut b, carol) = setup();
    assert_ok(b.trade(true, 100 * W, PX)); // alice long 100 @ 250, bob short
    b.w.tick(1, 165.0);
    // Alice: balance 9,995 (maker fee 5), upnl −8,500 → equity 1,495 < MM 1,650.
    let id = pid(&b, &b.alice);
    let fund0 = b.w.insurance().fund;
    let alice0 = b.w.user(&b.alice).balance(0);
    let carol0 = b.w.user(&carol).balance(0);
    let m = assert_ok(b.w.liquidate(&carol, &b.alice, 1, id, vec![]));
    println!(
        "liquidate, 1 position each: {} CU",
        m.compute_units_consumed
    );

    // plan_liquidation: the smallest slice that restores maintenance after
    // the penalty, shortfall / (165 · (10% − 0.5%)), never the 50% cap (L9).
    let shortfall = 1_650 * P - 1_495 * P;
    let per_unit = mul_div(165 * P, 950, 10_000).unwrap();
    let exact = protocol_core::mul_div_ceil(shortfall, P, per_unit).unwrap();
    // Rounded up to whole order units (1e-9 share) so it stays closable.
    let size = kryon_perps::position::to_whole_units(exact, 100 * P);
    assert!(size >= exact && size - exact < 1_000_000_000);
    assert!(size < 50 * P);
    let n = notional(size, 165 * P).unwrap();
    let penalty = apply_bps(n, 50).unwrap();
    let reward = penalty.min(apply_bps(n, 20).unwrap());
    assert!(reward < penalty);

    let a = b.position(&b.alice).unwrap();
    assert_eq!(a.size.get(), 100 * P - size);
    let c = b.position(&carol).unwrap();
    assert_eq!(
        (c.is_long, c.size.get(), c.entry_price.get()),
        (1, size, 165 * P),
        "Carol took the slice at the mark"
    );
    // Alice realized the slice at the mark and paid the penalty.
    let realized = protocol_core::mul_div_floor(size, -85 * P, P).unwrap();
    assert_eq!(b.w.user(&b.alice).balance(0) - alice0, realized - penalty);
    assert_eq!(b.w.user(&carol).balance(0) - carol0, reward);
    assert_eq!(b.w.insurance().fund - fund0, penalty - reward);
    // OI stays two-sided: 100 long (alice + carol) vs bob's 100 short.
    let mk = b.w.market(1);
    assert_eq!((mk.oi_long.get(), mk.oi_short.get()), (100 * P, 100 * P));
    for px in [140, 165, 250] {
        assert_solvent(&b.w, &b.usdc, &[&b.alice, &b.bob, &carol], 1, px * P);
    }
}

#[test]
fn one_step_restores_health_and_then_it_stops() {
    let (mut b, carol) = setup();
    assert_ok(b.trade(true, 100 * W, PX));
    b.w.tick(1, 160.0);
    let id = pid(&b, &b.alice);
    let mut steps = 0;
    while b.w.liquidate(&carol, &b.alice, 1, id, vec![]).is_ok() {
        steps += 1;
        assert!(steps < 40, "liquidation must converge");
    }
    assert_eq!(steps, 1, "one step restores maintenance");
    assert_err(
        b.w.liquidate(&carol, &b.alice, 1, id, vec![]),
        KryonError::NotLiquidatable,
    );
    assert!(
        b.position(&b.alice).is_some(),
        "only what was needed was closed"
    );
    assert_solvent(&b.w, &b.usdc, &[&b.alice, &b.bob, &carol], 1, 160 * P);
}

#[test]
fn a_bankrupt_account_draws_insurance_then_records_bad_debt_and_retires_shares() {
    let (mut b, carol) = setup();
    // Dan stakes 500 USDC.
    let dan = funded(&mut b.w.svm);
    let dan_t = Trader {
        kp: dan.insecure_clone(),
        sub_id: 0,
        user: user_pda(&solana_signer::Signer::pubkey(&dan), 0),
    };
    let usdc = Asset {
        mint: b.usdc.mint,
        token_program: b.usdc.token_program,
    };
    let dan_wallet = b.w.wallet(&dan_t, &usdc, 500 * USDC);
    assert_ok(b.w.stake(&dan, &usdc, &dan_wallet, 500 * USDC));
    assert_eq!(b.w.insurance().fund, 500 * P);

    assert_ok(b.trade(true, 100 * W, PX));
    b.w.tick(1, 140.0); // Alice: 9,995 − 11,000 → equity ≈ −1,005
    let id = pid(&b, &b.alice);
    let mut steps = 0;
    while b.position(&b.alice).is_some() {
        assert_ok(b.w.liquidate(&carol, &b.alice, 1, id, vec![]));
        steps += 1;
        assert!(steps < 40);
    }
    let ins = b.w.insurance();
    assert_eq!(ins.fund, 0, "the fund was wiped");
    assert_eq!(ins.epoch, 1, "so its shares were retired");
    assert_eq!(ins.total_shares, 0);
    assert!(ins.bad_debt > 500 * P, "bad debt {}", ins.bad_debt);
    assert_eq!(
        b.w.user(&b.alice).balance(0),
        0,
        "the deficit was covered or written off"
    );
    // Carol now holds the whole long; OI is still balanced.
    assert_eq!(b.position(&carol).unwrap().size.get(), 100 * P);
    let mk = b.w.market(1);
    assert_eq!(mk.oi_long.get(), mk.oi_short.get());
    // Conservation with the recorded shortfall: vault + bad debt ≥ liabilities.
    for px in [120, 140, 200] {
        assert_solvent(&b.w, &b.usdc, &[&b.alice, &b.bob, &carol], 1, px * P);
    }
    // Dan's retired shares are gone: he has nothing left to unstake.
    assert_err(
        b.w.request_unstake(&dan, 500 * P),
        KryonError::InsufficientShares,
    );
}

#[test]
fn halted_markets_are_not_liquidated() {
    let (mut b, carol) = setup();
    assert_ok(b.trade(true, 100 * W, PX));
    b.w.warp(1);
    let now = b.w.now();
    mock_usd(&mut b.w.svm, FEED_TSLA, 140.0, now - 600);
    let id = pid(&b, &b.alice);
    assert_err(
        b.w.liquidate(&carol, &b.alice, 1, id, vec![]),
        KryonError::MarketHalted,
    );
}

#[test]
fn nobody_liquidates_their_own_account() {
    let (mut b, _carol) = setup();
    assert_ok(b.trade(true, 100 * W, PX));
    b.w.tick(1, 140.0);
    let id = pid(&b, &b.alice);
    let alice = Trader {
        kp: b.alice.kp.insecure_clone(),
        sub_id: b.alice.sub_id,
        user: b.alice.user,
    };
    assert_err(
        b.w.liquidate(&alice, &b.alice, 1, id, vec![]),
        KryonError::SelfLiquidation,
    );
}

#[test]
fn the_liquidator_must_be_able_to_margin_the_position() {
    let (mut b, _carol) = setup();
    let usdc = Asset {
        mint: b.usdc.mint,
        token_program: b.usdc.token_program,
    };
    let poor = b.w.funded_trader(&usdc, 1);
    assert_ok(b.trade(true, 100 * W, PX));
    b.w.tick(1, 140.0);
    let id = pid(&b, &b.alice);
    assert_err(
        b.w.liquidate(&poor, &b.alice, 1, id, vec![]),
        KryonError::InsufficientCollateral,
    );
}

#[test]
fn grace_protects_an_account_from_the_close_multiplier_alone() {
    let (mut b, carol) = setup();
    assert_ok(b.trade(true, 100 * W, PX)); // before the ramp
    let t0 = b.w.now();
    // The window closes at t0 + 5,400; the ramp starts at t0 + 1,800.
    b.w.post_regular_window(1, t0 - 3_600, t0 + 5_400);
    // Halfway up the ramp, maintenance is 15% (×1.5). At $175 Alice has
    // equity ≈ 2,495: above the base 1,750 but below the ramped 2,625.
    b.w.warp_to(t0 + 3_600);
    let now = b.w.now();
    mock_usd(&mut b.w.svm, FEED_TSLA, 175.0, now);
    let id = pid(&b, &b.alice);
    assert_err(
        b.w.liquidate(&carol, &b.alice, 1, id, vec![]),
        KryonError::NotLiquidatable,
    );
    // Had she added exposure during the ramp, she would get no grace.
    let saved = b.w.user(&b.alice).last_increase_ts;
    patch_zc::<kryon_perps::state::UserAccount>(&mut b.w.svm, &b.alice.user, |u| {
        u.last_increase_ts = (t0 + 2_000) as u64
    });
    b.w.svm.expire_blockhash();
    assert_ok(b.w.liquidate(&carol, &b.alice, 1, id, vec![]));
    let _ = saved;
}

#[test]
fn grace_does_not_protect_against_the_price() {
    let (mut b, carol) = setup();
    assert_ok(b.trade(true, 100 * W, PX));
    let t0 = b.w.now();
    b.w.post_regular_window(1, t0 - 3_600, t0 + 5_400);
    b.w.warp_to(t0 + 3_600);
    let now = b.w.now();
    mock_usd(&mut b.w.svm, FEED_TSLA, 165.0, now); // below even the base 10%
    let id = pid(&b, &b.alice);
    assert_ok(b.w.liquidate(&carol, &b.alice, 1, id, vec![]));
}

#[test]
fn closed_markets_liquidate_at_the_clamped_book_mark() {
    let (mut b, carol) = setup();
    // Alice long 199 @ 250: just inside Regular IM. Closed doubles MM to 20%.
    assert_ok(b.trade(true, 199 * W, PX));
    b.w.close_market(1);
    // The weekend book walks down; the mark follows it inside the 2% band.
    for _ in 0..40 {
        b.w.warp(60);
        assert_ok(b.w.post_mark(1, 240 * W));
    }
    let id = pid(&b, &b.alice);
    assert_ok(b.w.liquidate(&carol, &b.alice, 1, id, vec![]));
    let c = b.position(&carol).unwrap();
    let mark = c.entry_price.get();
    assert!((245 * P..250 * P).contains(&mark), "mark {mark}");
    assert_solvent(&b.w, &b.usdc, &[&b.alice, &b.bob, &carol], 1, mark);
}

const FEED_XSTOCK: [u8; 32] = [0x42; 32];

#[test]
fn other_collateral_is_sold_to_the_liquidator_at_its_haircut_value() {
    let mut w = World::new();
    let usdc = w.add_usdc(u64::MAX);
    let x = w.add_xstock(FEED_XSTOCK, 1_000); // 10% haircut
    let tsla = w.open_market(1, 250.0);
    let now = w.now();
    let xfeed = mock_usd(&mut w.svm, FEED_XSTOCK, 250.0, now);
    assert_ok(w.init_insurance(7 * 86_400, 20, 5_000));
    // Alice: 10 USDC + 40 xStock ($10,000, $9,000 after haircut).
    let alice = w.funded_trader(&usdc, 10);
    let xw = w.wallet(&alice, &x, 40 * 100_000_000);
    assert_ok(w.deposit(&alice, &x, &xw, 40 * 100_000_000));
    let bob = w.funded_trader(&usdc, 20_000);
    let carol = w.funded_trader(&usdc, 50_000);
    let (ak, bk) = (
        solana_keypair::Keypair::new(),
        solana_keypair::Keypair::new(),
    );
    let exp = w.now() + 86_400;
    assert_ok(w.set_delegate(&alice, &solana_signer::Signer::pubkey(&ak), exp));
    assert_ok(w.set_delegate(&bob, &solana_signer::Signer::pubkey(&bk), exp));
    let e = (w.now() + 3_600) as u64;
    let mut p = plan(
        &alice,
        &bob,
        order_args(1, true, 100 * W, PX, 1, e),
        order_args(1, false, 100 * W, PX, 1, e),
        100 * W,
        PX,
    );
    let xrisk = collateral_risk(&x, xfeed);
    p.maker_risk = xrisk.clone();
    assert_ok(w.settle(1, &[p], &[(&ak, &bk)]));

    // TSLA falls to $170: equity ≈ 9,010 − 8,000 = 1,010 < MM 1,700.
    w.warp(1);
    let now = w.now();
    mock_usd(&mut w.svm, FEED_TSLA, 170.0, now);
    let xfeed = mock_usd(&mut w.svm, FEED_XSTOCK, 250.0, now);
    let xrisk = collateral_risk(&x, xfeed);
    let id = w
        .user(&alice)
        .positions
        .iter()
        .find(|p| p.in_use != 0)
        .unwrap()
        .position_id;
    let mut steps = 0;
    loop {
        let carol_has_x = w.user(&carol).balance(1) > 0;
        let mut extra = xrisk.clone();
        if carol_has_x {
            extra.extend(xrisk.clone());
        }
        match w.liquidate(&carol, &alice, 1, id, extra) {
            Ok(_) => steps += 1,
            Err(f) => {
                assert!(
                    format!("{:?}", f.err).contains(&format!(
                        "Custom({})",
                        anchor_code(KryonError::NotLiquidatable)
                    )),
                    "{:?}\n{:#?}",
                    f.err,
                    f.meta.logs
                );
                break;
            }
        }
        assert!(steps < 40);
    }
    let a = w.user(&alice);
    let c = w.user(&carol);
    assert!(c.balance(1) > 0, "Carol bought Alice's xStock");
    assert_eq!(
        a.balance(1) + c.balance(1),
        40 * P,
        "the xStock ledger still balances"
    );
    assert!(
        a.balance(0) >= 0,
        "Alice's USDC debt was settled from her xStock: usdc {} x {} carol x {}",
        a.balance(0),
        a.balance(1),
        c.balance(1)
    );
    assert_eq!(w.insurance().bad_debt, 0, "no loss was socialised");
    let _ = tsla;
}
