import { test } from "node:test";
import assert from "node:assert/strict";
import { computePriorityFeeMicroLamports, type PriorityFeeSample } from "../src/priorityFee.ts";

const config = { minMicroLamports: 100, maxMicroLamports: 10_000 };

test("returns the floor with no samples", () => {
  assert.equal(computePriorityFeeMicroLamports([], config), 100);
});

test("returns the floor when every sample is zero (an idle cluster)", () => {
  const samples: PriorityFeeSample[] = [{ slot: 1, prioritizationFee: 0 }, { slot: 2, prioritizationFee: 0 }];
  assert.equal(computePriorityFeeMicroLamports(samples, config), 100);
});

test("uses the median of non-zero samples", () => {
  const samples: PriorityFeeSample[] = [
    { slot: 1, prioritizationFee: 1000 },
    { slot: 2, prioritizationFee: 2000 },
    { slot: 3, prioritizationFee: 3000 },
  ];
  assert.equal(computePriorityFeeMicroLamports(samples, config), 2000);
});

test("caps at maxMicroLamports regardless of how congested the cluster reports being", () => {
  const samples: PriorityFeeSample[] = Array.from({ length: 5 }, (_, i) => ({ slot: i, prioritizationFee: 1_000_000 }));
  assert.equal(computePriorityFeeMicroLamports(samples, config), 10_000);
});

test("one outlier sample doesn't dominate (median, not mean)", () => {
  const samples: PriorityFeeSample[] = [
    { slot: 1, prioritizationFee: 100 },
    { slot: 2, prioritizationFee: 150 },
    { slot: 3, prioritizationFee: 200 },
    { slot: 4, prioritizationFee: 5_000_000 },
  ];
  const fee = computePriorityFeeMicroLamports(samples, config);
  assert.ok(fee < 1000, `expected median-driven fee well under the outlier, got ${fee}`);
});
