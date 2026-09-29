import { test } from "node:test";
import assert from "node:assert/strict";
import {
  STAKE_TERMS,
  compactStakeQty,
  feeBpsForBalances,
  termByDays,
} from "./stake";

test("holder and staker fees use the lower rate and do not stack", () => {
  assert.equal(feeBpsForBalances(0, 0), 100);
  assert.equal(feeBpsForBalances(100_000, 0), 80);
  assert.equal(feeBpsForBalances(1_000_000, 0), 60);
  assert.equal(feeBpsForBalances(10_000_000, 0), 40);
  assert.equal(feeBpsForBalances(0, 100_000), 50);
  assert.equal(feeBpsForBalances(0, 1_000_000), 25);
  assert.equal(feeBpsForBalances(10_000_000, 1_000_000), 25);
  assert.equal(feeBpsForBalances(50_000, 50_000), 100);
});

test("stake terms are lock lengths", () => {
  assert.deepEqual(STAKE_TERMS.map((t) => t.days), [7, 30, 90, 180, 360]);
  assert.equal(termByDays(12), null);
  assert.equal(termByDays(30)?.days, 30);
});

test("compact total uses millions", () => {
  assert.equal(compactStakeQty(1_380_000), "1.38M");
});
