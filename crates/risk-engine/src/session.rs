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

use crate::funding::premium_from_mark;
use protocol_core::{
    apply_bps, checked_add, checked_sub, mul_div, mul_div_ceil, CoreError, BPS_DENOMINATOR,
    PRECISION,
};

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
    /// Seconds before a scheduled step up in margin (e.g. Regular → Closed at
    /// 16:00) over which the requirement ramps linearly (`07` §2). 0 = no ramp.
    pub close_ramp_secs: u32,
    /// Seconds after that step during which an account that added no exposure
    /// since the ramp began is not liquidated by the multiplier alone.
    pub close_grace_secs: u32,
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

/// Margin multiplier (bps, 10_000 = 1x) a session applies to base margin.
pub fn session_mult_bps(session: MarketSession, policy: &SessionPolicy) -> u32 {
    match session {
        MarketSession::Regular => BPS_DENOMINATOR as u32,
        MarketSession::Extended => policy.extended_margin_mult_bps,
        MarketSession::Closed | MarketSession::Halted => policy.closed_margin_mult_bps,
    }
}

/// The session scheduled right after a window that ends at `end`: a window
/// starting exactly there, else `Closed` (the fail-safe default).
fn session_after(windows: &[SessionWindow], end: u64) -> MarketSession {
    windows
        .iter()
        .find(|w| w.start == end && w.start < w.end)
        .map(|w| w.session)
        .unwrap_or(MarketSession::Closed)
}

/// A scheduled Regular/Extended window followed by a session with a higher
/// multiplier: the window, its multiplier and the multiplier it steps up to.
fn step_up(
    w: &SessionWindow,
    windows: &[SessionWindow],
    policy: &SessionPolicy,
) -> Option<(u32, u32)> {
    if !matches!(w.session, MarketSession::Regular | MarketSession::Extended) {
        return None;
    }
    let from = session_mult_bps(w.session, policy);
    let to = session_mult_bps(session_after(windows, w.end), policy);
    (to > from).then_some((from, to))
}

/// Margin multiplier at `now` in the resolved `session`, ramped linearly over
/// `close_ramp_secs` before a scheduled step up (`07` §2), so the requirement
/// does not jump from ×1 to ×2 on the bell. Rounds up. A `Halted` session is
/// not ramped: it already carries the closed multiplier.
pub fn session_mult_bps_at(
    windows: &[SessionWindow],
    now: u64,
    session: MarketSession,
    policy: &SessionPolicy,
) -> Result<u32, CoreError> {
    let base = session_mult_bps(session, policy);
    let ramp = u64::from(policy.close_ramp_secs);
    if ramp == 0 || !matches!(session, MarketSession::Regular | MarketSession::Extended) {
        return Ok(base);
    }
    let Some(w) = windows
        .iter()
        .find(|w| w.start <= now && now < w.end && w.session == session)
    else {
        return Ok(base);
    };
    let Some((from, to)) = step_up(w, windows, policy) else {
        return Ok(base);
    };
    let ramp_start = w.end.saturating_sub(ramp);
    if now < ramp_start {
        return Ok(from);
    }
    let step = mul_div_ceil(
        i128::from(to - from),
        i128::from(now - ramp_start),
        i128::from(ramp),
    )?;
    Ok(from + step as u32)
}

/// Base margin (bps of notional) scaled by [`session_mult_bps_at`], rounded
/// up and capped at 100%.
pub fn session_margin_bps_at(
    base_bps: u32,
    windows: &[SessionWindow],
    now: u64,
    session: MarketSession,
    policy: &SessionPolicy,
) -> Result<u32, CoreError> {
    scale_margin_bps(
        base_bps,
        session_mult_bps_at(windows, now, session, policy)?,
    )
}

/// `base_bps × mult_bps / 10_000`, rounded up and capped at 100%. A
/// multiplier below 1x is a misconfiguration.
pub fn scale_margin_bps(base_bps: u32, mult_bps: u32) -> Result<u32, CoreError> {
    if mult_bps < BPS_DENOMINATOR as u32 {
        return Err(CoreError::InvalidConfig);
    }
    let scaled = mul_div_ceil(i128::from(base_bps), i128::from(mult_bps), BPS_DENOMINATOR)?;
    Ok(core::cmp::min(scaled, BPS_DENOMINATOR) as u32)
}

