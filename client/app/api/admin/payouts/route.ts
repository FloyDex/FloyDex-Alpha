import { NextRequest, NextResponse } from "next/server";
import {
  approvePayout,
  ensureVenueReady,
  flushVenue,
  getPayout,
  listPayouts,
  rejectPayout,
} from "@/lib/market/venue";
import { readAdminSessionFromRequest } from "@/lib/admin-auth";
import { sendTreasuryUsdc } from "@/lib/solana/treasury";

export async function GET(req: NextRequest) {
  if (!(await readAdminSessionFromRequest(req))) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  await ensureVenueReady();
  const status = req.nextUrl.searchParams.get("status") as
    | "pending"
    | "approved"
    | "rejected"
    | null;
  const rows = listPayouts(status ? { status } : undefined);
  return NextResponse.json(
    { ok: true, payouts: rows },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(req: NextRequest) {
  if (!(await readAdminSessionFromRequest(req))) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  let body: { id?: string; action?: string; note?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }

  const id = body.id ?? "";
  const action = body.action ?? "";
  if (!id || (action !== "approve" && action !== "reject")) {
    return NextResponse.json({ ok: false, error: "id and action required" }, { status: 400 });
  }

  await ensureVenueReady();
  const existing = getPayout(id);
  if (!existing) return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
  if (existing.status !== "pending") {
    return NextResponse.json({ ok: false, error: "Already resolved" }, { status: 400 });
  }

  if (action === "reject") {
    const rejected = rejectPayout(id, body.note);
    await flushVenue();
    return NextResponse.json(rejected);
  }

  const sent = await sendTreasuryUsdc(existing.owner, existing.amount);
  if (!sent.ok) {
    return NextResponse.json({ ok: false, error: sent.error }, { status: 502 });
  }
  const approved = approvePayout(id, sent.signature);
  await flushVenue();
  return NextResponse.json(approved);
}
