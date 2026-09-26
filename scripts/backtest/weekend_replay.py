#!/usr/bin/env python3
"""Weekend replay backtest (docs/prd/07 §7).

Replays every close → next open of the last two years (weekends, holidays,
and every overnight gap, which includes earnings) against the Phase 2
parameter table, and reports the bad-debt rate per ticker.

The model (decided 2026-09-26, see 07 §7):
- Under the Phase 2 policy every close → open is a Closed period (extended
  hours count as Closed until Pyth Pro, 06 §8), with margin ×2.
- By the end of the close's grace window, any account below the Closed
  maintenance ratio m_c = 2 × MM has been liquidated near the last close
  (the Closed band starts at ±2%), so every account that holds through the
  gap has equity ≥ m_c × notional.
- No liquidation is credited during the closed period (the book-driven mark
  may not see the move), which is conservative. At the open the account is
  liquidated at the opening print; it is bad debt if the adverse gap exceeds
  its equity ratio.
- Two books: "worst" (every account exactly at m_c) and "typical" (a
  quarter each at m_c, 1.25, 1.5 and 2 × m_c). Half long, half short.

Target (07 §7): fewer than 1 in 1,000 account-weekends end in bad debt.

Data: Yahoo Finance daily OHLC (split-adjusted), cached in the gitignored
.backtest-cache/ for research use only, never committed.

    scripts/backtest/weekend_replay.py [--years 2] [--refresh] [--out FILE]
"""
import argparse
import datetime as dt
import json
import os
import sys
import urllib.request

# 07 §7: class → (IM, MM, closed band max, closed OI cap), fractions.
CLASSES = {
    "index": (0.10, 0.05, 0.10, 0.50),
    "mega": (0.125, 0.06, 0.15, 0.40),
    "highvol": (0.20, 0.10, 0.20, 0.30),
}
TICKERS = {
    "SPY": "index", "QQQ": "index",
    "AAPL": "mega", "MSFT": "mega", "NVDA": "mega", "META": "mega", "AMZN": "mega",
    "TSLA": "highvol", "COIN": "highvol", "MSTR": "highvol",
}
CLOSED_MULT = 2.0
TARGET = 1 / 1000
EVENT_GAP = 0.05  # an overnight move this large is almost always news/earnings
CACHE = ".backtest-cache"


def fetch(ticker: str, years: int, refresh: bool):
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, f"{ticker}-{years}y.json")
    if refresh or not os.path.exists(path):
        url = (
            f"https://query1.finance.yahoo.com/v8/finance/chart/{ticker}"
            f"?range={years}y&interval=1d"
        )
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=30) as r:
            body = r.read()
        with open(path, "wb") as f:
            f.write(body)
    with open(path) as f:
        res = json.load(f)["chart"]["result"][0]
    q = res["indicators"]["quote"][0]
    rows = []
    for ts, o, c in zip(res["timestamp"], q["open"], q["close"]):
        if o is None or c is None or o <= 0 or c <= 0:
            continue
        rows.append((dt.datetime.fromtimestamp(ts, dt.timezone.utc).date(), o, c))
    return rows


def gaps(rows):
    """(date of the open, gap fraction, kind) for each close → next open."""
    out = []
    for (d0, _, c0), (d1, o1, _) in zip(rows, rows[1:]):
        kind = "weekend" if (d1 - d0).days >= 2 else "overnight"
        out.append((d1, (o1 - c0) / c0, kind))
    return out


def bad_debt(g: float, equity_ratio: float) -> tuple[int, float]:
    """Accounts (of 2: one long, one short) whose loss exceeds equity, and the
    uncovered loss per unit notional."""
    n, uncovered = 0, 0.0
    for direction in (1, -1):
        loss = max(0.0, -direction * g)
        if loss > equity_ratio:
            n += 1
            uncovered += loss - equity_ratio
    return n, uncovered


