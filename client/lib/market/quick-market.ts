export type TicketSizeMode = "base" | "quote" | "margin";

export function sanitizeQuickSize(val: string): string {
  const cleaned = val.replace(/[^0-9.]/g, "").replace(/^0+(\d)/, "$1");
  const parts = cleaned.split(".");
  return parts.length > 2 ? parts[0] + "." + parts.slice(1).join("") : cleaned;
}

export function nextTicketSizeMode(mode: TicketSizeMode): TicketSizeMode {
  if (mode === "base") return "quote";
  if (mode === "quote") return "margin";
  return "base";
}

/** Convert the ticket input into base-asset size. */
export function baseSizeFromInput(
  size: number,
  mode: TicketSizeMode,
  execPrice: number,
  leverage = 1,
): number {
  if (!(size > 0)) return 0;
  if (mode === "base") return size;
  if (!(execPrice > 0)) return 0;
  if (mode === "quote") return size / execPrice;
  if (!(leverage > 0)) return 0;
  // Margin mode: typed dollars are collateral → notional = margin × leverage.
  return (size * leverage) / execPrice;
}

/** Aggressive limit so on-chain validate_order (limit_price > 0) accepts a market fill. */
export function aggressiveMarketLimit(mark: bigint, side: "buy" | "sell"): bigint {
  if (mark <= 0n) return 1n;
  return side === "buy" ? mark * 2n : mark / 2n || 1n;
}

export function sizeFromBuyingPowerPct(opts: {
  availableHuman: number;
  leverage: number;
  pct: number;
  execPrice: number;
  sizeMode: TicketSizeMode;
}): string {
  const margin = Math.max(0, opts.availableHuman * (opts.pct / 100));
  if (margin <= 0) return "";
  if (opts.sizeMode === "margin") return margin.toFixed(2);
  const notional = margin * Math.max(1, opts.leverage);
  if (opts.sizeMode === "quote") return notional.toFixed(2);
  if (!(opts.execPrice > 0)) return "";
  return (notional / opts.execPrice).toFixed(4);
}
