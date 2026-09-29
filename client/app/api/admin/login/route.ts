import { NextRequest, NextResponse } from "next/server";
import {
  adminAuthConfigured,
  adminCookieOptions,
  createAdminSessionToken,
  verifyAdminPassword,
} from "@/lib/admin-auth";
import { bodyTooLarge, rateLimit, requestKey } from "@/lib/rate-limit";

export async function POST(req: NextRequest) {
  if (bodyTooLarge(req)) {
    return NextResponse.json({ ok: false, error: "Body too large" }, { status: 413 });
  }
  // Tight: 3 tries / IP / minute (distributed via Upstash in production).
  if (!(await rateLimit(requestKey(req, "admin-login"), 3))) {
    return NextResponse.json({ ok: false, error: "Too many attempts" }, { status: 429 });
  }
  if (!adminAuthConfigured()) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "Admin password is not configured (need ≥24 chars with upper, lower, and a digit)",
      },
      { status: 503 },
    );
  }

  let body: { password?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }

  const password = typeof body.password === "string" ? body.password : "";
  if (!(await verifyAdminPassword(password))) {
    return NextResponse.json({ ok: false, error: "Invalid password" }, { status: 401 });
  }

  const token = await createAdminSessionToken();
  const res = NextResponse.json({ ok: true });
  res.cookies.set(adminCookieOptions(token));
  return res;
}
