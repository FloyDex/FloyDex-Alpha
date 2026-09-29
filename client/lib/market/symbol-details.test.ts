import { test } from "node:test";
import assert from "node:assert/strict";
import {
  compactStat,
  performanceFromCloses,
  returnPct,
  rsi,
  sma,
  technicalScore,
} from "./symbol-details";

test("returnPct and compact stats", () => {
  assert.equal(returnPct(110, 100)?.toFixed(2), "10.00");
  assert.equal(compactStat(3370), "3.37K");
  assert.equal(compactStat(614.84), "614.84");
});

test("SMA / RSI and technical label", () => {
  const up = Array.from({ length: 30 }, (_, i) => 100 + i);
  assert.equal(sma(up, 5), 127);
  const r = rsi(up, 14);
  assert.ok(r !== null && r > 70);
  assert.equal(technicalScore(130, 120, 110, 70).label, "Strong buy");
  assert.equal(technicalScore(90, 120, 110, 30).label, "Strong sell");
});

test("performance windows read the right offsets", () => {
  const closes = Array.from({ length: 252 }, (_, i) => 100 + i * 0.1);
  const times = closes.map((_, i) => Date.UTC(2025, 0, 1) + i * 86_400_000);
  const p = performanceFromCloses(closes, times);
  assert.ok(p["1W"] !== null && p["1W"]! > 0);
  assert.ok(p["1Y"] !== null);
});
