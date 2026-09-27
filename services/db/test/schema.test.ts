/**
 * Integration test against a real Postgres (docker compose locally; a
 * `postgres:16` service container in CI). Skips instead of failing when no
 * `DATABASE_URL` is set, so `yarn test` stays usable on a machine without
 * Docker running — but CI always sets it, so the schema is never merged
 * unverified against a real database.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";

const DATABASE_URL = process.env.DATABASE_URL;

test("Prisma schema round-trips through a real Postgres", { skip: !DATABASE_URL && "set DATABASE_URL (see docker-compose.yml) to run this" }, async () => {
  const prisma = new PrismaClient();
  const network = `test-${Date.now()}`;
  try {
    // SlotCursor: the L3 replacement for LedgerCursor.
    await prisma.slotCursor.create({
      data: { id: `${network}-cursor`, network, programId: "11111111111111111111111111111111", slot: 100n, cursor: "sig-abc" },
    });
    const cursor = await prisma.slotCursor.findUniqueOrThrow({ where: { network_programId: { network, programId: "11111111111111111111111111111111" } } });
    assert.equal(cursor.slot, 100n);

    // Market + Account + Order + Fill, exercising base58-shaped addresses and the unique constraints.
    await prisma.market.create({
      data: { id: 1, symbol: `SOL-PERP-${network}`, settlementMint: "BL4DqDDg5uerF11E4PafA43Vj7MVfy25xy9wwyXeMCqd" },
    });
    const owner = "71Wd3Sut366NSg71bYMNdSKsjRZ2pHDV6j6GyLFKt4eJ";
    await prisma.account.create({ data: { address: owner } });
    await prisma.order.create({
      data: {
        id: `${network}-order-1`,
        owner,
        subId: 0,
        marketId: 1,
        isLong: true,
        size: "1000000000",
        limitPrice: "150000000000",
        reduceOnly: false,
        nonce: 1n,
        expiryTs: 9999999999n,
      },
    });
    // Same owner+nonce but a different sub-account is a different order —
    // the unique constraint is (owner, subId, nonce), not (owner, nonce).
    await prisma.order.create({
      data: {
        id: `${network}-order-1-sub1`,
        owner,
        subId: 1,
        marketId: 1,
        isLong: true,
        size: "2000000000",
        limitPrice: "150000000000",
        reduceOnly: false,
        nonce: 1n,
        expiryTs: 9999999999n,
      },
    });

    const taker = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
    await prisma.account.create({ data: { address: taker } });
    await prisma.fill.create({
      data: {
        network,
        marketId: 1,
        maker: owner,
        makerNonce: 1n,
        taker,
        takerNonce: 1n,
        fillSize: "1000000000",
        fillPrice: "150000000000",
        signature: "5" + "a".repeat(87),
        slot: 200n,
      },
    });

    // TxJob carries signature + slot (11: "TxJob with signature + slot"), unlike the Stellar XDR job.
    const job = await prisma.txJob.create({
      data: { network, kind: "settle_fills", payloadHash: "deadbeef", status: "SUBMITTED", signature: "5" + "b".repeat(87) },
    });
    await prisma.txJob.update({ where: { id: job.id }, data: { status: "CONFIRMED", slot: 201n } });
    const confirmed = await prisma.txJob.findUniqueOrThrow({ where: { id: job.id } });
    assert.equal(confirmed.status, "CONFIRMED");
    assert.equal(confirmed.slot, 201n);

    // The dead Position model must not exist at all (11 L13).
    assert.ok(!("position" in prisma), "Position model must not exist on the Prisma client (11 L13)");
  } finally {
    // Clean up in FK-safe order.
    await prisma.fill.deleteMany({ where: { network } });
    await prisma.txJob.deleteMany({ where: { network } });
    await prisma.order.deleteMany({ where: { id: { in: [`${network}-order-1`, `${network}-order-1-sub1`] } } });
    await prisma.account.deleteMany({
      where: { address: { in: ["71Wd3Sut366NSg71bYMNdSKsjRZ2pHDV6j6GyLFKt4eJ", "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin"] } },
    });
    await prisma.market.deleteMany({ where: { id: 1 } });
    await prisma.slotCursor.deleteMany({ where: { network } });
    await prisma.$disconnect();
  }
});
