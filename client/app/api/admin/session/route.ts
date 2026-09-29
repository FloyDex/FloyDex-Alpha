import { NextRequest, NextResponse } from "next/server";
import { readAdminSessionFromRequest } from "@/lib/admin-auth";

export async function GET(req: NextRequest) {
  const ok = await readAdminSessionFromRequest(req);
  return NextResponse.json(
    { ok, authenticated: ok },
    { headers: { "Cache-Control": "no-store" } },
  );
}
