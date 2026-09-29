"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useWalletStore } from "@/stores/wallet";
import { useMarketStore } from "@/stores/market";
import type { RawPosition } from "@/lib/stellar/contracts";
import { getPositions } from "@/lib/solana/account";
import { MARKETS, PRICE_PRECISION } from "@/config";
import { priceToHuman, amountToHuman, formatAccountUsd, formatMarketUsd, formatMarketSize } from "@/lib/format";
import { buildOrderIntent } from "@/lib/market/order-intent";
import { submitOrder } from "@/lib/market/matcher";
import { useLocalOrders } from "@/stores/orders";
import { calcLiqPrice, calcUnrealizedPnl } from "@/lib/math";
import { useTradeSettings } from "@/stores/settings";
import { logoFor, UsdcLogo } from "@/components/common/AssetLogos";
import { toast } from "sonner";
import { useState } from "react";

export function PositionsTable({
  marketFilter,
  sideFilter,
}: {
  marketFilter: number | "all";
  sideFilter: "both" | "long" | "short";
}) {
  const { address, connected } = useWalletStore();
  const addOrder = useLocalOrders((s) => s.addOrder);
  const markPrices = useMarketStore((s) => s.markPrices);
  const { hidePnl, hideLiqPrice } = useTradeSettings();
  const queryClient = useQueryClient();

  const { data: positions = [] } = useQuery({
    queryKey: ["positions", address],
    queryFn: () => getPositions(address!),
    enabled: !!address && connected,
    refetchInterval: 15_000,
  });

  const filtered = positions.filter(
    (p) =>
      (marketFilter === "all" || p.marketId === marketFilter) &&
      (sideFilter === "both" || (sideFilter === "long") === p.isLong)
  );

  if (!connected || !address) {
    return <Empty text="Connect a wallet to view open positions" />;
  }
  if (filtered.length === 0) {
    return <Empty text="No positions. Deposit USDC, then Open Long or Open Short." />;
  }

  const cols = [
    "Market",
    "Size",
    "Entry Price",
    "Mark Price",
    ...(hidePnl ? [] : ["PnL"]),
    ...(hideLiqPrice ? [] : ["Liq. Price"]),
    "TP",
    "SL",
    "Margin",
    "",
  ];

  // Close is a market IOC in the opposite direction. Aggressive limit crosses the
  // book; ioc prevents a resting leftover. Local open-orders must be marked
  // filled/cancelled or Close leaves a ghost "Reduce SHORT @ 0.5× mark" row.
  const makeClose = (pos: RawPosition) => async () => {
    if (!address) return;
    const mark = markPrices[pos.marketId];
    const closeIsLong = !pos.isLong;
    const aggPrice = mark && mark > 0n ? (closeIsLong ? mark * 2n : mark / 2n || 1n) : 1n;
    const intent = buildOrderIntent({
      owner: address,
      marketId: pos.marketId,
      isLong: closeIsLong,
      size: pos.size,
      limitPrice: aggPrice,
      reduceOnly: true,
      ttlSeconds: 60,
      leverage: 10,
    });
    addOrder(intent);
    const result = await submitOrder(intent, { ioc: true, orderType: "market" });
    if (result.ok) {
      const filledQty = result.fills?.reduce((s, f) => s + f.size, 0) ?? 0;
      if (filledQty > 0) useLocalOrders.getState().markFilled(intent.nonce, address);
      else useLocalOrders.getState().cancelOrder(intent.nonce, address);
      toast.success(filledQty > 0 ? "Position closed" : "Close submitted — nothing left to fill");
      const keys = [["positions", address], ["fills", address], ["balance", address], ["health", address]];
      const invalidateAll = () => keys.forEach((key) => queryClient.invalidateQueries({ queryKey: key }));
      invalidateAll();
      [2_000, 5_000, 10_000].forEach((ms) => setTimeout(invalidateAll, ms));
    } else {
      useLocalOrders.getState().cancelOrder(intent.nonce, address);
      toast.error(result.error ?? "Close failed");
    }
  };

  return (
    <>
      {/* Desktop: dense table */}
      <table className="hidden w-full text-[12px] tabular lg:table">
        <thead>
          <tr className="text-[10px] text-[#737373] font-semibold uppercase tracking-wider">
            {cols.map((h, i) => (
              <th
                key={h || `act-${i}`}
                className={`py-[9px] whitespace-nowrap ${i === 0 ? "pl-4 pr-2 text-left" : i === cols.length - 1 ? "pr-4 pl-2 text-right" : "px-3 text-right"}`}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {filtered.map((pos) => (
            <PositionRow
              key={String(pos.positionId)}
              position={pos}
              markPrice={markPrices[pos.marketId]}
              hidePnl={hidePnl}
              hideLiqPrice={hideLiqPrice}
              onClose={makeClose(pos)}
            />
          ))}
        </tbody>
      </table>

      {/* Mobile: stacked cards */}
      <div className="flex flex-col gap-2 p-3 lg:hidden">
        {filtered.map((pos) => (
          <PositionCard
            key={String(pos.positionId)}
            position={pos}
            markPrice={markPrices[pos.marketId]}
            hidePnl={hidePnl}
            hideLiqPrice={hideLiqPrice}
            onClose={makeClose(pos)}
          />
        ))}
      </div>
    </>
  );
}

interface PositionView {
  baseSymbol: string;
  entryHuman: number;
  sizeHuman: number;
  markHuman: number | null;
  pnlHuman: number | null;
  pnlColor: string;
  pnlPct: number | null;
  positionMargin: number;
  lev: number;
  liqPrice: string | null;
  sideBadge: string;
  isLong: boolean;
  // Pre-formatted at the market's own precision — a shared .toFixed(4) is
  // wrong by four orders of magnitude on BTC and truncates TRX's finest tick.
  sizeDisplay: string;
  entryDisplay: string;
  markDisplay: string;
  tpDisplay: string;
  slDisplay: string;
}

// Shared derivation used by both the desktop row and the mobile card.
function getPositionView(position: RawPosition, markPrice: bigint | undefined): PositionView {
  // MARKETS, not ACTIVE_MARKETS: a position in a de-listed market must still
  // render legibly rather than collapsing to "#7".
  const market = Object.values(MARKETS).find((m) => m.marketId === position.marketId);
  const baseSymbol = market?.baseAsset ?? `#${position.marketId}`;

  const entryHuman = priceToHuman(position.entryPrice);
  const sizeHuman = amountToHuman(position.size);
  const markHuman = markPrice ? priceToHuman(markPrice) : null;
  const refPrice = markHuman ?? entryHuman;

  const pnl = markPrice
    ? calcUnrealizedPnl(position.isLong, position.size, position.entryPrice, markPrice)
    : null;
  const pnlHuman = pnl !== null ? amountToHuman(pnl) : null;
  const pnlColor = pnlHuman === null ? "text-[#a3a3a3]" : pnlHuman >= 0 ? "text-[#1fae5b]" : "text-[#e34c4c]";

  const notional = sizeHuman * refPrice;
  // Prefer the margin actually posted on the venue position; fall back to IM×notional.
  const postedMargin = amountToHuman(position.margin);
  const imRate = (market?.initialMarginBps ?? 0) / 10_000;
  const positionMargin =
    postedMargin > 0 ? postedMargin : notional * (imRate > 0 ? imRate : 0.1);
  const pnlPct = pnlHuman !== null && positionMargin > 0 ? (pnlHuman / positionMargin) * 100 : null;
  // Position leverage = notional / margin (same as chart / ticket). Do NOT use
  // account equity here — that made a 10× ticket show as 3× and a different liq.
  const lev =
    positionMargin > 0 && notional > 0
      ? Math.max(1, Math.round(notional / positionMargin))
      : 0;

  const liqPrice = (() => {
    if (!market || sizeHuman <= 0 || entryHuman <= 0 || lev <= 0) return null;
    const entryRaw = BigInt(Math.round(entryHuman * Number(PRICE_PRECISION)));
    const liq = calcLiqPrice(position.isLong, entryRaw, lev, market.maintenanceMarginBps);
    if (liq <= 0n) return null;
    return formatMarketUsd(market, priceToHuman(liq));
  })();

  const sideBadge = position.isLong
    ? "bg-[rgba(31,174,91,0.12)] text-[#1fae5b]"
    : "bg-[rgba(227,76,76,0.12)] text-[#e34c4c]";

  // Fall back to 4dp only for an unknown market id — every known market has
  // its own precision.
  const px = (v: number) => (market ? formatMarketUsd(market, v) : "$" + v.toFixed(4));
  const sz = (v: number) => (market ? formatMarketSize(market, v) : v.toFixed(4));

  return {
    baseSymbol, entryHuman, sizeHuman, markHuman, pnlHuman, pnlColor, pnlPct,
    positionMargin, lev, liqPrice, sideBadge, isLong: position.isLong,
    sizeDisplay: sz(sizeHuman),
    entryDisplay: px(entryHuman),
    markDisplay: markHuman !== null ? px(markHuman) : "—",
    tpDisplay: position.tpPrice && position.tpPrice > 0 ? px(position.tpPrice) : "—",
    slDisplay: position.slPrice && position.slPrice > 0 ? px(position.slPrice) : "—",
  };
}

function PnlValue({ v }: { v: PositionView }) {
  if (v.pnlHuman === null) return <>—</>;
  return (
    <>
      {v.pnlHuman > 0 ? "+" : ""}
      {formatAccountUsd(v.pnlHuman)}
      {v.pnlPct !== null && (
        <span className="text-[11px] ml-1">
          ({v.pnlPct >= 0 ? "+" : ""}
          {v.pnlPct.toFixed(2)}%)
        </span>
      )}
    </>
  );
}

function MarketLabel({ v, badge = true }: { v: PositionView; badge?: boolean }) {
  return (
    <div className="flex items-center gap-2">
      {logoFor(v.baseSymbol, 16)}
      <span className="font-semibold text-[#f5f5f5]">
        {v.baseSymbol}
        <span className="text-[#737373] font-normal">/USDC</span>
      </span>
      {badge && (
        <span className={`rounded-[5px] px-1.5 py-0.5 text-[10px] font-bold tracking-wide ${v.sideBadge}`}>
          {v.lev > 0 ? `${v.lev}× ` : ""}
          {v.isLong ? "LONG" : "SHORT"}
        </span>
      )}
    </div>
  );
}

function PositionRow({
  position,
  markPrice,
  onClose,
  hidePnl,
  hideLiqPrice,
}: {
  position: RawPosition;
  markPrice: bigint | undefined;
  onClose: () => void;
  hidePnl: boolean;
  hideLiqPrice: boolean;
}) {
  const [closing, setClosing] = useState(false);
  const v = getPositionView(position, markPrice);

  return (
    <tr className="border-t border-[#1A2A26] hover:bg-white/[0.02] transition-colors">
      <td className="pl-4 pr-2 py-[10px] text-left">
        <MarketLabel v={v} />
      </td>
      <td className="px-3 py-[10px] text-right">
        <span className={`font-semibold ${v.isLong ? "text-[#1fae5b]" : "text-[#e34c4c]"}`}>
          {v.sizeDisplay}
        </span>{" "}
        <span className="text-[#737373]">{v.baseSymbol}</span>
      </td>
      <td className="px-3 py-[10px] text-right text-[#f5f5f5] font-medium">{v.entryDisplay}</td>
      <td className="px-3 py-[10px] text-right text-[#f5f5f5] font-medium">
        {v.markDisplay}
      </td>
      {!hidePnl && (
        <td className={`px-3 py-[10px] text-right font-semibold ${v.pnlColor}`}>
          <PnlValue v={v} />
        </td>
      )}
      {!hideLiqPrice && <td className="px-3 py-[10px] text-right text-amber-400">{v.liqPrice ?? "—"}</td>}
      <td className="px-3 py-[10px] text-right font-medium text-[#1fae5b]">{v.tpDisplay}</td>
      <td className="px-3 py-[10px] text-right font-medium text-[#e8716f]">{v.slDisplay}</td>
      <td className="px-3 py-[10px] text-right text-[#a3a3a3]">
        <span className="inline-flex items-center justify-end gap-1">
          {v.positionMargin.toFixed(2)} <UsdcLogo size={12} />
        </span>
      </td>
      <td className="pr-4 pl-2 py-[10px] text-right">
        <CloseButton closing={closing} setClosing={setClosing} onClose={onClose} />
      </td>
    </tr>
  );
}

function PositionCard({
  position,
  markPrice,
  onClose,
  hidePnl,
  hideLiqPrice,
}: {
  position: RawPosition;
  markPrice: bigint | undefined;
  onClose: () => void;
  hidePnl: boolean;
  hideLiqPrice: boolean;
}) {
  const [closing, setClosing] = useState(false);
  const v = getPositionView(position, markPrice);

  return (
    <div className="rounded-[10px] border border-[#1A2A26] bg-[#0E1614] p-3">
      <div className="flex items-center justify-between gap-2">
        <MarketLabel v={v} />
        <CloseButton closing={closing} setClosing={setClosing} onClose={onClose} />
      </div>
      <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2.5 text-[12.5px] tabular">
        <Field label="Size">
          <span className={v.isLong ? "text-[#1fae5b]" : "text-[#e34c4c]"}>{v.sizeDisplay}</span>{" "}
          <span className="text-[#737373]">{v.baseSymbol}</span>
        </Field>
        {!hidePnl && (
          <Field label="PnL" align="right">
            <span className={`font-semibold ${v.pnlColor}`}><PnlValue v={v} /></span>
          </Field>
        )}
        <Field label="Entry">
          <span className="text-[#f5f5f5]">{v.entryDisplay}</span>
        </Field>
        <Field label="Mark" align="right">
          <span className="text-[#f5f5f5]">{v.markDisplay}</span>
        </Field>
        {!hideLiqPrice && (
          <Field label="Liq. Price">
            <span className="text-amber-400">{v.liqPrice ?? "—"}</span>
          </Field>
        )}
        <Field label="TP">
          <span className="text-[#1fae5b]">{v.tpDisplay}</span>
        </Field>
        <Field label="SL" align="right">
          <span className="text-[#e8716f]">{v.slDisplay}</span>
        </Field>
        <Field label="Margin" align={hideLiqPrice ? "left" : "right"}>
          <span className="inline-flex items-center gap-1 text-[#a3a3a3]">
            {v.positionMargin.toFixed(2)} <UsdcLogo size={12} />
          </span>
        </Field>
      </div>
    </div>
  );
}

function Field({
  label,
  children,
  align = "left",
}: {
  label: string;
  children: React.ReactNode;
  align?: "left" | "right";
}) {
  return (
    <div className={`flex flex-col gap-0.5 ${align === "right" ? "items-end text-right" : "items-start"}`}>
      <span className="text-[10px] uppercase tracking-wider text-[#737373]">{label}</span>
      <span className="font-medium">{children}</span>
    </div>
  );
}

function CloseButton({
  closing,
  setClosing,
  onClose,
}: {
  closing: boolean;
  setClosing: (v: boolean) => void;
  onClose: () => void;
}) {
  return (
    <button
      className="shrink-0 rounded-[6px] border border-[#1C332C] px-3 py-1.5 text-[12px] font-semibold text-[#f5f5f5] transition-colors hover:border-[#2A4A40] hover:bg-[#0E1614] disabled:opacity-50"
      disabled={closing}
      onClick={async () => {
        setClosing(true);
        await onClose();
        setClosing(false);
      }}
    >
      {closing ? "Closing…" : "Close"}
    </button>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div className="flex flex-col items-center gap-3 py-10 text-[#a3a3a3]">
      <span className="text-[13px] text-[#a3a3a3]">{text}</span>
    </div>
  );
}
