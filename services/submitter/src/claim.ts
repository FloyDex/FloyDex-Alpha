/**
 * Claims `QUEUED` `TxJob` rows for one market with `SELECT ... FOR UPDATE
 * SKIP LOCKED` inside a transaction, then marks them `SUBMITTED` in the same
 * transaction before returning — so two submitter workers (this process or
 * another) can never claim the same job, and a job that's claimed is never
 * left in a state a second poll would pick up again while this worker is
 * still building its transaction.
 *
 * `FOR UPDATE SKIP LOCKED` (not `FOR UPDATE` alone) is the point: a worker
 * that's slow on one market must never block every other worker's claim on
 * the same rows — it just skips whatever's already locked.
 */
import type { Prisma, PrismaClient } from "@floydex/db";
import type { StoredFillPayload } from "./message.ts";

export interface ClaimedJob {
  id: bigint;
  marketId: number;
  payload: StoredFillPayload;
  attempts: number;
}

interface RawJobRow {
  id: bigint;
  payload: unknown;
  attempts: number;
}

/**
 * Claims up to `limit` `QUEUED` jobs of kind `settle_fill` for `marketId`,
 * oldest first, marking them `SUBMITTED` (attempts + 1) atomically. Returns
 * them ordered the same way they were claimed.
 */
export async function claimSettleFillJobs(prisma: PrismaClient, network: string, marketId: number, limit: number): Promise<ClaimedJob[]> {
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const rows = await tx.$queryRaw<RawJobRow[]>`
      SELECT id, payload, attempts FROM "TxJob"
      WHERE network = ${network}
        AND kind = 'settle_fill'
        AND status = 'QUEUED'
        AND "nextAttemptAt" <= NOW()
        AND (payload->>'marketId')::int = ${marketId}
      ORDER BY id ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    `;
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    await tx.txJob.updateMany({
      where: { id: { in: ids } },
      data: { status: "SUBMITTED", attempts: { increment: 1 } },
    });
    return rows.map((r) => ({
      id: r.id,
      marketId,
      payload: r.payload as StoredFillPayload,
      attempts: r.attempts + 1,
    }));
  });
}

/**
 * Persists the built transaction's signature and expiry (last valid block
 * height) *before* it is sent to the cluster — the idempotency anchor: if
 * the process crashes between this write and the actual `sendTransaction`
 * call, the reconciler can still find the signature and check whether it
 * landed, rather than the job silently vanishing into "SUBMITTED, nobody
 * knows what tx it was."
 */
export async function recordPendingSend(
  prisma: PrismaClient,
  jobIds: bigint[],
  signature: string,
  lastValidBlockHeight: number,
  signedTx: string,
): Promise<void> {
  await prisma.txJob.updateMany({
    where: { id: { in: jobIds } },
    data: { signature, lastValidBlockHeight: BigInt(lastValidBlockHeight), signedTx, lastError: null },
  });
}

/** Marks a job `QUEUED` again (with backoff) after a build/send failure that never reached the cluster — never marks it `FAILED`, since nothing was sent. */
export async function releaseJob(prisma: PrismaClient, jobId: bigint, error: string, backoffMs: number): Promise<void> {
  await prisma.txJob.update({
    where: { id: jobId },
    data: { status: "QUEUED", lastError: error, nextAttemptAt: new Date(Date.now() + backoffMs) },
  });
}
