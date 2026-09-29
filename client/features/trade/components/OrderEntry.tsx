"use client";

import { useState, useEffect, useRef } from "react";
import { useWalletStore } from "@/stores/wallet";
import { useMarketStore } from "@/stores/market";
import { MarketConfig, AMOUNT_PRECISION, PRICE_PRECISION, ASSETS, PLATFORM_FEE_BPS } from "@/config";
import { buildOrderIntent } from "@/lib/market/order-intent";
import { submitOrder } from "@/lib/market/matcher";
import { useLocalOrders } from "@/stores/orders";
import { toast } from "sonner";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { getBalance } from "@/lib/solana/vault";
import { getAccountHealth } from "@/lib/solana/health";
import { amountToHuman, formatAccountUsd, formatMarketPrice, formatMarketUsd, priceToHuman, toPriceInput } from "@/lib/format";
import { calcLiqPrice } from "@/lib/math";
import { gainPct, pnlUsd, priceFromPct, priceFromPnl, roePct, validateTpSl } from "@/lib/market/tpsl";
import {
  baseSizeFromInput,
  nextTicketSizeMode,
  sizeFromBuyingPowerPct,
} from "@/lib/market/quick-market";
import { UsdcLogo, logoFor } from "@/components/common/AssetLogos";
import { useTradeSettings } from "@/stores/settings";
import { Shuffle, X } from "lucide-react";

/* ── Icons ── */
const SwapIcon = () => (
  <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
    <path d="M7 7h13l-3-3M17 17H4l3 3" />
  </svg>
);
const CheckIcon = () => (
  <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M2 6.5 5 9.5 10 3.5" />
  </svg>
);
const EditIcon = () => (
  <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
  </svg>
);

