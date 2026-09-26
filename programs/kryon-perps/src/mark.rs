//! What every market-reading instruction records, and the book mark EMA
//! (`07` §4–5).

use crate::constants::MARK_MAX_STEP_BPS;
use crate::error::CoreResultExt;
use crate::events::SessionChanged;
use crate::health::MarketView;
use crate::state::*;
use anchor_lang::prelude::*;
use risk_engine::{mark_ema_update, MarketSession, MARK_EMA_HALF_LIFE_SECS};

pub fn session_code(s: MarketSession) -> u8 {
    match s {
        MarketSession::Regular => SESSION_REGULAR,
        MarketSession::Extended => SESSION_EXTENDED,
        MarketSession::Closed => SESSION_CLOSED,
        MarketSession::Halted => SESSION_HALTED,
    }
}

/// Record what an instruction saw of the market:
/// - in session: the last trusted oracle price (the anchor for Closed and
///   Halted marks); on the first observation after a close, the reopen
///   (`07` §5): the book EMA snaps to the oracle, so neither the mark nor
///   funding carries the weekend book into the new session;
/// - Closed: when the close was first seen (the band widens from there).
///
/// Returns a `SessionChanged` event when the session differs from the last
/// one recorded.
pub fn observe(m: &mut Market, view: &MarketView, now: u64) -> Option<SessionChanged> {
    match view.session {
        MarketSession::Regular | MarketSession::Extended => {
            if let Some(o) = view.oracle {
                if o.publish_time >= m.last_oracle_publish_time {
                    m.last_oracle_price.set(o.price);
                    m.last_oracle_publish_time = o.publish_time;
                }
                if m.closed_since != 0 {
                    m.mark_ema.set(o.price);
                    m.mark_ema_updated = now;
                }
            }
            m.closed_since = 0;
        }
        MarketSession::Closed => {
            if m.closed_since == 0 {
                m.closed_since = now;
            }
        }
        MarketSession::Halted => {}
    }
    // `last_session` stores code + 1 so a fresh market (0) always reports.
    let code = session_code(view.session);
    if m.last_session == code + 1 {
        return None;
    }
    m.last_session = code + 1;
    Some(SessionChanged {
        market_id: m.market_id,
        session: code,
    })
}

/// Fold a traded or posted price into the time-weighted mark EMA.
pub fn fold_mark(m: &mut Market, sample: i128, now: u64) -> Result<()> {
    let next = mark_ema_update(
        m.mark_ema.get(),
        m.mark_ema_updated,
        sample,
        now,
        MARK_EMA_HALF_LIFE_SECS,
        MARK_MAX_STEP_BPS,
    )
    .core()?;
    m.mark_ema.set(next);
    m.mark_ema_updated = now;
    Ok(())
}
