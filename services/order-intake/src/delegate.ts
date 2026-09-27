/**
 * On-chain delegate check: is the key that signed this order actually the
 * active session key for (owner, subId) right now? Ported from the intent of
 * Stellar's per-request auth check, but here it reads `UserAccount` directly
 * rather than trusting a client-asserted delegate.
 *
 * `UserAccount` is `#[account(zero_copy)]` (`programs/kryon-perps/src/state/user.rs`);
 * its Borsh-coded field names come back from the IDL verbatim (snake_case),
 * same gotcha as `services/kit/src/deployments.ts` — see that file's comment
 * and its regression test for how this was confirmed.
 */
import { PublicKey, type Connection } from "@solana/web3.js";
import { BorshAccountsCoder, type Idl } from "@coral-xyz/anchor";

export function deriveUserAccountPda(programId: PublicKey, owner: PublicKey, subId: number): PublicKey {
  if (!Number.isInteger(subId) || subId < 0 || subId > 0xff) throw new RangeError(`subId out of range: ${subId}`);
  return PublicKey.findProgramAddressSync([Buffer.from("user"), owner.toBuffer(), Uint8Array.of(subId)], programId)[0];
}

interface DecodedUserAccount {
  owner: PublicKey;
  delegate: PublicKey;
  delegate_expiry: { toNumber(): number } | number;
  cancel_all_below_nonce: { toString(): string } | bigint;
  sub_id: number;
}

export type DelegateCheckResult =
  | { ok: true; cancelAllBelowNonce: bigint }
  | { ok: false; error: string };

/**
 * Pure comparison: given the decoded UserAccount, is `signerPubkey` its
 * active delegate right now? Separate from the RPC/decode so it's
 * unit-testable without a validator.
 */
export function checkDelegateActive(decoded: DecodedUserAccount, signerPubkey: PublicKey, nowSec: number): DelegateCheckResult {
  if (!decoded.delegate.equals(signerPubkey)) {
    return { ok: false, error: `signer ${signerPubkey.toBase58()} is not the active delegate for this account` };
  }
  const expiry = typeof decoded.delegate_expiry === "number" ? decoded.delegate_expiry : decoded.delegate_expiry.toNumber();
  if (expiry <= nowSec) {
    return { ok: false, error: `delegate expired at ${expiry} (now ${nowSec})` };
  }
  const cancelAllBelowNonce = typeof decoded.cancel_all_below_nonce === "bigint" ? decoded.cancel_all_below_nonce : BigInt(decoded.cancel_all_below_nonce.toString());
  return { ok: true, cancelAllBelowNonce };
}

/**
 * The full check: fetches (owner, subId)'s UserAccount on-chain and confirms
 * `signerPubkey` is its active, unexpired delegate. Returns an error string
 * (never throws) for every "no" — missing account, wrong owner, program
 * mismatch, wrong or expired delegate — so the intake route can turn it
 * straight into a 4xx without a try/catch at the call site.
 */
export async function assertDelegateActive(opts: {
  connection: Connection;
  idl: Idl;
  programId: PublicKey;
  owner: PublicKey;
  subId: number;
  signerPubkey: PublicKey;
  nowSec?: number;
}): Promise<DelegateCheckResult> {
  const { connection, idl, programId, owner, subId, signerPubkey } = opts;
  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);

  const pda = deriveUserAccountPda(programId, owner, subId);
  const info = await connection.getAccountInfo(pda);
  if (!info) return { ok: false, error: `UserAccount ${pda.toBase58()} does not exist — has init_user run for sub_id ${subId}?` };
  if (!info.owner.equals(programId)) {
    return { ok: false, error: `UserAccount ${pda.toBase58()} is owned by ${info.owner.toBase58()}, not the declared program` };
  }

  const coder = new BorshAccountsCoder(idl);
  const decoded = coder.decode("UserAccount", info.data) as DecodedUserAccount;
  if (!decoded.owner.equals(owner)) {
    return { ok: false, error: `UserAccount ${pda.toBase58()} owner field (${decoded.owner.toBase58()}) != requested owner (${owner.toBase58()})` };
  }

  return checkDelegateActive(decoded, signerPubkey, nowSec);
}
