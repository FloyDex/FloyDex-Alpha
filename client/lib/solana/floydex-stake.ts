import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { FLOYDEX_TOKEN } from "@/config/token";
import { STAKE_DECIMALS, STAKE_TREASURY } from "@/lib/market/stake";
import { getSolanaConnection } from "./connection";

const TREASURY = new PublicKey(STAKE_TREASURY);

/** Move $FLOYDEX from the trader wallet into the treasury stake account. */
export async function transferFloydexToTreasury(
  owner: string,
  amount: number,
  sendTransaction: (tx: Transaction, connection: Connection) => Promise<string>,
): Promise<string> {
  const connection = getSolanaConnection();
  const from = new PublicKey(owner);
  const mint = new PublicKey(FLOYDEX_TOKEN.mint);
  const fromAta = getAssociatedTokenAddressSync(mint, from);
  const toAta = getAssociatedTokenAddressSync(mint, TREASURY);
  const raw = BigInt(Math.round(amount * 10 ** STAKE_DECIMALS));
  const tx = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(from, toAta, TREASURY, mint),
    createTransferCheckedInstruction(fromAta, mint, toAta, from, raw, STAKE_DECIMALS, [], TOKEN_PROGRAM_ID),
  );
  tx.feePayer = from;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  return sendTransaction(tx, connection);
}
