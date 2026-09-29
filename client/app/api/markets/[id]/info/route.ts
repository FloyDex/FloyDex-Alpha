import { NextRequest, NextResponse } from "next/server";
import { fetchMarketInfo } from "@/lib/market/info";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const marketId = parseInt(id, 10);
  if (!marketId) return NextResponse.json({ error: "invalid_market" }, { status: 400 });
  const data = await fetchMarketInfo(marketId);
  if (!data) return NextResponse.json({ error: "unavailable" }, { status: 404 });
  return NextResponse.json(data, { headers: { "Cache-Control": "no-store" } });
}
