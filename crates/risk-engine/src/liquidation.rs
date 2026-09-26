use crate::margin::{account_health, AccountHealth};
use protocol_core::{
    apply_bps, checked_sub, notional, AccountSnapshot, CoreError, MarketLookup, Position,
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LiquidationMode {
    None,
    Partial,
    Full,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct LiquidationPlan {
    pub mode: LiquidationMode,
    pub position_id: u64,
    pub close_size: i128,
    pub penalty: i128,
    pub expected_health: AccountHealth,
}

pub fn plan_liquidation<M: MarketLookup + ?Sized>(
    account: &AccountSnapshot,
    markets: &M,
    target_position_id: u64,
    partial_liquidation_bps: u32,
) -> Result<LiquidationPlan, CoreError> {
    let health = account_health(account, markets)?;
    if !health.liquidatable {
        return Err(CoreError::NotLiquidatable);
    }
    if partial_liquidation_bps == 0 || partial_liquidation_bps > 10_000 {
        return Err(CoreError::InvalidConfig);
    }

    let position = find_position(account, target_position_id)?;
    let market = markets
        .market(position.market_id)
        .ok_or(CoreError::InvalidConfig)?;

    let shortfall = checked_sub(health.maintenance_margin_required, health.equity)?;
    let max_partial_size =
        protocol_core::mul_div(position.size, partial_liquidation_bps as i128, 10_000)?;
    let min_size_to_cover = min_size_to_restore(
        shortfall,
        market.oracle_price,
        market.config.maintenance_margin_bps,
        market.config.liquidation_fee_bps,
        position.size,
    )?;
    let close_size = if min_size_to_cover >= position.size {
        // Position must be fully liquidated
        position.size
    } else if min_size_to_cover <= max_partial_size {
        // Liquidating the minimum needed is enough AND within the per-step cap
        min_size_to_cover
    } else {
        // Need more than one step; do the maximum allowed per step
        max_partial_size
    };
    let mode = if close_size >= position.size {
        LiquidationMode::Full
    } else {
        LiquidationMode::Partial
    };
    let penalty = apply_bps(
        notional(close_size, market.oracle_price)?,
        market.config.liquidation_fee_bps,
    )?;

    Ok(LiquidationPlan {
        mode,
        position_id: target_position_id,
        close_size,
        penalty,
        expected_health: health,
    })
}

/// The smallest size whose close at `price` removes `shortfall`.
///
/// Closing at the mark leaves equity unchanged except for the penalty, and
/// releases `maintenance_bps` of the closed notional, so each unit closed
/// removes `price · (maintenance_bps − fee_bps) / 10_000` of shortfall
/// (decided 2026-09-26). The Stellar port closed notional equal to the
/// shortfall instead, which removes only `(mm − fee)` of it per step, about
/// a tenth: liquidations crawled geometrically and a bankrupt account never
/// closed. Rounds up; returns `position_size` (a full close) when the
/// penalty eats the whole release or the slice would exceed the position.
fn min_size_to_restore(
    shortfall: i128,
    price: i128,
    maintenance_bps: u32,
    fee_bps: u32,
    position_size: i128,
) -> Result<i128, CoreError> {
    if maintenance_bps <= fee_bps {
        return Ok(position_size);
    }
    let per_unit = protocol_core::mul_div(price, (maintenance_bps - fee_bps) as i128, 10_000)?;
    if per_unit <= 0 {
        return Ok(position_size);
    }
    let size = protocol_core::mul_div_ceil(shortfall, protocol_core::PRECISION, per_unit)?;
    Ok(core::cmp::min(size, position_size))
}

fn find_position(account: &AccountSnapshot, position_id: u64) -> Result<Position, CoreError> {
    account
        .positions
        .iter()
        .find(|p| p.position_id == position_id)
        .copied()
        .ok_or(CoreError::InvalidConfig)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::margin::test_support::*;
    use protocol_core::{CollateralBalance, MarginMode, MarketSnapshot, PRECISION};

    fn btc_long(collateral_amount: i128) -> ([CollateralBalance; 1], [Position; 1]) {
        (
            [CollateralBalance {
                asset: TOKEN,
                amount: collateral_amount,
                value: collateral_amount,
                haircut_bps: 0,
            }],
            [Position {
                position_id: 42,
                owner: USER,
                market_id: 1,
                size: 10 * PRECISION,
                entry_price: 100 * PRECISION,
                margin: 0,
                is_long: true,
                last_funding_index: 0,
                mode: MarginMode::Cross,
            }],
        )
    }

    /// Health after closing `size` of the position at the mark and paying
    /// the plan's penalty.
    fn health_after(
        collateral: &[CollateralBalance; 1],
        positions: &[Position; 1],
        markets: &[MarketSnapshot; 1],
        plan: &LiquidationPlan,
    ) -> AccountHealth {
        let price = markets[0].oracle_price;
        let mut p = positions[0];
        let realized =
            protocol_core::mul_precision(plan.close_size, price - p.entry_price).unwrap();
        p.size -= plan.close_size;
        let mut c = collateral[0];
        c.amount += realized - plan.penalty;
        c.value = c.amount;
        let cs = [c];
        let ps = [p];
        let account = AccountSnapshot {
            owner: USER,
            collateral: &cs,
            positions: if p.size > 0 { &ps } else { &[] },
        };
        account_health(&account, markets).unwrap()
    }

    #[test]
    fn partial_liquidation_does_not_over_liquidate() {
        // 100 collateral, 10 BTC long at 100, price 94:
        //   equity = 100 − 60 = 40, maintenance 5% of 940 = 47, shortfall 7.
        //   Each BTC closed releases 94 · (5% − 0.5%) = 4.23 → close ⌈7/4.23⌉
        //   ≈ 1.655 BTC: under the 50% cap (never the cap itself, audit H5),
        //   and exactly enough to restore maintenance.
        let (collateral, positions) = btc_long(100 * PRECISION);
        let account = AccountSnapshot {
            owner: USER,
            collateral: &collateral,
            positions: &positions,
        };
        let markets = [make_market(1, 94 * PRECISION)];
        let health = account_health(&account, &markets).unwrap();
        assert!(health.liquidatable);
        assert_eq!(health.equity, 40 * PRECISION);

        let plan = plan_liquidation(&account, &markets, 42, 5_000).unwrap();
        assert_eq!(plan.mode, LiquidationMode::Partial);
        let per_unit = 94 * PRECISION * 450 / 10_000;
        let expected = protocol_core::mul_div_ceil(7 * PRECISION, PRECISION, per_unit).unwrap();
        assert_eq!(plan.close_size, expected);
        assert!(plan.close_size < 5 * PRECISION);

        let after = health_after(&collateral, &positions, &markets, &plan);
        assert!(!after.liquidatable, "one step restores maintenance");
        assert!(
            after.equity - after.maintenance_margin_required < PRECISION / 1_000_000,
            "and no more than that"
        );
    }

    #[test]
    fn the_per_step_cap_still_binds() {
        let (collateral, positions) = btc_long(100 * PRECISION);
        let account = AccountSnapshot {
            owner: USER,
            collateral: &collateral,
            positions: &positions,
        };
        let markets = [make_market(1, 94 * PRECISION)];
        let plan = plan_liquidation(&account, &markets, 42, 1_000).unwrap();
        assert_eq!(plan.close_size, PRECISION, "10% of 10 BTC");
        assert_eq!(plan.mode, LiquidationMode::Partial);
    }

    #[test]
    fn a_bankrupt_account_is_closed_in_full() {
        // 10 collateral: equity −50 at 94. No partial close can restore it.
        let (collateral, positions) = btc_long(10 * PRECISION);
        let account = AccountSnapshot {
            owner: USER,
            collateral: &collateral,
            positions: &positions,
        };
        let markets = [make_market(1, 94 * PRECISION)];
        let plan = plan_liquidation(&account, &markets, 42, 5_000).unwrap();
        assert_eq!(plan.mode, LiquidationMode::Full);
        assert_eq!(plan.close_size, 10 * PRECISION);
    }

    #[test]
    fn a_penalty_at_or_above_maintenance_closes_in_full() {
        let (collateral, positions) = btc_long(100 * PRECISION);
        let account = AccountSnapshot {
            owner: USER,
            collateral: &collateral,
            positions: &positions,
        };
        let mut m = make_market(1, 94 * PRECISION);
        m.config.liquidation_fee_bps = m.config.maintenance_margin_bps;
        let plan = plan_liquidation(&account, &[m], 42, 5_000).unwrap();
        assert_eq!(plan.close_size, 10 * PRECISION);
    }
}
