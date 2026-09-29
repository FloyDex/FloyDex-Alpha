"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronUp, Search } from "lucide-react";
import type { MarketConfig } from "@/config";
import { logoFor, UsdcLogo } from "@/components/common/AssetLogos";
import { marketLabel } from "@/config/labels";
import { formatChangePercent, formatMarketUsd } from "@/lib/format";
import { apiFetch } from "@/lib/api";
import { FavoriteStar } from "@/features/trade/components/MarketPicker";
import { useTradeSettings } from "@/stores/settings";

function leverageX(bps: number) {
  return Math.round(bps / 10_000);
}

type KindFilter = "all" | "crypto" | "equity" | "favorites";
type SortKey = "market" | "price" | "change" | "volume" | "oi" | "leverage";
type SortDir = "asc" | "desc";

type Ticker = {
  changePct?: number;
  volumeUsd?: number;
  openInterestUsd?: number;
  high?: number;
  low?: number;
  spark?: number[];
};

type PricesPayload = {
  usd?: Record<string, number>;
  raw?: Record<string, string>;
  tickers?: Record<string, Ticker>;
};

type Stats = {
  lastUsd: number;
  lastRaw: bigint;
  changePct: number | null;
  volumeUsd: number;
  openInterestUsd: number;
  high: number;
  low: number;
  spark: number[];
};

const SORTS: { key: SortKey; label: string; align: "left" | "right" }[] = [
  { key: "market", label: "Market", align: "left" },
  { key: "price", label: "Price", align: "right" },
  { key: "change", label: "24h", align: "right" },
];

const ROW_GRID =
  "md:min-w-[1120px] md:grid md:grid-cols-[minmax(230px,1.6fr)_100px_84px_100px_108px_100px_100px_52px_48px] md:items-center md:gap-x-4";

function compactUsd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "—";
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

function emptyLast(a: number | null, b: number | null, dir: SortDir): number {
  const aMiss = a == null || !Number.isFinite(a);
  const bMiss = b == null || !Number.isFinite(b);
  if (aMiss && bMiss) return 0;
  if (aMiss) return 1;
  if (bMiss) return -1;
  return dir === "asc" ? a - b : b - a;
}

function statsFor(market: MarketConfig, payload: PricesPayload | undefined): Stats {
  const id = String(market.marketId);
  const usd = payload?.usd?.[id];
  const raw = payload?.raw?.[id];
  const t = payload?.tickers?.[id];
  let lastRaw = 0n;
  if (raw) {
    try {
      lastRaw = BigInt(raw);
    } catch {
      lastRaw = 0n;
    }
  }
  return {
    lastUsd: usd && usd > 0 ? usd : 0,
    lastRaw,
    changePct: t?.changePct ?? null,
    volumeUsd: t?.volumeUsd ?? 0,
    openInterestUsd: t?.openInterestUsd ?? 0,
    high: t?.high ?? 0,
    low: t?.low ?? 0,
    spark: t?.spark ?? [],
  };
}

function changeClass(pct: number | null): string {
  if (pct == null) return "text-[#6b7c74]";
  return pct >= 0 ? "text-[#14F195]" : "text-[#FF5C6A]";
}

function Sparkline({ values, up }: { values: number[]; up: boolean }) {
  const w = 88;
  const h = 28;
  if (values.length < 2) {
    return <span className="inline-block w-[88px] text-center text-[11px] text-[#4d5f58]">—</span>;
  }
  let min = values[0];
  let max = values[0];
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const span = max - min || 1;
  const last = values.length - 1;
  const pts: string[] = [];
  for (let i = 0; i <= last; i++) {
    const x = (i / last) * w;
    const y = h - 1.5 - ((values[i] - min) / span) * (h - 3);
    pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  }
  const color = up ? "#14F195" : "#FF5C6A";
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden className="block">
      <polyline
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
        points={pts.join(" ")}
      />
    </svg>
  );
}

