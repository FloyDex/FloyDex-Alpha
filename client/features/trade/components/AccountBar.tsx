"use client";

import { useQuery } from "@tanstack/react-query";
import { useWalletStore } from "@/stores/wallet";
import { getAccountHealth } from "@/lib/solana/health";
import { SETTLEMENT_ASSET } from "@/config";
import { amountToHuman, formatAccountUsd } from "@/lib/format";
import { useCollateral } from "@/features/collateral/useCollateral";
import { AssetLogo } from "@/components/common/AssetLogos";
import { apiFetch } from "@/lib/api";
import { GIFT_UNLOCK_PROFIT, GIFT_USD, type GiftStatus } from "@/lib/market/gift";
import type { ReactNode } from "react";

export function AccountBar() {
  const { address, connected } = useWalletStore();

  const { data: collateral } = useCollateral(connected ? address : null);

  const { data: health } = useQuery({
    queryKey: ["health", address],
    queryFn: () => getAccountHealth(address!, SETTLEMENT_ASSET.contract),
    enabled: !!address && connected,
    refetchInterval: 15_000,
  });
  const { data: giftSnap } = useQuery({
    queryKey: ["gift", address],
    queryFn: async () => {
      const res = await apiFetch(`/api/venue/gift?owner=${encodeURIComponent(address!)}`, { cache: "no-store" });
      if (!res.ok) return { gift: null as GiftStatus | null };
      return (await res.json()) as { gift: GiftStatus | null };
    },
    enabled: !!address && connected,
    refetchInterval: 15_000,
  });

  const deposited = collateral?.reduce((acc, p) => acc + p.marginValue, 0);
  const held = (collateral ?? []).filter((p) => p.raw !== 0n);
  const available =
    health?.freeCollateral !== undefined ? amountToHuman(health.freeCollateral) : deposited;
  const used = health ? amountToHuman(health.usedMargin) : 0;
  const equity = health ? amountToHuman(health.equity) : (deposited ?? 0);
  const ratioBase = equity > 0 ? equity : deposited ?? 0;
  const ratio = ratioBase > 0 ? Math.min(100, (used / ratioBase) * 100) : 0;
  const gift = giftSnap?.gift ?? null;

  return (
    <div className="border-b border-[#15221E] px-3 py-2">
      <div className="flex items-center gap-1.5">
        <span className="inline-flex h-[22px] shrink-0 items-center rounded-[5px] border border-[#1C332C] bg-[#0E1614] px-2 text-[10px] font-semibold uppercase tracking-[.06em] text-[#c5d4cc]">
          Cross
        </span>
        <span className="shrink-0 whitespace-nowrap text-[10px] font-medium uppercase tracking-[.06em] text-[#6b7c74]">
          {SETTLEMENT_ASSET.code}-M
        </span>
      </div>

      <div className="mt-2 grid grid-cols-3 gap-2">
        <Stat
          label="Available"
          value={available !== undefined ? formatAccountUsd(available) : "$0.00"}
          icon={
            <span className="flex items-center -space-x-1">
              {(held.length > 0 ? held : [{ code: SETTLEMENT_ASSET.code }]).map((p) => (
                <AssetLogo key={p.code} symbol={p.code} size={11} />
              ))}
            </span>
          }
        />
        <Stat label="Used Margin" value={formatAccountUsd(used || 0)} />
        <Stat label="Equity" value={formatAccountUsd(equity || deposited || 0)} />
      </div>

      <div className="mt-2">
        <div className="mb-1 flex items-center justify-between text-[10px] text-[#6b7c74]">
          <span>Margin ratio</span>
          <span className={`font-mono tabular ${ratio > 70 ? "text-[#FF5C6A]" : "text-[#c5d4cc]"}`}>
            {ratio.toFixed(2)}%
          </span>
        </div>
        <div className="h-[3px] overflow-hidden rounded-full bg-[#12201C]">
          <div
            className={`h-full ${ratio > 70 ? "bg-[#FF5C6A]" : "bg-[#14F195]"}`}
            style={{ width: `${Math.max(2, ratio)}%` }}
          />
        </div>
      </div>

      <CreditNotice connected={connected} gift={gift} />
    </div>
  );
}

function CreditNotice({ connected, gift }: { connected: boolean; gift: GiftStatus | null }) {
  if (gift && !gift.unlocked) {
    const realized = Math.max(0, gift.realized);
    const pct = Math.min(100, (realized / gift.unlockAt) * 100);
    return (
      <div className="mt-2 min-w-0 rounded-[8px] border border-[#1A2A26] bg-[#0E1614] px-2.5 py-2">
        <div className="flex items-baseline justify-between gap-2">
          <span className="min-w-0 text-[11px] font-semibold leading-tight text-[#14F195]">
            ${GIFT_USD} credit locked
          </span>
          <span className="shrink-0 font-mono text-[10px] tabular text-[#8A9B94]">
            ${realized.toFixed(0)} / ${GIFT_UNLOCK_PROFIT}
          </span>
        </div>
        <div className="mt-1.5 h-[3px] overflow-hidden rounded-full bg-[#12201C]">
          <div className="h-full bg-[#14F195]" style={{ width: `${Math.max(3, pct)}%` }} />
        </div>
        <p className="mt-1.5 text-[10px] leading-snug text-[#6b7c74]">
          One credit per IP and device. Withdraw after ${GIFT_UNLOCK_PROFIT} realized profit.
        </p>
      </div>
    );
  }

  if (!connected) {
    return (
      <div className="mt-2 min-w-0 rounded-[8px] border border-[#1A2A26] bg-[#0E1614] px-2.5 py-2">
        <p className="text-[11px] font-semibold leading-tight text-[#14F195]">
          ${GIFT_USD} signup credit
        </p>
        <p className="mt-1 text-[10px] leading-snug text-[#8A9B94]">
          Withdraw after ${GIFT_UNLOCK_PROFIT} realized profit.
        </p>
      </div>
    );
  }

  return null;
}

function Stat({
  label,
  value,
  valueClass,
  icon,
}: {
  label: string;
  value: string;
  valueClass?: string;
  icon?: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col items-start gap-0.5">
      <span className="text-[10px] uppercase tracking-wider text-[#6b7c74]">{label}</span>
      <span className={`flex min-w-0 items-center gap-[4px] font-mono text-[12px] font-semibold tabular ${valueClass ?? "text-[#f5f5f5]"}`}>
        {icon}
        {value}
      </span>
    </div>
  );
}
