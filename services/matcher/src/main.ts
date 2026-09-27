import { PrismaClient } from "@kryon/db";
import { bootEnv } from "../../kit/src/env.ts";
import { createLogger } from "../../kit/src/logger.ts";
import { createAlerter } from "../../kit/src/alerter.ts";
import { loadDeployment } from "../../kit/src/deployments.ts";
import { tick, type TickDeps } from "./tick.ts";
import { MATCHER_ENV } from "./env.ts";

async function main() {
  const env = bootEnv(MATCHER_ENV);
  const logger = createLogger("matcher");
  const alerter = createAlerter({ webhookUrl: env.ALERT_WEBHOOK_URL, service: "matcher", logger });
  const deployment = loadDeployment(env.DEPLOYMENT_FILE);
  const prisma = new PrismaClient();

  const deps: TickDeps = {
    prisma,
    network: deployment.cluster,
    maxDeviationBps: BigInt(env.MATCHER_MAX_DEVIATION_BPS ?? "1000"),
    logger,
  };
  const intervalMs = Number(env.MATCHER_INTERVAL_MS ?? "1000");

  logger.info("matcher starting", { network: deps.network, intervalMs, maxDeviationBps: deps.maxDeviationBps.toString() });

  let running = true;
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, async () => {
      logger.info(`${sig} received, shutting down`);
      running = false;
    });
  }

  let consecutiveErrors = 0;
  while (running) {
    try {
      const markets = await prisma.market.findMany({ where: { active: true }, select: { id: true } });
      const queued = await tick(deps, markets.map((m) => m.id));
      if (queued > 0) logger.info("tick complete", { queued });
      consecutiveErrors = 0;
    } catch (e) {
      consecutiveErrors++;
      const msg = e instanceof Error ? e.message : String(e);
      logger.error("tick failed", { error: msg, consecutiveErrors });
      if (consecutiveErrors >= 5) {
        await alerter.alert({ service: "matcher", severity: "critical", title: "matcher tick failing repeatedly", detail: msg, fields: { consecutiveErrors } });
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
