"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Copy, ExternalLink, Search, Star } from "lucide-react";
import { toast } from "sonner";
import { TopNav } from "@/components/common/TopNav";
import { AssetLogo } from "@/components/common/AssetLogos";
import { DEFAULT_MARKET_SYMBOL, MARKETS } from "@/config";
import { useNetwork } from "@/features/network/NetworkContext";
import { apiFetch } from "@/lib/api";
import { shortenAddress } from "@/lib/format";
import {
  WATCH_KEY,
  identiconHues,
  pageWindow,
  parseWatchList,
  timeAgo,
  type LeaderboardPeriod,
} from "@/lib/market/leaderboard";
import { useWalletStore } from "@/stores/wallet";

type Period = LeaderboardPeriod;
type Metric = "pnl" | "volume" | "roi";
type Board = "top" | "watch";

const PERIODS: { id: Period; label: string }[] = [
  { id: "DAY", label: "24H" },
  { id: "WEEK", label: "7D" },
  { id: "MONTH", label: "30D" },
  { id: "ALL", label: "All" },
];

const METRICS: { id: Metric; label: string }[] = [
  { id: "pnl", label: "PnL" },
  { id: "roi", label: "ROI" },
  { id: "volume", label: "Volume" },
];

interface Trader {
  rank: number;
  address: string;
  pnl: number;
  volume: number;
  roi: number;
  winRate: number;
  tradeCount: number;
  wins?: number;
  losses?: number;
  liquidations: number;
  accountValue: number;
  lastTradeAt?: string | null;
  spark?: number[];
  markets?: number[];
  openPositions?: number;
}

interface LeaderboardResp {
  period: Period;
  metric: string;
  total: number;
  traders: Trader[];
  error?: string;
}

const PAGE_SIZE = 10;
const ROW_GRID =
  "md:min-w-[1240px] md:grid md:grid-cols-[44px_minmax(210px,1.6fr)_minmax(0,0.8fr)_minmax(0,1.1fr)_96px_minmax(0,0.95fr)_88px_64px_minmax(0,0.85fr)_72px_104px] md:items-center md:gap-x-3";

const pnlClass = (n: number) => (n >= 0 ? "text-[#14F195]" : "text-[#FF5C6A]");

function fmtUsd(n: number, signed = false) {
  const body =
    "$" +
    Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (!signed) return n < 0 ? `-${body}` : body;
  if (n > 0) return `+${body}`;
  if (n < 0) return `-${body}`;
  return body;
}

function compactUsd(n: number) {
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(1)}K`;
  return fmtUsd(n);
}

function fmtRoi(n: number) {
  const pct = n * 100;
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct.toFixed(2)}%`;
}

function baseForMarket(id: number): string | null {
  const m = Object.values(MARKETS).find((x) => x.marketId === id);
  return m?.baseAsset ?? null;
}

function RankMark({ rank }: { rank: number }) {
  const tone =
    rank === 1
      ? "border-[#14F195]/40 bg-[#14F195]/10 text-[#14F195]"
      : rank === 2
        ? "border-[#8A9B94]/40 bg-[#0E1614] text-[#d5ddd8]"
        : rank === 3
          ? "border-[#E8A317]/40 bg-[#E8A317]/10 text-[#E8A317]"
          : "border-[#1C332C] bg-[#0E1614] text-[#8A9B94]";
  return (
    <span
      className={`inline-grid size-7 place-items-center rounded-full border font-mono text-[11px] font-semibold tabular ${tone}`}
      aria-label={`Rank ${rank}`}
    >
      {rank}
    </span>
  );
}

function Identicon({ address }: { address: string }) {
  const [a, b, c] = identiconHues(address);
  return (
    <svg width={36} height={36} viewBox="0 0 36 36" className="shrink-0 rounded-full" aria-hidden>
      <rect width="36" height="36" rx="18" fill={`hsl(${a} 38% 22%)`} />
      <rect x="6" y="8" width="14" height="20" rx="3" fill={`hsl(${b} 42% 38%)`} />
      <circle cx="24" cy="14" r="7" fill={`hsl(${c} 48% 46%)`} />
    </svg>
  );
}

