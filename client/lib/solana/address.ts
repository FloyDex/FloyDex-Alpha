import { PublicKey } from "@solana/web3.js";

export function isSolanaAddress(value: string): boolean {
  try {
    // Accepts any well-formed pubkey (wallets and PDAs).
    new PublicKey(value);
    return true;
  } catch {
    return false;
  }
}
