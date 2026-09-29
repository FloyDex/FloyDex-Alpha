import { NextRequest, NextResponse } from "next/server";
import {
  creditUsdc,
  recordFundedOut,
  requestWithdraw,
  isBanned,
  bannedError,
} from "@/lib/market/venue";
import { isSolanaAddress } from "@/lib/solana/address";
import { sendTreasuryUsdc } from "@/lib/solana/treasury";

export async function POST(req: NextRequest) {
  let body: { owner?: string; amount?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }
  const owner = body.owner ?? "";
  const amount = Number(body.amount);
  if (!isSolanaAddress(owner) || !(amount > 0)) {
    return NextResponse.json({ ok: false, error: "Invalid withdraw" }, { status: 400 });
  }
  if (isBanned(owner)) {
    return NextResponse.json(bannedError(), { status: 403 });
  }

  const result = requestWithdraw(owner, amount);
  if (!result.ok) return NextResponse.json(result, { status: 400 });

  if (result.mode === "manual") {
    return NextResponse.json({
      ok: true,
      mode: "manual",
      payout: result.payout,
      message:
        "This withdrawal exceeds your funded deposits (includes profit or gift). It is queued for admin approval.",
    });
  }

  const sent = await sendTreasuryUsdc(owner, amount);
  if (!sent.ok) {
    creditUsdc(owner, amount);
    return NextResponse.json(
      { ok: false, error: sent.error },
      { status: sent.error.includes("not configured") ? 503 : 502 },
    );
  }
  recordFundedOut(owner, amount, sent.signature);
  return NextResponse.json({ ok: true, mode: "auto", signature: sent.signature });
}
