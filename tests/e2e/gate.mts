/**
 * Phase 1 gate: end to end on a local validator (run via scripts/e2e-local.sh).
 *
 * admin bootstraps the exchange (as upgrade authority) → USDC + TSLA market →
 * the keeper posts a Regular window → two users deposit and hand order
 * signing to session keys → 1,000 random fills signed by the session keys
 * with the TypeScript encoder and settled by the operator → conservation
 * (solvency at several marks every 100 fills, strict equality once flat, and
 * again after both users withdraw everything).
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
import { computeDomain, encodeOrder, FLAG_IS_LONG, type Order } from "../../sdk/src/order.ts";
import { ED25519_PROGRAM_ID, ed25519InstructionData, signEd25519 } from "../../sdk/src/ed25519.ts";
import { pushFeedAddress } from "./mock-pyth.mts";

const { AnchorProvider, Program, Wallet, BN } = anchorPkg as unknown as typeof import("@coral-xyz/anchor");

const DIR = process.env.E2E_DIR ?? ".e2e";
const FILLS = Number(process.env.E2E_FILLS ?? 1000);
const FEED = Buffer.from(process.env.E2E_FEED!, "hex");
const connection = new Connection(process.env.RPC_URL ?? "http://127.0.0.1:8899", "confirmed");

const P = 10n ** 18n;
const W = 1_000_000_000n; // wire scale
const USDC = 1_000_000n;
const MARKET_ID = 1;

const key = (name: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(`${DIR}/keys/${name}.json`, "utf8"))));
const [admin, operator, guardian, calendar, alice, bob, aliceSession, bobSession, mintAuthority] = [
  "admin", "operator", "guardian", "calendar", "alice", "bob", "alice_session", "bob_session", "mint_authority",
].map(key);

const idl = JSON.parse(readFileSync("target/idl/kryon_perps.json", "utf8"));
const provider = new AnchorProvider(connection, new Wallet(admin), { commitment: "confirmed" });
const program = new Program(idl, provider);
const PROGRAM_ID = program.programId;

const pda = (...seeds: (Buffer | Uint8Array)[]) => PublicKey.findProgramAddressSync(seeds.map((s) => Buffer.from(s)), PROGRAM_ID)[0];
const u16 = (v: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; };
const u64 = (v: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(v); return b; };
const exchangePda = pda(Buffer.from("exchange"));
const marketPda = pda(Buffer.from("market"), u16(MARKET_ID));
const userPda = (owner: PublicKey, sub = 0) => pda(Buffer.from("user"), owner.toBuffer(), Buffer.from([sub]));
const orderPda = (owner: PublicKey, sub: number, nonce: bigint) => pda(Buffer.from("order"), owner.toBuffer(), Buffer.from([sub]), u64(nonce));
const eventAuthority = pda(Buffer.from("__event_authority"));
const priceUpdate = pushFeedAddress(0, FEED);

const bn = (v: bigint | number) => new BN(v.toString());
const i128 = (pod: { le: number[] }) => BigInt.asIntN(128, Buffer.from(pod.le).reduceRight((acc, b) => (acc << 8n) | BigInt(b), 0n));
const floorDiv = (a: bigint, b: bigint) => { const q = a / b; return (a % b !== 0n && (a < 0n) !== (b < 0n)) ? q - 1n : q; };

async function send(ixs: TransactionInstruction[], payer: Keypair, signers: Keypair[] = []): Promise<string> {
  const tx = new Transaction().add(...ixs);
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
  tx.sign(payer, ...signers.filter((s) => !s.publicKey.equals(payer.publicKey)));
  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  const res = await connection.confirmTransaction(sig, "confirmed");
  if (res.value.err) throw new Error(`tx ${sig} failed: ${JSON.stringify(res.value.err)}`);
  return sig;
}

async function airdrop(k: PublicKey, sol = 100) {
  const sig = await connection.requestAirdrop(k, sol * 1e9);
  await connection.confirmTransaction(sig, "confirmed");
}

async function sleepUntil(unix: number) {
  for (;;) {
    const slot = await connection.getSlot("confirmed");
    const t = (await connection.getBlockTime(slot)) ?? 0;
    if (t >= unix) return;
    await new Promise((r) => setTimeout(r, 400));
  }
}

async function chainNow(): Promise<number> {
  const slot = await connection.getSlot("confirmed");
  return (await connection.getBlockTime(slot)) ?? Math.floor(Date.now() / 1000);
}

// ---------------------------------------------------------------- bootstrap

async function bootstrap(domain: Uint8Array) {
  for (const k of [admin, operator, guardian, calendar, alice, bob, mintAuthority]) await airdrop(k.publicKey);

  const init = await program.methods
    .initializeExchange({
      domain: Array.from(domain),
      guardian: guardian.publicKey,
      calendarAuthority: calendar.publicKey,
      feeConfig: { makerFeeBps: 2, takerFeeBps: 5 },
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

  const usdc = await createMint(connection, mintAuthority, mintAuthority.publicKey, null, 6, Keypair.generate(), undefined, TOKEN_PROGRAM_ID);
  const collateral = pda(Buffer.from("collateral"), usdc.toBuffer());
  const vault = pda(Buffer.from("vault"), usdc.toBuffer());
  const addUsdc = await program.methods
    .addCollateral({
      haircutBps: 0,
      pythFeedId: Array(32).fill(0),
      pythShardId: 0,
      maxOracleAgeSecs: bn(0),
      maxOracleConfidenceBps: 0,
      depositCap: bn(1_000_000n * USDC),
      isSettlement: true,
    })
    .accountsStrict({ exchange: exchangePda, admin: admin.publicKey, mint: usdc, collateral, vault, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId })
    .instruction();
  const createMarket = await program.methods
    .createMarket(MARKET_ID, {
      baseAsset: Array.from(Buffer.from("TSLA".padEnd(16, "\0"))),
      pythFeedId: Array.from(FEED),
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
      },
      fundingImbalanceCoeff: bn(P),
      fundingMaxRatePerHour: bn(P / 1_000n),
    })
    .accountsStrict({ exchange: exchangePda, admin: admin.publicKey, market: marketPda, systemProgram: SystemProgram.programId })
    .instruction();
  await send([addUsdc, createMarket], admin);

  // The keeper posts a Regular window starting in 2 s (only future windows
  // may be posted), then we wait for it to open.
  const start = (await chainNow()) + 2;
  const post = await program.methods
    .postSessionCalendar([{ start: bn(start), end: bn(start + 86_400), session: 0 }])
    .accountsStrict({ exchange: exchangePda, calendarAuthority: calendar.publicKey, market: marketPda })
    .instruction();
  await send([post], calendar);
  await sleepUntil(start + 1);

  // Users: sub-account, 50k USDC deposited, session key for 1 day.
  const users = [];
  for (const [owner, session] of [[alice, aliceSession], [bob, bobSession]] as const) {
    const wallet = await createAccount(connection, owner, usdc, owner.publicKey, Keypair.generate());
    await mintTo(connection, mintAuthority, usdc, wallet, mintAuthority, 100_000n * USDC);
    const user = userPda(owner.publicKey);
    const move = { exchange: exchangePda, owner: owner.publicKey, userAccount: user, collateral, mint: usdc, vault, userToken: wallet, tokenProgram: TOKEN_PROGRAM_ID, eventAuthority, program: PROGRAM_ID };
    await send(
      [
        await program.methods.initUser(0).accountsStrict({ owner: owner.publicKey, userAccount: user, systemProgram: SystemProgram.programId }).instruction(),
        await program.methods.deposit(bn(50_000n * USDC)).accountsStrict(move).instruction(),
        await program.methods
          .setDelegate(session.publicKey, bn((await chainNow()) + 86_400))
          .accountsStrict({ owner: owner.publicKey, userAccount: user, eventAuthority, program: PROGRAM_ID })
          .instruction(),
      ],
      owner,
    );
    users.push({ owner, session, user, wallet, move });
  }
  return { usdc, collateral, vault, users };
}

// ------------------------------------------------------------- conservation

async function state(collateral: PublicKey, vault: PublicKey, users: PublicKey[]) {
  const c: any = await program.account.collateral.fetch(collateral);
  const v = await getAccount(connection, vault, "confirmed");
  const us: any[] = await Promise.all(users.map((u) => program.account.userAccount.fetch(u)));
  const scale = 10n ** BigInt(18 - c.decimals);
  return { fees: BigInt(c.feesAccrued.toString()), vault: BigInt(v.amount.toString()) * scale, scale, users: us };
}

/** balances + fees + Σ(what each position realizes at `mark`, floored) ≤ vault. */
function liabilities(s: Awaited<ReturnType<typeof state>>, mark: bigint): bigint {
  let total = s.fees;
  for (const u of s.users) {
    for (const b of u.balances) if (b.inUse) total += i128(b.amount);
    for (const p of u.positions) {
      if (!p.inUse) continue;
      const size = i128(p.size);
      const entry = i128(p.entryPrice);
      total += floorDiv(size * (p.isLong ? mark - entry : entry - mark), P);
    }
  }
  return total;
}

