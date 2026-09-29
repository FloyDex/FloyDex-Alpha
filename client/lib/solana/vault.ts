import { PublicKey } from "@solana/web3.js";
import { COLLATERAL } from "@/config";
import { getSolanaConnection } from "./connection";
import type { ListedCollateral } from "@/lib/stellar/collateral";

export async function listVaultCollateral(): Promise<ListedCollateral[]> {
  return COLLATERAL.filter((c) => c.settlement).map((c) => ({
    ...c,
    haircutBps: 0,
    depositCap: null,
    totalDeposited: 0n,
    capHeadroom: null,
  }));
}

export async function getTokenBalance(owner: string, mint: string): Promise<bigint> {
  const connection = getSolanaConnection();
  const ownerKey = new PublicKey(owner);
  const mintKey = new PublicKey(mint);
  const parsed = await connection.getParsedTokenAccountsByOwner(ownerKey, { mint: mintKey });
  let total = 0n;
  for (const acct of parsed.value) {
    const info = acct.account.data.parsed?.info;
    const amount = info?.tokenAmount?.amount;
    if (typeof amount === "string") total += BigInt(amount);
  }
  return total;
}

/** Venue ledger equity (deposits ± realized ± upnl), scaled to AMOUNT_PRECISION. */
export async function getBalance(owner: string, _mint: string): Promise<bigint> {
  const { getVenueSnapshot } = await import("./account");
  const snap = await getVenueSnapshot(owner);
  // Equity, not raw deposits — a stop-loss must shrink what the vault shows.
  const equity = Number(snap.equity ?? snap.deposited ?? 0);
  return BigInt(Math.max(0, Math.round(equity * 1e6)));
}

export async function hasTrustline(_owner: string, _asset: ListedCollateral): Promise<boolean> {
  return true;
}

export async function addTrustline(_owner: string, _asset: ListedCollateral): Promise<string> {
  return "";
}

export function roundToBridgeable(amount: bigint, _asset: ListedCollateral): bigint {
  return amount;
}
