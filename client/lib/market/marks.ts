import { MARKETS, PRICE_PRECISION } from "@/config";

/** Scale a USD price to 1e18 without overflowing JS Number. */
export function usdToPriceRaw(usd: number): bigint {
  if (!Number.isFinite(usd) || usd <= 0) return 0n;
  const cents = Math.round(usd * 1e8);
  return BigInt(cents) * (PRICE_PRECISION / 100_000_000n);
}

export const EQUITY_TICKERS: Record<number, string> = {
  9: "TSLA",
  10: "NVDA",
  11: "AAPL",
  12: "SPY",
  13: "META",
  14: "AMZN",
  15: "QQQ",
  16: "MSFT",
  17: "COIN",
  18: "MSTR",
};

const FALLBACK: Record<number, number> = {
  1: 0.22,
  2: 65_000,
  3: 3_200,
  4: 150,
  5: 0.55,
  6: 0.45,
  7: 600,
  8: 0.12,
  9: 430,
  10: 180,
  11: 230,
  12: 570,
  13: 580,
  14: 190,
  15: 480,
  16: 420,
  17: 220,
  18: 340,
};

function marketOf(id: number) {
  return Object.values(MARKETS).find((m) => m.marketId === id);
}

export function isEquityMarket(id: number): boolean {
  return Boolean(EQUITY_TICKERS[id] || marketOf(id)?.kind === "equity");
}

type YahooMeta = {
  regularMarketPrice?: number;
  regularMarketTime?: number;
  regularMarketDayHigh?: number;
  regularMarketDayLow?: number;
  previousClose?: number;
  regularMarketVolume?: number;
  chartPreviousClose?: number;
  preMarketPrice?: number;
  preMarketTime?: number;
  postMarketPrice?: number;
  postMarketTime?: number;
};

export type YahooLivePrint = { price: number; asOf: number };

/** Newest Yahoo print. Extended hours live on the 1m bar, not regularMarketPrice. */
export function pickYahooLivePrice(input: {
  lastBarClose?: number | null;
  lastBarTime?: number | null;
  regularMarketPrice?: number | null;
  regularMarketTime?: number | null;
  preMarketPrice?: number | null;
  preMarketTime?: number | null;
  postMarketPrice?: number | null;
  postMarketTime?: number | null;
}): YahooLivePrint | null {
  const cands: YahooLivePrint[] = [];
  const add = (price?: number | null, timeSec?: number | null) => {
    if (!(price && price > 0)) return;
    const asOf = timeSec && timeSec > 0 ? timeSec * 1000 : 0;
    cands.push({ price, asOf });
  };
  add(input.lastBarClose, input.lastBarTime);
  add(input.preMarketPrice, input.preMarketTime);
  add(input.postMarketPrice, input.postMarketTime);
  add(input.regularMarketPrice, input.regularMarketTime);
  if (!cands.length) return null;
  cands.sort((a, b) => b.asOf - a.asOf || b.price - a.price);
  return cands[0];
}

type YahooQuote = {
  price: number;
  asOf: number;
  previousClose: number;
  volume: number;
  high: number;
  low: number;
  spark: number[];
};

/** Evenly sample positive closes down to `n` points for a 24h sparkline. */
export function downsampleSpark(closes: Array<number | null | undefined>, n = 24): number[] {
  const pts: number[] = [];
  for (const c of closes) {
    if (typeof c === "number" && Number.isFinite(c) && c > 0) pts.push(c);
  }
  if (pts.length <= n) return pts;
  if (n <= 1) return pts.slice(-1);
  const out: number[] = [];
  const last = pts.length - 1;
  for (let i = 0; i < n; i++) {
    out.push(pts[Math.round((i * last) / (n - 1))]);
  }
  return out;
}

const yahooCache = new Map<string, { at: number; quote: YahooQuote | null }>();

