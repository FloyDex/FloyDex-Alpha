use protocol_core::{
    add_signed, apply_bps, checked_add, checked_sub, collateral_value_after_haircut, funding_pnl,
    notional, signed_position_pnl, AccountSnapshot, CoreError, MarginMode, MarketLookup, PRECISION,
};

/// Positions an account may carry through one health computation. Mirrors the
/// fixed `pnl_buf` of the Soroban version; on Solana the user account's
/// position array must never be larger than this.
pub const MAX_POSITIONS_PER_ACCOUNT: usize = 64;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct AccountHealth {
    pub collateral_value: i128,
    pub unrealized_pnl: i128,
    pub equity: i128,
    pub initial_margin_required: i128,
    pub maintenance_margin_required: i128,
    pub free_collateral: i128,
    pub margin_ratio: i128,
    pub liquidatable: bool,
}

pub fn account_health<M: MarketLookup + ?Sized>(
    account: &AccountSnapshot,
    markets: &M,
) -> Result<AccountHealth, CoreError> {
    let mut total_collateral_value = 0i128;
    for c in account.collateral.iter() {
        total_collateral_value = checked_add(
            total_collateral_value,
            collateral_value_after_haircut(c.value, c.haircut_bps)?,
        )?;
    }

    // First pass: collect per-position pnl and margin info
    let mut pnl_buf = [0i128; MAX_POSITIONS_PER_ACCOUNT];
    let mut pnl_count = 0usize;
    let mut initial = 0i128;
    let mut maintenance = 0i128;
    let mut locked_isolated_margin = 0i128;
    let mut any_isolated_liquidatable = false;

    for p in account.positions.iter() {
        if pnl_count >= pnl_buf.len() {
            return Err(CoreError::InvalidConfig);
        }
        let market = markets
            .market(p.market_id)
            .ok_or(CoreError::InvalidConfig)?;
        if !market.config.active {
            return Err(CoreError::InvalidConfig);
        }
        let current_funding = if p.is_long {
            market.funding_index_long
        } else {
            market.funding_index_short
        };
        let trade_pnl = signed_position_pnl(p, market.oracle_price)?;
        let f_pnl = funding_pnl(p, current_funding)?;
        let upnl = checked_add(trade_pnl, f_pnl)?;
        pnl_buf[pnl_count] = upnl;
        pnl_count += 1;

        let n = notional(p.size, market.oracle_price)?;
        initial = checked_add(initial, apply_bps(n, market.config.initial_margin_bps)?)?;
        maintenance = checked_add(
            maintenance,
            apply_bps(n, market.config.maintenance_margin_bps)?,
        )?;

        if p.mode == MarginMode::Isolated {
            locked_isolated_margin = checked_add(locked_isolated_margin, p.margin)?;
            // Isolated position is liquidatable when its own equity < its own maintenance margin
            let iso_maintenance = apply_bps(n, market.config.maintenance_margin_bps)?;
            let iso_equity = checked_add(p.margin, upnl)?;
            if iso_maintenance > 0 && iso_equity < iso_maintenance {
                any_isolated_liquidatable = true;
            }
        }
    }

    // Cross collateral = total collateral minus margin locked in isolated positions.
    // May be negative when cross losses have depleted the balance — that is the
    // underwater signal; do NOT clamp to 0 or the equity check won't fire.
    let cross_collateral = checked_sub(total_collateral_value, locked_isolated_margin)?;

    // Second pass: split unrealised pnl into its cross and isolated halves. The
    // split drives the per-mode liquidation triggers below; it does NOT change
    // total equity.
    //
    // KRY-Q5: isolated losses are NOT floored at the locked margin here. The
    // Stellar vault had a single settlement balance with no isolated bucket, so
    // an isolated loss beyond its margin consumed cross collateral the moment it
    // realised. Counting the loss in full makes equity match the balance that
    // actually backs it, and can only make an account look worse, never better.
    // Revisit only once the Solana vault carries a real per-position margin
    // ledger (see docs/prd/05-program-design-anchor.md).
    let mut isolated_equity = 0i128;
    let mut cross_unrealized = 0i128;
    for (idx, p) in account.positions.iter().enumerate() {
        let upnl = pnl_buf[idx];
        if p.mode == MarginMode::Isolated {
            isolated_equity = checked_add(isolated_equity, checked_add(p.margin, upnl)?)?;
        } else {
            cross_unrealized = checked_add(cross_unrealized, upnl)?;
        }
    }

    let unrealized_pnl = add_signed(&pnl_buf[..pnl_count])?;

    // Total equity = free cross collateral + cross unrealised pnl + isolated
    // equity. This reduces exactly to `total_collateral_value + unrealized_pnl`.
    let equity = checked_add(
        checked_add(cross_collateral, cross_unrealized)?,
        isolated_equity,
    )?;
    let free_collateral = checked_sub(equity, initial)?;
    let margin_ratio = if maintenance > 0 {
        protocol_core::div_precision(equity, maintenance)?
    } else {
        i128::MAX
    };

    // Cross positions are liquidatable when cross equity < cross maintenance requirement
    let mut cross_maintenance = 0i128;
    for p in account.positions.iter() {
        if p.mode == MarginMode::Cross {
            let market = markets
                .market(p.market_id)
                .ok_or(CoreError::InvalidConfig)?;
            let n = notional(p.size, market.oracle_price)?;
            cross_maintenance = checked_add(
                cross_maintenance,
                apply_bps(n, market.config.maintenance_margin_bps)?,
            )?;
        }
    }
    let cross_equity = checked_add(cross_collateral, cross_unrealized)?;
    let cross_liquidatable = cross_maintenance > 0 && cross_equity < cross_maintenance;
    let liquidatable = cross_liquidatable || any_isolated_liquidatable;

    Ok(AccountHealth {
        collateral_value: total_collateral_value,
        unrealized_pnl,
        equity,
        initial_margin_required: initial,
        maintenance_margin_required: maintenance,
        free_collateral,
        margin_ratio,
        liquidatable,
    })
}

