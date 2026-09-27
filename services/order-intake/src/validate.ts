/**
 * Server-side validation for order intake. Pure — no I/O — so it's testable
 * without a database or an RPC connection. Ported from
 * `reference/stellar/offchain/lib/validation.ts`'s shape and bounds, adapted
 * to the Solana wire format (`sdk/src/order.ts`) and its Ed25519 session-key
 * signature instead of a Soroban auth entry.
 *
 * What this does NOT check (left to the caller, which has the DB/RPC this
 * module deliberately doesn't touch): the market is known and active, the
 * delegate is active on-chain for (owner, subId) and its signer matches, and
 * `nonce` clears the account's `cancel_all_below_nonce`.
 */
import { PublicKey } from "@solana/web3.js";
import { computeDomain, encodeOrder, FLAG_IS_LONG, FLAG_REDUCE_ONLY, type Order as WireOrder } from "../../../sdk/src/order.ts";
import { verifyEd25519 } from "../../../sdk/src/ed25519.ts";

// Sane absolute bounds (defence-in-depth; on-chain checks are authoritative).
const MAX_SIZE = 10_000_000n * 1_000_000_000n; // 10M units at 1e9 scale
const MAX_PRICE = 10_000_000n * 1_000_000_000n; // $10M at 1e9 scale
const MAX_TTL_SECONDS = 7n * 24n * 3600n; // 7 days
const MIN_TTL_SECONDS = 5n; // reject already-racy orders
const U64_MAX = (1n << 64n) - 1n;

export interface ValidatedOrder {
  owner: string; // base58
  subId: number;
  marketId: number;
  isLong: boolean;
  reduceOnly: boolean;
  size: bigint;
  limitPrice: bigint;
  nonce: bigint;
  expiryTs: bigint;
  /** The session key that actually signed — checked against the delegate on-chain by the caller. */
  signerPubkey: string; // base58
  signature: string; // base64, as received, stored for settlement replay
}

export type ValidationResult = { ok: true; order: ValidatedOrder } | { ok: false; error: string };

function parseBigInt(v: unknown): bigint | null {
  if (typeof v !== "string" && typeof v !== "number") return null;
  const s = String(v).trim();
  if (!/^\d+$/.test(s)) return null;
  try {
    return BigInt(s);
  } catch {
    return null;
  }
}

function isBase58Pubkey(v: unknown): v is string {
  if (typeof v !== "string" || v.length < 32 || v.length > 44) return false;
  try {
    new PublicKey(v);
    return true;
  } catch {
    return false;
  }
}

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

function decodeBase64(v: string): Uint8Array | null {
  // Buffer.from(_, "base64") silently drops characters outside the alphabet
  // rather than throwing, so a malformed payload would otherwise decode to
  // *something* instead of being rejected outright.
  if (!BASE64_RE.test(v)) return null;
  return new Uint8Array(Buffer.from(v, "base64"));
}

/**
 * @param domain `sha256(genesis_hash || program_id)` for the network this
 *   service is running against (from `deployments/*.json`'s `genesisHash`
 *   via `computeDomain`). Required rather than defaulted, same reasoning as
 *   the Stellar `networkPassphrase` parameter it replaces: a devnet-signed
 *   order must never verify against a mainnet domain or vice versa.
 */
export function validateOrderPayload(body: unknown, domain: Uint8Array): ValidationResult {
  if (typeof body !== "object" || body === null) return { ok: false, error: "body must be an object" };
  const b = body as Record<string, unknown>;

  if (!isBase58Pubkey(b.owner)) return { ok: false, error: "invalid owner pubkey" };
  const owner = b.owner as string;

  const subId = b.subId;
  if (typeof subId !== "number" || !Number.isInteger(subId) || subId < 0 || subId > 0xff) {
    return { ok: false, error: "subId must be a u8" };
  }

  const marketId = b.marketId;
  if (typeof marketId !== "number" || !Number.isInteger(marketId) || marketId < 0 || marketId > 0xffff) {
    return { ok: false, error: "marketId must be a u16" };
  }

  if (typeof b.isLong !== "boolean") return { ok: false, error: "isLong must be boolean" };
  if (typeof b.reduceOnly !== "boolean") return { ok: false, error: "reduceOnly must be boolean" };

  const size = parseBigInt(b.size);
  if (size === null || size <= 0n) return { ok: false, error: "size must be a positive integer" };
  if (size > MAX_SIZE) return { ok: false, error: "size exceeds maximum" };

  // Zero is not accepted as a "market order" sentinel — same reasoning as the
  // Stellar validator this is ported from: an order the chain will always
  // reject can still match off-chain first, holding book depth for nothing.
  // A market order is an aggressive crossing limit instead (2x mark to buy,
  // half to sell); the on-chain execution band still caps the fill.
  const limitPrice = parseBigInt(b.limitPrice);
  if (limitPrice === null || limitPrice <= 0n) {
    return { ok: false, error: "limitPrice must be a positive integer; send an aggressive crossing limit for a market order, not 0" };
  }
  if (limitPrice > MAX_PRICE) return { ok: false, error: "limitPrice exceeds maximum" };

  const nonce = parseBigInt(b.nonce);
  if (nonce === null || nonce > U64_MAX) return { ok: false, error: "nonce must be a u64 integer" };

  const expiryTs = parseBigInt(b.expiryTs);
  if (expiryTs === null || expiryTs > U64_MAX) return { ok: false, error: "expiryTs must be a u64 integer" };
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  if (expiryTs <= nowSec + MIN_TTL_SECONDS) return { ok: false, error: "expiryTs is too soon" };
  if (expiryTs > nowSec + MAX_TTL_SECONDS) return { ok: false, error: "expiryTs too far in the future" };

  if (typeof b.signature !== "string" || b.signature.length === 0 || b.signature.length > 128) {
    return { ok: false, error: "missing or oversized order signature" };
  }
  const signatureBytes = decodeBase64(b.signature);
  if (!signatureBytes || signatureBytes.length !== 64) return { ok: false, error: "signature must be 64 bytes, base64-encoded" };

  // The signer: the session key (delegate), never necessarily the owner.
  // Required explicitly rather than assumed to be the owner, because a
  // signature "valid for someone" is meaningless — the caller still has to
  // check this specific key is the account's active delegate on-chain.
  if (!isBase58Pubkey(b.signerPubkey)) return { ok: false, error: "invalid signerPubkey" };
  const signerPubkey = b.signerPubkey as string;

  let wire: Uint8Array;
  try {
    const wireOrder: WireOrder = {
      domain,
      owner: new PublicKey(owner).toBytes(),
      subId,
      marketId,
      flags: (b.isLong ? FLAG_IS_LONG : 0) | (b.reduceOnly ? FLAG_REDUCE_ONLY : 0),
      size,
      limitPrice,
      nonce,
      expiryTs,
    };
    wire = encodeOrder(wireOrder);
  } catch (e) {
    return { ok: false, error: `could not encode order message: ${e instanceof Error ? e.message : String(e)}` };
  }

  if (!verifyEd25519(new PublicKey(signerPubkey).toBytes(), wire, signatureBytes)) {
    return { ok: false, error: "invalid order signature" };
  }

  return {
    ok: true,
    order: { owner, subId, marketId, isLong: b.isLong, reduceOnly: b.reduceOnly, size, limitPrice, nonce, expiryTs, signerPubkey, signature: b.signature },
  };
}

export { computeDomain };
