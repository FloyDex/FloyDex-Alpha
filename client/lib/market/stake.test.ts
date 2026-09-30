import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FEE_COLLECTOR,
} from "@/config";
import {
  STAKE_TERMS,
  STAKE_TREASURY,
  compactStakeQty,
  feeBpsForBalances,
  stakePayout,
  stakeReward,
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

test("stake terms carry OpenGap-style period yields", () => {
  assert.deepEqual(
    STAKE_TERMS.map((t) => [t.days, t.apyPct]),
    [
      [7, 3.5],
      [30, 15],
      [90, 45],
      [180, 90],
      [360, 180],
    ],
  );
  assert.equal(termByDays(12), null);
  assert.equal(termByDays(30)?.apyPct, 15);
});

test("stake reward is flat period yield on principal", () => {
  assert.equal(stakeReward(1000, 3.5), 35);
  assert.equal(stakePayout(1000, 15), 1150);
  assert.equal(stakePayout(1000, 180), 2800);
  assert.equal(stakeReward(100_000, 15), 15_000);
});

test("stake treasury is the fee collector wallet", () => {
  assert.equal(STAKE_TREASURY, FEE_COLLECTOR);
  assert.equal(STAKE_TREASURY, "HPXzdeaarrnLL8PKGi11PT2BBd8HY5yty7WwDBZavCbn");
});

test("compact total uses millions", () => {
  assert.equal(compactStakeQty(1_380_000), "1.38M");
});
