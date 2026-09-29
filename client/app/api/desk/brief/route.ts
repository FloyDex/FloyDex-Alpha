import { NextResponse } from "next/server";
import { ACTIVE_MARKETS, NETWORK_LABEL } from "@/config";

export const runtime = "nodejs";

const USEPOD_TOKEN = process.env.USEPOD_API_TOKEN ?? "";
const USEPOD_URL = USEPOD_TOKEN
  ? `https://api.usepod.ai/proxy/${USEPOD_TOKEN}/v1/chat/completions`
  : "";

function localBrief(symbol: string, session: string): string {
  const market = ACTIVE_MARKETS[symbol];
  const lev = market ? (market.maxLeverageBps / 10_000).toFixed(0) : "—";
  return [
    `FloyDex desk · ${NETWORK_LABEL} · ${symbol || "SOL-PERP"}`,
    `Session: ${session}. Stock-hours risk still applies off the tape — size down in Extended, do not add risk in Closed or Halted.`,
    `Max leverage ${lev}x. Settlement is USDC. Tokenized stocks are margin; the book is off-chain and fills settle on Solana.`,
    `UsePod inference is not funded yet — this brief is the local session/risk path. Fund the UsePod dashboard to route the same prompt through the marketplace.`,
  ].join(" ");
}

export async function POST(req: Request) {
  let symbol = "SOL-PERP";
  let session = "Regular";
  try {
    const body = (await req.json()) as { symbol?: string; session?: string };
    if (typeof body.symbol === "string") symbol = body.symbol.toUpperCase();
    if (typeof body.session === "string") session = body.session;
  } catch {
    // empty body is fine
  }

  const prompt = [
    "You are the FloyDex desk: session-aware tokenized-stock perps on Solana.",
    "Numbers-first. No hype. No token shilling. No advice to launch a coin.",
    `Market ${symbol}. Assumed session ${session}. Venue ${NETWORK_LABEL}.`,
    "In 4 short sentences: (1) what FloyDex is, (2) what this session means for margin,",
    "(3) what to check before size (mark, funding, health), (4) remind that settlement is on-chain USDC.",
  ].join(" ");

  if (!USEPOD_URL) {
    return NextResponse.json({
      source: "local",
      route: null,
      text: localBrief(symbol, session),
    });
  }

  try {
    const upstream = await fetch(USEPOD_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "deepseek-v3.2",
        max_tokens: 220,
        messages: [{ role: "user", content: prompt }],
        usepod: { routes: ["marketplace", "commercial"], fallback: "explicit" },
      }),
    });

    const route = upstream.headers.get("x-pod-route");
    const balance = upstream.headers.get("x-balance-remaining");

    if (!upstream.ok) {
      return NextResponse.json({
        source: "usepod-fallback",
        route,
        balance,
        status: upstream.status,
        text: localBrief(symbol, session),
      });
    }

    const data = (await upstream.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const text = data.choices?.[0]?.message?.content?.trim();
    return NextResponse.json({
      source: "usepod",
      route,
      balance,
      text: text || localBrief(symbol, session),
    });
  } catch {
    return NextResponse.json({
      source: "usepod-error",
      route: null,
      text: localBrief(symbol, session),
    });
  }
}
