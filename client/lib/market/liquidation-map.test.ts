import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assembleLiqMap,
  binsFromAggregatedMap,
  liqPriceAt,
  ourbitPair,
  overlayVenueBins,
  weightsForMaxLev,
} from "./liquidation-map";

test("long liq sits below entry, short above", () => {
  const long = liqPriceAt(true, 100, 10, 100);
  const short = liqPriceAt(false, 100, 10, 100);
  assert.ok(long < 100 && long > 80);
  assert.ok(short > 100 && short < 120);
});

test("50x markets drop 75x/100x buckets", () => {
  const w = weightsForMaxLev(50);
  assert.ok(w.every((b) => b.lev <= 50));
  const sum = w.reduce((s, b) => s + b.w, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9);
});

test("long clusters sit below mark and shorts above", () => {
  const { points, venueUsd } = assembleLiqMap({
    mark: 100,
    rangeLow: 80,
    rangeHigh: 120,
    mmBps: 100,
    maxLev: 50,
    oiUsd: 1_000_000,
    longShare: 0.6,
    venue: [{ isLong: true, size: 10, entry: 100, margin: 200 }],
    bins: 40,
  });
  assert.equal(venueUsd, 1000);
  assert.ok(points.length === 40);
  const below = points.filter((p) => p.price < 100);
  const above = points.filter((p) => p.price > 100);
  const longBelow = below.reduce((s, p) => s + p.longUsd, 0);
  const shortAbove = above.reduce((s, p) => s + p.shortUsd, 0);
  assert.ok(longBelow > shortAbove * 0.4);
  assert.ok(shortAbove > 0);
  const left = points[0];
  assert.ok(left.cumLongUsd > left.cumShortUsd);
});

test("OurBit pair ids match aggregated_map paths", () => {
  assert.equal(ourbitPair("BTC"), "BTC_USDT");
  assert.equal(ourbitPair("TSLA"), "TSLA_USDT");
  assert.equal(ourbitPair("xlm"), "XLM_USDT");
});

test("aggregated map l/r pad onto x and reverse-cumsum y", () => {
  const { points, mark } = binsFromAggregatedMap({
    lp: 100,
    x: [90, 95, 100, 105, 110],
    y: [10, 20, 5, 8, 12],
    l: [35, 25],
    r: [5, 13, 25],
  });
  assert.equal(mark, 100);
  assert.equal(points.length, 5);
  assert.equal(points[0].cumLongUsd, 35);
  assert.equal(points[1].cumLongUsd, 25);
  assert.equal(points[0].atUsd, 10);
  assert.equal(points[4].cumShortUsd, 25);
  assert.equal(points[2].cumShortUsd, 5);
  assert.equal(points[4].cumLongUsd, 0);
});

test("venue overlay adds notional into the nearest bin", () => {
  const { points, mark } = binsFromAggregatedMap({
    lp: 100,
    x: [90, 95, 100, 105, 110],
    y: [10, 20, 5, 8, 12],
    l: [35, 25],
    r: [5, 13, 25],
  });
  const out = overlayVenueBins(
    points,
    mark,
    [{ isLong: true, size: 2, entry: 100, margin: 10 }],
    100,
  );
  assert.equal(out.venueUsd, 200);
  const totalAt = out.points.reduce((s, p) => s + p.atUsd, 0);
  assert.ok(totalAt > 10 + 20 + 5 + 8 + 12);
});
