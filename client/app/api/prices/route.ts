import { NextResponse } from "next/server";
import { fetchAllMarketTickers, fetchMarksUsd, usdToPriceRaw } from "@/lib/market/marks";

export async function GET() {
  const [marks, tickers] = await Promise.all([fetchMarksUsd(), fetchAllMarketTickers()]);
  const scaled: Record<string, string> = {};
  for (const [id, px] of Object.entries(marks)) {
    scaled[id] = usdToPriceRaw(px).toString();
  }
  return NextResponse.json(
    { usd: marks, raw: scaled, tickers, timestamp: Date.now() },
    { headers: { "Cache-Control": "no-store" } },
  );
}
