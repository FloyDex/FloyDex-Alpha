import { test } from "node:test";
import assert from "node:assert/strict";
import {
  aggressiveMarketLimit,
  baseSizeFromInput,
  nextTicketSizeMode,
  sanitizeQuickSize,
  sizeFromBuyingPowerPct,
} from "./quick-market";

test("quick size sanitizes digits and a single decimal", () => {
  assert.equal(sanitizeQuickSize("1,200.50abc"), "1200.50");
  assert.equal(sanitizeQuickSize("0.25"), "0.25");
  assert.equal(sanitizeQuickSize("1.2.3"), "1.23");
});

test("size modes convert to base at the mark", () => {
  assert.equal(baseSizeFromInput(83000, "quote", 83000, 10), 1);
  assert.equal(baseSizeFromInput(0.5, "base", 83000, 10), 0.5);
  assert.equal(baseSizeFromInput(100, "quote", 0, 10), 0);
  // $10 margin at 10x → $100 notional → 100/83000 base
  assert.equal(baseSizeFromInput(10, "margin", 83000, 10), 100 / 83000);
});

test("size mode cycles base → quote → margin", () => {
  assert.equal(nextTicketSizeMode("base"), "quote");
  assert.equal(nextTicketSizeMode("quote"), "margin");
  assert.equal(nextTicketSizeMode("margin"), "base");
});

test("market buys cross 2x mark and sells 0.5x", () => {
  const mark = 100n;
  assert.equal(aggressiveMarketLimit(mark, "buy"), 200n);
  assert.equal(aggressiveMarketLimit(mark, "sell"), 50n);
  assert.equal(aggressiveMarketLimit(0n, "sell"), 1n);
});

test("buying-power percent fills margin, quote notional, or base size", () => {
  assert.equal(
    sizeFromBuyingPowerPct({
      availableHuman: 100,
      leverage: 10,
      pct: 50,
      execPrice: 50_000,
      sizeMode: "margin",
    }),
    "50.00",
  );
  assert.equal(
    sizeFromBuyingPowerPct({
      availableHuman: 100,
      leverage: 10,
      pct: 50,
      execPrice: 50_000,
      sizeMode: "quote",
    }),
    "500.00",
  );
  assert.equal(
    sizeFromBuyingPowerPct({
      availableHuman: 100,
      leverage: 10,
      pct: 100,
      execPrice: 50_000,
      sizeMode: "base",
    }),
    "0.0200",
  );
});