/// The grace window around a scheduled step up: from the start of the ramp
/// until `close_grace_secs` after the step. Returns the pre-step multiplier
/// and when the ramp began. Liquidation uses that multiplier for maintenance
/// if the account added no exposure since the ramp began (`07` §2): such an
/// account cannot be liquidated by the multiplier alone, only by the price.
pub fn close_grace(
    windows: &[SessionWindow],
    now: u64,
    policy: &SessionPolicy,
) -> Option<(u32, u64)> {
    let ramp = u64::from(policy.close_ramp_secs);
    let grace = u64::from(policy.close_grace_secs);
    windows.iter().find_map(|w| {
        let (from, _) = step_up(w, windows, policy)?;
        let ramp_start = w.end.saturating_sub(ramp);
        (ramp_start <= now && now < w.end.saturating_add(grace)).then_some((from, ramp_start))
    })
}

/// Half-life of the book mark EMA (`07` §4: ~5 minutes).
pub const MARK_EMA_HALF_LIFE_SECS: u64 = 300;

/// `2^(-k/16)` at PRECISION, k = 0..=16.
const POW2_NEG_SIXTEENTHS: [i128; 17] = [
    1_000_000_000_000_000_000,
    957_603_280_698_573_647,
    917_004_043_204_671_232,
    878_126_080_186_649_742,
    840_896_415_253_714_543,
    805_245_165_974_627_154,
    771_105_412_703_970_412,
    738_413_072_969_749_656,
    707_106_781_186_547_524,
    677_127_773_468_446_364,
    648_419_777_325_504_833,
    620_928_906_036_742_024,
    594_603_557_501_360_533,
    569_394_317_378_345_827,
    545_253_866_332_628_830,
    522_136_891_213_706_920,
    500_000_000_000_000_000,
];

/// `2^(-elapsed / half_life)` at PRECISION: the weight an EMA keeps on its
/// old value after `elapsed` seconds. Exact at every 1/16 of a half-life and
/// linearly interpolated between (relative error < 3e-4); no floats.
pub fn decay_factor(elapsed: u64, half_life: u64) -> Result<i128, CoreError> {
    if half_life == 0 {
        return Err(CoreError::InvalidConfig);
    }
    let sixteenths = u128::from(elapsed) * 16;
    let half = u128::from(half_life);
    let steps = sixteenths / half; // whole 1/16 half-lives
    let rem = sixteenths % half;
    let halvings = steps / 16;
    if halvings >= 64 {
        return Ok(0);
    }
    let k = (steps % 16) as usize;
    let (hi, lo) = (POW2_NEG_SIXTEENTHS[k], POW2_NEG_SIXTEENTHS[k + 1]);
    let within = checked_sub(hi, mul_div(hi - lo, rem as i128, half as i128)?)?;
    Ok(within >> halvings)
}

/// Fold one price `sample` into a time-weighted EMA (`07` §4). The new value
/// moves toward the sample by `1 − decay(now − updated_at)`, so a burst of
/// fills in one second moves it no more than a single fill would, and never
/// by more than `max_step_bps` of the old value. An unset EMA (0) takes the
/// sample.
pub fn mark_ema_update(
    ema: i128,
    updated_at: u64,
    sample: i128,
    now: u64,
    half_life: u64,
    max_step_bps: u32,
) -> Result<i128, CoreError> {
    if sample <= 0 {
        return Err(CoreError::InvalidPrice);
    }
    if ema <= 0 {
        return Ok(sample);
    }
    let keep = decay_factor(now.saturating_sub(updated_at), half_life)?;
    let pull = mul_div(checked_sub(sample, ema)?, PRECISION - keep, PRECISION)?;
    let max = apply_bps(ema, max_step_bps)?;
    checked_add(ema, pull.clamp(-max, max))
}

