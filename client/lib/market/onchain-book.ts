import { MARKETS, AMOUNT_PRECISION, PRICE_PRECISION } from "@/config";
import type { OrderBook, OrderBookLevel, RecentTrade } from "@/lib/market/matcher";
import { fetchMarkUsd } from "./marks";

/** Matches the on-chain `MarketBook` owner slot used for desk quotes. */
export const DESK_MM = "11111111111111111111111111111111";

export interface RestingOrder {
  owner: string;
  marketId: number;
  isLong: boolean;
  price: number;
  size: number;
  nonce: string;
  expiryTs: number;
  reduceOnly: boolean;
  /** Immediate-or-cancel — never leave a residual on the book (market orders). */
  ioc?: boolean;
}

export interface BookFill {
  price: number;
  size: number;
  takerIsLong: boolean;
  maker: string;
  taker: string;
  makerNonce: string;
  takerNonce: string;
  timestamp: number;
}

interface MarketBookState {
  bids: RestingOrder[];
  asks: RestingOrder[];
  trades: RecentTrade[];
  seq: number;
  lastSeedMid: number;
  lastTickAt: number;
}

const DEPTH = 16;
const BPS = [2, 5, 10, 18, 30, 50, 80, 130];
const NOTIONAL = [180, 280, 420, 650, 950, 1_400, 2_000, 2_800];

function emptyBook(): MarketBookState {
  return { bids: [], asks: [], trades: [], seq: 0, lastSeedMid: 0, lastTickAt: 0 };
}

function store(): Map<number, MarketBookState> {
  const g = globalThis as typeof globalThis & { __floydexBooks?: Map<number, MarketBookState> };
  if (!g.__floydexBooks) g.__floydexBooks = new Map();
  return g.__floydexBooks;
}

export function resetBooksForTests(): void {
  store().clear();
}

