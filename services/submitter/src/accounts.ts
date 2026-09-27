/**
 * PDA derivation and on-chain account resolution for `settle_fills`
 * (`programs/kryon-perps/src/instructions/settle.rs`, `programs/kryon-perps/
 * src/health.rs`). Kept separate from `build.ts` so the pure instruction
 * assembly is testable without a live `Connection`.
 */
import { PublicKey } from "@solana/web3.js";
import type { Program } from "@coral-xyz/anchor";
import { derivePushFeedAddress } from "../../kit/src/pyth.ts";

export function pda(programId: PublicKey, ...seeds: (Buffer | Uint8Array)[]): PublicKey {
  return PublicKey.findProgramAddressSync(seeds.map((s) => Buffer.from(s)), programId)[0];
}

/**
 * `Program.account` is typed against the IDL's TS-generated type when one
 * exists; every service here instead constructs `Program` from the raw JSON
 * IDL loaded at runtime (`target/idl/kryon_perps.json`), so TS only knows it
 * as `AccountNamespace<Idl>` with no per-account keys. This is the one place
 * that loosens the type back to `{ fetch }` per account name, kept narrow
 * (not exported beyond this module's own use) so a genuine typo in an
 * account name still only fails at runtime here, not silently everywhere.
 */
export function accountNamespace(program: Program): Record<string, { fetch(address: PublicKey): Promise<unknown> }> {
  return program.account as unknown as Record<string, { fetch(address: PublicKey): Promise<unknown> }>;
}

export { derivePushFeedAddress };

const u16le = (v: number) => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(v);
  return b;
};
const u64le = (v: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v);
  return b;
};

export function exchangePda(programId: PublicKey): PublicKey {
  return pda(programId, Buffer.from("exchange"));
}
export function marketPda(programId: PublicKey, marketId: number): PublicKey {
  return pda(programId, Buffer.from("market"), u16le(marketId));
}
export function userPda(programId: PublicKey, owner: PublicKey, subId: number): PublicKey {
  return pda(programId, Buffer.from("user"), owner.toBuffer(), Buffer.from([subId]));
}
export function orderRecordPda(programId: PublicKey, owner: PublicKey, subId: number, nonce: bigint): PublicKey {
  return pda(programId, Buffer.from("order"), owner.toBuffer(), Buffer.from([subId]), u64le(nonce));
}
export function insurancePda(programId: PublicKey): PublicKey {
  return pda(programId, Buffer.from("insurance"));
}
export function collateralPda(programId: PublicKey, mint: PublicKey): PublicKey {
  return pda(programId, Buffer.from("collateral"), mint.toBuffer());
}
export function eventAuthorityPda(programId: PublicKey): PublicKey {
  return pda(programId, Buffer.from("__event_authority"));
}

/** A market's identity for risk-account resolution: its own PDA plus its Pyth push-feed account (`health.rs`'s `[Market, PriceUpdateV2]` pair). */
export interface MarketRef {
  marketId: number;
  marketPda: PublicKey;
  priceUpdate: PublicKey;
}

/** A non-settlement collateral's identity for risk-account resolution (`health.rs`'s `[Collateral, PriceUpdateV2, Mint]` triple). */
export interface CollateralRef {
  index: number;
  collateralPda: PublicKey;
  priceUpdate: PublicKey;
  mint: PublicKey;
}

interface DecodedMarket {
  market_id: number;
  pyth_feed_id: number[];
  pyth_shard_id: number;
}
interface DecodedCollateral {
  index: number;
  mint: PublicKey;
  pyth_feed_id: number[];
  pyth_shard_id: number;
  is_settlement: boolean;
}
interface PositionSlot {
  in_use: number;
  market_id: number;
}
/** `amount` is the zero-copy `PodI128` shape (`{ le: number[16] }`); decode it with `podI128ToBigInt` before comparing. */
interface BalanceSlot {
  in_use: number;
  collateral_index: number;
  amount: { le: number[] };
}
interface DecodedUserAccount {
  positions: PositionSlot[];
  balances: BalanceSlot[];
}

