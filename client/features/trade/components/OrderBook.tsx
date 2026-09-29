"use client";

import { useEffect, useRef, useState } from "react";
import { useMarketStore } from "@/stores/market";
import type { OrderBookLevel } from "@/lib/market/matcher";
import { UsdcLogo, logoFor } from "@/components/common/AssetLogos";
import type { MarketConfig } from "@/config";
import { Shuffle } from "lucide-react";
const CaretIcon = () => (
  <svg width={9} height={9} viewBox="0 0 12 12" fill="currentColor">
    <path d="M2 4 L6 8 L10 4 Z" />
  </svg>
);

type ViewMode = "both" | "asks" | "bids";

interface LevelRow {
  price: number;
  metric: number; // size in base or quote, per denomination
  cum: number;
}

// Aggregate raw book levels into price buckets of `tick`.
function groupByTick(levels: OrderBookLevel[], tick: number, isBid: boolean): { price: number; size: number }[] {
  const map = new Map<string, number>();
  for (const l of levels) {
    const p = parseFloat(l.price);
    const s = parseFloat(l.size);
    if (!isFinite(p) || !isFinite(s)) continue;
    const bucket = isBid ? Math.floor(p / tick) * tick : Math.ceil(p / tick) * tick;
    const key = bucket.toFixed(8);
    map.set(key, (map.get(key) ?? 0) + s);
  }
  const out = [...map.entries()].map(([k, size]) => ({ price: parseFloat(k), size }));
  out.sort((a, b) => (isBid ? b.price - a.price : a.price - b.price));
  return out;
}