async function yahooChart(ticker: string): Promise<YahooQuote | null> {
  const hit = yahooCache.get(ticker);
  if (hit && Date.now() - hit.at < 3_000) return hit.quote;
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1m&range=1d&includePrePost=true`,
      { cache: "no-store", headers: { "User-Agent": "FloyDex/1.0" } },
    );
    if (!res.ok) {
      yahooCache.set(ticker, { at: Date.now(), quote: hit?.quote ?? null });
      return hit?.quote ?? null;
    }
    const json = (await res.json()) as {
      chart?: {
        result?: {
          meta?: YahooMeta;
          timestamp?: number[];
          indicators?: { quote?: { close?: (number | null)[]; volume?: (number | null)[] }[] };
        }[];
      };
    };
    const result = json.chart?.result?.[0];
    const meta = result?.meta;
    const ts = result?.timestamp ?? [];
    const closes = result?.indicators?.quote?.[0]?.close ?? [];
    const vols = result?.indicators?.quote?.[0]?.volume ?? [];
    let lastBarClose: number | null = null;
    let lastBarTime: number | null = null;
    let high = 0;
    let low = Number.POSITIVE_INFINITY;
    let volume = 0;
    const sparkCloses: number[] = [];
    for (let i = 0; i < ts.length; i++) {
      const c = closes[i];
      const v = vols[i];
      if (v && v > 0) volume += v;
      if (!(c && c > 0)) continue;
      sparkCloses.push(c);
      lastBarClose = c;
      lastBarTime = ts[i];
      if (c > high) high = c;
      if (c < low) low = c;
    }
    const live = pickYahooLivePrice({
      lastBarClose,
      lastBarTime,
      regularMarketPrice: meta?.regularMarketPrice,
      regularMarketTime: meta?.regularMarketTime,
      preMarketPrice: meta?.preMarketPrice,
      preMarketTime: meta?.preMarketTime,
      postMarketPrice: meta?.postMarketPrice,
      postMarketTime: meta?.postMarketTime,
    });
    if (!live) {
      yahooCache.set(ticker, { at: Date.now(), quote: null });
      return null;
    }
    const prev = meta?.previousClose ?? meta?.chartPreviousClose ?? live.price;
    const quote: YahooQuote = {
      price: live.price,
      asOf: live.asOf || Date.now(),
      previousClose: prev > 0 ? prev : live.price,
      volume: meta?.regularMarketVolume && meta.regularMarketVolume > 0 ? meta.regularMarketVolume : volume,
      high: high > 0 ? high : live.price,
      low: Number.isFinite(low) ? low : live.price,
      spark: downsampleSpark(sparkCloses, 24),
    };
    yahooCache.set(ticker, { at: Date.now(), quote });
    return quote;
  } catch {
    yahooCache.set(ticker, { at: Date.now(), quote: hit?.quote ?? null });
    return hit?.quote ?? null;
  }
}

async function yahooLast(ticker: string): Promise<number | null> {
  const q = await yahooChart(ticker);
  return q && q.price > 0 ? q.price : null;
}

export async function fetchYahoo24h(marketId: number): Promise<{
  price: number;
  highPrice: number;
  lowPrice: number;
  changePct: number;
  volume: number;
  asOf: number;
  previousClose: number;
  spark: number[];
} | null> {
  const m = marketOf(marketId);
  if (!m || !isEquityMarket(marketId)) return null;
  const ticker = EQUITY_TICKERS[marketId] ?? m.baseAsset;
  const q = await yahooChart(ticker);
  if (!q || !(q.price > 0)) return null;
  const prev = q.previousClose > 0 ? q.previousClose : q.price;
  return {
    price: q.price,
    highPrice: q.high,
    lowPrice: q.low,
    changePct: prev > 0 ? ((q.price - prev) / prev) * 100 : 0,
    volume: q.volume,
    asOf: q.asOf,
    previousClose: prev,
    spark: q.spark,
  };
}

/**
 * Spot hosts. `api.binance.com` is often blocked from cloud/Vercel IPs (451 /
 * empty); `data-api.binance.vision` is the public market-data mirror and works
 * from most serverless regions. `api.binance.us` is a last-resort US endpoint
 * (subset of pairs).
 */
const BINANCE_SPOT_HOSTS = [
  "https://data-api.binance.vision",
  "https://api.binance.com",
  "https://api.binance.us",
] as const;

async function binanceSpotFetch(path: string): Promise<Response | null> {
  for (const host of BINANCE_SPOT_HOSTS) {
    try {
      const res = await fetch(`${host}${path}`, { cache: "no-store" });
      if (res.ok) return res;
    } catch {
      /* try next host */
    }
  }
  return null;
}

async function binanceLast(pair: string): Promise<number | null> {
  try {
    const res = await binanceSpotFetch(`/api/v3/ticker/price?symbol=${pair}`);
    if (!res) return null;
    const data = (await res.json()) as { price?: string };
    const px = parseFloat(data.price ?? "");
    return px > 0 ? px : null;
  } catch {
    return null;
  }
}

const markCache = new Map<number, { at: number; px: number | null }>();

/** Live mark: equities via Yahoo (Binance RWA when listed), crypto via Binance. */
export async function fetchMarkUsd(marketId: number): Promise<number | null> {
  const hit = markCache.get(marketId);
  if (hit && Date.now() - hit.at < 2_500) return hit.px;
  const m = marketOf(marketId);
  if (!m) {
    const fb = FALLBACK[marketId] ?? null;
    markCache.set(marketId, { at: Date.now(), px: fb });
    return fb;
  }
  let px: number | null = null;
  if (isEquityMarket(marketId)) {
    const ticker = EQUITY_TICKERS[marketId] ?? m.baseAsset;
    px = await yahooLast(ticker);
  } else {
    px = await binanceLast(m.priceSourceSymbol);
  }
  px = px ?? FALLBACK[marketId] ?? null;
  markCache.set(marketId, { at: Date.now(), px });
  return px;
}

export async function fetchMarksUsd(): Promise<Record<number, number>> {
  const ids = Object.values(MARKETS).map((m) => m.marketId);
  const out: Record<number, number> = {};
  await Promise.all(
    ids.map(async (id) => {
      const px = await fetchMarkUsd(id);
      if (px) out[id] = px;
    }),
  );
  return out;
}

export type MarketTicker24h = {
  high: number;
  low: number;
  changePct: number;
  volumeUsd: number;
  /** Share count for equities; unused for crypto (quote volume lives in volumeUsd). */
  volume?: number;
  openInterestUsd: number;
  fundingRate?: number;
  /** ~24 closes over the last day for the markets-page sparkline. */
  spark?: number[];
};

async function binance24h(pair: string): Promise<{
  last: number;
  high: number;
  low: number;
  changePct: number;
  volumeUsd: number;
} | null> {
  try {
    const res = await binanceSpotFetch(`/api/v3/ticker/24hr?symbol=${pair}`);
    if (!res) return null;
    const d = (await res.json()) as {
      lastPrice?: string;
      highPrice?: string;
      lowPrice?: string;
      priceChangePercent?: string;
      quoteVolume?: string;
    };
    const last = parseFloat(d.lastPrice ?? "");
    const high = parseFloat(d.highPrice ?? "");
    const low = parseFloat(d.lowPrice ?? "");
    const changePct = parseFloat(d.priceChangePercent ?? "");
    const volumeUsd = parseFloat(d.quoteVolume ?? "");
    if (!(last > 0)) return null;
    return {
      last,
      high: high > 0 ? high : last,
      low: low > 0 ? low : last,
      changePct: Number.isFinite(changePct) ? changePct : 0,
      volumeUsd: volumeUsd > 0 ? volumeUsd : 0,
    };
  } catch {
    return null;
  }
}

const sparkCache = new Map<string, { at: number; pts: number[] }>();

async function binanceSpark(pair: string): Promise<number[]> {
  const hit = sparkCache.get(pair);
  if (hit && Date.now() - hit.at < 20_000) return hit.pts;
  try {
    const res = await binanceSpotFetch(
      `/api/v3/klines?symbol=${pair}&interval=1h&limit=24`,
    );
    if (!res) return hit?.pts ?? [];
    const rows = (await res.json()) as [number, string, string, string, string][];
    const pts = rows
      .map((r) => parseFloat(r[4]))
      .filter((n) => Number.isFinite(n) && n > 0);
    sparkCache.set(pair, { at: Date.now(), pts });
    return pts;
  } catch {
    return hit?.pts ?? [];
  }
}

async function binanceFuturesOiUsd(pair: string, last: number): Promise<number> {
  try {
    const res = await fetch(
      `https://fapi.binance.com/fapi/v1/openInterest?symbol=${pair}`,
      { cache: "no-store" },
    );
    if (!res.ok) return 0;
    const d = (await res.json()) as { openInterest?: string };
    const qty = parseFloat(d.openInterest ?? "");
    return qty > 0 && last > 0 ? qty * last : 0;
  } catch {
    return 0;
  }
}

