import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { GIFT_USD, isDeviceId } from "@/lib/market/gift";
import { claimSignupGift, ensureVenueReady, flushVenue, snapshot, isBanned, bannedError } from "@/lib/market/venue";
import { bodyTooLarge, clientIp, rateLimit, requestKey } from "@/lib/rate-limit";
import { isSolanaAddress } from "@/lib/solana/address";

function hashId(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function deviceFrom(req: NextRequest, bodyId: string): string | null {
  const cookie = req.cookies.get("floydex-device")?.value ?? "";
  if (cookie && bodyId && cookie !== bodyId) return null;
  const device = cookie || bodyId;
  return isDeviceId(device) ? device : null;
}

export async function GET(req: NextRequest) {
  const owner = req.nextUrl.searchParams.get("owner") ?? "";
  if (!isSolanaAddress(owner)) {
    return NextResponse.json({ error: "invalid_owner" }, { status: 400 });
  }
  await ensureVenueReady();
  const snap = await snapshot(owner);
  await flushVenue();
  return NextResponse.json(
    { gift: snap.gift, amount: GIFT_USD },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(req: NextRequest) {
  if (bodyTooLarge(req, 2048)) {
    return NextResponse.json({ ok: false, error: "Body too large" }, { status: 413 });
  }
  let body: { owner?: string; deviceId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }
  const owner = body.owner ?? "";
  const device = deviceFrom(req, body.deviceId ?? "");
  if (!isSolanaAddress(owner) || !device) {
    return NextResponse.json({ ok: false, error: "Connect a wallet from one device" }, { status: 400 });
  }
  await ensureVenueReady();
  if (isBanned(owner)) {
    return NextResponse.json(bannedError(), { status: 403 });
  }
  if (!(await rateLimit(requestKey(req, owner), 8))) {
    return NextResponse.json({ ok: false, error: "Too many claims" }, { status: 429 });
  }
  const ip = clientIp(req);
  if (ip === "unknown") {
    return NextResponse.json({ ok: false, error: "Could not read your IP" }, { status: 400 });
  }
  const result = claimSignupGift(owner, hashId(`ip:${ip}`), hashId(`dev:${device}`));
  if (!result.ok) {
    const gift = result.code === "claimed_owner" ? (await snapshot(owner)).gift : null;
    await flushVenue();
    return NextResponse.json({ ok: false, claimed: false, error: result.error, code: result.code, gift });
  }
  const snap = await snapshot(owner);
  await flushVenue();
  return NextResponse.json({
    ok: true,
    claimed: true,
    amount: result.amount,
    gift: snap.gift,
  });
}
