/**
 * One matcher tick, per market: single writer via a transaction-scoped
 * Postgres advisory lock (`11` L4 — "single writer per market", so two
 * matcher instances can never process the same market at once and
 * double-reserve the same order's remaining size). Loads resting orders,
 * runs price-time priority matching (`engine.ts`), and enqueues one TxJob
 * per match into the durable settlement queue.
 *
 * Never builds or submits a transaction itself — that's the submitter's job
 * (a separate process reading TxJob), kept apart per L4 so settlement can
 * never happen inside the match tick and the fill-rate ceiling that capped
 * Stellar at ~12-13/min never repeats here.
 *
 * The lock, the order reads, and the TxJob/queuedSize writes all run inside
 * one Prisma interactive transaction — i.e. one physical connection for the
 * whole tick. That matters: `pg_try_advisory_xact_lock` is session-scoped,
 * so acquiring it on one pooled connection and later writing on another
 * (which a naive `$queryRaw` then `$transaction` split risks under Prisma's
 * internal connection pool) would provide no real exclusion at all. The
 * `_xact` variant also auto-releases at COMMIT/ROLLBACK, so there is no
 * separate unlock call to forget on an error path.
 */
import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "@kryon/db";
import type { Logger } from "../../kit/src/logger.ts";
import { matchAll, withinOracleBand, type MatchResult, type RestingOrder } from "./engine.ts";

// Postgres advisory-lock namespace for the matcher ("KRYN" as an int4), so
// its per-market locks never collide with some other subsystem's use of the
// same (int, int) key space. Exported so a test can take the same lock on a
// second connection to exercise the "already locked" skip path.
export const LOCK_NAMESPACE = 0x4b52594e;

export interface TickDeps {
  prisma: PrismaClient;
  network: string;
  /** Off-chain pre-filter band; the on-chain execution-deviation check is authoritative regardless. */
  maxDeviationBps: bigint;
  logger: Logger;
}

type Tx = Prisma.TransactionClient;

interface OrderRow {
  id: string;
  owner: string;
  subId: number;
  marketId: number;
  isLong: boolean;
  size: string;
  limitPrice: string;
  reduceOnly: boolean;
  nonce: bigint;
  expiryTs: bigint;
  filledSize: string;
  queuedSize: string;
  createdAt: Date;
  signature: string | null;
  signerPubkey: string | null;
}

function toResting(o: OrderRow): RestingOrder {
  return {
    id: o.id,
    owner: o.owner,
    subId: o.subId,
    marketId: o.marketId,
    isLong: o.isLong,
    size: BigInt(o.size),
    limitPrice: BigInt(o.limitPrice),
    reduceOnly: o.reduceOnly,
    nonce: o.nonce,
    expiryTs: o.expiryTs,
    filledSize: BigInt(o.filledSize),
    queuedSize: BigInt(o.queuedSize),
    createdAt: o.createdAt,
    signature: o.signature,
    signerPubkey: o.signerPubkey,
  };
}

async function loadOpenOrders(tx: Tx, marketId: number): Promise<RestingOrder[]> {
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const rows = (await tx.order.findMany({
    where: { marketId, cancelled: false, expiryTs: { gt: nowSec }, signature: { not: null }, signerPubkey: { not: null } },
  })) as unknown as OrderRow[];
  return rows.map(toResting).filter((o) => o.size - o.filledSize - o.queuedSize > 0n);
}

/** The `FillArgs`-shaped data (`programs/kryon-perps/src/instructions/settle.rs`) the submitter needs to build the settle_fills instruction. */
export function fillArgsPayload(match: MatchResult) {
  const side = (o: RestingOrder) => ({
    owner: o.owner,
    subId: o.subId,
    marketId: o.marketId,
    flags: (o.isLong ? 1 : 0) | (o.reduceOnly ? 2 : 0),
    size: o.size.toString(),
    limitPrice: o.limitPrice.toString(),
    nonce: o.nonce.toString(),
    expiryTs: o.expiryTs.toString(),
    signature: o.signature,
    signerPubkey: o.signerPubkey,
  });
  return {
    marketId: match.maker.marketId,
    maker: side(match.maker),
    taker: side(match.taker),
    fillSize: match.fillSize.toString(),
    fillPrice: match.fillPrice.toString(),
  };
}

