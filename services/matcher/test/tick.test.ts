/**
 * Integration test against a real Postgres (docker compose locally; a
 * `postgres:16` service container in CI). Skips instead of failing when no
 * `DATABASE_URL` is set, matching `services/db/test/schema.test.ts`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@kryon/db";
import { createLogger } from "../../kit/src/logger.ts";
import { tickMarket, tick, fillArgsPayload, payloadHash, LOCK_NAMESPACE } from "../src/tick.ts";
import type { MatchResult, RestingOrder } from "../src/engine.ts";

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL && "set DATABASE_URL (see services/db/docker-compose.yml) to run this";

function order(o: Partial<RestingOrder> & { owner: string; isLong: boolean }): RestingOrder {
  return {
    id: o.id ?? `${o.owner}-${o.isLong}-${Math.random()}`,
    owner: o.owner,
    subId: o.subId ?? 0,
    marketId: o.marketId ?? 1,
    isLong: o.isLong,
    size: o.size ?? 1_000_000_000n,
    limitPrice: o.limitPrice ?? 100_000_000_000n,
    reduceOnly: o.reduceOnly ?? false,
    nonce: o.nonce ?? BigInt(Math.floor(Math.random() * 1e9)),
    expiryTs: o.expiryTs ?? 9_999_999_999n,
    filledSize: o.filledSize ?? 0n,
    queuedSize: o.queuedSize ?? 0n,
    createdAt: o.createdAt ?? new Date(),
    signature: o.signature ?? "c2ln",
    signerPubkey: o.signerPubkey ?? "signer",
  };
}

test("fillArgsPayload and payloadHash are stable and change with fillSize", () => {
  const maker = order({ owner: "alice", isLong: true });
  const taker = order({ owner: "bob", isLong: false });
  const match: MatchResult = { maker, taker, fillSize: 500_000_000n, fillPrice: 100_000_000_000n };
  const p1 = fillArgsPayload(match);
  assert.equal(p1.maker.owner, "alice");
  assert.equal(p1.fillSize, "500000000");
  const h1 = payloadHash("devnet", match);
  const h2 = payloadHash("devnet", { ...match, fillSize: 250_000_000n });
  assert.notEqual(h1, h2);
  assert.equal(h1, payloadHash("devnet", match)); // deterministic
});

test(
  "tickMarket queues a TxJob and reserves queuedSize on both orders, idempotently",
  { skip },
  async () => {
    const prisma = new PrismaClient();
    const logger = createLogger("matcher-test", { level: "error" });
    const network = `test-${Date.now()}`;
    const marketId = 900001;
    try {
      await prisma.market.create({ data: { id: marketId, symbol: `TEST-${network}`, settlementMint: "BL4DqDDg5uerF11E4PafA43Vj7MVfy25xy9wwyXeMCqd", active: true, lastOraclePrice: (100n * 10n ** 18n).toString() } });
      const alice = "71Wd3Sut366NSg71bYMNdSKsjRZ2pHDV6j6GyLFKt4eJ";
      const bob = "CbhFXNFcaEbrwftTZ6aG1YBkCLKNsmxqNjhdXxzbco15";
      await prisma.account.createMany({ data: [{ address: alice }, { address: bob }] });
      await prisma.order.create({
        data: { id: `${network}-bid`, owner: alice, subId: 0, marketId, isLong: true, size: "1000000000", limitPrice: "100000000000", reduceOnly: false, nonce: 1n, expiryTs: 9_999_999_999n, signature: "sig", signerPubkey: alice },
      });
      await prisma.order.create({
        data: { id: `${network}-ask`, owner: bob, subId: 0, marketId, isLong: false, size: "1000000000", limitPrice: "100000000000", reduceOnly: false, nonce: 2n, expiryTs: 9_999_999_999n, signature: "sig", signerPubkey: bob },
      });

      const deps = { prisma, network, maxDeviationBps: 1000n, logger };
      const queued = await tickMarket(deps, marketId);
      assert.equal(queued, 1);

      const bidAfter = await prisma.order.findUniqueOrThrow({ where: { id: `${network}-bid` } });
      const askAfter = await prisma.order.findUniqueOrThrow({ where: { id: `${network}-ask` } });
      assert.equal(bidAfter.queuedSize, "1000000000");
      assert.equal(askAfter.queuedSize, "1000000000");

      const jobs = await prisma.txJob.findMany({ where: { network, kind: "settle_fill" } });
      assert.equal(jobs.length, 1);
      assert.equal(jobs[0].status, "QUEUED");

      // A second tick sees size - filledSize - queuedSize == 0 on both sides
      // now, so it must not match (and therefore not re-reserve) again.
      const queuedAgain = await tickMarket(deps, marketId);
      assert.equal(queuedAgain, 0);
      const jobsAfter = await prisma.txJob.findMany({ where: { network, kind: "settle_fill" } });
      assert.equal(jobsAfter.length, 1);
    } finally {
      await prisma.txJob.deleteMany({ where: { network } });
      await prisma.order.deleteMany({ where: { marketId } });
      await prisma.market.deleteMany({ where: { id: marketId } });
      await prisma.account.deleteMany({ where: { address: { in: ["71Wd3Sut366NSg71bYMNdSKsjRZ2pHDV6j6GyLFKt4eJ", "CbhFXNFcaEbrwftTZ6aG1YBkCLKNsmxqNjhdXxzbco15"] } } });
      await prisma.$disconnect();
    }
  },
);

test("tickMarket skips a match whose price falls outside the oracle band", { skip }, async () => {
  const prisma = new PrismaClient();
  const logger = createLogger("matcher-test", { level: "error" });
  const network = `test-band-${Date.now()}`;
  const marketId = 900002;
  try {
    // Oracle at $100 (1e18); resting orders crossed at $200 — 100% away, well outside a 10% band.
    await prisma.market.create({ data: { id: marketId, symbol: `TEST-${network}`, settlementMint: "BL4DqDDg5uerF11E4PafA43Vj7MVfy25xy9wwyXeMCqd", active: true, lastOraclePrice: (100n * 10n ** 18n).toString() } });
    const alice = "71Wd3Sut366NSg71bYMNdSKsjRZ2pHDV6j6GyLFKt4eJ";
    const bob = "CbhFXNFcaEbrwftTZ6aG1YBkCLKNsmxqNjhdXxzbco15";
    await prisma.account.createMany({ data: [{ address: alice }, { address: bob }] });
    await prisma.order.create({ data: { id: `${network}-bid`, owner: alice, subId: 0, marketId, isLong: true, size: "1000000000", limitPrice: "200000000000", reduceOnly: false, nonce: 1n, expiryTs: 9_999_999_999n, signature: "sig", signerPubkey: alice } });
    await prisma.order.create({ data: { id: `${network}-ask`, owner: bob, subId: 0, marketId, isLong: false, size: "1000000000", limitPrice: "200000000000", reduceOnly: false, nonce: 2n, expiryTs: 9_999_999_999n, signature: "sig", signerPubkey: bob } });

    const deps = { prisma, network, maxDeviationBps: 1000n, logger };
    const queued = await tickMarket(deps, marketId);
    assert.equal(queued, 0);
    const jobs = await prisma.txJob.findMany({ where: { network } });
    assert.equal(jobs.length, 0);
  } finally {
    await prisma.txJob.deleteMany({ where: { network } });
    await prisma.order.deleteMany({ where: { marketId } });
    await prisma.market.deleteMany({ where: { id: marketId } });
    await prisma.account.deleteMany({ where: { address: { in: ["71Wd3Sut366NSg71bYMNdSKsjRZ2pHDV6j6GyLFKt4eJ", "CbhFXNFcaEbrwftTZ6aG1YBkCLKNsmxqNjhdXxzbco15"] } } });
    await prisma.$disconnect();
  }
});

test("tick() skips (returns null contribution) a market another instance already holds the lock on", { skip }, async () => {
  const prisma = new PrismaClient();
  const other = new PrismaClient();
  const logger = createLogger("matcher-test", { level: "error" });
  const network = `test-lock-${Date.now()}`;
  const marketId = 900003;
  try {
    await prisma.market.create({ data: { id: marketId, symbol: `TEST-${network}`, settlementMint: "BL4DqDDg5uerF11E4PafA43Vj7MVfy25xy9wwyXeMCqd", active: true } });
    // Hold the same advisory lock this market's tick would take, on a second connection.
    await other.$executeRaw`SELECT pg_advisory_lock(${LOCK_NAMESPACE}, ${marketId})`;
    try {
      const deps = { prisma, network, maxDeviationBps: 1000n, logger };
      const total = await tick(deps, [marketId]);
      assert.equal(total, 0); // locked elsewhere -> tickMarket returned null -> contributes 0, not an error
    } finally {
      await other.$executeRaw`SELECT pg_advisory_unlock(${LOCK_NAMESPACE}, ${marketId})`;
    }
  } finally {
    await prisma.market.deleteMany({ where: { id: marketId } });
    await prisma.$disconnect();
    await other.$disconnect();
  }
});
