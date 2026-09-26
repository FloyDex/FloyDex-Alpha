//! Session-aware risk for equity perps.
//!
//! Crypto perps assume a price that never sleeps. A TSLA perp does not have
//! one: the underlying trades ~6.5h a day in the regular session, thinly in
//! extended hours, and not at all on weekends and holidays. A perp that keeps
//! trading 24/7 must answer three questions the crypto engine never asked:
//!
//! 1. **What session are we in?** Decided by a keeper-posted calendar of
//!    windows, NOT by oracle staleness alone — a stale oracle during a
//!    scheduled open session is an outage and must halt, not "go weekend".
//! 2. **What is the mark while the reference is closed?** The book's own mid,
//!    clamped to a band around the last trusted oracle price that widens with
//!    time since the close.
//! 3. **How much leverage is safe across a gap?** Margin requirements scale up
//!    outside the regular session, so a Monday-open gap is absorbed by margin
//!    rather than by the insurance fund.

use protocol_core::{apply_bps, checked_add, checked_sub, mul_div, CoreError};

/// Trading session of the underlying asset.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MarketSession {
    /// Primary exchange open; oracle is authoritative.
    Regular,
    /// Pre-market / post-market / overnight venues; oracle is live but thin.
    Extended,
    /// No reference market. Mark comes from the book, clamped to a band.
    Closed,
    /// Scheduled open but the oracle is stale — an outage. Reduce-only.
    Halted,
}

/// One calendar window `[start, end)` in unix seconds. The keeper posts the
/// upcoming week's windows (DST and exchange holidays included) so the
/// program never has to encode a timezone database.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SessionWindow {
    pub start: u64,
    pub end: u64,
    pub session: MarketSession,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SessionPolicy {
    /// Margin multiplier in bps applied in extended hours (10_000 = 1x).
    pub extended_margin_mult_bps: u32,
    /// Margin multiplier in bps applied while closed (e.g. 20_000 = 2x).
    pub closed_margin_mult_bps: u32,
    /// Band around the last oracle price the closed-session mark may move in,
    /// at the moment of close.
    pub closed_band_base_bps: u32,
    /// How much the band widens per hour closed.
    pub closed_band_per_hour_bps: u32,
    /// Hard ceiling on the band.
    pub closed_band_max_bps: u32,
    /// Share of `max_open_interest` that may be open while closed.
    pub closed_oi_cap_bps: u32,
}

/// Resolve the session at `now`. Anything outside every posted window is
/// `Closed` — the fail-safe default when the keeper has not posted a calendar.
/// A scheduled Regular/Extended window with a stale oracle becomes `Halted`.
pub fn resolve_session(
    windows: &[SessionWindow],
    now: u64,
    oracle_publish_time: u64,
    max_oracle_age_secs: u64,
) -> MarketSession {
    let scheduled = windows
        .iter()
        .find(|w| w.start <= now && now < w.end)
        .map(|w| w.session)
        .unwrap_or(MarketSession::Closed);
    match scheduled {
        MarketSession::Regular | MarketSession::Extended => {
            let fresh =
                oracle_publish_time <= now && now - oracle_publish_time <= max_oracle_age_secs;
            if fresh {
                scheduled
            } else {
                MarketSession::Halted
            }
        }
        other => other,
    }
}

/// Scale a base margin requirement (bps of notional) for the session,
/// capped at 100%.
pub fn session_margin_bps(
    base_bps: u32,
    session: MarketSession,
    policy: &SessionPolicy,
) -> Result<u32, CoreError> {
    let mult = match session {
        MarketSession::Regular => return Ok(base_bps),
        MarketSession::Extended => policy.extended_margin_mult_bps,
        MarketSession::Closed | MarketSession::Halted => policy.closed_margin_mult_bps,
    };
    if mult < 10_000 {
        return Err(CoreError::InvalidConfig);
    }
    let scaled = mul_div(base_bps as i128, mult as i128, 10_000)?;
    Ok(core::cmp::min(scaled, 10_000) as u32)
}

/// Band (bps) the closed-session mark may deviate from the last oracle price
/// after `secs_closed` seconds.
pub fn closed_band_bps(secs_closed: u64, policy: &SessionPolicy) -> u32 {
    let hours = secs_closed / 3_600;
    let widened = (policy.closed_band_base_bps as u64)
        .saturating_add(hours.saturating_mul(policy.closed_band_per_hour_bps as u64));
    core::cmp::min(widened, policy.closed_band_max_bps as u64) as u32
}

/// Mark price while the reference market is closed: the book mid (the
/// caller supplies an EMA, never a single print), clamped into the band
/// around the last trusted oracle price.
pub fn closed_mark_price(
    last_oracle_price: i128,
    book_mid_ema: i128,
    secs_closed: u64,
    policy: &SessionPolicy,
) -> Result<i128, CoreError> {
    if last_oracle_price <= 0 || book_mid_ema <= 0 {
        return Err(CoreError::InvalidPrice);
    }
    let band = apply_bps(last_oracle_price, closed_band_bps(secs_closed, policy))?;
    let lo = checked_sub(last_oracle_price, band)?;
    let hi = checked_add(last_oracle_price, band)?;
    Ok(book_mid_ema.clamp(lo, hi))
}

