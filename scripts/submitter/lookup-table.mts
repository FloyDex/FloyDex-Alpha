/**
 * One-time (then rerun-on-demand) address lookup table maintenance for the
 * submitter (roadmap Phase 3 item d): creates the table if
 * `deployments/<network>.json` has none recorded yet, extends it with any
 * address in `addressesFor()` it doesn't already hold, and writes the
 * table's pubkey back to `accounts.lookupTable`.
 *
 * Run manually (not at service boot — extending a lookup table costs SOL
 * and rent, and should happen deliberately, e.g. after adding a market):
 *
 *   node --experimental-strip-types scripts/submitter/lookup-table.mts <deployments/devnet.json>
 */
import { readFileSync, writeFileSync } from "node:fs";
import anchorPkg from "@coral-xyz/anchor";
import {
  AddressLookupTableProgram,
  Connection,
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { PrismaClient } from "../../services/db/src/index.ts";
import { exchangePda, eventAuthorityPda, insurancePda, loadChainDirectory } from "../../services/submitter/src/accounts.ts";

const { AnchorProvider, Program, Wallet } = anchorPkg as unknown as typeof import("@coral-xyz/anchor");

interface Deployment {
  cluster: string;
  programId: string;
  rpc?: string;
  accounts?: { exchange?: string; settlementCollateral?: string; lookupTable?: string };
}

/**
 * Every address worth compressing into the lookup table: it's shared by
 * every `settle_fills` transaction regardless of which two users are
 * trading, so putting it in the table (32 bytes -> 1 byte per reference)
 * is what buys the room `buildFillPlan`'s 2-fill packing needs.
 */
export function addressesFor(programId: PublicKey, deployment: Deployment, marketPythFeeds: { marketPda: PublicKey; priceUpdate: PublicKey }[]): PublicKey[] {
  const out = [
    programId,
    exchangePda(programId),
    eventAuthorityPda(programId),
    insurancePda(programId),
    SystemProgram.programId,
  ];
  if (deployment.accounts?.settlementCollateral) out.push(new PublicKey(deployment.accounts.settlementCollateral));
  for (const m of marketPythFeeds) out.push(m.marketPda, m.priceUpdate);
  return out;
}

async function main() {
  const path = process.argv[2];
  if (!path) throw new Error("usage: lookup-table.mts <deployments/*.json>");
  const deployment = JSON.parse(readFileSync(path, "utf8")) as Deployment;
  const programId = new PublicKey(deployment.programId);
  const connection = new Connection(process.env.RPC_URL ?? `https://api.${deployment.cluster}.solana.com`, "confirmed");
  const authority = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(process.env.OPERATOR_KEYPAIR_FILE!, "utf8"))));

  const idl = JSON.parse(readFileSync("target/idl/floydex_perps.json", "utf8"));
  const provider = new AnchorProvider(connection, new Wallet(authority), { commitment: "confirmed" });
  const program = new Program(idl, provider);

  const prisma = new PrismaClient();
  const markets = await prisma.market.findMany({ where: { active: true } });
  await prisma.$disconnect();
  const dir = await loadChainDirectory(program, markets.map((m) => m.id), []);
  const marketRefs = [...dir.markets.values()];

  const wanted = addressesFor(programId, deployment, marketRefs);

  let table = deployment.accounts?.lookupTable ? new PublicKey(deployment.accounts.lookupTable) : null;
  if (!table) {
    const slot = await connection.getSlot("finalized");
    const [ix, addr] = AddressLookupTableProgram.createLookupTable({ authority: authority.publicKey, payer: authority.publicKey, recentSlot: slot });
    await sendAndConfirmTransaction(connection, new Transaction().add(ix), [authority]);
    table = addr;
    deployment.accounts = { ...deployment.accounts, lookupTable: table.toBase58() };
    writeFileSync(path, JSON.stringify(deployment, null, 2) + "\n");
    console.log(`created lookup table ${table.toBase58()}`);
  }

  const existing = await connection.getAddressLookupTable(table);
  const have = new Set((existing.value?.state.addresses ?? []).map((a) => a.toBase58()));
  const missing = wanted.filter((a) => !have.has(a.toBase58()));
  if (missing.length === 0) {
    console.log("lookup table already has every address");
    return;
  }
  const extendIx = AddressLookupTableProgram.extendLookupTable({
    payer: authority.publicKey,
    authority: authority.publicKey,
    lookupTable: table,
    addresses: missing,
  });
  const sig = await sendAndConfirmTransaction(connection, new Transaction().add(extendIx), [authority]);
  console.log(`extended lookup table ${table.toBase58()} with ${missing.length} address(es): ${sig}`);
}

if (process.argv[1]?.endsWith("lookup-table.mts")) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
