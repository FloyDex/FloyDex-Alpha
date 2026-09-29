/** Flip to true when the public leaderboard is ready again. */
export const LEADERBOARD_PUBLIC = false;

export type LeaderboardPeriod = "DAY" | "WEEK" | "MONTH" | "ALL";

export const WATCH_KEY = "floydex-lb-watch";

export function parseWatchList(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    if (!Array.isArray(v)) return [];
    return v.filter((x): x is string => typeof x === "string" && x.length > 20).slice(0, 50);
  } catch {
    return [];
  }
}

export function periodSinceMs(period: LeaderboardPeriod, now = Date.now()): number {
  if (period === "DAY") return now - 86_400_000;
  if (period === "WEEK") return now - 7 * 86_400_000;
  if (period === "MONTH") return now - 30 * 86_400_000;
  return now - 90 * 86_400_000;
}

export function sparkBucketCount(period: LeaderboardPeriod): number {
  if (period === "DAY") return 24;
  if (period === "WEEK") return 14;
  if (period === "MONTH") return 30;
  return 24;
}

/** Running sum of deltas into evenly spaced buckets. Empty if nothing moved. */
export function cumulativeSpark(
  rows: Array<{ at: number; value: number }>,
  start: number,
  end: number,
  buckets: number,
): number[] {
  if (!(end > start) || buckets < 2) return [];
  const width = (end - start) / buckets;
  const per = Array.from({ length: buckets }, () => 0);
  for (const r of rows) {
    if (!Number.isFinite(r.at) || !Number.isFinite(r.value) || r.value === 0) continue;
    let i = Math.floor((r.at - start) / width);
    if (i < 0) i = 0;
    if (i >= buckets) i = buckets - 1;
    per[i] += r.value;
  }
  if (!per.some((v) => v !== 0)) return [];
  let run = 0;
  return per.map((v) => {
    run += v;
    return run;
  });
}

/** Last observed curve value in each bucket (already-cumulative series). */
export function sampleCurve(
  rows: Array<{ at: number; value: number }>,
  start: number,
  end: number,
  buckets: number,
): number[] {
  if (!(end > start) || buckets < 2 || rows.length === 0) return [];
  const sorted = rows
    .filter((r) => Number.isFinite(r.at) && Number.isFinite(r.value))
    .sort((a, b) => a.at - b.at);
  if (sorted.length === 0) return [];
  const width = (end - start) / buckets;
  const out: number[] = [];
  let j = 0;
  let last = sorted[0].value;
  for (let i = 0; i < buckets; i++) {
    const t = start + (i + 1) * width;
    while (j < sorted.length && sorted[j].at <= t) {
      last = sorted[j].value;
      j += 1;
    }
    out.push(last);
  }
  const first = out[0];
  if (out.every((v) => v === first)) return [];
  return out;
}

export function timeAgo(ts: number | string | null | undefined, now = Date.now()): string {
  if (ts == null || ts === "") return "—";
  const t = typeof ts === "number" ? ts : Date.parse(String(ts));
  if (!Number.isFinite(t)) return "—";
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 45) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86_400 * 30) return `${Math.floor(s / 86_400)}d ago`;
  return `${Math.floor(s / (86_400 * 30))}mo ago`;
}

