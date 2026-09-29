import { test } from "node:test";
import assert from "node:assert/strict";
import {
  STAKE_TERMS,
  compactKry,
  formatApy,
  quoteStake,
  termByDays,
} from "./stake";

test("OpenGap-style term yield is percent of principal, not calendar APY", () => {
  const q = quoteStake(1000, termByDays(30)!, 0);
  assert.ok(q);
  assert.equal(q.reward, 150);
  assert.equal(q.receive, 1150);
  assert.equal(q.unlockAt, 30 * 86_400_000);
  assert.equal(formatApy(q.apy), "15%");
});

test("every advertised term quotes the screenshot ladder on 1000", () => {
  const expected: Record<number, number> = { 7: 1035, 30: 1150, 90: 1450, 180: 1900, 360: 2800 };
  for (const term of STAKE_TERMS) {
    const q = quoteStake(1000, term, 0);
    assert.equal(q?.receive, expected[term.days]);
  }
  assert.equal(formatApy(0.035), "3.5%");
  assert.equal(formatApy(1.8), "180%");
});

test("quote rejects empty size", () => {
  assert.equal(quoteStake(0, STAKE_TERMS[0]), null);
  assert.equal(quoteStake(-1, STAKE_TERMS[0]), null);
  assert.equal(termByDays(12), null);
});

test("compact total uses millions", () => {
  assert.equal(compactKry(1_380_000), "1.38M");
});
