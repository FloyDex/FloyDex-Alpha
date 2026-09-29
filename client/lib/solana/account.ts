import { AMOUNT_PRECISION, PRICE_PRECISION } from "@/config";
import { apiFetch } from "@/lib/api";
import type { RawAccountHealth, RawPosition } from "@/lib/stellar/contracts";
import { toast } from "sonner";

function toRawUnits(usdc: number): bigint {
  return BigInt(Math.max(0, Math.round(usdc * Number(AMOUNT_PRECISION))));
}

function toPriceRaw(usd: number): bigint {
  return BigInt(Math.max(0, Math.round(usd * Number(PRICE_PRECISION))));
}

export async function getVenueSnapshot(owner: string) {
  const res = await apiFetch(`/api/venue/account?owner=${encodeURIComponent(owner)}`, {
    cache: "no-store",
  });
  if (!res.ok) {
    return {
      deposited: 0,
      equity: 0,
      usedMargin: 0,
      freeCollateral: 0,
      positions: [] as {
        marketId: number;
        isLong: boolean;
        size: number;
        entry: number;
        margin: number;
        tp?: number | null;
        sl?: number | null;
      }[],
    };
  }
  return (await res.json()) as {
    deposited: number;
    equity: number;
    usedMargin: number;
    freeCollateral: number;
    realized?: number;
    upnl?: number;
    fundedIn?: number;
    fundedOut?: number;
    principalLeft?: number;
    banned?: boolean;
    pendingPayouts?: {
      id: string;
      amount: number;
      status: string;
      createdAt: number;
    }[];
    positions: {
      marketId: number;
      isLong: boolean;
      size: number;
      entry: number;
      margin: number;
      tp?: number | null;
      sl?: number | null;
    }[];
    triggered?: string[];
    gift?: {
      amount: number;
      realized: number;
      unlockAt: number;
      unlocked: boolean;
    } | null;
  };
}

export async function getPositions(owner: string): Promise<RawPosition[]> {
  const snap = await getVenueSnapshot(owner);
  for (const msg of snap.triggered ?? []) toast.success(msg);
  return snap.positions.map((p, i) => ({
    positionId: BigInt(i + 1),
    owner,
    marketId: p.marketId,
    size: toRawUnits(p.size),
    entryPrice: toPriceRaw(p.entry),
    margin: toRawUnits(p.margin),
    isLong: p.isLong,
    lastFundingIndex: 0n,
    tpPrice: p.tp && p.tp > 0 ? p.tp : null,
    slPrice: p.sl && p.sl > 0 ? p.sl : null,
  }));
}

export async function getAccountHealth(owner: string, _mint?: string): Promise<RawAccountHealth> {
  const snap = await getVenueSnapshot(owner);
  return {
    equity: toRawUnits(snap.equity),
    usedMargin: toRawUnits(snap.usedMargin),
    freeCollateral: toRawUnits(Math.max(0, snap.freeCollateral)),
    healthFactor: snap.usedMargin > 0
      ? BigInt(Math.round((snap.equity / snap.usedMargin) * 1e18))
      : BigInt("1000000000000000000"),
    liquidatable: snap.equity < snap.usedMargin * 0.5,
  };
}
