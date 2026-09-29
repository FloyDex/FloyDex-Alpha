import { test } from "node:test";
import assert from "node:assert/strict";
import {
  gainPct,
  pnlUsd,
  priceFromPct,
  priceFromPnl,
  roePct,
  validateTpSl,
} from "./tpsl";

test("long TP/SL percentages and PnL", () => {
  assert.equal(gainPct(100, 110, true).toFixed(2), "10.00");
  assert.equal(gainPct(100, 90, true).toFixed(2), "-10.00");
  assert.equal(pnlUsd(100, 110, 2, true), 20);
  assert.equal(pnlUsd(100, 90, 2, true), -20);
});

test("short TP/SL percentages and PnL", () => {
  assert.equal(gainPct(100, 90, false).toFixed(2), "10.00");
  assert.equal(gainPct(100, 110, false).toFixed(2), "-10.00");
  assert.equal(pnlUsd(100, 90, 2, false), 20);
  assert.equal(pnlUsd(100, 110, 2, false), -20);
});

test("ROE is PnL versus isolated margin", () => {
  // 1 unit at 100, 10x → margin 10. $10 profit = 100% ROE.
  assert.equal(roePct(10, 100, 10), 100);
  assert.equal(roePct(-5, 100, 10), -50);
  assert.equal(roePct(10, 0, 10), 0);
});

test("price from percent and from PnL invert", () => {
  const near = (actual: number, expected: number) =>
    assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} !~ ${expected}`);
  near(priceFromPct(200, 10, true, true), 220);
  near(priceFromPct(200, 10, true, false), 180);
  near(priceFromPct(200, 10, false, true), 180);
  near(priceFromPct(200, 10, false, false), 220);
  near(priceFromPnl(200, 20, 2, true, true), 210);
  near(priceFromPnl(200, 20, 2, true, false), 190);
  near(priceFromPnl(200, 20, 2, false, true), 190);
  near(priceFromPnl(200, 20, 2, false, false), 210);
});

test("validateTpSl rejects the wrong side of entry", () => {
  assert.equal(validateTpSl({ isLong: true, entry: 100, tp: 110, sl: 90 }), null);
  assert.equal(validateTpSl({ isLong: false, entry: 100, tp: 90, sl: 110 }), null);
  assert.equal(
    validateTpSl({ isLong: true, entry: 100, tp: 90 }),
    "Take profit must be above entry for a long",
  );
  assert.equal(
    validateTpSl({ isLong: false, entry: 100, sl: 90 }),
    "Stop loss must be above entry for a short",
  );
  assert.equal(
    validateTpSl({ isLong: true, entry: 100, sl: 80, liq: 85 }),
    "Stop loss is at or below liquidation",
  );
});
