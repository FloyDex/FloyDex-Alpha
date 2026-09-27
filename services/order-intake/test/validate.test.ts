import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { encodeOrder, FLAG_IS_LONG, type Order as WireOrder } from "../../../sdk/src/order.ts";
import { signEd25519 } from "../../../sdk/src/ed25519.ts";
import { validateOrderPayload } from "../src/validate.ts";

function solanaKeypair(): { secretKey: Uint8Array; publicKey: Uint8Array } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const seed = new Uint8Array(privateKey.export({ format: "der", type: "pkcs8" }).subarray(16));
  const pub = new Uint8Array(publicKey.export({ format: "der", type: "spki" }).subarray(12));
  const secretKey = new Uint8Array(64);
  secretKey.set(seed);
  secretKey.set(pub, 32);
  return { secretKey, publicKey: pub };
}

const DOMAIN = new Uint8Array(32).fill(9);

function validPayload(overrides: Partial<Record<string, unknown>> = {}) {
  const owner = solanaKeypair();
  const signer = overrides.signerKeypair ? (overrides.signerKeypair as ReturnType<typeof solanaKeypair>) : owner;
  const nowSec = Math.floor(Date.now() / 1000);

  const base = {
    owner: new PublicKey(owner.publicKey).toBase58(),
    subId: 0,
    marketId: 1,
    isLong: true,
    reduceOnly: false,
    size: "1000000000",
    limitPrice: "150000000000",
    nonce: "1",
    expiryTs: String(nowSec + 300),
    signerPubkey: new PublicKey(signer.publicKey).toBase58(),
    ...overrides,
  };
  delete (base as Record<string, unknown>).signerKeypair;

  const wireOrder: WireOrder = {
    domain: DOMAIN,
    owner: new PublicKey(base.owner as string).toBytes(),
    subId: base.subId as number,
    marketId: base.marketId as number,
    flags: base.isLong ? FLAG_IS_LONG : 0,
    size: BigInt(base.size as string),
    limitPrice: BigInt(base.limitPrice as string),
    nonce: BigInt(base.nonce as string),
    expiryTs: BigInt(base.expiryTs as string),
  };
  const wire = encodeOrder(wireOrder);
  const signature = Buffer.from(signEd25519(signer.secretKey, wire)).toString("base64");

  return { ...base, signature };
}

test("accepts a validly signed order", () => {
  const result = validateOrderPayload(validPayload(), DOMAIN);
  assert.equal(result.ok, true);
});

test("rejects a signature that doesn't match the domain", () => {
  const payload = validPayload();
  const result = validateOrderPayload(payload, new Uint8Array(32).fill(1)); // different domain
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /signature/);
});

test("rejects a tampered field after signing (e.g. size bumped post-hoc)", () => {
  const payload = validPayload();
  const tampered = { ...payload, size: "9999999999" };
  const result = validateOrderPayload(tampered, DOMAIN);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /signature/);
});

test("accepts a session key (delegate) signature distinct from the owner", () => {
  const owner = solanaKeypair();
  const session = solanaKeypair();
  const payload = validPayload({ owner: new PublicKey(owner.publicKey).toBase58(), signerKeypair: session });
  const result = validateOrderPayload(payload, DOMAIN);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.order.owner, new PublicKey(owner.publicKey).toBase58());
    assert.equal(result.order.signerPubkey, new PublicKey(session.publicKey).toBase58());
    assert.notEqual(result.order.owner, result.order.signerPubkey);
  }
});

// These tamper with a validly *signed* payload's fields after signing —
// building the payload with the bad value in the first place would mean
// signing a message the encoder itself rejects (e.g. a negative size isn't a
// u64), which tests encodeOrder's own guards, not validateOrderPayload's.
// Every case below is expected to fail on the specific structural check
// before signature verification ever runs, so a stale signature is fine.

test("rejects invalid owner pubkey, out-of-range subId/marketId, non-boolean flags", () => {
  const payload = validPayload();
  assert.equal(validateOrderPayload({ ...payload, owner: "not-a-pubkey" }, DOMAIN).ok, false);
  assert.equal(validateOrderPayload({ ...payload, subId: 256 }, DOMAIN).ok, false);
  assert.equal(validateOrderPayload({ ...payload, subId: -1 }, DOMAIN).ok, false);
  assert.equal(validateOrderPayload({ ...payload, marketId: 70000 }, DOMAIN).ok, false);
  assert.equal(validateOrderPayload({ ...payload, isLong: "yes" }, DOMAIN).ok, false);
  assert.equal(validateOrderPayload({ ...payload, reduceOnly: 1 }, DOMAIN).ok, false);
});

test("rejects zero or negative size/limitPrice, and size/price above the sane bound", () => {
  const payload = validPayload();
  assert.equal(validateOrderPayload({ ...payload, size: "0" }, DOMAIN).ok, false);
  assert.equal(validateOrderPayload({ ...payload, limitPrice: "0" }, DOMAIN).ok, false);
  assert.equal(validateOrderPayload({ ...payload, size: "-1" }, DOMAIN).ok, false);
  assert.equal(validateOrderPayload({ ...payload, size: "99999999999999999999999" }, DOMAIN).ok, false);
});

test("rejects an expiry that's too soon, too far out, or not a u64", () => {
  const payload = validPayload();
  const nowSec = Math.floor(Date.now() / 1000);
  assert.equal(validateOrderPayload({ ...payload, expiryTs: String(nowSec + 1) }, DOMAIN).ok, false);
  assert.equal(validateOrderPayload({ ...payload, expiryTs: String(nowSec + 8 * 24 * 3600) }, DOMAIN).ok, false);
  assert.equal(validateOrderPayload({ ...payload, expiryTs: "not-a-number" }, DOMAIN).ok, false);
});

test("rejects a missing, oversized, or malformed-base64 signature", () => {
  const payload = validPayload();
  assert.equal(validateOrderPayload({ ...payload, signature: undefined }, DOMAIN).ok, false);
  assert.equal(validateOrderPayload({ ...payload, signature: "a".repeat(200) }, DOMAIN).ok, false);
  assert.equal(validateOrderPayload({ ...payload, signature: "not base64!!" }, DOMAIN).ok, false);
});

test("rejects a non-object body", () => {
  assert.equal(validateOrderPayload(null, DOMAIN).ok, false);
  assert.equal(validateOrderPayload("hello", DOMAIN).ok, false);
  assert.equal(validateOrderPayload(42, DOMAIN).ok, false);
});