let tickerCache: { at: number; data: Record<number, MarketTicker24h> } | null = null;

let fundingCache: { at: number; data: Record<string, number> } | null = null;

async function binanceFundingMap(): Promise<Record<string, number>> {
  if (fundingCache && Date.now() - fundingCache.at < 20_000) return fundingCache.data;
  try {
    const res = await fetch("https://fapi.binance.com/fapi/v1/premiumIndex", { cache: "no-store" });
    if (!res.ok) return fundingCache?.data ?? {};
    const rows = (await res.json()) as { symbol?: string; lastFundingRate?: string }[];
    const data: Record<string, number> = {};
    for (const r of rows) {
      const n = parseFloat(r.lastFundingRate ?? "");
      if (r.symbol && Number.isFinite(n)) data[r.symbol] = n * 100;
    }
    fundingCache = { at: Date.now(), data };
    return data;
  } catch {
    return fundingCache?.data ?? {};
  }
}

/** 24h high/low/change/volume/OI for every listed market. */
export async function fetchAllMarketTickers(): Promise<Record<number, MarketTicker24h>> {
  if (tickerCache && Date.now() - tickerCache.at < 8_000) return tickerCache.data;
  const out: Record<number, MarketTicker24h> = {};
  const funding = await binanceFundingMap();
  await Promise.all(
    Object.values(MARKETS).map(async (m) => {
      const fund = funding[m.priceSourceSymbol] ?? funding[`${m.baseAsset}USDT`];
      if (isEquityMarket(m.marketId)) {
        const y = await fetchYahoo24h(m.marketId);
        if (!y) return;
        const volumeUsd = y.volume > 0 ? y.volume * y.price : 0;
        out[m.marketId] = {
          high: y.highPrice,
          low: y.lowPrice,
          changePct: y.changePct,
          volumeUsd,
          volume: y.volume,
          openInterestUsd: 0,
          spark: y.spark,
        };
        return;
      }
      const [row, spark] = await Promise.all([
        binance24h(m.priceSourceSymbol),
        binanceSpark(m.priceSourceSymbol),
      ]);
      if (!row) return;
      const oi = await binanceFuturesOiUsd(m.priceSourceSymbol, row.last);
      out[m.marketId] = {
        high: row.high,
        low: row.low,
        changePct: row.changePct,
        volumeUsd: row.volumeUsd,
        openInterestUsd: oi > 0 ? oi : row.volumeUsd,
        fundingRate: fund,
        spark,
      };
    }),
  );
  tickerCache = { at: Date.now(), data: out };
  return out;
}

