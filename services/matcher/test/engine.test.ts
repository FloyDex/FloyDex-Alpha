import { test } from "node:test";
import assert from "node:assert/strict";
import { matchAll, withinOracleBand, type RestingOrder } from "../src/engine.ts";

let seq = 0;
function order(partial: Partial<RestingOrder> & { owner: string; isLong: boolean }): RestingOrder {
  seq += 1;
  return {
    id: partial.id ?? `o${seq}`,
    owner: partial.owner,
    subId: partial.subId ?? 0,
    marketId: partial.marketId ?? 1,
    isLong: partial.isLong,
    size: partial.size ?? 1_000_000_000n,
    limitPrice: partial.limitPrice ?? 0n,
    reduceOnly: partial.reduceOnly ?? false,
    nonce: partial.nonce ?? BigInt(seq),
    expiryTs: partial.expiryTs ?? 9_999_999_999n,
    filledSize: partial.filledSize ?? 0n,
    queuedSize: partial.queuedSize ?? 0n,
    createdAt: partial.createdAt ?? new Date(2026, 0, 1, 0, 0, seq),
    signature: partial.signature ?? "sig",
    signerPubkey: partial.signerPubkey ?? "signer",
  };
}

test("matches a crossed bid/ask at the resting (maker) price", () => {
  const bid = order({ owner: "alice", isLong: true, limitPrice: 100n, createdAt: new Date(2026, 0, 1, 0, 0, 0) });
  const ask = order({ owner: "bob", isLong: false, limitPrice: 95n, createdAt: new Date(2026, 0, 1, 0, 0, 1) });
  const matches = matchAll([bid, ask], []);
  assert.equal(matches.length, 1);
  // ask (bob) rested first-ish by createdAt comparison; maker is whichever
  // order came first, so with bid earlier, bid is maker and price is bid's.
  assert.equal(matches[0].maker.owner, "alice");
  assert.equal(matches[0].fillPrice, 100n);
  assert.equal(matches[0].fillSize, 1_000_000_000n);
});

test("does not match an uncrossed book", () => {
  const bid = order({ owner: "alice", isLong: true, limitPrice: 90n });
  const ask = order({ owner: "bob", isLong: false, limitPrice: 95n });
  assert.equal(matchAll([bid, ask], []).length, 0);
});

test("price-time priority: earlier order at the best price fills first", () => {
  const bidEarly = order({ owner: "alice", isLong: true, limitPrice: 100n, createdAt: new Date(2026, 0, 1, 0, 0, 0) });
  const bidLate = order({ owner: "carol", isLong: true, limitPrice: 100n, createdAt: new Date(2026, 0, 1, 0, 0, 5) });
  const ask = order({ owner: "bob", isLong: false, limitPrice: 100n, size: 1_000_000_000n });
  const matches = matchAll([bidEarly, bidLate, ask], []);
  assert.equal(matches.length, 1);
  assert.ok([matches[0].maker.owner, matches[0].taker.owner].includes("alice"));
  assert.ok(![matches[0].maker.owner, matches[0].taker.owner].includes("carol"));
});

test("partial fills split across resting orders in price-time order", () => {
  const bid1 = order({ owner: "alice", isLong: true, limitPrice: 100n, size: 300_000_000n, createdAt: new Date(2026, 0, 1, 0, 0, 0) });
  const bid2 = order({ owner: "carol", isLong: true, limitPrice: 100n, size: 300_000_000n, createdAt: new Date(2026, 0, 1, 0, 0, 1) });
  const ask = order({ owner: "bob", isLong: false, limitPrice: 100n, size: 500_000_000n });
  const matches = matchAll([bid1, bid2, ask], []);
  const total = matches.reduce((s, m) => s + m.fillSize, 0n);
  assert.equal(total, 500_000_000n);
  assert.equal(matches.length, 2);
  assert.equal(matches[0].fillSize, 300_000_000n); // alice fully filled first
  assert.equal(matches[1].fillSize, 200_000_000n); // carol partially filled
});

