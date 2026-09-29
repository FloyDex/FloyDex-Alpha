"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { MarketConfig } from "@/config";
import { marketLabel } from "@/config/labels";
import { logoFor } from "@/components/common/AssetLogos";
import type { MarketInfoPayload } from "@/lib/market/info";
import { useMarketStore } from "@/stores/market";

type InfoTab = "market" | "trading" | "leverage";

export function MarketInfo({ market }: { market: MarketConfig }) {
  const [tab, setTab] = useState<InfoTab>("market");
  const ticker = useMarketStore((s) => s.ticker24h[market.marketId]);
  const { data } = useQuery({
    queryKey: ["market-info", market.marketId],
    queryFn: async () => {
      const res = await fetch(`/api/markets/${market.marketId}/info`, { cache: "no-store" });
      if (!res.ok) throw new Error("info unavailable");
      return (await res.json()) as MarketInfoPayload;
    },
    refetchInterval: 60_000,
    staleTime: 0,
    refetchOnMount: "always",
  });

  const equity = market.kind === "equity";
  const name = data?.name ?? marketLabel(market);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-[#070B0A] px-5 py-4">
      <div className="flex items-center gap-2">
        {logoFor(market.baseAsset, 22)}
        <div>
          <div className="text-[15px] font-semibold text-[#f5f5f5]">
            {market.baseAsset}
            {market.quoteAsset}{" "}
            <span className="text-[11px] font-medium text-[#8A9B94]">Perp</span>
          </div>
          <div className="text-[12px] text-[#737373]">{name}</div>
        </div>
      </div>

      <div className="mt-4 flex gap-1 border-b border-[#1A2A26] text-[12px] font-medium">
        {(
          [
            ["market", "Market Info"],
            ["trading", "Trading Parameters"],
            ["leverage", "Leverage & Margin"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={`relative px-3 py-2 ${
              tab === id ? "text-[#f5f5f5]" : "text-[#737373] hover:text-[#c5d4cc]"
            }`}
          >
            {label}
            {tab === id && (
              <span className="absolute inset-x-2 -bottom-px h-[2px] rounded-full bg-[#f5f5f5]" />
            )}
          </button>
        ))}
      </div>

      {tab === "market" && (
        <>
          <div className="mt-4 text-[13px] font-semibold text-[#f5f5f5]">Stats</div>
          <p className="mt-1 text-[11px] text-[#737373]">
            {equity
              ? "Figures below cover pre-market / market-open / post-market periods only."
              : "24h figures follow the same Binance venue as the TradingView chart."}
          </p>
          <div className="mt-3 grid grid-cols-2 gap-x-8 gap-y-4 sm:grid-cols-3">
            {equity ? (
              <>
                <Stat label="Market Cap" value={compactUsd(data?.stats.marketCap)} />
                <Stat label="P/E Ratio" value={num(data?.stats.peRatio, 2)} />
                <Stat label="Dividend Yield" value={pct(data?.stats.dividendYield)} />
                <Stat label="EPS" value={usd(data?.stats.eps)} />
                <Stat label="EV" value={compactUsd(data?.stats.enterpriseValue)} />
                <Stat label="FCF" value={compactUsd(data?.stats.fcf)} />
              </>
            ) : (
              <>
                <Stat label="24h High" value={usd(ticker?.highPrice, market.priceDecimals)} />
                <Stat label="24h Low" value={usd(ticker?.lowPrice, market.priceDecimals)} />
                <Stat label="24h Volume" value={compactUsd(ticker?.volumeUsd)} />
                <Stat label="Open Interest" value={compactUsd(ticker?.openInterestUsd)} />
                <Stat
                  label="Funding Rate"
                  value={ticker?.fundingRate == null ? "—" : `${ticker.fundingRate.toFixed(4)}%`}
                />
                <Stat label="Max Leverage" value={`${Math.round(market.maxLeverageBps / 10_000)}x`} />
              </>
            )}
          </div>

          <div className="mt-6 grid gap-4 lg:grid-cols-2">
            <div>
              <div className="text-[13px] font-semibold text-[#f5f5f5]">News</div>
              <p className="mt-1 text-[11px] text-[#737373]">
                For informational purposes only.
              </p>
              <div className="mt-2 divide-y divide-[#1A2A26]">
                {(data?.news ?? []).length === 0 ? (
                  <div className="py-6 text-[12px] text-[#737373]">No headlines right now.</div>
                ) : (
                  data!.news.map((n) => (
                    <a
                      key={n.url}
                      href={n.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block py-3 hover:opacity-90"
                    >
                      <div className="text-[13px] font-medium text-[#f5f5f5]">{n.title}</div>
                      <div className="mt-1 text-[11px] text-[#737373]">
                        {n.publisher}
                        {n.publishedAt ? ` · ${formatNewsTime(n.publishedAt)}` : ""}
                      </div>
                    </a>
                  ))
                )}
              </div>
            </div>
            <div>
              <div className="text-[13px] font-semibold text-[#f5f5f5]">About {name}</div>
              <p className="mt-2 text-[13px] leading-relaxed text-[#c5d4cc]">
                {data?.about ?? "—"}
              </p>
            </div>
          </div>
        </>
      )}

      {tab === "trading" && (
        <div className="mt-4 grid grid-cols-2 gap-x-8 gap-y-4 sm:grid-cols-3">
          <Stat label="Tick Size" value={String(data?.trading.tickSize ?? market.tickSizes[0])} />
          <Stat label="Quote" value={market.quoteAsset} />
          <Stat label="Settlement" value="USDC" />
          <Stat label="Platform Fee" value={`${data?.trading.platformFeePct ?? 1}%`} />
          <Stat label="Chart" value={market.tvSymbol} />
          <Stat label="Oracle" value={market.oracleSymbol} />
          <Stat label="Kind" value={equity ? "TradFi" : "USDT Perp"} />
        </div>
      )}

      {tab === "leverage" && (
        <div className="mt-4 grid grid-cols-2 gap-x-8 gap-y-4 sm:grid-cols-3">
          <Stat label="Max Leverage" value={`${data?.trading.maxLeverage ?? Math.round(market.maxLeverageBps / 10_000)}x`} />
          <Stat label="Initial Margin" value={`${data?.trading.initialMarginPct ?? market.initialMarginBps / 100}%`} />
          <Stat label="Maintenance Margin" value={`${data?.trading.maintenanceMarginPct ?? market.maintenanceMarginBps / 100}%`} />
          <Stat label="Liquidation Fee" value={`${data?.trading.liquidationFeePct ?? market.liquidationFeeBps / 100}%`} />
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[11px] text-[#737373]">{label}</div>
      <div className="mt-1 font-mono text-[16px] font-semibold text-[#f5f5f5]">{value}</div>
    </div>
  );
}

function compactUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1e12) return `${sign}$${(abs / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(2)}`;
}

function usd(n: number | null | undefined, decimals = 2): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `$${n.toFixed(decimals)}`;
}

function num(n: number | null | undefined, decimals = 2): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toFixed(decimals);
}

function pct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${n.toFixed(2)}%`;
}

function formatNewsTime(ms: number): string {
  if (!(ms > 0)) return "";
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
}
