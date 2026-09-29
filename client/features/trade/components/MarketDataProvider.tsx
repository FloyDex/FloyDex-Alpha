"use client";

import { useEffect, useRef } from "react";
import { useMarketStore } from "@/stores/market";
import { getOraclePrice } from "@/lib/stellar/oracle";
import { fetchOrderBook, fetchRecentTrades } from "@/lib/market/matcher";
import {
  wsSetHandlers,
  wsSubscribe,
  wsUnsubscribe,
  wsDisconnect,
  wsReset,
} from "@/lib/market/websocket";
import { ACTIVE_MARKETS, MARKETS, type MarketConfig } from "@/config";
import { usdToPriceRaw } from "@/lib/market/marks";
import type { OrderBook, RecentTrade } from "@/lib/market/matcher";
import { apiFetch } from "@/lib/api";

interface Props {
  market: MarketConfig;
  children: React.ReactNode;
}

// Binance pair for a market. Unknown ids return null rather than falling back
// to XLM — a wrong ticker is worse than no 24h stats.
function getBinancePair(marketId: number): string | null {
  const market = Object.values(MARKETS).find((m) => m.marketId === marketId);
  if (!market || market.kind === "equity") return null;
  return market.priceSourceSymbol;
}

// Fetch Binance 24h ticker once — gives last price, 24h high/low, and 24h % change.
async function fetchBinance24h(
  marketId: number
): Promise<{ price: bigint; highPrice: bigint; lowPrice: bigint; changePct: number } | null> {
  try {
    const pair = getBinancePair(marketId);
    if (!pair) return null;
    const res = await fetch(
      `https://api.binance.com/api/v3/ticker/24hr?symbol=${pair}`,
      { cache: "no-store" }
    );
    if (!res.ok) return null;
    const data = (await res.json()) as {
      lastPrice: string;
      highPrice: string;
      lowPrice: string;
      priceChangePercent: string;
    };
    const priceFloat = parseFloat(data.lastPrice);
    const highFloat = parseFloat(data.highPrice);
    const lowFloat = parseFloat(data.lowPrice);
    const changePct = parseFloat(data.priceChangePercent);
    return {
      price: usdToPriceRaw(priceFloat),
      highPrice: usdToPriceRaw(highFloat),
      lowPrice: usdToPriceRaw(lowFloat),
      changePct: isNaN(changePct) ? 0 : changePct,
    };
  } catch {
    return null;
  }
}

/**
 * One batched 24h ticker for EVERY active market.
 *
 * The market switcher and the markets page show a price and 24h change per
 * row, which needs data for markets the terminal is not currently subscribed
 * to. Binance's /ticker/24hr accepts a `symbols` array, so this is a single
 * request for all eight rather than eight requests — and notably it does NOT
 * require touching lib/market/websocket.ts, whose single global handler set
 * still only has to serve the one market on screen.
 */
async function fetchAllTickers(): Promise<
  Record<number, { price: bigint; changePct: number }>
> {
  const markets = Object.values(ACTIVE_MARKETS).filter((m) => m.kind !== "equity");
  const symbols = markets.map((m) => m.priceSourceSymbol);
  if (symbols.length === 0) return {};
  const url =
    `https://api.binance.com/api/v3/ticker/24hr?symbols=` +
    encodeURIComponent(JSON.stringify(symbols));
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) return {};
  const rows = (await res.json()) as { symbol: string; lastPrice: string; priceChangePercent: string }[];
  const bySymbol = new Map(rows.map((r) => [r.symbol, r]));

  const out: Record<number, { price: bigint; changePct: number }> = {};
  for (const m of markets) {
    const r = bySymbol.get(m.priceSourceSymbol);
    if (!r) continue;
    const last = parseFloat(r.lastPrice);
    const pct = parseFloat(r.priceChangePercent);
    if (!Number.isFinite(last) || last <= 0) continue;
    out[m.marketId] = {
      price: usdToPriceRaw(last),
      changePct: Number.isFinite(pct) ? pct : 0,
    };
  }
  return out;
}

