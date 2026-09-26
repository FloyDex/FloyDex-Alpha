import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decodeOrder, encodeOrder, computeDomain, toWire, ORDER_MSG_LEN, type Order } from "../src/order.ts";

const hex = (s: string) => Uint8Array.from(Buffer.from(s, "hex"));
const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");

const doc = JSON.parse(readFileSync(new URL("../conformance/order-v1.json", import.meta.url), "utf8"));

function fromVector(o: Record<string, string | number>): Order {
  return {
    domain: hex(o.domain as string),
    owner: hex(o.owner as string),
    subId: o.sub_id as number,
    marketId: o.market_id as number,
    flags: o.flags as number,
    size: BigInt(o.size),
    limitPrice: BigInt(o.limit_price),
    nonce: BigInt(o.nonce),
    expiryTs: BigInt(o.expiry_ts),
  };
}

test("spec length", () => {
  assert.equal(doc.length, ORDER_MSG_LEN);
  assert.ok(doc.vectors.length >= 8);
});

for (const v of doc.vectors) {
  test(`golden: ${v.name}`, () => {
    const order = fromVector(v.order);
    assert.equal(toHex(encodeOrder(order)), v.hex);
    assert.deepEqual(decodeOrder(hex(v.hex)), order);
  });
}

for (const d of doc.domains) {
  test(`domain: ${d.name}`, () => {
    assert.equal(toHex(computeDomain(hex(d.genesis_hash), hex(d.program_id))), d.domain);
  });
}

test("encoder refuses out-of-range fields", () => {
  const base = fromVector(doc.vectors[0].order);
  assert.throws(() => encodeOrder({ ...base, subId: 256 }));
  assert.throws(() => encodeOrder({ ...base, marketId: 65536 }));
  assert.throws(() => encodeOrder({ ...base, flags: 0b1000 }));
  assert.throws(() => encodeOrder({ ...base, size: -1n }));
  assert.throws(() => encodeOrder({ ...base, nonce: 1n << 64n }));
  assert.throws(() => encodeOrder({ ...base, owner: new Uint8Array(31) }));
});

test("decoder is strict", () => {
  const good = hex(doc.vectors[0].hex);
  assert.throws(() => decodeOrder(good.slice(0, 107)));
  const cancel = good.slice();
  cancel.set(new TextEncoder().encode("KRYCANv1"), 0);
  assert.throws(() => decodeOrder(cancel), /magic/);
  const flags = good.slice();
  flags[75] |= 0b1000;
  assert.throws(() => decodeOrder(flags), /flag/);
});

test("toWire is exact decimal", () => {
  assert.equal(toWire("250.12"), 250_120_000_000n);
  assert.equal(toWire("1"), 1_000_000_000n);
  assert.equal(toWire("0.000000001"), 1n);
  assert.throws(() => toWire("0.0000000001"));
  assert.throws(() => toWire("-1"));
});
