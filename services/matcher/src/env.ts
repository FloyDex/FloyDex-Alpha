import type { EnvSpec } from "../../kit/src/env.ts";

export const MATCHER_ENV: EnvSpec = {
  DATABASE_URL: { description: "the Postgres connection string (services/db)" },
  DEPLOYMENT_FILE: { description: "path to deployments/*.json (11 L3 check) — its cluster/network name tags every TxJob this matcher enqueues" },
  MATCHER_INTERVAL_MS: {
    description: "how often to run a match tick, in milliseconds",
    optional: true,
    validate: (v) => (Number.isInteger(Number(v)) && Number(v) > 0 ? null : "must be a positive integer"),
  },
  MATCHER_MAX_DEVIATION_BPS: {
    description: "off-chain oracle-band pre-filter, in bps (the on-chain execution-deviation check is authoritative regardless)",
    optional: true,
    validate: (v) => (Number.isInteger(Number(v)) && Number(v) > 0 && Number(v) <= 10_000 ? null : "must be a positive integer <= 10000"),
  },
  ALERT_WEBHOOK_URL: { description: "webhook for tick failures worth paging on (11 L6)", optional: true },
};
