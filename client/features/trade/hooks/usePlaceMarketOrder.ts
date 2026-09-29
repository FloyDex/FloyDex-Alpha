"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AMOUNT_PRECISION, ASSETS, PRICE_PRECISION, type MarketConfig } from "@/config";
import { amountToHuman, priceToHuman } from "@/lib/format";
import { buildOrderIntent } from "@/lib/market/order-intent";
import { submitOrder } from "@/lib/market/matcher";
import { aggressiveMarketLimit, baseSizeFromInput, type TicketSizeMode } from "@/lib/market/quick-market";
import { getAccountHealth } from "@/lib/solana/health";
import { getBalance } from "@/lib/solana/vault";
import { useMarketStore } from "@/stores/market";
import { useLocalOrders } from "@/stores/orders";
import { useTradeSettings } from "@/stores/settings";
import { useWalletStore } from "@/stores/wallet";

export function usePlaceMarketOrder(market: MarketConfig) {
  const { address, connected, setWrongNetwork } = useWalletStore();
  const queryClient = useQueryClient();
  const addOrder = useLocalOrders((s) => s.addOrder);
  const rawMarkPrice = useMarketStore((s) => s.markPrices[market.marketId]);
  const book = useMarketStore((s) => s.orderBooks[market.marketId]);
  const ticketLeverage = useTradeSettings((s) => s.ticketLeverage);
  const [loading, setLoading] = useState(false);

  const { data: balance } = useQuery({
    queryKey: ["balance", address],
    queryFn: () => getBalance(address!, ASSETS.usdc),
    enabled: !!address && connected,
    refetchInterval: 10_000,
  });
  const { data: health } = useQuery({
    queryKey: ["health", address],
    queryFn: () => getAccountHealth(address!, ASSETS.usdc),
    enabled: !!address && connected,
    refetchInterval: 10_000,
  });

  const availableToTrade = health?.freeCollateral ?? balance ?? 0n;
  const maxLev = Math.round(market.maxLeverageBps / 10000);
  const leverage = Math.min(Math.max(1, ticketLeverage || 15), maxLev);

  const lastPrice = (() => {
    if (rawMarkPrice && rawMarkPrice > 0n) return priceToHuman(rawMarkPrice);
    if (book?.asks[0] && book?.bids[0]) {
      return (parseFloat(book.asks[0].price) + parseFloat(book.bids[0].price)) / 2;
    }
    return 0;
  })();

  async function place(side: "buy" | "sell", sizeRaw: string, sizeMode: TicketSizeMode) {
    if (!address || !connected) {
      toast.error("Connect your wallet first");
      return false;
    }
    setWrongNetwork(false);
    const sizeNum = parseFloat(sizeRaw) || 0;
    const baseSize = baseSizeFromInput(sizeNum, sizeMode, lastPrice, leverage);
    if (!(baseSize > 0)) {
      toast.error("Enter a valid size");
      return false;
    }
    if (!(lastPrice > 0)) {
      toast.error("Waiting for a market price");
      return false;
    }
    const margin = (baseSize * lastPrice) / leverage;
    const availableHuman = amountToHuman(availableToTrade);
    if (margin > availableHuman) {
      toast.error(
        `Insufficient balance — $${margin.toFixed(2)} required, $${availableHuman.toFixed(2)} available.`,
      );
      return false;
    }

    const mark =
      rawMarkPrice && rawMarkPrice > 0n
        ? rawMarkPrice
        : BigInt(Math.round(lastPrice * Number(PRICE_PRECISION)));

    setLoading(true);
    try {
      const intent = buildOrderIntent({
        owner: address,
        marketId: market.marketId,
        isLong: side === "buy",
        size: BigInt(Math.round(baseSize * Number(AMOUNT_PRECISION))),
        limitPrice: aggressiveMarketLimit(mark, side),
        reduceOnly: false,
        ttlSeconds: 3600,
        leverage,
      });
      const result = await submitOrder(intent, { ioc: true, orderType: "market" });
      if (result.ok) {
        addOrder(intent);
        const filledQty = result.fills?.reduce((s, f) => s + f.size, 0) ?? 0;
        if (filledQty > 0) useLocalOrders.getState().markFilled(intent.nonce, address);
        else useLocalOrders.getState().cancelOrder(intent.nonce, address);
        if (result.book) useMarketStore.getState().setOrderBook(market.marketId, result.book);
        toast.success(
          filledQty > 0 ? `Market ${side} filled` : `Market ${side} — nothing to fill`,
        );
        queryClient.invalidateQueries({ queryKey: ["balance", address] });
        queryClient.invalidateQueries({ queryKey: ["health", address] });
        queryClient.invalidateQueries({ queryKey: ["fills", address] });
        queryClient.invalidateQueries({ queryKey: ["positions", address] });
        return true;
      }
      toast.error(result.error ?? "Order rejected");
      return false;
    } catch (e) {
      toast.error(String(e));
      return false;
    } finally {
      setLoading(false);
    }
  }

  return {
    place,
    loading,
    lastPrice,
    availableHuman: amountToHuman(availableToTrade),
    leverage,
    connected,
  };
}
