# 07 — Equity-perp risk: sessions, gaps, corporate actions

Code: `crates/risk-engine/src/session.rs` (resolution, band, ramp, grace,
EMA, closed premium) and the program's `health::market_view`, `mark.rs` and
`post_mark`. This document is the spec for them.

## 1. The problem

A crypto perp's index never stops. A stock's does:
- Regular session: 09:30–16:00 ET (13:30–20:00 UTC in summer, 14:30–21:00 UTC
  in winter).
- Extended sessions: pre-market, post-market and overnight (Blue Ocean ATS).
  Prices are real but thin.
- Weekends and exchange holidays: no reference price at all, for up to ~65 h.
- Monday opens and earnings gap by 5–20%.

If you keep trading 24/7 and naively hold the last price, the mark is frozen,
liquidations can't fire when the book moves, and Monday's open hits the
insurance fund. If you let the book set the price with no limits, a thin
weekend book can be pushed to liquidate people.

## 2. The model

| Session | Mark | Initial/maintenance margin | New exposure | Liquidations |
|---|---|---|---|---|
| Regular | Pyth | base | up to `max_open_interest` | normal |
| Extended | Pyth (extended feed) | base × 1.5 | up to max OI | normal |
| Closed | `clamp(book_mid_EMA, last ± band(t))` | base × 2.0 | ≤ `closed_oi_cap_bps` of max OI (default 50%) | allowed, at the clamped mark |
| Halted | last valid | base × 2.0 | **none** (reduce-only) | paused, except at the band edge (decide in governance) |

`band(t) = min(base 2% + 0.25% × hours_closed, 15%)`. Defaults are in
`SessionPolicy` and set per market. Single stocks get wider bands than index
ETFs.

**Margin ramp:** don't jump from ×1 to ×2 exactly at 16:00, or everybody near
the edge gets liquidated at the bell. **Ramp the requirement over the 60 minutes
before a scheduled close.** Positions opened before the ramp get a grace
window: they can't add exposure, but they aren't liquidated by the multiplier
alone for N minutes. Build this as `session_margin_bps_at(now, window)`, the
next function to add to `session.rs`.

**Built (decided 2026-09-26):**
- `session_margin_bps_at(base, windows, now, session, policy)`: in a
  Regular/Extended window whose *next* scheduled session has a higher
  multiplier (a window starting exactly at its end, else Closed), the
  multiplier ramps linearly from the window's own to the next one's over
  `SessionPolicy.close_ramp_secs` (default 3,600) before the window ends.
  Regular → Extended ramps ×1 → ×1.5; Extended → Closed ×1.5 → ×2;
  back-to-back Regular windows don't ramp. Halted is never ramped (it is
  already ×2). The multiplier and the scaled bps round up.
- Grace: from the start of the ramp until `close_grace_secs` (default 1,800)
  after the window ends, **liquidation** evaluates maintenance at the
  pre-close multiplier for an account whose `UserAccount.last_increase_ts`
  (set by every fill that opens or grows exposure) is before the ramp began.
  Tracked per account, not per position, which is stricter: adding exposure
  anywhere during the ramp forfeits the grace. Initial margin (adding
  exposure, withdrawals, the reduce relief) always uses the ramped value.
  Both fields are capped at 4 h by `create_market`.

## 3. The calendar

- The program **never computes time zones.** A keeper posts
  `SessionWindow{start, end, session}` for the next 7–14 days: NYSE regular,
  extended and early-close days, holidays, and DST shifts.
- Anything outside a posted window is **Closed**. That's fail-safe: if the
  keeper dies, markets go conservative, not permissive.
- The calendar authority can't modify a window that has already started.
- Source for the keeper: a static NYSE holiday table checked into the repo
  (reviewed yearly), plus DST from the IANA tz database.

## 4. The closed-session mark EMA

- Update `Market.mark_ema` inside `settle_fills` from each fill price: time
  weighted, with a half-life of ~5 min.
- If there are no fills, use the book mid posted by the matcher in a
  lightweight `post_mark(market, mid)` call. It's rate-limited, clamped to the
  band, and can only move the EMA by a bounded step each time.
- Funding while closed uses `premium = (mark_ema − last_close) / last_close`,
  so weekend longs pay if the book is rich. This is the incentive that keeps
  the weekend book honest.

**Built (decided 2026-09-26):**
- One EMA, `Market.mark_ema`, fed by **every fill in every session** (not
  only while Closed), so funding in session has a perp price to compare with
  the oracle (`update_funding`). Half-life 300 s. The weight is
  `1 − 2^(−Δt/half-life)`, computed without floats (a 1/16-half-life table
  with interpolation, < 3e-4 relative error), so fills in the same second
  move it no more than one fill would. The first sample seeds it.
