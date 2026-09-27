import { test } from "node:test";
import assert from "node:assert/strict";
import { loadEnv, EnvValidationError } from "../src/env.ts";

test("loadEnv returns values when everything is set and valid", () => {
  const { values, warnings } = loadEnv(
    { RPC_URL: { description: "the RPC endpoint" } },
    { RPC_URL: "https://api.devnet.solana.com" },
  );
  assert.equal(values.RPC_URL, "https://api.devnet.solana.com");
  assert.deepEqual(warnings, []);
});

test("loadEnv reports every missing var in one error, not just the first", () => {
  const spec = {
    RPC_URL: { description: "the RPC endpoint" },
    DATABASE_URL: { description: "the Postgres connection string" },
  };
  assert.throws(
    () => loadEnv(spec, {}),
    (e: unknown) => {
      assert.ok(e instanceof EnvValidationError);
      assert.equal(e.problems.length, 2);
      assert.match(e.problems[0], /RPC_URL/);
      assert.match(e.problems[1], /DATABASE_URL/);
      return true;
    },
  );
});

test("loadEnv rejects an obvious placeholder value", () => {
  assert.throws(
    () => loadEnv({ RPC_URL: { description: "x" } }, { RPC_URL: "<paste your devnet RPC URL here>" }),
    EnvValidationError,
  );
});

test("loadEnv skips missing optional vars without error", () => {
  const { values } = loadEnv({ ALERT_WEBHOOK_URL: { description: "optional webhook", optional: true } }, {});
  assert.equal(values.ALERT_WEBHOOK_URL, undefined);
});

test("loadEnv rejects a too-short secret and warns on a known test-key prefix", () => {
  assert.throws(() => loadEnv({ OPERATOR_KEY: { description: "x", secret: true } }, { OPERATOR_KEY: "abc" }), EnvValidationError);

  const { warnings } = loadEnv({ OPERATOR_KEY: { description: "x", secret: true } }, { OPERATOR_KEY: "SCZANGBAxxxxxxxxxxxxxxxx" });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /known test-key prefix/);
});

test("loadEnv runs a custom validator", () => {
  const spec = { PORT: { description: "http port", validate: (v: string) => (Number.isNaN(Number(v)) ? "not a number" : null) } };
  assert.throws(() => loadEnv(spec, { PORT: "not-a-port" }), EnvValidationError);
  const { values } = loadEnv(spec, { PORT: "8080" });
  assert.equal(values.PORT, "8080");
});
