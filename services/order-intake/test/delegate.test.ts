import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import { deriveUserAccountPda, checkDelegateActive } from "../src/delegate.ts";

test("deriveUserAccountPda is deterministic and varies with subId", () => {
  const programId = Keypair.generate().publicKey;
  const owner = Keypair.generate().publicKey;
  const a = deriveUserAccountPda(programId, owner, 0);
  const b = deriveUserAccountPda(programId, owner, 0);
  const c = deriveUserAccountPda(programId, owner, 1);
  assert.ok(a.equals(b));
  assert.ok(!a.equals(c));
});

test("deriveUserAccountPda rejects an out-of-range subId", () => {
  const programId = Keypair.generate().publicKey;
  const owner = Keypair.generate().publicKey;
  assert.throws(() => deriveUserAccountPda(programId, owner, -1), RangeError);
  assert.throws(() => deriveUserAccountPda(programId, owner, 256), RangeError);
});

test("checkDelegateActive accepts the matching, unexpired delegate", () => {
  const delegate = Keypair.generate().publicKey;
  const nowSec = 1_000_000;
  const result = checkDelegateActive({ owner: Keypair.generate().publicKey, delegate, delegate_expiry: nowSec + 60, cancel_all_below_nonce: 5n, sub_id: 0 }, delegate, nowSec);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.cancelAllBelowNonce, 5n);
});

test("checkDelegateActive rejects a signer that isn't the delegate", () => {
  const delegate = Keypair.generate().publicKey;
  const impostor = Keypair.generate().publicKey;
  const nowSec = 1_000_000;
  const result = checkDelegateActive({ owner: Keypair.generate().publicKey, delegate, delegate_expiry: nowSec + 60, cancel_all_below_nonce: 0n, sub_id: 0 }, impostor, nowSec);
  assert.equal(result.ok, false);
});

test("checkDelegateActive rejects an expired delegate", () => {
  const delegate = Keypair.generate().publicKey;
  const nowSec = 1_000_000;
  const result = checkDelegateActive({ owner: Keypair.generate().publicKey, delegate, delegate_expiry: nowSec - 1, cancel_all_below_nonce: 0n, sub_id: 0 }, delegate, nowSec);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /expired/);
});

test("checkDelegateActive accepts a BN-like delegate_expiry/cancel_all_below_nonce (as the real coder returns)", () => {
  const delegate = Keypair.generate().publicKey;
  const nowSec = 1_000_000;
  const bnLike = (n: number) => ({ toNumber: () => n, toString: () => String(n) });
  const result = checkDelegateActive(
    { owner: Keypair.generate().publicKey, delegate, delegate_expiry: bnLike(nowSec + 60) as unknown as number, cancel_all_below_nonce: bnLike(7) as unknown as bigint, sub_id: 0 },
    delegate,
    nowSec,
  );
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.cancelAllBelowNonce, 7n);
});
