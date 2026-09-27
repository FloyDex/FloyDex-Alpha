/**
 * Rebuilds the exact 108-byte order message each session key signed, from
 * the `OrderArgs`-shaped JSON the matcher stored on the `TxJob.payload`
 * (`services/matcher/src/tick.ts`'s `fillArgsPayload`). Must byte-match what
 * the session key actually signed — the on-chain Ed25519 introspection
 * check (`05` §5) compares this message and the stored `signature` verbatim,
 * so a single wrong byte here (wrong owner, stale domain, a flag dropped)
 * fails the fill closed rather than silently mis-settling it.
 *
 * The domain is never stored per-job: it's one value for the whole exchange
 * (`sha256(genesis_hash || program_id)`, `05` §4), fetched once from the
 * on-chain `Exchange` account (`accounts.ts`) and passed in here.
 */
import { PublicKey } from "@solana/web3.js";
import { encodeOrder, type Order as WireOrder } from "../../../sdk/src/order.ts";

/** The `OrderArgs`-shaped side of a queued fill, as stored in `TxJob.payload` (`services/matcher/src/tick.ts`). */
export interface StoredOrderArgs {
  owner: string; // base58
  subId: number;
  marketId: number;
  flags: number;
  size: string; // u64 decimal, wire scale
  limitPrice: string; // u64 decimal, wire scale
  nonce: string; // u64 decimal
  expiryTs: string; // u64 decimal
  signature: string | null; // base64
  signerPubkey: string | null; // base58
}

export interface StoredFillPayload {
  marketId: number;
  maker: StoredOrderArgs;
  taker: StoredOrderArgs;
  fillSize: string;
  fillPrice: string;
}

export class MissingSignatureError extends Error {}

/** Rebuilds the 108-byte message a side's `signerPubkey` signed. Throws `MissingSignatureError` if the order was queued without one (should never happen — the matcher only reads orders with both set). */
export function rebuildOrderMessage(domain: Uint8Array, side: StoredOrderArgs): Uint8Array {
  const order: WireOrder = {
    domain,
    owner: new PublicKey(side.owner).toBytes(),
    subId: side.subId,
    marketId: side.marketId,
    flags: side.flags,
    size: BigInt(side.size),
    limitPrice: BigInt(side.limitPrice),
    nonce: BigInt(side.nonce),
    expiryTs: BigInt(side.expiryTs),
  };
  return encodeOrder(order);
}

/** The signature + signer for a side, decoded to raw bytes. Throws `MissingSignatureError` if either is absent. */
export function sideSignedMessage(domain: Uint8Array, side: StoredOrderArgs): { message: Uint8Array; signature: Uint8Array; signerPubkey: Uint8Array } {
  if (!side.signature || !side.signerPubkey) {
    throw new MissingSignatureError(`order for owner ${side.owner} (market ${side.marketId}, nonce ${side.nonce}) has no signature/signerPubkey persisted`);
  }
  return {
    message: rebuildOrderMessage(domain, side),
    signature: new Uint8Array(Buffer.from(side.signature, "base64")),
    signerPubkey: new PublicKey(side.signerPubkey).toBytes(),
  };
}
