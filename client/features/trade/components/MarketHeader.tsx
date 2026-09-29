"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { MarketConfig } from "@/config";
import { getOpenInterest } from "@/lib/stellar/contracts";
import { formatAmount, formatChangePercent, formatMarketUsd, priceToHuman } from "@/lib/format";
import { useMarketStore } from "@/stores/market";
import { logoFor } from "@/components/common/AssetLogos";
import { compactStat } from "@/lib/market/symbol-details";
import { FavoriteStar, MarketPicker } from "@/features/trade/components/MarketPicker";
import { Info } from "lucide-react";

const CaretIcon = () => (
  <svg width={10} height={10} viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6">
    <path d="M3 4.5 L6 7.5 L9 4.5" />
  </svg>
);

function useFundingCountdown() {
  const [left, setLeft] = useState("00:00:00");
  useEffect(() => {
    const tick = () => {
      const period = 8 * 60 * 60 * 1000;
      const rem = period - (Date.now() % period);
      const h = Math.floor(rem / 3_600_000);
      const m = Math.floor((rem % 3_600_000) / 60_000);
      const s = Math.floor((rem % 60_000) / 1000);
      setLeft(
        `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
      );
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);
  return left;
}

function compactUsd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "—";
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

export function MarketHeader({
  market,
  detailsOpen,
  onToggleDetails,
}: {
  market: MarketConfig;
  detailsOpen?: boolean;
  onToggleDetails?: () => void;
}) {
  const [pairOpen, setPairOpen] = useState(false);
  const fundingLeft = useFundingCountdown();
  const markPrice = useMarketStore((s) => s.markPrices[market.marketId]);
  const stats = useMarketStore((s) => s.marketStats[market.marketId]);
  const ticker24h = useMarketStore((s) => s.ticker24h[market.marketId]);
  const changePct = useMarketStore((s) => s.priceChangePct[market.marketId]);

  const { data: oi } = useQuery({
    queryKey: ["oi", market.marketId],
    queryFn: () => getOpenInterest(market.marketId),
    refetchInterval: 15_000,
  });

  const markHuman = markPrice ? priceToHuman(markPrice) : null;
  // Last/index follow the same venue as the TradingView chart (Binance spot / Yahoo),
  // not the last on-chain fill — that is why the tape used to disagree with the chart.
  const lastDisplay = markHuman !== null ? formatMarketUsd(market, markHuman) : "—";
  const markDisplay = lastDisplay;
  const indexDisplay = lastDisplay;

  const equity = market.kind === "equity";
  const volumeDisplay = equity && ticker24h?.volume && ticker24h.volume > 0
    ? compactStat(ticker24h.volume)
    : ticker24h && ticker24h.volumeUsd > 0
      ? compactUsd(ticker24h.volumeUsd)
      : stats && stats.volume > 0n
        ? compactUsd(Number(formatAmount(stats.volume, 0).replace(/,/g, "")))
        : "—";

  const leverageDisplay = Math.round(market.maxLeverageBps / 10_000);
  const changeDisplay = changePct !== undefined ? formatChangePercent(changePct) : "—";
  const changeUp = changePct === undefined || changePct >= 0;
  const highDisplay = formatMarketUsd(market, ticker24h?.highPrice);
  const lowDisplay = formatMarketUsd(market, ticker24h?.lowPrice);
  const oiVenue = oi ? Number(formatAmount(oi.total, 0).replace(/,/g, "")) : 0;
  const oiDisplay =
    oiVenue > 0
      ? compactUsd(oiVenue)
      : !equity && ticker24h && ticker24h.openInterestUsd > 0
        ? compactUsd(ticker24h.openInterestUsd)
        : equity
          ? "—"
          : volumeDisplay;
  const fundingRate =
    ticker24h?.fundingRate !== undefined
      ? `${ticker24h.fundingRate.toFixed(4)}%`
      : "—";

  const prevLast = useRef(lastDisplay);
  const [flash, setFlash] = useState<"up" | "down" | null>(null);
  useEffect(() => {
    if (lastDisplay === "—" || lastDisplay === prevLast.current) return;
    const next = Number(lastDisplay.replace(/[^0-9.-]/g, ""));
    const prev = Number(prevLast.current.replace(/[^0-9.-]/g, ""));
    if (Number.isFinite(next) && Number.isFinite(prev) && prev > 0) {
      setFlash(next >= prev ? "up" : "down");
    }
    prevLast.current = lastDisplay;
    const t = setTimeout(() => setFlash(null), 420);
    return () => clearTimeout(t);
  }, [lastDisplay]);

  const statItems: Array<{ label: string; value: string; tone?: "up" | "down" | "muted" }> = [
    { label: "Mark", value: markDisplay },
    { label: "Index", value: indexDisplay },
    { label: "24h High", value: highDisplay },
    { label: "24h Low", value: lowDisplay },
    { label: "24h Vol", value: volumeDisplay },
    ...(!equity
      ? [
          { label: "Open Interest", value: oiDisplay },
          { label: "Funding / Countdown", value: `${fundingRate} / ${fundingLeft}` as string, tone: "muted" as const },
        ]
      : []),
  ];

  return (
    <div className="flex h-[48px] items-center border-b border-[#15221E] bg-[#070B0A]">
      <div className="relative flex h-full shrink-0 items-center gap-2 px-3">
        <div className="flex items-center gap-2">
          <FavoriteStar symbol={market.symbol} />
          <button
            type="button"
            className="flex items-center gap-[7px] transition-opacity hover:opacity-90"
            onClick={() => setPairOpen((v) => !v)}
            aria-haspopup="menu"
            aria-expanded={pairOpen}
            aria-label={`${market.baseAsset} / ${market.quoteAsset}`}
            data-tour="pair"
          >
            <MarketPairLabel baseSymbol={market.baseAsset} quoteAsset={market.quoteAsset} />
            <span className="text-[#7d8f88]">
              <CaretIcon />
            </span>
          </button>
          <span className="rounded-[4px] bg-[#0E1614] px-1.5 py-[1px] font-mono text-[10px] font-semibold uppercase tracking-[.08em] text-[#8A9B94]">
            Perp
          </span>
          <span className="rounded-[4px] bg-[#0E1614] px-1.5 py-[1px] font-mono text-[10px] font-semibold text-[#f5f5f5]">
            {leverageDisplay}x
          </span>
          {onToggleDetails && (
            <button
              type="button"
              onClick={onToggleDetails}
              aria-pressed={detailsOpen}
              title="Symbol details"
              className={`grid h-7 w-7 place-items-center rounded-[6px] transition-colors ${
                detailsOpen
                  ? "bg-[#15221E] text-[#f5f5f5]"
                  : "text-[#7d8f88] hover:bg-[#15221E] hover:text-[#f5f5f5]"
              }`}
            >
              <Info size={13} strokeWidth={2.2} />
            </button>
          )}
        </div>
        <MarketPicker market={market} open={pairOpen} onClose={() => setPairOpen(false)} />
      </div>

      <div className="h-7 w-px shrink-0 bg-[#15221E]" />

      <div className="flex h-full min-w-0 flex-1 items-center overflow-x-auto no-scrollbar">
        <div className={`flex h-full shrink-0 items-center gap-2.5 px-3 ${flash === "up" ? "floy-flash-up" : flash === "down" ? "floy-flash-down" : ""}`}>
          <span className="floy-live-dot" aria-hidden />
          <span
            className={`font-mono text-[20px] font-semibold leading-none tabular ${
              changeUp ? "text-[#14F195]" : "text-[#FF5C6A]"
            }`}
          >
            {lastDisplay}
          </span>
          <span
            className={`font-mono text-[12px] font-semibold tabular ${
              changeUp ? "text-[#14F195]" : "text-[#FF5C6A]"
            }`}
          >
            {changeDisplay}
          </span>
        </div>

        <div className="flex h-full min-w-0 flex-1 items-center gap-5 px-2">
          {statItems.map((s) => (
            <div key={s.label} className="flex h-full shrink-0 flex-col justify-center gap-[1px]">
              <span className="whitespace-nowrap text-[10px] font-medium text-[#5C6E67]">{s.label}</span>
              <span
                className={`font-mono text-[12px] font-semibold tabular ${
                  s.tone === "up"
                    ? "text-[#14F195]"
                    : s.tone === "down"
                    ? "text-[#FF5C6A]"
                    : s.tone === "muted"
                    ? "text-[#c5d4cc]"
                    : "text-[#f5f5f5]"
                }`}
              >
                {s.value}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function MarketPairLabel({ baseSymbol, quoteAsset }: { baseSymbol: string; quoteAsset: string }) {
  return (
    <span className="flex items-center gap-[7px]">
      {logoFor(baseSymbol, 24)}
      <span className="flex items-center gap-[3px] text-[15px] font-semibold text-[#f5f5f5]" style={{ letterSpacing: ".01em" }}>
        {baseSymbol}
        <span className="font-normal text-[#737373]">/</span>
        <span>{quoteAsset}</span>
      </span>
    </span>
  );
}
