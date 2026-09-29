/**
 * Integration test against a real Postgres (docker compose locally; a
 * `postgres:16` service container in CI). Skips instead of failing when no
 * `DATABASE_URL` is set, matching `services/matcher/test/tick.test.ts`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@floydex/db";
import { createLogger } from "../../kit/src/logger.ts";
import { reconcileOnce, type ChainStatusSource } from "../src/reconcile.ts";

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL && "set DATABASE_URL (see services/db/docker-compose.yml) to run this";

function fillPayload(marketId: number, maker: string, taker: string, makerNonce = 1, takerNonce = 1) {
  const side = (owner: string, nonce: number, isLong: boolean) => ({
    owner,
    subId: 0,
    marketId,
    flags: isLong ? 1 : 0,
    size: "1000000000",
    limitPrice: "100000000000",
    nonce: String(nonce),
    expiryTs: "9999999999",
    signature: "c2ln",
    signerPubkey: "sig",
  });
  return { marketId, maker: side(maker, makerNonce, true), taker: side(taker, takerNonce, false), fillSize: "500000000", fillPrice: "100000000000" };
}

/** A `ChainStatusSource` fake driven entirely by the test: a signature's status and the current block height are both set by hand. */
function fakeChain(): ChainStatusSource & { statuses: Map<string, { slot: number; err: unknown | null }>; blockHeight: number } {
  const statuses = new Map<string, { slot: number; err: unknown | null }>();
  return {
    statuses,
    blockHeight: 1000,
    async getSignatureStatuses(signatures: string[]) {
      return { value: signatures.map((s) => statuses.get(s) ?? null) };
    },
    async getBlockHeight() {
      return this.blockHeight;
    },
  };
}

async function setupOrder(prisma: PrismaClient, network: string, owner: string, marketId: number, nonce: number, overrides: Partial<{ cancelled: boolean; expiryTs: bigint; size: string; filledSize: string; queuedSize: string }> = {}) {
  await prisma.account.upsert({ where: { address: owner }, create: { address: owner }, update: {} });
  await prisma.order.create({
    data: {
      id: `${owner}-${nonce}`,
      owner,
      marketId,
      isLong: true,
      size: overrides.size ?? "1000000000",
      limitPrice: "100000000000",
      reduceOnly: false,
      nonce: BigInt(nonce),
      expiryTs: overrides.expiryTs ?? 9_999_999_999n,
      cancelled: overrides.cancelled ?? false,
      filledSize: overrides.filledSize ?? "0",
      queuedSize: overrides.queuedSize ?? "500000000",
      signature: "c2ln",
      signerPubkey: "sig",
    },
  });
}