pub fn validate_withdrawal<M: MarketLookup + ?Sized>(
    account: &AccountSnapshot,
    markets: &M,
    withdrawal_value: i128,
) -> Result<AccountHealth, CoreError> {
    if withdrawal_value < 0 {
        return Err(CoreError::InvalidAmount);
    }
    let mut health = account_health(account, markets)?;
    health.collateral_value = checked_sub(health.collateral_value, withdrawal_value)?;
    health.equity = checked_sub(health.equity, withdrawal_value)?;
    health.free_collateral = checked_sub(health.equity, health.initial_margin_required)?;
    health.margin_ratio = if health.maintenance_margin_required > 0 {
        protocol_core::div_precision(health.equity, health.maintenance_margin_required)?
    } else {
        i128::MAX
    };
    health.liquidatable = health.maintenance_margin_required > 0
        && health.equity < health.maintenance_margin_required;
    if health.equity < health.initial_margin_required {
        return Err(CoreError::InsufficientCollateral);
    }
    Ok(health)
}

pub fn max_leverage_bps(initial_margin_bps: u32) -> Result<i128, CoreError> {
    if initial_margin_bps == 0 {
        return Err(CoreError::InvalidConfig);
    }
    protocol_core::mul_div(10_000, PRECISION, initial_margin_bps as i128)
}

#[cfg(test)]
pub(crate) mod test_support {
    use protocol_core::{asset_code, MarketConfig, MarketSnapshot, PRECISION};

    pub const USER: [u8; 32] = [1u8; 32];
    pub const TOKEN: [u8; 32] = [2u8; 32];

    pub fn make_market(market_id: u32, oracle_price: i128) -> MarketSnapshot {
        MarketSnapshot {
            config: MarketConfig {
                market_id,
                base_asset: asset_code("BTC"),
                settlement_asset: TOKEN,
                max_leverage_bps: 100_000,
                initial_margin_bps: 1_000,
                maintenance_margin_bps: 500,
                liquidation_fee_bps: 50,
                max_open_interest: 10_000 * PRECISION,
                max_oracle_age_secs: 10,
                max_oracle_confidence_bps: 50,
                active: true,
            },
            oracle_price,
            funding_index_long: 0,
            funding_index_short: 0,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::*;
    use super::*;
    use protocol_core::{CollateralBalance, MarginMode, Position, PRECISION};

    fn collateral(amount: i128) -> [CollateralBalance; 1] {
        [CollateralBalance {
            asset: TOKEN,
            amount,
            value: amount,
            haircut_bps: 0,
        }]
    }

    fn position(id: u64, market_id: u32, size: i128, margin: i128, mode: MarginMode) -> Position {
        Position {
            position_id: id,
            owner: USER,
            market_id,
            size,
            entry_price: 100 * PRECISION,
            margin,
            is_long: true,
            last_funding_index: 0,
            mode,
        }
    }

    #[test]
    fn withdrawal_uses_unrealized_loss_not_locked_margin() {
        let collateral = collateral(1_000 * PRECISION);
        let positions = [position(
            1,
            1,
            10 * PRECISION,
            100 * PRECISION,
            MarginMode::Cross,
        )];
        let account = AccountSnapshot {
            owner: USER,
            collateral: &collateral,
            positions: &positions,
        };
        let markets = [make_market(1, 10 * PRECISION)];
        let health = account_health(&account, &markets).unwrap();
        assert_eq!(health.unrealized_pnl, -900 * PRECISION);
        assert!(validate_withdrawal(&account, &markets, 900 * PRECISION).is_err());
    }

    #[test]
    fn isolated_position_loss_counted_in_full() {
        // Isolated: margin 100, 10 BTC at 100, price drops to 1 → upnl = -990.
        let collateral = collateral(1_000 * PRECISION);
        let positions = [position(
            1,
            1,
            10 * PRECISION,
            100 * PRECISION,
            MarginMode::Isolated,
        )];
        let account = AccountSnapshot {
            owner: USER,
            collateral: &collateral,
            positions: &positions,
        };
        let markets = [make_market(1, PRECISION)];
        let health = account_health(&account, &markets).unwrap();
        assert_eq!(health.unrealized_pnl, -990 * PRECISION);
        // KRY-Q5: 1000 collateral - 990 loss = 10, not the floored 900.
        assert_eq!(health.equity, 10 * PRECISION);
        assert!(health.liquidatable);
    }

    #[test]
    fn isolated_does_not_contaminate_cross_health() {
        let collateral = collateral(2_000 * PRECISION);
        let positions = [
            position(1, 1, 10 * PRECISION, 100 * PRECISION, MarginMode::Isolated),
            position(2, 2, PRECISION, 0, MarginMode::Cross),
        ];
        let account = AccountSnapshot {
            owner: USER,
            collateral: &collateral,
            positions: &positions,
        };
        let markets = [make_market(1, PRECISION), make_market(2, 100 * PRECISION)];
        let health = account_health(&account, &markets).unwrap();
        assert!(health.liquidatable);
        assert!(
            !health.margin_ratio.is_negative(),
            "cross side is comfortably solvent",
        );
        assert_eq!(health.equity, 1_010 * PRECISION);
    }
}
