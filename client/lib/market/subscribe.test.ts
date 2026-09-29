import { test } from "node:test";
import assert from "node:assert/strict";
import { addSubscriber, isValidEmail, normalizeEmail, type SubscriberState } from "./subscribe";

test("emails are trimmed and lowercased", () => {
  assert.equal(normalizeEmail("  Ada@FloyDex.xyz  "), "ada@floydex.xyz");
  assert.equal(isValidEmail("ada@floydex.xyz"), true);
  assert.equal(isValidEmail("not-an-email"), false);
  assert.equal(isValidEmail(""), false);
});

test("new address is recorded once", () => {
  const state: SubscriberState = { emails: [] };
  const first = addSubscriber(state, "  Ada@FloyDex.xyz ", 1);
  assert.equal(first.ok, true);
  if (first.ok) {
    assert.equal(first.created, true);
    assert.equal(first.email, "ada@floydex.xyz");
  }
  const again = addSubscriber(state, "ada@floydex.xyz", 2);
  assert.equal(again.ok, true);
  if (again.ok) assert.equal(again.created, false);
  assert.equal(state.emails.length, 1);
  assert.equal(state.emails[0].at, 1);
});

test("rejects a bad address without writing", () => {
  const state: SubscriberState = { emails: [] };
  const bad = addSubscriber(state, "hello");
  assert.equal(bad.ok, false);
  assert.equal(state.emails.length, 0);
});
