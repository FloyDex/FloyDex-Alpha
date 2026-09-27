import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { encodeOrder, FLAG_IS_LONG, type Order as WireOrder } from "../../../sdk/src/order.ts";
import { signEd25519, verifyEd25519 } from "../../../sdk/src/ed25519.ts";
import { MissingSignatureError, rebuildOrderMessage, sideSignedMessage, type StoredOrderArgs } from "../src/message.ts";

const domain = new Uint8Array(32).fill(7);
const owner = Keypair.generate();

function stored(overrides: Partial<StoredOrderArgs> = {}): StoredOrderArgs {
  return {
    owner: owner.publicKey.toBase58(),
    subId: 0,
    marketId: 1,
    flags: FLAG_IS_LONG,
    size: "1000000000",
    limitPrice: "100000000000",
    nonce: "1",
    expiryTs: "9999999999",
    signature: null,
    signerPubkey: null,
    ...overrides,
  };
}

test("rebuildOrderMessage byte-matches sdk.encodeOrder given the same fields", () => {
  const side = stored();
  const expected = encodeOrder({
    domain,
    owner: owner.publicKey.toBytes(),
    subId: side.subId,
    marketId: side.marketId,
    flags: side.flags,
    size: BigInt(side.size),
    limitPrice: BigInt(side.limitPrice),
    nonce: BigInt(side.nonce),
    expiryTs: BigInt(side.expiryTs),
  } as WireOrder);
  assert.deepEqual(rebuildOrderMessage(domain, side), expected);
});

test("rebuildOrderMessage reflects every field (a stale/wrong field produces a different message, so a tampered payload fails Ed25519 rather than silently matching)", () => {
  const a = rebuildOrderMessage(domain, stored());
  const b = rebuildOrderMessage(domain, stored({ nonce: "2" }));
  assert.notDeepEqual(a, b);
  const c = rebuildOrderMessage(domain, stored({ marketId: 2 }));
  assert.notDeepEqual(a, c);
  const d = rebuildOrderMessage(new Uint8Array(32).fill(9), stored());
  assert.notDeepEqual(a, d);
});

test("sideSignedMessage round-trips a real signature through verifyEd25519", () => {
  const signer = Keypair.generate();
  const side = stored();
  const message = rebuildOrderMessage(domain, side);
  const signature = signEd25519(signer.secretKey, message);
  const signed = stored({ signature: Buffer.from(signature).toString("base64"), signerPubkey: signer.publicKey.toBase58() });
  const rebuilt = sideSignedMessage(domain, signed);
  assert.deepEqual(rebuilt.message, message);
  assert.deepEqual(rebuilt.signature, signature);
  assert.deepEqual(rebuilt.signerPubkey, signer.publicKey.toBytes());
  assert.equal(verifyEd25519(rebuilt.signerPubkey, rebuilt.message, rebuilt.signature), true);
});

test("sideSignedMessage throws MissingSignatureError when signature or signerPubkey is null", () => {
  assert.throws(() => sideSignedMessage(domain, stored({ signature: null, signerPubkey: "x" })), MissingSignatureError);
  assert.throws(() => sideSignedMessage(domain, stored({ signature: "c2ln", signerPubkey: null })), MissingSignatureError);
});

test("rebuildOrderMessage uses the stored owner, never a delegate/signer key (the on-chain domain-separation rule, 05 §4)", () => {
  const signer = Keypair.generate();
  const side = stored({ signerPubkey: signer.publicKey.toBase58() });
  const msg = rebuildOrderMessage(domain, side);
  assert.deepEqual(msg.slice(40, 72), owner.publicKey.toBytes());
  assert.notDeepEqual(msg.slice(40, 72), signer.publicKey.toBytes());
});