export function MarketDataProvider({ market, children }: Props) {
  const marketId = market.marketId;
  const oracleSymbol = market.oracleSymbol;
  // NOTE: intentionally does NOT subscribe to the store (no useMarketStore()).
  // It only writes via getState() setters, so market-data ticks never re-render
  // this wrapper or its (stable) children.
  const wsActiveRef = useRef(false);
  const visibleRef = useRef(true);
  const inFlightRef = useRef<Record<string, boolean>>({});

  useEffect(() => {
    let cancelled = false;
    const set = () => useMarketStore.getState();
    const runOnce = async (key: string, fn: () => Promise<void>) => {
      if (inFlightRef.current[key]) return;
      inFlightRef.current[key] = true;
      try {
        await fn();
      } finally {
        inFlightRef.current[key] = false;
      }
    };

    visibleRef.current = typeof document === "undefined" ? true : document.visibilityState === "visible";
    function onVisibility() {
      visibleRef.current = document.visibilityState === "visible";
      if (visibleRef.current) {
        pollOracle();
        pollOrderBook();
        pollTrades();
        pollMarketStats();
        pollAllTickers();
      }
    }
    document.addEventListener("visibilitychange", onVisibility);

    // ── Oracle price → Binance fallback ──────────────────────────────────────
    // Wrapped so a failed/slow RPC never becomes an unhandled rejection on the
    // polling interval; we degrade to the Binance price instead.
    async function pollOracle() {
      if (!visibleRef.current) return;
      await runOnce("oracle", async () => {
      try {
        const res = await apiFetch("/api/prices", { cache: "no-store" });
        if (res.ok) {
          const data = (await res.json()) as {
            raw?: Record<string, string>;
            tickers?: Record<string, {
              high: number;
              low: number;
              changePct: number;
              volumeUsd: number;
              openInterestUsd: number;
              volume?: number;
              fundingRate?: number;
            }>;
          };
          for (const [id, px] of Object.entries(data.raw ?? {})) {
            if (px && BigInt(px) > 0n) set().setMarkPrice(Number(id), BigInt(px));
          }
          for (const [id, t] of Object.entries(data.tickers ?? {})) {
            const mid = Number(id);
            const volumeUsd = t.volumeUsd ?? 0;
            set().setPriceChangePct(mid, t.changePct);
            set().setTicker24h(mid, {
              highPrice: t.high,
              lowPrice: t.low,
              changePct: t.changePct,
              volumeUsd,
              volume: t.volume,
              openInterestUsd: t.openInterestUsd ?? 0,
              fundingRate: t.fundingRate,
            });
          }
          if (data.raw?.[String(marketId)]) return;
        }
      } catch { /* fall through */ }
      try {
        const result = await getOraclePrice(oracleSymbol);
        if (cancelled) return;
        if (result && result.price > 0n) {
          set().setMarkPrice(marketId, result.price);
          return;
        }
      } catch { /* RPC failure — fall through to Binance */ }
      try {
        const b = await fetchBinance24h(marketId);
        if (!cancelled && b && b.price > 0n) set().setMarkPrice(marketId, b.price);
      } catch { /* best-effort */ }
      });
    }

    // ── 24h change (Yahoo for equities, Binance for crypto) ──────────────────
    async function poll24h() {
      if (!visibleRef.current) return;
      await runOnce("24h", async () => {
      try {
        const res = await apiFetch("/api/prices", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as {
          tickers?: Record<string, {
            high: number;
            low: number;
            changePct: number;
            volumeUsd: number;
            volume?: number;
            openInterestUsd: number;
            fundingRate?: number;
          }>;
        };
        const t = data.tickers?.[String(marketId)];
        if (!t || cancelled) return;
        set().setPriceChangePct(marketId, t.changePct);
        set().setTicker24h(marketId, {
          highPrice: t.high,
          lowPrice: t.low,
          changePct: t.changePct,
          volumeUsd: t.volumeUsd,
          volume: t.volume,
          openInterestUsd: t.openInterestUsd,
          fundingRate: t.fundingRate,
        });
      } catch { /* /api/prices already retried in pollOracle */ }
      });
    }

    // ── All-markets ticker (switcher rows) ───────────────────────────────────
    // Only writes markets OTHER than the active one, so it can never race the
    // active market's oracle-backed mark price with a Binance figure.
    async function pollAllTickers() {
      if (!visibleRef.current) return;
      await runOnce("allTickers", async () => {
        try {
          const all = await fetchAllTickers();
          if (cancelled) return;
          for (const [idStr, v] of Object.entries(all)) {
            const id = Number(idStr);
            set().setPriceChangePct(id, v.changePct);
            if (id !== marketId) set().setMarkPrice(id, v.price);
          }
        } catch { /* best-effort — rows fall back to "—" */ }
      });
    }

    // ── Orderbook / trades REST polling (fallback when WS is down) ────────────
    async function pollOrderBook() {
      if (!visibleRef.current) return;
      // Live book comes from the WS; REST is only a reconnect fallback.
      if (wsActiveRef.current) return;
      await runOnce("book", async () => {
      const book = await fetchOrderBook(marketId);
      if (!cancelled && book) set().setOrderBook(marketId, book);
      });
    }

    async function pollTrades() {
      if (!visibleRef.current) return;
      if (wsActiveRef.current) return;
      await runOnce("trades", async () => {
      const trades = await fetchRecentTrades(marketId);
      if (!cancelled && trades.length > 0) set().setTrades(marketId, trades);
      });
    }

    // ── Market stats from indexer / node-runtime ──────────────────────────────
    async function pollMarketStats() {
      if (!visibleRef.current) return;
      await runOnce("stats", async () => {
      try {
        const res = await apiFetch(`/api/markets/${marketId}`, { cache: "no-store" });
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as Record<string, unknown>;
        if (cancelled) return;
        const lastPrice = BigInt(String(data["last_price"] ?? "0"));
        const volume = BigInt(String(data["volume"] ?? "0"));
        const existing = set().marketStats[marketId];
        set().setMarketStats(marketId, {
          lastPrice: lastPrice > 0n ? lastPrice : existing?.lastPrice ?? 0n,
          volume: volume > 0n ? volume : existing?.volume ?? 0n,
          longOI: BigInt(String(data["long_open_interest"] ?? "0")),
          shortOI: BigInt(String(data["short_open_interest"] ?? "0")),
        });
      } catch { /* best-effort */ }
      });
    }

    // ── WS handlers ──────────────────────────────────────────────────────────
    function handleWsOrderBook(mid: number, book: OrderBook) {
      if (mid !== marketId) return;
      set().setOrderBook(mid, book);
    }
    function handleWsTrade(mid: number, trade: RecentTrade) {
      if (mid !== marketId) return;
      set().prependTrade(mid, trade);
    }
    function handleWsStatus(connected: boolean) {
      wsActiveRef.current = connected;
      set().setWsConnected(connected);
      if (!connected) {
        pollOrderBook();
        pollTrades();
      }
    }

    // Initial fetches immediately
    pollOracle();
    poll24h();
    pollAllTickers();
    pollOrderBook();
    pollTrades();
    pollMarketStats();

    const timers = [
      setInterval(pollOracle, 5_000),
      // REST book/trades only when the WS is down (see pollOrderBook / pollTrades).
      setInterval(() => { pollOrderBook(); pollTrades(); }, 5_000),
      setInterval(pollMarketStats, 20_000),
      setInterval(poll24h, 30_000),
      // Switcher rows only need to be roughly live.
      setInterval(pollAllTickers, 60_000),
    ];

    wsReset();
    wsSetHandlers(handleWsOrderBook, handleWsTrade, handleWsStatus);
    wsSubscribe(marketId);

    return () => {
      cancelled = true;
      timers.forEach(clearInterval);
      document.removeEventListener("visibilitychange", onVisibility);
      wsUnsubscribe(marketId);
      wsDisconnect();
    };
  }, [marketId, oracleSymbol]);

  return <>{children}</>;
}
