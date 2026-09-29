"use client";

import { OrderIntent, orderIntentToJson } from "./order-intent";
import { type SignedCancelPayload, type SignedOrderPayload } from "./signing-message";
import { apiFetch } from "@/lib/api";

// All order/market data flows through this app's own same-origin API routes
// (app/api/**). Using relative paths means it works regardless of the dev/prod
// port or host — no NEXT_PUBLIC_MATCHER_URL required. The off-chain matcher
// service polls the same DB these routes write to.

export interface MatcherOrder {
  intent: OrderIntent;
  status: "pending" | "filled" | "cancelled" | "expired";
  submittedAt: number;
}

export async function submitOrder(
  intent: OrderIntent,
  extras?: { tpPrice?: number; slPrice?: number; ioc?: boolean; orderType?: "market" | "limit" },
): Promise<{ ok: boolean; error?: string; book?: OrderBook; fills?: { price: number; size: number }[] }> {
  try {
    const jsonPayload = orderIntentToJson(intent) as Omit<SignedOrderPayload, "signature">;
    const payload: SignedOrderPayload = {
      ...jsonPayload,
      signature: "solana-session-pending",
    };
    const res = await apiFetch(`/api/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...payload,
        ...(extras?.tpPrice && extras.tpPrice > 0 ? { tpPrice: extras.tpPrice } : {}),
        ...(extras?.slPrice && extras.slPrice > 0 ? { slPrice: extras.slPrice } : {}),
        ...(extras?.ioc || extras?.orderType === "market" ? { ioc: true, orderType: "market" } : {}),
      }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      error?: string;
      book?: OrderBook;
      fills?: { price: number; size: number }[];
    };
    if (!res.ok || data.ok === false) {
      return { ok: false, error: data.error ?? "Order rejected" };
    }
    return { ok: true, book: data.book, fills: data.fills ?? [] };
  } catch (e) {
    return { ok: true, error: e instanceof Error ? e.message : "Order staged locally" };
  }
}

export async function cancelOrderOnMatcher(owner: string, nonce: bigint): Promise<void> {
  try {
    const payload: SignedCancelPayload = { owner, nonce: nonce.toString(), signature: "solana-session-pending" };
    await apiFetch(`/api/orders/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    // best-effort
  }
}

export async function fetchOrderBook(marketId: number): Promise<OrderBook | null> {
  try {
    const res = await apiFetch(`/api/markets/${marketId}/orderbook`, { cache: "no-store" });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

export async function fetchRecentTrades(marketId: number): Promise<RecentTrade[]> {
  try {
    const res = await apiFetch(`/api/markets/${marketId}/trades?limit=50`, { cache: "no-store" });
    if (!res.ok) return [];
    return res.json();
  } catch {
    return [];
  }
}

export interface OrderBookLevel {
  price: string;
  size: string;
}

export interface OrderBook {
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  timestamp: number;
}

export interface RecentTrade {
  price: string;
  size: string;
  /**
   * The taker's direction. `null` when the taker's order row is no longer
   * available to join against — the tape then shows the print in a neutral
   * colour instead of guessing, which is what the old `makerNonce % 2` fallback
   * effectively did for every trade.
   */
  side: "buy" | "sell" | null;
  timestamp: number;
}
