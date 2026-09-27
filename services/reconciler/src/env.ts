import type { EnvSpec } from "../../kit/src/env.ts";

export const RECONCILER_ENV: EnvSpec = {
  DATABASE_URL: { description: "the Postgres connection string (services/db)" },
  DEPLOYMENT_FILE: { description: "path to deployments/*.json (11 L3 check) — its cluster/network name tags every TxJob this reconciles" },
  RPC_URL: { description: "Solana RPC endpoint used to check signature status and current block height" },
  RECONCILER_INTERVAL_MS: {
    description: "how often to run a reconciliation pass, in milliseconds",
    optional: true,
    validate: (v) => (Number.isInteger(Number(v)) && Number(v) > 0 ? null : "must be a positive integer"),
  },
  RECONCILER_MAX_ATTEMPTS: {
    description: "how many send attempts a settle_fill job gets before an otherwise-still-valid job is rolled back instead of retried",
    optional: true,
    validate: (v) => (Number.isInteger(Number(v)) && Number(v) > 0 ? null : "must be a positive integer"),
  },
  ALERT_WEBHOOK_URL: { description: "webhook for a rising stuck/rolled-back-job count worth paging on (11 L6)", optional: true },
};
