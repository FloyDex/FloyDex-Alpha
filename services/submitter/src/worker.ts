/**
 * One submit cycle: claim queued `settle_fill` jobs for a market, decode the
 * on-chain accounts they touch, build a `settle_fills` transaction (packing
 * a 2nd same-market fill in when it fits `PACKET_DATA_SIZE`), sign it,
 * persist its signature + expiry (the idempotency anchor, `claim.ts`), then
 * send it. Never awaits confirmation — that's the reconciler's job (item e),
 * kept a separate process on purpose so a slow/stuck confirmation can never
 * block this worker from claiming the next job.
 */
import anchorPkg from "@coral-xyz/anchor";
import { Connection, Keypair, PACKET_DATA_SIZE, PublicKey, TransactionMessage, VersionedTransaction, type AddressLookupTableAccount } from "@solana/web3.js";
import type { PrismaClient } from "@kryon/db";
import type { Logger } from "../../kit/src/logger.ts";
import { claimSettleFillJobs, recordPendingSend, releaseJob, type ClaimedJob } from "./claim.ts";
import { buildFillPlan, settleFillsStaticAccounts, insurancePda, type BuildInputs, type UserContext } from "./build.ts";
import { accountNamespace, userPda, type ChainDirectory } from "./accounts.ts";
import { computePriorityFeeMicroLamports, type PriorityFeeConfig } from "./priorityFee.ts";

const { Program, utils: anchorUtils } = anchorPkg as unknown as typeof import("@coral-xyz/anchor");
type AnchorProgram = InstanceType<typeof Program>;

export interface WorkerDeps {
  prisma: PrismaClient;
  connection: Connection;
  program: AnchorProgram;
  network: string;
  operator: Keypair;
  exchange: PublicKey;
  settlementCollateral: PublicKey;
  /** Whether this market has `oi_policy_bps > 0` (the `insurance` account is then required, `SettleFills.insurance`). */
  marketNeedsInsurance: Map<number, boolean>;
  dir: ChainDirectory;
  computeUnitLimit: number;
  priorityFeeConfig: PriorityFeeConfig;
  lookupTable: AddressLookupTableAccount | null;
  logger: Logger;
}

let cachedExchange: { domain: Uint8Array; settlementIndex: number } | null = null;

/** The exchange's signing domain (`sha256(genesis_hash || program_id)`) and `settlement_collateral_index`, fetched once and cached — neither changes for a given deployment. */
export async function getExchangeContext(deps: Pick<WorkerDeps, "program" | "exchange">): Promise<{ domain: Uint8Array; settlementIndex: number }> {
  if (cachedExchange) return cachedExchange;
  const ex = (await accountNamespace(deps.program)["exchange"]!.fetch(deps.exchange)) as unknown as { domain: number[]; settlement_collateral_index: number };
  cachedExchange = { domain: Uint8Array.from(ex.domain), settlementIndex: ex.settlement_collateral_index };
  return cachedExchange;
}

/** Test-only: clears the cached exchange context between fixtures. */
export function _resetExchangeContextCache(): void {
  cachedExchange = null;
}

async function decodeUsers(program: AnchorProgram, programId: PublicKey, owners: { owner: string; subId: number }[]): Promise<Map<string, UserContext>> {
  const out = new Map<string, UserContext>();
  for (const { owner, subId } of owners) {
    const key = `${owner}:${subId}`;
    if (out.has(key)) continue;
    const pda = userPda(programId, new PublicKey(owner), subId);
    const account = (await accountNamespace(program)["userAccount"]!.fetch(pda)) as unknown as UserContext["account"];
    out.set(key, { account });
  }
  return out;
}