async function withFixture(fn: (prisma: PrismaClient, network: string, marketId: number) => Promise<void>) {
  const prisma = new PrismaClient();
  const network = `reconciler-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const marketId = 900201;
  try {
    await prisma.market.upsert({ where: { id: marketId }, create: { id: marketId, symbol: `TEST-${network}`, settlementMint: "BL4DqDDg5uerF11E4PafA43Vj7MVfy25xy9wwyXeMCqd", active: true }, update: {} });
    await fn(prisma, network, marketId);
  } finally {
    await prisma.fill.deleteMany({ where: { network } });
    await prisma.txJob.deleteMany({ where: { network } });
    await prisma.$disconnect();
  }
}

test("reconcileOnce confirms a landed transaction: queuedSize -> filledSize, a Fill row is created, the job is CONFIRMED", { skip }, async () => {
  await withFixture(async (prisma, network, marketId) => {
    const maker = "maker-confirm";
    const taker = "taker-confirm";
    await setupOrder(prisma, network, maker, marketId, 1);
    await setupOrder(prisma, network, taker, marketId, 1);
    const job = await prisma.txJob.create({
      data: { network, kind: "settle_fill", payloadHash: `${network}-confirm`, payload: fillPayload(marketId, maker, taker), status: "SUBMITTED", signature: "SigConfirm", lastValidBlockHeight: 900n },
    });

    const chain = fakeChain();
    chain.statuses.set("SigConfirm", { slot: 555, err: null });
    const result = await reconcileOnce({ prisma, chain, network, maxAttempts: 5, logger: createLogger("test", { level: "error" }) });
    assert.equal(result.confirmed, 1);

    const [makerRow, takerRow] = await Promise.all([
      prisma.order.findUniqueOrThrow({ where: { owner_subId_nonce: { owner: maker, subId: 0, nonce: 1n } } }),
      prisma.order.findUniqueOrThrow({ where: { owner_subId_nonce: { owner: taker, subId: 0, nonce: 1n } } }),
    ]);
    assert.equal(makerRow.queuedSize, "0");
    assert.equal(makerRow.filledSize, "500000000");
    assert.equal(takerRow.queuedSize, "0");
    assert.equal(takerRow.filledSize, "500000000");

    const txJob = await prisma.txJob.findUniqueOrThrow({ where: { id: job.id } });
    assert.equal(txJob.status, "CONFIRMED");
    assert.equal(txJob.slot?.toString(), "555");

    const fill = await prisma.fill.findFirst({ where: { network, signature: "SigConfirm" } });
    assert.ok(fill);
    assert.equal(fill!.fillSize, "500000000");
  });
});

test("reconcileOnce rolls back on a program error (e.g. OrderOverfilled): queuedSize released, job FAILED, no Fill row", { skip }, async () => {
  await withFixture(async (prisma, network, marketId) => {
    const maker = "maker-progerr";
    const taker = "taker-progerr";
    await setupOrder(prisma, network, maker, marketId, 1);
    await setupOrder(prisma, network, taker, marketId, 1);
    const job = await prisma.txJob.create({
      data: { network, kind: "settle_fill", payloadHash: `${network}-progerr`, payload: fillPayload(marketId, maker, taker), status: "SUBMITTED", signature: "SigProgErr", lastValidBlockHeight: 900n },
    });

    const chain = fakeChain();
    chain.statuses.set("SigProgErr", { slot: 556, err: { InstructionError: [0, { Custom: 6021 }] } }); // OrderOverfilled-shaped
    const result = await reconcileOnce({ prisma, chain, network, maxAttempts: 5, logger: createLogger("test", { level: "error" }) });
    assert.equal(result.rolledBack, 1);

    const makerRow = await prisma.order.findUniqueOrThrow({ where: { owner_subId_nonce: { owner: maker, subId: 0, nonce: 1n } } });
    assert.equal(makerRow.queuedSize, "0");
    assert.equal(makerRow.filledSize, "0");

    const txJob = await prisma.txJob.findUniqueOrThrow({ where: { id: job.id } });
    assert.equal(txJob.status, "FAILED");
    assert.match(txJob.lastError ?? "", /program error/);
    assert.equal(await prisma.fill.count({ where: { network } }), 0);
  });
});

test("reconcileOnce retries an expired-but-still-valid job (covers both blockhash expiry and a crash between send and record: the signature was never actually broadcast, so it never confirms either)", { skip }, async () => {
  await withFixture(async (prisma, network, marketId) => {
    const maker = "maker-retry";
    const taker = "taker-retry";
    await setupOrder(prisma, network, maker, marketId, 1);
    await setupOrder(prisma, network, taker, marketId, 1);
    await prisma.txJob.create({
      data: { network, kind: "settle_fill", payloadHash: `${network}-retry`, payload: fillPayload(marketId, maker, taker), status: "SUBMITTED", signature: "SigNeverLands", lastValidBlockHeight: 900n, attempts: 1 },
    });

    const chain = fakeChain();
    chain.blockHeight = 901; // one past lastValidBlockHeight — expired, and never found by getSignatureStatuses (unset in the map = null).
    const result = await reconcileOnce({ prisma, chain, network, maxAttempts: 5, logger: createLogger("test", { level: "error" }) });
    assert.equal(result.retried, 1);

    const jobs = await prisma.txJob.findMany({ where: { network } });
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]!.status, "QUEUED");
    assert.equal(jobs[0]!.signature, null);
    assert.equal(jobs[0]!.lastValidBlockHeight, null);

    // The reservation must be untouched — it's still legitimately held for the retry.
    const makerRow = await prisma.order.findUniqueOrThrow({ where: { owner_subId_nonce: { owner: maker, subId: 0, nonce: 1n } } });
    assert.equal(makerRow.queuedSize, "500000000");
    assert.equal(makerRow.filledSize, "0");
  });
});

test("reconcileOnce rolls back an expired job once the order was cancelled since queueing, instead of retrying forever", { skip }, async () => {
  await withFixture(async (prisma, network, marketId) => {
    const maker = "maker-expired-cancelled";
    const taker = "taker-expired-cancelled";
    await setupOrder(prisma, network, maker, marketId, 1, { cancelled: true });
    await setupOrder(prisma, network, taker, marketId, 1);
    await prisma.txJob.create({
      data: { network, kind: "settle_fill", payloadHash: `${network}-expired-cancelled`, payload: fillPayload(marketId, maker, taker), status: "SUBMITTED", signature: "SigExpiredCancelled", lastValidBlockHeight: 900n, attempts: 1 },
    });

    const chain = fakeChain();
    chain.blockHeight = 950;
    const result = await reconcileOnce({ prisma, chain, network, maxAttempts: 5, logger: createLogger("test", { level: "error" }) });
    assert.equal(result.rolledBack, 1);

    const makerRow = await prisma.order.findUniqueOrThrow({ where: { owner_subId_nonce: { owner: maker, subId: 0, nonce: 1n } } });
    assert.equal(makerRow.queuedSize, "0"); // released, not stuck
  });
});

test("reconcileOnce leaves a not-yet-expired, unconfirmed job alone (stillPending)", { skip }, async () => {
  await withFixture(async (prisma, network, marketId) => {
    const maker = "maker-pending";
    const taker = "taker-pending";
    await setupOrder(prisma, network, maker, marketId, 1);
    await setupOrder(prisma, network, taker, marketId, 1);
    await prisma.txJob.create({
      data: { network, kind: "settle_fill", payloadHash: `${network}-pending`, payload: fillPayload(marketId, maker, taker), status: "SUBMITTED", signature: "SigPending", lastValidBlockHeight: 900n },
    });

    const chain = fakeChain();
    chain.blockHeight = 899; // still within validity — not expired.
    const result = await reconcileOnce({ prisma, chain, network, maxAttempts: 5, logger: createLogger("test", { level: "error" }) });
    assert.equal(result.stillPending, 1);
    assert.equal(result.confirmed + result.rolledBack + result.retried, 0);

    const txJob = await prisma.txJob.findFirstOrThrow({ where: { network } });
    assert.equal(txJob.status, "SUBMITTED");
  });
});
