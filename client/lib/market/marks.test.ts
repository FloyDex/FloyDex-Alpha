import { test } from "node:test";
import assert from "node:assert/strict";
import { pickYahooLivePrice, downsampleSpark } from "./marks";

test("pickYahooLivePrice prefers the newest extended-hours print", () => {
  const fridayClose = 1_790_366_400; // 2026-09-25 20:00 UTC
  const premarket = 1_790_593_800; // 2026-09-28 11:10 UTC
  const live = pickYahooLivePrice({
    lastBarClose: 369.68,
    lastBarTime: premarket,
    regularMarketPrice: 372.11,
    regularMarketTime: fridayClose,
  });
  assert.equal(live?.price, 369.68);
  assert.equal(live?.asOf, premarket * 1000);
});

test("pickYahooLivePrice falls back to regular last when no 1m bar", () => {
  const live = pickYahooLivePrice({
    regularMarketPrice: 372.11,
    regularMarketTime: 1_790_366_400,
  });
  assert.equal(live?.price, 372.11);
});

test("downsampleSpark drops non-positive values and keeps short series", () => {
  assert.deepEqual(downsampleSpark([0, null, 1, 2, undefined, 3], 24), [1, 2, 3]);
});

test("downsampleSpark keeps first and last of a long series", () => {
  const src = Array.from({ length: 100 }, (_, i) => i + 1);
  const out = downsampleSpark(src, 24);
  assert.equal(out.length, 24);
  assert.equal(out[0], 1);
  assert.equal(out[23], 100);
});
