"use client";

import Link from "next/link";
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { ACTIVE_MARKETS, type MarketConfig } from "@/config";
import { formatChangePercent, formatMarketPrice, priceToHuman } from "@/lib/format";
import { apiFetch } from "@/lib/api";
import { useMarketStore } from "@/stores/market";
import { logoFor } from "@/components/common/AssetLogos";

type PricePayload = {
  usd?: Record<string, number>;
  tickers?: Record<string, { changePct?: number; volumeUsd?: number }>;
};

const PINNED = ["BTC-PERP", "ETH-PERP", "SOL-PERP", "TSLA-PERP", "NVDA-PERP", "QQQ-PERP", "MSFT-PERP"];

function pairLabel(market: MarketConfig) {
  return `${market.baseAsset}USDT Perp`;
}

function TickerItems({
  copy,
  markets,
  usd,
  tickers,
}: {
  copy: number;
  markets: MarketConfig[];
  usd: Record<string, number>;
  tickers: Record<string, { changePct?: number }>;
}) {
  return (
    <>
      {markets.map((m) => {
        const px = usd[String(m.marketId)];
        const chg = tickers[String(m.marketId)]?.changePct;
        const tone =
          chg == null ? "text-[#8A9B94]" : chg >= 0 ? "text-[#14F195]" : "text-[#ff4d5f]";
        return (
          <Link
            key={`${copy}-${m.symbol}`}
            href={`/trade/${m.symbol}`}
            className="flex shrink-0 items-center gap-[6px] px-3 text-[12px] leading-none hover:bg-white/[.04]"
            tabIndex={copy === 0 ? undefined : -1}
          >
            {logoFor(m.baseAsset, 14)}
            <span className="whitespace-nowrap text-[#d5ddd8]">{pairLabel(m)}</span>
            <span className={`whitespace-nowrap font-medium ${tone}`}>
              {chg == null ? "—" : formatChangePercent(chg)}
            </span>
            <span className="whitespace-nowrap font-mono tabular text-[#f5f5f5]">
              {px && px > 0 ? formatMarketPrice(m, px) : "—"}
            </span>
          </Link>
        );
      })}
    </>
  );
}

export function PopularTicker() {
  const storeMarks = useMarketStore((s) => s.markPrices);
  const storeChg = useMarketStore((s) => s.priceChangePct);
  const storeVol = useMarketStore((s) => s.ticker24h);

  const { data } = useQuery({
    queryKey: ["prices", "ticker"],
    queryFn: async () => {
      const res = await apiFetch("/api/prices", { cache: "no-store" });
      if (!res.ok) throw new Error("prices");
      return (await res.json()) as PricePayload;
    },
    refetchInterval: 15_000,
    staleTime: 8_000,
  });

  const { markets, usd, tickers } = useMemo(() => {
    const usd: Record<string, number> = { ...(data?.usd ?? {}) };
    const tickers: Record<string, { changePct?: number; volumeUsd?: number }> = {
      ...(data?.tickers ?? {}),
    };
    for (const [id, raw] of Object.entries(storeMarks)) {
      if (raw > 0n && usd[id] == null) {
        usd[id] = priceToHuman(raw);
      }
    }
    for (const [id, pct] of Object.entries(storeChg)) {
      tickers[id] = { ...tickers[id], changePct: pct };
    }
    for (const [id, t] of Object.entries(storeVol)) {
      tickers[id] = {
        changePct: tickers[id]?.changePct ?? t.changePct,
        volumeUsd: tickers[id]?.volumeUsd ?? t.volumeUsd,
      };
    }

    const list = Object.values(ACTIVE_MARKETS).slice();
    list.sort((a, b) => {
      const ia = PINNED.indexOf(a.symbol);
      const ib = PINNED.indexOf(b.symbol);
      if (ia !== -1 || ib !== -1) {
        if (ia === -1) return 1;
        if (ib === -1) return -1;
        return ia - ib;
      }
      const va = tickers[String(a.marketId)]?.volumeUsd ?? 0;
      const vb = tickers[String(b.marketId)]?.volumeUsd ?? 0;
      return vb - va;
    });
    return { markets: list, usd, tickers };
  }, [data, storeMarks, storeChg, storeVol]);

  if (markets.length === 0) return null;

  return (
    <div className="flex h-[28px] items-center border-t border-[#15221E] bg-[#070B0A]">
      <div className="relative z-[1] shrink-0 bg-[#070B0A] pl-3 pr-2 text-[11px] font-semibold uppercase tracking-[.08em] text-[#FF8A00]">
        Popular
      </div>
      <div className="group relative min-w-0 flex-1 overflow-hidden">
        <div className="pointer-events-none absolute inset-y-0 left-0 z-[1] w-6 bg-gradient-to-r from-[#070B0A] to-transparent" />
        <div className="pointer-events-none absolute inset-y-0 right-0 z-[1] w-8 bg-gradient-to-l from-[#070B0A] to-transparent" />
        <div className="floy-ticker flex w-max group-hover:[animation-play-state:paused] motion-reduce:animate-none">
          <div className="flex">
            <TickerItems copy={0} markets={markets} usd={usd} tickers={tickers} />
          </div>
          <div className="flex motion-reduce:hidden" aria-hidden="true">
            <TickerItems copy={1} markets={markets} usd={usd} tickers={tickers} />
          </div>
        </div>
      </div>
    </div>
  );
}
