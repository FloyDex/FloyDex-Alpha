/**
 * `deployments/*.json` loader plus the on-chain drift check (`11` L3: "two
 * contract sets live at once — v2/v3 split-brain — deposits landed in a vault
 * the matcher didn't settle against. A single deployment.json is the source
 * of truth; services refuse to start if on-chain Exchange doesn't match it").
 *
 * Every service calls `loadDeployment` then `assertDeploymentMatchesChain`
 * before doing anything else. A mismatch is fatal, on purpose: better a
 * service that won't start than one settling fills against the wrong
 * program.
 */
import { readFileSync } from "node:fs";
import { PublicKey, type Connection } from "@solana/web3.js";
import { BorshAccountsCoder, type Idl } from "@coral-xyz/anchor";

export interface DeploymentRecord {
  cluster: string;
  programId: string;
  usdcMint?: string;
  accounts?: {
    exchange?: string;
    market?: string;
    settlementCollateral?: string;
    vault?: string;
    insurance?: string;
    solUsdPushFeed?: string;
    operator?: string;
    calendarAuthority?: string;
    guardian?: string;
  };
  [key: string]: unknown;
}

export class DeploymentFileError extends Error {}
export class DeploymentMismatchError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(`on-chain state does not match deployments file:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "DeploymentMismatchError";
    this.problems = problems;
  }
}

/** Reads and minimally validates a `deployments/*.json` file. Throws on anything a service can't safely start without. */
export function loadDeployment(path: string): DeploymentRecord {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    throw new DeploymentFileError(`cannot read deployment file ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new DeploymentFileError(`${path} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  const rec = parsed as DeploymentRecord;
  if (!rec.programId) throw new DeploymentFileError(`${path} has no "programId"`);
  try {
    new PublicKey(rec.programId);
  } catch {
    throw new DeploymentFileError(`${path}: programId "${rec.programId}" is not a valid pubkey`);
  }
  return rec;
}

/** Derives the `["exchange"]` PDA for a program, matching `programs/kryon-perps/src/state/exchange.rs`. */
export function deriveExchangePda(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("exchange")], programId)[0];
}

interface DecodedExchange {
  admin: PublicKey;
  guardian: PublicKey;
  calendarAuthority: PublicKey;
  settlementMint: PublicKey;
  paused: boolean;
}

/**
 * Pure comparison: given the deployment record and what's actually decoded
 * on-chain, returns every mismatch found (empty = all clear). Kept separate
 * from the RPC calls so it's unit-testable without a validator.
 */
export function compareExchangeState(deployment: DeploymentRecord, onChain: DecodedExchange): string[] {
  const problems: string[] = [];
  const accounts = deployment.accounts ?? {};

  if (accounts.guardian && onChain.guardian.toBase58() !== accounts.guardian) {
    problems.push(`guardian on-chain (${onChain.guardian.toBase58()}) != deployments.json (${accounts.guardian})`);
  }
  if (accounts.calendarAuthority && onChain.calendarAuthority.toBase58() !== accounts.calendarAuthority) {
    problems.push(
      `calendarAuthority on-chain (${onChain.calendarAuthority.toBase58()}) != deployments.json (${accounts.calendarAuthority})`,
    );
  }
  if (deployment.usdcMint && onChain.settlementMint.toBase58() !== deployment.usdcMint) {
    problems.push(`settlementMint on-chain (${onChain.settlementMint.toBase58()}) != deployments.json usdcMint (${deployment.usdcMint})`);
  }
  return problems;
}

/**
 * The full boot-time check: the program is deployed and executable at the
 * declared id, the Exchange PDA exists, and its recorded fields agree with
 * `deployments.json`. Throws `DeploymentMismatchError` (or a plain Error for
 * "not deployed at all") rather than letting the service start against the
 * wrong chain state.
 */
export async function assertDeploymentMatchesChain(opts: {
  connection: Connection;
  idl: Idl;
  deployment: DeploymentRecord;
}): Promise<void> {
  const { connection, idl, deployment } = opts;
  const programId = new PublicKey(deployment.programId);

  const programInfo = await connection.getAccountInfo(programId);
  if (!programInfo?.executable) {
    throw new DeploymentMismatchError([`program ${programId.toBase58()} is not deployed (or not executable) on ${deployment.cluster}`]);
  }

  const exchangePda = deriveExchangePda(programId);
  if (deployment.accounts?.exchange && deployment.accounts.exchange !== exchangePda.toBase58()) {
    throw new DeploymentMismatchError([
      `derived Exchange PDA (${exchangePda.toBase58()}) != deployments.json accounts.exchange (${deployment.accounts.exchange}) — the program id in deployments.json is stale`,
    ]);
  }

  const exchangeInfo = await connection.getAccountInfo(exchangePda);
  if (!exchangeInfo) {
    throw new DeploymentMismatchError([`Exchange PDA ${exchangePda.toBase58()} does not exist on ${deployment.cluster} — has init_exchange run?`]);
  }
  if (!exchangeInfo.owner.equals(programId)) {
    throw new DeploymentMismatchError([`Exchange PDA ${exchangePda.toBase58()} is owned by ${exchangeInfo.owner.toBase58()}, not the declared program ${programId.toBase58()}`]);
  }

  const coder = new BorshAccountsCoder(idl);
  const decoded = coder.decode("exchange", exchangeInfo.data) as DecodedExchange;

  const problems = compareExchangeState(deployment, decoded);
  if (problems.length > 0) throw new DeploymentMismatchError(problems);
}