/** Decodes a zero-copy `PodI128` (`{ le: number[16] }`, little-endian two's complement) to a signed bigint. Ported from `tests/e2e/gate.mts`'s `i128` helper — must decode the same bytes the on-chain `PodI128` reads. */
export function podI128ToBigInt(pod: { le: number[] }): bigint {
  const unsigned = pod.le.reduceRight((acc, b) => (acc << 8n) | BigInt(b), 0n);
  return BigInt.asIntN(128, unsigned);
}

/** Everything the submitter needs to resolve *any* user's cross-market/cross-collateral risk accounts, cached once per batch. */
export interface ChainDirectory {
  programId: PublicKey;
  /** Every known market, by id — a fresh position in an id not here means the market registry is stale and the fill can't be built (fail closed). */
  markets: Map<number, MarketRef>;
  collaterals: Map<number, CollateralRef>;
}

/** Builds a `ChainDirectory` from the on-chain `Market` and `Collateral` accounts the program object already knows how to fetch (all markets/collaterals the operator has been told about via the DB `Market` table). */
export async function loadChainDirectory(program: Program, marketIds: number[], collateralMints: PublicKey[]): Promise<ChainDirectory> {
  const programId = program.programId;
  const markets = new Map<number, MarketRef>();
  for (const marketId of marketIds) {
    const mPda = marketPda(programId, marketId);
    const m = (await accountNamespace(program)["market"]!.fetch(mPda)) as unknown as DecodedMarket;
    if (m.market_id !== marketId) throw new Error(`market PDA ${mPda.toBase58()} decoded market_id ${m.market_id} != expected ${marketId}`);
    markets.set(marketId, {
      marketId,
      marketPda: mPda,
      priceUpdate: derivePushFeedAddress(m.pyth_shard_id, Uint8Array.from(m.pyth_feed_id)),
    });
  }
  const collaterals = new Map<number, CollateralRef>();
  for (const mint of collateralMints) {
    const cPda = collateralPda(programId, mint);
    const c = (await accountNamespace(program)["collateral"]!.fetch(cPda)) as unknown as DecodedCollateral;
    if (c.is_settlement) continue; // never in the remaining-accounts list; the settlement collateral is a fixed top-level account.
    collaterals.set(c.index, {
      index: c.index,
      collateralPda: cPda,
      priceUpdate: derivePushFeedAddress(c.pyth_shard_id, Uint8Array.from(c.pyth_feed_id)),
      mint,
    });
  }
  return { programId, markets, collaterals };
}

/**
 * `[Market, PriceUpdateV2]` pairs then `[Collateral, PriceUpdateV2, Mint]`
 * triples for one user's other-market/non-settlement-balance risk accounts,
 * matching `health.rs`'s documented order exactly. `known` markets (the
 * fill's own market) are skipped, matching `load_risk_inputs`.
 *
 * Fails closed on anything the directory doesn't recognize — a market or a
 * non-settlement, non-zero balance the directory has never seen means the
 * market/collateral registry this batch loaded is stale, and building a
 * short remaining-accounts list would either panic on-chain
 * (`InvalidRemainingAccounts`) or, worse, silently misalign the accounts
 * `health.rs` reads for a *different* slot. Better a job that stays QUEUED.
 */
export function riskAccountsFor(dir: ChainDirectory, user: DecodedUserAccount, known: number[], settlementIndex: number): PublicKey[] {
  const out: PublicKey[] = [];
  const seen = new Set<number>(known);
  for (const slot of user.positions) {
    if (slot.in_use === 0 || seen.has(slot.market_id)) continue;
    seen.add(slot.market_id);
    const ref = dir.markets.get(slot.market_id);
    if (!ref) throw new Error(`user has an open position in market ${slot.market_id}, not in the chain directory — market registry is stale`);
    out.push(ref.marketPda, ref.priceUpdate);
  }
  for (const slot of user.balances) {
    if (slot.in_use === 0 || slot.collateral_index === settlementIndex || podI128ToBigInt(slot.amount) === 0n) continue;
    const ref = dir.collaterals.get(slot.collateral_index);
    if (!ref) throw new Error(`user has a non-zero balance in collateral index ${slot.collateral_index}, not in the chain directory — collateral registry is stale`);
    out.push(ref.collateralPda, ref.priceUpdate, ref.mint);
  }
  return out;
}