function SortHead({
  label,
  column,
  sortKey,
  sortDir,
  onSort,
  align,
}: {
  label: string;
  column: SortKey;
  sortKey: SortKey | null;
  sortDir: SortDir;
  onSort: (key: SortKey) => void;
  align: "left" | "right";
}) {
  const on = sortKey === column;
  return (
    <button
      type="button"
      onClick={() => onSort(column)}
      aria-sort={on ? (sortDir === "asc" ? "ascending" : "descending") : "none"}
      className={`inline-flex items-center gap-1 text-[11px] font-semibold uppercase tracking-[.06em] ${
        align === "right" ? "w-full justify-end" : ""
      } ${on ? "text-[#f5f5f5]" : "text-[#6b7c74] hover:text-[#d5ddd8]"}`}
    >
      {label}
      {on ? (
        sortDir === "asc" ? (
          <ChevronUp size={12} className="text-[#14F195]" />
        ) : (
          <ChevronDown size={12} className="text-[#14F195]" />
        )
      ) : null}
    </button>
  );
}

function StaticHead({ label, align }: { label: string; align?: "right" }) {
  return (
    <span
      className={`text-[11px] font-semibold uppercase tracking-[.06em] text-[#6b7c74] ${
        align === "right" ? "block w-full text-right" : ""
      }`}
    >
      {label}
    </span>
  );
}

function MarketRow({ market, stats }: { market: MarketConfig; stats: Stats }) {
  const equity = market.kind === "equity";
  const price =
    stats.lastRaw > 0n || stats.lastUsd > 0
      ? formatMarketUsd(market, stats.lastRaw > 0n ? stats.lastRaw : stats.lastUsd)
      : "—";
  const up = (stats.changePct ?? 0) >= 0;

  return (
    <Link
      href={`/trade/${market.symbol}`}
      className={`group flex flex-col gap-2.5 border-b border-[#15221E] px-3 py-3 last:border-b-0 transition-colors hover:bg-[#0E1614] md:gap-0 md:px-4 md:py-2.5 ${ROW_GRID}`}
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <div
          className="shrink-0"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
        >
          <FavoriteStar symbol={market.symbol} />
        </div>
        {logoFor(market.baseAsset, 22)}
        <span className="min-w-0">
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="truncate text-[13px] font-semibold text-[#f5f5f5]">
              {market.baseAsset}
              <span className="text-[#6b7c74]"> / {market.quoteAsset}</span>
            </span>
            <span className="rounded-[4px] bg-[#15221E] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[.04em] text-[#8A9B94]">
              Perp
            </span>
            <span className="rounded-[4px] bg-[#12201C] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[.04em] text-[#6b7c74]">
              {equity ? "Equity" : "Crypto"}
            </span>
          </span>
          <span className="mt-0.5 block truncate text-[11px] text-[#6b7c74]">{marketLabel(market)}</span>
        </span>
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-2 pl-[38px] text-[13px] md:contents md:pl-0">
        <MarketStat label="Price" align="right">
          <span className="font-mono tabular text-[#f5f5f5]">{price}</span>
        </MarketStat>
        <MarketStat label="24h" align="right">
          <span className={`font-mono tabular ${changeClass(stats.changePct)}`}>
            {stats.changePct == null ? "—" : formatChangePercent(stats.changePct)}
          </span>
        </MarketStat>
        <MarketStat label="Chart">
          <span className="inline-flex w-[88px] justify-center overflow-hidden md:w-full">
            <Sparkline values={stats.spark} up={up} />
          </span>
        </MarketStat>
        <MarketStat label="High / Low" align="right">
          <span className="flex flex-col items-end font-mono tabular leading-tight">
            <span className="text-[12px] text-[#d5ddd8]">{stats.high > 0 ? formatMarketUsd(market, stats.high) : "—"}</span>
            <span className="text-[11px] text-[#6b7c74]">{stats.low > 0 ? formatMarketUsd(market, stats.low) : "—"}</span>
          </span>
        </MarketStat>
        <MarketStat label="24h Volume" align="right">
          <span className="font-mono tabular text-[#d5ddd8]">{compactUsd(stats.volumeUsd)}</span>
        </MarketStat>
        <MarketStat label="Open Interest" align="right">
          <span className="font-mono tabular text-[#d5ddd8]">{compactUsd(stats.openInterestUsd)}</span>
        </MarketStat>
        <MarketStat label="Leverage" align="right">
          <span className="inline-flex h-[22px] items-center justify-end font-mono tabular text-[#c5d4cc] md:w-full">
            {leverageX(market.maxLeverageBps)}x
          </span>
        </MarketStat>
        <span className="hidden text-right text-[12px] font-semibold text-[#6b7c74] transition-colors group-hover:text-[#14F195] md:block">
          Trade
        </span>
      </div>
    </Link>
  );
}

