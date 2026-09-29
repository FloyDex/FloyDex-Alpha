import { NextRequest, NextResponse } from "next/server";
import { StrKey } from "@stellar/stellar-sdk";
import { db } from "@/lib/db";
import { networkAwareCacheControl, networkFromRequest } from "@/lib/network-server";
import { rateLimit, requestKey } from "@/lib/rate-limit";
import { isSolanaAddress } from "@/lib/solana/address";
import { ensureVenueReady, snapshot } from "@/lib/market/venue";

const AMOUNT_SCALE = 1e7;
const PRICE_SCALE = 1e18;

function n(v: unknown, scale = AMOUNT_SCALE): number {
  return Number(v ?? 0) / scale;
}

function venueAnalytics(snap: Awaited<ReturnType<typeof snapshot>>) {
  const fills = [...(snap.fills ?? [])].sort((a, b) => a.at - b.at);
  const closes = fills.filter((f) => f.reason === "close" || f.reason === "tp" || f.reason === "sl");
  const wins = closes.filter((f) => f.pnl > 0).length;
  const volume = fills.reduce((s, f) => s + f.size * f.price, 0);

  const pnlHistory = fills
    .filter((f) => f.pnl !== 0 || f.reason === "close" || f.reason === "tp" || f.reason === "sl")
    .map((f) => ({
      kind: f.reason,
      amount: f.pnl,
      size: f.size,
      price: f.price,
      marketId: f.marketId,
      txHash: `venue:${f.reason}`,
      at: new Date(f.at).toISOString(),
    }))
    .reverse();

  // Reconstruct a coarse equity path: deposit + cumulative realized (open upnl only on tip).
  let realizedCum = 0;
  const equityCurve: Array<{
    equity: number;
    unrealizedPnl: number;
    realizedPnlCum: number;
    at: string;
  }> = [];

  const startAt = fills[0]?.at ?? Date.now();
  equityCurve.push({
    equity: snap.deposited,
    unrealizedPnl: 0,
    realizedPnlCum: 0,
    at: new Date(Math.max(0, startAt - 60_000)).toISOString(),
  });

  for (const f of fills) {
    realizedCum += f.pnl;
    equityCurve.push({
      equity: snap.deposited + realizedCum,
      unrealizedPnl: 0,
      realizedPnlCum: realizedCum,
      at: new Date(f.at).toISOString(),
    });
  }

  equityCurve.push({
    equity: snap.equity,
    unrealizedPnl: snap.upnl,
    realizedPnlCum: snap.realized,
    at: new Date().toISOString(),
  });

  const balanceHistory = (snap.transfers?.length
    ? snap.transfers
    : [
        ...(snap.fundedIn > 0
          ? [
              {
                kind: "deposit" as const,
                amount: snap.fundedIn,
                balanceAfter: snap.fundedIn,
                signature: undefined as string | undefined,
                at: Math.max(0, startAt - 60_000),
              },
            ]
          : []),
        ...(snap.fundedOut > 0
          ? [
              {
                kind: "withdraw" as const,
                amount: snap.fundedOut,
                balanceAfter: Math.max(0, snap.fundedIn - snap.fundedOut),
                signature: undefined as string | undefined,
                at: Date.now(),
              },
            ]
          : []),
      ]
  )
    .slice()
    .sort((a, b) => b.at - a.at)
    .map((t) => ({
      kind: t.kind,
      asset: "USDC",
      // Keep withdraw amounts negative so the Transfers tab signs them correctly.
      amount: t.kind === "withdraw" ? -Math.abs(t.amount) : Math.abs(t.amount),
      balanceAfter: t.balanceAfter,
      txHash: t.signature ?? null,
      at: new Date(t.at).toISOString(),
    }));

  return {
    analytics: {
      realizedPnl: snap.realized,
      volume,
      tradeCount: fills.length,
      winRate: closes.length > 0 ? wins / closes.length : 0,
      totalDeposited: snap.fundedIn || snap.deposited,
      totalWithdrawn: snap.fundedOut,
      totalFundingPaid: 0,
      totalFeesPaid: snap.feesPaid ?? 0,
      liquidationCount: 0,
      firstTradeAt: fills[0] ? new Date(fills[0].at).toISOString() : null,
      lastTradeAt: fills.at(-1) ? new Date(fills.at(-1)!.at).toISOString() : null,
    },
    pnlHistory,
    balanceHistory,
    fundingHistory: [] as Array<{ marketId: number; amount: number; txHash: string | null; at: string }>,
    equityCurve,
  };
}