// -------------------------------------------------------------------- fills

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
  const domain = computeDomain(genesis, PROGRAM_ID.toBytes());
  console.log(`program ${PROGRAM_ID.toBase58()}, domain ${Buffer.from(domain).toString("hex")}`);
  const { usdc, collateral, vault, users } = await bootstrap(domain);
  const [A, B] = users;
  const settlementCollateral = collateral;
  const t0 = Date.now();

  const nonces = new Map<string, bigint>();
  const nextNonce = (k: PublicKey) => { const n = (nonces.get(k.toBase58()) ?? 0n) + 1n; nonces.set(k.toBase58(), n); return n; };

  async function fillIx(aliceLong: boolean, size: bigint, price: bigint, expiry: bigint) {
    const orders: Order[] = [];
    const sides = [A, B];
    for (const [i, s] of sides.entries()) {
      const long = i === 0 ? aliceLong : !aliceLong;
      orders.push({
        domain, owner: s.owner.publicKey.toBytes(), subId: 0, marketId: MARKET_ID,
        flags: long ? FLAG_IS_LONG : 0, size, limitPrice: price, nonce: nextNonce(s.owner.publicKey), expiryTs: expiry,
      });
    }
    const msgs = orders.map(encodeOrder);
    const edData = ed25519InstructionData(
      sides.map((s, i) => ({ publicKey: s.session.publicKey.toBytes(), signature: signEd25519(s.session.secretKey, msgs[i]), message: msgs[i] })),
    );
    const ed = new TransactionInstruction({ programId: new PublicKey(ED25519_PROGRAM_ID), keys: [], data: Buffer.from(edData) });
    const arg = (o: Order) => ({ marketId: o.marketId, flags: o.flags, size: bn(o.size), limitPrice: bn(o.limitPrice), nonce: bn(o.nonce), expiryTs: bn(o.expiryTs) });
    const remaining: AccountMeta[] = [
      { pubkey: A.user, isSigner: false, isWritable: true },
      { pubkey: B.user, isSigner: false, isWritable: true },
      { pubkey: orderPda(A.owner.publicKey, 0, orders[0].nonce), isSigner: false, isWritable: true },
      { pubkey: orderPda(B.owner.publicKey, 0, orders[1].nonce), isSigner: false, isWritable: true },
    ];
    const settle = await program.methods
      .settleFills([{ maker: arg(orders[0]), taker: arg(orders[1]), fillSize: bn(size), fillPrice: bn(price), makerSig: { ixIndex: 1, sigIndex: 0 }, takerSig: { ixIndex: 1, sigIndex: 1 } }])
      .accountsStrict({
        exchange: exchangePda, operator: operator.publicKey, market: marketPda, priceUpdate, settlementCollateral,
        instructions: SYSVAR_INSTRUCTIONS_PUBKEY, systemProgram: SystemProgram.programId, eventAuthority, program: PROGRAM_ID,
      })
      .remainingAccounts(remaining)
      .instruction();
    return [ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }), ed, settle];
  }

  const checks: { fills: number; minSlackWei: string }[] = [];
  async function checkSolvency(done: number) {
    const s = await state(collateral, vault, [A.user, B.user]);
    let minSlack: bigint | null = null;
    for (const mark of [200n * P, 240n * P, 250n * P, 260n * P + 7n, 300n * P]) {
      const slack = s.vault - liabilities(s, mark);
      if (slack < 0n) throw new Error(`INSOLVENT after ${done} fills at mark ${mark}: short ${-slack} wei`);
      minSlack = minSlack === null || slack < minSlack ? slack : minSlack;
    }
    checks.push({ fills: done, minSlackWei: minSlack!.toString() });
    console.log(`  ${done} fills: solvent at 5 marks (min slack ${minSlack} wei), fees ${Number(s.fees) / 1e18} USDC`);
  }

  // Random fills in batches sent concurrently; each batch shares a blockhash.
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
      const tx = new Transaction().add(...(await fillIx(aliceLong, size, price, expiry)));
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
      const tx = await connection.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      cus.push(tx?.meta?.computeUnitsConsumed ?? 0);
    }
    const before = done;
    done += n;
    if (Math.floor(done / 100) > Math.floor(before / 100) || done === FILLS) await checkSolvency(done);
  }
  const secs = (Date.now() - t0) / 1000;

  // Flatten: Bob's position mirrors Alice's, so one fill closes both.
  let s = await state(collateral, vault, [A.user, B.user]);
  const pos: any = s.users[0].positions.find((p: any) => p.inUse);
  if (pos) {
    const size = i128(pos.size) / W; // PRECISION → wire
    const expiry = BigInt((await chainNow()) + 3_600);
    await send(await fillIx(!pos.isLong, size, 250n * W, expiry), operator);
  }
  s = await state(collateral, vault, [A.user, B.user]);
  const open = s.users.flatMap((u: any) => u.positions.filter((p: any) => p.inUse));
  if (open.length) throw new Error(`not flat: ${open.length} open positions`);
  const flatDust = s.vault - liabilities(s, 0n);
  if (flatDust < 0n || flatDust >= s.scale) throw new Error(`strict conservation failed when flat: dust ${flatDust}`);
  console.log(`flat: vault == balances + fees (dust ${flatDust} wei < 1 base unit)`);

  // Withdraw everything: the vault is left holding exactly the fees.
  for (const [i, u] of [A, B].entries()) {
    const bal = i128(s.users[i].balances.find((b: any) => b.inUse).amount);
    const amount = bal / s.scale;
    await send([await program.methods.withdraw(bn(amount)).accountsStrict(u.move).instruction()], u.owner);
  }
  s = await state(collateral, vault, [A.user, B.user]);
  const residual = s.vault - liabilities(s, 0n);
  if (residual < 0n || residual >= 2n * s.scale) throw new Error(`after withdrawals the vault holds ${s.vault}, expected fees ${s.fees}`);
  const walletA = await getAccount(connection, A.wallet, "confirmed");
  const walletB = await getAccount(connection, B.wallet, "confirmed");

  const sorted = [...cus].sort((a, b) => a - b);
  const report = {
    fills: FILLS,
    seconds: secs,
    fillsPerSecond: FILLS / secs,
    cu: { min: sorted[0], median: sorted[Math.floor(sorted.length / 2)], max: sorted[sorted.length - 1] },
    feesUsdc: Number(s.fees) / 1e18,
    vaultAfterWithdrawalsUsdc: Number(s.vault) / 1e18,
    walletsUsdc: [Number(walletA.amount) / 1e6, Number(walletB.amount) / 1e6],
    solvencyChecks: checks.length,
    minSlackWei: checks.reduce((m, c) => (BigInt(c.minSlackWei) < m ? BigInt(c.minSlackWei) : m), BigInt(checks[0].minSlackWei)).toString(),
    flatDustWei: flatDust.toString(),
    usdcMint: usdc.toBase58(),
  };
  writeFileSync(`${DIR}/report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log(`PHASE 1 GATE: PASS (${FILLS} fills, conservation held)`);
}

main().catch((e) => {
  console.error(e);
  console.error("PHASE 1 GATE: FAIL");
  process.exit(1);
});
