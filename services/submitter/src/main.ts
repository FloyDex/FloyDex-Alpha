import { readFileSync } from "node:fs";
import anchorPkg from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, type AddressLookupTableAccount } from "@solana/web3.js";
import { PrismaClient } from "@floydex/db";
import { bootEnv } from "../../kit/src/env.ts";
import { createLogger } from "../../kit/src/logger.ts";
import { createAlerter } from "../../kit/src/alerter.ts";
import { loadDeployment } from "../../kit/src/deployments.ts";
import { SUBMITTER_ENV } from "./env.ts";
import { accountNamespace, loadChainDirectory } from "./accounts.ts";
import { submitOnce, type WorkerDeps } from "./worker.ts";

const { AnchorProvider, Program, Wallet } = anchorPkg as unknown as typeof import("@coral-xyz/anchor");

function loadKeypair(path: string): Keypair {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

async function main() {
  const env = bootEnv(SUBMITTER_ENV);
  const logger = createLogger("submitter");
  const alerter = createAlerter({ webhookUrl: env.ALERT_WEBHOOK_URL, service: "submitter", logger });
  const deployment = loadDeployment(env.DEPLOYMENT_FILE);
  const prisma = new PrismaClient();
  const connection = new Connection(env.RPC_URL, "confirmed");
  const operator = loadKeypair(env.OPERATOR_KEYPAIR_FILE);
  const programId = new PublicKey(deployment.programId);
  const idl = JSON.parse(readFileSync("target/idl/floydex_perps.json", "utf8"));
  const provider = new AnchorProvider(connection, new Wallet(operator), { commitment: "confirmed" });
  const program = new Program(idl, provider);

  let lookupTable: AddressLookupTableAccount | null = null;
  if (env.SUBMITTER_LOOKUP_TABLE) {
    const res = await connection.getAddressLookupTable(new PublicKey(env.SUBMITTER_LOOKUP_TABLE));
    lookupTable = res.value;
    if (!lookupTable) logger.warn("SUBMITTER_LOOKUP_TABLE set but not found on-chain — sending without it", { table: env.SUBMITTER_LOOKUP_TABLE });
  }

  const workers = Number(env.SUBMITTER_WORKERS ?? "4");
  const intervalMs = Number(env.SUBMITTER_INTERVAL_MS ?? "250");
  const computeUnitLimit = Number(env.SUBMITTER_COMPUTE_UNIT_LIMIT ?? "300000");
  const priorityFeeConfig = {
    minMicroLamports: Number(env.SUBMITTER_MIN_PRIORITY_FEE_MICROLAMPORTS ?? "0"),
    maxMicroLamports: Number(env.SUBMITTER_MAX_PRIORITY_FEE_MICROLAMPORTS ?? "50000"),
  };

  logger.info("submitter starting", { network: deployment.cluster, workers, intervalMs, operator: operator.publicKey.toBase58() });

  let running = true;
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      logger.info(`${sig} received, shutting down`);
      running = false;
    });
  }

  async function refreshDirectory() {
    const markets = await prisma.market.findMany({ where: { active: true }, select: { id: true } });
    const marketIds = markets.map((m) => m.id);
    const dir = await loadChainDirectory(program, marketIds, []);
    const marketNeedsInsurance = new Map<number, boolean>();
    for (const id of marketIds) {
      const m = (await accountNamespace(program)["market"]!.fetch(dir.markets.get(id)!.marketPda)) as unknown as { oi_policy_bps: number };
      marketNeedsInsurance.set(id, m.oi_policy_bps > 0);
    }
    return { marketIds, dir, marketNeedsInsurance };
  }

  let { marketIds, dir, marketNeedsInsurance } = await refreshDirectory();
  let lastRefresh = Date.now();

  let consecutiveErrors = 0;
  async function runWorker(workerId: number) {
    while (running) {
      if (Date.now() - lastRefresh > 30_000) {
        try {
          ({ marketIds, dir, marketNeedsInsurance } = await refreshDirectory());
          lastRefresh = Date.now();
        } catch (e) {
          logger.warn("directory refresh failed, keeping stale directory", { workerId, error: e instanceof Error ? e.message : String(e) });
        }
      }
      let sentAny = false;
      for (const marketId of marketIds) {
        const deps: WorkerDeps = {
          prisma,
          connection,
          program,
          network: deployment.cluster,
          operator,
          exchange: new PublicKey(deployment.accounts?.exchange ?? ""),
          settlementCollateral: new PublicKey(deployment.accounts?.settlementCollateral ?? ""),
          marketNeedsInsurance,
          dir,
          computeUnitLimit,
          priorityFeeConfig,
          lookupTable,
          logger: logger.child({ workerId }),
        };
        try {
          const sent = await submitOnce(deps, marketId);
          if (sent > 0) sentAny = true;
          consecutiveErrors = 0;
        } catch (e) {
          consecutiveErrors++;
          if (consecutiveErrors % 10 === 0) {
            await alerter.alert({
              service: "submitter",
              severity: "critical",
              title: "submitter failing repeatedly",
              detail: e instanceof Error ? e.message : String(e),
              fields: { consecutiveErrors, marketId },
            });
          }
        }
      }
      if (!sentAny) await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  await Promise.all(Array.from({ length: workers }, (_, i) => runWorker(i)));
  await prisma.$disconnect();
}

main().catch((e) => {
  process.stderr.write(`FATAL: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
  process.exit(1);
});
