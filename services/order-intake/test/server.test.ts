import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createServer } from "../src/server.ts";
import { createLogger } from "../../kit/src/logger.ts";
import { createAlerter } from "../../kit/src/alerter.ts";

// A fake connection/prisma is fine here: these tests only exercise the
// request-shape handling (routing, body limits, JSON parsing, rate limiting)
// that runs before any chain or DB call. The signed-order happy path is
// covered end to end by test/validate.test.ts and test/delegate.test.ts.
function fakeDeps() {
  return {
    connection: {} as never,
    prisma: {} as never,
    idl: {} as never,
    programId: {} as never,
    domain: new Uint8Array(32),
    logger: createLogger("test", { out: { write: () => {} }, env: {} }),
    alerter: createAlerter({ service: "test", logger: createLogger("test", { out: { write: () => {} }, env: {} }) }),
  };
}

async function withServer<T>(fn: (base: string) => Promise<T>): Promise<T> {
  const server = createServer(fakeDeps());
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

test("GET /health returns ok", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  });
});

test("unknown routes 404", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/nope`);
    assert.equal(res.status, 404);
  });
});

test("POST /orders rejects invalid JSON with 400, not a crash", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/orders`, { method: "POST", body: "{ not json", headers: { "content-type": "application/json" } });
    assert.equal(res.status, 400);
  });
});

test("POST /orders rejects a structurally invalid order before touching chain or DB", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/orders`, { method: "POST", body: JSON.stringify({ owner: "not-a-pubkey" }), headers: { "content-type": "application/json" } });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { ok: boolean; error: string };
    assert.equal(body.ok, false);
  });
});

test("POST /orders enforces the per-(owner, ip) rate limit", async () => {
  await withServer(async (base) => {
    const body = JSON.stringify({ owner: "rate-limit-test-owner" });
    let last: Response | undefined;
    for (let i = 0; i < 31; i++) {
      last = await fetch(`${base}/orders`, { method: "POST", body, headers: { "content-type": "application/json" } });
    }
    assert.equal(last?.status, 429);
  });
});

test("oversized body is rejected with 413", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/orders`, { method: "POST", body: "x".repeat(9000), headers: { "content-type": "application/json" } });
    assert.equal(res.status, 413);
  });
});
