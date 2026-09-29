import { NextRequest, NextResponse } from "next/server";
import { MARKETS } from "@/config";
import { fetchMarketInfo } from "@/lib/market/info";
import { fetchAllMarketTickers, fetchMarksUsd, isEquityMarket } from "@/lib/market/marks";
import { fetchSymbolDetails, compactStat } from "@/lib/market/symbol-details";
import { listCallouts } from "@/lib/market/callouts-store";
import { completeChat } from "@/lib/market/llm";
import {
  clampChatHistory,
  fearClass,
  greedFromChange,
  localBullets,
  meterFromTechnicals,
  parseAnalysisPayload,
  parseLlmJson,
  sanitizeQuestion,
  stanceFromTechnicals,
  tapeSummary,
  type AiAnalysis,
} from "@/lib/market/ai-analysis";
import { bodyTooLarge, clientIp, rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const maxDuration = 60;

const CACHE_VER = 6;
type CacheRow = { at: number; data: AiAnalysis };
const cache = new Map<string, CacheRow>();
const CACHE_MS = 3 * 60_000;

type Fng = { value: number; label: string };
let fngCache: { at: number; data: Fng | null } = { at: 0, data: null };

async function cryptoFear(): Promise<Fng | null> {
  if (fngCache.data && Date.now() - fngCache.at < 10 * 60_000) return fngCache.data;
  try {
    const res = await fetch("https://api.alternative.me/fng/?limit=1", { cache: "no-store" });
    if (!res.ok) return fngCache.data;
    const json = (await res.json()) as { data?: { value?: string; value_classification?: string }[] };
    const row = json.data?.[0];
    const value = Number(row?.value);
    if (!Number.isFinite(value)) return fngCache.data;
    const data = { value, label: row?.value_classification ?? fearClass(value) };
    fngCache = { at: Date.now(), data };
    return data;
  } catch {
    return fngCache.data;
  }
}

async function marketContext(marketId: number) {
  const market = Object.values(MARKETS).find((m) => m.marketId === marketId);
  if (!market) return null;
  const equity = isEquityMarket(marketId);
  const [tickers, marks, info, fng, details] = await Promise.all([
    fetchAllMarketTickers(),
    fetchMarksUsd(),
    fetchMarketInfo(marketId),
    equity ? Promise.resolve(null) : cryptoFear(),
    fetchSymbolDetails(marketId),
  ]);
  const ticker = tickers[marketId];
  const last = marks[marketId] ?? details?.price ?? null;
  const posts = listCallouts(marketId, "top");
  const longs = posts.filter((p) => p.side === "long").map((p) => p.text);
  const shorts = posts.filter((p) => p.side === "short").map((p) => p.text);
  const news = (info?.news ?? []).map((n) => n.title);
  const change = ticker?.changePct ?? details?.changePct ?? null;
  const volumeShares = equity ? (details?.volume ?? ticker?.volume ?? null) : null;
  const tech = details?.technicals;
  const meter = equity && tech
    ? meterFromTechnicals(tech.score, tech.label)
    : {
        kind: "fng" as const,
        value: fng?.value ?? greedFromChange(change ?? 0),
        label: fng?.label ?? fearClass(fng?.value ?? greedFromChange(change ?? 0)),
        source: fng ? "alternative.me" : "24h change",
      };
  const tape = [
    `FloyDex ${market.symbol} (${market.baseAsset} ${equity ? "equity" : "crypto"} USDT perp).`,
    `Use ONLY these venue numbers — they match the header, the symbol panel, and the 24h tape. TradingView 1h candle OHLC and bar volume are a different timeframe; do not cite them.`,
    `Last ${last ?? "n/a"}. 24h change ${change ?? "n/a"}%${details ? ` (${details.changeAbs >= 0 ? "+" : ""}${details.changeAbs.toFixed(2)})` : ""}.`,
    `24h high ${ticker?.high ?? "n/a"} / 24h low ${ticker?.low ?? "n/a"}.`,
    equity
      ? `Session: ${details?.sessionLabel ?? "n/a"}. Volume ${volumeShares ? compactStat(volumeShares) : "n/a"} shares (notional ${ticker?.volumeUsd ? compactStat(ticker.volumeUsd) : "n/a"} USD). Avg 30D volume ${details?.avgVolume30d ? compactStat(details.avgVolume30d) : "n/a"} shares. Do not call share volume a dollar volume.`
      : `Funding ${ticker?.fundingRate ?? "n/a"}%. Volume USD ${ticker?.volumeUsd ?? "n/a"}.`,
    equity && tech
      ? `Technicals (same as the symbol panel): ${tech.label}. RSI14 ${tech.rsi ?? "n/a"}. SMA20 ${tech.sma20 ?? "n/a"}. SMA50 ${tech.sma50 ?? "n/a"}. Last above an SMA is support, not resistance. A 24h red day is a pullback if technicals are buy — do not flip the regime to fear/sell.`
      : `Greed & Fear ${meter.value} ${meter.label} (${meter.source}).`,
    details?.performance
      ? `Performance 1W ${details.performance["1W"] ?? "n/a"}% / 1M ${details.performance["1M"] ?? "n/a"}%.`
      : "",
    news.length ? `Headlines: ${news.slice(0, 6).join(" | ")}` : "No headlines.",
    longs.length ? `Desk longs: ${longs.slice(0, 3).join(" | ")}` : "",
    shorts.length ? `Desk shorts: ${shorts.slice(0, 3).join(" | ")}` : "",
    `Do not say a 24h low below last is a support breach. Last above the low is holding support.`,
    equity ? "Do not mention perpetual funding on this equity." : "",
  ]
    .filter(Boolean)
    .join(" ");
  return {
    market,
    ticker,
    last,
    longs,
    shorts,
    news,
    change,
    equity,
    volumeShares,
    meter,
    tech,
    tape,
  };
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const marketId = parseInt(id, 10);
  if (!marketId) return NextResponse.json({ error: "invalid_market" }, { status: 400 });
  const market = Object.values(MARKETS).find((m) => m.marketId === marketId);
  if (!market) return NextResponse.json({ error: "unknown_market" }, { status: 404 });

  if (!(await rateLimit(`ai:${clientIp(req)}:${marketId}`, 30))) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  const cacheKey = `${CACHE_VER}:${marketId}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_MS) {
    return NextResponse.json(hit.data, { headers: { "Cache-Control": "no-store" } });
  }

  const ctx = await marketContext(marketId);
  if (!ctx) return NextResponse.json({ error: "unknown_market" }, { status: 404 });

  const fallbackBullets = localBullets({
    base: ctx.market.baseAsset,
    price: ctx.last,
    changePct: ctx.change,
    high: ctx.ticker?.high ?? null,
    low: ctx.ticker?.low ?? null,
    fundingRate: ctx.equity ? null : ctx.ticker?.fundingRate ?? null,
    volumeUsd: ctx.ticker?.volumeUsd ?? null,
    volumeShares: ctx.volumeShares,
    equity: ctx.equity,
    news: ctx.news,
    longPosts: ctx.longs,
    shortPosts: ctx.shorts,
  });

  let summary = tapeSummary(ctx.market.baseAsset, ctx.change, ctx.last);
  let stance: AiAnalysis["stance"] = ctx.tech
    ? stanceFromTechnicals(ctx.tech.label)
    : ctx.change != null && ctx.change < -0.4 ? "bearish" : ctx.change != null && ctx.change > 0.4 ? "bullish" : "neutral";
  let bullets = fallbackBullets;
  let source = "tape";
  let llm = false;

  const reply = await completeChat(
    [
      {
        role: "system",
        content:
          "You are the FloyDex perp desk. Numbers-first. No hype. No investment advice. Use only the tape you are given.",
      },
      {
        role: "user",
        content: [
          ctx.tape,
          'Reply JSON only: {"summary":"2-3 sentences","stance":"bullish|bearish|neutral","bullish":["...","...","..."],"bearish":["...","...","..."]}.',
          "Three short factual bullets per side. Plain text only — no emoji, no hashtags, no 'post' counts.",
          "Mention last, 24h change, and one real 24h level. Do not invent USD volume from share count. Do not contradict venue technicals. Do not treat an SMA below last as resistance.",
        ].join(" "),
      },
    ],
    { maxTokens: 420 },
  );
  if (reply) {
    const parsed = parseAnalysisPayload(parseLlmJson(reply.text), {
      long: ctx.longs.length,
      short: ctx.shorts.length,
    });
    source = reply.provider;
    llm = true;
    if (parsed) {
      summary = parsed.summary || summary;
      stance = ctx.tech ? stanceFromTechnicals(ctx.tech.label) : parsed.stance;
      bullets = {
        bullish: parsed.bullish.length ? parsed.bullish : fallbackBullets.bullish,
        bearish: parsed.bearish.length ? parsed.bearish : fallbackBullets.bearish,
      };
    } else {
      summary = reply.text.replace(/\s+/g, " ").trim().slice(0, 480) || summary;
    }
  }

  const data: AiAnalysis = {
    marketId,
    symbol: ctx.market.symbol,
    base: ctx.market.baseAsset,
    generatedAt: Date.now(),
    meter: ctx.meter,
    summary,
    stance,
    bullish: bullets.bullish,
    bearish: bullets.bearish,
    source,
    llm,
  };
  cache.set(cacheKey, { at: Date.now(), data });
  return NextResponse.json(data, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const marketId = parseInt(id, 10);
  if (!marketId) return NextResponse.json({ error: "invalid_market" }, { status: 400 });
  const market = Object.values(MARKETS).find((m) => m.marketId === marketId);
  if (!market) return NextResponse.json({ error: "unknown_market" }, { status: 404 });

  if (bodyTooLarge(req, 8_192)) {
    return NextResponse.json({ error: "payload_too_large" }, { status: 413 });
  }
  if (!(await rateLimit(`ai-chat:${clientIp(req)}:${marketId}`, 12))) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const rec = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const question = sanitizeQuestion(rec.question);
  if (!question) return NextResponse.json({ error: "invalid_question" }, { status: 400 });
  const history = clampChatHistory(rec.history);

  const ctx = await marketContext(marketId);
  if (!ctx) return NextResponse.json({ error: "unknown_market" }, { status: 404 });

  const reply = await completeChat(
    [
      {
        role: "system",
        content: [
          "You are the FloyDex desk AI, chatting like a concise trading assistant.",
          "Ground every answer in the live tape. No investment advice. Short paragraphs. One or two emojis max if they help.",
          ctx.tape,
        ].join(" "),
      },
      ...history,
      { role: "user", content: question },
    ],
    { maxTokens: 360 },
  );
  if (!reply) {
    return NextResponse.json({ error: "ai_unavailable" }, { status: 503 });
  }
  return NextResponse.json(
    { reply: reply.text, source: reply.provider, model: reply.model },
    { headers: { "Cache-Control": "no-store" } },
  );
}
