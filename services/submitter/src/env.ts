import type { EnvSpec } from "../../kit/src/env.ts";

export const SUBMITTER_ENV: EnvSpec = {
  DATABASE_URL: { description: "the Postgres connection string (services/db)" },
  DEPLOYMENT_FILE: { description: "path to deployments/*.json (11 L3 check)" },
  RPC_URL: { description: "Solana RPC endpoint the submitter sends transactions to (Helius/Triton in prod — never the public devnet RPC, 06 §8)" },
  OPERATOR_KEYPAIR_FILE: {
    description: "path to the operator keypair JSON (gitignored) that pays settle_fills rent and signs every submitted transaction",
    secret: true,
  },
  SUBMITTER_WORKERS: {
    description: "number of concurrent claim/build/send workers",
    optional: true,
    validate: (v) => (Number.isInteger(Number(v)) && Number(v) > 0 ? null : "must be a positive integer"),
  },
  SUBMITTER_INTERVAL_MS: {
    description: "how often an idle worker polls for a new QUEUED job, in milliseconds",
    optional: true,
    validate: (v) => (Number.isInteger(Number(v)) && Number(v) > 0 ? null : "must be a positive integer"),
  },
  SUBMITTER_COMPUTE_UNIT_LIMIT: {
    description: "compute unit limit set on every settle_fills transaction",
    optional: true,
    validate: (v) => (Number.isInteger(Number(v)) && Number(v) > 0 ? null : "must be a positive integer"),
  },
  SUBMITTER_MIN_PRIORITY_FEE_MICROLAMPORTS: {
    description: "floor priority fee (microLamports/CU) applied even with no recent fee data",
    optional: true,
    validate: (v) => (Number.isInteger(Number(v)) && Number(v) >= 0 ? null : "must be a non-negative integer"),
  },
  SUBMITTER_MAX_PRIORITY_FEE_MICROLAMPORTS: {
    description: "hard cap on the priority fee (microLamports/CU) — never exceeded regardless of cluster congestion",
    optional: true,
    validate: (v) => (Number.isInteger(Number(v)) && Number(v) > 0 ? null : "must be a positive integer"),
  },
  SUBMITTER_LOOKUP_TABLE: {
    description: "address lookup table pubkey (from scripts/submitter/lookup-table.mts), used to compress repeated accounts into a v0 transaction",
    optional: true,
  },
  ALERT_WEBHOOK_URL: { description: "webhook for repeated submit failures worth paging on (11 L6)", optional: true },
};
