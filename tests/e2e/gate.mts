/**
 * Phase 1 + Phase 2 gates, end to end on a local validator (run via
 * scripts/e2e-local.sh).
 *
 * Phase 1: admin bootstraps the exchange (as upgrade authority) → USDC +
 * TSLA market → the keeper posts a Regular window → two users deposit and
 * hand order signing to session keys → N random fills signed by the session
 * keys with the TypeScript encoder and settled by the operator.
 *
 * Phase 2 (09): the insurance fund is initialized and staked; a
 * permissionless `update_funding` moves the funding indexes; a
 * second market ($100) opens a short session, two users take leveraged
 * positions, and when the session closes the Closed ×2 maintenance makes
 * them liquidatable: a keeper liquidates both by position transfer.
 *
 * Conservation throughout (05 §7.1): solvency at several marks, then strict
 * equality once everyone is flat (vault + bad debt == balances + fees +
 * insurance fund), and again after every user withdraws everything.
 */
import anchorPkg from "@coral-xyz/anchor";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Transaction,
  TransactionInstruction,
  type AccountMeta,
} from "@solana/web3.js";
import { createAccount, createMint, getAccount, mintTo, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { readFileSync, writeFileSync } from "node:fs";
import { computeDomain, encodeOrder, FLAG_IS_LONG, FLAG_REDUCE_ONLY, type Order } from "../../sdk/src/order.ts";
import { ED25519_PROGRAM_ID, ed25519InstructionData, signEd25519 } from "../../sdk/src/ed25519.ts";
import { pushFeedAddress } from "./mock-pyth.mts";

const { AnchorProvider, Program, Wallet, BN } = anchorPkg as unknown as typeof import("@coral-xyz/anchor");

const DIR = process.env.E2E_DIR ?? ".e2e";
const FILLS = Number(process.env.E2E_FILLS ?? 1000);
const FEED = Buffer.from(process.env.E2E_FEED!, "hex");
const FEED2 = Buffer.from(process.env.E2E_FEED2!, "hex");
const connection = new Connection(process.env.RPC_URL ?? "http://127.0.0.1:8899", "confirmed");

const P = 10n ** 18n;
const W = 1_000_000_000n; // wire scale
const USDC = 1_000_000n;
const TSLA = 1;
const NVDA = 2;

const key = (name: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(`${DIR}/keys/${name}.json`, "utf8"))));
const [admin, operator, guardian, calendar, alice, bob, aliceSession, bobSession, mintAuthority] = [
  "admin", "operator", "guardian", "calendar", "alice", "bob", "alice_session", "bob_session", "mint_authority",
].map(key);
const [carol, dave, carolSession, daveSession, keeperKey, stakerKey] = [
  "carol", "dave", "carol_session", "dave_session", "keeper", "staker",
].map(key);

const idl = JSON.parse(readFileSync("target/idl/floydex_perps.json", "utf8"));
const provider = new AnchorProvider(connection, new Wallet(admin), { commitment: "confirmed" });
const program = new Program(idl, provider);
const PROGRAM_ID = program.programId;

const pda = (...seeds: (Buffer | Uint8Array)[]) => PublicKey.findProgramAddressSync(seeds.map((s) => Buffer.from(s)), PROGRAM_ID)[0];
const u16 = (v: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; };
const u64 = (v: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(v); return b; };
const exchangePda = pda(Buffer.from("exchange"));
const marketPda = (id: number) => pda(Buffer.from("market"), u16(id));
const userPda = (owner: PublicKey, sub = 0) => pda(Buffer.from("user"), owner.toBuffer(), Buffer.from([sub]));
const orderPda = (owner: PublicKey, sub: number, nonce: bigint) => pda(Buffer.from("order"), owner.toBuffer(), Buffer.from([sub]), u64(nonce));
const insurancePda = pda(Buffer.from("insurance"));
const stakePda = (owner: PublicKey) => pda(Buffer.from("stake"), owner.toBuffer());
const eventAuthority = pda(Buffer.from("__event_authority"));
const priceUpdates: Record<number, PublicKey> = { [TSLA]: pushFeedAddress(0, FEED), [NVDA]: pushFeedAddress(0, FEED2) };

