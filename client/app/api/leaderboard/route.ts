import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  buildVenueLeaderboard,
  cumulativeSpark,
  LEADERBOARD_PUBLIC,
  periodSinceMs,
  sampleCurve,
  sparkBucketCount,
  type LeaderboardPeriod,
} from "@/lib/market/leaderboard";
import { ensureVenueReady, listVenueAccounts, snapshot } from "@/lib/market/venue";
import { networkAwareCacheControl, networkFromRequest } from "@/lib/network-server";
import { isSolanaAddress } from "@/lib/solana/address";

const VALID_PERIODS: LeaderboardPeriod[] = ["DAY", "WEEK", "MONTH", "ALL"];
const VALID_METRICS: Record<string, string> = {
  pnl: '"realizedPnl"',
  volume: "volume",
  roi: "roi",
};
const AMOUNT_SCALE = 1e7;

function coercePeriod(raw: string): LeaderboardPeriod {
  const p = raw.toUpperCase();
  return (VALID_PERIODS as string[]).includes(p) ? (p as LeaderboardPeriod) : "MONTH";
}

type SparkMap = Record<string, number[]>;
type MarketMap = Record<string, number[]>;
type OpenMap = Record<string, number>;

async function extras(
  sql: ReturnType<typeof db>,
  network: string,
  period: LeaderboardPeriod,
  addresses: string[],
): Promise<{ sparks: SparkMap; markets: MarketMap; openPositions: OpenMap }> {
  const empty = { sparks: {} as SparkMap, markets: {} as MarketMap, openPositions: {} as OpenMap };
  if (addresses.length === 0) return empty;
  const now = Date.now();
  const since = new Date(periodSinceMs(period, now)).toISOString();
  const buckets = sparkBucketCount(period);
  const start = periodSinceMs(period, now);
  const sparks: SparkMap = {};
  const markets: MarketMap = {};
  const openPositions: OpenMap = {};

  try {
    const pnlRows = (await sql.query(
      `SELECT address, "createdAt", amount
       FROM "PnlEvent"
       WHERE network = $1 AND address = ANY($2) AND "createdAt" >= $3
       ORDER BY "createdAt" ASC`,
      [network, addresses, since],
    )) as Array<{ address: string; createdAt: string | Date; amount: string }>;
    const byAddr = new Map<string, Array<{ at: number; value: number }>>();
    for (const r of pnlRows) {
      const list = byAddr.get(r.address) ?? [];
      list.push({ at: new Date(r.createdAt).getTime(), value: Number(r.amount) / AMOUNT_SCALE });
      byAddr.set(r.address, list);
    }
    for (const addr of addresses) {
      const spark = cumulativeSpark(byAddr.get(addr) ?? [], start, now, buckets);
      if (spark.length) sparks[addr] = spark;
    }
  } catch {
    /* indexer table may be empty or missing on a local desk */
  }

  const missingSpark = addresses.filter((a) => !sparks[a]);
  if (missingSpark.length) {
    try {
      const snapRows = (await sql.query(
        `SELECT address, "capturedAt", "realizedPnlCum"
         FROM "PortfolioSnapshot"
         WHERE network = $1 AND address = ANY($2) AND "capturedAt" >= $3
         ORDER BY "capturedAt" ASC`,
        [network, missingSpark, since],
      )) as Array<{ address: string; capturedAt: string | Date; realizedPnlCum: string }>;
      const byAddr = new Map<string, Array<{ at: number; value: number }>>();
      for (const r of snapRows) {
        const list = byAddr.get(r.address) ?? [];
        list.push({ at: new Date(r.capturedAt).getTime(), value: Number(r.realizedPnlCum) / AMOUNT_SCALE });
        byAddr.set(r.address, list);
      }
      for (const addr of missingSpark) {
        const spark = sampleCurve(byAddr.get(addr) ?? [], start, now, buckets);
        if (spark.length) sparks[addr] = spark;
      }
    } catch {
      /* same — portfolio snapshots are optional */
    }
  }

  try {
    const fillRows = (await sql.query(
      `SELECT addr, "marketId", COUNT(*)::int AS n
       FROM (
         SELECT maker AS addr, "marketId" FROM "Fill"
         WHERE network = $1 AND maker = ANY($2) AND "createdAt" >= $3
         UNION ALL
         SELECT taker AS addr, "marketId" FROM "Fill"
         WHERE network = $1 AND taker = ANY($2) AND "createdAt" >= $3
       ) t
       GROUP BY 1, 2`,
      [network, addresses, since],
    )) as Array<{ addr: string; marketId: number; n: number }>;
    const ranked = new Map<string, Array<{ marketId: number; n: number }>>();
    for (const r of fillRows) {
      const list = ranked.get(r.addr) ?? [];
      list.push({ marketId: Number(r.marketId), n: Number(r.n) });
      ranked.set(r.addr, list);
    }
    for (const [addr, list] of ranked) {
      markets[addr] = list
        .sort((a, b) => b.n - a.n)
        .slice(0, 3)
        .map((x) => x.marketId);
    }
  } catch {
    /* fills are optional on a cold desk */
  }

  try {
    const posRows = (await sql.query(
      `SELECT DISTINCT ON (address) address, "openPositionCount"
       FROM "PortfolioSnapshot"
       WHERE network = $1 AND address = ANY($2)
       ORDER BY address, "capturedAt" DESC`,
      [network, addresses],
    )) as Array<{ address: string; openPositionCount: number }>;
    for (const r of posRows) openPositions[r.address] = Number(r.openPositionCount) || 0;
  } catch {
    /* ignore */
  }

  return { sparks, markets, openPositions };
}

