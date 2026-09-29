import { NextRequest, NextResponse } from "next/server";
import { lastStaker, listStakes, lockStake, totalStaked } from "@/lib/market/stakes";
import { STAKE_PUBLIC, STAKE_TERMS, isOpenStake, type StakePosition } from "@/lib/market/stake";
import { bodyTooLarge, rateLimit, requestKey } from "@/lib/rate-limit";
import { isSolanaAddress } from "@/lib/solana/address";
import { shortenAddress } from "@/lib/format";
import { isBanned, bannedError } from "@/lib/market/venue";

function snapshot(owner: string) {
  const now = Date.now();
  const mine = owner && isSolanaAddress(owner) ? listStakes(owner) : [];
  const open = mine.filter((r) => isOpenStake(r, now));
  return {
    totalStaked: totalStaked(now),
    lastStaker: lastStaker() ? shortenAddress(lastStaker()!) : null,
    terms: STAKE_TERMS,
    stakes: mine.sort((a, b) => b.lockedAt - a.lockedAt) as StakePosition[],
    openCount: open.length,
  };
}

export async function GET(req: NextRequest) {
  if (!STAKE_PUBLIC) {
    return NextResponse.json({ error: "stake_disabled" }, { status: 404 });
  }
  const owner = req.nextUrl.searchParams.get("owner") ?? "";
  return NextResponse.json(snapshot(owner), { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: NextRequest) {
  if (!STAKE_PUBLIC) {
    return NextResponse.json({ error: "stake_disabled" }, { status: 404 });
  }
  if (bodyTooLarge(req, 2048)) {
    return NextResponse.json({ ok: false, error: "Body too large" }, { status: 413 });
  }
  let body: { owner?: string; days?: number; amount?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }
  const owner = body.owner ?? "";
  if (!isSolanaAddress(owner)) {
    return NextResponse.json({ ok: false, error: "Connect a wallet" }, { status: 400 });
  }
  if (isBanned(owner)) {
    return NextResponse.json(bannedError(), { status: 403 });
  }
  if (!(await rateLimit(requestKey(req, owner), 20))) {
    return NextResponse.json({ ok: false, error: "Too many locks" }, { status: 429 });
  }
  const result = lockStake(owner, Number(body.days), Number(body.amount));
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: 400 });
  }
  return NextResponse.json({ ok: true, position: result.position, ...snapshot(owner) });
}
