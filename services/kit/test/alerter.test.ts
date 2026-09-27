import { test } from "node:test";
import assert from "node:assert/strict";
import { createAlerter } from "../src/alerter.ts";
import { createLogger } from "../src/logger.ts";

function silentLogger() {
  return createLogger("test", { out: { write: () => {} }, env: {} });
}

test("alert() POSTs to the webhook URL with the alert payload", async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  const alerter = createAlerter({
    webhookUrl: "https://hooks.example/x",
    service: "monitor",
    logger: silentLogger(),
    fetchImpl: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return { ok: true, status: 200 };
    },
  });
  await alerter.alert({ service: "monitor", severity: "critical", title: "feed stale", detail: "SOL/USD 90s old" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://hooks.example/x");
  assert.equal((calls[0].body as { severity: string }).severity, "critical");
  assert.match((calls[0].body as { text: string }).text, /feed stale/);
});

test("alert() never throws when no webhook is configured", async () => {
  const alerter = createAlerter({ service: "monitor", logger: silentLogger() });
  await assert.doesNotReject(() => alerter.alert({ service: "monitor", severity: "info", title: "hi" }));
});

test("alert() never throws when the webhook delivery fails", async () => {
  const alerter = createAlerter({
    webhookUrl: "https://hooks.example/x",
    service: "monitor",
    logger: silentLogger(),
    fetchImpl: async () => {
      throw new Error("ECONNREFUSED");
    },
  });
  await assert.doesNotReject(() => alerter.alert({ service: "monitor", severity: "warning", title: "hi" }));
});