function Sparkline({ values }: { values: number[] }) {
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
  const up = values[last] >= values[0];
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

function MarketStack({ ids }: { ids: number[] }) {
  const bases = ids.map(baseForMarket).filter((x): x is string => Boolean(x)).slice(0, 3);
  if (!bases.length) return <span className="text-[11px] text-[#4d5f58]">—</span>;
  return (
    <span className="inline-flex items-center">
      {bases.map((sym, i) => (
        <span
          key={`${sym}-${i}`}
          className="inline-flex rounded-full ring-2 ring-[#070B0A]"
          style={{ marginLeft: i === 0 ? 0 : -6 }}
          title={sym}
        >
          <AssetLogo symbol={sym} size={18} />
        </span>
      ))}
    </span>
  );
}

async function fetchBoard(args: {
  period: Period;
  metric: Metric;
  page: number;
  search: string;
  addresses: string[];
}): Promise<LeaderboardResp> {
  const params = new URLSearchParams({
    period: args.period,
    metric: args.metric,
    limit: String(PAGE_SIZE),
    offset: String(args.page * PAGE_SIZE),
  });
  if (args.search) params.set("search", args.search);
  if (args.addresses.length) params.set("addresses", args.addresses.join(","));
  const res = await apiFetch(`/api/leaderboard?${params}`, { cache: "no-store" });
  const json = (await res.json()) as LeaderboardResp;
  if (!res.ok && json.error === "leaderboard_unavailable") {
    return { period: args.period, metric: args.metric, total: 0, traders: [], error: json.error };
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return json;
}

export default function LeaderboardPage() {
  const { address, connected } = useWalletStore();
  const { config } = useNetwork();
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [period, setPeriod] = useState<Period>("MONTH");
  const [metric, setMetric] = useState<Metric>("pnl");
  const [board, setBoard] = useState<Board>("top");
  const [page, setPage] = useState(0);
  const [watched, setWatched] = useState<string[]>([]);

  useEffect(() => {
    setWatched(parseWatchList(window.localStorage.getItem(WATCH_KEY)));
  }, []);

  useEffect(() => {
    const t = window.setTimeout(() => setQuery(search.trim()), 250);
    return () => window.clearTimeout(t);
  }, [search]);

  useEffect(() => {
    setPage(0);
  }, [query, period, metric, board]);

  const watchFilter = board === "watch" ? watched : [];
  const skipWatchFetch = board === "watch" && watched.length === 0;

  const { data, isLoading, isError, refetch, isFetching } = useQuery({
    queryKey: ["leaderboard", period, metric, page, query, board, watchFilter.join(",")],
    enabled: !skipWatchFetch,
    queryFn: () =>
      fetchBoard({
        period,
        metric,
        page,
        search: query,
        addresses: watchFilter,
      }),
    refetchInterval: 15_000,
    placeholderData: keepPreviousData,
  });

  const { data: mine } = useQuery({
    queryKey: ["leaderboard-me", period, metric, address],
    enabled: Boolean(connected && address),
    queryFn: async () => {
      const params = new URLSearchParams({
        period,
        metric,
        limit: "1",
        offset: "0",
        search: address!,
      });
      const res = await apiFetch(`/api/leaderboard?${params}`, { cache: "no-store" });
      const json = (await res.json()) as LeaderboardResp;
      return json.traders.find((t) => t.address === address) ?? null;
    },
    refetchInterval: 15_000,
  });

  const traders = skipWatchFetch ? [] : (data?.traders ?? []);
  const total = skipWatchFetch ? 0 : (data?.total ?? 0);
  const unavailable = data?.error === "leaderboard_unavailable";
  const from = total === 0 ? 0 : page * PAGE_SIZE + 1;
  const to = Math.min((page + 1) * PAGE_SIZE, total);
  const periodLabel = PERIODS.find((p) => p.id === period)?.label ?? "30D";
  const empty = !isLoading && !isError && traders.length === 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const explorerQ = config.cluster === "devnet" ? "?cluster=devnet" : "";

  const watchSet = useMemo(() => new Set(watched), [watched]);

  function accountUrl(owner: string) {
    return `${config.explorerUrl}/account/${owner}${explorerQ}`;
  }

  async function copyAddress(owner: string) {
    try {
      await navigator.clipboard.writeText(owner);
      toast.success("Address copied");
    } catch {
      toast.error("Could not copy address");
    }
  }

  function toggleWatch(owner: string) {
    setWatched((prev) => {
      const next = prev.includes(owner) ? prev.filter((x) => x !== owner) : [owner, ...prev].slice(0, 50);
      window.localStorage.setItem(WATCH_KEY, JSON.stringify(next));
      return next;
    });
  }

  return (
    <div
      className="min-h-screen bg-[#070B0A] text-[#f5f5f5]"
      style={{ fontFamily: "var(--font-poppins), 'Poppins', system-ui, sans-serif" }}
    >
      <TopNav />
      <main className="mx-auto flex w-full max-w-[1360px] flex-col gap-4 px-4 py-5 sm:px-6 sm:py-7">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-[22px] font-semibold tracking-[.01em] sm:text-[24px]">Leaderboard</h1>
            <p className="mt-1 text-[13px] text-[#6b7c74]">
              Realized PnL, ROI, and volume on USDC-settled perps.
            </p>
          </div>
          <p className="text-[12px] tabular text-[#6b7c74]">
            {isFetching && !isLoading ? "Updating · " : null}
            {total.toLocaleString("en-US")} ranked · {periodLabel}
          </p>
        </div>

        {mine ? (
          <YouStrip
            trader={mine}
            periodLabel={periodLabel}
            href={accountUrl(mine.address)}
            onCopy={() => copyAddress(mine.address)}
          />
        ) : null}

        <section className="overflow-hidden rounded-[12px] border border-[#1C332C] bg-[#070B0A]">
          <div className="flex flex-col gap-2.5 border-b border-[#15221E] px-3 py-2.5">
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
              <div className="flex" role="tablist" aria-label="Board">
                <button
                  type="button"
                  role="tab"
                  aria-selected={board === "top"}
                  onClick={() => setBoard("top")}
                  className={`desk-tab h-9 shrink-0 px-3 text-[12px] ${board === "top" ? "is-on" : ""}`}
                >
                  Top traders
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={board === "watch"}
                  onClick={() => setBoard("watch")}
                  className={`desk-tab h-9 shrink-0 px-3 text-[12px] ${board === "watch" ? "is-on" : ""}`}
                >
                  Watched
                  <span className="ml-1.5 tabular text-[#6b7c74]">{watched.length}</span>
                </button>
              </div>
              <label className="relative block w-full sm:w-[240px] sm:shrink-0">
                <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[#6b7c74]" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search wallet"
                  aria-label="Search wallet address"
                  className="h-9 w-full rounded-[8px] border border-[#1C332C] bg-[#0E1614] pl-8 pr-3 font-mono text-[13px] text-[#f5f5f5] outline-none placeholder:font-sans placeholder:text-[#5c6b64] focus:border-[#2A4A40]"
                />
              </label>
            </div>
            <div className="flex min-w-0 flex-wrap items-center gap-1">
              <div className="flex" role="tablist" aria-label="Ranking period">
                {PERIODS.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    role="tab"
                    aria-selected={period === p.id}
                    onClick={() => setPeriod(p.id)}
                    className={`desk-tab h-9 shrink-0 px-3 text-[12px] ${period === p.id ? "is-on" : ""}`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              <span className="mx-1 hidden h-4 w-px bg-[#15221E] sm:block" />
              <div className="flex" role="tablist" aria-label="Ranking metric">
                {METRICS.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    role="tab"
                    aria-selected={metric === m.id}
                    onClick={() => setMetric(m.id)}
                    className={`desk-tab h-9 shrink-0 px-3 text-[12px] ${metric === m.id ? "is-on" : ""}`}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {isLoading && !skipWatchFetch ? (
              <div className="flex flex-col">
                {Array.from({ length: 8 }, (_, i) => (
                  <div key={i} className="flex h-[64px] items-center gap-3 border-b border-[#15221E] px-4 last:border-b-0">
                    <span className="size-9 rounded-full bg-[#12201C]" />
                    <span className="h-3 w-28 rounded bg-[#12201C]" />
                    <span className="ml-auto h-3 w-16 rounded bg-[#12201C]" />
                  </div>
                ))}
              </div>
            ) : isError ? (
              <div className="flex flex-col items-center justify-center gap-3 px-4 py-16 text-center">
                <p className="text-[14px] font-semibold text-[#f5f5f5]">Could not load rankings</p>
                <p className="max-w-[360px] text-[13px] text-[#6b7c74]">The leaderboard feed is down. Try again in a moment.</p>
                <button
                  type="button"
                  onClick={() => refetch()}
                  className="h-9 rounded-[8px] border border-[#1C332C] bg-[#0E1614] px-4 text-[13px] font-semibold text-[#c5d4cc] hover:border-[#2A4A40] hover:text-[#f5f5f5]"
                >
                  Retry
                </button>
              </div>
            ) : empty ? (
              <EmptyBoard
                unavailable={unavailable}
                searching={Boolean(query)}
                watching={board === "watch"}
              />
            ) : (
              <div className="overflow-x-auto">
                <div className={`hidden border-b border-[#15221E] bg-[#070B0A] px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[.06em] text-[#6b7c74] md:grid ${ROW_GRID}`}>
                  <span>#</span>
                  <span>Trader</span>
                  <span className={`text-right ${metric === "roi" ? "text-[#f5f5f5]" : ""}`}>ROI</span>
                  <span className={`text-right ${metric === "pnl" ? "text-[#f5f5f5]" : ""}`}>PnL ({periodLabel})</span>
                  <span>Trend</span>
                  <span className="text-right">Assets</span>
                  <span>Markets</span>
                  <span className="text-right">Win</span>
                  <span className={`text-right ${metric === "volume" ? "text-[#f5f5f5]" : ""}`}>Volume</span>
                  <span className="text-right">Last</span>
                  <span className="text-right">Action</span>
                </div>
                {traders.map((t) => (
                  <TraderRow
                    key={t.address}
                    trader={t}
                    periodLabel={periodLabel}
                    you={t.address === address}
                    watched={watchSet.has(t.address)}
                    href={accountUrl(t.address)}
                    onCopy={() => copyAddress(t.address)}
                    onWatch={() => toggleWatch(t.address)}
                  />
                ))}
              </div>
            )}

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[#15221E] px-4 py-3 text-[12px] text-[#6b7c74]">
            <span className="font-mono tabular">
              {from}–{to} of {total.toLocaleString("en-US")}
            </span>
            <div className="flex items-center gap-1">
              <PageBtn
                disabled={page === 0}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                label="Previous page"
              >
                <path d="M15 18l-6-6 6-6" />
              </PageBtn>
              {pageWindow(page, pageCount).map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => setPage(n)}
                  className={`grid size-8 place-items-center rounded-[8px] border text-[12px] font-semibold tabular transition-colors ${
                    n === page
                      ? "border-[#14F195]/40 bg-[#0E1614] text-[#f5f5f5]"
                      : "border-[#1C332C] text-[#c5d4cc] hover:border-[#2A4A40] hover:text-[#f5f5f5]"
                  }`}
                >
                  {n + 1}
                </button>
              ))}
              <PageBtn
                disabled={to >= total}
                onClick={() => setPage((p) => p + 1)}
                label="Next page"
              >
                <path d="M9 18l6-6-6-6" />
              </PageBtn>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}

function PageBtn({
  disabled,
  onClick,
  label,
  children,
}: {
  disabled: boolean;
  onClick: () => void;
  label: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-label={label}
      className="grid size-8 place-items-center rounded-[8px] border border-[#1C332C] text-[#c5d4cc] transition-colors hover:border-[#2A4A40] hover:text-[#f5f5f5] disabled:border-transparent disabled:text-[#4d5f58] disabled:hover:border-transparent"
    >
      <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        {children}
      </svg>
    </button>
  );
}

function YouStrip({
  trader,
  periodLabel,
  href,
  onCopy,
}: {
  trader: Trader;
  periodLabel: string;
  href: string;
  onCopy: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-[12px] border border-[#1C332C] bg-[#0E1614] px-4 py-3">
      <div className="flex min-w-0 items-center gap-2.5">
        <Identicon address={trader.address} />
        <div className="min-w-0">
          <div className="text-[11px] font-semibold uppercase tracking-[.06em] text-[#14F195]">Your rank</div>
          <button type="button" onClick={onCopy} className="font-mono text-[13px] text-[#d5ddd8] hover:text-[#f5f5f5]">
            {shortenAddress(trader.address)}
          </button>
        </div>
        <RankMark rank={trader.rank} />
      </div>
      <div className="flex flex-wrap items-center gap-4 text-[13px]">
        <span className={`font-mono tabular ${pnlClass(trader.pnl)}`}>{fmtUsd(trader.pnl, true)}</span>
        <span className={`font-mono tabular ${pnlClass(trader.roi)}`}>{fmtRoi(trader.roi)}</span>
        <span className="text-[#6b7c74]">{periodLabel}</span>
        <a href={href} target="_blank" rel="noreferrer" className="text-[12px] font-semibold text-[#8A9B94] hover:text-[#14F195]">
          Explorer
        </a>
      </div>
    </div>
  );
}

function TraderRow({
  trader,
  periodLabel,
  you,
  watched,
  href,
  onCopy,
  onWatch,
}: {
  trader: Trader;
  periodLabel: string;
  you: boolean;
  watched: boolean;
  href: string;
  onCopy: () => void;
  onWatch: () => void;
}) {
  const spark = trader.spark ?? [];
  const inPos = (trader.openPositions ?? 0) > 0;
  return (
    <div
      className={`border-b border-[#15221E] last:border-b-0 ${you ? "bg-[#14F195]/[0.04]" : "hover:bg-[#0E1614]"}`}
    >
      <div className={`hidden px-4 py-3 md:grid ${ROW_GRID}`}>
        <RankMark rank={trader.rank} />
        <div className="flex min-w-0 items-center gap-2.5">
          <Identicon address={trader.address} />
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-1.5">
              <button
                type="button"
                onClick={onCopy}
                title={trader.address}
                className="truncate font-mono text-[13px] text-[#f5f5f5] hover:text-[#14F195]"
              >
                {shortenAddress(trader.address)}
              </button>
              {you ? (
                <span className="rounded-[4px] bg-[#12201C] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[.04em] text-[#14F195]">
                  You
                </span>
              ) : null}
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-[#6b7c74]">
              <span className="tabular">{trader.tradeCount.toLocaleString("en-US")} fills</span>
              {inPos ? (
                <span className="rounded-[4px] border border-[#1C332C] px-1 py-px text-[10px] uppercase tracking-[.04em] text-[#8A9B94]">
                  In position
                </span>
              ) : null}
              {trader.liquidations > 0 ? (
                <span className="text-[#FF5C6A]">{trader.liquidations} liq</span>
              ) : null}
            </div>
          </div>
        </div>
        <span className={`text-right font-mono text-[13px] font-semibold tabular ${pnlClass(trader.roi)}`}>
          {fmtRoi(trader.roi)}
        </span>
        <span className={`text-right font-mono text-[13px] font-semibold tabular ${pnlClass(trader.pnl)}`}>
          {fmtUsd(trader.pnl, true)}
        </span>
        <Sparkline values={spark} />
        <span className="text-right font-mono text-[13px] tabular text-[#f5f5f5]">{fmtUsd(trader.accountValue)}</span>
        <MarketStack ids={trader.markets ?? []} />
        <span className="text-right font-mono text-[13px] tabular text-[#d5ddd8]">
          {(trader.winRate * 100).toFixed(0)}%
        </span>
        <span className="text-right font-mono text-[13px] tabular text-[#d5ddd8]">{compactUsd(trader.volume)}</span>
        <span className="text-right font-mono text-[12px] tabular text-[#6b7c74]">{timeAgo(trader.lastTradeAt)}</span>
        <div className="flex justify-end">
          <RowActions watched={watched} href={href} onCopy={onCopy} onWatch={onWatch} />
        </div>
      </div>

      <div className="flex items-start justify-between gap-2 p-4 md:hidden">
        <div className="flex min-w-0 items-start gap-2.5">
          <Identicon address={trader.address} />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <RankMark rank={trader.rank} />
              <button type="button" onClick={onCopy} className="truncate font-mono text-[13px] text-[#f5f5f5]">
                {shortenAddress(trader.address)}
              </button>
            </div>
            <div className={`mt-2 font-mono text-[16px] font-semibold tabular ${pnlClass(trader.pnl)}`}>
              {fmtUsd(trader.pnl, true)}
              <span className={`ml-2 text-[13px] font-medium ${pnlClass(trader.roi)}`}>{fmtRoi(trader.roi)}</span>
            </div>
            <div className="mt-2">
              <Sparkline values={spark} />
            </div>
            <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-[13px]">
              <MobileStat label={`PnL (${periodLabel})`} value={fmtUsd(trader.pnl, true)} cls={pnlClass(trader.pnl)} />
              <MobileStat label="Assets" value={fmtUsd(trader.accountValue)} />
              <MobileStat label="Win rate" value={`${(trader.winRate * 100).toFixed(0)}%`} />
              <MobileStat label="Volume" value={compactUsd(trader.volume)} />
              <MobileStat label="Last" value={timeAgo(trader.lastTradeAt)} />
              <MobileStat label="Fills" value={String(trader.tradeCount)} />
            </div>
          </div>
        </div>
        <RowActions watched={watched} href={href} onCopy={onCopy} onWatch={onWatch} />
      </div>
    </div>
  );
}

function RowActions({
  watched,
  href,
  onCopy,
  onWatch,
}: {
  watched: boolean;
  href: string;
  onCopy: () => void;
  onWatch: () => void;
}) {
  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        onClick={onWatch}
        aria-label={watched ? "Remove from watchlist" : "Watch trader"}
        aria-pressed={watched}
        className={`grid size-8 place-items-center rounded-[8px] border transition-colors ${
          watched
            ? "border-[#14F195]/40 text-[#14F195]"
            : "border-[#1C332C] text-[#6b7c74] hover:border-[#2A4A40] hover:text-[#f5f5f5]"
        }`}
      >
        <Star size={13} fill={watched ? "currentColor" : "none"} />
      </button>
      <button
        type="button"
        onClick={onCopy}
        aria-label="Copy address"
        className="grid size-8 place-items-center rounded-[8px] border border-[#1C332C] text-[#6b7c74] hover:border-[#2A4A40] hover:text-[#f5f5f5]"
      >
        <Copy size={13} />
      </button>
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        aria-label="Open explorer"
        className="grid size-8 place-items-center rounded-[8px] border border-[#1C332C] text-[#6b7c74] hover:border-[#2A4A40] hover:text-[#f5f5f5]"
      >
        <ExternalLink size={13} />
      </a>
    </div>
  );
}

function MobileStat({ label, value, cls }: { label: string; value: string; cls?: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-[.06em] text-[#6b7c74]">{label}</span>
      <span className={`font-mono tabular ${cls ?? "text-[#f5f5f5]"}`}>{value}</span>
    </div>
  );
}

function EmptyBoard({
  unavailable,
  searching,
  watching,
}: {
  unavailable: boolean;
  searching: boolean;
  watching: boolean;
}) {
  const title = watching
    ? "No watched traders"
    : searching
      ? "No matching traders"
      : unavailable
        ? "Rankings are not live yet"
        : "No traders ranked yet";
  const body = watching
    ? "Star a wallet on Top traders to keep it on this desk."
    : searching
      ? "Try a different wallet address."
      : unavailable
        ? "The stats indexer is not connected. Trade as usual — ranks will fill in once fills settle."
        : "Open a position to appear here. Rankings track realized PnL, volume, and ROI.";
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-4 py-16 text-center">
      <p className="text-[14px] font-semibold text-[#f5f5f5]">{title}</p>
      <p className="max-w-[420px] text-[13px] text-[#6b7c74]">{body}</p>
      {!searching && !watching ? (
        <Link
          href={`/trade/${DEFAULT_MARKET_SYMBOL}`}
          className="mt-1 inline-flex h-9 items-center rounded-[8px] bg-[#14F195] px-4 text-[13px] font-semibold text-[#050807] transition-colors hover:bg-[#3DFFB0]"
        >
          Open Long or Open Short
        </Link>
      ) : null}
    </div>
  );
}
