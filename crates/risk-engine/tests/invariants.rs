//! Property tests for the invariants in `05` §7 that live in the crates, and
//! for the Phase 2 session math. The program-level harness is
//! `integration/tests/fuzz_program.rs`.

use proptest::prelude::*;
use protocol_core::{
    asset_code, AccountSnapshot, CollateralBalance, MarginMode, MarketConfig, MarketSnapshot,
    Position, PRECISION,
};
use risk_engine::*;

const P: i128 = PRECISION;
const USER: [u8; 32] = [1; 32];

fn market(id: u32, price: i128, im: u32, mm: u32, fee: u32) -> MarketSnapshot {
    MarketSnapshot {
        config: MarketConfig {
            market_id: id,
            base_asset: asset_code("X"),
            settlement_asset: [2; 32],
            max_leverage_bps: 100_000,
            initial_margin_bps: im,
            maintenance_margin_bps: mm,
            liquidation_fee_bps: fee,
            max_open_interest: 1_000_000_000 * P,
            max_oracle_age_secs: 10,
            max_oracle_confidence_bps: 50,
            active: true,
        },
        oracle_price: price,
        funding_index_long: 0,
        funding_index_short: 0,
    }
}

fn position(id: u64, market_id: u32, size: i128, entry: i128, long: bool) -> Position {
    Position {
        position_id: id,
        owner: USER,
        market_id,
        size,
        entry_price: entry,
        margin: 0,
        is_long: long,
        last_funding_index: 0,
        mode: MarginMode::Cross,
    }
}

fn cash(amount: i128) -> [CollateralBalance; 1] {
    [CollateralBalance {
        asset: [2; 32],
        amount,
        value: amount,
        haircut_bps: 0,
    }]
}

/// Health after closing `size` of position `k` at its market's price and
/// paying `penalty` (what the program does in `liquidate`).
fn after_close(
    collateral: i128,
    positions: &[Position],
    markets: &[MarketSnapshot],
    k: usize,
    size: i128,
    penalty: i128,
) -> AccountHealth {
    let mut ps: Vec<Position> = positions.to_vec();
    let m = markets
        .iter()
        .find(|m| m.config.market_id == ps[k].market_id)
        .unwrap();
    let per_unit = if ps[k].is_long {
        m.oracle_price - ps[k].entry_price
    } else {
        ps[k].entry_price - m.oracle_price
    };
    let realized = protocol_core::mul_div_floor(size, per_unit, P).unwrap();
    ps[k].size -= size;
    if ps[k].size == 0 {
        ps.remove(k);
    }
    let c = cash(collateral + realized - penalty);
    account_health(
        &AccountSnapshot {
            owner: USER,
            collateral: &c,
            positions: &ps,
        },
        markets,
    )
    .unwrap()
}

prop_compose! {
    /// A cross account with 1–3 positions in 3 markets at random prices.
    fn account()(
        collateral in 0i128..20_000,
        n in 1usize..=3,
        sizes in prop::collection::vec(1i128..10_000, 3),
        entries in prop::collection::vec(1i128..1_000, 3),
        prices in prop::collection::vec(1i128..1_000, 3),
        longs in prop::collection::vec(any::<bool>(), 3),
        mm in 100u32..3_000,
        fee_frac in 0u32..100,
    ) -> (i128, Vec<Position>, Vec<MarketSnapshot>) {
        // create_market requires fee < maintenance.
        let fee = mm * fee_frac / 100;
        let positions = (0..n)
            .map(|i| position(i as u64 + 1, i as u32 + 1, sizes[i] * P / 10, entries[i] * P, longs[i]))
            .collect();
        let markets = (0..3)
            .map(|i| market(i as u32 + 1, prices[i] * P, (mm * 2).min(10_000), mm, fee))
            .collect();
        (collateral * P, positions, markets)
    }
}

