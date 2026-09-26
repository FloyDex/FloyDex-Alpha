import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, verify, createPublicKey } from "node:crypto";
import { ed25519InstructionData, signEd25519 } from "../src/ed25519.ts";

function solanaKeypair(): { secretKey: Uint8Array; publicKey: Uint8Array } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const seed = new Uint8Array(privateKey.export({ format: "der", type: "pkcs8" }).subarray(16));
  const pub = new Uint8Array(publicKey.export({ format: "der", type: "spki" }).subarray(12));
  const secretKey = new Uint8Array(64);
  secretKey.set(seed);
  secretKey.set(pub, 32);
  return { secretKey, publicKey: pub };
}

test("layout: every offset points at this instruction and resolves to the right bytes", () => {
  const a = solanaKeypair();
  const b = solanaKeypair();
  const m1 = new Uint8Array(108).fill(1);
  const m2 = new Uint8Array(108).fill(2);
  const data = ed25519InstructionData([
    { publicKey: a.publicKey, signature: signEd25519(a.secretKey, m1), message: m1 },
    { publicKey: b.publicKey, signature: signEd25519(b.secretKey, m2), message: m2 },
  ]);
  const view = new DataView(data.buffer);
  assert.equal(data[0], 2);
  for (let i = 0; i < 2; i++) {
    const o = 2 + 14 * i;
    const [sig, sigIx, pk, pkIx, msg, msgLen, msgIx] = [0, 1, 2, 3, 4, 5, 6].map((k) => view.getUint16(o + 2 * k, true));
    assert.deepEqual([sigIx, pkIx, msgIx], [0xffff, 0xffff, 0xffff]);
    assert.equal(msgLen, 108);
    const pub = data.subarray(pk, pk + 32);
    const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(pub)]);
    const ok = verify(null, data.subarray(msg, msg + msgLen), createPublicKey({ key: spki, format: "der", type: "spki" }), data.subarray(sig, sig + 64));
    assert.ok(ok, `signature ${i} verifies over the bytes its offsets point at`);
  }
});
