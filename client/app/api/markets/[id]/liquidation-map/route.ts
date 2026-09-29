import { NextRequest, NextResponse } from "next/server";
import { MARKETS } from "@/config";
import { isEquityMarket, fetchMarkUsd } from "@/lib/market/marks";
import {
  assembleLiqMap,
  binsFromAggregatedMap,
  ourbitPair,
  overlayVenueBins,
  type AggregatedMapRaw,
  type LiqMapPayload,
} from "@/lib/market/liquidation-map";
import { ensureVenueReady, listMarketPositions } from "@/lib/market/venue";

const cache = new Map<number, { at: number; data: LiqMapPayload }>();
const CACHE_MS = 12_000;
const OURBIT_MAP = "https://futures.ourbit.com/api/activity/contract/liquidation/aggregated_map";

const OURBIT_SOURCE =
  "OurBit aggregated map — CEX-wide OI + leverage levels (same feed as KCEX / OurBit Liq Heatmap)";

async function binanceOiUsd(pair: string, last: number): Promise<number> {
  try {
    const res = await fetch(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${pair}`, {
      cache: "no-store",
    });
    if (!res.ok) return 0;
    const d = (await res.json()) as { openInterest?: string };
    const qty = parseFloat(d.openInterest ?? "");
    return qty > 0 && last > 0 ? qty * last : 0;
  } catch {
    return 0;
  }
}

async function binanceLongShare(pair: string): Promise<number> {
  try {
    const res = await fetch(
      `https://fapi.binance.com/futures/data/topLongShortPositionRatio?symbol=${pair}&period=5m&limit=1`,
      { cache: "no-store" },
    );
    if (!res.ok) return 0.5;
    const rows = (await res.json()) as { longAccount?: string }[];
    const n = parseFloat(rows[0]?.longAccount ?? "");
    return n > 0 && n < 1 ? n : 0.5;
  } catch {
    return 0.5;
  }
}

async function binanceRange(pair: string, last: number): Promise<{ low: number; high: number }> {
  try {
    const res = await fetch(`https://fapi.binance.com/fapi/v1/ticker/24hr?symbol=${pair}`, {
      cache: "no-store",
    });
    if (!res.ok) return { low: last * 0.9, high: last * 1.1 };
    const d = (await res.json()) as { lowPrice?: string; highPrice?: string };
    const low = parseFloat(d.lowPrice ?? "");
    const high = parseFloat(d.highPrice ?? "");
    return {
      low: low > 0 ? low : last * 0.9,
      high: high > 0 ? high : last * 1.1,
    };
  } catch {
    return { low: last * 0.9, high: last * 1.1 };
  }
}

async function fetchOurbitMap(baseAsset: string): Promise<AggregatedMapRaw | null> {
  try {
    const res = await fetch(`${OURBIT_MAP}/${ourbitPair(baseAsset)}`, {
      cache: "no-store",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { code?: number; data?: AggregatedMapRaw };
    const data = json.data;
    if (json.code !== 0 || !data?.x?.length || !data.y?.length || !(data.lp > 0)) return null;
    return data;
  } catch {
    return null;
  }
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const marketId = parseInt(id, 10);
  if (!marketId) return NextResponse.json({ error: "invalid_market" }, { status: 400 });
  const hit = cache.get(marketId);
  if (hit && Date.now() - hit.at < CACHE_MS) {
    return NextResponse.json(hit.data, { headers: { "Cache-Control": "no-store" } });
  }
  const market = Object.values(MARKETS).find((m) => m.marketId === marketId);
  if (!market) return NextResponse.json({ error: "unknown_market" }, { status: 404 });
  if (isEquityMarket(marketId) || market.kind === "equity") {
    return NextResponse.json({ error: "no_equity_liq_map" }, { status: 404 });
  }

  const mark = (await fetchMarkUsd(marketId)) ?? 0;
  if (!(mark > 0)) return NextResponse.json({ error: "no_mark" }, { status: 503 });

  await ensureVenueReady();
  const venue = listMarketPositions(marketId);
  const maxLev = market.maxLeverageBps / 10_000;

  const aggregated = await fetchOurbitMap(market.baseAsset);
  if (aggregated) {
    const mapped = binsFromAggregatedMap(aggregated);
    const { points, venueUsd } = overlayVenueBins(
      mapped.points,
      mapped.mark,
      venue,
      market.maintenanceMarginBps,
    );
    const data: LiqMapPayload = {
      marketId,
      mark: mapped.mark || mark,
      source: OURBIT_SOURCE,
      updatedAt: aggregated.ts ?? Date.now(),
      points,
      venueUsd,
      oiUsd: points.reduce((s, p) => s + p.atUsd, 0),
    };
    cache.set(marketId, { at: Date.now(), data });
    return NextResponse.json(data, { headers: { "Cache-Control": "no-store" } });
  }

  let oiUsd = 0;
  let longShare = 0.5;
  let low = mark * 0.9;
  let high = mark * 1.1;
  let source = "FloyDex book";

  const pair = market.priceSourceSymbol;
  const [oi, share, range] = await Promise.all([
    binanceOiUsd(pair, mark),
    binanceLongShare(pair),
    binanceRange(pair, mark),
  ]);
  oiUsd = oi;
  longShare = share;
  low = range.low;
  high = range.high;
  source = oiUsd > 0
    ? "Binance USD-M open interest + long/short ratio (leverage-cluster estimate)"
    : "FloyDex book";

  const assembled = assembleLiqMap({
    mark,
    rangeLow: low,
    rangeHigh: high,
    mmBps: market.maintenanceMarginBps,
    maxLev: Math.max(maxLev, 100),
    oiUsd,
    longShare,
    venue,
  });

  const data: LiqMapPayload = {
    marketId,
    mark,
    source,
    updatedAt: Date.now(),
    points: assembled.points,
    venueUsd: assembled.venueUsd,
    oiUsd,
  };
  cache.set(marketId, { at: Date.now(), data });
  return NextResponse.json(data, { headers: { "Cache-Control": "no-store" } });
}
