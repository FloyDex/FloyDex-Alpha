import { NextRequest, NextResponse } from "next/server";
import { seedFromBinance, snapshotBook } from "@/lib/market/onchain-book";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const marketId = parseInt(id, 10);
  if (!marketId) return NextResponse.json(null, { status: 400 });

  await seedFromBinance(marketId);
  return NextResponse.json(snapshotBook(marketId), {
    headers: { "Cache-Control": "no-store" },
  });
}
