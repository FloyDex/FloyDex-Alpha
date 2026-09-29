import { MARKETS, type MarketConfig } from "@/config";
import { EQUITY_TICKERS, fetchMarkUsd, fetchYahoo24h, isEquityMarket } from "./marks";

export type PerformanceKey = "1W" | "1M" | "3M" | "6M" | "YTD" | "1Y";

export interface SymbolDetails {
  marketId: number;
  symbol: string;
  pair: string;
  venue: string;
  kind: "equity" | "crypto";
  price: number;
  prevClose: number;
  changeAbs: number;
  changePct: number;
  marketOpen: boolean;
  sessionLabel: string;
  volume: number;
  avgVolume30d: number;
  asOf: number;
  performance: Record<PerformanceKey, number | null>;
  technicals: {
    score: number;
    label: string;
    rsi: number | null;
    sma20: number | null;
    sma50: number | null;
  };
}

type Bar = { t: number; close: number; volume: number };

const DAILY_CACHE_MS = 120_000;
const LIVE_CACHE_MS = 3_000;
const dailyCache = new Map<number, { at: number; bars: Bar[] }>();
const cache = new Map<number, { at: number; data: SymbolDetails | null }>();

function marketOf(id: number): MarketConfig | undefined {
  return Object.values(MARKETS).find((m) => m.marketId === id);
}

export function compactStat(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "—";
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(2)}K`;
  return n >= 100 ? n.toFixed(2) : n.toFixed(n >= 10 ? 2 : 3);
}

export function returnPct(last: number, prior: number | undefined): number | null {
  if (!(last > 0) || !(prior && prior > 0)) return null;
  return ((last - prior) / prior) * 100;
}

export function sma(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((s, v) => s + v, 0) / period;
}

/** Wilder RSI. */
export function rsi(values: number[], period = 14): number | null {
  if (values.length < period + 1) return null;
  let gain = 0;
  let loss = 0;
  for (let i = values.length - period; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  const avgGain = gain / period;
  const avgLoss = loss / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export function technicalScore(last: number, sma20: number | null, sma50: number | null, rsi14: number | null) {
  let score = 0;
  let votes = 0;
  if (sma20 && sma20 > 0) {
    votes += 1;
    score += last >= sma20 ? 1 : -1;
  }
  if (sma50 && sma50 > 0) {
    votes += 1;
    score += last >= sma50 ? 1 : -1;
  }
  if (rsi14 !== null) {
    votes += 1;
    if (rsi14 >= 60) score += 1;
    else if (rsi14 <= 40) score -= 1;
  }
  const norm = votes > 0 ? score / votes : 0;
  const label =
    norm <= -0.67 ? "Strong sell" : norm < -0.15 ? "Selling" : norm <= 0.15 ? "Neutral" : norm < 0.67 ? "Buying" : "Strong buy";
  return { score: norm, label };
}

export function performanceFromCloses(
  closes: number[],
  times: number[],
): Record<PerformanceKey, number | null> {
  const last = closes[closes.length - 1];
  const atOffset = (days: number) => {
    const idx = closes.length - 1 - days;
    return idx >= 0 ? closes[idx] : undefined;
  };
  const ytdClose = (() => {
    const year = new Date().getUTCFullYear();
    const start = Date.UTC(year, 0, 1);
    for (let i = 0; i < times.length; i++) {
      if (times[i] >= start) return closes[i];
    }
    return closes[0];
  })();
  return {
    "1W": returnPct(last, atOffset(5)),
    "1M": returnPct(last, atOffset(21)),
    "3M": returnPct(last, atOffset(63)),
    "6M": returnPct(last, atOffset(126)),
    YTD: returnPct(last, ytdClose),
    "1Y": returnPct(last, closes[0]),
  };
}

export function equitySessionNow(now = Date.now()): { open: boolean; label: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(now));
  const weekday = parts.find((p) => p.type === "weekday")?.value ?? "";
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  const mins = hour * 60 + minute;
  const weekdayOpen = weekday !== "Sat" && weekday !== "Sun";
  const regular = mins >= 9 * 60 + 30 && mins < 16 * 60;
  const extended = (mins >= 4 * 60 && mins < 9 * 60 + 30) || (mins >= 16 * 60 && mins < 20 * 60);
  if (weekdayOpen && regular) return { open: true, label: "Market open" };
  if (weekdayOpen && extended) return { open: true, label: "Extended hours" };
  return { open: false, label: "Market closed" };
}

async function yahooDaily(ticker: string): Promise<Bar[]> {
  const res = await fetch(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=1y`,
    { cache: "no-store", headers: { "User-Agent": "FloyDex/1.0" } },
  );
  if (!res.ok) return [];
  const json = (await res.json()) as {
    chart?: {
      result?: {
        timestamp?: number[];
        meta?: { regularMarketPrice?: number; chartPreviousClose?: number; previousClose?: number };
        indicators?: { quote?: { close?: (number | null)[]; volume?: (number | null)[] }[] };
      }[];
    };
  };
  const result = json.chart?.result?.[0];
  const ts = result?.timestamp ?? [];
  const closes = result?.indicators?.quote?.[0]?.close ?? [];
  const vols = result?.indicators?.quote?.[0]?.volume ?? [];
  const bars: Bar[] = [];
  for (let i = 0; i < ts.length; i++) {
    const close = closes[i];
    if (!(close && close > 0)) continue;
    bars.push({ t: ts[i] * 1000, close, volume: vols[i] && vols[i]! > 0 ? vols[i]! : 0 });
  }
  return bars;
}

