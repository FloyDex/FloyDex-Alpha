/**
 * Off-chain CLOB matching engine: price-time priority, ported from
 * `reference/stellar/offchain/scripts/matcher-service.ts` (`lib/market/matcher.ts`
 * in that tree is browser-side order submission, not the matching algorithm —
 * this file is the actual port). Pure function, no I/O: `tick.ts` owns
 * loading orders and persisting the result. Never call anything that submits
 * a transaction from in here (`11` L4: matching and settlement submission
 * must stay separate, or the ceiling becomes one settle per match-tick).
 *
 * Differences from the Stellar version, logged per CLAUDE.md:
 *
 * 2026-09-27: self-trade prevention compares (owner, subId) pairs, not owner
 * alone. On-chain `settle_fills` checks `maker_ai.key() != taker_ai.key()`
 * where those are UserAccount PDAs keyed by (owner, sub_id) (`05` line 257)
 * — two sub-accounts of the same wallet are distinct trading identities and
 * are allowed to trade with each other on-chain, so the off-chain engine
 * must allow it too rather than being stricter than the program.
 *
 * 2026-09-27: "remaining size" subtracts `queuedSize` (size already reserved
 * by an outstanding, not-yet-confirmed settlement job) as well as
 * `filledSize`, so a fill queued this tick is never matched again next tick
 * before the reconciler (item e) confirms or rolls it back.
 */

export interface RestingOrder {
  id: string;
  owner: string;
  subId: number;
  marketId: number;
  isLong: boolean;
  size: bigint; // 1e9
  limitPrice: bigint; // 1e9; 0 = market order
  reduceOnly: boolean;
  nonce: bigint;
  expiryTs: bigint;
  filledSize: bigint; // 1e9, confirmed on-chain (from the indexer)
  queuedSize: bigint; // 1e9, reserved by QUEUED/SUBMITTED settlement jobs
  createdAt: Date;
  /** Base64 signature over the 108-byte order message; null means not yet signed. */
  signature: string | null;
  /** The pubkey (owner or an active delegate) that produced `signature`. */
  signerPubkey: string | null;
}

export interface MatchResult {
  maker: RestingOrder;
  taker: RestingOrder;
  fillSize: bigint;
  fillPrice: bigint;
}

function sameAccount(a: RestingOrder, b: RestingOrder): boolean {
  return a.owner === b.owner && a.subId === b.subId;
}

/**
 * Single-pass matching engine supporting both limit and market orders.
 *
 * Pass 1 – market orders vs resting limit orders. Market orders are always
 *   taker; fill price is the resting limit order's price. Market buys hit
 *   the cheapest available ask, market sells hit the highest available bid.
 * Pass 2 – limit vs limit, price-time priority (unchanged from Stellar).
 *
 * A shared `pendingFills` map carries partial-fill accounting across both
 * passes so the same liquidity is never consumed twice in one tick.
 */
export function matchAll(limitOrders: RestingOrder[], marketOrders: RestingOrder[]): MatchResult[] {
  const pendingFills = new Map<string, bigint>();
  const results: MatchResult[] = [];

  const remaining = (o: RestingOrder) => o.size - o.filledSize - o.queuedSize - (pendingFills.get(o.id) ?? 0n);

  const add = (id: string, delta: bigint) => pendingFills.set(id, (pendingFills.get(id) ?? 0n) + delta);

  const limitBids = limitOrders
    .filter((o) => o.isLong)
    .sort((a, b) => Number(b.limitPrice - a.limitPrice) || a.createdAt.getTime() - b.createdAt.getTime());

  const limitAsks = limitOrders
    .filter((o) => !o.isLong)
    .sort((a, b) => Number(a.limitPrice - b.limitPrice) || a.createdAt.getTime() - b.createdAt.getTime());

  // ── Pass 1: market orders vs limit resting book ──────────────────────────

  // Market SELLS → hit best bids (highest first)
  for (const mo of marketOrders.filter((o) => !o.isLong)) {
    for (const bid of limitBids) {
      if (sameAccount(bid, mo)) continue;
      const bidRem = remaining(bid);
      const moRem = remaining(mo);
      if (bidRem <= 0n || moRem <= 0n) continue;
      const fillSize = bidRem < moRem ? bidRem : moRem;
      add(bid.id, fillSize);
      add(mo.id, fillSize);
      results.push({ maker: bid, taker: mo, fillSize, fillPrice: bid.limitPrice });
      if (remaining(mo) <= 0n) break;
    }
  }

  // Market BUYS → hit best asks (lowest first)
  for (const mo of marketOrders.filter((o) => o.isLong)) {
    for (const ask of limitAsks) {
      if (sameAccount(ask, mo)) continue;
      const askRem = remaining(ask);
      const moRem = remaining(mo);
      if (askRem <= 0n || moRem <= 0n) continue;
      const fillSize = askRem < moRem ? askRem : moRem;
      add(ask.id, fillSize);
      add(mo.id, fillSize);
      results.push({ maker: ask, taker: mo, fillSize, fillPrice: ask.limitPrice });
      if (remaining(mo) <= 0n) break;
    }
  }

  // ── Pass 2: limit vs limit (price-time priority) ──────────────────────────

  for (const bid of limitBids) {
    for (const ask of limitAsks) {
      if (sameAccount(bid, ask)) continue;
      if (bid.limitPrice < ask.limitPrice) break;
      const bidRem = remaining(bid);
      const askRem = remaining(ask);
      if (bidRem <= 0n || askRem <= 0n) continue;
      const fillSize = bidRem < askRem ? bidRem : askRem;
      const makerFirst = bid.createdAt <= ask.createdAt;
      const maker = makerFirst ? bid : ask;
      const taker = makerFirst ? ask : bid;
      add(bid.id, fillSize);
      add(ask.id, fillSize);
      results.push({ maker, taker, fillSize, fillPrice: maker.limitPrice });
      if (remaining(bid) <= 0n) break;
    }
  }

  return results;
}

/** `oracle - MAX_DEVIATION_BPS <= price <= oracle + MAX_DEVIATION_BPS`, 1e18-scale bps math done in i128-safe bigint. */
export function withinOracleBand(price: bigint, oracle: bigint, maxDeviationBps: bigint): boolean {
  const delta = (oracle * maxDeviationBps) / 10_000n;
  return price >= oracle - delta && price <= oracle + delta;
}