export function OrderBook({ market }: { market: MarketConfig }) {
  const marketId = market.marketId;
  // The aggregation ladder is per asset — a $0.20 tick ladder is useless on a
  // $77,000 book. Comes from MarketConfig.tickSizes.
  const TICKS = market.tickSizes;
  const [activeTab, setActiveTab] = useState<"Order Book" | "Trades">("Order Book");
  const [hover, setHover] = useState<HoverState>(null);
  // Default to the second-finest tick, clamped for markets with a short ladder.
  const [tickIdx, setTickIdx] = useState(() => Math.min(1, TICKS.length - 1));
  const [tickOpen, setTickOpen] = useState(false);
  const [denomQuote, setDenomQuote] = useState(true); // false = base asset, true = quote (USDC)
  const [viewMode, setViewMode] = useState<ViewMode>("both");

  const book = useMarketStore((s) => s.orderBooks[marketId]);
  const tradesRaw = useMarketStore((s) => s.recentTrades[marketId]);
  const setSelectedPrice = useMarketStore((s) => s.setSelectedPrice);
  const trades = tradesRaw ?? [];

  // Switching markets can leave tickIdx past the end of a shorter ladder.
  const safeTickIdx = Math.min(tickIdx, TICKS.length - 1);
  const tick = TICKS[safeTickIdx];
  const unit = denomQuote ? market.quoteAsset : market.baseAsset;
  const depth = viewMode === "both" ? 10 : 22;
  // Enough decimals to render the chosen tick, but never fewer than the
  // market's own display precision.
  const priceDecimals = Math.max(market.priceDecimals, Math.ceil(-Math.log10(tick)));
  const tradeMetric = (price: string, size: string) => {
    const p = parseFloat(price);
    const s = parseFloat(size);
    if (!isFinite(p) || !isFinite(s)) return 0;
    return denomQuote ? p * s : s;
  };

  // Group → slice → cumulative on the chosen denomination metric.
  const toRows = (levels: { price: number; size: number }[]): LevelRow[] => {
    let run = 0;
    return levels.slice(0, depth).map(({ price, size }) => {
      const metric = denomQuote ? price * size : size;
      run += metric;
      return { price, metric, cum: run };
    });
  };

  const asks = toRows(groupByTick(book?.asks ?? [], tick, false));
  const bids = toRows(groupByTick(book?.bids ?? [], tick, true));

  const maxDepth = Math.max(
    asks.length ? asks[asks.length - 1].cum : 0,
    bids.length ? bids[bids.length - 1].cum : 0,
    1
  );

  const displayAsks = [...asks].reverse(); // highest at top, best ask near spread

  const bestAsk = asks[0]?.price ?? null;
  const bestBid = bids[0]?.price ?? null;
  const spreadAbs = bestAsk !== null && bestBid !== null ? (bestAsk - bestBid).toFixed(priceDecimals) : null;
  const midPrice = bestAsk !== null && bestBid !== null ? (bestAsk + bestBid) / 2 : null;
  const spreadPct =
    spreadAbs && midPrice ? ((parseFloat(spreadAbs) / midPrice) * 100).toFixed(3) + "%" : "0.000%";

  const lastTrades = trades;
  const lastPx = lastTrades[0] ? parseFloat(lastTrades[0].price) : midPrice;
  const lastSide = lastTrades[0]?.side;
  const bidNotional = bids.reduce((n, r) => n + r.metric, 0);
  const askNotional = asks.reduce((n, r) => n + r.metric, 0);
  const bookTotal = bidNotional + askNotional;
  const bidPct = bookTotal > 0 ? (bidNotional / bookTotal) * 100 : 50;
  const prevLast = useRef<number | null>(null);
  const [lastFlash, setLastFlash] = useState<"up" | "down" | null>(null);
  useEffect(() => {
    if (lastPx == null) return;
    if (prevLast.current != null && lastPx !== prevLast.current) {
      setLastFlash(lastPx >= prevLast.current ? "up" : "down");
      const t = setTimeout(() => setLastFlash(null), 380);
      prevLast.current = lastPx;
      return () => clearTimeout(t);
    }
    prevLast.current = lastPx;
  }, [lastPx]);

  const tabCls = (active: boolean) =>
    `desk-tab h-full flex-1 text-center text-[12.5px] ${active ? "is-on" : ""}`;

  const onPriceClick = (price: number) => setSelectedPrice(marketId, price);

  const Asks = (
    <div className="flex-1 overflow-y-auto flex flex-col" style={{ scrollbarWidth: "none" }}>
      {displayAsks.length === 0 ? (
        <EmptyRows count={8} side="ask" />
      ) : (
        displayAsks.map((a, displayIdx) => {
          const originalIdx = asks.length - 1 - displayIdx;
          const hl = hover?.side === "ask" && originalIdx <= asks.length - 1 - (hover?.idx ?? 0);
          return (
            <BookRow
              key={`ask-${a.price}`}
              level={a}
              side="ask"
              maxCum={maxDepth}
              highlight={hl}
              priceDecimals={priceDecimals}
              onClick={() => onPriceClick(a.price)}
              onEnter={() => setHover({ side: "ask", idx: displayIdx })}
              onLeave={() => setHover(null)}
            />
          );
        })
      )}
    </div>
  );

  const Bids = (
    <div className="flex-1 overflow-y-auto flex flex-col" style={{ scrollbarWidth: "none" }}>
      {bids.length === 0 ? (
        <EmptyRows count={8} side="bid" />
      ) : (
        bids.map((b, i) => {
          const hl = hover?.side === "bid" && i <= (hover?.idx ?? -1);
          return (
            <BookRow
              key={`bid-${b.price}`}
              level={b}
              side="bid"
              maxCum={maxDepth}
              highlight={hl}
              priceDecimals={priceDecimals}
              onClick={() => onPriceClick(b.price)}
              onEnter={() => setHover({ side: "bid", idx: i })}
              onLeave={() => setHover(null)}
            />
          );
        })
      )}
    </div>
  );

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Tabs */}
      <div className="mx-2 flex h-9 shrink-0 border-b border-[#15221E]">
        {(["Order Book", "Trades"] as const).map((t) => (
          <button key={t} className={tabCls(activeTab === t)} onClick={() => setActiveTab(t)}>
            {t}
          </button>
        ))}
      </div>

      {activeTab === "Order Book" ? (
        <>
          {/* Sub-controls */}
          <div className="flex items-center justify-between px-[8px] py-[7px] shrink-0 font-mono text-[12px] font-semibold text-[#f5f5f5]">
            <div className="flex items-center gap-[6px]">
              <div className="relative">
                <button
                  className="flex items-center gap-[7px] hover:text-[#f5f5f5] transition-colors"
                  onClick={() => setTickOpen((v) => !v)}
                >
                  {formatTick(tick)} <CaretIcon />
                </button>
                {tickOpen && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setTickOpen(false)} />
                    <div className="absolute left-0 top-full mt-1 z-50 rounded-[8px] border border-[#1C332C] bg-[#0E1614] p-1 shadow-[0_10px_30px_rgba(0,0,0,.5)]">
                      {TICKS.map((t, i) => (
                        <button
                          key={t}
                          onClick={() => { setTickIdx(i); setTickOpen(false); }}
                          className={`block w-full text-left px-3 py-[5px] rounded-[5px] transition-colors ${
                            i === safeTickIdx ? "text-[#f5f5f5] bg-[#0E1614]" : "text-[#a3a3a3] hover:text-[#f5f5f5] hover:bg-[#0E1614]"
                          }`}
                        >
                          {formatTick(t)}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
            </div>
            <div className="flex items-center gap-[8px]">
              <button
                className="flex items-center gap-[8px] text-[#f5f5f5] hover:text-[#f5f5f5] transition-colors"
                onClick={() => setDenomQuote((v) => !v)}
                title="Toggle size denomination"
              >
                {denomQuote ? <UsdcLogo size={13} /> : logoFor(market.baseAsset, 13)} {unit}{" "}
                <Shuffle size={13} className="text-[#a3a3a3]" />
              </button>
              <button
                className="hover:opacity-80 transition-opacity"
                onClick={() => setViewMode((m) => (m === "both" ? "asks" : m === "asks" ? "bids" : "both"))}
                title={`View: ${viewMode}`}
              >
                <svg width={16} height={14} viewBox="0 0 16 14" fill="none">
                  <circle cx="2.4" cy="4" r="1.7" fill={viewMode === "bids" ? "#525252" : "#e06a6a"} />
                  <rect x="6" y="3.2" width="9" height="1.6" rx="0.8" fill={viewMode === "bids" ? "#525252" : "#6b7280"} />
                  <circle cx="2.4" cy="10" r="1.7" fill={viewMode === "asks" ? "#525252" : "#54bd7c"} />
                  <rect x="6" y="9.2" width="9" height="1.6" rx="0.8" fill={viewMode === "asks" ? "#525252" : "#6b7280"} />
                </svg>
              </button>
            </div>
          </div>

          {/* Column headers */}
          <div className={`${BOOK_COLS} px-2 pb-[6px] font-mono text-[10.5px] text-[#7d8f88] shrink-0`}>
            <span className="min-w-0">Price</span>
            <span className="min-w-0 text-right">Size</span>
            <span className="min-w-0 text-right">Total</span>
          </div>

          {viewMode !== "bids" && Asks}

          <div
            className={`flex shrink-0 items-center justify-between px-2 py-1.5 ${
              lastFlash === "up" ? "floy-flash-up" : lastFlash === "down" ? "floy-flash-down" : "bg-[#0B1210]"
            }`}
          >
            <button
              type="button"
              className={`font-mono text-[15px] font-semibold tabular ${
                lastSide === "sell" ? "text-[#FF5C6A]" : "text-[#14F195]"
              }`}
              onClick={() => lastPx != null && onPriceClick(lastPx)}
            >
              {(lastPx ?? midPrice)?.toFixed(priceDecimals) ?? "—"}
            </button>
            <div className="text-right font-mono text-[10px] leading-tight text-[#7d8f88]">
              <div>Spread {spreadAbs ?? "—"}</div>
              <div>{spreadPct}</div>
            </div>
          </div>

          {viewMode !== "asks" && Bids}
          <div className="flex shrink-0 items-center gap-2 px-2 py-1.5">
            <span className="font-mono text-[10px] text-[#14F195]">{bidPct.toFixed(1)}%</span>
            <div className="flex h-[3px] flex-1 overflow-hidden rounded-full bg-[#15221E]">
              <div className="h-full bg-[#14F195]" style={{ width: `${bidPct}%` }} />
              <div className="h-full bg-[#FF5C6A]" style={{ width: `${100 - bidPct}%` }} />
            </div>
            <span className="font-mono text-[10px] text-[#FF5C6A]">{(100 - bidPct).toFixed(1)}%</span>
          </div>
        </>
      ) : (
        /* Trades tab */
        <div className="flex flex-col flex-1 overflow-hidden">
          <div className={`${TAPE_COLS} border-b border-[#1A2A26] px-[8px] py-[6px] font-mono text-[11px] text-[#9fb0c9] shrink-0`}>
            <span className="min-w-0">Price</span>
            <span className="min-w-0 text-right">Size</span>
            <span className="text-right">Time</span>
          </div>
          <div className="flex-1 overflow-y-auto" style={{ scrollbarWidth: "none" }}>
            {trades.length === 0 ? (
              <div className="flex items-center justify-center h-16">
                <span className="text-[11px] text-[#737373]">No trades yet</span>
              </div>
            ) : (
              trades.map((t, i) => (
                <div
                  key={`${t.timestamp}-${i}`}
                  className={`${TAPE_COLS} cursor-pointer px-2 py-1 font-mono text-[11px] hover:bg-white/[0.02] ${i === 0 ? "floy-tape-in" : ""}`}
                  onClick={() => setSelectedPrice(marketId, parseFloat(t.price))}
                >
                  <span
                    className={`min-w-0 truncate tabular-nums ${
                      t.side === "buy"
                        ? "text-[#14F195]"
                        : t.side === "sell"
                          ? "text-[#FF5C6A]"
                          : "text-[#a3a3a3]"
                    }`}
                  >
                    {parseFloat(t.price).toFixed(market.priceDecimals)}
                  </span>
                  <span className="min-w-0 truncate text-right tabular-nums text-[#f5f5f5]">
                    {fmtBook(tradeMetric(t.price, t.size))}
                  </span>
                  <span className="shrink-0 text-right tabular-nums text-[#a3a3a3]">
                    {fmtTapeTime(t.timestamp)}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

type HoverState = { side: "ask" | "bid"; idx: number } | null;

const BOOK_COLS =
  "grid [grid-template-columns:minmax(0,1.15fr)_minmax(0,0.95fr)_minmax(0,1fr)] gap-x-1.5";
const TAPE_COLS =
  "grid [grid-template-columns:minmax(0,1.1fr)_minmax(0,0.9fr)_58px] gap-x-1.5";

function fmtTapeTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

// toFixed, not String(): String(0.00001) is "1e-5".
function formatTick(t: number): string {
  return t.toFixed(Math.max(0, Math.ceil(-Math.log10(t))));
}

/** Compact so size/total never collide in the 270px book rail. */
function fmtBook(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0.00";
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e4) return `${(n / 1e3).toFixed(1)}K`;
  if (abs >= 1e3) return n.toLocaleString("en-US", { maximumFractionDigits: 1 });
  return n.toFixed(2);
}

function BookRow({
  level,
  side,
  maxCum,
  highlight,
  priceDecimals,
  onClick,
  onEnter,
  onLeave,
}: {
  level: LevelRow;
  side: "ask" | "bid";
  maxCum: number;
  highlight: boolean;
  priceDecimals: number;
  onClick: () => void;
  onEnter: () => void;
  onLeave: () => void;
}) {
  const barPct = (level.cum / maxCum) * 100;
  const prev = useRef(level.metric);
  const [flash, setFlash] = useState<"up" | "down" | null>(null);
  useEffect(() => {
    if (prev.current === level.metric) return;
    setFlash(level.metric >= prev.current ? "up" : "down");
    prev.current = level.metric;
    const t = setTimeout(() => setFlash(null), 320);
    return () => clearTimeout(t);
  }, [level.metric]);

  return (
    <div
      className={`${BOOK_COLS} relative cursor-pointer overflow-hidden rounded-[4px] px-[5px] py-[3px] font-mono text-[11px] hover:bg-white/[0.03] ${
        flash === "up" ? "floy-flash-up" : flash === "down" ? "floy-flash-down" : ""
      }`}
      style={{ margin: "1px 8px", lineHeight: 1.4 }}
      onClick={onClick}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      <div
        className={`absolute inset-y-0 right-0 rounded-[4px] ${
          side === "ask" ? "bg-[rgba(255,92,106,0.22)]" : "bg-[rgba(20,241,149,0.16)]"
        }`}
        style={{ width: `${barPct}%`, transition: "width 180ms ease-out" }}
      />
      {highlight && <div className="absolute inset-0 z-[1] bg-white/[0.08]" />}
      <span
        className={`relative z-10 min-w-0 truncate tabular-nums ${
          side === "ask" ? "text-[#FF5C6A]" : "text-[#14F195]"
        }`}
      >
        {level.price.toFixed(priceDecimals)}
      </span>
      <span className="relative z-10 min-w-0 truncate text-right tabular-nums text-[#f5f5f5]">
        {fmtBook(level.metric)}
      </span>
      <span className="relative z-10 min-w-0 truncate text-right tabular-nums text-[#8A9B94]">
        {fmtBook(level.cum)}
      </span>
    </div>
  );
}

function EmptyRows({ count, side }: { count: number; side: "ask" | "bid" }) {
  const widths = [40, 56, 32, 48, 36, 52, 28, 44, 60, 34, 50, 38, 46, 30];
  return (
    <>
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className={`${BOOK_COLS} font-mono text-[11px]`}
          style={{ padding: "3px 8px", lineHeight: 1.4 }}
        >
          <div
            className={`h-[5px] rounded-full opacity-[0.06] ${side === "ask" ? "bg-[#e06a6a]" : "bg-[#54bd7c]"}`}
            style={{ width: widths[i % widths.length] }}
          />
          <div className="h-[5px] rounded-full bg-[#1C332C] opacity-[0.06] ml-auto" style={{ width: 36 }} />
          <div className="h-[5px] rounded-full bg-[#1C332C] opacity-[0.06] ml-auto" style={{ width: 44 }} />
        </div>
      ))}
    </>
  );
}
