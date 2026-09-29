/** Take-profit / stop-loss price and PnL helpers. Prices and size are human. */

export function gainPct(entry: number, target: number, isLong: boolean): number {
  if (!(entry > 0)) return 0;
  return isLong ? ((target - entry) / entry) * 100 : ((entry - target) / entry) * 100;
}

export function pnlUsd(entry: number, target: number, size: number, isLong: boolean): number {
  return (isLong ? target - entry : entry - target) * size;
}

/** ROE% versus isolated margin (notional / leverage). */
export function roePct(pnl: number, notional: number, leverage: number): number {
  const margin = leverage > 0 ? notional / leverage : 0;
  if (!(margin > 0)) return 0;
  return (pnl / margin) * 100;
}

export function priceFromPct(entry: number, pct: number, isLong: boolean, takeProfit: boolean): number {
  if (!(entry > 0)) return 0;
  const signed = takeProfit ? pct : -pct;
  return isLong ? entry * (1 + signed / 100) : entry * (1 - signed / 100);
}

export function priceFromPnl(
  entry: number,
  pnlAbs: number,
  size: number,
  isLong: boolean,
  takeProfit: boolean,
): number {
  if (!(entry > 0) || !(size > 0)) return 0;
  const dir = (isLong ? 1 : -1) * (takeProfit ? 1 : -1);
  return entry + (pnlAbs / size) * dir;
}

export function validateTpSl(args: {
  isLong: boolean;
  entry: number;
  tp?: number;
  sl?: number;
  liq?: number;
}): string | null {
  const { isLong, entry, tp, sl, liq } = args;
  if (!(entry > 0)) return "Waiting for a price";
  if (tp && tp > 0) {
    if (isLong && tp <= entry) return "Take profit must be above entry for a long";
    if (!isLong && tp >= entry) return "Take profit must be below entry for a short";
  }
  if (sl && sl > 0) {
    if (isLong && sl >= entry) return "Stop loss must be below entry for a long";
    if (!isLong && sl <= entry) return "Stop loss must be above entry for a short";
    if (liq && liq > 0) {
      if (isLong && sl <= liq) return "Stop loss is at or below liquidation";
      if (!isLong && sl >= liq) return "Stop loss is at or above liquidation";
    }
  }
  return null;
}
