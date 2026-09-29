import { NextRequest, NextResponse } from "next/server";
import {
  banWallet,
  isBanned,
  listBans,
  unbanWallet,
} from "@/lib/market/venue";
import { readAdminSessionFromRequest } from "@/lib/admin-auth";
import { isSolanaAddress } from "@/lib/solana/address";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!(await readAdminSessionFromRequest(req))) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json(
    { ok: true, bans: listBans() },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(req: NextRequest) {
  if (!(await readAdminSessionFromRequest(req))) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  let body: { owner?: string; action?: string; reason?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }

  const owner = (body.owner ?? "").trim();
  const action = body.action ?? "";
  if (!isSolanaAddress(owner)) {
    return NextResponse.json({ ok: false, error: "Invalid wallet" }, { status: 400 });
  }
  if (action !== "ban" && action !== "unban") {
    return NextResponse.json({ ok: false, error: "action must be ban or unban" }, { status: 400 });
  }

  if (action === "unban") {
    const result = unbanWallet(owner);
    if (!result.ok) return NextResponse.json(result, { status: 400 });
    return NextResponse.json({ ok: true, banned: false, owner });
  }

  if (isBanned(owner) && !body.reason) {
    // Re-ban with same state is fine; still refresh timestamp if reason given.
  }
  const result = banWallet(owner, body.reason);
  if (!result.ok) return NextResponse.json(result, { status: 400 });
  return NextResponse.json({ ok: true, banned: true, ban: result.ban });
}