/** Fits as many of `jobs` (already same-market) as pass `PACKET_DATA_SIZE` once actually serialized, trying 2 before falling back to 1 (roadmap item d: "1–2 fills per tx, whatever fits, measure it"). */
async function packAndSend(deps: WorkerDeps, marketId: number, jobs: ClaimedJob[]): Promise<{ sent: ClaimedJob[]; leftover: ClaimedJob[] } | null> {
  const marketRef = deps.dir.markets.get(marketId);
  if (!marketRef) throw new Error(`market ${marketId} not in chain directory`);
  const needsInsurance = deps.marketNeedsInsurance.get(marketId) ?? false;

  const { domain, settlementIndex } = await getExchangeContext(deps);
  const samples = await deps.connection.getRecentPrioritizationFees({ lockedWritableAccounts: [marketRef.marketPda] }).catch(() => []);
  const priorityFeeMicroLamports = computePriorityFeeMicroLamports(samples, deps.priorityFeeConfig);

  for (const tryCount of jobs.length >= 2 ? [2, 1] : [1]) {
    const batch = jobs.slice(0, tryCount);
    const owners = batch.flatMap((j) => [
      { owner: j.payload.maker.owner, subId: j.payload.maker.subId },
      { owner: j.payload.taker.owner, subId: j.payload.taker.subId },
    ]);
    const users = await decodeUsers(deps.program, deps.program.programId, owners);

    const buildInput: BuildInputs = {
      programId: deps.program.programId,
      dir: deps.dir,
      domain,
      operator: deps.operator.publicKey,
      exchange: deps.exchange,
      market: marketRef.marketPda,
      priceUpdate: marketRef.priceUpdate,
      settlementCollateral: deps.settlementCollateral,
      insurance: needsInsurance ? insurancePda(deps.program.programId) : null,
      computeUnitLimit: deps.computeUnitLimit,
      priorityFeeMicroLamports,
      settlementIndex,
      fills: batch.map((j) => j.payload),
      users,
    };
    const plan = buildFillPlan(buildInput);
    const settleIx = await deps.program.methods
      .settleFills(plan.fillArgs)
      // Cast: `program` is built from the raw JSON IDL (no generated per-instruction
      // account type), so TS can't verify `insurance: PublicKey | null` (an Option<Account>)
      // against its loosened `Accounts<IdlInstructionAccountItem>` type — the same gap
      // `accountNamespace` papers over for account fetches.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .accountsStrict(settleFillsStaticAccounts(buildInput) as any)
      .remainingAccounts(plan.remainingAccounts)
      .instruction();

    const { blockhash, lastValidBlockHeight } = await deps.connection.getLatestBlockhash("confirmed");
    const message = new TransactionMessage({
      payerKey: deps.operator.publicKey,
      recentBlockhash: blockhash,
      instructions: [...plan.computeIxs, plan.ed25519Ix, settleIx],
    }).compileToV0Message(deps.lookupTable ? [deps.lookupTable] : []);
    const tx = new VersionedTransaction(message);
    tx.sign([deps.operator]);
    const serialized = tx.serialize();

    if (serialized.length > PACKET_DATA_SIZE && tryCount > 1) continue; // doesn't fit with 2 — fall back to 1.
    if (serialized.length > PACKET_DATA_SIZE) throw new Error(`settle_fills transaction too large even at 1 fill: ${serialized.length} bytes`);

    const signature = anchorUtils.bytes.bs58.encode(tx.signatures[0]!);
    await recordPendingSend(deps.prisma, batch.map((j) => j.id), signature, lastValidBlockHeight, Buffer.from(serialized).toString("base64"));

    await deps.connection.sendRawTransaction(serialized, { skipPreflight: true, maxRetries: 0 });
    deps.logger.info("sent settle_fills", { marketId, jobs: batch.map((j) => j.id.toString()), fills: batch.length, signature, bytes: serialized.length });
    return { sent: batch, leftover: jobs.slice(tryCount) };
  }
  return null;
}

/** One poll: claims up to 2 jobs for `marketId` and sends them, or returns 0 if none were queued. Failures release claimed jobs back to QUEUED with backoff rather than leaving them stuck SUBMITTED-but-unsent. */
export async function submitOnce(deps: WorkerDeps, marketId: number): Promise<number> {
  const jobs = await claimSettleFillJobs(deps.prisma, deps.network, marketId, 2);
  if (jobs.length === 0) return 0;
  try {
    const result = await packAndSend(deps, marketId, jobs);
    if (!result) return 0;
    if (result.leftover.length > 0) {
      // The 2nd job didn't fit this tx — release it, unsent, for the next poll.
      for (const j of result.leftover) await releaseJob(deps.prisma, j.id, "did not fit in this batch", 0);
    }
    return result.sent.length;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    deps.logger.error("submit failed, releasing claimed jobs", { marketId, jobs: jobs.map((j) => j.id.toString()), error: msg });
    for (const j of jobs) await releaseJob(deps.prisma, j.id, msg, 2_000);
    throw e;
  }
}