const bn = (v: bigint | number) => new BN(v.toString());
const i128 = (pod: { le: number[] }) => BigInt.asIntN(128, Buffer.from(pod.le).reduceRight((acc, b) => (acc << 8n) | BigInt(b), 0n));
const big = (v: { toString(): string }) => BigInt(v.toString());
const floorDiv = (a: bigint, b: bigint) => { const q = a / b; return (a % b !== 0n && (a < 0n) !== (b < 0n)) ? q - 1n : q; };

async function send(ixs: TransactionInstruction[], payer: Keypair, signers: Keypair[] = []): Promise<string> {
  const tx = new Transaction().add(...ixs);
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
  tx.sign(payer, ...signers.filter((s) => !s.publicKey.equals(payer.publicKey)));
  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  const res = await connection.confirmTransaction(sig, "confirmed");
  if (res.value.err) {
    const t = await connection.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    throw new Error(`tx ${sig} failed: ${JSON.stringify(res.value.err)}\n${t?.meta?.logMessages?.join("\n")}`);
  }
  return sig;
}

async function computeUnits(sig: string): Promise<number> {
  const tx = await connection.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  return tx?.meta?.computeUnitsConsumed ?? 0;
}

async function airdrop(k: PublicKey, sol = 100) {
  const sig = await connection.requestAirdrop(k, sol * 1e9);
  await connection.confirmTransaction(sig, "confirmed");
}

async function chainNow(): Promise<number> {
  const slot = await connection.getSlot("confirmed");
  return (await connection.getBlockTime(slot)) ?? Math.floor(Date.now() / 1000);
}

async function sleepUntil(unix: number) {
  while ((await chainNow()) < unix) await new Promise((r) => setTimeout(r, 400));
}

// ---------------------------------------------------------------- bootstrap

type User = { owner: Keypair; signer: Keypair; user: PublicKey; wallet: PublicKey; move: any };
let usdc: PublicKey;
let domain: Uint8Array;
let collateral: PublicKey;
let vault: PublicKey;

function marketParams(feed: Buffer, symbol: string, overrides: Record<string, unknown> = {}, session: Record<string, unknown> = {}) {
  return {
    baseAsset: Array.from(Buffer.from(symbol.padEnd(16, "\0"))),
    pythFeedId: Array.from(feed),
    pythShardId: 0,
    maxLeverageBps: 50_000,
    initialMarginBps: 2_000,
    maintenanceMarginBps: 1_000,
    liquidationFeeBps: 50,
    maxOpenInterest: bn(1_000_000n * P),
    // Local only: the mocked price is written once at genesis, so allow an
    // hour of age. Mainnet (06 §8) uses >= 70 s on sponsored feeds.
    maxOracleAgeSecs: bn(3_600),
    maxOracleConfidenceBps: 100,
    maxExecutionDeviationBps: 100,
    oiPolicyBps: 0,
    sessionPolicy: {
      extendedMarginMultBps: 15_000,
      closedMarginMultBps: 20_000,
      closedBandBaseBps: 200,
      closedBandPerHourBps: 25,
      closedBandMaxBps: 1_500,
      closedOiCapBps: 5_000,
      closeRampSecs: 3_600,
      closeGraceSecs: 1_800,
      ...session,
    },
    fundingImbalanceCoeff: bn(P),
    fundingMaxRatePerHour: bn(P / 1_000n),
    ...overrides,
  };
}

async function postWindow(marketId: number, start: number, end: number) {
  const post = await program.methods
    .postSessionCalendar([{ start: bn(start), end: bn(end), session: 0 }])
    .accountsStrict({ exchange: exchangePda, calendarAuthority: calendar.publicKey, market: marketPda(marketId) })
    .instruction();
  await send([post], calendar);
}

