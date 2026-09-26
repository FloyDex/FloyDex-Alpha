use super::pod::PodI128;
use crate::constants::CALENDAR_LEN;
use anchor_lang::prelude::*;
use protocol_core::{MarketConfig, MarketSnapshot};
use risk_engine::{FundingConfig, FundingState, MarketSession, SessionPolicy, SessionWindow};

pub const SESSION_REGULAR: u8 = 0;
pub const SESSION_EXTENDED: u8 = 1;
pub const SESSION_CLOSED: u8 = 2;
pub const SESSION_HALTED: u8 = 3;

pub fn session_from_u8(v: u8) -> Option<MarketSession> {
    match v {
        SESSION_REGULAR => Some(MarketSession::Regular),
        SESSION_EXTENDED => Some(MarketSession::Extended),
        SESSION_CLOSED => Some(MarketSession::Closed),
        SESSION_HALTED => Some(MarketSession::Halted),
        _ => None,
    }
}

/// `[start, end)` in unix seconds. An empty slot has `end == 0`.
#[zero_copy]
#[derive(Default, Debug, PartialEq, Eq)]
pub struct SessionWindowPod {
    pub start: u64,
    pub end: u64,
    pub session: u8,
    pub _pad: [u8; 7],
}

#[zero_copy]
#[derive(Default, Debug, PartialEq, Eq)]
pub struct SessionPolicyPod {
    pub extended_margin_mult_bps: u32,
    pub closed_margin_mult_bps: u32,
    pub closed_band_base_bps: u32,
    pub closed_band_per_hour_bps: u32,
    pub closed_band_max_bps: u32,
    pub closed_oi_cap_bps: u32,
}

impl From<SessionPolicyPod> for SessionPolicy {
    fn from(p: SessionPolicyPod) -> Self {
        SessionPolicy {
            extended_margin_mult_bps: p.extended_margin_mult_bps,
            closed_margin_mult_bps: p.closed_margin_mult_bps,
            closed_band_base_bps: p.closed_band_base_bps,
            closed_band_per_hour_bps: p.closed_band_per_hour_bps,
            closed_band_max_bps: p.closed_band_max_bps,
            closed_oi_cap_bps: p.closed_oi_cap_bps,
        }
    }
}

/// One perp market. PDA `["market", market_id u16 LE]`. Zero-copy.
#[account(zero_copy)]
#[derive(Debug)]
pub struct Market {
    // --- MarketConfig ---
    pub max_oracle_age_secs: u64,
    pub max_open_interest: PodI128,
    pub base_asset: [u8; 16],
    pub market_id: u16,
    /// Pyth push-feed shard: 0 = Pyth-sponsored feeds, else our own (`06` §8).
    pub pyth_shard_id: u16,
    pub max_leverage_bps: u32,
    pub initial_margin_bps: u32,
    pub maintenance_margin_bps: u32,
    pub liquidation_fee_bps: u32,
    pub max_oracle_confidence_bps: u32,
    pub oi_policy_bps: u32,
    pub max_execution_deviation_bps: u32,
    pub active: u8,
    pub bump: u8,
    /// Last session observed by `settle_fills`, as `SESSION_* + 1` (0 = none).
    pub last_session: u8,
    pub _pad0: [u8; 5],
    pub pyth_feed_id: [u8; 32],
    pub session_policy: SessionPolicyPod,
    pub calendar: [SessionWindowPod; CALENDAR_LEN],
    // --- funding ---
    pub funding_imbalance_coeff: PodI128,
    pub funding_max_rate_per_hour: PodI128,
    pub funding_long_index: PodI128,
    pub funding_short_index: PodI128,
    pub funding_rate_per_hour: PodI128,
    pub funding_last_update: u64,
    // --- open interest ---
    pub oi_long: PodI128,
    pub oi_short: PodI128,
    // --- oracle / mark ---
    pub last_oracle_price: PodI128,
    pub last_oracle_publish_time: u64,
    /// When the market last entered Closed (0 = not closed).
    pub closed_since: u64,
    pub mark_ema: PodI128,
    pub mark_ema_updated: u64,
    pub _reserved: [u8; 128],
}

impl Market {
    pub fn config(&self) -> MarketConfig {
        MarketConfig {
            market_id: u32::from(self.market_id),
            base_asset: self.base_asset,
            settlement_asset: [0; 32],
            max_leverage_bps: self.max_leverage_bps,
            initial_margin_bps: self.initial_margin_bps,
            maintenance_margin_bps: self.maintenance_margin_bps,
            liquidation_fee_bps: self.liquidation_fee_bps,
            max_open_interest: self.max_open_interest.get(),
            max_oracle_age_secs: self.max_oracle_age_secs,
            max_oracle_confidence_bps: self.max_oracle_confidence_bps,
            active: self.active != 0,
        }
    }

    /// Snapshot for `risk-engine`, at `price`, with the margin requirements
    /// replaced by their session-scaled values.
    pub fn snapshot(&self, price: i128, initial_bps: u32, maintenance_bps: u32) -> MarketSnapshot {
        let mut config = self.config();
        config.initial_margin_bps = initial_bps;
        config.maintenance_margin_bps = maintenance_bps;
        MarketSnapshot {
            config,
            oracle_price: price,
            funding_index_long: self.funding_long_index.get(),
            funding_index_short: self.funding_short_index.get(),
        }
    }

    pub fn session_policy(&self) -> SessionPolicy {
        self.session_policy.into()
    }

    /// Posted windows as `risk-engine` values (empty slots skipped).
    pub fn windows(&self, out: &mut [SessionWindow; CALENDAR_LEN]) -> usize {
        let mut n = 0;
        for w in self.calendar.iter() {
            if w.end == 0 {
                continue;
            }
            if let Some(session) = session_from_u8(w.session) {
                out[n] = SessionWindow {
                    start: w.start,
                    end: w.end,
                    session,
                };
                n += 1;
            }
        }
        n
    }

    pub fn funding_config(&self) -> FundingConfig {
        FundingConfig {
            imbalance_coeff: self.funding_imbalance_coeff.get(),
            max_rate_per_hour: self.funding_max_rate_per_hour.get(),
        }
    }

    pub fn funding_state(&self) -> FundingState {
        FundingState {
            long_index: self.funding_long_index.get(),
            short_index: self.funding_short_index.get(),
            rate_per_hour: self.funding_rate_per_hour.get(),
            last_update: self.funding_last_update,
        }
    }

    pub fn funding_index(&self, is_long: bool) -> i128 {
        if is_long {
            self.funding_long_index.get()
        } else {
            self.funding_short_index.get()
        }
    }
}
