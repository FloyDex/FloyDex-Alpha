import { NextRequest, NextResponse } from "next/server";
import { checkTriggers, ensureVenueReady, flushVenue, snapshot } from "@/lib/market/venue";
import { isSolanaAddress } from "@/lib/solana/address";

export async function GET(req: NextRequest) {
  const owner = req.nextUrl.searchParams.get("owner") ?? "";
  if (!isSolanaAddress(owner)) {
    return NextResponse.json({ error: "invalid_owner" }, { status: 400 });
  }
  await ensureVenueReady();
  const fired = await checkTriggers(owner);
  const snap = await snapshot(owner);
  // Only wait on a pending durable write — never force a Blob round-trip on reads.
  if (fired.length > 0) await flushVenue();
  return NextResponse.json(
    { ...snap, triggered: fired },
    { headers: { "Cache-Control": "no-store" } },
  );
}