/// Funding premium while closed (`07` §4): the clamped book mark against the
/// last regular close, so weekend longs pay when the book trades rich.
pub fn closed_premium(
    last_close: i128,
    book_mid_ema: i128,
    secs_closed: u64,
    policy: &SessionPolicy,
) -> Result<i128, CoreError> {
    let mark = closed_mark_price(last_close, book_mid_ema, secs_closed, policy)?;
    premium_from_mark(mark, last_close)
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
            close_ramp_secs: 3_600,
            close_grace_secs: 1_800,
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

    // --- margin ramp and grace (07 §2) ---

    /// Regular 09:30–16:00 then nothing posted (Closed), in seconds.
    const DAY: [SessionWindow; 1] = [SessionWindow {
        start: 0,
        end: 23_400,
        session: MarketSession::Regular,
    }];
    const CLOSE: u64 = 23_400;

    #[test]
    fn margin_ramps_linearly_over_the_hour_before_the_close() {
        let p = policy();
        let at = |t| session_mult_bps_at(&DAY, t, MarketSession::Regular, &p).unwrap();
        assert_eq!(at(0), 10_000);
        assert_eq!(at(CLOSE - 3_601), 10_000, "before the ramp");
        assert_eq!(at(CLOSE - 3_600), 10_000, "the ramp starts at ×1");
        assert_eq!(at(CLOSE - 1_800), 15_000, "halfway: ×1.5");
        assert_eq!(
            at(CLOSE - 1),
            19_998,
            "one second before the bell, rounded up"
        );
        // After the bell the session itself is Closed: ×2, no ramp.
        assert_eq!(
            session_mult_bps_at(&DAY, CLOSE, MarketSession::Closed, &p).unwrap(),
            20_000
        );
        let bps = |t| session_margin_bps_at(1_000, &DAY, t, MarketSession::Regular, &p).unwrap();
        assert_eq!(bps(CLOSE - 1_800), 1_500);
        assert_eq!(bps(CLOSE - 900), 1_750);
    }

    #[test]
    fn the_ramp_targets_the_next_scheduled_session() {
        let p = policy();
        // Regular → Extended (post-market): ramp to ×1.5 only.
        let w = [
            SessionWindow {
                start: 0,
                end: 10_000,
                session: MarketSession::Regular,
            },
            SessionWindow {
                start: 10_000,
                end: 20_000,
                session: MarketSession::Extended,
            },
        ];
        assert_eq!(
            session_mult_bps_at(&w, 10_000 - 1_800, MarketSession::Regular, &p).unwrap(),
            12_500
        );
        // Extended → nothing (Closed): ramp ×1.5 → ×2.
        assert_eq!(
            session_mult_bps_at(&w, 20_000 - 1_800, MarketSession::Extended, &p).unwrap(),
            17_500
        );
        // Regular → Regular (back-to-back windows): no step, no ramp.
        let w = [
            SessionWindow {
                start: 0,
                end: 10_000,
                session: MarketSession::Regular,
            },
            SessionWindow {
                start: 10_000,
                end: 20_000,
                session: MarketSession::Regular,
            },
        ];
        assert_eq!(
            session_mult_bps_at(&w, 9_999, MarketSession::Regular, &p).unwrap(),
            10_000
        );
        // A gap between windows is Closed, so the first one ramps.
        let w = [
            SessionWindow {
                start: 0,
                end: 10_000,
                session: MarketSession::Regular,
            },
            SessionWindow {
                start: 10_001,
                end: 20_000,
                session: MarketSession::Regular,
            },
        ];
        assert_eq!(
            session_mult_bps_at(&w, 9_999, MarketSession::Regular, &p).unwrap(),
            19_998
        );
    }

    #[test]
    fn halted_is_not_ramped_and_zero_ramp_is_a_step() {
        let mut p = policy();
        assert_eq!(
            session_mult_bps_at(&DAY, CLOSE - 1_800, MarketSession::Halted, &p).unwrap(),
            20_000
        );
        p.close_ramp_secs = 0;
        assert_eq!(
            session_mult_bps_at(&DAY, CLOSE - 1, MarketSession::Regular, &p).unwrap(),
            10_000
        );
    }

    #[test]
    fn grace_covers_the_ramp_and_the_first_minutes_after_the_close() {
        let p = policy();
        assert_eq!(close_grace(&DAY, CLOSE - 3_601, &p), None);
        assert_eq!(
            close_grace(&DAY, CLOSE - 3_600, &p),
            Some((10_000, CLOSE - 3_600))
        );
        assert_eq!(
            close_grace(&DAY, CLOSE + 1_799, &p),
            Some((10_000, CLOSE - 3_600))
        );
        assert_eq!(close_grace(&DAY, CLOSE + 1_800, &p), None);
        // No step up, no grace.
        let w = [
            SessionWindow {
                start: 0,
                end: 10_000,
                session: MarketSession::Regular,
            },
            SessionWindow {
                start: 10_000,
                end: 20_000,
                session: MarketSession::Regular,
            },
        ];
        assert_eq!(close_grace(&w, 9_999, &p), None);
    }

    // --- mark EMA (07 §4) ---

    #[test]
    fn decay_halves_every_half_life() {
        let h = MARK_EMA_HALF_LIFE_SECS;
        assert_eq!(decay_factor(0, h).unwrap(), PRECISION);
        assert_eq!(decay_factor(h, h).unwrap(), PRECISION / 2);
        assert_eq!(decay_factor(2 * h, h).unwrap(), PRECISION / 4);
        assert_eq!(decay_factor(h / 2, h).unwrap(), 707_106_781_186_547_524);
        assert_eq!(decay_factor(64 * h, h).unwrap(), 0);
        assert_eq!(decay_factor(u64::MAX, h).unwrap(), 0);
        assert!(decay_factor(1, 0).is_err());
    }

    #[test]
    fn decay_is_close_to_the_exact_exponential_everywhere() {
        let h = 300u64;
        for t in (0..3_000).step_by(7) {
            let got = decay_factor(t, h).unwrap() as f64 / 1e18;
            let want = 2f64.powf(-(t as f64) / h as f64);
            assert!((got - want).abs() <= want * 3e-4, "t={t}: {got} vs {want}");
        }
        // Monotone non-increasing.
        let mut prev = PRECISION;
        for t in 0..2_000 {
            let d = decay_factor(t, h).unwrap();
            assert!(d <= prev);
            prev = d;
        }
    }

    #[test]
    fn ema_is_time_weighted_and_step_bounded() {
        let h = MARK_EMA_HALF_LIFE_SECS;
        let p100 = 100 * PRECISION;
        // Unset: takes the first sample.
        assert_eq!(mark_ema_update(0, 0, p100, 50, h, 10_000).unwrap(), p100);
        // Same second: no move, however many fills.
        assert_eq!(
            mark_ema_update(p100, 50, 102 * PRECISION, 50, h, 10_000).unwrap(),
            p100
        );
        // One half-life later: halfway.
        assert_eq!(
            mark_ema_update(p100, 0, 102 * PRECISION, h, h, 10_000).unwrap(),
            101 * PRECISION
        );
        // A long gap: all the way, unless the step bound (50 bps) stops it.
        assert_eq!(
            mark_ema_update(p100, 0, 110 * PRECISION, 100 * h, h, 10_000).unwrap(),
            110 * PRECISION
        );
        assert_eq!(
            mark_ema_update(p100, 0, 110 * PRECISION, 100 * h, h, 50).unwrap(),
            1005 * PRECISION / 10
        );
        assert_eq!(
            mark_ema_update(p100, 0, 90 * PRECISION, 100 * h, h, 50).unwrap(),
            995 * PRECISION / 10
        );
        assert!(mark_ema_update(p100, 0, 0, 1, h, 50).is_err());
    }

    #[test]
    fn a_rich_weekend_book_gives_a_positive_premium_clamped_to_the_band() {
        let p = policy();
        let close = 250 * PRECISION;
        // Book 1% rich right after the close: inside the 2% band.
        let prem = closed_premium(close, 2525 * PRECISION / 10, 0, &p).unwrap();
        assert_eq!(prem, PRECISION / 100);
        // Book 10% rich right after the close: clamped to +2%.
        assert_eq!(
            closed_premium(close, 275 * PRECISION, 0, &p).unwrap(),
            PRECISION / 50
        );
        // Cheap book: negative.
        assert!(closed_premium(close, 245 * PRECISION, 0, &p).unwrap() < 0);
    }
}