async function binanceDaily(pair: string): Promise<Bar[]> {
  const res = await fetch(
    `https://api.binance.com/api/v3/klines?symbol=${pair}&interval=1d&limit=365`,
    { cache: "no-store" },
  );
  if (!res.ok) return [];
  const rows = (await res.json()) as (string | number)[][];
  return rows
    .map((r) => ({
      t: Number(r[0]),
      close: parseFloat(String(r[4])),
      volume: parseFloat(String(r[7])),
    }))
    .filter((b) => b.close > 0);
}

function fromBars(market: MarketConfig, bars: Bar[], cryptoAlwaysOpen: boolean, now = Date.now()): SymbolDetails | null {
  if (bars.length < 2) return null;
  const closes = bars.map((b) => b.close);
  const last = closes[closes.length - 1];
  const prev = closes[closes.length - 2];
  const last30 = bars.slice(-30);
  const avgVolume30d = last30.reduce((s, b) => s + b.volume, 0) / last30.length;
  const sma20 = sma(closes, 20);
  const sma50 = sma(closes, 50);
  const rsi14 = rsi(closes, 14);
  const session = cryptoAlwaysOpen
    ? { open: true, label: "Market open" }
    : equitySessionNow(now);
  return {
    marketId: market.marketId,
    symbol: `${market.baseAsset}${market.quoteAsset}`,
    pair: `${market.baseAsset} / ${market.quoteAsset}`,
    venue: cryptoAlwaysOpen ? "BINANCE" : "YAHOO",
    kind: cryptoAlwaysOpen ? "crypto" : "equity",
    price: last,
    prevClose: prev,
    changeAbs: last - prev,
    changePct: prev > 0 ? ((last - prev) / prev) * 100 : 0,
    marketOpen: session.open,
    sessionLabel: session.label,
    volume: bars[bars.length - 1]?.volume ?? 0,
    avgVolume30d,
    asOf: bars[bars.length - 1]?.t ?? now,
    performance: performanceFromCloses(closes, bars.map((b) => b.t)),
    technicals: { ...technicalScore(last, sma20, sma50, rsi14), rsi: rsi14, sma20, sma50 },
  };
}

async function dailyBarsFor(marketId: number, market: MarketConfig, equity: boolean): Promise<Bar[]> {
  const hit = dailyCache.get(marketId);
  if (hit && Date.now() - hit.at < DAILY_CACHE_MS) return hit.bars;
  const bars = equity
    ? await yahooDaily(EQUITY_TICKERS[marketId] ?? market.baseAsset)
    : await binanceDaily(market.priceSourceSymbol);
  dailyCache.set(marketId, { at: Date.now(), bars });
  return bars;
}

export async function fetchSymbolDetails(marketId: number): Promise<SymbolDetails | null> {
  const hit = cache.get(marketId);
  if (hit && Date.now() - hit.at < LIVE_CACHE_MS) return hit.data;
  const market = marketOf(marketId);
  if (!market) {
    cache.set(marketId, { at: Date.now(), data: null });
    return null;
  }
  try {
    const equity = isEquityMarket(marketId);
    const bars = [...(await dailyBarsFor(marketId, market, equity))];
    if (equity) {
      const live = await fetchYahoo24h(marketId);
      if (live && live.price > 0 && bars.length) {
        const last = bars[bars.length - 1];
        const next = {
          t: live.asOf || Date.now(),
          close: live.price,
          volume: live.volume > 0 ? live.volume : last.volume,
        };
        // Don't overwrite Friday's official close with Monday premarket.
        if (next.t - last.t > 18 * 3600_000) bars.push(next);
        else bars[bars.length - 1] = next;
      }
      const data = fromBars(market, bars, false);
      if (data && live) {
        data.price = live.price;
        data.prevClose = live.previousClose > 0 ? live.previousClose : data.prevClose;
        data.changeAbs = data.price - data.prevClose;
        data.changePct = live.changePct;
        data.volume = live.volume > 0 ? live.volume : data.volume;
        data.asOf = live.asOf || Date.now();
        data.technicals = {
          ...technicalScore(data.price, data.technicals.sma20, data.technicals.sma50, data.technicals.rsi),
          rsi: data.technicals.rsi,
          sma20: data.technicals.sma20,
          sma50: data.technicals.sma50,
        };
      }
      cache.set(marketId, { at: Date.now(), data });
      return data;
    }
    const livePx = await fetchMarkUsd(marketId);
    if (livePx && livePx > 0 && bars.length) {
      bars[bars.length - 1] = { ...bars[bars.length - 1], close: livePx, t: Date.now() };
    }
    const data = fromBars(market, bars, true);
    if (data) data.asOf = Date.now();
    cache.set(marketId, { at: Date.now(), data });
    return data;
  } catch {
    cache.set(marketId, { at: Date.now(), data: hit?.data ?? null });
    return hit?.data ?? null;
  }
}