async function venueBoard(opts: {
  period: LeaderboardPeriod;
  metric: string;
  limit: number;
  offset: number;
  search?: string | null;
  watched: string[];
}) {
  await ensureVenueReady();
  const accounts = listVenueAccounts();
  const built = buildVenueLeaderboard({
    accounts,
    period: opts.period,
    metric: opts.metric,
    limit: opts.limit,
    offset: opts.offset,
    search: opts.search,
    watched: opts.watched,
  });

  const enriched = await Promise.all(
    built.traders.map(async (t) => {
      try {
        const snap = await snapshot(t.address);
        return {
          ...t,
          accountValue: snap.equity,
          openPositions: snap.positions.filter((p) => p.size > 0).length,
        };
      } catch {
        return t;
      }
    }),
  );

  return {
    period: opts.period,
    metric: opts.metric,
    total: built.total,
    limit: opts.limit,
    offset: opts.offset,
    traders: enriched,
    source: "venue" as const,
  };
}

// GET /api/leaderboard?period=MONTH&metric=pnl&limit=50&offset=0&search=…&addresses=a,b
export async function GET(req: NextRequest) {
  if (!LEADERBOARD_PUBLIC) {
    return NextResponse.json({ error: "leaderboard_disabled" }, { status: 404 });
  }
  const sp = req.nextUrl.searchParams;
  const period = coercePeriod(sp.get("period") ?? "MONTH");
  const metric = (sp.get("metric") ?? "pnl").toLowerCase();
  const orderCol = VALID_METRICS[metric] ?? VALID_METRICS.pnl;
  const limit = Math.min(parseInt(sp.get("limit") ?? "50", 10) || 50, 200);
  const offset = Math.max(parseInt(sp.get("offset") ?? "0", 10) || 0, 0);
  const search = sp.get("search")?.trim();
  const watched = (sp.get("addresses") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(isSolanaAddress)
    .slice(0, 50);

  const venueOpts = { period, metric, limit, offset, search, watched };

  // Solana desk: every wallet that trades on the venue ledger belongs on the board.
  // Prefer venue whenever it has traders so ranks are not blocked on the stats indexer.
  try {
    const venue = await venueBoard(venueOpts);
    if (venue.total > 0) {
      return NextResponse.json(venue, { headers: { "Cache-Control": "no-store" } });
    }
  } catch {
    /* fall through to DB / empty */
  }

  try {
    const network = networkFromRequest(req);
    const sql = db(network);

    const filters: string[] = [`network = $1`, `period = $2::"StatsPeriod"`];
    const params: unknown[] = [network, period];
    if (search) {
      params.push("%" + search + "%");
      filters.push(`address ILIKE $${params.length}`);
    }
    if (watched.length) {
      params.push(watched);
      filters.push(`address = ANY($${params.length})`);
    }
    const where = filters.join(" AND ");
    params.push(limit);
    const limitIdx = params.length;
    params.push(offset);
    const offsetIdx = params.length;

    const query = `
      SELECT address, "realizedPnl", volume, roi, "winRate", "tradeCount",
             "winningTrades", "losingTrades", "liquidationCount", "peakCollateral",
             "lastTradeAt",
             RANK() OVER (ORDER BY (${orderCol})::numeric DESC) AS rank
      FROM "TraderStat"
      WHERE ${where}
      ORDER BY (${orderCol})::numeric DESC
      LIMIT $${limitIdx} OFFSET $${offsetIdx}
    `;

    const countSql =
      search && watched.length
        ? sql`SELECT COUNT(*)::int AS c FROM "TraderStat" WHERE network = ${network} AND period = ${period}::"StatsPeriod" AND address ILIKE ${"%" + search + "%"} AND address = ANY(${watched})`
        : search
          ? sql`SELECT COUNT(*)::int AS c FROM "TraderStat" WHERE network = ${network} AND period = ${period}::"StatsPeriod" AND address ILIKE ${"%" + search + "%"}`
          : watched.length
            ? sql`SELECT COUNT(*)::int AS c FROM "TraderStat" WHERE network = ${network} AND period = ${period}::"StatsPeriod" AND address = ANY(${watched})`
            : sql`SELECT COUNT(*)::int AS c FROM "TraderStat" WHERE network = ${network} AND period = ${period}::"StatsPeriod"`;

    const [countRows, rows] = await Promise.all([countSql, sql.query(query, params)]);
    const total = Number((countRows as Record<string, unknown>[])[0]?.c ?? 0);

    const raw = rows as Record<string, unknown>[];
    const addrs = raw.map((r) => r.address as string);
    const extra = await extras(sql, network, period, addrs);

    const data = raw.map((r) => {
      const address = r.address as string;
      const last = r.lastTradeAt as string | Date | null;
      return {
        rank: Number(r.rank),
        address,
        pnl: Number(r.realizedPnl) / AMOUNT_SCALE,
        volume: Number(r.volume) / AMOUNT_SCALE,
        roi: Number(r.roi),
        winRate: Number(r.winRate),
        tradeCount: Number(r.tradeCount),
        wins: Number(r.winningTrades) || 0,
        losses: Number(r.losingTrades) || 0,
        liquidations: Number(r.liquidationCount),
        accountValue: Number(r.peakCollateral) / AMOUNT_SCALE,
        lastTradeAt: last ? new Date(last).toISOString() : null,
        spark: extra.sparks[address] ?? [],
        markets: extra.markets[address] ?? [],
        openPositions: extra.openPositions[address] ?? 0,
      };
    });

    return NextResponse.json(
      { period, metric, total, limit, offset, traders: data, source: "db" },
      {
        headers: {
          "Cache-Control": networkAwareCacheControl(req, "s-maxage=10, stale-while-revalidate=30"),
        },
      },
    );
  } catch {
    try {
      const venue = await venueBoard(venueOpts);
      return NextResponse.json(venue, { headers: { "Cache-Control": "no-store" } });
    } catch {
      return NextResponse.json(
        { period, metric, total: 0, limit, offset, traders: [], error: "leaderboard_unavailable" },
        { status: 200 },
      );
    }
  }
}
