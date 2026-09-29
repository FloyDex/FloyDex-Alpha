"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { marketById } from "@/components/common/MarketCell";
import { formatAccountUsd, priceFor, sizeFor } from "@/lib/format";
import { useWalletStore } from "@/stores/wallet";
import { STELLAR_EXPERT_URL, NETWORK_LABEL } from "@/config";
import { freighterSignAuthEntry, isOnExpectedNetwork } from "@/lib/stellar/freighter";
import { useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";

interface FillNotification {
  id: string;
  marketId: number;
  isMaker: boolean;
  isLong?: boolean;
  price: number | string;
  size: number | string;
  txHash: string;
  createdAt: number;
  reason?: string;
  pnl?: number;
}

interface PendingSettlement {
  id: string;
  marketId: number;
  isMaker: boolean;
  fillHash: string;
  authEntryXdr: string;
  retryNeeded?: boolean;
  fillPrice: string;
  fillSize: string;
  createdAt: string;
}

type FillKind = "open" | "add" | "close" | "tp" | "sl" | "fill";

function fillKind(f: FillNotification): FillKind {
  const tx = String(f.txHash ?? "");
  const raw = (f.reason ?? (tx.startsWith("venue:") ? tx.slice(6) : "")).toLowerCase();
  if (raw === "tp" || raw === "sl" || raw === "close" || raw === "open" || raw === "add") return raw;
  return "fill";
}

/** Merge open+close (or tp/sl) that land in the same burst into one card. */
function coalesceFills(fills: FillNotification[]): FillNotification[] {
  const out: FillNotification[] = [];
  const used = new Set<string>();
  const sorted = [...fills].sort((a, b) => b.createdAt - a.createdAt);

  for (const f of sorted) {
    if (used.has(f.id)) continue;
    const kind = fillKind(f);
    if (kind === "close" || kind === "tp" || kind === "sl") {
      const open = sorted.find(
        (o) =>
          !used.has(o.id) &&
          o.id !== f.id &&
          o.marketId === f.marketId &&
          fillKind(o) === "open" &&
          Math.abs(Number(o.size) - Number(f.size)) < 1e-9 &&
          Math.abs(o.createdAt - f.createdAt) < 5_000,
      );
      if (open) {
        used.add(f.id);
        used.add(open.id);
        out.push({
          ...f,
          id: `roundtrip:${open.id}:${f.id}`,
          reason: kind === "tp" ? "roundtrip-tp" : kind === "sl" ? "roundtrip-sl" : "roundtrip",
          price: f.price,
          pnl: Number(f.pnl ?? 0),
          // Keep open price in a fake maker flag unused — stash via size string? Better add fields.
          // Encode open price in id payload via extending reason display only.
        });
        // Attach open price for the card via a synthetic field on the object.
        (out[out.length - 1] as FillNotification & { openPrice?: number }).openPrice = Number(open.price);
        continue;
      }
    }
    used.add(f.id);
    out.push(f);
  }
  return out.slice(0, 4);
}

function useFillNotifications(address: string | null) {
  const [fills, setFills] = useState<FillNotification[]>([]);
  const sinceRef = useRef<number>(0);

  const poll = useCallback(async () => {
    if (!address) return;
    try {
      const res = await apiFetch(
        `/api/fills?address=${address}&since=${sinceRef.current}&limit=10`,
        { cache: "no-store" },
      );
      if (!res.ok) return;
      const data = (await res.json()) as FillNotification[];
      if (data.length > 0) {
        sinceRef.current = Math.max(...data.map((f) => f.createdAt)) + 1;
        setFills((prev) => coalesceFills([...data, ...prev]).slice(0, 12));
      }
    } catch {
      /* best-effort */
    }
  }, [address]);

  useEffect(() => {
    if (!address) return;
    // Only look back briefly — avoid replaying old open/close pairs on connect.
    sinceRef.current = Date.now() - 2_000;
    poll();
    const id = setInterval(poll, 2_500);
    return () => clearInterval(id);
  }, [address, poll]);

  return {
    fills,
    dismiss: (id: string) =>
      setFills((p) => {
        if (id.startsWith("roundtrip:")) {
          const parts = new Set(id.split(":").slice(1));
          return p.filter((f) => f.id !== id && !parts.has(f.id));
        }
        return p.filter((f) => f.id !== id);
      }),
  };
}

function usePendingSettlements(address: string | null) {
  const [pending, setPending] = useState<PendingSettlement[]>([]);

  const poll = useCallback(async () => {
    if (!address) return;
    try {
      const res = await apiFetch(`/api/settlements?address=${address}`, { cache: "no-store" });
      if (!res.ok) return;
      setPending((await res.json()) as PendingSettlement[]);
    } catch {
      /* best-effort */
    }
  }, [address]);

  useEffect(() => {
    if (!address) {
      queueMicrotask(() => setPending([]));
      return;
    }
    const first = setTimeout(poll, 0);
    const id = setInterval(poll, 4_000);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, [address, poll]);

  return { pending, refresh: poll };
}

export function SettlementModal() {
  const { address, connected } = useWalletStore();
  const { fills, dismiss } = useFillNotifications(connected ? address : null);
  const { pending, refresh } = usePendingSettlements(connected ? address : null);
  const cards = useMemo(() => coalesceFills(fills), [fills]);

  if (!cards.length && !pending.length) return null;

  return (
    <div className="fixed inset-x-3 bottom-24 z-50 flex flex-col gap-2 sm:inset-x-auto sm:bottom-6 sm:right-6 sm:w-[340px]">
      {pending.slice(0, 2).map((settlement) => (
        <PendingSettlementCard
          key={settlement.id}
          settlement={settlement}
          address={address}
          onSigned={refresh}
        />
      ))}
      {cards.slice(0, 3).map((fill) => (
        <FillCard key={fill.id} fill={fill} onDismiss={() => dismiss(fill.id)} />
      ))}
    </div>
  );
}

function PendingSettlementCard({
  settlement,
  address,
  onSigned,
}: {
  settlement: PendingSettlement;
  address: string | null;
  onSigned: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const role = settlement.isMaker ? "Maker" : "Taker";
  const queryClient = useQueryClient();

  const signSettlement = async () => {
    if (!address || busy) return;
    setBusy(true);
    setError(null);
    try {
      let signedAuthEntry: string;

      if (settlement.retryNeeded) {
        signedAuthEntry = settlement.authEntryXdr;
      } else {
        const onCorrectNetwork = await isOnExpectedNetwork();
        if (!onCorrectNetwork) {
          throw new Error(`Freighter is on the wrong network — switch to ${NETWORK_LABEL} and try again.`);
        }
        signedAuthEntry = await freighterSignAuthEntry(settlement.authEntryXdr);
      }
      const res = await apiFetch(`/api/settlements/${settlement.id}/sign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address, signedAuthEntry }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.ok === false) {
        throw new Error(data?.error ?? "Settlement signing failed");
      }
      onSigned();
      const keys = [
        ["positions", address],
        ["fills", address],
        ["balance", address],
        ["health", address],
      ];
      const invalidateAll = () => keys.forEach((key) => queryClient.invalidateQueries({ queryKey: key }));
      invalidateAll();
      [3_000, 6_000, 10_000, 15_000, 22_000, 30_000].forEach((ms) => setTimeout(invalidateAll, ms));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Settlement signing failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="overflow-hidden rounded-[14px] border border-[#3a2a12] bg-[#140f07] shadow-2xl">
      <div className="flex items-center justify-between border-b border-[#3a2a12] px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="h-2 w-2 rounded-full bg-amber-400" style={{ boxShadow: "0 0 6px rgba(251,191,36,.7)" }} />
          <span className="text-[13px] font-semibold text-[#f4ead7]">Settlement Signature</span>
        </div>
        <span className="text-[11px] text-[#a98d54]">{role}</span>
      </div>
      <div className="flex flex-col gap-2 px-4 py-3">
        <Row
          label="Size"
          value={`${sizeFor(settlement.marketId, BigInt(settlement.fillSize))} ${baseAssetOf(settlement.marketId)}`}
        />
        <Row label="Price" value={priceFor(settlement.marketId, BigInt(settlement.fillPrice))} />
        <Row
          label="Status"
          value={settlement.retryNeeded ? "Retry settlement" : "Wallet auth required"}
          valueClass="text-amber-300"
        />
        {error && <div className="text-[11px] leading-4 text-red-300">{error}</div>}
      </div>
      <div className="px-4 pb-4">
        <button
          type="button"
          onClick={() => void signSettlement()}
          disabled={busy}
          className="block w-full rounded-[8px] bg-amber-300 py-[9px] text-center text-[13px] font-semibold text-[#140f07] transition-colors hover:bg-amber-200 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy ? (settlement.retryNeeded ? "Retrying..." : "Signing...") : settlement.retryNeeded ? "Retry Settlement" : "Sign Settlement"}
        </button>
      </div>
    </div>
  );
}

function FillCard({
  fill,
  onDismiss,
}: {
  fill: FillNotification & { openPrice?: number };
  onDismiss: () => void;
}) {
  const tx = String(fill.txHash ?? "");
  const isVenue = tx.startsWith("venue:");
  const isDbFill = tx.startsWith("dbfill");
  const isOnChain = Boolean(tx) && !isVenue && !isDbFill && tx.length >= 64;
  const reason = (fill.reason ?? "").toLowerCase();
  const kind = fillKind(fill);
  const base = baseAssetOf(fill.marketId);
  const sizeLabel = `${sizeFor(fill.marketId, Number(fill.size))} ${base}`;
  const pxLabel = priceFor(fill.marketId, Number(fill.price));
  const pnl = Number(fill.pnl ?? 0);
  const hasPnl = kind === "close" || kind === "tp" || kind === "sl" || reason.startsWith("roundtrip");

  const tone =
    reason.startsWith("roundtrip") || kind === "close"
      ? {
          border: "border-[#3a2410]",
          bg: "bg-[#120e08]",
          head: "border-[#3a2410]",
          dot: "bg-[#E8A317]",
          glow: "0 0 6px rgba(232,163,23,.55)",
          title: "text-[#f4ead7]",
        }
      : kind === "sl"
        ? {
            border: "border-[#3a1518]",
            bg: "bg-[#140a0c]",
            head: "border-[#3a1518]",
            dot: "bg-[#FF5C6A]",
            glow: "0 0 6px rgba(255,92,106,.55)",
            title: "text-[#ffd5d9]",
          }
        : kind === "tp"
          ? {
              border: "border-[#143028]",
              bg: "bg-[#0a1410]",
              head: "border-[#143028]",
              dot: "bg-[#14F195]",
              glow: "0 0 6px rgba(20,241,149,.55)",
              title: "text-[#d7ffe9]",
            }
          : {
              border: "border-[#1a2a1a]",
              bg: "bg-[#0a140a]",
              head: "border-[#1a2a1a]",
              dot: "bg-[#14F195]",
              glow: "0 0 6px rgba(20,241,149,.55)",
              title: "text-[#f5f5f5]",
            };

  const title =
    reason === "roundtrip-tp"
      ? "Opened, then take-profit"
      : reason === "roundtrip-sl"
        ? "Opened, then stop-loss"
        : reason === "roundtrip"
          ? "Opened, then closed"
          : kind === "tp"
            ? "Take profit hit"
            : kind === "sl"
              ? "Stop loss hit"
              : kind === "close"
                ? "Position closed"
                : kind === "add"
                  ? "Added to position"
                  : kind === "open"
                    ? "Position opened"
                    : "Order filled";

  const subtitle =
    reason === "roundtrip"
      ? "Flat again — same size closed right after the open."
      : reason === "roundtrip-tp"
        ? "TP was still active on this market from an earlier order."
        : reason === "roundtrip-sl"
          ? "SL was still active on this market from an earlier order."
          : kind === "close"
            ? "Your position is flat on this market."
            : kind === "open"
              ? "Live in Positions — margin is reserved."
              : null;

  useEffect(() => {
    const t = setTimeout(onDismiss, reason.startsWith("roundtrip") ? 14_000 : 10_000);
    return () => clearTimeout(t);
  }, [onDismiss, reason]);

  return (
    <div className={`overflow-hidden rounded-[14px] border shadow-2xl ${tone.border} ${tone.bg}`}>
      <div className={`flex items-center justify-between border-b px-4 py-3 ${tone.head}`}>
        <div className="flex min-w-0 items-center gap-2">
          <div className={`h-2 w-2 shrink-0 rounded-full ${tone.dot}`} style={{ boxShadow: tone.glow }} />
          <span className={`truncate text-[13px] font-semibold ${tone.title}`}>{title}</span>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="text-lg leading-none text-[#737373] hover:text-[#a3a3a3]"
          aria-label="Dismiss"
        >
          ×
        </button>
      </div>

      <div className="flex flex-col gap-2 px-4 py-3">
        {subtitle ? <p className="text-[11px] leading-4 text-[#8A9B94]">{subtitle}</p> : null}
        <Row label="Size" value={sizeLabel} />
        {fill.openPrice != null ? (
          <>
            <Row label="Open" value={priceFor(fill.marketId, fill.openPrice)} />
            <Row label="Close" value={pxLabel} />
          </>
        ) : (
          <Row label="Price" value={pxLabel} />
        )}
        {hasPnl ? (
          <Row
            label="Realized"
            value={`${pnl > 0 ? "+" : ""}${formatAccountUsd(pnl)}`}
            valueClass={pnl > 0 ? "text-[#14F195]" : pnl < 0 ? "text-[#FF5C6A]" : "text-[#a3a3a3]"}
          />
        ) : null}
        <Row
          label="Venue"
          value={isVenue ? "Desk" : isOnChain ? "On-chain" : "Pending"}
          valueClass="text-[#8A9B94]"
        />
      </div>

      {isOnChain && (
        <div className="px-4 pb-4">
          <a
            href={`${STELLAR_EXPERT_URL}/tx/${tx}`}
            target="_blank"
            rel="noopener noreferrer"
            className="block w-full rounded-[8px] border border-[#1a3a1a] py-[9px] text-center text-[13px] font-semibold text-[#1fae5b] transition-colors hover:bg-[#0d1f0d]"
          >
            View on Explorer →
          </a>
        </div>
      )}
    </div>
  );
}

function baseAssetOf(marketId: number): string {
  return marketById(marketId)?.baseAsset ?? "";
}

function Row({
  label,
  value,
  valueClass = "text-[#f5f5f5]",
}: {
  label: string;
  value: string;
  valueClass?: string;
}) {
  return (
    <div className="flex justify-between gap-3 text-[12px]">
      <span className="text-[#737373]">{label}</span>
      <span className={`font-medium tabular ${valueClass}`}>{value}</span>
    </div>
  );
}
