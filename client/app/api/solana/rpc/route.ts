import { NextResponse } from "next/server";

export const runtime = "nodejs";

function upstreamUrl(): string {
  return (
    process.env.RPC_URL ||
    process.env.SOLANA_RPC_URL ||
    "https://api.mainnet-beta.solana.com"
  );
}

export async function POST(req: Request) {
  const url = upstreamUrl();
  const body = await req.text();
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  const text = await res.text();
  return new NextResponse(text, {
    status: res.status,
    headers: { "content-type": res.headers.get("content-type") ?? "application/json" },
  });
}
