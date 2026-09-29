"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Star } from "lucide-react";
import { ACTIVE_MARKETS, type MarketConfig } from "@/config";
import { marketLabel, isTradFi } from "@/config/labels";
import { formatChangePercent, formatMarketUsd } from "@/lib/format";
import { useMarketStore } from "@/stores/market";
import { useTradeSettings } from "@/stores/settings";
import { logoFor } from "@/components/common/AssetLogos";

type Tab = "favorites" | "usdt" | "tradfi";

export function MarketPicker({
  market,
  open,
  onClose,
}: {
  market: MarketConfig;
  open: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<Tab>("usdt");
  const inputRef = useRef<HTMLInputElement>(null);
  const markPrices = useMarketStore((s) => s.markPrices);
  const tickers = useMarketStore((s) => s.ticker24h);
  const favorites = useTradeSettings((s) => s.favoriteSymbols);
  const toggleFavorite = useTradeSettings((s) => s.toggleFavorite);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setTab(isTradFi(market) ? "tradfi" : "usdt");
    const t = window.setTimeout(() => inputRef.current?.focus(), 20);
    return () => window.clearTimeout(t);
  }, [open, market]);

  const rows = useMemo(() => {
    const all = Object.values(ACTIVE_MARKETS);
    const q = query.trim().toUpperCase();
    return all.filter((m) => {
      if (tab === "favorites" && !favorites.includes(m.symbol)) return false;
      if (tab === "usdt" && isTradFi(m)) return false;
      if (tab === "tradfi" && !isTradFi(m)) return false;
      if (!q) return true;
      const name = marketLabel(m).toUpperCase();
      return m.symbol.includes(q) || m.baseAsset.includes(q) || name.includes(q);
    });
  }, [query, tab, favorites]);

  if (!open) return null;

  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div className="absolute left-0 top-full z-50 mt-2 w-[min(560px,calc(100vw-24px))] overflow-hidden rounded-[12px] border border-[#1C332C] bg-[#0E1614] shadow-[0_20px_50px_rgba(0,0,0,.55)]">
        <div className="border-b border-[#1A2A26] p-3">
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search"
            aria-label="Search markets"
            className="w-full rounded-[8px] border border-[#1A2A26] bg-[#070B0A] px-3 py-2 text-[13px] text-[#f5f5f5] outline-none placeholder:text-[#737373] focus:border-[#2A4A40]"
          />
          <div className="mt-3 flex gap-2 text-[12px] font-medium">
            {(
              [
                ["favorites", "Favorites"],
                ["usdt", "USDT Perps"],
                ["tradfi", "TradFi"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setTab(id)}
                className={`rounded-full px-3 py-1 ${
                  tab === id ? "bg-[#1A2A26] text-[#f5f5f5]" : "text-[#a3a3a3] hover:text-[#f5f5f5]"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="grid grid-cols-[1fr_88px_72px_88px] gap-2 px-3 py-2 text-[10px] font-medium uppercase tracking-wide text-[#6b7c74]">
          <span>Symbols</span>
          <span className="text-right">Last Price</span>
          <span className="text-right">24h Chg</span>
          <span className="text-right">Funding</span>
        </div>
        <div className="max-h-[380px] overflow-y-auto">
          {rows.length === 0 ? (
            <div className="px-3 py-8 text-center text-[12px] text-[#737373]">
              {tab === "favorites" && !query ? "Star a market to save it here." : "No markets match."}
            </div>
          ) : (
            rows.map((m) => {
              const mark = markPrices[m.marketId];
              const ticker = tickers[m.marketId];
              const last = mark && mark > 0n ? formatMarketUsd(m, mark) : "—";
              const chg = ticker?.changePct;
              const fund = ticker?.fundingRate;
              const liked = favorites.includes(m.symbol);
              return (
                <div
                  key={m.symbol}
                  className={`grid grid-cols-[1fr_88px_72px_88px] items-center gap-2 px-3 py-2.5 hover:bg-[#1A2A26] ${
                    m.marketId === market.marketId ? "bg-[#12201C]" : ""
                  }`}
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <button
                      type="button"
                      aria-label={liked ? "Remove favorite" : "Add favorite"}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleFavorite(m.symbol);
                      }}
                      className="shrink-0 text-[#737373] hover:text-[#f5c518]"
                    >
                      <Star size={14} fill={liked ? "#f5c518" : "none"} color={liked ? "#f5c518" : "currentColor"} />
                    </button>
                    <button
                      type="button"
                      className="flex min-w-0 items-center gap-2 text-left"
                      onClick={() => {
                        onClose();
                        if (m.symbol !== market.symbol) router.push(`/trade/${m.symbol}`);
                      }}
                    >
                      {logoFor(m.baseAsset, 20)}
                      <span className="min-w-0">
                        <span className="block truncate text-[13px] font-semibold text-[#f5f5f5]">
                          {m.baseAsset}{m.quoteAsset} <span className="text-[10px] font-medium text-[#8A9B94]">Perp</span>
                        </span>
                        <span className="block truncate text-[11px] text-[#737373]">{marketLabel(m)}</span>
                      </span>
                    </button>
                  </div>
                  <button
                    type="button"
                    className="text-right font-mono text-[12px] text-[#f5f5f5]"
                    onClick={() => {
                      onClose();
                      if (m.symbol !== market.symbol) router.push(`/trade/${m.symbol}`);
                    }}
                  >
                    {last}
                  </button>
                  <span
                    className={`text-right font-mono text-[12px] ${
                      chg === undefined ? "text-[#737373]" : chg >= 0 ? "text-[#1fae5b]" : "text-[#e34c4c]"
                    }`}
                  >
                    {chg === undefined ? "—" : formatChangePercent(chg)}
                  </span>
                  <span className="text-right font-mono text-[12px] text-[#c5d4cc]">
                    {fund === undefined ? "—" : `${fund >= 0 ? "" : ""}${fund.toFixed(4)}%`}
                  </span>
                </div>
              );
            })
          )}
        </div>
      </div>
    </>
  );
}

export function FavoriteStar({ symbol }: { symbol: string }) {
  const favorites = useTradeSettings((s) => s.favoriteSymbols);
  const toggleFavorite = useTradeSettings((s) => s.toggleFavorite);
  const liked = favorites.includes(symbol);
  return (
    <button
      type="button"
      aria-label={liked ? "Remove favorite" : "Add favorite"}
      onClick={() => toggleFavorite(symbol)}
      className="grid h-7 w-7 place-items-center rounded-[6px] text-[#737373] hover:text-[#f5c518]"
    >
      <Star size={15} fill={liked ? "#f5c518" : "none"} color={liked ? "#f5c518" : "currentColor"} />
    </button>
  );
}