/** Deterministic idempotency key: the same match queued twice (a re-run tick, a retried job) never double-reserves. */
export function payloadHash(network: string, match: MatchResult): string {
  const key = [
    network,
    match.maker.owner,
    match.maker.subId,
    match.maker.nonce.toString(),
    match.taker.owner,
    match.taker.subId,
    match.taker.nonce.toString(),
    match.fillSize.toString(),
    match.fillPrice.toString(),
  ].join(":");
  return createHash("sha256").update(key).digest("hex");
}

/**
 * Enqueues one match: a TxJob row plus the `queuedSize` reservation on both
 * orders, in the same transaction as the caller's lock. Returns false if
 * this exact match was already queued (duplicate tick / retry) — the
 * reservation is then correctly *not* double-counted.
 */
async function enqueueMatch(tx: Tx, network: string, match: MatchResult, logger: Logger): Promise<boolean> {
  const hash = payloadHash(network, match);
  const created = await tx.txJob.createMany({
    data: [{ network, kind: "settle_fill", payloadHash: hash, payload: fillArgsPayload(match) }],
    skipDuplicates: true,
  });
  if (created.count === 0) return false;
  for (const o of [match.maker, match.taker]) {
    await tx.$executeRaw`UPDATE "Order" SET "queuedSize" = ("queuedSize"::numeric + ${match.fillSize.toString()}::numeric)::text, "updatedAt" = NOW() WHERE id = ${o.id}`;
  }
  logger.info("queued settle_fill", {
    marketId: match.maker.marketId,
    maker: match.maker.owner,
    taker: match.taker.owner,
    fillSize: match.fillSize.toString(),
    fillPrice: match.fillPrice.toString(),
  });
  return true;
}

/**
 * Runs one match tick for a single market. Returns the number of matches
 * queued, or `null` if another instance already holds this market's lock
 * (skipped, not blocked — a slow market must never back up every other
 * market's tick).
 */
export async function tickMarket(deps: TickDeps, marketId: number): Promise<number | null> {
  return deps.prisma.$transaction(async (tx) => {
    const lockRows = await tx.$queryRaw<{ locked: boolean }[]>`SELECT pg_try_advisory_xact_lock(${LOCK_NAMESPACE}::int, ${marketId}::int) AS locked`;
    if (!lockRows[0]?.locked) return null;

    const orders = await loadOpenOrders(tx, marketId);
    if (orders.length === 0) return 0;

    const market = await tx.market.findUnique({ where: { id: marketId } });
    const oracle1e18 = market ? BigInt(market.lastOraclePrice) : 0n;
    const oracle = oracle1e18 / 1_000_000_000n; // Market.lastOraclePrice is 1e18; Order prices are 1e9 wire scale.

    const limitOrders = orders.filter((o) => o.limitPrice > 0n);
    const marketOrders = orders.filter((o) => o.limitPrice === 0n);
    // Exclude out-of-band RESTING orders before matching, not just their
    // matches after: price-time priority would otherwise allocate incoming
    // volume to an unsettleable top-of-book quote, starving legitimate orders
    // behind it. They stay in the DB — if the oracle moves to them they
    // become matchable again next tick.
    const inBand = oracle > 0n ? limitOrders.filter((o) => withinOracleBand(o.limitPrice, oracle, deps.maxDeviationBps)) : [];
    if (inBand.length < limitOrders.length) {
      deps.logger.warn("resting order(s) outside oracle band excluded from matching", { marketId, excluded: limitOrders.length - inBand.length });
    }

    const matches = matchAll(inBand, marketOrders);
    let queued = 0;
    for (const match of matches) {
      // Fail closed: no oracle price, or the match itself crossed the band
      // (can happen at the edge between resting-order and fill checks) — the
      // on-chain engine can't accept it either, so don't bother queuing it.
      if (oracle === 0n || !withinOracleBand(match.fillPrice, oracle, deps.maxDeviationBps)) {
        deps.logger.warn("skip match outside oracle band", { marketId, fillPrice: match.fillPrice.toString(), oracle: oracle.toString() });
        continue;
      }
      if (await enqueueMatch(tx, deps.network, match, deps.logger)) queued++;
    }
    return queued;
  });
}

/** Ticks every market in `marketIds`, sequentially — never overlap ticks within one process. */
export async function tick(deps: TickDeps, marketIds: number[]): Promise<number> {
  let total = 0;
  for (const marketId of marketIds) {
    const n = await tickMarket(deps, marketId);
    if (n !== null) total += n;
  }
  return total;
}
