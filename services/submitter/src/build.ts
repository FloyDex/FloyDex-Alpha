/**
 * Assembles the instructions for one `settle_fills` transaction: an Ed25519
 * introspection instruction (one signature pair per fill, `05` §5) followed
 * by the `settle_fills` instruction itself, batching 1..N same-market fills
 * (`programs/floydex-perps/src/instructions/settle.rs`).
 *
 * Kept as a pure function of already-fetched chain state (no `Connection`
 * calls in here) so it's unit-testable: given a `ChainDirectory` and decoded
 * `UserAccount`s for every side, build the exact instruction list a matching
 * fixture in `tests/e2e/gate.mts` already exercises on a real validator.
 */
import {
  ComputeBudgetProgram,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SystemProgram,
  TransactionInstruction,
  type AccountMeta,
} from "@solana/web3.js";
import { ED25519_PROGRAM_ID, ed25519InstructionData } from "../../../sdk/src/ed25519.ts";
import { type ChainDirectory, eventAuthorityPda, insurancePda, orderRecordPda, riskAccountsFor, userPda } from "./accounts.ts";
import { sideSignedMessage, type StoredFillPayload, type StoredOrderArgs } from "./message.ts";

export interface DecodedUserAccountLike {
  positions: { in_use: number; market_id: number }[];
  balances: { in_use: number; collateral_index: number; amount: { le: number[] } }[];
}

/** Everything `buildSettleFillsTx` needs about one user, keyed by base58 owner pubkey. */
export interface UserContext {
  account: DecodedUserAccountLike;
}

export interface BuildInputs {
  programId: PublicKey;
  dir: ChainDirectory;
  domain: Uint8Array;
  operator: PublicKey;
  exchange: PublicKey;
  market: PublicKey;
  priceUpdate: PublicKey;
  settlementCollateral: PublicKey;
  /** `null` when the market's `oi_policy_bps` is 0 and the account is therefore omitted (matches `SettleFills.insurance: Option<...>`). */
  insurance: PublicKey | null;
  computeUnitLimit: number;
  priorityFeeMicroLamports: number;
  /** `Exchange.settlement_collateral_index` — the balance slot `riskAccountsFor` never emits a remaining account for (it's priced at par, no oracle, and is not one of `dir.collaterals`). */
  settlementIndex: number;
  /** Fills to pack into one instruction; every one must share `marketId` — the instruction has a single `market`/`priceUpdate` pair. */
  fills: StoredFillPayload[];
  /** Decoded on-chain `UserAccount` for every distinct (owner, subId) touched by `fills`, keyed by `${owner}:${subId}`. */
  users: Map<string, UserContext>;
}

function userKey(owner: string, subId: number): string {
  return `${owner}:${subId}`;
}

function orderArg(o: StoredOrderArgs) {
  return {
    marketId: o.marketId,
    flags: o.flags,
    size: BigInt(o.size),
    limitPrice: BigInt(o.limitPrice),
    nonce: BigInt(o.nonce),
    expiryTs: BigInt(o.expiryTs),
  };
}

function requireUser(users: Map<string, UserContext>, owner: string, subId: number): DecodedUserAccountLike {
  const u = users.get(userKey(owner, subId));
  if (!u) throw new Error(`missing decoded UserAccount for ${owner} sub ${subId} — build() requires every touched user pre-fetched`);
  return u.account;
}

/**
 * Builds `[ComputeBudget×2, Ed25519, settle_fills]` for a batch of
 * same-market fills. The caller (`worker.ts`) is responsible for actually
 * encoding the Anchor instruction data for `settle_fills` via the IDL
 * (`program.methods.settleFills(...)`) — this function returns the pieces
 * that call needs (the Ed25519 ix, the ordered remaining accounts, the
 * fill args) rather than duplicating Anchor's encoder.
 */
