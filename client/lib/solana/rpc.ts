/** Browser traffic goes through /api/solana/rpc so the Helius key stays server-side. */
export function solanaRpcUrl(): string {
  if (typeof window !== "undefined") {
    return `${window.location.origin}/api/solana/rpc`;
  }
  return (
    process.env.RPC_URL ||
    process.env.SOLANA_RPC_URL ||
    "https://api.mainnet-beta.solana.com"
  );
}
