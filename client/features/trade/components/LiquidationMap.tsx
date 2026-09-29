"use client";

import { useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { MarketConfig } from "@/config";
import { formatMarketPrice } from "@/lib/format";
import type { LiqMapBin, LiqMapPayload } from "@/lib/market/liquidation-map";

function usd(n: number): string {
  if (!(n > 0)) return "$0";
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

function stamp(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19);
}

export function LiquidationMap({ market }: { market: MarketConfig }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["liq-map", market.marketId],
    queryFn: async () => {
      const res = await fetch(`/api/markets/${market.marketId}/liquidation-map`, { cache: "no-store" });
      if (!res.ok) throw new Error("liq map unavailable");
      return (await res.json()) as LiqMapPayload;
    },
    refetchInterval: 15_000,
  });

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#070B0A] px-3 py-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-3 text-[11px]">
          <Legend swatch="line" color="#14F195" label="Cum. Long Liq. Intensity" />
          <Legend swatch="line" color="#FF5C6A" label="Cum. Short Liq. Intensity" />
          <Legend swatch="bar" color="#E8A317" label="Curr. Price Liq. Intensity" />
        </div>
        <div className="text-[10px] text-[#6b7c74]">
          Data updated at: {data ? stamp(data.updatedAt) : "—"}
        </div>
      </div>
      <div className="relative mt-2 min-h-0 flex-1">
        {isLoading && <p className="p-6 text-center text-[12px] text-[#6b7c74]">Loading liquidation map…</p>}
        {error && (
          <p className="p-6 text-center text-[12px] text-[#FF5C6A]">Could not load liquidation map.</p>
        )}
        {data && data.points.length > 0 && <MapChart market={market} data={data} />}
      </div>
      <p className="mt-2 shrink-0 text-[10px] leading-relaxed text-[#6b7c74]">
        {data?.source ?? "—"}. Estimated CEX-wide liquidation levels, not a live order-by-order book.
        FloyDex positions are overlaid when present.
      </p>
    </div>
  );
}

function Legend({
  swatch,
  color,
  label,
}: {
  swatch: "line" | "bar";
  color: string;
  label: string;
}) {
  return (
    <span className="flex items-center gap-1.5 text-[#a3a3a3]">
      {swatch === "bar" ? (
        <span className="inline-block h-2 w-2.5" style={{ background: color }} />
      ) : (
        <span className="inline-block h-[2px] w-3.5" style={{ background: color }} />
      )}
      {label}
    </span>
  );
}

