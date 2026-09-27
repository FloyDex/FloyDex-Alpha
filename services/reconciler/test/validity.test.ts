import { test } from "node:test";
import assert from "node:assert/strict";
import { decideRetry, type OrderState } from "../src/validity.ts";

const NOW = 1_800_000_000n;

function order(overrides: Partial<OrderState> = {}): OrderState {
  return { cancelled: false, expiryTs: NOW + 1000n, size: 1_000_000_000n, filledSize: 0n, ...overrides };
}

test("retries when both orders are still valid and under the attempt cap", () => {
  const d = decideRetry({ maker: order(), taker: order(), attempts: 1, maxAttempts: 5, nowUnix: NOW }, 500_000_000n);
  assert.deepEqual(d, { retry: true });
});

test("rolls back once attempts reach the cap, even with otherwise-valid orders", () => {
  const d = decideRetry({ maker: order(), taker: order(), attempts: 5, maxAttempts: 5, nowUnix: NOW }, 500_000_000n);
  assert.equal(d.retry, false);
  assert.match((d as { reason: string }).reason, /max attempts/);
});

test("rolls back when the maker order was cancelled since queueing", () => {
  const d = decideRetry({ maker: order({ cancelled: true }), taker: order(), attempts: 1, maxAttempts: 5, nowUnix: NOW }, 500_000_000n);
  assert.equal(d.retry, false);
  assert.match((d as { reason: string }).reason, /maker order was cancelled/);
});

test("rolls back when the taker order has expired", () => {
  const d = decideRetry({ maker: order(), taker: order({ expiryTs: NOW - 1n }), attempts: 1, maxAttempts: 5, nowUnix: NOW }, 500_000_000n);
  assert.equal(d.retry, false);
  assert.match((d as { reason: string }).reason, /taker order expired/);
});

test("rolls back when settling the fill would overfill an order (its filledSize already moved since queueing, e.g. from another job)", () => {
  const d = decideRetry({ maker: order({ filledSize: 900_000_000n }), taker: order(), attempts: 1, maxAttempts: 5, nowUnix: NOW }, 500_000_000n);
  assert.equal(d.retry, false);
  assert.match((d as { reason: string }).reason, /overfill/);
});

test("rolls back when either order row is missing entirely", () => {
  assert.equal(decideRetry({ maker: null, taker: order(), attempts: 1, maxAttempts: 5, nowUnix: NOW }, 1n).retry, false);
  assert.equal(decideRetry({ maker: order(), taker: null, attempts: 1, maxAttempts: 5, nowUnix: NOW }, 1n).retry, false);
});

test("an order exactly at its expiry boundary (now == expiryTs) is still valid", () => {
  const d = decideRetry({ maker: order({ expiryTs: NOW }), taker: order(), attempts: 1, maxAttempts: 5, nowUnix: NOW }, 500_000_000n);
  assert.deepEqual(d, { retry: true });
});

test("filling exactly to the order's size is not an overfill", () => {
  const d = decideRetry({ maker: order({ filledSize: 500_000_000n, size: 1_000_000_000n }), taker: order(), attempts: 1, maxAttempts: 5, nowUnix: NOW }, 500_000_000n);
  assert.deepEqual(d, { retry: true });
});
