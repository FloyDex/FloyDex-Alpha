/**
 * Ed25519 program instructions for settlement (`05` §5).
 *
 * The program only accepts signatures whose offsets all point at the same
 * instruction (`u16::MAX`), so this builder always writes 0xffff. Several
 * signatures share one instruction: `[count, pad, offsets…]`, then per
 * signature `pubkey ‖ signature ‖ message`.
 */
import { createPrivateKey, sign as nodeSign } from "node:crypto";

export const ED25519_PROGRAM_ID = "Ed25519SigVerify111111111111111111111111111";
const THIS_INSTRUCTION = 0xffff;
const OFFSETS_LEN = 14;

export interface SignedMessage {
  publicKey: Uint8Array; // 32 bytes
  signature: Uint8Array; // 64 bytes
  message: Uint8Array;
}

export function ed25519InstructionData(entries: SignedMessage[]): Uint8Array {
  if (entries.length === 0 || entries.length > 255) throw new RangeError("1..255 signatures");
  const header = 2 + OFFSETS_LEN * entries.length;
  const bodyLen = entries.reduce((n, e) => n + 32 + 64 + e.message.length, 0);
  const out = new Uint8Array(header + bodyLen);
  const view = new DataView(out.buffer);
  out[0] = entries.length;
  let cursor = header;
  entries.forEach((e, i) => {
    if (e.publicKey.length !== 32 || e.signature.length !== 64) throw new RangeError("bad key or signature length");
    const pk = cursor;
    out.set(e.publicKey, pk);
    const sig = pk + 32;
    out.set(e.signature, sig);
    const msg = sig + 64;
    out.set(e.message, msg);
    cursor = msg + e.message.length;
    if (cursor > 0xffff) throw new RangeError("instruction too large");
    const o = 2 + i * OFFSETS_LEN;
    for (const [k, v] of [sig, THIS_INSTRUCTION, pk, THIS_INSTRUCTION, msg, e.message.length, THIS_INSTRUCTION].entries()) {
      view.setUint16(o + 2 * k, v, true);
    }
  });
  return out;
}

// PKCS#8 wrapper for a raw 32-byte Ed25519 seed (RFC 8410).
const PKCS8_ED25519_PREFIX = Uint8Array.from([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);

/** Sign with a Solana-style 64-byte secret key (seed ‖ pubkey). */
export function signEd25519(secretKey: Uint8Array, message: Uint8Array): Uint8Array {
  if (secretKey.length !== 64) throw new RangeError("secret key must be 64 bytes");
  const der = new Uint8Array(PKCS8_ED25519_PREFIX.length + 32);
  der.set(PKCS8_ED25519_PREFIX);
  der.set(secretKey.subarray(0, 32), PKCS8_ED25519_PREFIX.length);
  const key = createPrivateKey({ key: Buffer.from(der), format: "der", type: "pkcs8" });
  return new Uint8Array(nodeSign(null, message, key));
}
