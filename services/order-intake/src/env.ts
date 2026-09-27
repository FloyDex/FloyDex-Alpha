import type { EnvSpec } from "../../kit/src/env.ts";

export const ORDER_INTAKE_ENV: EnvSpec = {
  RPC_URL: { description: "the Solana RPC endpoint used to check delegates and market state" },
  DATABASE_URL: { description: "the Postgres connection string (services/db)" },
  DEPLOYMENT_FILE: { description: "path to deployments/*.json (11 L3 check)" },
  PORT: {
    description: "the HTTP port to listen on",
    optional: true,
    validate: (v) => (Number.isInteger(Number(v)) && Number(v) > 0 && Number(v) < 65536 ? null : "must be a valid TCP port"),
  },
  ALERT_WEBHOOK_URL: { description: "webhook for intake failures worth paging on (11 L6)", optional: true },
};