/// Whether a fill may open or increase exposure in this session. `Halted`
/// is reduce-only; `Closed` is capped at a share of max open interest.
pub fn may_increase_exposure(
    session: MarketSession,
    open_interest_after: i128,
    max_open_interest: i128,
    policy: &SessionPolicy,
) -> Result<bool, CoreError> {
    match session {
        MarketSession::Regular | MarketSession::Extended => {
            Ok(open_interest_after <= max_open_interest)
        }
        MarketSession::Closed => {
            let cap = apply_bps(max_open_interest, policy.closed_oi_cap_bps)?;
            Ok(open_interest_after <= cap)
        }
        MarketSession::Halted => Ok(false),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use protocol_core::PRECISION;

    fn policy() -> SessionPolicy {
        SessionPolicy {
            extended_margin_mult_bps: 15_000,
            closed_margin_mult_bps: 20_000,
            closed_band_base_bps: 200,
            closed_band_per_hour_bps: 25,
            closed_band_max_bps: 1_500,
            closed_oi_cap_bps: 5_000,
        }
    }

    const WINDOWS: [SessionWindow; 2] = [
        SessionWindow {
            start: 1_000,
            end: 2_000,
            session: MarketSession::Extended,
        },
        SessionWindow {
            start: 2_000,
            end: 5_000,
            session: MarketSession::Regular,
        },
    ];

    #[test]
    fn outside_every_window_is_closed() {
        assert_eq!(
            resolve_session(&WINDOWS, 9_000, 9_000, 60),
            MarketSession::Closed
        );
        assert_eq!(
            resolve_session(&[], 3_000, 3_000, 60),
            MarketSession::Closed
        );
    }

    #[test]
    fn stale_oracle_in_scheduled_session_halts_rather_than_closes() {
        assert_eq!(
            resolve_session(&WINDOWS, 3_000, 2_990, 60),
            MarketSession::Regular
        );
        assert_eq!(
            resolve_session(&WINDOWS, 3_000, 2_000, 60),
            MarketSession::Halted
        );
        assert_eq!(
            resolve_session(&WINDOWS, 1_500, 1_500, 60),
            MarketSession::Extended
        );
    }

    #[test]
    fn margin_scales_by_session_and_caps_at_full_collateral() {
        let p = policy();
        assert_eq!(
            session_margin_bps(1_000, MarketSession::Regular, &p).unwrap(),
            1_000
        );
        assert_eq!(
            session_margin_bps(1_000, MarketSession::Extended, &p).unwrap(),
            1_500
        );
        assert_eq!(
            session_margin_bps(1_000, MarketSession::Closed, &p).unwrap(),
            2_000
        );
        assert_eq!(
            session_margin_bps(8_000, MarketSession::Closed, &p).unwrap(),
            10_000
        );
    }

    #[test]
    fn a_multiplier_below_one_is_rejected() {
        let mut p = policy();
        p.closed_margin_mult_bps = 5_000;
        assert!(session_margin_bps(1_000, MarketSession::Closed, &p).is_err());
    }

    #[test]
    fn closed_band_widens_with_time_up_to_the_ceiling() {
        let p = policy();
        assert_eq!(closed_band_bps(0, &p), 200);
        assert_eq!(closed_band_bps(10 * 3_600, &p), 450);
        assert_eq!(closed_band_bps(65 * 3_600, &p), 1_500); // a full weekend
    }

    #[test]
    fn closed_mark_follows_the_book_inside_the_band_and_clamps_outside() {
        let p = policy();
        let last = 250 * PRECISION;
        // 1% above close, inside a 2% band: book wins.
        assert_eq!(
            closed_mark_price(last, 2525 * PRECISION / 10, 0, &p).unwrap(),
            2525 * PRECISION / 10
        );
        // 10% above close right after the bell: clamped to +2%.
        assert_eq!(
            closed_mark_price(last, 275 * PRECISION, 0, &p).unwrap(),
            255 * PRECISION
        );
        // Same book 40h later: band is 2% + 40*0.25% = 12%, so the book wins.
        assert_eq!(
            closed_mark_price(last, 275 * PRECISION, 40 * 3_600, &p).unwrap(),
            275 * PRECISION
        );
    }

    #[test]
    fn halted_is_reduce_only_and_closed_is_capped() {
        let p = policy();
        let max = 1_000 * PRECISION;
        assert!(!may_increase_exposure(MarketSession::Halted, 1, max, &p).unwrap());
        assert!(may_increase_exposure(MarketSession::Closed, 500 * PRECISION, max, &p).unwrap());
        assert!(!may_increase_exposure(MarketSession::Closed, 501 * PRECISION, max, &p).unwrap());
        assert!(may_increase_exposure(MarketSession::Regular, max, max, &p).unwrap());
    }
}
