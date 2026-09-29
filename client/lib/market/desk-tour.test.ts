import { test } from "node:test";
import assert from "node:assert/strict";
import { DESK_TOUR_STEPS } from "./desk-tour";

test("desk tour walks the six desk regions in order", () => {
  assert.deepEqual(
    DESK_TOUR_STEPS.map((s) => s.id),
    ["pair", "tape", "chart", "book", "ticket", "pos"],
  );
  for (const [i, step] of DESK_TOUR_STEPS.entries()) {
    assert.match(step.title, new RegExp(`^${i + 1}\\.`));
    assert.ok(step.body.length > 40);
  }
});