test("self-trade prevention: same (owner, subId) never matches itself", () => {
  const bid = order({ owner: "alice", subId: 0, isLong: true, limitPrice: 100n });
  const ask = order({ owner: "alice", subId: 0, isLong: false, limitPrice: 95n });
  assert.equal(matchAll([bid, ask], []).length, 0);
});

test("distinct sub-accounts of the same wallet may trade with each other", () => {
  const bid = order({ owner: "alice", subId: 0, isLong: true, limitPrice: 100n });
  const ask = order({ owner: "alice", subId: 1, isLong: false, limitPrice: 95n });
  const matches = matchAll([bid, ask], []);
  assert.equal(matches.length, 1);
});

test("filledSize and queuedSize both reduce remaining size", () => {
  const bid = order({ owner: "alice", isLong: true, limitPrice: 100n, size: 1_000_000_000n, filledSize: 400_000_000n, queuedSize: 400_000_000n });
  const ask = order({ owner: "bob", isLong: false, limitPrice: 100n, size: 1_000_000_000n });
  const matches = matchAll([bid, ask], []);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].fillSize, 200_000_000n); // only 1e9 - 4e8 - 4e8 left on alice's side
});

test("a fully queued order (queuedSize == size) is skipped, never re-matched", () => {
  const bid = order({ owner: "alice", isLong: true, limitPrice: 100n, size: 1_000_000_000n, queuedSize: 1_000_000_000n });
  const ask = order({ owner: "bob", isLong: false, limitPrice: 100n });
  assert.equal(matchAll([bid, ask], []).length, 0);
});

test("market sell hits the best (highest) bid first", () => {
  const lowBid = order({ owner: "alice", isLong: true, limitPrice: 90n });
  const highBid = order({ owner: "carol", isLong: true, limitPrice: 100n });
  const marketSell = order({ owner: "bob", isLong: false, limitPrice: 0n });
  const matches = matchAll([lowBid, highBid], [marketSell]);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].maker.owner, "carol");
  assert.equal(matches[0].fillPrice, 100n);
});

test("market buy hits the best (lowest) ask first", () => {
  const highAsk = order({ owner: "alice", isLong: false, limitPrice: 110n });
  const lowAsk = order({ owner: "carol", isLong: false, limitPrice: 100n });
  const marketBuy = order({ owner: "bob", isLong: true, limitPrice: 0n });
  const matches = matchAll([highAsk, lowAsk], [marketBuy]);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].maker.owner, "carol");
  assert.equal(matches[0].fillPrice, 100n);
});

test("a market order never matches its own resting order on the other side", () => {
  const bid = order({ owner: "alice", isLong: true, limitPrice: 100n });
  const marketSell = order({ owner: "alice", isLong: false, limitPrice: 0n });
  assert.equal(matchAll([bid], [marketSell]).length, 0);
});

test("liquidity is never consumed twice across market-order and limit-limit passes", () => {
  const bid = order({ owner: "alice", isLong: true, limitPrice: 100n, size: 1_000_000_000n });
  const ask = order({ owner: "bob", isLong: false, limitPrice: 100n, size: 1_000_000_000n });
  const marketSell = order({ owner: "carol", isLong: false, limitPrice: 0n, size: 1_000_000_000n });
  const matches = matchAll([bid, ask], [marketSell]);
  // The market sell should take the bid in pass 1, leaving nothing for the
  // limit ask in pass 2.
  assert.equal(matches.length, 1);
  assert.equal(matches[0].taker.owner, "carol");
});

test("withinOracleBand accepts the oracle price itself and rejects far outside the band", () => {
  const oracle = 100_000_000_000_000_000_000n; // $100 at 1e18
  const bps = 1000n; // 10%
  assert.equal(withinOracleBand(oracle, oracle, bps), true);
  assert.equal(withinOracleBand((oracle * 109n) / 100n, oracle, bps), true);
  assert.equal(withinOracleBand((oracle * 111n) / 100n, oracle, bps), false);
  assert.equal(withinOracleBand((oracle * 89n) / 100n, oracle, bps), false);
});
