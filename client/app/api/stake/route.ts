import { NextRequest, NextResponse } from "next/server";
import { Connection, PublicKey, type ParsedTransactionWithMeta } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { randomUUID } from "node:crypto";
import {
  addStakeLock,
  ensureVenueReady,
  floydexWalletBalance,
  flushVenue,
  isBanned,
  bannedError,
  lastStakeOwner,
  listStakeRows,
  markStakeReturned,
  openStakedAmount,
  stakeRow,
  totalStakedNow,
  traderFeeBps,
} from "@/lib/market/venue";
import {
  HOLD_FEE_TIERS,
  STAKE_DECIMALS,
  STAKE_FEE_TIERS,
  STAKE_MINT,
  STAKE_PUBLIC,
  STAKE_SUPPLY,
  STAKE_TERMS,
  STAKE_TREASURY,
  isOpenStake,
  positionPayout,
  stakeReward,
  termByDays,
  type StakePosition,
} from "@/lib/market/stake";
import { FLOYDEX_TOKEN } from "@/config/token";
import { PLATFORM_FEE_BPS } from "@/config";
import { bodyTooLarge, rateLimit, requestKey } from "@/lib/rate-limit";
import { isSolanaAddress } from "@/lib/solana/address";
import { shortenAddress } from "@/lib/format";
import { solanaRpcUrl } from "@/lib/solana/rpc";
import { sendTreasuryToken, stakeOperatorKey } from "@/lib/solana/treasury";

async function snapshot(owner: string) {
  const wallet = owner && isSolanaAddress(owner) ? await floydexWalletBalance(owner) : 0;
  const staked = owner && isSolanaAddress(owner) ? openStakedAmount(owner) : 0;
  const mine = owner && isSolanaAddress(owner) ? listStakeRows(owner) : [];
  return {
    totalStaked: totalStakedNow(),
    lastStaker: lastStakeOwner() ? shortenAddress(lastStakeOwner()!) : null,
    terms: STAKE_TERMS,
    stakes: mine as StakePosition[],
    openCount: mine.filter((r) => isOpenStake(r)).length,
    walletBalance: wallet,
    staked,
    feeBps: await traderFeeBps(owner && isSolanaAddress(owner) ? owner : ""),
    baseFeeBps: PLATFORM_FEE_BPS,
    holdTiers: HOLD_FEE_TIERS,
    stakeTiers: STAKE_FEE_TIERS,
    treasury: STAKE_TREASURY,
    token: {
      symbol: FLOYDEX_TOKEN.symbol,
      mint: FLOYDEX_TOKEN.mint,
      supply: STAKE_SUPPLY,
      decimals: STAKE_DECIMALS,
      clawpump: FLOYDEX_TOKEN.clawpump,
      dexscreener: FLOYDEX_TOKEN.dexscreener,
      padre: FLOYDEX_TOKEN.padre,
    },
  };
}

