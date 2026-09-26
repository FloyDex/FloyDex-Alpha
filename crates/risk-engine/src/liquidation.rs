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
    let position_notional = notional(position.size, market.oracle_price)?;
    let max_partial_size =
        protocol_core::mul_div(position.size, partial_liquidation_bps as i128, 10_000)?;
    let min_size_to_cover = protocol_core::mul_div(position.size, shortfall, position_notional)?;
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
    use protocol_core::{CollateralBalance, MarginMode, PRECISION};

    #[test]
    fn partial_liquidation_does_not_over_liquidate() {
        // 10 collateral, 10 BTC long at 100, price 94:
        //   equity = 10 + (94-100)*10 = -50, maintenance = 47, shortfall = 97
        //   min_size_to_cover = 10 * 97 / 940 ≈ 1.03 BTC, 50% cap = 5 BTC
        //   → close ~1.03 BTC, never the full 5 BTC cap (audit finding H5).
        let collateral = [CollateralBalance {
            asset: TOKEN,
            amount: 10 * PRECISION,
            value: 10 * PRECISION,
            haircut_bps: 0,
        }];
        let positions = [Position {
            position_id: 42,
            owner: USER,
            market_id: 1,
            size: 10 * PRECISION,
            entry_price: 100 * PRECISION,
            margin: 0,
            is_long: true,
            last_funding_index: 0,
            mode: MarginMode::Cross,
        }];
        let account = AccountSnapshot {
            owner: USER,
            collateral: &collateral,
            positions: &positions,
        };
        let markets = [make_market(1, 94 * PRECISION)];

        let health = account_health(&account, &markets).unwrap();
        assert!(
            health.liquidatable,
            "account should be liquidatable at price=94"
        );
        let shortfall = checked_sub(health.maintenance_margin_required, health.equity).unwrap();
        assert!(shortfall > 0, "shortfall should be positive");

        let plan = plan_liquidation(&account, &markets, 42, 5_000).unwrap();
        assert_eq!(plan.mode, LiquidationMode::Partial);
        assert!(
            plan.close_size < 5 * PRECISION,
            "should not over-liquidate to 50%"
        );
        let expected_min =
            protocol_core::mul_div(10 * PRECISION, shortfall, 94 * 10 * PRECISION).unwrap();
        assert_eq!(plan.close_size, expected_min);
    }
}
