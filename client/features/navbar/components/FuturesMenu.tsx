"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronRight, Star } from "lucide-react";
import { logoFor } from "@/components/common/AssetLogos";
import { marketLabel, tradFiMarkets, usdtPerpMarkets } from "@/config/labels";
import type { MarketConfig } from "@/config";
import { formatChangePercent, formatMarketUsd } from "@/lib/format";
import { useMarketStore } from "@/stores/market";
import { useTradeSettings } from "@/stores/settings";

type Venue = "usdt" | "tradfi";

export function FuturesMenu({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname() ?? "";
  const [open, setOpen] = useState(false);
  const [venue, setVenue] = useState<Venue>("usdt");
  const ref = useRef<HTMLDivElement>(null);
  const active = pathname.startsWith("/trade");
  const usdt = usdtPerpMarkets();
  const tradfi = tradFiMarkets();
  const rows = venue === "usdt" ? usdt : tradfi;

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={`desk-tab flex items-center gap-1 px-3 py-2 text-[13px] ${
          active ? "is-on" : ""
        }`}
      >
        Futures
        <svg width={10} height={10} viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6">
          <path d="M3 4.5 L6 7.5 L9 4.5" />
        </svg>
      </button>
      {open && (
        <div className="absolute left-0 top-full z-50 mt-2 flex overflow-hidden rounded-[12px] border border-[#1C332C] bg-[#0E1614] shadow-[0_20px_50px_rgba(0,0,0,.55)]">
          <div className="w-[190px] border-r border-[#1A2A26] py-2">
            <VenueRow
              label="USDT Perps"
              active={venue === "usdt"}
              onHover={() => setVenue("usdt")}
              onClick={() => setVenue("usdt")}
            />
            <VenueRow
              label="TradFi"
              active={venue === "tradfi"}
              onHover={() => setVenue("tradfi")}
              onClick={() => setVenue("tradfi")}
            />
          </div>
          <div className="w-[280px] max-h-[420px] overflow-y-auto py-1">
            {rows.length === 0 ? (
              <div className="px-3 py-6 text-center text-[12px] text-[#737373]">No markets listed.</div>
            ) : (
              rows.map((m) => (
                <MarketRow
                  key={m.symbol}
                  market={m}
                  onPick={() => {
                    setOpen(false);
                    onNavigate?.();
                  }}
                />
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function FuturesDrawerLinks({ onNavigate }: { onNavigate: () => void }) {
  const [venue, setVenue] = useState<Venue | null>(null);
  const usdt = usdtPerpMarkets();
  const tradfi = tradFiMarkets();
  const rows = venue === "usdt" ? usdt : venue === "tradfi" ? tradfi : [];

  return (
    <div className="px-1 pb-2">
      <div className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-[#6b7c74]">Futures</div>
      <button
        type="button"
        onClick={() => setVenue((v) => (v === "usdt" ? null : "usdt"))}
        className="flex w-full items-center justify-between rounded-[8px] px-4 py-3 text-[15px] font-medium text-[#a3a3a3] hover:bg-[#070B0A] hover:text-[#f5f5f5]"
      >
        USDT Perps
        <ChevronRight size={16} className={venue === "usdt" ? "rotate-90 text-[#f5f5f5]" : ""} />
      </button>
      {venue === "usdt" &&
        rows.map((m) => (
          <Link
            key={m.symbol}
            href={`/trade/${m.symbol}`}
            onClick={onNavigate}
            className="flex items-center gap-2 rounded-[8px] px-6 py-2.5 text-[14px] text-[#c5d4cc] hover:bg-[#070B0A] hover:text-[#f5f5f5]"
          >
            {logoFor(m.baseAsset, 18)}
            {m.baseAsset}
            {m.quoteAsset}
          </Link>
        ))}
      <button
        type="button"
        onClick={() => setVenue((v) => (v === "tradfi" ? null : "tradfi"))}
        className="flex w-full items-center justify-between rounded-[8px] px-4 py-3 text-[15px] font-medium text-[#a3a3a3] hover:bg-[#070B0A] hover:text-[#f5f5f5]"
      >
        TradFi
        <ChevronRight size={16} className={venue === "tradfi" ? "rotate-90 text-[#f5f5f5]" : ""} />
      </button>
      {venue === "tradfi" &&
        tradfi.map((m) => (
          <Link
            key={m.symbol}
            href={`/trade/${m.symbol}`}
            onClick={onNavigate}
            className="flex items-center gap-2 rounded-[8px] px-6 py-2.5 text-[14px] text-[#c5d4cc] hover:bg-[#070B0A] hover:text-[#f5f5f5]"
          >
            {logoFor(m.baseAsset, 18)}
            {m.baseAsset}
            {m.quoteAsset}
          </Link>
        ))}
    </div>
  );
}

function VenueRow({
  label,
  active,
  onHover,
  onClick,
}: {
  label: string;
  active: boolean;
  onHover: () => void;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onMouseEnter={onHover}
      onClick={onClick}
      className={`flex w-full items-center justify-between px-4 py-2.5 text-[13px] ${
        active ? "bg-[#12201C] text-[#f5f5f5]" : "text-[#a3a3a3] hover:bg-[#12201C] hover:text-[#f5f5f5]"
      }`}
    >
      {label}
      <ChevronRight size={14} />
    </button>
  );
}

function MarketRow({ market, onPick }: { market: MarketConfig; onPick: () => void }) {
  const mark = useMarketStore((s) => s.markPrices[market.marketId]);
  const change = useMarketStore((s) => s.priceChangePct[market.marketId]);
  const favorites = useTradeSettings((s) => s.favoriteSymbols);
  const toggleFavorite = useTradeSettings((s) => s.toggleFavorite);
  const liked = favorites.includes(market.symbol);
  const last = mark && mark > 0n ? formatMarketUsd(market, mark) : "—";

  return (
    <div className="flex items-center gap-1 px-2 py-1.5 hover:bg-[#1A2A26]">
      <button
        type="button"
        aria-label={liked ? "Remove favorite" : "Add favorite"}
        onClick={() => toggleFavorite(market.symbol)}
        className="grid h-7 w-7 shrink-0 place-items-center text-[#737373] hover:text-[#f5c518]"
      >
        <Star size={13} fill={liked ? "#f5c518" : "none"} color={liked ? "#f5c518" : "currentColor"} />
      </button>
      <Link
        href={`/trade/${market.symbol}`}
        onClick={onPick}
        className="flex min-w-0 flex-1 items-center justify-between gap-2"
      >
        <span className="flex min-w-0 items-center gap-2">
          {logoFor(market.baseAsset, 18)}
          <span className="min-w-0">
            <span className="block truncate text-[13px] font-semibold text-[#f5f5f5]">
              {market.baseAsset}
              {market.quoteAsset}
            </span>
            <span className="block truncate text-[10px] text-[#737373]">{marketLabel(market)}</span>
          </span>
        </span>
        <span className="shrink-0 text-right">
          <span className="block font-mono text-[12px] text-[#f5f5f5]">{last}</span>
          <span
            className={`block font-mono text-[10px] ${
              change === undefined ? "text-[#737373]" : change >= 0 ? "text-[#1fae5b]" : "text-[#e34c4c]"
            }`}
          >
            {change === undefined ? "—" : formatChangePercent(change)}
          </span>
        </span>
      </Link>
    </div>
  );
}