async function waitForParsedTx(
  connection: Connection,
  signature: string,
): Promise<ParsedTransactionWithMeta | null> {
  for (let i = 0; i < 12; i++) {
    const tx = await connection.getParsedTransaction(signature, {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    });
    if (tx) return tx;
    if (i < 11) await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

function creditedFloydex(tx: ParsedTransactionWithMeta, owner: string, treasuryAta: string): number {
  let credited = 0;
  const walk = (ixs: typeof tx.transaction.message.instructions) => {
    for (const ix of ixs) {
      if (!("parsed" in ix) || !ix.parsed) continue;
      const p = ix.parsed as {
        type?: string;
        info?: {
          destination?: string;
          authority?: string;
          owner?: string;
          mint?: string;
          amount?: string;
          tokenAmount?: { amount?: string; uiAmount?: number };
        };
      };
      if (p.type !== "transfer" && p.type !== "transferChecked") continue;
      const info = p.info ?? {};
      if (info.mint && info.mint !== STAKE_MINT) continue;
      const authority = info.authority || info.owner || "";
      if (authority && authority !== owner) continue;
      if (info.destination && info.destination !== treasuryAta) continue;
      const raw =
        Number(info.tokenAmount?.amount ?? info.amount ?? 0) ||
        (info.tokenAmount?.uiAmount != null
          ? Math.round(info.tokenAmount.uiAmount * 10 ** STAKE_DECIMALS)
          : 0);
      if (raw > 0) credited = Math.max(credited, raw / 10 ** STAKE_DECIMALS);
    }
  };
  walk(tx.transaction.message.instructions);
  for (const inner of tx.meta?.innerInstructions ?? []) walk(inner.instructions);
  return credited;
}

export async function GET(req: NextRequest) {
  if (!STAKE_PUBLIC) {
    return NextResponse.json({ error: "stake_disabled" }, { status: 404 });
  }
  await ensureVenueReady();
  const owner = req.nextUrl.searchParams.get("owner") ?? "";
  return NextResponse.json(await snapshot(owner), { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: NextRequest) {
  if (!STAKE_PUBLIC) {
    return NextResponse.json({ error: "stake_disabled" }, { status: 404 });
  }
  if (bodyTooLarge(req, 4096)) {
    return NextResponse.json({ ok: false, error: "Body too large" }, { status: 413 });
  }
  let body: { owner?: string; days?: number; amount?: number; signature?: string; action?: string; id?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }
  const owner = body.owner ?? "";
  if (!isSolanaAddress(owner)) {
    return NextResponse.json({ ok: false, error: "Connect a wallet" }, { status: 400 });
  }
  await ensureVenueReady();
  if (isBanned(owner)) {
    return NextResponse.json(bannedError(), { status: 403 });
  }
  if (!(await rateLimit(requestKey(req, owner), 20))) {
    return NextResponse.json({ ok: false, error: "Too many stake requests" }, { status: 429 });
  }

  if (body.action === "unlock") {
    const row = stakeRow(owner, body.id ?? "");
    if (!row) return NextResponse.json({ ok: false, error: "Lock not found" }, { status: 404 });
    if (row.returned) return NextResponse.json({ ok: false, error: "Already unlocked" }, { status: 400 });
    if (Date.now() < row.unlockAt) {
      return NextResponse.json({ ok: false, error: "Term is still locked" }, { status: 400 });
    }
    const payout = positionPayout(row);
    const sent = await sendTreasuryToken(
      owner,
      payout,
      new PublicKey(STAKE_MINT),
      STAKE_DECIMALS,
      { signer: stakeOperatorKey(), expectedPubkey: STAKE_TREASURY },
    );
    if (!sent.ok) return NextResponse.json({ ok: false, error: sent.error }, { status: 502 });
    markStakeReturned(row.id, sent.signature);
    await flushVenue();
    return NextResponse.json({
      ok: true,
      signature: sent.signature,
      payout,
      ...(await snapshot(owner)),
    });
  }

  const term = termByDays(Number(body.days));
  const signature = body.signature ?? "";
  const claimed = Number(body.amount);
  if (!term || !signature || !(claimed >= 1)) {
    return NextResponse.json({ ok: false, error: "Send $FLOYDEX, then pick a term" }, { status: 400 });
  }

  const connection = new Connection(solanaRpcUrl(), "confirmed");
  try {
    await connection.confirmTransaction(signature, "confirmed");
  } catch {
    /* fetch below */
  }
  const tx = await waitForParsedTx(connection, signature);
  if (!tx) {
    return NextResponse.json({ ok: false, error: "Transfer not found yet — retry" }, { status: 409 });
  }
  if (tx.meta?.err) {
    return NextResponse.json({ ok: false, error: "On-chain transfer failed" }, { status: 400 });
  }
  const treasuryAta = getAssociatedTokenAddressSync(
    new PublicKey(STAKE_MINT),
    new PublicKey(STAKE_TREASURY),
  ).toBase58();
  const credited = creditedFloydex(tx, owner, treasuryAta);
  if (!(credited >= 1)) {
    return NextResponse.json({ ok: false, error: "No $FLOYDEX transfer to the stake wallet" }, { status: 400 });
  }
  const principal = Math.min(credited, claimed);
  const now = Date.now();
  const position: StakePosition = {
    id: randomUUID(),
    owner,
    days: term.days,
    principal,
    apyPct: term.apyPct,
    reward: stakeReward(principal, term.apyPct),
    lockedAt: now,
    unlockAt: now + term.days * 86_400_000,
    signature,
  };
  const result = addStakeLock(position);
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: 400 });
  }
  await flushVenue();
  return NextResponse.json({ ok: true, position, ...(await snapshot(owner)) });
}