// GET /api/portfolio/<address>
// Returns denormalized analytics + recent history for the portfolio page.
export async function GET(req: NextRequest, ctx: { params: Promise<{ address: string }> }) {
  const { address } = await ctx.params;
  if (!isSolanaAddress(address) && !StrKey.isValidEd25519PublicKey(address)) {
    return NextResponse.json({ error: "invalid address" }, { status: 400 });
  }
  if (!(await rateLimit(requestKey(req, address), 120))) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  // Solana desk: prefer venue ledger (authoritative for paper/hybrid fills).
  if (isSolanaAddress(address)) {
    try {
      await ensureVenueReady();
      const snap = await snapshot(address);
      const venue = venueAnalytics(snap);
      return NextResponse.json(
        { address, ...venue, source: "venue" },
        { headers: { "Cache-Control": "no-store" } },
      );
    } catch {
      // Fall through to DB if venue read fails.
    }
  }

  try {
    const network = networkFromRequest(req);
    const sql = db(network);

    const [analyticsRows, pnlHistory, balanceHistory, fundingHistory, snapshots] = await Promise.all([
      sql`SELECT * FROM "AccountAnalytics" WHERE network = ${network} AND address = ${address} LIMIT 1`,
      sql`SELECT kind, amount, size, price, "marketId", "txHash", "createdAt"
          FROM "PnlEvent" WHERE network = ${network} AND address = ${address}
          ORDER BY "createdAt" DESC LIMIT 100`,
      sql`SELECT kind, asset, amount, "balanceAfter", "txHash", "createdAt"
          FROM "BalanceChange" WHERE network = ${network} AND address = ${address}
          ORDER BY "createdAt" DESC LIMIT 50`,
      sql`SELECT "marketId", amount, "fundingIndex", "txHash", "createdAt"
          FROM "FundingPayment" WHERE network = ${network} AND address = ${address}
          ORDER BY "createdAt" DESC LIMIT 50`,
      sql`SELECT equity, "unrealizedPnl", "realizedPnlCum", "freeCollateral",
                 "usedMargin", "openPositionCount", "longExposure", "shortExposure", "capturedAt"
          FROM "PortfolioSnapshot" WHERE network = ${network} AND address = ${address}
          ORDER BY "capturedAt" DESC LIMIT 200`,
    ]);

    const a = analyticsRows[0] as Record<string, unknown> | undefined;

    const analytics = a
      ? {
          realizedPnl: n(a.realizedPnlAll),
          volume: n(a.volumeAll),
          tradeCount: Number(a.tradeCountAll),
          winRate: Number(a.winRateAll),
          totalDeposited: n(a.totalDeposited),
          totalWithdrawn: n(a.totalWithdrawn),
          totalFundingPaid: n(a.totalFundingPaid),
          totalFeesPaid: n(a.totalFeesPaid),
          liquidationCount: Number(a.liquidationCount),
          firstTradeAt: a.firstTradeAt,
          lastTradeAt: a.lastTradeAt,
        }
      : null;

    return NextResponse.json(
      {
        address,
        analytics,
        source: "db",
        pnlHistory: (pnlHistory as Record<string, unknown>[]).map((r) => ({
          kind: r.kind,
          amount: n(r.amount),
          size: n(r.size),
          price: n(r.price, PRICE_SCALE),
          marketId: Number(r.marketId),
          txHash: r.txHash,
          at: r.createdAt,
        })),
        balanceHistory: (balanceHistory as Record<string, unknown>[]).map((r) => ({
          kind: r.kind,
          asset: r.asset,
          amount: n(r.amount),
          balanceAfter: r.balanceAfter ? n(r.balanceAfter) : null,
          txHash: r.txHash,
          at: r.createdAt,
        })),
        fundingHistory: (fundingHistory as Record<string, unknown>[]).map((r) => ({
          marketId: Number(r.marketId),
          amount: n(r.amount),
          txHash: r.txHash,
          at: r.createdAt,
        })),
        equityCurve: (snapshots as Record<string, unknown>[]).reverse().map((r) => ({
          equity: n(r.equity),
          unrealizedPnl: n(r.unrealizedPnl),
          realizedPnlCum: n(r.realizedPnlCum),
          at: r.capturedAt,
        })),
      },
      { headers: { "Cache-Control": networkAwareCacheControl(req, "s-maxage=5, stale-while-revalidate=15") } },
    );
  } catch {
    // Last resort for Solana if venue path somehow skipped.
    if (isSolanaAddress(address)) {
      try {
        const snap = await snapshot(address);
        return NextResponse.json(
          { address, ...venueAnalytics(snap), source: "venue" },
          { headers: { "Cache-Control": "no-store" } },
        );
      } catch {
        /* fall through */
      }
    }
    return NextResponse.json(
      {
        address,
        analytics: null,
        pnlHistory: [],
        balanceHistory: [],
        fundingHistory: [],
        equityCurve: [],
        error: "portfolio_unavailable",
      },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  }
}
