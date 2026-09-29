"use client";

import {
  Connection,
  PublicKey,
  Transaction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { ASSETS } from "@/config";
import { getSolanaConnection } from "./connection";
import { apiFetch } from "@/lib/api";

const TREASURY = new PublicKey(
  process.env.NEXT_PUBLIC_TREASURY || "41jft3o6Q7HBFw1UPJqh2jsLDz12zaRa6WuRFG9iJDhj",
);

export async function deposit(
  owner: string,
  raw: bigint,
  mint: string,
  sendTransaction: (tx: Transaction, connection: Connection) => Promise<string>,
): Promise<{ hash: string }> {
  const connection = getSolanaConnection();
  const from = new PublicKey(owner);
  const usdc = new PublicKey(mint || ASSETS.usdc);
  const fromAta = getAssociatedTokenAddressSync(usdc, from);
  const toAta = getAssociatedTokenAddressSync(usdc, TREASURY);

  const tx = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(from, toAta, TREASURY, usdc),
    createTransferCheckedInstruction(
      fromAta,
      usdc,
      toAta,
      from,
      raw,
      6,
      [],
      TOKEN_PROGRAM_ID,
    ),
  );
  tx.feePayer = from;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

  const signature = await sendTransaction(tx, connection);
  const amount = Number(raw) / 1e6;
  // RPC often lags Phantom — retry credit until the desk sees the signature.
  let lastErr = "Deposit landed on-chain but the desk has not credited it yet — retry in a few seconds";
  for (let i = 0; i < 8; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 800));
    const credit = await apiFetch("/api/venue/deposit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ owner, signature, amount }),
    });
    const data = (await credit.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (credit.ok && data.ok !== false) return { hash: signature };
    lastErr = data.error ?? lastErr;
    if (credit.status !== 409) break;
  }
  throw new Error(lastErr);
}

export async function withdraw(
  owner: string,
  raw: bigint,
  _mint: string,
): Promise<{ hash: string; mode: "auto" | "manual"; message?: string }> {
  const amount = Number(raw) / 1e6;
  const res = await apiFetch("/api/venue/withdraw", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ owner, amount }),
  });
  const data = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    error?: string;
    signature?: string;
    mode?: "auto" | "manual";
    message?: string;
  };
  if (!res.ok || data.ok === false) {
    throw new Error(data.error ?? "Withdraw failed");
  }
  return {
    hash: data.signature ?? "",
    mode: data.mode ?? "auto",
    message: data.message,
  };
}
