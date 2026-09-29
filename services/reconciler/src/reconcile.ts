/**
 * The reconciler (roadmap Phase 3 item e): confirms `settle_fill` `TxJob`s
 * by signature/slot, and is the only place that ever clears a job's
 * `queuedSize` reservation — on success by moving it to `filledSize`, on
 * failure/rollback by simply releasing it. Until this existed, a job that
 * failed left `queuedSize` stuck reserved on both its orders forever
 * (flagged in the roadmap when the submitter shipped).
 *
 * Never creates a `Fill` row for anything but a genuinely confirmed
 * transaction — `Fill.signature`/`Fill.slot` are required columns, so a
 * job that never lands has no `Fill` to "mark failed"; its `TxJob.status`
 * (`FAILED`) is the failure record instead. `Fill.feeMaker`/`feeTaker`
 * default to `"0"` here (2026-09-27): the reconciler knows a fill happened
 * from the job's own payload, but not the exact fee the program actually
 * charged — that's the indexer's job (item g, reading the real
 * `FillSettled` event) and is expected to overwrite these once it exists.
 */
import type { Prisma, PrismaClient } from "@floydex/db";
import type { Logger } from "../../kit/src/logger.ts";
import type { StoredFillPayload, StoredOrderArgs } from "../../submitter/src/message.ts";
import { decideRetry, type OrderState } from "./validity.ts";

type Tx = Prisma.TransactionClient;

/** The subset of `Connection` the reconciler needs — kept narrow and interface-typed so tests can fake it without a live cluster. */
export interface ChainStatusSource {
  getSignatureStatuses(signatures: string[]): Promise<{ value: ({ slot: number; err: unknown | null } | null)[] }>;
  getBlockHeight(): Promise<number>;
}

export interface ReconcilerDeps {
  prisma: PrismaClient;
  chain: ChainStatusSource;
  network: string;
  maxAttempts: number;
  logger: Logger;
}

interface RawJobRow {
  id: bigint;
  payload: unknown;
  signature: string;
  lastValidBlockHeight: bigint | null;
  attempts: number;
}

async function loadOrderState(tx: Tx, o: StoredOrderArgs): Promise<OrderState | null> {
  const row = await tx.order.findUnique({ where: { owner_subId_nonce: { owner: o.owner, subId: o.subId, nonce: BigInt(o.nonce) } } });
  if (!row) return null;
  return { cancelled: row.cancelled, expiryTs: row.expiryTs, size: BigInt(row.size), filledSize: BigInt(row.filledSize) };
}

async function adjustOrder(tx: Tx, o: StoredOrderArgs, queuedDelta: bigint, filledDelta: bigint): Promise<void> {
  await tx.$executeRaw`
    UPDATE "Order" SET
      "queuedSize" = ("queuedSize"::numeric + ${queuedDelta.toString()}::numeric)::text,
      "filledSize" = ("filledSize"::numeric + ${filledDelta.toString()}::numeric)::text,
      "updatedAt" = NOW()
    WHERE owner = ${o.owner} AND "subId" = ${o.subId} AND nonce = ${BigInt(o.nonce)}
  `;
}

/** Confirms every job in one landed transaction: moves `queuedSize` → `filledSize` on both orders, records the `Fill`, marks the job `CONFIRMED`. */
async function confirmJob(prisma: PrismaClient, network: string, job: RawJobRow, signature: string, slot: number, logger: Logger): Promise<void> {
  const payload = job.payload as StoredFillPayload;
  await prisma.$transaction(async (tx) => {
    const fillSize = BigInt(payload.fillSize);
    await adjustOrder(tx, payload.maker, -fillSize, fillSize);
    await adjustOrder(tx, payload.taker, -fillSize, fillSize);
    await tx.fill.createMany({
      data: [
        {
          network,
          marketId: payload.marketId,
          maker: payload.maker.owner,
          makerSubId: payload.maker.subId,
          makerNonce: BigInt(payload.maker.nonce),
          taker: payload.taker.owner,
          takerSubId: payload.taker.subId,
          takerNonce: BigInt(payload.taker.nonce),
          fillSize: payload.fillSize,
          fillPrice: payload.fillPrice,
          signature,
          slot: BigInt(slot),
        },
      ],
      skipDuplicates: true,
    });
    await tx.txJob.update({ where: { id: job.id }, data: { status: "CONFIRMED", slot: BigInt(slot), lastError: null } });
  });
  logger.info("settle_fill confirmed", { jobId: job.id.toString(), signature, slot, marketId: payload.marketId });
}