function MapChart({ market, data }: { market: MarketConfig; data: LiqMapPayload }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ x: number; y: number; bin: LiqMapBin } | null>(null);
  const W = 1000;
  const H = 420;
  const pad = { l: 62, r: 62, t: 28, b: 36 };
  const innerW = W - pad.l - pad.r;
  const innerH = H - pad.t - pad.b;
  const pts = data.points;
  const minP = pts[0].price;
  const maxP = pts[pts.length - 1].price;
  const maxBar = Math.max(1, ...pts.map((p) => p.atUsd));
  const maxCum = Math.max(1, ...pts.map((p) => Math.max(p.cumLongUsd, p.cumShortUsd)));
  const xOf = (price: number) => pad.l + ((price - minP) / (maxP - minP || 1)) * innerW;
  const yBar = (usd: number) => pad.t + innerH - (usd / maxBar) * innerH;
  const yCum = (usd: number) => pad.t + innerH - (usd / maxCum) * innerH;
  const barW = Math.max(1.2, innerW / pts.length - 0.8);
  const left = pts.filter((p) => p.price <= data.mark);
  const right = pts.filter((p) => p.price >= data.mark);

  const longPath = useMemo(() => {
    if (left.length < 2) return "";
    return left.map((p, i) => `${i === 0 ? "M" : "L"} ${xOf(p.price).toFixed(1)} ${yCum(p.cumLongUsd).toFixed(1)}`).join(" ");
  }, [pts, data.mark, maxCum, minP, maxP]);

  const longArea = useMemo(() => {
    if (left.length < 2) return "";
    const line = left.map((p) => `${xOf(p.price).toFixed(1)} ${yCum(p.cumLongUsd).toFixed(1)}`).join(" L ");
    const x0 = xOf(left[0].price).toFixed(1);
    const x1 = xOf(left[left.length - 1].price).toFixed(1);
    const y0 = yCum(0).toFixed(1);
    return `M ${x0} ${y0} L ${line} L ${x1} ${y0} Z`;
  }, [pts, data.mark, maxCum, minP, maxP]);

  const shortPath = useMemo(() => {
    if (right.length < 2) return "";
    return right.map((p, i) => `${i === 0 ? "M" : "L"} ${xOf(p.price).toFixed(1)} ${yCum(p.cumShortUsd).toFixed(1)}`).join(" ");
  }, [pts, data.mark, maxCum, minP, maxP]);

  const shortArea = useMemo(() => {
    if (right.length < 2) return "";
    const line = right.map((p) => `${xOf(p.price).toFixed(1)} ${yCum(p.cumShortUsd).toFixed(1)}`).join(" L ");
    const x0 = xOf(right[0].price).toFixed(1);
    const x1 = xOf(right[right.length - 1].price).toFixed(1);
    const y0 = yCum(0).toFixed(1);
    return `M ${x0} ${y0} L ${line} L ${x1} ${y0} Z`;
  }, [pts, data.mark, maxCum, minP, maxP]);

  function onMove(e: React.PointerEvent<SVGSVGElement>) {
    const svg = e.currentTarget;
    const r = svg.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * W;
    const y = ((e.clientY - r.top) / r.height) * H;
    const price = minP + ((x - pad.l) / innerW) * (maxP - minP);
    let best = pts[0];
    let dist = Infinity;
    for (const p of pts) {
      const d = Math.abs(p.price - price);
      if (d < dist) {
        dist = d;
        best = p;
      }
    }
    setHover({ x, y, bin: best });
  }

  const markX = xOf(data.mark);
  const ticks = 6;
  const tipX = hover ? Math.min(W - 248, Math.max(pad.l, hover.x + 12)) : 0;
  const tipY = hover ? Math.min(H - 108, Math.max(pad.t, hover.y + 8)) : 0;

  return (
    <div ref={wrapRef} className="h-full w-full">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-full w-full"
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
      >
        <rect width={W} height={H} fill="#070B0A" />
        {Array.from({ length: 5 }, (_, i) => {
          const y = pad.t + (innerH * i) / 4;
          const barV = maxBar * (1 - i / 4);
          const cumV = maxCum * (1 - i / 4);
          return (
            <g key={i}>
              <line x1={pad.l} x2={W - pad.r} y1={y} y2={y} stroke="#15221E" strokeWidth="1" strokeDasharray="4 4" />
              <text x={pad.l - 6} y={y + 3} textAnchor="end" fill="#6b7c74" fontSize="10">
                {usd(barV)}
              </text>
              <text x={W - pad.r + 6} y={y + 3} textAnchor="start" fill="#6b7c74" fontSize="10">
                {usd(cumV)}
              </text>
            </g>
          );
        })}
        {longArea && <path d={longArea} fill="#14F195" opacity="0.12" />}
        {shortArea && <path d={shortArea} fill="#FF5C6A" opacity="0.12" />}
        {pts.map((p) => (
          <rect
            key={p.price}
            x={xOf(p.price) - barW / 2}
            y={yBar(p.atUsd)}
            width={barW}
            height={Math.max(0, yBar(0) - yBar(p.atUsd))}
            fill="#E8A317"
            opacity={0.9}
          />
        ))}
        <path d={longPath} fill="none" stroke="#14F195" strokeWidth="1.8" />
        <path d={shortPath} fill="none" stroke="#FF5C6A" strokeWidth="1.8" />
        <line
          x1={markX}
          x2={markX}
          y1={pad.t}
          y2={pad.t + innerH}
          stroke="#c5d4cc"
          strokeDasharray="4 4"
          strokeWidth="1.1"
        />
        <polygon points={`${markX},${pad.t + 8} ${markX - 5},${pad.t} ${markX + 5},${pad.t}`} fill="#c5d4cc" />
        <text x={markX + 8} y={pad.t + 12} fill="#c5d4cc" fontSize="11">
          Current Price: {formatMarketPrice(market, data.mark)}
        </text>
        {left.length > 0 && (
          <text x={pad.l} y={yCum(left[0].cumLongUsd) - 6} fill="#14F195" fontSize="10">
            {usd(left[0].cumLongUsd)}
          </text>
        )}
        {right.length > 0 && (
          <text x={W - pad.r} y={yCum(right[right.length - 1].cumShortUsd) - 6} textAnchor="end" fill="#FF5C6A" fontSize="10">
            {usd(right[right.length - 1].cumShortUsd)}
          </text>
        )}
        {Array.from({ length: ticks }, (_, i) => {
          const p = minP + ((maxP - minP) * i) / (ticks - 1);
          const x = xOf(p);
          return (
            <text key={i} x={x} y={H - 12} textAnchor="middle" fill="#6b7c74" fontSize="10">
              {formatMarketPrice(market, p)}
            </text>
          );
        })}
        {hover && (
          <g>
            <line
              x1={xOf(hover.bin.price)}
              x2={xOf(hover.bin.price)}
              y1={pad.t}
              y2={pad.t + innerH}
              stroke="#c5d4cc"
              strokeWidth="0.6"
              opacity="0.4"
            />
            <rect x={tipX} y={tipY} width="232" height="96" rx="6" fill="#0E1614" stroke="#1A2A26" />
            <text x={tipX + 10} y={tipY + 18} fill="#f5f5f5" fontSize="11">
              Price {formatMarketPrice(market, hover.bin.price)}
            </text>
            <text x={tipX + 10} y={tipY + 36} fill="#14F195" fontSize="11">
              Cum. Long Liq. Intensity {usd(hover.bin.cumLongUsd)}
            </text>
            <text x={tipX + 10} y={tipY + 52} fill="#FF5C6A" fontSize="11">
              Cum. Short Liq. Intensity {usd(hover.bin.cumShortUsd)}
            </text>
            <text x={tipX + 10} y={tipY + 68} fill="#E8A317" fontSize="11">
              Curr. Price Liq. Intensity {usd(hover.bin.atUsd)}
            </text>
          </g>
        )}
      </svg>
    </div>
  );
}
