import { test } from "node:test";
import assert from "node:assert/strict";
import { derivePushFeedAddress, PYTH_PUSH_ORACLE_PROGRAM_ID } from "../src/pyth.ts";

// The known sponsored shard-0 SOL/USD push feed recorded in
// `deployments/devnet.json` (`06` §8), derived from feed id
// `ef0d8b6f...b56d` — a fixed known-good vector so a refactor of the PDA
// derivation can never silently drift from what's actually deployed.
const SOL_USD_FEED_HEX = "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";

test("derivePushFeedAddress matches the recorded devnet SOL/USD push feed", () => {
  const feedId = Buffer.from(SOL_USD_FEED_HEX, "hex");
  const addr = derivePushFeedAddress(0, feedId);
  assert.equal(addr.toBase58(), "7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE");
});

test("derivePushFeedAddress is owned by the Pyth push-oracle program (not checked directly, but the derivation uses it as the PDA program)", () => {
  assert.equal(PYTH_PUSH_ORACLE_PROGRAM_ID.toBase58(), "pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT");
});

test("derivePushFeedAddress differs per shard", () => {
  const feedId = Buffer.from(SOL_USD_FEED_HEX, "hex");
  const shard0 = derivePushFeedAddress(0, feedId);
  const shard1 = derivePushFeedAddress(1, feedId);
  assert.notEqual(shard0.toBase58(), shard1.toBase58());
});

test("derivePushFeedAddress rejects a feed id that isn't 32 bytes", () => {
  assert.throws(() => derivePushFeedAddress(0, Buffer.from("00", "hex")), RangeError);
});
