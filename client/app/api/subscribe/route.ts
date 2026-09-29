import { NextRequest, NextResponse } from "next/server";
import { recordSubscriber } from "@/lib/market/subscribe";
import { bodyTooLarge, clientIp, rateLimit } from "@/lib/rate-limit";

export async function POST(req: NextRequest) {
  if (bodyTooLarge(req, 1024)) {
    return NextResponse.json({ ok: false, error: "Body too large" }, { status: 413 });
  }
  let body: { email?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }
  if (!(await rateLimit(`subscribe:${clientIp(req)}`, 8))) {
    return NextResponse.json({ ok: false, error: "Too many tries" }, { status: 429 });
  }
  const result = recordSubscriber(body.email ?? "");
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: 400 });
  }
  return NextResponse.json({ ok: true, created: result.created });
}