def replay(ticker: str, rows):
    im, mm, band, _ = CLASSES[TICKERS[ticker]]
    mc = CLOSED_MULT * mm
    books = {
        "worst": [mc],
        "typical": [mc, 1.25 * mc, 1.5 * mc, 2.0 * mc],
    }
    all_gaps = gaps(rows)
    out = {"ticker": ticker, "class": TICKERS[ticker], "mc": mc, "band": band}
    for scope in ("weekend", "all"):
        gs = [g for g in all_gaps if scope == "all" or g[2] == "weekend"]
        out[f"{scope}_n"] = len(gs)
        out[f"{scope}_max"] = max((abs(g[1]) for g in gs), default=0.0)
        for name, ratios in books.items():
            accounts, bad, uncovered = 0, 0, 0.0
            for _, g, _ in gs:
                for e in ratios:
                    k, u = bad_debt(g, e)
                    accounts += 2
                    bad += k
                    uncovered += u
            out[f"{scope}_{name}_rate"] = bad / accounts if accounts else 0.0
            out[f"{scope}_{name}_bad"] = bad
            out[f"{scope}_{name}_accounts"] = accounts
            out[f"{scope}_{name}_uncovered"] = uncovered
    out["events"] = sorted(
        [(d, g) for d, g, k in all_gaps if abs(g) >= EVENT_GAP], key=lambda x: -abs(x[1])
    )[:3]
    out["beyond_band"] = sum(1 for _, g, k in all_gaps if k == "weekend" and abs(g) > band)
    return out


def pct(x: float) -> str:
    return f"{100 * x:.2f}%"


def rate(x: float) -> str:
    return "0" if x == 0 else f"{1000 * x:.2f}‰"


def report(results, years: int, first, last) -> tuple[str, bool]:
    lines = [
        f"# Weekend replay backtest ({dt.date.today().isoformat()})",
        "",
        f"Generated by `scripts/backtest/weekend_replay.py`: {years} years of daily "
        f"opens and closes ({first} → {last}), Yahoo Finance, split-adjusted. "
        "Model and assumptions: see the script's docstring and `07` §7.",
        "",
        "Bad debt per 1,000 account-closes (‰). Target: < 1‰. `m_c` is the "
        "Closed maintenance ratio (2 × MM) every account holding through a close "
        "has at least. *Worst*: every account exactly at `m_c`. *Typical*: a "
        "quarter each at 1, 1.25, 1.5 and 2 × `m_c`.",
        "",
        "| Ticker | Class | m_c | Weekends | Max weekend gap | Weekend worst | "
        "Weekend typical | All closes | Max gap | All worst | All typical | Pass |",
        "|---|---|---|---|---|---|---|---|---|---|---|---|",
    ]
    ok_all = True
    for r in results:
        ok = r["all_typical_rate"] < TARGET and r["weekend_typical_rate"] < TARGET
        ok_all &= ok
        lines.append(
            f"| {r['ticker']} | {r['class']} | {pct(r['mc'])} | {r['weekend_n']} | "
            f"{pct(r['weekend_max'])} | {rate(r['weekend_worst_rate'])} | "
            f"{rate(r['weekend_typical_rate'])} | {r['all_n']} | {pct(r['all_max'])} | "
            f"{rate(r['all_worst_rate'])} | {rate(r['all_typical_rate'])} | "
            f"{'✅' if ok else '❌'} |"
        )
    lines += ["", "Largest gaps (likely earnings or news):", ""]
    for r in results:
        ev = ", ".join(f"{d} {pct(g)}" for d, g in r["events"]) or "none ≥ 5%"
        lines.append(f"- **{r['ticker']}**: {ev}")
    lines += [
        "",
        "Weekend gaps larger than the Closed band ceiling (the book mark could "
        "not have reached them before the open):",
        "",
        ", ".join(f"{r['ticker']} {r['beyond_band']}" for r in results),
        "",
    ]
    return "\n".join(lines), ok_all


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--years", type=int, default=2)
    ap.add_argument("--refresh", action="store_true")
    ap.add_argument("--out")
    args = ap.parse_args()
    results, first, last = [], None, None
    for t in TICKERS:
        rows = fetch(t, args.years, args.refresh)
        first = min(first or rows[0][0], rows[0][0])
        last = max(last or rows[-1][0], rows[-1][0])
        results.append(replay(t, rows))
    text, ok = report(results, args.years, first, last)
    print(text)
    if args.out:
        with open(args.out, "w") as f:
            f.write(text)
    print("BACKTEST:", "PASS" if ok else "FAIL (typical book above 1‰ somewhere)")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
