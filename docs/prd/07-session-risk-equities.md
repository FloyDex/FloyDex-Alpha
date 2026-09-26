# 07 — Equity-perp risk: sessions, gaps, corporate actions

Code: `crates/risk-engine/src/session.rs` (done, 7 tests). This document is the
spec for it and for the parts still to build.

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

## 5. The reopen

At the first valid Regular or Extended Pyth price after Closed:
1. The mark snaps to the oracle.
2. Accounts under water at the new mark are liquidated normally. Margin ×2
   should have absorbed a gap of up to ~1/(2 × base margin).
3. Funding re-anchors to the oracle index.
4. Emit `SessionChanged` so the UI and indexer know.

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
