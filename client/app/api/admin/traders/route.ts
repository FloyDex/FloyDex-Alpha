import { NextRequest, NextResponse } from "next/server";
import { deskTraders, listBans } from "@/lib/market/venue";
import { readAdminSessionFromRequest } from "@/lib/admin-auth";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!(await readAdminSessionFromRequest(req))) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const traders = deskTraders();
  const known = new Set(traders.map((t) => t.owner));
  // Ban-only wallets (never funded) still show up so they can be unbanned.
  for (const ban of listBans()) {
    if (known.has(ban.owner)) continue;
    traders.push({
      owner: ban.owner,
      equity: 0,
      deposited: 0,
      realized: 0,
      feesPaid: 0,
      fundedIn: 0,
      fundedOut: 0,
      principalLeft: 0,
      usedMargin: 0,
      freeCollateral: 0,
      positions: 0,
      fills: 0,
      volume: 0,
      giftUsd: 0,
      giftLeft: 0,
      banned: true,
      ban,
      payouts: {
        pendingCount: 0,
        pendingUsd: 0,
        approvedCount: 0,
        approvedUsd: 0,
        rejectedCount: 0,
        rejectedUsd: 0,
        totalCount: 0,
        latest: null,
      },
      lastFillAt: 0,
      lastTransferAt: 0,
    });
  }

  return NextResponse.json(
    { ok: true, traders },
    { headers: { "Cache-Control": "no-store" } },
  );
}