function bookOf(marketId: number): MarketBookState {
  const books = store();
  let b = books.get(marketId);
  if (!b) {
    b = emptyBook();
    books.set(marketId, b);
  }
  return b;
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function compact(side: RestingOrder[]): RestingOrder[] {
  const now = nowSec();
  return side.filter((o) => o.size > 0 && (o.expiryTs === 0 || o.expiryTs > now));
}

function insertSorted(side: RestingOrder[], order: RestingOrder, desc: boolean): RestingOrder[] {
  const next = [...side, order];
  next.sort((a, b) => {
    const cmp = desc ? b.price - a.price : a.price - b.price;
    if (cmp !== 0) return cmp;
    return Number(a.nonce) - Number(b.nonce);
  });
  return next.slice(0, DEPTH);
}

function marketCfg(marketId: number) {
  return Object.values(MARKETS).find((m) => m.marketId === marketId);
}

function decimals(marketId: number): number {
  return Math.max(4, marketCfg(marketId)?.priceDecimals ?? 4);
}

function aggregate(orders: RestingOrder[], desc: boolean, dp: number): OrderBookLevel[] {
  const map = new Map<string, number>();
  for (const o of orders) {
    const key = o.price.toFixed(dp);
    map.set(key, (map.get(key) ?? 0) + o.size);
  }
  const levels = [...map.entries()].map(([price, size]) => ({
    price,
    size: size.toFixed(4),
  }));
  levels.sort((a, b) =>
    desc ? parseFloat(b.price) - parseFloat(a.price) : parseFloat(a.price) - parseFloat(b.price)
  );
  return levels;
}

export function snapshotBook(marketId: number): OrderBook {
  const b = bookOf(marketId);
  b.bids = compact(b.bids);
  b.asks = compact(b.asks);
  const midHint = b.lastSeedMid || ((b.bids[0]?.price ?? 0) + (b.asks[0]?.price ?? 0)) / 2;
  if (b.trades.length === 0 && midHint > 0) {
    seedTape(b, marketId, midHint, marketCfg(marketId)?.tickSizes[0] ?? 0.0001);
  }
  const dp = decimals(marketId);
  return {
    bids: aggregate(b.bids, true, dp),
    asks: aggregate(b.asks, false, dp),
    timestamp: Date.now(),
  };
}

export function recentBookTrades(marketId: number, limit = 50): RecentTrade[] {
  const b = bookOf(marketId);
  const midHint = b.lastSeedMid || ((b.bids[0]?.price ?? 0) + (b.asks[0]?.price ?? 0)) / 2;
  if (b.trades.length === 0 && midHint > 0) {
    seedTape(b, marketId, midHint, marketCfg(marketId)?.tickSizes[0] ?? 0.0001);
  }
  return b.trades.slice(0, limit);
}

export function placeOnBook(order: RestingOrder): { book: OrderBook; fills: BookFill[] } {
  const b = bookOf(order.marketId);
  b.bids = compact(b.bids);
  b.asks = compact(b.asks);

  const fills: BookFill[] = [];
  let remaining = order.size;
  const opposite = order.isLong ? b.asks : b.bids;
  const crosses = (makerPx: number) =>
    order.isLong ? makerPx <= order.price : makerPx >= order.price;

  let i = 0;
  while (remaining > 1e-12 && i < opposite.length) {
    const maker = opposite[i];
    if (!crosses(maker.price)) break;
    if (maker.owner === order.owner) {
      i += 1;
      continue;
    }
    const qty = Math.min(remaining, maker.size);
    fills.push({
      price: maker.price,
      size: qty,
      takerIsLong: order.isLong,
      maker: maker.owner,
      taker: order.owner,
      makerNonce: maker.nonce,
      takerNonce: order.nonce,
      timestamp: Date.now(),
    });
    b.trades.unshift({
      price: maker.price.toFixed(decimals(order.marketId)),
      size: qty.toFixed(4),
      side: order.isLong ? "buy" : "sell",
      timestamp: Date.now(),
    });
    b.trades = b.trades.slice(0, 100);
    maker.size -= qty;
    remaining -= qty;
    if (maker.size <= 1e-12) {
      opposite.splice(i, 1);
    } else {
      i += 1;
    }
  }

  if (remaining > 1e-12 && !order.reduceOnly && !order.ioc) {
    const rest = { ...order, size: remaining };
    if (order.isLong) b.bids = insertSorted(b.bids, rest, true);
    else b.asks = insertSorted(b.asks, rest, false);
  }

  b.seq += 1;
  return { book: snapshotBook(order.marketId), fills };
}

export function cancelOnBook(owner: string, nonce: string): boolean {
  let removed = false;
  for (const b of store().values()) {
    const beforeB = b.bids.length;
    const beforeA = b.asks.length;
    b.bids = b.bids.filter((o) => !(o.owner === owner && o.nonce === nonce));
    b.asks = b.asks.filter((o) => !(o.owner === owner && o.nonce === nonce));
    if (b.bids.length !== beforeB || b.asks.length !== beforeA) {
      removed = true;
      b.seq += 1;
    }
  }
  return removed;
}

export function cancelAllOnBook(owner: string, marketId?: number): number {
  let n = 0;
  for (const [id, b] of store()) {
    if (marketId !== undefined && id !== marketId) continue;
    const bidN = b.bids.length;
    const askN = b.asks.length;
    b.bids = b.bids.filter((o) => o.owner !== owner);
    b.asks = b.asks.filter((o) => o.owner !== owner);
    n += bidN - b.bids.length + (askN - b.asks.length);
    b.seq += 1;
  }
  return n;
}

function seedSide(
  marketId: number,
  mid: number,
  isLong: boolean,
  tick: number,
): RestingOrder[] {
  const expiryTs = nowSec() + 7 * 86_400;
  return BPS.map((bps, i) => {
    const raw = isLong ? mid * (1 - bps / 10_000) : mid * (1 + bps / 10_000);
    let price = isLong
      ? Math.floor(raw / tick) * tick
      : Math.ceil(raw / tick) * tick;
    if (isLong && price >= mid) price = mid - tick;
    if (!isLong && price <= mid) price = mid + tick;
    price = Math.max(tick, price);
    const size = NOTIONAL[i] / price;
    return {
      owner: DESK_MM,
      marketId,
      isLong,
      price,
      size,
      nonce: `${isLong ? "b" : "a"}-${marketId}-${i}-${Math.round(price / tick)}`,
      expiryTs,
      reduceOnly: false,
    };
  });
}

/** Quote two-sided desk depth around `mid` when the book is empty or the mid has moved. */
export function seedDeskQuotes(marketId: number, mid: number): void {
  if (!(mid > 0) || !Number.isFinite(mid)) return;
  const b = bookOf(marketId);
  const tick = marketCfg(marketId)?.tickSizes[0] ?? 0.0001;
  const drifted =
    b.lastSeedMid > 0 && Math.abs(mid - b.lastSeedMid) / b.lastSeedMid > 0.004;
  const empty = b.bids.length === 0 && b.asks.length === 0;
  const onlyDesk =
    b.bids.every((o) => o.owner === DESK_MM) && b.asks.every((o) => o.owner === DESK_MM);
  const locked =
    !!b.bids[0] && !!b.asks[0] && b.bids[0].price >= b.asks[0].price;
  if (!empty && !locked && !(drifted && onlyDesk)) {
    seedTape(b, marketId, mid, tick);
    return;
  }

  b.bids = seedSide(marketId, mid, true, tick);
  b.asks = seedSide(marketId, mid, false, tick);
  if (b.bids[0] && b.asks[0] && b.bids[0].price >= b.asks[0].price) {
    b.bids[0].price = Math.max(tick, mid - tick);
    b.asks[0].price = mid + tick;
  }
  seedTape(b, marketId, mid, tick);
  b.lastSeedMid = mid;
  b.seq += 1;
}

function seedTape(b: MarketBookState, marketId: number, mid: number, tick: number) {
  if (b.trades.length > 0) return;
  const dec = decimals(marketId);
  const now = Date.now();
  b.trades = Array.from({ length: 28 }, (_, i) => {
    const buy = i % 3 !== 0;
    const px = mid + (buy ? 1 : -1) * tick * (1 + (i % 6) * 0.35);
    return {
      price: px.toFixed(dec),
      size: (0.08 + (i % 9) * 0.37).toFixed(4),
      side: buy ? "buy" : "sell" as const,
      timestamp: now - i * 2400,
    };
  });
  b.seq += 1;
}

function printTape(b: MarketBookState, marketId: number, price: number, size: number, buy: boolean) {
  const dec = decimals(marketId);
  b.trades.unshift({
    price: price.toFixed(dec),
    size: size.toFixed(4),
    side: buy ? "buy" : "sell",
    timestamp: Date.now(),
  });
  b.trades = b.trades.slice(0, 100);
}

function jitterDeskSizes(orders: RestingOrder[]) {
  for (const o of orders) {
    if (o.owner !== DESK_MM) continue;
    // Mean-reverting twitch — the old 0.86–1.18 walk had a >1 expectation and
    // exploded notionals until size/total painted on top of each other.
    const factor = 0.97 + Math.random() * 0.06;
    const next = o.size * factor;
    const maxSize = o.price > 0 ? 6_000 / o.price : next;
    const minSize = o.price > 0 ? 40 / o.price : next;
    o.size = Math.min(maxSize, Math.max(minSize, next));
  }
}

/** Live MM: walk quotes with the mark, twitch sizes, and print the tape. */
export function pulseBook(marketId: number, mid: number): void {
  if (!(mid > 0) || !Number.isFinite(mid)) return;
  const b = bookOf(marketId);
  const now = Date.now();
  if (now - b.lastTickAt < 550) return;
  b.lastTickAt = now;

  const tick = marketCfg(marketId)?.tickSizes[0] ?? 0.0001;
  seedTape(b, marketId, mid, tick);
  if (b.bids.length === 0 && b.asks.length === 0) {
    seedDeskQuotes(marketId, mid);
    return;
  }

  const deskOnly =
    b.bids.every((o) => o.owner === DESK_MM) && b.asks.every((o) => o.owner === DESK_MM);
  const exploded = [...b.bids, ...b.asks].some(
    (o) => o.owner === DESK_MM && o.price * o.size > 20_000,
  );
  const drifted = b.lastSeedMid > 0 && Math.abs(mid - b.lastSeedMid) / b.lastSeedMid > 0.0008;
  if (deskOnly && (drifted || exploded)) {
    const usersB = b.bids.filter((o) => o.owner !== DESK_MM);
    const usersA = b.asks.filter((o) => o.owner !== DESK_MM);
    b.bids = [...seedSide(marketId, mid, true, tick), ...usersB];
    b.asks = [...seedSide(marketId, mid, false, tick), ...usersA];
    b.bids.sort((x, y) => y.price - x.price);
    b.asks.sort((x, y) => x.price - y.price);
    if (b.bids[0] && b.asks[0] && b.bids[0].price >= b.asks[0].price) {
      b.bids[0].price = Math.max(tick, mid - tick);
      b.asks[0].price = mid + tick;
    }
    b.lastSeedMid = mid;
  } else {
    jitterDeskSizes(b.bids);
    jitterDeskSizes(b.asks);
  }

  if (Math.random() < 0.72) {
    const buy = Math.random() > 0.47;
    const top = buy ? b.asks[0] : b.bids[0];
    const px = top?.price ?? (buy ? mid + tick : mid - tick);
    const qty = top ? Math.min(top.size * (0.08 + Math.random() * 0.22), top.size * 0.35) : 0.1;
    printTape(b, marketId, px, Math.max(qty, tick), buy);
    if (top && top.owner === DESK_MM) {
      top.size = Math.max(top.size * 0.25, top.size - qty);
    }
  }

  b.seq += 1;
}

const FALLBACK_MID: Record<number, number> = {
  1: 0.22,
  2: 65_000,
  3: 3_200,
  4: 150,
  5: 0.55,
  6: 0.45,
  7: 600,
  8: 0.12,
  9: 372,
  10: 180,
  11: 230,
  12: 570,
  13: 580,
  14: 190,
  15: 480,
  16: 420,
  17: 220,
  18: 340,
};

export async function seedFromBinance(marketId: number): Promise<number | null> {
  const mid = await fetchMarkUsd(marketId);
  const px = mid ?? FALLBACK_MID[marketId] ?? null;
  if (!px) return null;
  seedDeskQuotes(marketId, px);
  pulseBook(marketId, px);
  return px;
}

export function intentToResting(o: {
  owner: string;
  marketId: number;
  isLong: boolean;
  size: bigint;
  limitPrice: bigint;
  reduceOnly: boolean;
  nonce: bigint;
  expiryTs: bigint;
  ioc?: boolean;
}): RestingOrder {
  return {
    owner: o.owner,
    marketId: o.marketId,
    isLong: o.isLong,
    price: Number(o.limitPrice) / Number(PRICE_PRECISION),
    size: Number(o.size) / Number(AMOUNT_PRECISION),
    nonce: o.nonce.toString(),
    expiryTs: Number(o.expiryTs),
    reduceOnly: o.reduceOnly,
    ioc: o.ioc,
  };
}