- Every update (fill or post) moves it at most `MARK_MAX_STEP_BPS` = 50 bps.
  Fills are already inside the 1% execution band around the mark; the step
  bound also stops a single print after a long quiet gap from resetting it.
- `post_mark(market, mid)`: operators only, at most once per
  `POST_MARK_MIN_INTERVAL_SECS` = 10 s per market, refused while Halted and
  while paused. The mid is clamped to the band first: Closed → the widening
  band around the last close; in session → the execution band around the
  oracle. `mid` is u64 at 1e9, like order prices.
- The Closed mark is `closed_mark_price(last_close, ema, secs_closed)` (the
  last close until the EMA is seeded). The execution band follows it.
- Rate limit, step bound and half-life are program constants, not per-market
  config, until tuning on devnet says otherwise.

## 5. The reopen

At the first valid Regular or Extended Pyth price after Closed:
1. The mark snaps to the oracle.
2. Accounts under water at the new mark are liquidated normally. Margin ×2
   should have absorbed a gap of up to ~1/(2 × base margin).
3. Funding re-anchors to the oracle index.
4. Emit `SessionChanged` so the UI and indexer know.

**Built (decided 2026-09-26):** every instruction that reads a market
(`settle_fills`, `post_mark`, `update_funding`, `liquidate`, `adl`) runs
`mark::observe`: the first in-session observation after a close snaps
`mark_ema` to the oracle price, clears `closed_since` and records the
oracle as the new last close; `SessionChanged` fires on any change. The
snap means neither the mark nor funding carries the weekend book into the
new session; the premium rebuilds from fills. `closed_since` is when the
close was first *observed*, which can only make the band narrower
(conservative) if nobody touched the market at the bell.

## 6. Corporate actions

| Event | Handling |
|---|---|
| Split / reverse split | Perp: admin sets a `price_multiplier` in the same slot the oracle switches. Positions are rescaled by size×k and price÷k. Notional is unchanged. Rehearse on devnet |
| Cash dividend | The underlying price drops on the ex-date. Option A (simple, v1): no adjustment; the funding and price move absorb it; document it. Option B (phase 2): credit longs and debit shorts the dividend amount at ex-date |
| Delisting / halts / M&A | The market goes reduce-only, then settles at the final price. The governance procedure is in the runbook |
| xStocks collateral during corporate actions | Read the mint's multiplier extension; value = amount × multiplier × price |

## 7. Parameters to start with (tune on devnet with replayed history)

| Class | Base IM / MM | Max lev (Regular) | Closed band max | Closed OI cap |
|---|---|---|---|---|
| Index ETFs (SPY, QQQ) | 10% / 5% | 10x | 10% | 50% |
| Mega-cap (AAPL, MSFT, NVDA, META, AMZN) | 12.5% / 6% | 8x | 15% | 40% |
| High-vol (TSLA, COIN, MSTR) | 20% / 10% | 5x | 20% | 30% |
| Crypto (SOL, BTC, ETH) | 5% / 2.5% | 20x | n/a (always Regular) | n/a |

Backtest: replay 2 years of Monday opens and earnings gaps per ticker against
these numbers. The target is that fewer than 1 in 1,000 account-weekends end
in bad debt.

**Built and run (2026-09-26):** `yarn backtest`
(`scripts/backtest/weekend_replay.py`, report in
`docs/backtest/weekend-replay.md`). It replays every close → next open
(weekends and holidays, and every overnight gap, which contains the earnings
gaps; extended hours count as Closed, `06` §8). The model: after the close's
grace window every holder has equity ≥ the Closed maintenance ratio
`m_c = 2 × MM` (anything below was liquidated near the last close). No
liquidation is credited during the closure (conservative). An account is bad
debt at the open if the adverse gap exceeds its equity ratio. Two books:
*worst* (all at `m_c`) and *typical* (a quarter each at 1, 1.25, 1.5 and
2 × `m_c`). Data is Yahoo daily OHLC, cached for research only, never
committed.

Result, 2024-09 → 2026-09: **9 of 10 tickers pass; NVDA fails.** Its
2025-01-27 open (DeepSeek, −12.49%) is beyond the mega-cap `m_c` of 12%,
giving 1.12‰ of typical-book weekends in bad debt (4.46‰ worst book).
MSFT and AMZN also have overnight earnings gaps above 12% (12.13%, 12.53%),
0.25–0.50‰ typical. All other gaps, including high-vol names, stay inside
`m_c`. No weekend gap exceeded its Closed band ceiling. With ~112 weekends a
ticker, one bad weekend is already ~1.1‰, so the target is really "no bad
weekend in two years". **Open decision for the owner:** move NVDA to the
high-vol class, or raise mega-cap MM (e.g. 7% → `m_c` 14%); see the Phase 2
gate in `09`.
