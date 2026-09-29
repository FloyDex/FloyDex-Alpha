/**
 * The signed order intent, `docs/prd/05-program-design-anchor.md` §4.
 * Must byte-match `protocol_core::OrderMsg::encode` in Rust; both are pinned
 * by `sdk/conformance/order-v1.json`.
 *
 *   0    8  magic        "FLOYDEX\0"
 *   8   32  domain       sha256(genesis_hash || program_id)
 *   40  32  owner        wallet pubkey (never the delegate)
 *   72   1  sub_id
 *   73   2  market_id    u16
 *   75   1  flags        bit0 is_long, bit1 reduce_only, bit2 post_only
 *   76   8  size         u64, 1e9 scale
 *   84   8  limit_price  u64, 1e9 scale
 *   92   8  nonce        u64
 *   100  8  expiry_ts    u64, unix seconds
 */
import { createHash } from "node:crypto";

export const ORDER_MAGIC = new Uint8Array([0x46, 0x4c, 0x4f, 0x59, 0x44, 0x45, 0x58, 0x00]); // "FLOYDEX\0"
export const ORDER_MSG_LEN = 108;

export const FLAG_IS_LONG = 1 << 0;
export const FLAG_REDUCE_ONLY = 1 << 1;
export const FLAG_POST_ONLY = 1 << 2;
const FLAGS_KNOWN = FLAG_IS_LONG | FLAG_REDUCE_ONLY | FLAG_POST_ONLY;

const U64_MAX = (1n << 64n) - 1n;

export interface Order {
  domain: Uint8Array; // 32 bytes
  owner: Uint8Array; // 32 bytes: the wallet, never the session key
  subId: number; // u8
  marketId: number; // u16
  flags: number; // u8, known bits only
  size: bigint; // u64, 1e9 scale
  limitPrice: bigint; // u64, 1e9 scale
  nonce: bigint; // u64
  expiryTs: bigint; // u64, unix seconds
}

function checkInt(name: string, v: number, max: number): void {
  if (!Number.isInteger(v) || v < 0 || v > max) throw new RangeError(`${name} out of range: ${v}`);
}

function checkU64(name: string, v: bigint): void {
  if (typeof v !== "bigint" || v < 0n || v > U64_MAX) throw new RangeError(`${name} is not a u64: ${v}`);
}

function checkBytes32(name: string, v: Uint8Array): void {
  if (!(v instanceof Uint8Array) || v.length !== 32) throw new RangeError(`${name} must be 32 bytes`);
}

/** Encode an order into the exact 108 bytes a session key signs. */
export function encodeOrder(o: Order): Uint8Array {
  checkBytes32("domain", o.domain);
  checkBytes32("owner", o.owner);
  checkInt("subId", o.subId, 0xff);
  checkInt("marketId", o.marketId, 0xffff);
  checkInt("flags", o.flags, 0xff);
  if ((o.flags & ~FLAGS_KNOWN) !== 0) throw new RangeError(`unknown flag bits: ${o.flags}`);
  checkU64("size", o.size);
  checkU64("limitPrice", o.limitPrice);
  checkU64("nonce", o.nonce);
  checkU64("expiryTs", o.expiryTs);

  const out = new Uint8Array(ORDER_MSG_LEN);
  const view = new DataView(out.buffer);
  out.set(ORDER_MAGIC, 0);
  out.set(o.domain, 8);
  out.set(o.owner, 40);
  view.setUint8(72, o.subId);
  view.setUint16(73, o.marketId, true);
  view.setUint8(75, o.flags);
  view.setBigUint64(76, o.size, true);
  view.setBigUint64(84, o.limitPrice, true);
  view.setBigUint64(92, o.nonce, true);
  view.setBigUint64(100, o.expiryTs, true);
  return out;
}

/** Strict decode: exact length, magic, known flags. */
export function decodeOrder(bytes: Uint8Array): Order {
  if (bytes.length !== ORDER_MSG_LEN) throw new RangeError(`order must be ${ORDER_MSG_LEN} bytes`);
  for (let i = 0; i < 8; i++) if (bytes[i] !== ORDER_MAGIC[i]) throw new RangeError("bad order magic");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const flags = view.getUint8(75);
  if ((flags & ~FLAGS_KNOWN) !== 0) throw new RangeError(`unknown flag bits: ${flags}`);
  return {
    domain: bytes.slice(8, 40),
    owner: bytes.slice(40, 72),
    subId: view.getUint8(72),
    marketId: view.getUint16(73, true),
    flags,
    size: view.getBigUint64(76, true),
    limitPrice: view.getBigUint64(84, true),
    nonce: view.getBigUint64(92, true),
    expiryTs: view.getBigUint64(100, true),
  };
}

/** `sha256(genesis_hash || program_id)`, the per-deployment signing domain. */
export function computeDomain(genesisHash: Uint8Array, programId: Uint8Array): Uint8Array {
  checkBytes32("genesisHash", genesisHash);
  checkBytes32("programId", programId);
  return new Uint8Array(createHash("sha256").update(genesisHash).update(programId).digest());
}

/** 1e9 wire scale: `toWire("250.12")` → 250_120_000_000n. Exact, no floats. */
export function toWire(decimal: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,9}))?$/.exec(decimal);
  if (!m) throw new RangeError(`not a non-negative decimal with <= 9 places: ${decimal}`);
  const v = BigInt(m[1]) * 1_000_000_000n + BigInt((m[2] ?? "").padEnd(9, "0") || "0");
  checkU64("value", v);
  return v;
}
