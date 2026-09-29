import { MARKETS, PLATFORM_FEE_BPS, type MarketConfig } from "@/config";
import { MARKET_LABELS } from "@/config/labels";
import { EQUITY_TICKERS, isEquityMarket } from "./marks";

export type MarketInfoNews = {
  title: string;
  publisher: string;
  publishedAt: number;
  url: string;
};

export type MarketInfoPayload = {
  marketId: number;
  name: string;
  about: string;
  stats: {
    marketCap: number | null;
    peRatio: number | null;
    dividendYield: number | null;
    eps: number | null;
    enterpriseValue: number | null;
    fcf: number | null;
  };
  news: MarketInfoNews[];
  trading: {
    tickSize: number;
    maxLeverage: number;
    initialMarginPct: number;
    maintenanceMarginPct: number;
    liquidationFeePct: number;
    platformFeePct: number;
  };
};

const CACHE_MS = 60_000;
const cache = new Map<number, { at: number; data: MarketInfoPayload | null }>();

function marketOf(id: number): MarketConfig | undefined {
  return Object.values(MARKETS).find((m) => m.marketId === id);
}

function rawNum(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (v && typeof v === "object" && "raw" in v) {
    const n = (v as { raw?: unknown }).raw;
    if (typeof n === "number" && Number.isFinite(n)) return n;
  }
  return null;
}

type YahooQuoteResult = {
  price?: { marketCap?: unknown; longName?: string; shortName?: string };
  summaryDetail?: { trailingPE?: unknown; dividendYield?: unknown };
  defaultKeyStatistics?: { trailingEps?: unknown; enterpriseValue?: unknown };
  financialData?: { freeCashflow?: unknown };
  assetProfile?: { longBusinessSummary?: string };
};

type YahooSearch = {
  news?: Array<{
    title?: string;
    publisher?: string;
    providerPublishTime?: number;
    link?: string;
  }>;
};

const YAHOO_UA = { "User-Agent": "Mozilla/5.0" };

let yahooSession: { cookie: string; crumb: string; at: number } | null = null;

async function yahooAuth(): Promise<{ cookie: string; crumb: string } | null> {
  if (yahooSession && Date.now() - yahooSession.at < 20 * 60_000) return yahooSession;
  try {
    const fc = await fetch("https://fc.yahoo.com", {
      redirect: "manual",
      headers: YAHOO_UA,
    });
    const setCookies =
      typeof fc.headers.getSetCookie === "function"
        ? fc.headers.getSetCookie()
        : [fc.headers.get("set-cookie") ?? ""];
    const cookie = setCookies
      .filter(Boolean)
      .map((c) => c.split(";")[0])
      .join("; ");
    const crumbRes = await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", {
      cache: "no-store",
      headers: { ...YAHOO_UA, Cookie: cookie },
    });
    const crumb = (await crumbRes.text()).trim();
    if (!crumb || crumb.startsWith("<") || crumb.includes(" ")) return yahooSession;
    yahooSession = { cookie, crumb, at: Date.now() };
    return yahooSession;
  } catch {
    return yahooSession;
  }
}

async function yahooQuote(ticker: string): Promise<YahooQuoteResult | undefined> {
  const auth = await yahooAuth();
  if (!auth) return undefined;
  const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=price,summaryDetail,defaultKeyStatistics,financialData,assetProfile&crumb=${encodeURIComponent(auth.crumb)}`;
  const res = await fetch(url, {
    cache: "no-store",
    headers: { ...YAHOO_UA, Cookie: auth.cookie },
  });
  if (!res.ok) {
    yahooSession = null;
    return undefined;
  }
  const json = (await res.json()) as { quoteSummary?: { result?: YahooQuoteResult[] }; finance?: { error?: unknown } };
  if (!json.quoteSummary?.result?.[0]) {
    yahooSession = null;
    return undefined;
  }
  return json.quoteSummary.result[0];
}

async function yahooNews(ticker: string): Promise<MarketInfoNews[]> {
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(ticker)}&quotesCount=0&newsCount=8`,
      { cache: "no-store", headers: YAHOO_UA },
    );
    if (!res.ok) return [];
    const json = (await res.json()) as YahooSearch;
    return (json.news ?? [])
      .filter((n) => n.title && n.link)
      .map((n) => ({
        title: n.title!,
        publisher: n.publisher ?? "",
        publishedAt: (n.providerPublishTime ?? 0) * 1000,
        url: n.link!,
      }));
  } catch {
    return [];
  }
}

function tradingOf(market: MarketConfig) {
  return {
    tickSize: market.tickSizes[0] ?? 0.01,
    maxLeverage: Math.round(market.maxLeverageBps / 10_000),
    initialMarginPct: market.initialMarginBps / 100,
    maintenanceMarginPct: market.maintenanceMarginBps / 100,
    liquidationFeePct: market.liquidationFeeBps / 100,
    platformFeePct: PLATFORM_FEE_BPS / 100,
  };
}

export async function fetchMarketInfo(marketId: number): Promise<MarketInfoPayload | null> {
  const hit = cache.get(marketId);
  if (hit && Date.now() - hit.at < CACHE_MS) {
    const emptyEquity = hit.data && isEquityMarket(marketId) && hit.data.stats.marketCap == null;
    if (!emptyEquity) return hit.data;
  }
  const market = marketOf(marketId);
  if (!market) {
    cache.set(marketId, { at: Date.now(), data: null });
    return null;
  }
  const label = MARKET_LABELS[market.symbol];
  const fallback: MarketInfoPayload = {
    marketId,
    name: label?.name ?? market.baseAsset,
    about: label?.about ?? `${market.baseAsset} perpetual on FloyDex.`,
    stats: {
      marketCap: null,
      peRatio: null,
      dividendYield: null,
      eps: null,
      enterpriseValue: null,
      fcf: null,
    },
    news: [],
    trading: tradingOf(market),
  };
  try {
    if (!isEquityMarket(marketId)) {
      cache.set(marketId, { at: Date.now(), data: fallback });
      return fallback;
    }
    const ticker = EQUITY_TICKERS[marketId] ?? market.baseAsset;
    const [quote, news] = await Promise.all([yahooQuote(ticker), yahooNews(ticker)]);
    const yieldRaw = rawNum(quote?.summaryDetail?.dividendYield);
    const data: MarketInfoPayload = {
      ...fallback,
      name: quote?.price?.longName ?? quote?.price?.shortName ?? fallback.name,
      about: quote?.assetProfile?.longBusinessSummary ?? fallback.about,
      stats: {
        marketCap: rawNum(quote?.price?.marketCap),
        peRatio: rawNum(quote?.summaryDetail?.trailingPE),
        dividendYield: yieldRaw != null ? yieldRaw * 100 : quote ? 0 : null,
        eps: rawNum(quote?.defaultKeyStatistics?.trailingEps),
        enterpriseValue: rawNum(quote?.defaultKeyStatistics?.enterpriseValue),
        fcf: rawNum(quote?.financialData?.freeCashflow),
      },
      news,
    };
    cache.set(marketId, { at: Date.now(), data });
    return data;
  } catch {
    cache.set(marketId, { at: Date.now(), data: hit?.data ?? fallback });
    return hit?.data ?? fallback;
  }
}
