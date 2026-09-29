import { NextRequest, NextResponse } from "next/server";
import { checkTriggers, snapshot } from "@/lib/market/venue";
import { isSolanaAddress } from "@/lib/solana/address";

export async function GET(req: NextRequest) {
  const owner = req.nextUrl.searchParams.get("owner") ?? "";
  if (!isSolanaAddress(owner)) {
    return NextResponse.json({ error: "invalid_owner" }, { status: 400 });
  }
  const fired = await checkTriggers(owner);
  const snap = await snapshot(owner);
  return NextResponse.json(
    { ...snap, triggered: fired },
    { headers: { "Cache-Control": "no-store" } },
  );
}