export function identiconHues(address: string): [number, number, number] {
  let h = 2166136261;
  for (let i = 0; i < address.length; i++) {
    h ^= address.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const u = h >>> 0;
  return [u % 360, (u >>> 8) % 360, (u >>> 16) % 360];
}

export function pageWindow(page: number, pageCount: number): number[] {
  if (pageCount <= 1) return pageCount === 1 ? [0] : [];
  const span = 5;
  let start = Math.max(0, page - 2);
  let end = Math.min(pageCount, start + span);
  start = Math.max(0, end - span);
  const out: number[] = [];
  for (let i = start; i < end; i++) out.push(i);
  return out;
}

export type VenueLeaderboardFill = {
  marketId: number;
  size: number;
  price: number;
  pnl: number;
  reason: string;
  at: number;
};

export type VenueLeaderboardAccount = {
  owner: string;
  deposited: number;
  realized: number;
  fundedIn?: number;
  positions: Array<{ marketId: number; size: number; margin: number }>;
  fills?: VenueLeaderboardFill[];
};

export type VenueLeaderboardTrader = {
  rank: number;
  address: string;
  pnl: number;
  volume: number;
  roi: number;
  winRate: number;
  tradeCount: number;
  wins: number;
  losses: number;
  liquidations: number;
  accountValue: number;
  lastTradeAt: string | null;
  spark: number[];
  markets: number[];
  openPositions: number;
};

/** Rank venue ledger accounts for the desk when the stats indexer is offline. */
export function buildVenueLeaderboard(opts: {
  accounts: VenueLeaderboardAccount[];
  period: LeaderboardPeriod;
  metric: "pnl" | "volume" | "roi" | string;
  limit: number;
  offset: number;
  search?: string | null;
  watched?: string[];
  now?: number;
}): { total: number; traders: VenueLeaderboardTrader[] } {
  const now = opts.now ?? Date.now();
  // Venue "ALL" is true all-time so early traders never drop off the board.
  const since = opts.period === "ALL" ? 0 : periodSinceMs(opts.period, now);
  const sparkStart = opts.period === "ALL" ? periodSinceMs("MONTH", now) : since;
  const buckets = sparkBucketCount(opts.period === "ALL" ? "MONTH" : opts.period);
  const search = opts.search?.trim().toLowerCase() ?? "";
  const watched = new Set((opts.watched ?? []).map((a) => a.trim()).filter(Boolean));

  const rows: VenueLeaderboardTrader[] = [];
  for (const acct of opts.accounts) {
    if (watched.size && !watched.has(acct.owner)) continue;
    if (search && !acct.owner.toLowerCase().includes(search)) continue;

    const allFills = acct.fills ?? [];
    const fills = allFills.filter((f) => f.at >= since);
    const openPositions = (acct.positions ?? []).filter((p) => p.size > 0);
    // Anyone with a trade in-window ranks. Lifetime fills backfill if they only hold a position.
    const scored = fills.length > 0 ? fills : openPositions.length > 0 ? allFills : [];
    if (scored.length === 0) continue;

    const pnl = scored.reduce((s, f) => s + f.pnl, 0);
    const volume = scored.reduce((s, f) => s + f.size * f.price, 0);
    const closes = scored.filter(
      (f) => f.reason === "close" || f.reason === "tp" || f.reason === "sl",
    );
    const wins = closes.filter((f) => f.pnl > 0).length;
    const losses = closes.filter((f) => f.pnl <= 0).length;
    const stake = Math.max(acct.fundedIn ?? 0, acct.deposited, 1e-9);
    const equity = acct.deposited + acct.realized;

    const marketCounts = new Map<number, number>();
    for (const f of scored) marketCounts.set(f.marketId, (marketCounts.get(f.marketId) ?? 0) + 1);
    for (const p of openPositions) {
      if (!marketCounts.has(p.marketId)) marketCounts.set(p.marketId, 1);
    }
    const markets = [...marketCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([id]) => id);

    const sparkRows = scored
      .filter((f) => f.pnl !== 0)
      .map((f) => ({ at: f.at, value: f.pnl }));
    const spark = cumulativeSpark(sparkRows, sparkStart, now, buckets);
    const lastAt = Math.max(...scored.map((f) => f.at));

    rows.push({
      rank: 0,
      address: acct.owner,
      pnl,
      volume,
      roi: pnl / stake,
      winRate: closes.length > 0 ? wins / closes.length : 0,
      tradeCount: scored.length,
      wins,
      losses,
      liquidations: 0,
      accountValue: Math.max(0, equity),
      lastTradeAt: Number.isFinite(lastAt) ? new Date(lastAt).toISOString() : null,
      spark,
      markets,
      openPositions: openPositions.length,
    });
  }

  const metric = (opts.metric || "pnl").toLowerCase();
  const key = (t: VenueLeaderboardTrader) =>
    metric === "volume" ? t.volume : metric === "roi" ? t.roi : t.pnl;
  rows.sort((a, b) => key(b) - key(a) || b.volume - a.volume);
  rows.forEach((t, i) => {
    t.rank = i + 1;
  });

  const total = rows.length;
  const traders = rows.slice(opts.offset, opts.offset + opts.limit);
  return { total, traders };
}
