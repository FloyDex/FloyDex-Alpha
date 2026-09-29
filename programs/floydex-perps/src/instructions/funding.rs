//! `update_funding(market)`: permissionless, run hourly by a keeper (`05` §2).
//!
//! The premium is the book against the index (`11` L8: never OI imbalance):
//! - in session: `(mark_ema − oracle) / oracle`;
//! - Closed: `(clamped mark_ema − last close) / last close` (`07` §4), so
//!   weekend longs pay when the book trades rich;
//! - Halted, or no fill or posted mid for `MARK_EMA_MAX_AGE_SECS`: zero.
//!
//! `risk_engine::update_from_premium` clamps the rate and charges at most
//! `MAX_FUNDING_ELAPSED_SECS` per call, so a late keeper under-charges and
//! never over-charges. Positions settle funding on their next touch; health
//! counts the pending amount through the market's indexes.

use crate::constants::*;
use crate::error::{CoreResultExt, FloyDexError};
use crate::events::FundingUpdated;
use crate::health::{market_view, secs_closed, MarketView};
use crate::mark::observe;
use crate::state::*;
use anchor_lang::prelude::*;
use risk_engine::{closed_premium, premium_from_mark, update_from_premium, MarketSession};

#[event_cpi]
#[derive(Accounts)]
pub struct UpdateFunding<'info> {
    #[account(seeds = [EXCHANGE_SEED], bump = exchange.bump)]
    pub exchange: Box<Account<'info, Exchange>>,
    #[account(mut, seeds = [MARKET_SEED, &market.load()?.market_id.to_le_bytes()], bump = market.load()?.bump)]
    pub market: AccountLoader<'info, Market>,
    /// CHECK: address, owner, discriminator and feed id are verified in `oracle::read_pyth`.
    pub price_update: UncheckedAccount<'info>,
}

pub fn handle_update_funding(ctx: Context<UpdateFunding>) -> Result<()> {
    require!(!ctx.accounts.exchange.paused, FloyDexError::Paused);
    let now = Clock::get()?.unix_timestamp as u64;
    let view = {
        let m = ctx.accounts.market.load()?;
        market_view(&m, &ctx.accounts.price_update, now)?
    };
    let mut m = ctx.accounts.market.load_mut()?;
    let changed = observe(&mut m, &view, now);
    let premium = funding_premium(&m, &view, now)?;
    let next = update_from_premium(&m.funding_config(), &m.funding_state(), premium, now).core()?;
    m.funding_long_index.set(next.long_index);
    m.funding_short_index.set(next.short_index);
    m.funding_rate_per_hour.set(next.rate_per_hour);
    m.funding_last_update = next.last_update;
    let event = FundingUpdated {
        market_id: m.market_id,
        session: crate::mark::session_code(view.session),
        premium,
        rate_per_hour: next.rate_per_hour,
        long_index: next.long_index,
        short_index: next.short_index,
    };
    drop(m);
    if let Some(changed) = changed {
        emit_cpi!(changed);
    }
    emit_cpi!(event);
    Ok(())
}

/// PRECISION-scaled premium of the book over the index right now.
pub fn funding_premium(m: &Market, view: &MarketView, now: u64) -> Result<i128> {
    let ema = m.mark_ema.get();
    let fresh = ema > 0 && now.saturating_sub(m.mark_ema_updated) <= MARK_EMA_MAX_AGE_SECS;
    if !fresh {
        return Ok(0);
    }
    Ok(match view.session {
        MarketSession::Regular | MarketSession::Extended => {
            let index = view.oracle.ok_or(FloyDexError::StaleOracle)?.price;
            premium_from_mark(ema, index).core()?
        }
        MarketSession::Closed => {
            let last = m.last_oracle_price.get();
            closed_premium(last, ema, secs_closed(m, now), &m.session_policy()).core()?
        }
        MarketSession::Halted => 0,
    })
}