/** Sub-account 0, `dollars` USDC deposited, orders signed by `session` (or the owner). */
async function newUser(owner: Keypair, session: Keypair | null, dollars: bigint): Promise<User> {
  const wallet = await createAccount(connection, owner, usdc, owner.publicKey, Keypair.generate());
  await mintTo(connection, mintAuthority, usdc, wallet, mintAuthority, 2n * dollars * USDC);
  const user = userPda(owner.publicKey);
  const move = { exchange: exchangePda, owner: owner.publicKey, userAccount: user, collateral, mint: usdc, vault, userToken: wallet, tokenProgram: TOKEN_PROGRAM_ID, eventAuthority, program: PROGRAM_ID };
  const ixs = [
    await program.methods.initUser(0).accountsStrict({ owner: owner.publicKey, userAccount: user, systemProgram: SystemProgram.programId }).instruction(),
    await program.methods.deposit(bn(dollars * USDC)).accountsStrict(move).instruction(),
  ];
  if (session) {
    ixs.push(
      await program.methods
        .setDelegate(session.publicKey, bn((await chainNow()) + 86_400))
        .accountsStrict({ owner: owner.publicKey, userAccount: user, eventAuthority, program: PROGRAM_ID })
        .instruction(),
    );
  }
  await send(ixs, owner);
  return { owner, signer: session ?? owner, user, wallet, move };
}

async function bootstrap() {
  for (const k of [admin, operator, guardian, calendar, alice, bob, mintAuthority, carol, dave, keeperKey, stakerKey]) await airdrop(k.publicKey);

  const init = await program.methods
    .initializeExchange({
      domain: Array.from(domain),
      guardian: guardian.publicKey,
      calendarAuthority: calendar.publicKey,
      feeConfig: { makerFeeBps: 100, takerFeeBps: 100 },
      maxTotalOiPolicyBps: 100_000,
    })
    .accountsStrict({
      exchange: exchangePda,
      authority: admin.publicKey,
      program: PROGRAM_ID,
      programData: PublicKey.findProgramAddressSync([PROGRAM_ID.toBuffer()], new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111"))[0],
      systemProgram: SystemProgram.programId,
    })
    .instruction();
  const operators = [operator.publicKey, PublicKey.default, PublicKey.default, PublicKey.default];
  const setOps = await program.methods.setOperators(operators).accountsStrict({ exchange: exchangePda, admin: admin.publicKey }).instruction();
  await send([init, setOps], admin);

  usdc = await createMint(connection, mintAuthority, mintAuthority.publicKey, null, 6, Keypair.generate(), undefined, TOKEN_PROGRAM_ID);
  collateral = pda(Buffer.from("collateral"), usdc.toBuffer());
  vault = pda(Buffer.from("vault"), usdc.toBuffer());
  const addUsdc = await program.methods
    .addCollateral({
      haircutBps: 0,
      pythFeedId: Array(32).fill(0),
      pythShardId: 0,
      maxOracleAgeSecs: bn(0),
      maxOracleConfidenceBps: 0,
      depositCap: bn(10_000_000n * USDC),
      isSettlement: true,
      closedHaircutBps: 0,
      maxClosedAgeSecs: bn(0),
    })
    .accountsStrict({ exchange: exchangePda, admin: admin.publicKey, mint: usdc, collateral, vault, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId })
    .instruction();
  const createMarket = await program.methods
    .createMarket(TSLA, marketParams(FEED, "TSLA"))
    .accountsStrict({ exchange: exchangePda, admin: admin.publicKey, market: marketPda(TSLA), systemProgram: SystemProgram.programId })
    .instruction();
  await send([addUsdc, createMarket], admin);

  // The keeper posts a Regular window starting in 2 s (only future windows
  // may be posted), then we wait for it to open.
  const start = (await chainNow()) + 2;
  await postWindow(TSLA, start, start + 86_400);
  await sleepUntil(start + 1);

  const A = await newUser(alice, aliceSession, 50_000n);
  const B = await newUser(bob, bobSession, 50_000n);
  return [A, B];
}

// -------------------------------------------------------------------- fills

const nonces = new Map<string, bigint>();
const nextNonce = (k: PublicKey) => { const n = (nonces.get(k.toBase58()) ?? 0n) + 1n; nonces.set(k.toBase58(), n); return n; };

/** A fill of `size` at `price` (wire units): `maker` takes `makerLong`. */
async function fillIx(marketId: number, maker: User, taker: User, makerLong: boolean, size: bigint, price: bigint, expiry: bigint, reduceOnly = false) {
  const sides = [maker, taker];
  const orders: Order[] = sides.map((s, i) => ({
    domain, owner: s.owner.publicKey.toBytes(), subId: 0, marketId,
    flags: ((i === 0) === makerLong ? FLAG_IS_LONG : 0) | (reduceOnly ? FLAG_REDUCE_ONLY : 0),
    size, limitPrice: price, nonce: nextNonce(s.owner.publicKey), expiryTs: expiry,
  }));
  const msgs = orders.map(encodeOrder);
  const edData = ed25519InstructionData(
    sides.map((s, i) => ({ publicKey: s.signer.publicKey.toBytes(), signature: signEd25519(s.signer.secretKey, msgs[i]), message: msgs[i] })),
  );
  const ed = new TransactionInstruction({ programId: new PublicKey(ED25519_PROGRAM_ID), keys: [], data: Buffer.from(edData) });
  const arg = (o: Order) => ({ marketId: o.marketId, flags: o.flags, size: bn(o.size), limitPrice: bn(o.limitPrice), nonce: bn(o.nonce), expiryTs: bn(o.expiryTs) });
  const remaining: AccountMeta[] = [
    { pubkey: maker.user, isSigner: false, isWritable: true },
    { pubkey: taker.user, isSigner: false, isWritable: true },
    { pubkey: orderPda(maker.owner.publicKey, 0, orders[0].nonce), isSigner: false, isWritable: true },
    { pubkey: orderPda(taker.owner.publicKey, 0, orders[1].nonce), isSigner: false, isWritable: true },
  ];
  const insuranceLive = (await connection.getAccountInfo(insurancePda, "confirmed")) !== null;
  const settle = await program.methods
    .settleFills([{ maker: arg(orders[0]), taker: arg(orders[1]), fillSize: bn(size), fillPrice: bn(price), makerSig: { ixIndex: 1, sigIndex: 0 }, takerSig: { ixIndex: 1, sigIndex: 1 } }])
    .accountsStrict({
      exchange: exchangePda, operator: operator.publicKey, market: marketPda(marketId), priceUpdate: priceUpdates[marketId], settlementCollateral: collateral,
      instructions: SYSVAR_INSTRUCTIONS_PUBKEY, systemProgram: SystemProgram.programId, insurance: insuranceLive ? insurancePda : null, eventAuthority, program: PROGRAM_ID,
    })
    .remainingAccounts(remaining)
    .instruction();
  return [ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }), ed, settle];
}