export function buildFillPlan(input: BuildInputs): {
  computeIxs: TransactionInstruction[];
  ed25519Ix: TransactionInstruction;
  remainingAccounts: AccountMeta[];
  fillArgs: {
    maker: ReturnType<typeof orderArg>;
    taker: ReturnType<typeof orderArg>;
    fillSize: bigint;
    fillPrice: bigint;
    makerSig: { ixIndex: number; sigIndex: number };
    takerSig: { ixIndex: number; sigIndex: number };
  }[];
} {
  if (input.fills.length === 0) throw new Error("no fills to build");
  const marketId = input.fills[0]!.marketId;
  for (const f of input.fills) {
    if (f.marketId !== marketId) throw new Error(`buildFillPlan: mixed markets in one batch (${f.marketId} != ${marketId})`);
  }

  const signed: { publicKey: Uint8Array; signature: Uint8Array; message: Uint8Array }[] = [];
  const remainingAccounts: AccountMeta[] = [];
  const fillArgs: ReturnType<typeof buildFillPlan>["fillArgs"] = [];

  // Ed25519 introspection instruction is at index 1 (index 0 is the compute-budget ix that always precedes it, matching `gate.mts`'s fixed layout).
  const ED25519_IX_INDEX = 1;

  for (const fill of input.fills) {
    const makerSig = sideSignedMessage(input.domain, fill.maker);
    const takerSig = sideSignedMessage(input.domain, fill.taker);
    const makerSigIndex = signed.length;
    signed.push({ publicKey: makerSig.signerPubkey, signature: makerSig.signature, message: makerSig.message });
    const takerSigIndex = signed.length;
    signed.push({ publicKey: takerSig.signerPubkey, signature: takerSig.signature, message: takerSig.message });

    const makerUser = requireUser(input.users, fill.maker.owner, fill.maker.subId);
    const takerUser = requireUser(input.users, fill.taker.owner, fill.taker.subId);

    remainingAccounts.push(
      { pubkey: userPda(input.programId, new PublicKey(fill.maker.owner), fill.maker.subId), isSigner: false, isWritable: true },
      { pubkey: userPda(input.programId, new PublicKey(fill.taker.owner), fill.taker.subId), isSigner: false, isWritable: true },
      { pubkey: orderRecordPda(input.programId, new PublicKey(fill.maker.owner), fill.maker.subId, BigInt(fill.maker.nonce)), isSigner: false, isWritable: true },
      { pubkey: orderRecordPda(input.programId, new PublicKey(fill.taker.owner), fill.taker.subId, BigInt(fill.taker.nonce)), isSigner: false, isWritable: true },
    );
    for (const p of riskAccountsFor(input.dir, makerUser, [marketId], input.settlementIndex)) remainingAccounts.push({ pubkey: p, isSigner: false, isWritable: false });
    for (const p of riskAccountsFor(input.dir, takerUser, [marketId], input.settlementIndex)) remainingAccounts.push({ pubkey: p, isSigner: false, isWritable: false });

    fillArgs.push({
      maker: orderArg(fill.maker),
      taker: orderArg(fill.taker),
      fillSize: BigInt(fill.fillSize),
      fillPrice: BigInt(fill.fillPrice),
      makerSig: { ixIndex: ED25519_IX_INDEX, sigIndex: makerSigIndex },
      takerSig: { ixIndex: ED25519_IX_INDEX, sigIndex: takerSigIndex },
    });
  }

  const ed25519Ix = new TransactionInstruction({
    programId: new PublicKey(ED25519_PROGRAM_ID),
    keys: [],
    data: Buffer.from(ed25519InstructionData(signed)),
  });

  const computeIxs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: input.computeUnitLimit }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: input.priorityFeeMicroLamports }),
  ];

  return { computeIxs, ed25519Ix, remainingAccounts, fillArgs };
}

/** Static (non-remaining) accounts for the `settle_fills` instruction, in IDL account order. */
export function settleFillsStaticAccounts(input: BuildInputs) {
  return {
    exchange: input.exchange,
    operator: input.operator,
    market: input.market,
    priceUpdate: input.priceUpdate,
    settlementCollateral: input.settlementCollateral,
    instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
    systemProgram: SystemProgram.programId,
    insurance: input.insurance,
    eventAuthority: eventAuthorityPda(input.programId),
    program: input.programId,
  };
}

export { insurancePda };
