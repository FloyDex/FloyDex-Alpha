/**
 * Integration test against a real Postgres (docker compose locally; a
 * `postgres:16` service container in CI). Skips instead of failing when no
 * `DATABASE_URL` is set, matching `services/matcher/test/tick.test.ts`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@kryon/db";
import { claimSettleFillJobs, recordPendingSend, releaseJob } from "../src/claim.ts";

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL && "set DATABASE_URL (see services/db/docker-compose.yml) to run this";

function payload(marketId: number, tag: string) {
  return {
    marketId,
    maker: { owner: `maker-${tag}`, subId: 0, marketId, flags: 1, size: "1000000000", limitPrice: "100000000000", nonce: "1", expiryTs: "9999999999", signature: "c2ln", signerPubkey: "sig" },
    taker: { owner: `taker-${tag}`, subId: 0, marketId, flags: 0, size: "1000000000", limitPrice: "100000000000", nonce: "1", expiryTs: "9999999999", signature: "c2ln", signerPubkey: "sig" },
    fillSize: "500000000",
    fillPrice: "100000000000",
  };
}

test(
  "claimSettleFillJobs claims only QUEUED jobs for the given market, marks them SUBMITTED, and never double-claims (SKIP LOCKED under concurrency)",
  { skip },
  async () => {
    const prisma = new PrismaClient();
    const network = `submitter-test-${Date.now()}`;
    const marketId = 900101;
    try {
      const a = await prisma.txJob.create({ data: { network, kind: "settle_fill", payloadHash: `${network}-a`, payload: payload(marketId, "a") } });
      const b = await prisma.txJob.create({ data: { network, kind: "settle_fill", payloadHash: `${network}-b`, payload: payload(marketId, "b") } });
      // A job for a different market must never be claimed here.
      await prisma.txJob.create({ data: { network, kind: "settle_fill", payloadHash: `${network}-c`, payload: payload(900102, "c") } });

      const claimed = await claimSettleFillJobs(prisma, network, marketId, 10);
      assert.equal(claimed.length, 2);
      assert.deepEqual(claimed.map((j) => j.id.toString()).sort(), [a.id.toString(), b.id.toString()].sort());

      const rows = await prisma.txJob.findMany({ where: { id: { in: [a.id, b.id] } } });
      assert.ok(rows.every((r) => r.status === "SUBMITTED"));
      assert.ok(rows.every((r) => r.attempts === 1));

      // Already SUBMITTED — a second claim (simulating a concurrent worker) finds nothing.
      const secondClaim = await claimSettleFillJobs(prisma, network, marketId, 10);
      assert.equal(secondClaim.length, 0);
    } finally {
      await prisma.txJob.deleteMany({ where: { network } });
      await prisma.$disconnect();
    }
  },
);

test(
  "recordPendingSend persists signature and lastValidBlockHeight before any send is assumed to have happened",
  { skip },
  async () => {
    const prisma = new PrismaClient();
    const network = `submitter-test-${Date.now()}`;
    try {
      const job = await prisma.txJob.create({ data: { network, kind: "settle_fill", payloadHash: `${network}-x`, payload: payload(1, "x"), status: "SUBMITTED" } });
      await recordPendingSend(prisma, [job.id], "5sigBase58Placeholder", 12345, "base64tx");
      const row = await prisma.txJob.findUniqueOrThrow({ where: { id: job.id } });
      assert.equal(row.signature, "5sigBase58Placeholder");
      assert.equal(row.lastValidBlockHeight?.toString(), "12345");
      assert.equal(row.signedTx, "base64tx");
    } finally {
      await prisma.txJob.deleteMany({ where: { network } });
      await prisma.$disconnect();
    }
  },
);

test(
  "releaseJob puts a claimed job back to QUEUED with backoff and a recorded error, never FAILED (nothing was actually sent)",
  { skip },
  async () => {
    const prisma = new PrismaClient();
    const network = `submitter-test-${Date.now()}`;
    try {
      const job = await prisma.txJob.create({ data: { network, kind: "settle_fill", payloadHash: `${network}-y`, payload: payload(1, "y"), status: "SUBMITTED" } });
      const before = Date.now();
      await releaseJob(prisma, job.id, "simulated build failure", 5_000);
      const row = await prisma.txJob.findUniqueOrThrow({ where: { id: job.id } });
      assert.equal(row.status, "QUEUED");
      assert.equal(row.lastError, "simulated build failure");
      assert.ok(row.nextAttemptAt.getTime() >= before + 4_000);
    } finally {
      await prisma.txJob.deleteMany({ where: { network } });
      await prisma.$disconnect();
    }
  },
);