/** Rolls a job back: releases its `queuedSize` reservation (never touches `filledSize` — nothing was confirmed) and marks it `FAILED`. */
async function rollbackJob(prisma: PrismaClient, job: RawJobRow, reason: string, logger: Logger): Promise<void> {
  const payload = job.payload as StoredFillPayload;
  await prisma.$transaction(async (tx) => {
    const fillSize = BigInt(payload.fillSize);
    await adjustOrder(tx, payload.maker, -fillSize, 0n);
    await adjustOrder(tx, payload.taker, -fillSize, 0n);
    await tx.txJob.update({ where: { id: job.id }, data: { status: "FAILED", lastError: reason } });
  });
  logger.warn("settle_fill rolled back", { jobId: job.id.toString(), reason });
}

/** Releases a job back to `QUEUED` for the submitter to resend with a fresh blockhash — the reservation stays exactly as it was. */
async function retryJob(prisma: PrismaClient, job: RawJobRow, reason: string): Promise<void> {
  await prisma.txJob.update({
    where: { id: job.id },
    data: { status: "QUEUED", signature: null, lastValidBlockHeight: null, lastError: reason, nextAttemptAt: new Date() },
  });
}

async function handleExpired(deps: ReconcilerDeps, job: RawJobRow): Promise<"retried" | "rolledBack"> {
  const payload = job.payload as StoredFillPayload;
  const [maker, taker] = await deps.prisma.$transaction([
    deps.prisma.order.findUnique({ where: { owner_subId_nonce: { owner: payload.maker.owner, subId: payload.maker.subId, nonce: BigInt(payload.maker.nonce) } } }),
    deps.prisma.order.findUnique({ where: { owner_subId_nonce: { owner: payload.taker.owner, subId: payload.taker.subId, nonce: BigInt(payload.taker.nonce) } } }),
  ]);
  const toState = (r: typeof maker): OrderState | null => (r ? { cancelled: r.cancelled, expiryTs: r.expiryTs, size: BigInt(r.size), filledSize: BigInt(r.filledSize) } : null);
  const decision = decideRetry(
    { maker: toState(maker), taker: toState(taker), attempts: job.attempts, maxAttempts: deps.maxAttempts, nowUnix: BigInt(Math.floor(Date.now() / 1000)) },
    BigInt(payload.fillSize),
  );
  if (decision.retry) {
    await retryJob(deps.prisma, job, "blockhash expired, retrying");
    return "retried";
  }
  await rollbackJob(deps.prisma, job, `blockhash expired and job is no longer valid: ${decision.reason}`, deps.logger);
  return "rolledBack";
}

export interface ReconcileResult {
  confirmed: number;
  rolledBack: number;
  retried: number;
  stillPending: number;
}

/** One reconciliation pass over every `SUBMITTED settle_fill` job with a recorded signature. */
export async function reconcileOnce(deps: ReconcilerDeps): Promise<ReconcileResult> {
  const jobs = await deps.prisma.$queryRaw<RawJobRow[]>`
    SELECT id, payload, signature, "lastValidBlockHeight", attempts FROM "TxJob"
    WHERE network = ${deps.network} AND kind = 'settle_fill' AND status = 'SUBMITTED' AND signature IS NOT NULL
  `;
  const result: ReconcileResult = { confirmed: 0, rolledBack: 0, retried: 0, stillPending: 0 };
  if (jobs.length === 0) return result;

  const bySignature = new Map<string, RawJobRow[]>();
  for (const j of jobs) {
    const arr = bySignature.get(j.signature) ?? [];
    arr.push(j);
    bySignature.set(j.signature, arr);
  }
  const signatures = [...bySignature.keys()];
  const statuses = await deps.chain.getSignatureStatuses(signatures);
  let blockHeight: number | null = null;

  for (let i = 0; i < signatures.length; i++) {
    const signature = signatures[i]!;
    const group = bySignature.get(signature)!;
    const status = statuses.value[i] ?? null;

    if (status) {
      if (status.err === null || status.err === undefined) {
        for (const job of group) {
          await confirmJob(deps.prisma, deps.network, job, signature, status.slot, deps.logger);
          result.confirmed++;
        }
      } else {
        for (const job of group) {
          await rollbackJob(deps.prisma, job, `program error: ${JSON.stringify(status.err)}`, deps.logger);
          result.rolledBack++;
        }
      }
      continue;
    }

    // Not found yet — only act once it's actually expired (never confirmed within its blockhash's validity window).
    blockHeight ??= await deps.chain.getBlockHeight();
    for (const job of group) {
      if (job.lastValidBlockHeight !== null && blockHeight > Number(job.lastValidBlockHeight)) {
        const outcome = await handleExpired(deps, job);
        if (outcome === "retried") result.retried++;
        else result.rolledBack++;
      } else {
        result.stillPending++;
      }
    }
  }
  return result;
}
