import { test } from "node:test";
import assert from "node:assert/strict";
import { validateCallout } from "./callouts";

test("callout needs a side and a real sentence", () => {
  assert.equal(validateCallout("too", "long").ok, false);
  assert.equal(validateCallout("NVDA breaks out on earnings", "maybe").ok, false);
  const ok = validateCallout("  NVDA   breaks out on earnings  ", "long");
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.side, "long");
    assert.equal(ok.text, "NVDA breaks out on earnings");
  }
});
