import { test } from "node:test";
import assert from "node:assert/strict";
import { createLogger } from "../src/logger.ts";

function captureOut() {
  const lines: string[] = [];
  return { out: { write: (line: string) => lines.push(line) }, lines };
}

test("createLogger emits one JSON object per line with service, level and msg", () => {
  const { out, lines } = captureOut();
  const log = createLogger("matcher", { out, env: {} });
  log.info("started", { marketId: 1 });
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.service, "matcher");
  assert.equal(parsed.level, "info");
  assert.equal(parsed.msg, "started");
  assert.equal(parsed.marketId, 1);
  assert.ok(parsed.ts);
});

test("LOG_LEVEL filters below-threshold lines", () => {
  const { out, lines } = captureOut();
  const log = createLogger("matcher", { out, env: { LOG_LEVEL: "warn" } });
  log.debug("noisy");
  log.info("still noisy");
  log.warn("this one shows");
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).msg, "this one shows");
});

test("child() merges its fields into every subsequent line", () => {
  const { out, lines } = captureOut();
  const log = createLogger("matcher", { out, env: {} }).child({ marketId: 7 });
  log.info("fill");
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.marketId, 7);
});