proptest! {
    #![proptest_config(ProptestConfig {
        cases: 4_000,
        max_global_rejects: 200_000,
        ..ProptestConfig::default()
    })]

    /// 05 §7.5: a liquidation step never increases the shortfall, never
    /// closes more than the position or (partially) the per-step cap, and
    /// when the cap does not bind it restores maintenance (the sizing fix).
    #[test]
    fn liquidation_never_increases_shortfall(
        (collateral, positions, markets) in account(),
        k_seed in 0usize..3,
        cap_bps in 1u32..=10_000,
    ) {
        let c = cash(collateral);
        let snap = AccountSnapshot { owner: USER, collateral: &c, positions: &positions };
        let before = account_health(&snap, markets.as_slice()).unwrap();
        prop_assume!(before.liquidatable);
        let k = k_seed % positions.len();
        let plan = plan_liquidation(&snap, markets.as_slice(), positions[k].position_id, cap_bps).unwrap();
        prop_assert!(plan.close_size > 0 && plan.close_size <= positions[k].size);
        let cap = protocol_core::mul_div(positions[k].size, cap_bps as i128, 10_000).unwrap();
        prop_assert!(plan.mode == LiquidationMode::Full || plan.close_size <= cap);
        let after = after_close(collateral, &positions, &markets, k, plan.close_size, plan.penalty);
        let shortfall = |h: &AccountHealth| h.maintenance_margin_required - h.equity;
        prop_assert!(shortfall(&after) <= shortfall(&before),
            "shortfall {} → {}", shortfall(&before), shortfall(&after));
        prop_assert!(shortfall(&after) < shortfall(&before), "strictly");
        if plan.mode == LiquidationMode::Partial && plan.close_size < cap {
            // Exactly enough, to rounding.
            prop_assert!(after.equity >= after.maintenance_margin_required - P / 1_000_000_000,
                "not restored: equity {} mm {}", after.equity, after.maintenance_margin_required);
        }
    }

    /// Health is an identity: equity = collateral after haircut + Σ upnl, and
    /// a withdrawal is only allowed if equity after stays above initial margin.
    #[test]
    fn withdrawals_never_leave_equity_below_initial_margin(
        (collateral, positions, markets) in account(),
        w in 0i128..300_000,
    ) {
        let c = cash(collateral);
        let snap = AccountSnapshot { owner: USER, collateral: &c, positions: &positions };
        let h = account_health(&snap, markets.as_slice()).unwrap();
        prop_assert_eq!(h.equity, h.collateral_value + h.unrealized_pnl);
        if let Ok(after) = validate_withdrawal(&snap, markets.as_slice(), w * P) {
            prop_assert!(after.equity >= after.initial_margin_required);
            prop_assert_eq!(after.equity, h.equity - w * P);
        }
    }

    /// Funding is zero-sum: what longs pay per unit, shorts receive, so with
    /// OI long == OI short (05 §7.3) no value is created. The charged window
    /// never exceeds the elapsed cap.
    #[test]
    fn funding_is_zero_sum_and_capped(
        premium in -P..P,
        coeff in 0i128..(10 * P),
        max_rate in 1i128..(P / 100),
        last in 0u64..1_000_000,
        dt in 0u64..1_000_000,
    ) {
        let cfg = FundingConfig { imbalance_coeff: coeff, max_rate_per_hour: max_rate };
        let s = FundingState { long_index: 0, short_index: 0, rate_per_hour: 0, last_update: last };
        let n = update_from_premium(&cfg, &s, premium, last + dt).unwrap();
        prop_assert_eq!(n.long_index, -n.short_index);
        prop_assert!(n.rate_per_hour.abs() <= max_rate);
        prop_assert!(n.long_index.abs() <= max_rate);
        if dt > 0 {
            prop_assert_eq!(n.last_update, last + dt);
            prop_assert!(n.long_index == 0 || n.long_index.signum() == premium.signum());
        }
    }

    /// The mark EMA moves toward the sample, never past it, and never by
    /// more than the step bound.
    #[test]
    fn the_mark_ema_is_bounded(
        ema in 1i128..(10_000 * P),
        sample in 1i128..(10_000 * P),
        dt in 0u64..100_000,
        step in 1u32..=10_000,
    ) {
        let n = mark_ema_update(ema, 0, sample, dt, MARK_EMA_HALF_LIFE_SECS, step).unwrap();
        prop_assert!(n >= ema.min(sample) && n <= ema.max(sample));
        prop_assert!((n - ema).abs() <= protocol_core::apply_bps(ema, step).unwrap());
    }

    /// The closed mark always lies in the band around the last close, and the
    /// band never exceeds its ceiling.
    #[test]
    fn the_closed_mark_stays_in_its_band(
        last in 1i128..(10_000 * P),
        book in 1i128..(10_000 * P),
        secs in 0u64..(10 * 86_400),
        base in 0u32..1_000,
        per_hour in 0u32..200,
        max in 1_000u32..=5_000,
    ) {
        let policy = SessionPolicy {
            extended_margin_mult_bps: 15_000,
            closed_margin_mult_bps: 20_000,
            closed_band_base_bps: base,
            closed_band_per_hour_bps: per_hour,
            closed_band_max_bps: max,
            closed_oi_cap_bps: 5_000,
            close_ramp_secs: 3_600,
            close_grace_secs: 1_800,
        };
        let band = closed_band_bps(secs, &policy);
        prop_assert!(band <= max);
        let m = closed_mark_price(last, book, secs, &policy).unwrap();
        let w = protocol_core::apply_bps(last, band).unwrap();
        prop_assert!(m >= last - w && m <= last + w);
    }

    /// The margin ramp is monotone in time and stays between the two
    /// sessions' multipliers.
    #[test]
    fn the_margin_ramp_is_monotone(
        end in 10_000u64..100_000,
        ramp in 1u32..20_000,
        t1 in 0u64..100_000,
        t2 in 0u64..100_000,
        extended in any::<bool>(),
    ) {
        let session = if extended { MarketSession::Extended } else { MarketSession::Regular };
        let windows = [SessionWindow { start: 0, end, session }];
        let mut policy = SessionPolicy {
            extended_margin_mult_bps: 15_000,
            closed_margin_mult_bps: 20_000,
            closed_band_base_bps: 200,
            closed_band_per_hour_bps: 25,
            closed_band_max_bps: 1_500,
            closed_oi_cap_bps: 5_000,
            close_ramp_secs: ramp,
            close_grace_secs: 0,
        };
        policy.close_ramp_secs = ramp;
        let (a, b) = (t1.min(t2).min(end - 1), t1.max(t2).min(end - 1));
        let ma = session_mult_bps_at(&windows, a, session, &policy).unwrap();
        let mb = session_mult_bps_at(&windows, b, session, &policy).unwrap();
        let from = session_mult_bps(session, &policy);
        prop_assert!(ma <= mb);
        prop_assert!(from <= ma && mb <= 20_000);
    }
}
