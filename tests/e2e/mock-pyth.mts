/**
 * Write a genesis account for `solana-test-validator --account`: a fully
 * verified Pyth `PriceUpdateV2` at the push-feed address for (shard, feed),
 * owned by the Pyth receiver program. The program reads it exactly as it
 * would on mainnet; only the Wormhole posting is skipped.
 *
 *   node tests/e2e/mock-pyth.mts <out.json> <feedIdHex> <shard> <price> <expo> <conf> <publishTime>
 */
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { PublicKey } from "@solana/web3.js";

const RECEIVER = new PublicKey("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ");
const PUSH_ORACLE = new PublicKey("pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT");

export function pushFeedAddress(shard: number, feedId: Uint8Array): PublicKey {
  const s = Buffer.alloc(2);
  s.writeUInt16LE(shard);
  return PublicKey.findProgramAddressSync([s, Buffer.from(feedId)], PUSH_ORACLE)[0];
}

export function priceUpdateV2(feedId: Uint8Array, price: bigint, conf: bigint, expo: number, publishTime: bigint): Buffer {
  const b = Buffer.alloc(134);
  createHash("sha256").update("account:PriceUpdateV2").digest().copy(b, 0, 0, 8);
  let o = 8 + 32; // write_authority = zero
  b.writeUInt8(1, o); // VerificationLevel::Full
  o += 1;
  Buffer.from(feedId).copy(b, o);
  o += 32;
  b.writeBigInt64LE(price, o); o += 8;
  b.writeBigUInt64LE(conf, o); o += 8;
  b.writeInt32LE(expo, o); o += 4;
  b.writeBigInt64LE(publishTime, o); o += 8; // publish_time
  b.writeBigInt64LE(publishTime - 1n, o); o += 8; // prev_publish_time
  b.writeBigInt64LE(price, o); o += 8; // ema_price
  b.writeBigUInt64LE(conf, o); o += 8; // ema_conf
  b.writeBigUInt64LE(0n, o); // posted_slot
  return b;
}

if (process.argv[1]?.endsWith("mock-pyth.mts")) {
  const [out, feedHex, shard, price, expo, conf, publishTime] = process.argv.slice(2);
  const feed = Buffer.from(feedHex, "hex");
  const data = priceUpdateV2(feed, BigInt(price), BigInt(conf), Number(expo), BigInt(publishTime));
  const address = pushFeedAddress(Number(shard), feed);
  writeFileSync(
    out,
    JSON.stringify({
      pubkey: address.toBase58(),
      account: {
        lamports: 1_000_000_000,
        data: [data.toString("base64"), "base64"],
        owner: RECEIVER.toBase58(),
        executable: false,
        rentEpoch: 0,
        space: data.length,
      },
    }),
  );
  console.log(address.toBase58());
}
