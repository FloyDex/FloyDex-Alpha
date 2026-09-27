/**
 * Pyth push-oracle account derivation, shared by every service that needs to
 * read or reference a market's (or collateral's) `PriceUpdateV2` account:
 * the submitter (building `settle_fills`' remaining accounts for
 * cross-market risk inputs), and later the mark poster / monitor (feed
 * freshness, `11` L2).
 *
 * The push-feed address is a deterministic PDA of `(shard_id, feed_id)`
 * under the Pyth push-oracle program — ported from `tests/e2e/mock-pyth.mts`'
 * `pushFeedAddress`, which this must byte-match (both derive the same
 * address the on-chain program reads in `oracle::read_pyth`).
 */
import { PublicKey } from "@solana/web3.js";

/** The Pyth push-oracle program that owns every `PriceUpdateV2` push-feed PDA. */
export const PYTH_PUSH_ORACLE_PROGRAM_ID = new PublicKey("pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT");

/** Derives the `PriceUpdateV2` PDA for a given shard and 32-byte feed id. Shard 0 is Pyth's sponsored feeds (`06` §8). */
export function derivePushFeedAddress(shardId: number, feedId: Uint8Array): PublicKey {
  if (feedId.length !== 32) throw new RangeError("feedId must be 32 bytes");
  const shard = Buffer.alloc(2);
  shard.writeUInt16LE(shardId);
  return PublicKey.findProgramAddressSync([shard, Buffer.from(feedId)], PYTH_PUSH_ORACLE_PROGRAM_ID)[0];
}
