import { Connection } from "@solana/web3.js";
import { solanaRpcUrl } from "./rpc";

let cached: { url: string; connection: Connection } | null = null;

export function getSolanaConnection(): Connection {
  const url = solanaRpcUrl();
  if (cached && cached.url === url) return cached.connection;
  const connection = new Connection(url, "confirmed");
  cached = { url, connection };
  return connection;
}
