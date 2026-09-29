"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { logoFor } from "@/components/common/AssetLogos";
import { formatMarketPrice, priceToHuman } from "@/lib/format";
import {
  compactStat,
  equitySessionNow,
  technicalScore,
  type PerformanceKey,
  type SymbolDetails as Details,
} from "@/lib/market/symbol-details";
import { useMarketStore } from "@/stores/market";
import type { MarketConfig } from "@/config";
import { X } from "lucide-react";

const PERIODS: PerformanceKey[] = ["1W", "1M", "3M", "6M", "YTD", "1Y"];

function formatAgo(asOf: number, now: number): string {
  if (!(asOf > 0)) return "";
  const s = Math.max(0, Math.round((now - asOf) / 1000));
  if (s < 8) return "Live";
  if (s < 60) return `Updated ${s}s ago`;
  if (s < 3600) return `Updated ${Math.floor(s / 60)}m ago`;
  return `Updated ${Math.floor(s / 3600)}h ago`;
}

export function SymbolDetails({
  market,
  onClose,
}: {
  market: MarketConfig;
  onClose: () => void;
}) {
  const [more, setMore] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const markPrice = useMarketStore((s) => s.markPrices[market.marketId]);
  const changePctStore = useMarketStore((s) => s.priceChangePct[market.marketId]);
  const ticker = useMarketStore((s) => s.ticker24h[market.marketId]);
  const { data } = useQuery({
    queryKey: ["symbol-details", market.marketId],
    queryFn: async () => {
      const res = await fetch(`/api/markets/${market.marketId}/details`, { cache: "no-store" });
      if (!res.ok) throw new Error("details unavailable");
      return (await res.json()) as Details;
    },
    refetchInterval: 15_000,
  });

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const live = markPrice ? priceToHuman(markPrice) : data?.price;
  const prevClose = data?.prevClose;
  const changeAbs =
    live != null && prevClose && prevClose > 0 ? live - prevClose : data?.changeAbs;
  const changePct =
    changePctStore !== undefined
      ? changePctStore
      : live != null && prevClose && prevClose > 0
        ? ((live - prevClose) / prevClose) * 100
        : data?.changePct;
  const volume =
    market.kind === "equity" && ticker?.volume && ticker.volume > 0
      ? ticker.volume
      : ticker?.volumeUsd && ticker.volumeUsd > 0 && market.kind !== "equity"
        ? ticker.volumeUsd
        : data?.volume;
  const session =
    market.kind === "equity" ? equitySessionNow(now) : { open: true, label: "Market open" };
  const tech =
    live != null && data
      ? {
          ...technicalScore(live, data.technicals.sma20, data.technicals.sma50, data.technicals.rsi),
          rsi: data.technicals.rsi,
          sma20: data.technicals.sma20,
          sma50: data.technicals.sma50,
        }
      : data?.technicals;

  const price = live;
  const [whole, frac] = price !== undefined
    ? formatMarketPrice(market, price).split(".")
    : ["—", ""];
  const up = (changePct ?? 0) >= 0;

  const lastPx = useRef(price);
  const [flash, setFlash] = useState<"up" | "down" | null>(null);
  const [markAsOf, setMarkAsOf] = useState(0);
  useEffect(() => {
    if (price == null || price === lastPx.current) return;
    if (lastPx.current != null) setFlash(price >= lastPx.current ? "up" : "down");
    lastPx.current = price;
    setMarkAsOf(Date.now());
    const t = window.setTimeout(() => setFlash(null), 420);
    return () => window.clearTimeout(t);
  }, [price]);

  const asOf = markAsOf || data?.asOf || 0;
  const ago = formatAgo(asOf, now);

  return (
    <aside className="flex h-full w-full flex-col overflow-y-auto border-r border-[#15221E] bg-[#070B0A] px-4 py-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          {logoFor(market.baseAsset, 22)}
          <span className="truncate text-[13px] font-semibold text-[#f5f5f5]">
            {market.baseAsset}{market.quoteAsset}
          </span>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="grid h-7 w-7 place-items-center rounded-[6px] text-[#737373] hover:bg-[#1A2A26] hover:text-[#f5f5f5]"
          aria-label="Close symbol details"
        >
          <X size={14} />
        </button>
      </div>

      <div className="mt-2 text-[12px] text-[#a3a3a3]">
        {market.baseAsset} / {market.quoteAsset}
        <span className="text-[#737373]"> · {data?.venue ?? "FLOYDEX"}</span>
      </div>
      <div className="mt-0.5 text-[11px] text-[#737373]">
        Perp · {market.kind === "equity" ? "Equity" : "Crypto"}
      </div>

      <div className="mt-4 flex flex-wrap items-end gap-2">
        <div
          className={`font-mono leading-none text-[#f5f5f5] transition-colors duration-300 ${
            flash === "up" ? "text-[#1fae5b]" : flash === "down" ? "text-[#e34c4c]" : ""
          }`}
        >
          <span className="text-[28px] font-semibold">{whole}</span>
          {frac && <span className="text-[16px] text-[#a3a3a3]">.{frac}</span>}
          <span className="ml-0.5 text-[11px] text-[#737373]">{market.quoteAsset}</span>
        </div>
      </div>
      <div className={`mt-1 font-mono text-[12px] ${up ? "text-[#1fae5b]" : "text-[#e34c4c]"}`}>
        {changeAbs != null && changePct != null ? (
          <>
            {changeAbs >= 0 ? "+" : ""}
            {changeAbs.toFixed(Math.min(market.priceDecimals, 3))}{" "}
            {changePct >= 0 ? "+" : ""}
            {changePct.toFixed(2)}%
          </>
        ) : "—"}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px]">
        <span className="flex items-center gap-1.5">
          <span className={`h-1.5 w-1.5 rounded-full ${session.open ? "bg-[#1fae5b]" : "bg-[#737373]"} ${session.open ? "animate-pulse" : ""}`} />
          <span className={session.open ? "text-[#1fae5b]" : "text-[#a3a3a3]"}>
            {session.label}
          </span>
        </span>
        {ago && (
          <span className="text-[11px] text-[#737373]">{ago}</span>
        )}
      </div>

      <Section title="Key statistics">
        <Stat label="Volume" value={volume != null ? compactStat(volume) : "—"} />
        <Stat label="Average Volume (30D)" value={data ? compactStat(data.avgVolume30d) : "—"} />
      </Section>

      <Section title="Performance">
        <div className="grid grid-cols-3 gap-2">
          {PERIODS.map((key) => {
            const v = data?.performance[key];
            const tone = v == null ? "text-[#737373]" : v >= 0 ? "text-[#1fae5b]" : "text-[#e34c4c]";
            return (
              <div key={key} className="rounded-[6px] bg-[#0E1614] px-2 py-2 text-center">
                <div className={`font-mono text-[12px] font-semibold ${tone}`}>
                  {v == null ? "—" : `${v.toFixed(2)}%`}
                </div>
                <div className="mt-0.5 text-[10px] text-[#737373]">{key}</div>
              </div>
            );
          })}
        </div>
      </Section>

      <Section title="Technicals">
        <Gauge score={tech?.score ?? 0} label={tech?.label ?? "—"} />
        <button
          type="button"
          onClick={() => setMore((v) => !v)}
          className="mt-3 w-full rounded-full border border-[#1A2A26] bg-[#0E1614] py-2 text-[12px] text-[#c5d4cc] hover:border-[#2A4A40]"
        >
          {more ? "Hide technicals" : "More technicals"}
        </button>
        {more && tech && (
          <div className="mt-2 space-y-1">
            <Stat label="RSI (14)" value={tech.rsi != null ? tech.rsi.toFixed(1) : "—"} />
            <Stat label="SMA 20" value={tech.sma20 != null ? formatMarketPrice(market, tech.sma20) : "—"} />
            <Stat label="SMA 50" value={tech.sma50 != null ? formatMarketPrice(market, tech.sma50) : "—"} />
          </div>
        )}
      </Section>
    </aside>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-5">
      <div className="mb-2 text-[13px] font-semibold text-[#f5f5f5]">{title}</div>
      {children}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between py-[5px] text-[12.5px]">
      <span className="text-[#a3a3a3]">{label}</span>
      <span className="font-mono text-[#f5f5f5]">{value}</span>
    </div>
  );
}

function Gauge({ score, label }: { score: number; label: string }) {
  const clamped = Math.max(-1, Math.min(1, score));
  const angle = -90 + ((clamped + 1) / 2) * 180;
  return (
    <div className="flex flex-col items-center pt-1">
      <svg viewBox="0 0 160 92" className="h-[88px] w-[160px]">
        <path d="M16 80 A64 64 0 0 1 144 80" fill="none" stroke="#2a2a31" strokeWidth="8" strokeLinecap="round" />
        <path d="M16 80 A64 64 0 0 1 48 28" fill="none" stroke="#e34c4c" strokeWidth="8" strokeLinecap="round" />
        <path d="M112 28 A64 64 0 0 1 144 80" fill="none" stroke="#3b82f6" strokeWidth="8" strokeLinecap="round" />
        <g transform={`rotate(${angle} 80 80)`}>
          <circle cx="80" cy="80" r="5" fill="#f5f5f5" />
          <line x1="80" y1="80" x2="80" y2="28" stroke="#f5f5f5" strokeWidth="2.4" strokeLinecap="round" />
        </g>
      </svg>
      <div className="mt-1 text-[18px] font-semibold text-[#f5f5f5]">{label}</div>
    </div>
  );
}