export type VenueTrade = {
  price: string;
  size: string;
  side: "buy" | "sell";
  timestamp: number;
};

const tradeCache = new Map<number, { at: number; rows: VenueTrade[] }>();

async function binanceTrades(pair: string): Promise<VenueTrade[]> {
  const res = await binanceSpotFetch(`/api/v3/trades?symbol=${pair}&limit=50`);
  if (!res) return [];
  const rows = (await res.json()) as {
    price: string;
    qty: string;
    time: number;
    isBuyerMaker: boolean;
  }[];
  return rows
    .map((r) => ({
      price: r.price,
      size: r.qty,
      side: (r.isBuyerMaker ? "sell" : "buy") as "buy" | "sell",
      timestamp: r.time,
    }))
    .reverse();
}

async function yahooMinuteTape(ticker: string): Promise<VenueTrade[]> {
  const res = await fetch(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1m&range=1d&includePrePost=true`,
    { cache: "no-store", headers: { "User-Agent": "FloyDex/1.0" } },
  );
  if (!res.ok) return [];
  const json = (await res.json()) as {
    chart?: {
      result?: {
        timestamp?: number[];
        indicators?: { quote?: { close?: (number | null)[]; open?: (number | null)[]; volume?: (number | null)[] }[] };
      }[];
    };
  };
  const result = json.chart?.result?.[0];
  const ts = result?.timestamp ?? [];
  const q = result?.indicators?.quote?.[0];
  const closes = q?.close ?? [];
  const opens = q?.open ?? [];
  const vols = q?.volume ?? [];
  const out: VenueTrade[] = [];
  for (let i = ts.length - 1; i >= 0 && out.length < 50; i--) {
    const px = closes[i] ?? opens[i];
    const vol = vols[i];
    if (!(px && px > 0) || !(vol && vol > 0)) continue;
    const prev = (i > 0 ? closes[i - 1] ?? opens[i - 1] : opens[i]) ?? px;
    out.push({
      price: String(px),
      size: String(vol),
      side: px >= (prev ?? px) ? "buy" : "sell",
      timestamp: ts[i] * 1000,
    });
  }
  return out;
}

/** Live tape: Binance prints for crypto, Yahoo 1m bars for equities. */
export async function fetchVenueTrades(marketId: number): Promise<VenueTrade[]> {
  const hit = tradeCache.get(marketId);
  if (hit && Date.now() - hit.at < 6_000) return hit.rows;
  const m = marketOf(marketId);
  if (!m) return [];
  try {
    const rows = isEquityMarket(marketId)
      ? await yahooMinuteTape(EQUITY_TICKERS[marketId] ?? m.baseAsset)
      : await binanceTrades(m.priceSourceSymbol);
    tradeCache.set(marketId, { at: Date.now(), rows });
    return rows;
  } catch {
    tradeCache.set(marketId, { at: Date.now(), rows: hit?.rows ?? [] });
    return hit?.rows ?? [];
  }
}
