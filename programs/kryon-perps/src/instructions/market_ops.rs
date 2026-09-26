//! Market operations after creation: the session calendar (keeper) and the
//! oracle source (admin).

use crate::constants::*;
use crate::error::KryonError;
use crate::state::*;
use anchor_lang::prelude::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct SessionWindowArgs {
    pub start: u64,
    pub end: u64,
    /// `SESSION_REGULAR`, `SESSION_EXTENDED`, `SESSION_CLOSED` or `SESSION_HALTED`.
    pub session: u8,
}

#[derive(Accounts)]
pub struct PostSessionCalendar<'info> {
    #[account(seeds = [EXCHANGE_SEED], bump = exchange.bump, has_one = calendar_authority @ KryonError::Unauthorized)]
    pub exchange: Account<'info, Exchange>,
    pub calendar_authority: Signer<'info>,
    #[account(mut, seeds = [MARKET_SEED, &market.load()?.market_id.to_le_bytes()], bump = market.load()?.bump)]
    pub market: AccountLoader<'info, Market>,
}

/// Replace every window that has not started yet with `windows` (`07` §3).
///
/// - Windows must be well-formed, sorted, non-overlapping and strictly in
///   the future (`start > now`).
/// - The window in effect right now is never touched, and no new window may
///   start before it ends.
/// - Finished windows are dropped. Anything outside every window is Closed,
///   so a keeper that stops posting fails safe.
pub fn handle_post_session_calendar(
    ctx: Context<PostSessionCalendar>,
    windows: Vec<SessionWindowArgs>,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp as u64;
    let mut m = ctx.accounts.market.load_mut()?;

    let current: Option<SessionWindowPod> = m
        .calendar
        .iter()
        .copied()
        .find(|w| w.end != 0 && w.start <= now && now < w.end);
    let mut prev_end = current.map_or(now, |w| w.end);
    for w in windows.iter() {
        require!(
            w.start < w.end
                && w.start > now
                && w.start >= prev_end
                && session_from_u8(w.session).is_some(),
            KryonError::InvalidSessionWindow
        );
        prev_end = w.end;
    }
    let keep = usize::from(current.is_some());
    require!(
        keep + windows.len() <= CALENDAR_LEN,
        KryonError::InvalidSessionWindow
    );

    let mut next = [SessionWindowPod::default(); CALENDAR_LEN];
    let mut n = 0;
    if let Some(c) = current {
        next[n] = c;
        n += 1;
    }
    for w in windows.iter() {
        next[n] = SessionWindowPod {
            start: w.start,
            end: w.end,
            session: w.session,
            _pad: [0; 7],
        };
        n += 1;
    }
    m.calendar = next;
    Ok(())
}

#[derive(Accounts)]
#[instruction(market_id: u16)]
pub struct SetMarketOracle<'info> {
    #[account(seeds = [EXCHANGE_SEED], bump = exchange.bump, has_one = admin @ KryonError::Unauthorized)]
    pub exchange: Account<'info, Exchange>,
    pub admin: Signer<'info>,
    #[account(mut, seeds = [MARKET_SEED, &market_id.to_le_bytes()], bump = market.load()?.bump)]
    pub market: AccountLoader<'info, Market>,
}

/// Switch the Pyth shard and freshness guard (`06` §8: moving from the free
/// sponsored shard 0 to our own pusher shard is a config change). The feed
/// id itself stays fixed.
pub fn handle_set_market_oracle(
    ctx: Context<SetMarketOracle>,
    _market_id: u16,
    pyth_shard_id: u16,
    max_oracle_age_secs: u64,
    max_oracle_confidence_bps: u32,
) -> Result<()> {
    require!(
        max_oracle_age_secs > 0 && max_oracle_confidence_bps <= 10_000,
        KryonError::InvalidConfig
    );
    let mut m = ctx.accounts.market.load_mut()?;
    m.pyth_shard_id = pyth_shard_id;
    m.max_oracle_age_secs = max_oracle_age_secs;
    m.max_oracle_confidence_bps = max_oracle_confidence_bps;
    Ok(())
}
