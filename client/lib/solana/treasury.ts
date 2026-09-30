import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import bs58 from "bs58";
import { solanaRpcUrl } from "@/lib/solana/rpc";

const USDC = new PublicKey(
  process.env.USDC_MINT ||
    process.env.NEXT_PUBLIC_ASSET_USDC ||
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
);

function decodeSecretKey(raw: string): Uint8Array {
  if (raw.startsWith("[")) {
    return Uint8Array.from(JSON.parse(raw) as number[]);
  }
  const decode =
    typeof (bs58 as { decode?: (s: string) => Uint8Array }).decode === "function"
      ? (bs58 as { decode: (s: string) => Uint8Array }).decode
      : (bs58 as unknown as { default: { decode: (s: string) => Uint8Array } }).default.decode;
  return decode(raw);
}

function keyFromEnv(raw: string | undefined): Keypair | null {
  if (!raw?.trim()) return null;
  try {
    const secret = decodeSecretKey(raw.trim());
    if (secret.length === 32) return Keypair.fromSeed(secret);
    return Keypair.fromSecretKey(secret);
  } catch {
    return null;
  }
}

export function operatorKey(): Keypair | null {
  return keyFromEnv(process.env.SOLANA_PRIVATE_KEY);
}

/** Signer for $FLOYDEX stake unlocks. Prefers SOLANA_STAKE_PRIVATE_KEY, else SOLANA_PRIVATE_KEY. */
export function stakeOperatorKey(): Keypair | null {
  return keyFromEnv(process.env.SOLANA_STAKE_PRIVATE_KEY) || operatorKey();
}

export function operatorPubkey(): string | null {
  return operatorKey()?.publicKey.toBase58() ?? null;
}

/** On-chain USDC held by the treasury operator wallet. */
export async function treasuryUsdcBalance(): Promise<{
  usdc: number | null;
  sol: number | null;
  pubkey: string | null;
}> {
  const operator = operatorKey();
  if (!operator) return { usdc: null, sol: null, pubkey: null };
  const connection = new Connection(solanaRpcUrl(), "confirmed");
  const ata = getAssociatedTokenAddressSync(USDC, operator.publicKey);
  const [bal, solLamports] = await Promise.all([
    connection.getTokenAccountBalance(ata).catch(() => null),
    connection.getBalance(operator.publicKey).catch(() => null),
  ]);
  return {
    usdc: bal?.value?.uiAmount ?? Number(bal?.value?.amount ?? 0) / 1e6,
    sol: solLamports != null ? solLamports / 1e9 : null,
    pubkey: operator.publicKey.toBase58(),
  };
}

async function waitForSig(
  connection: Connection,
  sig: string,
  tries = 20,
): Promise<"ok" | "err" | "unknown"> {
  for (let i = 0; i < tries; i++) {
    const st = await connection.getSignatureStatus(sig, { searchTransactionHistory: true });
    const v = st.value;
    if (v?.err) return "err";
    if (v?.confirmationStatus === "confirmed" || v?.confirmationStatus === "finalized") return "ok";
    await new Promise((r) => setTimeout(r, 1000));
  }
  return "unknown";
}

export function sendTreasuryUsdc(
  owner: string,
  amount: number,
): Promise<{ ok: true; signature: string } | { ok: false; error: string }> {
  return sendTreasuryToken(owner, amount, USDC, 6);
}

export async function sendTreasuryToken(
  owner: string,
  amount: number,
  mint: PublicKey = USDC,
  decimals = 6,
  opts?: { signer?: Keypair | null; expectedPubkey?: string },
): Promise<{ ok: true; signature: string } | { ok: false; error: string }> {
  const operator = opts?.signer ?? operatorKey();
  if (!operator) {
    return {
      ok: false,
      error:
        "Treasury key is not configured on the server (set SOLANA_PRIVATE_KEY to a valid base58 or JSON secret)",
    };
  }

  const expected =
    opts?.expectedPubkey?.trim() ||
    process.env.SOLANA_OPERATOR_PUBKEY?.trim() ||
    process.env.NEXT_PUBLIC_TREASURY?.trim() ||
    "";
  if (expected && expected !== operator.publicKey.toBase58()) {
    return {
      ok: false,
      error: opts?.expectedPubkey
        ? `Stake unlock signer must be ${expected} — set SOLANA_STAKE_PRIVATE_KEY for that wallet`
        : "Treasury key does not match NEXT_PUBLIC_TREASURY / SOLANA_OPERATOR_PUBKEY — deposits and withdrawals must use the same wallet",
    };
  }

  const connection = new Connection(solanaRpcUrl(), "confirmed");
  const dest = new PublicKey(owner);

  if (dest.equals(operator.publicKey)) {
    return { ok: true, signature: `local:self-withdraw:${Date.now()}` };
  }

  const fromAta = getAssociatedTokenAddressSync(mint, operator.publicKey);
  const toAta = getAssociatedTokenAddressSync(mint, dest);
  const scale = 10 ** decimals;
  const rawAmt = BigInt(Math.round(amount * scale));
  if (rawAmt <= 0n) return { ok: false, error: "Invalid withdraw amount" };

  const bal = await connection.getTokenAccountBalance(fromAta).catch(() => null);
  const available = BigInt(bal?.value?.amount ?? "0");
  if (available < rawAmt) {
    return {
      ok: false,
      error: `Treasury token balance too low (need ${(Number(rawAmt) / scale).toFixed(4)}, have ${(Number(available) / scale).toFixed(4)})`,
    };
  }

  const solBal = await connection.getBalance(operator.publicKey);
  if (solBal < 5_000_000) {
    return {
      ok: false,
      error: "Treasury needs more SOL for transaction fees (top up ~0.01 SOL)",
    };
  }

  let lastErr = "unknown";
  for (let attempt = 0; attempt < 3; attempt++) {
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 120_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }),
      createAssociatedTokenAccountIdempotentInstruction(operator.publicKey, toAta, dest, mint),
      createTransferCheckedInstruction(
        fromAta,
        mint,
        toAta,
        operator.publicKey,
        rawAmt,
        decimals,
        [],
        TOKEN_PROGRAM_ID,
      ),
    );
    tx.feePayer = operator.publicKey;
    tx.recentBlockhash = blockhash;
    tx.sign(operator);

    let sig = "";
    try {
      sig = await connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: false,
        preflightCommitment: "confirmed",
        maxRetries: 5,
      });
      try {
        const conf = await connection.confirmTransaction(
          { signature: sig, blockhash, lastValidBlockHeight },
          "confirmed",
        );
        if (conf.value.err) {
          lastErr = `on-chain err ${JSON.stringify(conf.value.err)}`;
          continue;
        }
        return { ok: true, signature: sig };
      } catch (confirmErr) {
        const status = await waitForSig(connection, sig);
        if (status === "ok") return { ok: true, signature: sig };
        if (status === "err") {
          lastErr = "transaction failed on-chain";
          continue;
        }
        lastErr =
          confirmErr instanceof Error ? confirmErr.message : String(confirmErr);
        // block height exceeded → retry with fresh blockhash
        continue;
      }
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
      if (sig) {
        const status = await waitForSig(connection, sig);
        if (status === "ok") return { ok: true, signature: sig };
      }
      // simulation / send failures: retry once or two
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  return {
    ok: false,
    error: lastErr.includes("insufficient")
      ? "Treasury could not send the token — fund the treasury with SOL for fees"
      : `Treasury send failed: ${lastErr.slice(0, 220)}`,
  };
}