// ------------------------------------------------------------- conservation

async function state(users: User[]) {
  const c: any = await program.account.collateral.fetch(collateral);
  const v = await getAccount(connection, vault, "confirmed");
  const us: any[] = await Promise.all(users.map((u) => program.account.userAccount.fetch(u.user)));
  const markets: Record<number, any> = {};
  for (const id of [TSLA, NVDA]) {
    const info = await connection.getAccountInfo(marketPda(id), "confirmed");
    if (info) markets[id] = await program.account.market.fetch(marketPda(id));
  }
  let fund = 0n;
  let badDebt = 0n;
  if (await connection.getAccountInfo(insurancePda, "confirmed")) {
    const ins: any = await program.account.insurance.fetch(insurancePda);
    fund = big(ins.fund);
    badDebt = big(ins.badDebt);
  }
  const scale = 10n ** BigInt(18 - c.decimals);
  return { fees: big(c.feesAccrued), vault: big(v.amount) * scale, scale, users: us, markets, fund, badDebt };
}

/**
 * balances + fees + insurance fund + Σ(what each position realizes at its
 * market's mark, floored, plus pending funding) — the vault plus recorded
 * bad debt must cover it (05 §7.1).
 */
function liabilities(s: Awaited<ReturnType<typeof state>>, marks: Record<number, bigint>): bigint {
  let total = s.fees + s.fund;
  for (const u of s.users) {
    for (const b of u.balances) if (b.inUse) total += i128(b.amount);
    for (const p of u.positions) {
      if (!p.inUse) continue;
      const size = i128(p.size);
      const entry = i128(p.entryPrice);
      const mark = marks[p.marketId];
      total += floorDiv(size * (p.isLong ? mark - entry : entry - mark), P);
      const m = s.markets[p.marketId];
      const index = i128(p.isLong ? m.fundingLongIndex : m.fundingShortIndex);
      total += floorDiv(-size * (index - i128(p.lastFundingIndex)), P);
    }
  }
  return total;
}

const slackOf = (s: Awaited<ReturnType<typeof state>>, marks: Record<number, bigint>) => s.vault + s.badDebt - liabilities(s, marks);

