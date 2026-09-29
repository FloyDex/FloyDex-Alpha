import { NextRequest, NextResponse } from "next/server";
import { deskOverview, ensureVenueReady } from "@/lib/market/venue";
import { readAdminSessionFromRequest } from "@/lib/admin-auth";
import { treasuryUsdcBalance } from "@/lib/solana/treasury";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!(await readAdminSessionFromRequest(req))) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  await ensureVenueReady();
  const overview = deskOverview();
  const treasury = await treasuryUsdcBalance();

  return NextResponse.json(
    {
      ok: true,
      ...overview,
      treasury: {
        pubkey: treasury.pubkey,
        usdc: treasury.usdc,
        sol: treasury.sol,
        coverRatio:
          treasury.usdc != null && overview.vault.ledgerEquity > 0
            ? treasury.usdc / overview.vault.ledgerEquity
            : null,
      },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
