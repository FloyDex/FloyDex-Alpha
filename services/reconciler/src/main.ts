import { Connection } from "@solana/web3.js";
import { PrismaClient } from "@floydex/db";
import { bootEnv } from "../../kit/src/env.ts";
import { createLogger } from "../../kit/src/logger.ts";
import { createAlerter } from "../../kit/src/alerter.ts";
import { loadDeployment } from "../../kit/src/deployments.ts";
import { RECONCILER_ENV } from "./env.ts";
import { reconcileOnce, type ChainStatusSource } from "./reconcile.ts";

async function main() {
  const env = bootEnv(RECONCILER_ENV);
  const logger = createLogger("reconciler");
  const alerter = createAlerter({ webhookUrl: env.ALERT_WEBHOOK_URL, service: "reconciler", logger });
  const deployment = loadDeployment(env.DEPLOYMENT_FILE);
  const prisma = new PrismaClient();
  const connection = new Connection(env.RPC_URL, "confirmed");
  const chain: ChainStatusSource = connection;
  const intervalMs = Number(env.RECONCILER_INTERVAL_MS ?? "1000");
  const maxAttempts = Number(env.RECONCILER_MAX_ATTEMPTS ?? "5");

  logger.info("reconciler starting", { network: deployment.cluster, intervalMs, maxAttempts });

  let running = true;
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      logger.info(`${sig} received, shutting down`);
      running = false;
    });
  }

  let consecutiveErrors = 0;
  let consecutiveStuck = 0;
  while (running) {
    try {
      const result = await reconcileOnce({ prisma, chain, network: deployment.cluster, maxAttempts, logger });
      if (result.confirmed || result.rolledBack || result.retried) {
        logger.info("reconcile pass", { ...result });
      }
      consecutiveErrors = 0;
      // A backlog that never shrinks (every pass finds the same jobs still pending) is worth paging on — the settlement-backlog-age signal the monitor (item i) will also watch.
      consecutiveStuck = result.stillPending > 0 && result.confirmed === 0 && result.rolledBack === 0 && result.retried === 0 ? consecutiveStuck + 1 : 0;
      if (consecutiveStuck === 30) {
        await alerter.alert({ service: "reconciler", severity: "warning", title: "settlement backlog not shrinking", detail: `${result.stillPending} job(s) pending with no confirmations/rollbacks for 30 consecutive passes` });
      }
    } catch (e) {
      consecutiveErrors++;
      const msg = e instanceof Error ? e.message : String(e);
      logger.error("reconcile pass failed", { error: msg, consecutiveErrors });
      if (consecutiveErrors >= 5) {
        await alerter.alert({ service: "reconciler", severity: "critical", title: "reconciler failing repeatedly", detail: msg, fields: { consecutiveErrors } });
      }
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }

  await prisma.$disconnect();
}

main().catch((e) => {
  process.stderr.write(`FATAL: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
  process.exit(1);
});