function MarketStat({
  label,
  children,
  align,
}: {
  label: string;
  children: React.ReactNode;
  align?: "right";
}) {
  return (
    <div className={`flex flex-col gap-0.5 md:block ${align === "right" ? "md:text-right" : ""}`}>
      <span className="text-[10px] uppercase tracking-wider text-[#6b7c74] md:hidden">{label}</span>
      {children}
    </div>
  );
}

function OverviewCard({
  title,
  rows,
  onMore,
  payload,
  ready,
}: {
  title: string;
  rows: MarketConfig[];
  onMore: () => void;
  payload: PricesPayload | undefined;
  ready: boolean;
}) {
  return (
    <section className="w-full overflow-hidden rounded-[12px] border border-[#1C332C] bg-[#070B0A]">
      <div className="flex items-center justify-between border-b border-[#15221E] px-3 py-2.5">
        <h2 className="text-[13px] font-semibold text-[#f5f5f5]">{title}</h2>
        <button
          type="button"
          onClick={onMore}
          className="text-[11px] font-semibold text-[#6b7c74] hover:text-[#d5ddd8]"
        >
          More
        </button>
      </div>
      <div>
        {rows.length === 0
          ? ready
            ? (
                <p className="px-3 py-8 text-center text-[12px] text-[#6b7c74]">No names in this list.</p>
              )
            : Array.from({ length: 4 }, (_, i) => (
                <div key={i} className="flex h-[46px] items-center gap-2.5 px-3">
                  <span className="size-[22px] rounded-full bg-[#12201C]" />
                  <span className="h-3 flex-1 rounded bg-[#12201C]" />
                </div>
              ))
          : rows.map((m) => {
              const s = statsFor(m, payload);
              const price =
                s.lastUsd > 0 ? formatMarketUsd(m, s.lastRaw > 0n ? s.lastRaw : s.lastUsd) : "—";
              return (
                <Link
                  key={m.symbol}
                  href={`/trade/${m.symbol}`}
                  className="flex items-center gap-2.5 px-3 py-2 hover:bg-[#0E1614]"
                >
                  {logoFor(m.baseAsset, 22)}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-semibold text-[#f5f5f5]">
                      {m.baseAsset}
                      <span className="font-medium text-[#6b7c74]"> / {m.quoteAsset}</span>
                    </span>
                    <span className="block truncate text-[11px] text-[#6b7c74]">{marketLabel(m)}</span>
                  </span>
                  <span className="shrink-0 text-right">
                    <span className="block font-mono text-[13px] tabular text-[#f5f5f5]">{price}</span>
                    <span className={`block font-mono text-[11px] tabular ${changeClass(s.changePct)}`}>
                      {s.changePct == null ? "—" : formatChangePercent(s.changePct)}
                    </span>
                  </span>
                </Link>
              );
            })}
      </div>
    </section>
  );
}

export function MarketsTable({ markets }: { markets: MarketConfig[] }) {
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<KindFilter>("all");
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const favorites = useTradeSettings((s) => s.favoriteSymbols);

  const { data } = useQuery({
    queryKey: ["prices", "markets-table"],
    queryFn: async () => {
      const res = await apiFetch("/api/prices", { cache: "no-store" });
      if (!res.ok) throw new Error("prices");
      return (await res.json()) as PricesPayload;
    },
    refetchInterval: 15_000,
    staleTime: 10_000,
  });

  const counts = useMemo(() => {
    let crypto = 0;
    let equity = 0;
    for (const m of markets) {
      if (m.kind === "equity") equity += 1;
      else crypto += 1;
    }
    return {
      all: markets.length,
      crypto,
      equity,
      favorites: favorites.filter((s) => markets.some((m) => m.symbol === s)).length,
    };
  }, [markets, favorites]);

  const tabs: { id: KindFilter; label: string; count: number }[] = [
    { id: "all", label: "All", count: counts.all },
    { id: "crypto", label: "Crypto", count: counts.crypto },
    { id: "equity", label: "Equities", count: counts.equity },
    { id: "favorites", label: "Favorites", count: counts.favorites },
  ];

  function onSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "desc" ? "asc" : "desc"));
      return;
    }
    setSortKey(key);
    setSortDir(key === "market" ? "asc" : "desc");
  }

  const pool = useMemo(() => {
    return markets.filter((m) => {
      if (kind === "crypto" && m.kind === "equity") return false;
      if (kind === "equity" && m.kind !== "equity") return false;
      if (kind === "favorites" && !favorites.includes(m.symbol)) return false;
      return true;
    });
  }, [markets, kind, favorites]);

  const visible = useMemo(() => {
    const q = query.trim().toUpperCase();
    const filtered = pool.filter((m) => {
      if (!q) return true;
      const name = marketLabel(m).toUpperCase();
      return m.symbol.includes(q) || m.baseAsset.includes(q) || name.includes(q);
    });
    if (!sortKey) return filtered;

    const rows = filtered.slice();
    rows.sort((a, b) => {
      const sa = statsFor(a, data);
      const sb = statsFor(b, data);
      switch (sortKey) {
        case "market": {
          const cmp = a.baseAsset.localeCompare(b.baseAsset);
          return sortDir === "asc" ? cmp : -cmp;
        }
        case "price":
          return emptyLast(sa.lastUsd > 0 ? sa.lastUsd : null, sb.lastUsd > 0 ? sb.lastUsd : null, sortDir);
        case "change":
          return emptyLast(sa.changePct, sb.changePct, sortDir);
        case "volume":
          return emptyLast(sa.volumeUsd, sb.volumeUsd, sortDir);
        case "oi":
          return emptyLast(sa.openInterestUsd, sb.openInterestUsd, sortDir);
        case "leverage":
          return emptyLast(leverageX(a.maxLeverageBps), leverageX(b.maxLeverageBps), sortDir);
        default:
          return 0;
      }
    });
    return rows;
  }, [pool, query, sortKey, sortDir, data]);

  const boards = useMemo(() => {
    const ranked = pool.slice();
    const hot = ranked
      .slice()
      .sort((a, b) => statsFor(b, data).volumeUsd - statsFor(a, data).volumeUsd)
      .slice(0, 4);
    const gainers = ranked
      .filter((m) => (statsFor(m, data).changePct ?? -Infinity) > 0)
      .sort((a, b) => (statsFor(b, data).changePct ?? 0) - (statsFor(a, data).changePct ?? 0))
      .slice(0, 4);
    const losers = ranked
      .filter((m) => (statsFor(m, data).changePct ?? Infinity) < 0)
      .sort((a, b) => (statsFor(a, data).changePct ?? 0) - (statsFor(b, data).changePct ?? 0))
      .slice(0, 4);
    return { hot, gainers, losers };
  }, [pool, data]);

  const ready = Boolean(data?.tickers);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-3 lg:grid lg:grid-cols-3">
        <OverviewCard
          title="Hot"
          rows={ready ? boards.hot : []}
          payload={data}
          ready={ready}
          onMore={() => {
            setSortKey("volume");
            setSortDir("desc");
          }}
        />
        <OverviewCard
          title="Top Gainers"
          rows={ready ? boards.gainers : []}
          payload={data}
          ready={ready}
          onMore={() => {
            setSortKey("change");
            setSortDir("desc");
          }}
        />
        <OverviewCard
          title="Top Losers"
          rows={ready ? boards.losers : []}
          payload={data}
          ready={ready}
          onMore={() => {
            setSortKey("change");
            setSortDir("asc");
          }}
        />
      </div>

      <div className="overflow-hidden rounded-[12px] border border-[#1C332C] bg-[#070B0A]">
        <div className="flex flex-col gap-2.5 border-b border-[#15221E] px-3 py-2.5 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex min-w-0 flex-nowrap items-center overflow-x-auto no-scrollbar" role="tablist" aria-label="Filter markets">
            {tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={kind === t.id}
                onClick={() => setKind(t.id)}
                className={`desk-tab h-9 shrink-0 px-3 text-[12px] ${kind === t.id ? "is-on" : ""}`}
              >
                {t.label}
                <span className={`ml-1.5 tabular ${kind === t.id ? "text-[#8A9B94]" : "text-[#4d5f58]"}`}>
                  {t.count}
                </span>
              </button>
            ))}
          </div>
          <label className="relative block w-full lg:w-[240px] lg:shrink-0">
            <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[#6b7c74]" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search markets"
              aria-label="Search markets"
              className="h-9 w-full rounded-[8px] border border-[#1C332C] bg-[#0E1614] pl-8 pr-3 text-[13px] text-[#f5f5f5] outline-none placeholder:text-[#5c6b64] focus:border-[#2A4A40]"
            />
          </label>
        </div>

        <div className="flex gap-1 overflow-x-auto border-b border-[#15221E] px-3 py-2 md:hidden">
          {[
            ...SORTS,
            { key: "volume" as const, label: "Volume" },
            { key: "oi" as const, label: "OI" },
            { key: "leverage" as const, label: "Leverage" },
          ].map((s) => {
            const on = sortKey === s.key;
            return (
              <button
                key={s.key}
                type="button"
                onClick={() => onSort(s.key)}
                className={`inline-flex shrink-0 items-center gap-0.5 rounded-[6px] px-2 py-1 text-[11px] font-semibold ${
                  on ? "bg-[#15221E] text-[#f5f5f5]" : "text-[#6b7c74]"
                }`}
              >
                {s.label}
                {on ? sortDir === "asc" ? <ChevronUp size={11} /> : <ChevronDown size={11} /> : null}
              </button>
            );
          })}
        </div>

        <div className="overflow-x-auto">
          <div className={`sticky top-0 z-[1] hidden border-b border-[#15221E] bg-[#070B0A] px-4 py-2 ${ROW_GRID} md:grid`}>
            {SORTS.map((s) => (
              <SortHead
                key={s.key}
                label={s.label}
                column={s.key}
                sortKey={sortKey}
                sortDir={sortDir}
                onSort={onSort}
                align={s.align}
              />
            ))}
            <StaticHead label="Chart" />
            <StaticHead label="High / Low" align="right" />
            <SortHead
              label="24h Volume"
              column="volume"
              sortKey={sortKey}
              sortDir={sortDir}
              onSort={onSort}
              align="right"
            />
            <SortHead
              label="Open Interest"
              column="oi"
              sortKey={sortKey}
              sortDir={sortDir}
              onSort={onSort}
              align="right"
            />
            <SortHead
              label="Lev"
              column="leverage"
              sortKey={sortKey}
              sortDir={sortDir}
              onSort={onSort}
              align="right"
            />
            <span />
          </div>

          {visible.length === 0 ? (
            <div className="px-4 py-14 text-center">
              <div className="text-[13px] font-medium text-[#c5d4cc]">
                {kind === "favorites" && !query.trim() ? "No favorites yet" : "No markets match"}
              </div>
              <p className="mt-1 text-[12px] text-[#6b7c74]">
                {kind === "favorites" && !query.trim()
                  ? "Star a market to pin it here."
                  : query.trim()
                    ? `Nothing for “${query.trim()}”.`
                    : "Try another filter."}
              </p>
            </div>
          ) : (
            visible.map((market) => (
              <MarketRow key={market.symbol} market={market} stats={statsFor(market, data)} />
            ))
          )}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-[#15221E] px-4 py-2.5 text-[11px] text-[#6b7c74]">
          <span className="inline-flex items-center gap-1.5">
            <UsdcLogo size={12} /> Settled in USDC
          </span>
          <span className="tabular">
            {visible.length} of {markets.length}
          </span>
        </div>
      </div>
    </div>
  );
}
