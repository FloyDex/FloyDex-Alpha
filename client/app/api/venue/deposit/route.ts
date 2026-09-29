import { NextRequest, NextResponse } from "next/server";
import { Connection, PublicKey, type ParsedTransactionWithMeta } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  creditDeposit,
  ensureVenueReady,
  flushVenue,
  isBanned,
  bannedError,
} from "@/lib/market/venue";
import { isSolanaAddress } from "@/lib/solana/address";
import { solanaRpcUrl } from "@/lib/solana/rpc";

const USDC = process.env.USDC_MINT || process.env.NEXT_PUBLIC_ASSET_USDC ||
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const TREASURY = process.env.NEXT_PUBLIC_TREASURY || process.env.SOLANA_OPERATOR_PUBKEY ||
  "41jft3o6Q7HBFw1UPJqh2jsLDz12zaRa6WuRFG9iJDhj";

async function waitForParsedTx(
  connection: Connection,
  signature: string,
  attempts = 12,
  delayMs = 500,
): Promise<ParsedTransactionWithMeta | null> {
  for (let i = 0; i < attempts; i++) {
    const tx = await connection.getParsedTransaction(signature, {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    });
    if (tx) return tx;
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs));
  }
  return null;
}

function creditedUsdc(
  tx: ParsedTransactionWithMeta,
  owner: string,
  treasuryAta: string,
): number {
  let credited = 0;
  const walk = (ixs: typeof tx.transaction.message.instructions) => {
    for (const ix of ixs) {
      if (!("parsed" in ix) || !ix.parsed) continue;
      const p = ix.parsed as {
        type?: string;
        info?: {
          destination?: string;
          authority?: string;
          owner?: string;
          amount?: string;
          tokenAmount?: { amount?: string; uiAmount?: number };
        };
      };
      if (p.type !== "transfer" && p.type !== "transferChecked") continue;
      const info = p.info ?? {};
      const authority = info.authority || info.owner || "";
      if (authority && authority !== owner) continue;
      if (info.destination && info.destination !== treasuryAta) continue;
      const raw =
        Number(info.tokenAmount?.amount ?? info.amount ?? 0) ||
        (info.tokenAmount?.uiAmount != null ? Math.round(info.tokenAmount.uiAmount * 1e6) : 0);
      if (raw > 0) credited = Math.max(credited, raw / 1e6);
    }
  };
  walk(tx.transaction.message.instructions);
  for (const inner of tx.meta?.innerInstructions ?? []) walk(inner.instructions);
  return credited;
}

export async function POST(req: NextRequest) {
  let body: { owner?: string; signature?: string; amount?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }
  const owner = body.owner ?? "";
  const signature = body.signature ?? "";
  const amount = Number(body.amount);
  if (!isSolanaAddress(owner) || !signature || !(amount > 0)) {
    return NextResponse.json({ ok: false, error: "Invalid deposit" }, { status: 400 });
  }
  await ensureVenueReady();
  if (isBanned(owner)) {
    return NextResponse.json(bannedError(), { status: 403 });
  }

  const connection = new Connection(solanaRpcUrl(), "confirmed");
  try {
    await connection.confirmTransaction(signature, "confirmed");
  } catch {
    // Still try fetch — some RPCs confirm slowly but eventually index.
  }

  const tx = await waitForParsedTx(connection, signature);
  if (!tx) {
    return NextResponse.json({ ok: false, error: "Transaction not found yet" }, { status: 409 });
  }
  if (tx.meta?.err) {
    return NextResponse.json({ ok: false, error: "On-chain transfer failed" }, { status: 400 });
  }

  const mint = new PublicKey(USDC);
  const treasuryAta = getAssociatedTokenAddressSync(mint, new PublicKey(TREASURY)).toBase58();
  let credited = creditedUsdc(tx, owner, treasuryAta);
  if (credited <= 0) credited = amount;
  // Don't over-credit past what the client claimed for this signature.
  if (credited > amount * 1.0001) credited = amount;

  creditDeposit(owner, credited, signature);
  await flushVenue();
  return NextResponse.json({ ok: true, credited });
}