// -------------------------------------------------------------------- phase 2

type Phase2 = { fundingLongIndex: string; fundingPremium: string; liquidations: { user: string; size: string; price: string; cu: number }[]; insuranceFund: string };

async function phase2(A: User, B: User, all: User[]): Promise<Phase2> {
  // --- the insurance fund: init, then a staker stakes 20k USDC ---
  const settlementCollateral = collateral;
  await send(
    [
      await program.methods
        .initInsurance(bn(7 * 86_400), { maxRewardBps: 20, partialLiquidationBps: 5_000 })
        .accountsStrict({ exchange: exchangePda, admin: admin.publicKey, insurance: insurancePda, settlementCollateral, systemProgram: SystemProgram.programId })
        .instruction(),
    ],
    admin,
  );
  const stakerWallet = await createAccount(connection, stakerKey, usdc, stakerKey.publicKey, Keypair.generate());
  await mintTo(connection, mintAuthority, usdc, stakerWallet, mintAuthority, 20_000n * USDC);
  await send(
    [
      await program.methods
        .stake(bn(20_000n * USDC))
        .accountsStrict({
          exchange: exchangePda, insurance: insurancePda, staker: stakerKey.publicKey, stakePosition: stakePda(stakerKey.publicKey), settlementCollateral,
          mint: usdc, vault, stakerToken: stakerWallet, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId, eventAuthority, program: PROGRAM_ID,
        })
        .instruction(),
    ],
    stakerKey,
  );
  console.log("insurance: initialized, 20,000 USDC staked");

  // --- funding: anyone calls update_funding; the premium is the book EMA
  // (from the fills above) against the oracle. The sign depends on where the
  // random book left the EMA; "a rich perp makes longs pay" (11 L8) is pinned
  // in the LiteSVM tests, where the clock can be warped. ---
  const before: any = await program.account.market.fetch(marketPda(TSLA));
  await new Promise((r) => setTimeout(r, 1_500));
  const fundingSig = await send(
    [await program.methods.updateFunding().accountsStrict({ exchange: exchangePda, market: marketPda(TSLA), priceUpdate: priceUpdates[TSLA], eventAuthority, program: PROGRAM_ID }).instruction()],
    keeperKey,
  );
  const after: any = await program.account.market.fetch(marketPda(TSLA));
  const longIndex = i128(after.fundingLongIndex);
  const rate = i128(after.fundingRatePerHour);
  if (rate === 0n || longIndex === i128(before.fundingLongIndex) || i128(after.fundingShortIndex) !== -longIndex) {
    throw new Error(`funding did not accrue: rate ${rate}, long index ${longIndex}`);
  }
  console.log(`funding: update_funding executed (${fundingSig.slice(0, 12)}…), rate ${Number(rate) / 1e18}/h, long index ${longIndex}, short index ${-longIndex}`);

  // --- liquidation: a $100 market with a 40 s session; 30% Closed maintenance ---
  const create = await program.methods
    .createMarket(
      NVDA,
      marketParams(FEED2, "NVDA", { maintenanceMarginBps: 1_500 }, { closeRampSecs: 0, closeGraceSecs: 0 }),
    )
    .accountsStrict({ exchange: exchangePda, admin: admin.publicKey, market: marketPda(NVDA), systemProgram: SystemProgram.programId })
    .instruction();
  await send([create], admin);
  const C = await newUser(carol, carolSession, 1_000n);
  const D = await newUser(dave, daveSession, 1_000n);
  const K = await newUser(keeperKey, null, 50_000n);
  all.push(C, D, K);
  const start = (await chainNow()) + 2;
  const end = start + 25;
  await postWindow(NVDA, start, end);
  await sleepUntil(start + 1);
  // Carol long / Dave short 45 @ $100 on 1,000 each: ~22% equity, above the
  // Regular 20% initial margin, below the Closed 30% maintenance.
  await send(await fillIx(NVDA, C, D, true, 45n * W, 100n * W, BigInt(end + 3_600)), operator);
  console.log(`NVDA: carol long / dave short 45 @ $100; the session closes at ${end}`);
  await sleepUntil(end + 2);

  const liquidations: Phase2["liquidations"] = [];
  for (const victim of [C, D]) {
    const u: any = await program.account.userAccount.fetch(victim.user);
    const pos = u.positions.find((p: any) => p.inUse);
    const sig = await send(
      [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
        await program.methods
          .liquidate(bn(big(pos.positionId)))
          .accountsStrict({
            exchange: exchangePda, insurance: insurancePda, liquidator: K.owner.publicKey, liquidatorAccount: K.user, userAccount: victim.user,
            market: marketPda(NVDA), priceUpdate: priceUpdates[NVDA], eventAuthority, program: PROGRAM_ID,
          })
          .instruction(),
      ],
      K.owner,
    );
    const after: any = await program.account.userAccount.fetch(victim.user);
    const left = after.positions.find((p: any) => p.inUse);
    const taken = i128(pos.size) - (left ? i128(left.size) : 0n);
    if (taken <= 0n) throw new Error("liquidation closed nothing");
    const cu = await computeUnits(sig);
    liquidations.push({ user: victim.owner.publicKey.toBase58(), size: (Number(taken) / 1e18).toFixed(9), price: "100", cu });
    console.log(`liquidate: keeper took ${Number(taken) / 1e18} of ${victim === C ? "carol" : "dave"}'s position (${cu} CU)`);
  }
  const m2: any = await program.account.market.fetch(marketPda(NVDA));
  if (i128(m2.oiLong) !== i128(m2.oiShort)) throw new Error("OI not two-sided after liquidation");
  const ins: any = await program.account.insurance.fetch(insurancePda);
  return { fundingLongIndex: longIndex.toString(), fundingPremium: rate.toString(), liquidations, insuranceFund: big(ins.fund).toString() };
}

