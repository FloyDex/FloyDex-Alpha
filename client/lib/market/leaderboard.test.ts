import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildVenueLeaderboard,
  cumulativeSpark,
  identiconHues,
  pageWindow,
  parseWatchList,
  periodSinceMs,
  sampleCurve,
  sparkBucketCount,
  timeAgo,
} from "./leaderboard";

test("cumulative spark is a running sum of bucketed deltas", () => {
  const start = 0;
  const end = 4;
  const spark = cumulativeSpark(
    [
      { at: 0.5, value: 10 },
      { at: 2.5, value: -4 },
    ],
    start,
    end,
    4,
  );
  assert.deepEqual(spark, [10, 10, 6, 6]);
});

test("flat spark is omitted so the desk can show a dash", () => {
  assert.deepEqual(cumulativeSpark([{ at: 1, value: 0 }], 0, 4, 4), []);
  assert.deepEqual(sampleCurve([{ at: 1, value: 5 }, { at: 2, value: 5 }], 0, 4, 4), []);
});

test("period windows and relative time", () => {
  assert.equal(periodSinceMs("DAY", 100_000_000), 100_000_000 - 86_400_000);
  assert.equal(sparkBucketCount("WEEK"), 14);
  assert.equal(timeAgo(1_000, 1_000 + 90_000), "1m ago");
  assert.equal(timeAgo(1_000, 1_000 + 8_000), "now");
});

test("watch list and pagination stay bounded", () => {
  assert.deepEqual(parseWatchList('["abc"]'), []);
  assert.deepEqual(parseWatchList('["' + "1".repeat(32) + '"]'), ["1".repeat(32)]);
  assert.deepEqual(pageWindow(0, 1), [0]);
  assert.deepEqual(pageWindow(4, 10), [2, 3, 4, 5, 6]);
});

test("identicon hues are stable for an address", () => {
  const a = identiconHues("HPXzdeaarrnLL8PKGi11PT2BBd8HY5yty7WwDBZavCbn");
  const b = identiconHues("HPXzdeaarrnLL8PKGi11PT2BBd8HY5yty7WwDBZavCbn");
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, identiconHues("So11111111111111111111111111111111111111112"));
});

test("venue leaderboard ranks every wallet that traded", () => {
  const now = 1_000_000_000_000;
  const { total, traders } = buildVenueLeaderboard({
    accounts: [
      {
        owner: "Aaa1111111111111111111111111111111111111111",
        deposited: 10,
        realized: -1,
        fundedIn: 10,
        positions: [{ marketId: 1, size: 1, margin: 2 }],
        fills: [
          { marketId: 1, size: 1, price: 100, pnl: 0, reason: "open", at: now - 1000 },
          { marketId: 1, size: 1, price: 90, pnl: -10, reason: "close", at: now - 500 },
        ],
      },
      {
        owner: "Bbb2222222222222222222222222222222222222222",
        deposited: 5,
        realized: 20,
        fundedIn: 5,
        positions: [],
        fills: [
          { marketId: 2, size: 2, price: 50, pnl: 0, reason: "open", at: now - 800 },
          { marketId: 2, size: 2, price: 60, pnl: 20, reason: "close", at: now - 400 },
        ],
      },
      {
        owner: "Ccc3333333333333333333333333333333333333333",
        deposited: 3,
        realized: 0,
        positions: [],
        fills: [],
      },
    ],
    period: "DAY",
    metric: "pnl",
    limit: 10,
    offset: 0,
    now,
  });
  assert.equal(total, 2);
  assert.equal(traders[0]?.address.startsWith("Bbb"), true);
  assert.equal(traders[0]?.rank, 1);
  assert.equal(traders[1]?.address.startsWith("Aaa"), true);
  assert.equal(traders[1]?.rank, 2);
});
