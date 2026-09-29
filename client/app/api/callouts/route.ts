import { NextRequest, NextResponse } from "next/server";
import { MARKETS } from "@/config";
import { validateCallout } from "@/lib/market/callouts";
import { addCallout, listCallouts, toggleCalloutLike } from "@/lib/market/callouts-store";
import { bodyTooLarge, rateLimit, requestKey } from "@/lib/rate-limit";
import { isSolanaAddress } from "@/lib/solana/address";

function marketExists(id: number): boolean {
  return Object.values(MARKETS).some((m) => m.marketId === id);
}

export async function GET(req: NextRequest) {
  const marketId = Number(req.nextUrl.searchParams.get("marketId"));
  const sort = req.nextUrl.searchParams.get("sort") === "top" ? "top" : "new";
  if (!marketId || !marketExists(marketId)) {
    return NextResponse.json({ error: "invalid_market" }, { status: 400 });
  }
  return NextResponse.json(
    { posts: listCallouts(marketId, sort) },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(req: NextRequest) {
  if (bodyTooLarge(req, 2048)) {
    return NextResponse.json({ ok: false, error: "Body too large" }, { status: 413 });
  }
  let body: { owner?: string; marketId?: number; side?: string; text?: string; likeId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }
  const owner = body.owner ?? "";
  if (!isSolanaAddress(owner)) {
    return NextResponse.json({ ok: false, error: "Connect a wallet to post" }, { status: 400 });
  }
  if (!(await rateLimit(requestKey(req, owner), 20))) {
    return NextResponse.json({ ok: false, error: "Too many posts" }, { status: 429 });
  }

  if (body.likeId) {
    const post = toggleCalloutLike(body.likeId, owner);
    if (!post) return NextResponse.json({ ok: false, error: "Callout not found" }, { status: 404 });
    return NextResponse.json({ ok: true, post });
  }

  const marketId = Number(body.marketId);
  if (!marketId || !marketExists(marketId)) {
    return NextResponse.json({ ok: false, error: "invalid_market" }, { status: 400 });
  }
  const parsed = validateCallout(body.text ?? "", body.side);
  if (!parsed.ok) return NextResponse.json({ ok: false, error: parsed.error }, { status: 400 });
  const post = addCallout({ marketId, owner, side: parsed.side, text: parsed.text });
  return NextResponse.json({ ok: true, post });
}