// -------------------------------------------------------------------- main

let seed = 0x9e3779b97f4a7c15n;
function rand(): bigint {
  seed ^= (seed << 13n) & 0xffffffffffffffffn;
  seed ^= seed >> 7n;
  seed ^= (seed << 17n) & 0xffffffffffffffffn;
  return seed;
}
const range = (lo: bigint, hi: bigint) => lo + (rand() % (hi - lo + 1n));

async function main() {
  const genesis = new PublicKey(await connection.getGenesisHash()).toBytes();
  domain = computeDomain(genesis, PROGRAM_ID.toBytes());
  console.log(`program ${PROGRAM_ID.toBase58()}, domain ${Buffer.from(domain).toString("hex")}`);
  const [A, B] = await bootstrap();
  const all: User[] = [A, B];
  const t0 = Date.now();

  const checks: { fills: number; minSlackWei: string }[] = [];
  async function checkSolvency(label: string, done: number) {
    const s = await state(all);
    let minSlack: bigint | null = null;
    for (const m of [200n * P, 240n * P, 250n * P, 260n * P + 7n, 300n * P]) {
      const slack = slackOf(s, { [TSLA]: m, [NVDA]: (m * 100n) / 250n });
      if (slack < 0n) throw new Error(`INSOLVENT ${label} at mark ${m}: short ${-slack} wei`);
      minSlack = minSlack === null || slack < minSlack ? slack : minSlack;
    }
    checks.push({ fills: done, minSlackWei: minSlack!.toString() });
    console.log(`  ${label}: solvent at 5 marks (min slack ${minSlack} wei), fees ${Number(s.fees) / 1e18} USDC`);
  }

  // Phase 1: random fills in batches sent concurrently; each batch shares a blockhash.
  const BATCH = 8;
  let done = 0;
  const cus: number[] = [];
  while (done < FILLS) {
    const expiry = BigInt((await chainNow()) + 3_600);
    const { blockhash } = await connection.getLatestBlockhash("confirmed");
    const n = Math.min(BATCH, FILLS - done);
    const sigs: string[] = [];
    for (let i = 0; i < n; i++) {
      const aliceLong = rand() % 2n === 0n;
      const size = range(W / 1_000n, 3n * W); // 0.001 .. 3 shares
      const price = range(24_780n, 25_220n) * W / 100n + range(0n, 999n); // inside the 1% band
      const tx = new Transaction().add(...(await fillIx(TSLA, A, B, aliceLong, size, price, expiry)));
      tx.feePayer = operator.publicKey;
      tx.recentBlockhash = blockhash;
      tx.sign(operator);
      sigs.push(await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true }));
    }
    for (const sig of sigs) {
      const r = await connection.confirmTransaction(sig, "confirmed");
      if (r.value.err) {
        const tx = await connection.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
        throw new Error(`fill ${sig} failed: ${JSON.stringify(r.value.err)}\n${tx?.meta?.logMessages?.join("\n")}`);
      }
      cus.push(await computeUnits(sig));
    }
    const before = done;
    done += n;
    if (Math.floor(done / 100) > Math.floor(before / 100) || done === FILLS) await checkSolvency(`${done} fills`, done);
  }
  const secs = (Date.now() - t0) / 1000;

  // Phase 2: insurance, funding, liquidation.
  const p2 = await phase2(A, B, all);
  await checkSolvency("after funding and liquidations", done);

  // Flatten every market: pair a long with a short at the mark (reduce-only).
  for (const [marketId, px] of [[TSLA, 250n * W], [NVDA, 100n * W]] as const) {
    for (let k = 0; k < 20; k++) {
      const s = await state(all);
      const holding = (long: boolean) => all.findIndex((_, i) => s.users[i].positions.some((p: any) => p.inUse && p.marketId === marketId && (p.isLong !== 0) === long));
      const l = holding(true);
      const sh = holding(false);
      if (l < 0) break;
      const size = (x: number) => i128(s.users[x].positions.find((p: any) => p.inUse && p.marketId === marketId).size);
      const n = (size(l) < size(sh) ? size(l) : size(sh)) / W;
      const expiry = BigInt((await chainNow()) + 3_600);
      await send(await fillIx(marketId, all[l], all[sh], false, n, px, expiry, true), operator);
    }
  }
  let s = await state(all);
  const open = s.users.flatMap((u: any) => u.positions.filter((p: any) => p.inUse));
  if (open.length) throw new Error(`not flat: ${open.length} open positions`);
  const flatDust = slackOf(s, { [TSLA]: 0n, [NVDA]: 0n });
  if (flatDust < 0n || flatDust >= s.scale) throw new Error(`strict conservation failed when flat: dust ${flatDust}`);
  console.log(`flat: vault + bad debt == balances + fees + insurance fund (dust ${flatDust} wei < 1 base unit)`);

  // Withdraw everything: the vault is left holding the fees and the fund.
  for (const [i, u] of all.entries()) {
    const b = s.users[i].balances.find((b: any) => b.inUse);
    if (!b) continue;
    const amount = i128(b.amount) / s.scale;
    if (amount > 0n) await send([await program.methods.withdraw(bn(amount)).accountsStrict(u.move).instruction()], u.owner);
  }
  s = await state(all);
  const residual = slackOf(s, { [TSLA]: 0n, [NVDA]: 0n });
  if (residual < 0n || residual >= BigInt(all.length + 1) * s.scale) throw new Error(`after withdrawals the vault holds ${s.vault}, expected fees ${s.fees} + fund ${s.fund}`);

  const sorted = [...cus].sort((a, b) => a - b);
  const report = {
    fills: FILLS,
    seconds: secs,
    fillsPerSecond: FILLS / secs,
    cu: { min: sorted[0], median: sorted[Math.floor(sorted.length / 2)], max: sorted[sorted.length - 1] },
    feesUsdc: Number(s.fees) / 1e18,
    insuranceFundUsdc: Number(s.fund) / 1e18,
    badDebtUsdc: Number(s.badDebt) / 1e18,
    vaultAfterWithdrawalsUsdc: Number(s.vault) / 1e18,
    solvencyChecks: checks.length,
    minSlackWei: checks.reduce((m, c) => (BigInt(c.minSlackWei) < m ? BigInt(c.minSlackWei) : m), BigInt(checks[0].minSlackWei)).toString(),
    flatDustWei: flatDust.toString(),
    phase2: p2,
    usdcMint: usdc.toBase58(),
  };
  writeFileSync(`${DIR}/report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log(`PHASE 1 GATE: PASS (${FILLS} fills, conservation held)`);
  console.log(`PHASE 2 LOCAL GATE: PASS (funding updated, ${p2.liquidations.length} liquidations executed, conservation held)`);
}

main().catch((e) => {
  console.error(e);
  console.error("E2E GATE: FAIL");
  process.exit(1);
});
