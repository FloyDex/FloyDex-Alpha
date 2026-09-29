import { PublicKey } from "@solana/web3.js";

/** PDA `["book", market_id u16 LE]` — matches `BOOK_SEED` in floydex-perps. */
export function marketBookPda(programId: PublicKey, marketId: number): PublicKey {
  const id = Buffer.alloc(2);
  id.writeUInt16LE(marketId, 0);
  return PublicKey.findProgramAddressSync([Buffer.from("book"), id], programId)[0];
}