/* ── Main OrderEntry ── */
export function OrderEntry({
  market,
  side: sideProp,
  setSide: setSideProp,
}: {
  market: MarketConfig;
  /** Optional controlled side — lets the mobile bottom bar preset long/short. */
  side?: "buy" | "sell";
  setSide?: (v: "buy" | "sell") => void;
}) {
  const { address, connected, setWrongNetwork } = useWalletStore();
  const queryClient = useQueryClient();
  const addOrder = useLocalOrders((s) => s.addOrder);
  const localOrders = useLocalOrders((s) => s.orders);
  const rawMarkPrice = useMarketStore((s) => s.markPrices[market.marketId]);
  const book = useMarketStore((s) => s.orderBooks[market.marketId]);
  const selectedPrice = useMarketStore((s) => s.selectedPrice[market.marketId]);
  const degenMode = useTradeSettings((s) => s.degenMode);
  const setDegenMode = useTradeSettings((s) => s.setDegenMode);
  const ticketLeverage = useTradeSettings((s) => s.ticketLeverage);
  const setTicketLeverage = useTradeSettings((s) => s.setTicketLeverage);
  const size = useTradeSettings((s) => s.ticketSize);
  const setSize = useTradeSettings((s) => s.setTicketSize);
  const sizeMode = useTradeSettings((s) => s.ticketSizeMode);
  const setSizeMode = useTradeSettings((s) => s.setTicketSizeMode);

  const [sideState, setSideState] = useState<"buy" | "sell">("buy");
  const side = sideProp ?? sideState;
  const setSide = setSideProp ?? setSideState;
  const [orderType, setOrderType] = useState<"market" | "limit">("market");
  const [limitPrice, setLimitPrice] = useState("");
  const [tpPrice, setTpPrice] = useState("");
  const [slPrice, setSlPrice] = useState("");
  const [tpGain, setTpGain] = useState("");
  const [slLoss, setSlLoss] = useState("");
  const [tpGainUnit, setTpGainUnit] = useState<"percent" | "quote">("percent");
  const [slLossUnit, setSlLossUnit] = useState<"percent" | "quote">("percent");
  const [degenPromptOpen, setDegenPromptOpen] = useState(false);

  const { data: feeQuote } = useQuery({
    queryKey: ["fee-tier", address],
    queryFn: async () => {
      const q = address ? `?owner=${encodeURIComponent(address)}` : "";
      const res = await apiFetch(`/api/stake${q}`, { cache: "no-store" });
      if (!res.ok) return { feeBps: PLATFORM_FEE_BPS };
      return (await res.json()) as { feeBps?: number };
    },
    staleTime: 15_000,
    refetchInterval: 20_000,
  });
  const feeBps = feeQuote?.feeBps ?? PLATFORM_FEE_BPS;

  const sanitizeNumericInput = (val: string): string => {
    // Allow only digits and a single decimal point; strip leading zeros
    const cleaned = val.replace(/[^0-9.]/g, "").replace(/^0+(\d)/, "$1");
    const parts = cleaned.split(".");
    return parts.length > 2 ? parts[0] + "." + parts.slice(1).join("") : cleaned;
  };
  const [reduce, setReduce] = useState(false);
  const [post, setPost] = useState(false);
  const [tpsl, setTpsl] = useState(false);
  const [loading, setLoading] = useState(false);
  const [fastPoll, setFastPoll] = useState(false);

  // Leverage cap always follows the market config (which mirrors the on-chain
  // engine limits) — degen mode must not advertise leverage the chain rejects.
  const maxLev = Math.round(market.maxLeverageBps / 10000);
  const leverage = Math.min(Math.max(1, ticketLeverage || 15), maxLev);
  const setLeverage = (v: number | ((prev: number) => number)) => {
    const next = typeof v === "function" ? v(leverage) : v;
    setTicketLeverage(next);
  };
  const effectiveLeverage = Math.min(leverage, maxLev);
  const levMarks = [1, 2, 5, 10, 25, 50, maxLev].filter(
    (v, i, arr) => v >= 1 && v <= maxLev && arr.indexOf(v) === i
  );

  // Picking a price in the order book / trades feed loads it as a limit price.
  useEffect(() => {
    if (selectedPrice != null && selectedPrice > 0) {
      queueMicrotask(() => {
        setOrderType("limit");
        setLimitPrice(toPriceInput(market, selectedPrice));
      });
    }
  }, [selectedPrice, market]);

  const { data: balance } = useQuery({
    queryKey: ["balance", address],
    queryFn: () => getBalance(address!, ASSETS.usdc),
    enabled: !!address && connected,
    refetchInterval: fastPoll ? 3_000 : 15_000,
  });

  const { data: health } = useQuery({
    queryKey: ["health", address],
    queryFn: () => getAccountHealth(address!, ASSETS.usdc),
    enabled: !!address && connected,
    refetchInterval: fastPoll ? 3_000 : 15_000,
  });

  // Available to trade = free collateral (balance minus locked margin).
  // Falls back to raw vault balance when no positions exist yet.
  const availableToTrade: bigint = health?.freeCollateral ?? balance ?? 0n;

  // ── Live mid price: oracle mark → orderbook mid → fallback 0 ───────────────
  const midPriceHuman: number | null = (() => {
    if (rawMarkPrice && rawMarkPrice > 0n) return priceToHuman(rawMarkPrice);
    if (book?.asks[0] && book?.bids[0]) {
      return (parseFloat(book.asks[0].price) + parseFloat(book.bids[0].price)) / 2;
    }
    return null;
  })();

  const sizeNum = parseFloat(size) || 0;
  const limitPriceNum = parseFloat(limitPrice) || 0;
  const baseSymbol = market.baseAsset;
  const sizeUnit =
    sizeMode === "base" ? baseSymbol : sizeMode === "quote" ? market.quoteAsset : "Margin";
  const midDisplay = midPriceHuman !== null ? formatMarketPrice(market, midPriceHuman) : "—";

  const execPrice = orderType === "market" ? midPriceHuman ?? 0 : limitPriceNum;
  const bestAsk = book?.asks[0] ? parseFloat(book.asks[0].price) : null;
  const bestBid = book?.bids[0] ? parseFloat(book.bids[0].price) : null;
  const baseSizeNum = baseSizeFromInput(sizeNum, sizeMode, execPrice, effectiveLeverage);

  const orderValue = baseSizeNum > 0 && execPrice > 0
    ? (baseSizeNum * execPrice).toFixed(2)
    : "0.00";
  const feeUsd = baseSizeNum > 0 && execPrice > 0
    ? (baseSizeNum * execPrice * feeBps) / 10_000
    : 0;
  const marginRequired = baseSizeNum > 0 && execPrice > 0
    ? (baseSizeNum * execPrice / effectiveLeverage).toFixed(2)
    : "0.00";

  // Estimated liquidation price
  const liqPriceDisplay = (() => {
    if (baseSizeNum <= 0 || execPrice <= 0) return "—";
    const entryRaw = BigInt(Math.round(execPrice * Number(PRICE_PRECISION)));
    const liq = calcLiqPrice(
      side === "buy",
      entryRaw,
      effectiveLeverage,
      market.maintenanceMarginBps
    );
    if (liq <= 0n) return "—";
    return formatMarketUsd(market, liq);
  })();

  const liqHuman = (() => {
    if (baseSizeNum <= 0 || execPrice <= 0) return 0;
    const entryRaw = BigInt(Math.round(execPrice * Number(PRICE_PRECISION)));
    const liq = calcLiqPrice(side === "buy", entryRaw, effectiveLeverage, market.maintenanceMarginBps);
    return liq > 0n ? priceToHuman(liq) : 0;
  })();

  const isLong = side === "buy";
  const tpNum = parseFloat(tpPrice) || 0;
  const slNum = parseFloat(slPrice) || 0;
  const tpPnl = tpNum > 0 && execPrice > 0 && baseSizeNum > 0
    ? pnlUsd(execPrice, tpNum, baseSizeNum, isLong) : 0;
  const slPnl = slNum > 0 && execPrice > 0 && baseSizeNum > 0
    ? pnlUsd(execPrice, slNum, baseSizeNum, isLong) : 0;
  const notional = baseSizeNum * execPrice;
  const tpRoe = roePct(tpPnl, notional, effectiveLeverage);
  const slRoe = roePct(slPnl, notional, effectiveLeverage);
  const tpSlError = tpsl
    ? validateTpSl({
        isLong,
        entry: execPrice,
        tp: tpNum || undefined,
        sl: slNum || undefined,
        liq: liqHuman || undefined,
      })
    : null;

  const editingTpGain = useRef(false);
  const editingSlLoss = useRef(false);

  // Keep % / USDC in sync with the current mark and size. Those fields used to
  // freeze at whatever was typed, so a $1080 TP still showed a stale 33.84%.
  useEffect(() => {
    if (!(execPrice > 0)) return;
    if (!editingTpGain.current && tpNum > 0) {
      const pct = gainPct(execPrice, tpNum, isLong);
      const usd = pnlUsd(execPrice, tpNum, Math.max(baseSizeNum, 0), isLong);
      const next = tpGainUnit === "percent" ? pct.toFixed(2) : Math.abs(usd).toFixed(2);
      setTpGain((prev) => (prev === next ? prev : next));
    }
    if (!editingSlLoss.current && slNum > 0) {
      const pct = -gainPct(execPrice, slNum, isLong);
      const usd = -pnlUsd(execPrice, slNum, Math.max(baseSizeNum, 0), isLong);
      const next = slLossUnit === "percent" ? Math.max(0, pct).toFixed(2) : Math.max(0, usd).toFixed(2);
      setSlLoss((prev) => (prev === next ? prev : next));
    }
  }, [execPrice, tpNum, slNum, isLong, baseSizeNum, tpGainUnit, slLossUnit]);

  function onTpPrice(raw: string) {
    const next = sanitizeNumericInput(raw);
    setTpPrice(next);
    const px = parseFloat(next);
    if (!(px > 0) || execPrice <= 0) return;
    const pct = gainPct(execPrice, px, isLong);
    const usd = pnlUsd(execPrice, px, Math.max(baseSizeNum, 0), isLong);
    setTpGain(tpGainUnit === "percent" ? pct.toFixed(2) : Math.abs(usd).toFixed(2));
  }

  function onTpGain(raw: string) {
    const next = sanitizeNumericInput(raw);
    setTpGain(next);
    const g = parseFloat(next);
    if (!(g > 0) || execPrice <= 0) return;
    const px = tpGainUnit === "percent"
      ? priceFromPct(execPrice, g, isLong, true)
      : priceFromPnl(execPrice, g, Math.max(baseSizeNum, 1e-9), isLong, true);
    if (px > 0) setTpPrice(toPriceInput(market, px));
  }

  function onSlPrice(raw: string) {
    const next = sanitizeNumericInput(raw);
    setSlPrice(next);
    const px = parseFloat(next);
    if (!(px > 0) || execPrice <= 0) return;
    const pct = -gainPct(execPrice, px, isLong);
    const usd = -pnlUsd(execPrice, px, Math.max(baseSizeNum, 0), isLong);
    setSlLoss(slLossUnit === "percent" ? Math.max(0, pct).toFixed(2) : Math.max(0, usd).toFixed(2));
  }

  function onSlLoss(raw: string) {
    const next = sanitizeNumericInput(raw);
    setSlLoss(next);
    const g = parseFloat(next);
    if (!(g > 0) || execPrice <= 0) return;
    const px = slLossUnit === "percent"
      ? priceFromPct(execPrice, g, isLong, false)
      : priceFromPnl(execPrice, g, Math.max(baseSizeNum, 1e-9), isLong, false);
    if (px > 0) setSlPrice(toPriceInput(market, px));
  }

  function applySizePct(pct: number) {
    const avail = amountToHuman(availableToTrade);
    const next = sizeFromBuyingPowerPct({
      availableHuman: avail,
      leverage: effectiveLeverage,
      pct,
      execPrice,
      sizeMode,
    });
    if (!next) {
      toast.error(avail <= 0 ? "Deposit USDC first" : "Waiting for a market price");
      return;
    }
    setSize(next);
  }

  async function handleSubmit(nextSide?: "buy" | "sell") {
    const orderSide = nextSide ?? side;
    if (nextSide) setSide(nextSide);
    if (!address || !connected) { toast.error("Connect your wallet first"); return; }
    setWrongNetwork(false);
    if (!size || sizeNum <= 0) { toast.error("Enter a valid size"); return; }
    if (execPrice <= 0) {
      toast.error(orderType === "market" ? "Waiting for a market price" : "Enter a limit price"); return;
    }
    if (sizeMode !== "base" && baseSizeNum <= 0) {
      toast.error("Waiting for a price to convert the order size");
      return;
    }
    if (post && orderType !== "limit") {
      toast.error("Post Only is only available for limit orders");
      return;
    }
    if (post && orderType === "limit") {
      const wouldCross = orderSide === "buy"
        ? bestAsk !== null && limitPriceNum >= bestAsk
        : bestBid !== null && limitPriceNum <= bestBid;
      if (wouldCross) {
        toast.error("Post Only order would execute immediately");
        return;
      }
    }
    if (tpsl) {
      if (!tpPrice && !slPrice && !tpGain && !slLoss) {
        toast.error("Enter a take-profit or stop-loss value");
        return;
      }
      const err = validateTpSl({
        isLong: orderSide === "buy",
        entry: execPrice,
        tp: parseFloat(tpPrice) || undefined,
        sl: parseFloat(slPrice) || undefined,
        liq: liqHuman || undefined,
      });
      if (err) {
        toast.error(err);
        return;
      }
    }

    // Self-trade heads-up: the matcher never matches two orders from the same
    // wallet, so an order that only crosses the user's own resting order will
    // sit unfilled until a different wallet takes the other side.
    const wouldSelfCross = localOrders.some((o) => {
      if (o.status !== "pending" || o.owner !== address || o.marketId !== market.marketId) return false;
      if (o.isLong === (orderSide === "buy")) return false;
      if (orderType === "market") return true; // market orders cross any resting price
      const restingPrice = priceToHuman(o.limitPrice);
      return orderSide === "buy" ? limitPriceNum >= restingPrice : limitPriceNum <= restingPrice;
    });
    if (wouldSelfCross) {
      toast.warning(
        "This order crosses your own resting order. Self-matches are skipped — it will only fill against another wallet."
      );
    }

    // Client-side margin check — prevents orders that would fail on-chain settlement
    const marginRequiredNum = parseFloat(marginRequired);
    if (marginRequiredNum > 0 && availableToTrade !== undefined) {
      const availableHuman = amountToHuman(availableToTrade);
      if (marginRequiredNum > availableHuman) {
        toast.error(
          `Insufficient balance — $${marginRequiredNum.toFixed(2)} required, $${availableHuman.toFixed(2)} available. Deposit more collateral or reduce size.`
        );
        return;
      }
    }

    setLoading(true);
    try {
      const rawSize = BigInt(Math.round(baseSizeNum * Number(AMOUNT_PRECISION)));
      // Market orders use an aggressive limit price so the on-chain validate_order
      // (which requires limit_price > 0) accepts the settlement.
      // Buys use 2× mark price; sells use 0.5× — both cross any resting order immediately.
      const rawPrice = orderType === "market"
        ? (() => {
            const mark = rawMarkPrice && rawMarkPrice > 0n
              ? rawMarkPrice
              : BigInt(Math.round(execPrice * Number(PRICE_PRECISION)));
            return orderSide === "buy" ? mark * 2n : mark / 2n || 1n;
          })()
        : BigInt(Math.round(limitPriceNum * Number(PRICE_PRECISION)));

      const intent = buildOrderIntent({
        owner: address,
        marketId: market.marketId,
        isLong: orderSide === "buy",
        size: rawSize,
        limitPrice: rawPrice,
        reduceOnly: reduce,
        ttlSeconds: 3600,
        leverage: effectiveLeverage,
      });
      const result = await submitOrder(intent, {
        ...(tpsl ? {
          tpPrice: parseFloat(tpPrice) || undefined,
          slPrice: parseFloat(slPrice) || undefined,
        } : {}),
        ...(orderType === "market" ? { ioc: true, orderType: "market" as const } : {}),
      });
      if (result.ok) {
        addOrder(intent, { ticketType: orderType === "market" ? "market" : "limit" });
        const filledQty = result.fills?.reduce((s, f) => s + f.size, 0) ?? 0;
        const fillNotional = result.fills?.reduce((s, f) => s + f.price * f.size, 0) ?? 0;
        const avgFillPrice = filledQty > 0 ? fillNotional / filledQty : undefined;
        if (filledQty > 0 || orderType === "market") {
          // Market/IOC never rests — mark filled or cancel so Open Orders stays clean.
          if (filledQty > 0) {
            useLocalOrders.getState().markFilled(intent.nonce, address, {
              avgFillPrice,
              filledSize: filledQty,
            });
          } else useLocalOrders.getState().cancelOrder(intent.nonce, address);
        }
        if (result.book) useMarketStore.getState().setOrderBook(market.marketId, result.book);
        const extras = tpsl && (tpPrice || slPrice)
          ? ` · TP ${tpPrice || "—"} / SL ${slPrice || "—"}`
          : "";
        toast.success(
          filledQty > 0
            ? `${orderType === "market" ? "Market" : "Limit"} ${orderSide} filled${extras}`
            : `${orderType === "market" ? "Market" : "Limit"} ${orderSide} resting` +
              (post ? " as post-only" : "") +
              (reduce ? " reduce-only" : "") +
              extras
        );
        // Immediately refetch all user-facing data and poll fast for 30s to catch on-chain settlement
        const keys = [["balance", address], ["health", address], ["fills", address], ["positions", address]];
        const invalidateAll = () => keys.forEach((key) => queryClient.invalidateQueries({ queryKey: key }));
        invalidateAll();
        [1_500, 4_000, 10_000].forEach((ms) => setTimeout(invalidateAll, ms));
        setFastPoll(true);
        setTimeout(() => setFastPoll(false), 30_000);
      } else {
        toast.error(result.error ?? "Order rejected");
      }
      setSize("");
    } catch (e) {
      toast.error(String(e));
    } finally {
      setLoading(false);
    }
  }

  const rowCls = "flex justify-between items-center text-[12px] text-[#a3a3a3]";
  const showTpSl = true;
  // Degen mode: kept in code but hidden for v1 — its old 500x cap exceeded the
  // on-chain max leverage, so the toggle only misled users.
  const showDegenMode = false;

  return (
    <div className="relative flex flex-col">
      <div className="flex flex-col gap-[10px] p-3">
        <div className="flex items-center justify-between">
          <div className="desk-seg w-[148px]">
            <button
              type="button"
              onClick={() => setReduce(false)}
              className={!reduce ? "is-on" : ""}
            >
              Open
            </button>
            <button
              type="button"
              onClick={() => setReduce(true)}
              className={reduce ? "is-on" : ""}
            >
              Close
            </button>
          </div>
          <div className="flex items-center gap-1.5 text-[11px] text-[#8A9B94]">
            <span>Available</span>
            <span className="font-mono tabular text-[#f5f5f5]">
              {connected ? formatAccountUsd(amountToHuman(availableToTrade)) : "$0.00"}
            </span>
          </div>
        </div>

        {/* Order type + price display */}
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(116px,1fr)] gap-2">
          <div className="desk-seg h-[36px]">
            <button
              type="button"
              className={orderType === "market" ? "is-on" : ""}
              onClick={() => {
                setOrderType("market");
                setPost(false);
                if (midPriceHuman && !limitPrice) setLimitPrice(toPriceInput(market, midPriceHuman));
              }}
            >
              Market
            </button>
            <button
              type="button"
              className={orderType === "limit" ? "is-on" : ""}
              onClick={() => {
                setOrderType("limit");
                if (midPriceHuman && !limitPrice) setLimitPrice(toPriceInput(market, midPriceHuman));
              }}
            >
              Limit
            </button>
          </div>
          {orderType === "limit" ? (
            <div className="flex h-[36px] min-w-0 items-center justify-end gap-2 rounded-[8px] bg-[#0E1614] px-3">
              <span className="font-mono text-[12.5px] font-medium text-[#8f98aa]">$</span>
              <input
                className="min-w-0 flex-1 bg-transparent text-right font-mono text-[12.5px] font-medium text-[#f5f5f5] outline-none placeholder:text-[#737373]"
                placeholder={midDisplay === "—" ? "0.0000" : midDisplay}
                value={limitPrice}
                onChange={(e) => setLimitPrice(sanitizeNumericInput(e.target.value))}
              />
              <span className="rounded-[5px] bg-[#2a2a31] px-2 py-[4px] text-[10.5px] font-semibold text-[#737373]">
                LIMIT
              </span>
            </div>
          ) : (
            <div className="h-[36px]" aria-hidden="true" />
          )}
        </div>

        {orderType === "market" && (
          <div className="flex items-center justify-between rounded-[8px] border border-[#1C332C] bg-[#0E1614] px-3 py-2">
            <span className="text-[12px] text-[#8A9B94]">Price</span>
            <button
              type="button"
              className="font-mono text-[13px] font-semibold text-[#f5f5f5]"
              onClick={() => {
                if (midPriceHuman) {
                  setOrderType("limit");
                  setLimitPrice(toPriceInput(market, midPriceHuman));
                }
              }}
            >
              {midDisplay} <span className="text-[10px] text-[#6b7c74]">Last</span>
            </button>
          </div>
        )}

        {/* Order size field — cycle base qty → notional USDC → margin USDC */}
        <div className="flex flex-col gap-1 rounded-[9px] border border-[#1C332C] bg-[#0E1614] p-2">
          <div className="flex items-center justify-between text-[12px] text-[#a3a3a3]">
            <span>{sizeMode === "margin" ? "Margin" : "Quantity"}</span>
            <span className="font-mono text-[11px] text-[#737373]">
              ${sizeNum > 0 && execPrice > 0 ? (baseSizeNum * execPrice).toFixed(2) : "0.00"}
            </span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <input
              className="w-full flex-1 border-0 bg-transparent text-right font-mono text-[17px] font-medium text-[#f5f5f5] outline-none"
              placeholder="0"
              value={size}
              onChange={(e) => setSize(sanitizeNumericInput(e.target.value))}
            />
            <button
              type="button"
              onClick={() => setSizeMode(nextTicketSizeMode(sizeMode))}
              className="flex items-center gap-1.5 rounded-[6px] border border-[#1C332C] bg-[#0E1614] px-2 py-[3px] text-[12px] font-medium text-[#f5f5f5] transition-colors hover:border-[#2A4A40]"
              title="Cycle: asset → notional → margin"
            >
              {sizeMode === "base" ? logoFor(baseSymbol, 15) : <UsdcLogo size={15} />}
              {sizeUnit}
              <Shuffle size={13} className="text-[#a3a3a3]" />
            </button>
          </div>
          <div className="mt-1 grid grid-cols-4 gap-1">
            {[25, 50, 75, 100].map((pct) => (
              <button
                key={pct}
                type="button"
                onClick={() => applySizePct(pct)}
                className="rounded-[5px] bg-[#12201C] py-[5px] font-mono text-[11px] text-[#8A9B94] hover:bg-[#1A2A26] hover:text-[#f5f5f5]"
              >
                {pct}%
              </button>
            ))}
          </div>
        </div>

        {/* Degen mode */}
        {showDegenMode && (
        <div className="flex items-center justify-between px-1">
          <span className="text-[12px] font-semibold text-[#f5f5f5]">Degen Mode</span>
          <button
            type="button"
            aria-pressed={degenMode}
            onClick={() => {
              if (degenMode) {
                setDegenMode(false);
                setLeverage((v) => Math.min(v, Math.round(market.maxLeverageBps / 10000)));
                return;
              }
              setDegenPromptOpen(true);
            }}
            className={`relative h-[24px] w-[44px] rounded-full border transition-colors ${
              degenMode ? "border-[#14F195] bg-[#14F195]/20" : "border-[#1C332C] bg-[#0E1614]"
            }`}
          >
            <span
              className={`absolute left-0 top-1/2 h-[18px] w-[18px] -translate-y-1/2 rounded-full transition-transform ${
                degenMode ? "translate-x-[21px] bg-[#14F195]" : "translate-x-[3px] bg-[#a3a3a3]"
              }`}
            />
          </button>
        </div>
        )}

        {/* Order leverage — continuous 1…maxLev slider; marks sit on the real scale */}
        <div className="px-[2px] py-[2px]">
          <div className="flex items-center justify-between mb-[7px]">
            <span className="flex items-center gap-[6px] text-[12px] text-[#a3a3a3]">
              Order Leverage
              <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
                <rect x="4" y="3" width="16" height="18" rx="2" />
                <path d="M8 7h8M8 12h2M12 12h2M16 12h.01M8 16h2M12 16h2M16 16h.01" />
              </svg>
            </span>
            <span className="font-mono text-[14px] font-medium tabular-nums text-[#f5f5f5]">{effectiveLeverage}x</span>
          </div>
          <div className="relative pt-[2px] pb-[14px]">
            <input
              type="range"
              min={1}
              max={maxLev}
              step={1}
              value={effectiveLeverage}
              onChange={(e) => setLeverage(Number(e.target.value))}
              onInput={(e) => setLeverage(Number((e.target as HTMLInputElement).value))}
              className="desk-lev-slider"
              style={{
                // Live fill follows the thumb so drag feels continuous.
                background: `linear-gradient(to right, #f5f5f5 0%, #f5f5f5 ${
                  maxLev <= 1 ? 100 : ((effectiveLeverage - 1) / (maxLev - 1)) * 100
                }%, #1C332C ${
                  maxLev <= 1 ? 100 : ((effectiveLeverage - 1) / (maxLev - 1)) * 100
                }%, #1C332C 100%)`,
              }}
              aria-label="Order leverage"
            />
            <div className="pointer-events-none absolute inset-x-0 top-[18px] h-[14px]">
              {levMarks.map((m) => {
                const pct = maxLev <= 1 ? 0 : ((m - 1) / (maxLev - 1)) * 100;
                const active = effectiveLeverage === m;
                const edge =
                  pct <= 0 ? "translate-x-0" : pct >= 100 ? "-translate-x-full" : "-translate-x-1/2";
                return (
                  <button
                    key={m}
                    type="button"
                    tabIndex={-1}
                    className={`pointer-events-auto absolute top-0 ${edge} font-mono text-[10.5px] transition-colors ${
                      active ? "text-[#f5f5f5]" : "text-[#737373] hover:text-[#a3a3a3]"
                    }`}
                    style={{ left: `${pct}%` }}
                    onClick={() => setLeverage(m)}
                  >
                    {m}x
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* Checkboxes */}
        <div className="flex justify-between pt-[2px]">
          <CheckBox checked={reduce} onChange={setReduce} label="Reduce Only" />
          <CheckBox
            checked={post}
            onChange={(v) => {
              if (v && orderType !== "limit") {
                toast.error("Post Only is only available for limit orders");
                return;
              }
              setPost(v);
            }}
            label="Post Only"
          />
        </div>
        {showTpSl && <CheckBox checked={tpsl} onChange={setTpsl} label="Take Profit / Stop Loss" />}
        {showTpSl && tpsl && (
          <div className="flex flex-col gap-2">
            <div className="grid grid-cols-2 gap-2">
              <TpSlBox label="TP Price" prefix="$" value={tpPrice} onChange={onTpPrice} placeholder="0" />
              <TpSlBox
                label="Gain"
                suffix={tpGainUnit === "percent" ? "%" : " USDC"}
                value={tpGain}
                onChange={onTpGain}
                onFocusChange={(on) => { editingTpGain.current = on; }}
                onToggleUnit={() => {
                  setTpGainUnit((u) => {
                    const next = u === "percent" ? "quote" : "percent";
                    if (tpNum > 0 && execPrice > 0) {
                      const pct = gainPct(execPrice, tpNum, isLong);
                      const usd = pnlUsd(execPrice, tpNum, Math.max(baseSizeNum, 0), isLong);
                      setTpGain(next === "percent" ? pct.toFixed(2) : Math.abs(usd).toFixed(2));
                    }
                    return next;
                  });
                }}
              />
            </div>
            {tpNum > 0 && execPrice > 0 && (
              <div className="px-1 font-mono text-[11px] text-[#1fae5b]">
                TP {formatMarketUsd(market, tpNum)} → {tpPnl >= 0 ? "+" : ""}${tpPnl.toFixed(2)}
                {baseSizeNum > 0 ? ` · ${tpRoe >= 0 ? "+" : ""}${tpRoe.toFixed(1)}% ROE` : ""}
              </div>
            )}
            <div className="grid grid-cols-2 gap-2">
              <TpSlBox label="SL Price" prefix="$" value={slPrice} onChange={onSlPrice} placeholder="0" />
              <TpSlBox
                label="Loss"
                suffix={slLossUnit === "percent" ? "%" : " USDC"}
                value={slLoss}
                onChange={onSlLoss}
                onFocusChange={(on) => { editingSlLoss.current = on; }}
                onToggleUnit={() => {
                  setSlLossUnit((u) => {
                    const next = u === "percent" ? "quote" : "percent";
                    if (slNum > 0 && execPrice > 0) {
                      const pct = -gainPct(execPrice, slNum, isLong);
                      const usd = -pnlUsd(execPrice, slNum, Math.max(baseSizeNum, 0), isLong);
                      setSlLoss(next === "percent" ? Math.max(0, pct).toFixed(2) : Math.max(0, usd).toFixed(2));
                    }
                    return next;
                  });
                }}
              />
            </div>
            {slNum > 0 && execPrice > 0 && (
              <div className="px-1 font-mono text-[11px] text-[#e8716f]">
                SL {formatMarketUsd(market, slNum)} → {slPnl >= 0 ? "+" : ""}${slPnl.toFixed(2)}
                {baseSizeNum > 0 ? ` · ${slRoe >= 0 ? "+" : ""}${slRoe.toFixed(1)}% ROE` : ""}
              </div>
            )}
            {tpSlError && (
              <div className="px-1 text-[11px] text-[#e8716f]">{tpSlError}</div>
            )}
          </div>
        )}

        <div className="grid grid-cols-2 gap-2">
          <div className="rounded-[8px] bg-[#0E1614] px-2 py-2">
            <div className="text-[10px] text-[#6b7c74]">Max Long</div>
            <div className="font-mono text-[12px] text-[#14F195] tabular">
              {connected && execPrice > 0
                ? `${(amountToHuman(availableToTrade) * effectiveLeverage / execPrice).toFixed(4)} ${baseSymbol}`
                : `0.00 ${baseSymbol}`}
            </div>
          </div>
          <div className="rounded-[8px] bg-[#0E1614] px-2 py-2 text-right">
            <div className="text-[10px] text-[#6b7c74]">Max Short</div>
            <div className="font-mono text-[12px] text-[#FF5C6A] tabular">
              {connected && execPrice > 0
                ? `${(amountToHuman(availableToTrade) * effectiveLeverage / execPrice).toFixed(4)} ${baseSymbol}`
                : `0.00 ${baseSymbol}`}
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={() => void handleSubmit("buy")}
            disabled={loading}
            className="desk-btn-long rounded-[8px] py-[12px] text-[13px] font-semibold disabled:opacity-50"
          >
            {loading && side === "buy" ? "Placing…" : reduce ? "Close Short" : "Open Long"}
          </button>
          <button
            onClick={() => void handleSubmit("sell")}
            disabled={loading}
            className="desk-btn-short rounded-[8px] py-[12px] text-[13px] font-semibold disabled:opacity-50"
          >
            {loading && side === "sell" ? "Placing…" : reduce ? "Close Long" : "Open Short"}
          </button>
        </div>
        {!connected && (
          <p className="text-center text-[11px] text-[#6b7c74]">Connect a wallet in the header to settle fills on Solana.</p>
        )}

        {/* Order summary */}
        <div className="flex flex-col gap-1.5 rounded-[9px] bg-[#0E1614] p-3">
          <div className={rowCls}>
            <span>{orderType === "market" ? "Expected Price" : "Limit Price"}</span>
            <span className="font-mono text-[#f5f5f5]">
              {execPrice > 0 ? formatMarketUsd(market, execPrice) : "—"}
            </span>
          </div>
          <div className={rowCls}>
            <span>Est. Liquidation Price</span>
            <span className={`font-mono ${liqPriceDisplay !== "—" ? "text-amber-400" : "text-[#f5f5f5]"}`}>
              {liqPriceDisplay}
            </span>
          </div>
          {tpsl && tpNum > 0 && (
            <div className={rowCls}>
              <span>Take Profit</span>
              <span className="font-mono text-[#1fae5b]">
                {formatMarketUsd(market, tpNum)}
                {baseSizeNum > 0 ? ` (${tpPnl >= 0 ? "+" : ""}${tpPnl.toFixed(2)})` : ""}
              </span>
            </div>
          )}
          {tpsl && slNum > 0 && (
            <div className={rowCls}>
              <span>Stop Loss</span>
              <span className="font-mono text-[#e8716f]">
                {formatMarketUsd(market, slNum)}
                {baseSizeNum > 0 ? ` (${slPnl >= 0 ? "+" : ""}${slPnl.toFixed(2)})` : ""}
              </span>
            </div>
          )}
          <div className={rowCls}>
            <span>Order Value</span>
            <span className="font-mono text-[#f5f5f5]">${orderValue}</span>
          </div>
          <div className={rowCls}>
            <span>Margin Required</span>
            <span className="font-mono text-[#f5f5f5]">${marginRequired}</span>
          </div>
          {orderType === "market" && (
            <div className={rowCls}>
              <span>Slippage</span>
              <span className="flex items-center gap-2 font-mono text-[#f5f5f5]">
                Est: - / Max: 1%
                <span className="text-[#ff9440]"><EditIcon /></span>
              </span>
            </div>
          )}
          <div className={rowCls}>
            <span>Fees</span>
            <span className="font-mono text-[#f5f5f5]">
              {(feeBps / 100).toFixed(2)}%
              {feeUsd > 0 ? ` · $${feeUsd.toFixed(2)}` : ""}
              {feeBps < PLATFORM_FEE_BPS ? " · $FLOYDEX" : ""}
            </span>
          </div>
        </div>
      </div>

      {degenPromptOpen && (
        <DegenModeModal
          onCancel={() => setDegenPromptOpen(false)}
          onAccept={() => {
            setDegenMode(true);
            setDegenPromptOpen(false);
          }}
        />
      )}
    </div>
  );
}

function DegenModeModal({
  onCancel,
  onAccept,
}: {
  onCancel: () => void;
  onAccept: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[80] flex items-end justify-center p-0 sm:items-center sm:p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onMouseDown={onCancel} />
      <div
        className="relative max-h-[92dvh] w-full max-w-full overflow-y-auto rounded-t-2xl border border-[#1C332C] bg-[#070B0A] p-5 pb-[max(20px,env(safe-area-inset-bottom))] text-[#f5f5f5] shadow-[0_20px_60px_rgba(0,0,0,.6)] sm:w-[420px] sm:rounded-xl sm:pb-5"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <div>
            <div className="text-[17px] font-bold text-[#f5f5f5]">Degen Mode</div>
            <div className="mt-1 text-[12px] text-[#a3a3a3]">Confirm elevated leverage risk</div>
          </div>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Close"
            className="w-7 h-7 grid place-items-center rounded-[6px] text-[#a3a3a3] hover:text-[#f5f5f5] hover:bg-[#0E1614] transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        <div className="mt-4 rounded-[12px] border border-[#1C332C] bg-[#0E1614] p-4">
          <div className="text-center">
            <div className="text-[12px] font-semibold uppercase tracking-[.16em] text-[#a3a3a3]">Are you</div>
            <div className="mt-1 text-[20px] font-black uppercase tracking-[.08em] text-[#f5f5f5]">
              Degen Enough?
            </div>
          </div>
          <div className="my-4 h-px bg-[#1A2A26]" />
          <ul className="space-y-3 text-[13px] leading-5 text-[#d4d4d8]">
            <li className="flex gap-3">
              <span className="mt-[8px] h-1.5 w-1.5 shrink-0 rounded-full bg-[#a3a3a3]" />
              <span>Degen positions can be liquidated extremely quickly during rapid price moves.</span>
            </li>
            <li className="flex gap-3">
              <span className="mt-[8px] h-1.5 w-1.5 shrink-0 rounded-full bg-[#a3a3a3]" />
              <span>At 500x, every tick matters and small execution delays can materially change risk.</span>
            </li>
            <li className="flex gap-3">
              <span className="mt-[8px] h-1.5 w-1.5 shrink-0 rounded-full bg-[#a3a3a3]" />
              <span>You are trading at your own risk. Use this mode only when you understand liquidation risk.</span>
            </li>
          </ul>
        </div>

        <div className="mt-5 grid grid-cols-2 gap-3">
          <button
            type="button"
            onClick={onCancel}
            className="h-12 rounded-[10px] border border-[#1C332C] bg-[#0E1614] text-[14px] font-semibold text-[#a3a3a3] hover:text-[#f5f5f5] hover:border-[#2A4A40] transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onAccept}
            className="h-12 rounded-[10px] text-[14px] font-bold text-[#070B0A] bg-[#14F195] hover:brightness-110 transition"
          >
            Accept & Continue
          </button>
        </div>
        <p className="mt-3 text-center text-[11px] text-[#737373]">
          This only changes the order ticket leverage cap.
        </p>
      </div>
    </div>
  );
}

function TpSlBox({
  label,
  value,
  onChange,
  prefix = "",
  suffix = "",
  placeholder = "0",
  onToggleUnit,
  onFocusChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  prefix?: string;
  suffix?: string;
  placeholder?: string;
  onToggleUnit?: () => void;
  onFocusChange?: (focused: boolean) => void;
}) {
  const sanitize = (val: string): string => {
    const cleaned = val.replace(/[^0-9.]/g, "").replace(/^0+(\d)/, "$1");
    const parts = cleaned.split(".");
    return parts.length > 2 ? parts[0] + "." + parts.slice(1).join("") : cleaned;
  };

  return (
    <div className="flex h-[36px] items-center justify-between gap-2 rounded-[8px] bg-[#0E1614] px-2.5 text-[11.5px]">
      <span className="text-[#9fb0c9]">{label}</span>
      <span className="flex min-w-0 items-center gap-1.5 font-mono text-[#9fb0c9]">
        {prefix && <span>{prefix}</span>}
        <input
          className="min-w-0 max-w-[88px] bg-transparent text-right font-mono text-[#f5f5f5] outline-none placeholder:text-[#737373]"
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(sanitize(e.target.value))}
          onFocus={() => onFocusChange?.(true)}
          onBlur={() => onFocusChange?.(false)}
        />
        {suffix && <span>{suffix}</span>}
        {onToggleUnit && (
          <button
            type="button"
            onClick={onToggleUnit}
            className="grid h-5 w-5 place-items-center rounded-[5px] bg-[#34343d] text-[#f5f5f5] transition-colors hover:bg-[#3d3d47]"
            aria-label={`Toggle ${label} unit`}
          >
            <SwapIcon />
          </button>
        )}
      </span>
    </div>
  );
}

function CheckBox({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      className={`flex items-center gap-2 text-[12.5px] transition-colors ${checked ? "text-[#f5f5f5]" : "text-[#a3a3a3]"}`}
      onClick={() => onChange(!checked)}
    >
      <div
        className={`w-[14px] h-[14px] rounded-[3px] border grid place-items-center transition-colors ${
          checked ? "bg-[#f5f5f5] border-[#f5f5f5] text-[#070B0A]" : "bg-[#0E1614] border-[#2A4A40]"
        }`}
      >
        {checked && <CheckIcon />}
      </div>
      {label}
    </button>
  );
}
