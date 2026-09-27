import { Connection, PublicKey } from "@solana/web3.js";
import { PrismaClient } from "@kryon/db";
import { bootEnv } from "../../kit/src/env.ts";
import { createLogger } from "../../kit/src/logger.ts";
import { createAlerter } from "../../kit/src/alerter.ts";
import { loadDeployment, assertDeploymentMatchesChain } from "../../kit/src/deployments.ts";
import { computeDomain } from "../../../sdk/src/order.ts";
import { readFileSync } from "node:fs";
import { createServer } from "./server.ts";
import { ORDER_INTAKE_ENV } from "./env.ts";

async function main() {
  const env = bootEnv(ORDER_INTAKE_ENV);
  const logger = createLogger("order-intake");
  const alerter = createAlerter({ webhookUrl: env.ALERT_WEBHOOK_URL, service: "order-intake", logger });

  const deployment = loadDeployment(env.DEPLOYMENT_FILE);
  const connection = new Connection(env.RPC_URL, "confirmed");
  const idl = JSON.parse(readFileSync(new URL("../../../target/idl/kryon_perps.json", import.meta.url), "utf8"));

  // 11 L3: refuse to start against stale or split-brain chain state.
  await assertDeploymentMatchesChain({ connection, idl, deployment });
  logger.info("deployment verified against chain", { cluster: deployment.cluster, programId: deployment.programId });

  const genesisHash = (deployment as { genesisHash?: string }).genesisHash;
  if (!genesisHash) throw new Error(`${env.DEPLOYMENT_FILE} has no "genesisHash" — run the devnet gate first`);
  // genesisHash is base58 (like a pubkey), matching tests/e2e/devnet.mts.
  const domain = computeDomain(new PublicKey(genesisHash).toBytes(), new PublicKey(deployment.programId).toBytes());

  const prisma = new PrismaClient();
  const server = createServer({ connection, prisma, idl, programId: new PublicKey(deployment.programId), domain, logger, alerter });

  const port = Number(env.PORT ?? 8081);
  server.listen(port, () => logger.info(`order-intake listening on :${port}`));

  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, async () => {
      logger.info(`${sig} received, shutting down`);
      server.close();
      await prisma.$disconnect();
      process.exit(0);
    });
  }
}

main().catch((e) => {
  process.stderr.write(`FATAL: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  process.exit(1);
});
