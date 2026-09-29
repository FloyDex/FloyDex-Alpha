import { NextRequest, NextResponse } from "next/server";
import { db, withRetry } from "@/lib/db";
import { networkFromRequest } from "@/lib/network-server";
import { getNetworkConfig } from "@/config/networks";
import { validateOrderIntent } from "@/lib/validation";
import { bodyTooLarge, rateLimit, requestKey } from "@/lib/rate-limit";
import { AMOUNT_PRECISION, PRICE_PRECISION } from "@/config";
import { intentToResting, placeOnBook, seedFromBinance } from "@/lib/market/onchain-book";
import { fetchMarkUsd } from "@/lib/market/marks";
import { applyFill, checkTriggers, ensureVenueReady, flushVenue, setTriggers, snapshot, isBanned, bannedError } from "@/lib/market/venue";

export async function POST(req: NextRequest) {
  if (bodyTooLarge(req)) {
    return NextResponse.json({ ok: false, error: "Body too large" }, { status: 413 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const claimedOwner = typeof (body as Record<string, unknown>)?.owner === "string"
    ? ((body as Record<string, unknown>).owner as string).slice(0, 64)
    : "invalid";
  await ensureVenueReady();
  if (isBanned(claimedOwner)) {
    return NextResponse.json(bannedError(), { status: 403 });
  }
  if (!(await rateLimit(requestKey(req, claimedOwner), 30))) {
    return NextResponse.json({ ok: false, error: "Too many order requests" }, { status: 429 });
  }

  const network = networkFromRequest(req);
  const result = validateOrderIntent(body, getNetworkConfig(network).passphrase);
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: 400 });
  }
  const o = result.order;
  const sig = typeof (body as Record<string, unknown>).signature === "string"
    ? (body as Record<string, unknown>).signature as string
    : null;

  const sizeHuman = Number(o.size) / Number(AMOUNT_PRECISION);
  if (!o.reduceOnly) {
    const acct = await snapshot(o.owner);
    const mark = (await fetchMarkUsd(o.marketId)) ?? Number(o.limitPrice) / Number(PRICE_PRECISION);
    const need = (sizeHuman * mark) / o.leverage;
    if (acct.freeCollateral + 1e-9 < need) {
      return NextResponse.json(
        { ok: false, error: `Deposit USDC first — need $${need.toFixed(2)} free, have $${acct.freeCollateral.toFixed(2)}` },
        { status: 400 },
      );
    }
  }

  const raw = body as Record<string, unknown>;
  const ioc =
    raw.ioc === true ||
    raw.timeInForce === "ioc" ||
    raw.orderType === "market";

  // Apply / clear TP-SL BEFORE the fill so a stale pending trigger cannot attach
  // to the new position and close it in the same request.
  const tp = typeof raw.tpPrice === "number" ? raw.tpPrice : Number(raw.tpPrice);
  const sl = typeof raw.slPrice === "number" ? raw.slPrice : Number(raw.slPrice);
  setTriggers(
    o.owner,
    o.marketId,
    Number.isFinite(tp) && tp > 0 ? tp : null,
    Number.isFinite(sl) && sl > 0 ? sl : null,
  );

  // Serverless instances each hold their own in-memory book. Seed this isolate
  // before matching so market/IOC orders never cancel against an empty book.
  await seedFromBinance(o.marketId);

  const placed = placeOnBook(intentToResting({ ...o, ioc }));
  const filled = placed.fills.reduce((s, f) => s + f.size, 0);
  if (ioc && filled <= 0) {
    return NextResponse.json(
      {
        ok: false,
        error: "No liquidity at this price — retry in a moment",
        book: placed.book,
        fills: [],
      },
      { status: 409 },
    );
  }
  if (filled > 0) {
    const vwap = placed.fills.reduce((s, f) => s + f.price * f.size, 0) / filled;
    const applied = await applyFill({
      owner: o.owner,
      marketId: o.marketId,
      isLong: o.isLong,
      size: filled,
      price: vwap,
      leverage: o.leverage,
      reduceOnly: o.reduceOnly,
    });
    if (!applied.ok) {
      return NextResponse.json({ ok: false, error: applied.error }, { status: 400 });
    }
  }
  await checkTriggers(o.owner);

  try {
    const sql = db(network);
    await withRetry(async () => {
      await sql`
        INSERT INTO "Account" (address, collateral, "cancelledNonces", "filledByNonce", "createdAt", "updatedAt")
        VALUES (${o.owner}, '{}', ARRAY[]::BIGINT[], '{}', NOW(), NOW())
        ON CONFLICT (address) DO NOTHING
      `;
      await sql`
        INSERT INTO "Order" (
          id, owner, "marketId", "isLong", size, "limitPrice",
          "reduceOnly", nonce, "expiryTs", cancelled, "filledSize",
          signature, "createdAt", "updatedAt"
        ) VALUES (
          ${o.owner + ":" + o.nonce.toString()},
          ${o.owner},
          ${o.marketId},
          ${o.isLong},
          ${o.size.toString()},
          ${o.limitPrice.toString()},
          ${o.reduceOnly},
          ${o.nonce},
          ${o.expiryTs},
          false,
          '0',
          ${sig},
          NOW(),
          NOW()
        )
        ON CONFLICT (id) DO NOTHING
      `;
    });
  } catch (e) {
    console.error("order intake db (book still accepted):", e);
  }

  await flushVenue();
  return NextResponse.json({
    ok: true,
    book: placed.book,
    fills: placed.fills,
  });
}
