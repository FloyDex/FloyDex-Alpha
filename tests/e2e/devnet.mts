/**
 * Phase 2 gate, part 2 (09): a real liquidation on devnet against Pyth's
 * free sponsored shard-0 feed (`06` §8). Run via scripts/devnet-gate.sh.
 *
 * The program must already be deployed at its declared id. This script
 * bootstraps the exchange (if needed), lists the devnet USDC mint as the
 * settlement asset, creates a SOL-PERP market on the sponsored SOL/USD push
 * feed, initializes and stakes the insurance fund, and then reproduces the
 * local gate's liquidation: a short Regular session, two users at ~22%
 * equity, and when the session closes the Closed ×2 maintenance (30%) makes
 * both liquidatable; a keeper liquidates them by position transfer. A
 * permissionless `update_funding` runs too.
 *
 * Every key is written to .devnet/keys before any chain call (11 L14), and
 * the addresses and signatures go to deployments/devnet.json (11 L3). The
 * script refuses to continue if the feed is stale (11 L2).
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
import {
  createAssociatedTokenAccountIdempotent,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
  mintTo,
  transfer,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { computeDomain, encodeOrder, FLAG_IS_LONG, type Order } from "../../sdk/src/order.ts";
import { ED25519_PROGRAM_ID, ed25519InstructionData, signEd25519 } from "../../sdk/src/ed25519.ts";
import { pushFeedAddress } from "./mock-pyth.mts";

const { AnchorProvider, Program, Wallet, BN } = anchorPkg as unknown as typeof import("@coral-xyz/anchor");

const RPC = process.env.RPC_URL!;
const USDC_MINT = new PublicKey(process.env.USDC_MINT!);
const KEYS = process.env.KEYS_DIR ?? ".devnet/keys";
const DEPLOYER = process.env.DEPLOYER ?? `${process.env.HOME}/.config/solana/id.json`;
const FUNDER = process.env.USDC_FUNDER ?? DEPLOYER;
// Pyth SOL/USD; the sponsored push-feed account is shard 0 of this id.
const SOL_FEED = Buffer.from("ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d", "hex");
const MARKET_ID = Number(process.env.MARKET_ID ?? 1);
const SESSION_SECS = Number(process.env.SESSION_SECS ?? 60);

const connection = new Connection(RPC, "confirmed");
// Devnet's genesis hash: the record in deployments/ is only ever written for
// devnet itself (11 L3). A rehearsal on another cluster needs
// ALLOW_NON_DEVNET=1 and writes to the gitignored .devnet/ instead.
const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const P = 10n ** 18n;
const W = 1_000_000_000n;

const readKey = (path: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
function key(name: string): Keypair {
  const path = `${KEYS}/${name}.json`;
  if (!existsSync(path)) {
    mkdirSync(KEYS, { recursive: true });
    writeFileSync(path, JSON.stringify(Array.from(Keypair.generate().secretKey)), { mode: 0o400 });
  }
  return readKey(path);
}
// Persist every test key before any chain call (11 L14).
const names = ["operator", "guardian", "calendar", "carol", "dave", "carol_session", "dave_session", "keeper", "staker"] as const;
const K = Object.fromEntries(names.map((n) => [n, key(n)])) as Record<(typeof names)[number], Keypair>;
const deployer = readKey(DEPLOYER);
const funder = readKey(FUNDER);

const idl = JSON.parse(readFileSync("target/idl/floydex_perps.json", "utf8"));
const program = new Program(idl, new AnchorProvider(connection, new Wallet(deployer), { commitment: "confirmed" }));
const PROGRAM_ID = program.programId;

const pda = (...seeds: (Buffer | Uint8Array)[]) => PublicKey.findProgramAddressSync(seeds.map((s) => Buffer.from(s)), PROGRAM_ID)[0];
const u16 = (v: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; };
const u64 = (v: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(v); return b; };
const exchangePda = pda(Buffer.from("exchange"));
const marketPda = pda(Buffer.from("market"), u16(MARKET_ID));
const collateralPda = pda(Buffer.from("collateral"), USDC_MINT.toBuffer());
const vaultPda = pda(Buffer.from("vault"), USDC_MINT.toBuffer());
const insurancePda = pda(Buffer.from("insurance"));
const userPda = (o: PublicKey) => pda(Buffer.from("user"), o.toBuffer(), Buffer.from([0]));
const orderPda = (o: PublicKey, n: bigint) => pda(Buffer.from("order"), o.toBuffer(), Buffer.from([0]), u64(n));
const stakePda = (o: PublicKey) => pda(Buffer.from("stake"), o.toBuffer());
const eventAuthority = pda(Buffer.from("__event_authority"));
const priceUpdate = pushFeedAddress(0, SOL_FEED);
const bn = (v: bigint | number) => new BN(v.toString());
const i128 = (pod: { le: number[] }) => BigInt.asIntN(128, Buffer.from(pod.le).reduceRight((a, b) => (a << 8n) | BigInt(b), 0n));
const explorer = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;

async function send(ixs: TransactionInstruction[], payer: Keypair, signers: Keypair[] = []): Promise<string> {
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000 }), ...ixs);
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
  tx.sign(payer, ...signers.filter((s) => !s.publicKey.equals(payer.publicKey)));
  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  const res = await connection.confirmTransaction(sig, "confirmed");
  if (res.value.err) {
    const t = await connection.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    throw new Error(`tx ${sig} failed: ${JSON.stringify(res.value.err)}\n${t?.meta?.logMessages?.join("\n")}`);
  }
  return sig;
}

async function chainNow(): Promise<number> {
  return (await connection.getBlockTime(await connection.getSlot("confirmed"))) ?? Math.floor(Date.now() / 1000);
}
async function sleepUntil(unix: number) {
  while ((await chainNow()) < unix) await new Promise((r) => setTimeout(r, 1_000));
}

/** The sponsored feed: owner, full verification, price and age (11 L2). */
async function readFeed() {
  const info = await connection.getAccountInfo(priceUpdate, "confirmed");
  if (!info) throw new Error(`no sponsored SOL/USD push feed at ${priceUpdate.toBase58()} on this cluster`);
  const d = info.data;
  let o = 8 + 32;
  const level = d[o]; o += 1 + 32;
  const price = d.readBigInt64LE(o); o += 16;
  const expo = d.readInt32LE(o); o += 4;
  const publish = Number(d.readBigInt64LE(o));
  const age = (await chainNow()) - publish;
  return { owner: info.owner.toBase58(), level, price, expo, publish, age };
}

const toWire = (price: bigint, expo: number) => (expo >= -9 ? price * 10n ** BigInt(9 + expo) : price / 10n ** BigInt(-9 - expo));

async function fundUsdc(to: PublicKey, amount: bigint) {
  const mint = await getMint(connection, USDC_MINT);
  const ata = await createAssociatedTokenAccountIdempotent(connection, deployer, USDC_MINT, to);
  if (mint.mintAuthority?.equals(funder.publicKey)) {
    await mintTo(connection, deployer, USDC_MINT, ata, funder, amount);
  } else {
    const from = getAssociatedTokenAddressSync(USDC_MINT, funder.publicKey);
    await transfer(connection, deployer, from, ata, funder, amount);
  }
  return ata;
}

async function ensureSol(k: PublicKey, sol: number) {
  const bal = await connection.getBalance(k);
  if (bal >= sol * 1e9) return;
  await send([SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: k, lamports: Math.ceil(sol * 1e9 - bal) })], deployer);
}

type User = { owner: Keypair; signer: Keypair; user: PublicKey; wallet: PublicKey };
async function newUser(owner: Keypair, session: Keypair | null, dollars: bigint, scale: bigint): Promise<User> {
  await ensureSol(owner.publicKey, 0.05);
  const wallet = await fundUsdc(owner.publicKey, dollars * scale);
  const user = userPda(owner.publicKey);
  const move = { exchange: exchangePda, owner: owner.publicKey, userAccount: user, collateral: collateralPda, mint: USDC_MINT, vault: vaultPda, userToken: wallet, tokenProgram: TOKEN_PROGRAM_ID, eventAuthority, program: PROGRAM_ID };
  const ixs: TransactionInstruction[] = [];
  if (!(await connection.getAccountInfo(user))) {
    ixs.push(await program.methods.initUser(0).accountsStrict({ owner: owner.publicKey, userAccount: user, systemProgram: SystemProgram.programId }).instruction());
  }
  ixs.push(await program.methods.deposit(bn(dollars * scale)).accountsStrict(move).instruction());
  if (session) {
    ixs.push(
      await program.methods.setDelegate(session.publicKey, bn((await chainNow()) + 86_400))
        .accountsStrict({ owner: owner.publicKey, userAccount: user, eventAuthority, program: PROGRAM_ID }).instruction(),
    );
  }
  await send(ixs, owner);
  return { owner, signer: session ?? owner, user, wallet };
}

async function main() {
  const record: Record<string, unknown> = { cluster: "devnet", programId: PROGRAM_ID.toBase58(), rpc: new URL(RPC).host };

  // --- preflight: the program is deployed at its declared id; the feed is live ---
  const prog = await connection.getAccountInfo(PROGRAM_ID);
  if (!prog?.executable) throw new Error(`program ${PROGRAM_ID.toBase58()} is not deployed on this cluster`);
  let feed = await readFeed();
  console.log(`SOL/USD sponsored feed ${priceUpdate.toBase58()}: ${Number(feed.price) * 10 ** feed.expo}, age ${feed.age}s, verification ${feed.level}`);
  if (feed.owner !== "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ") throw new Error(`feed owner ${feed.owner} is not the Pyth receiver`);
  if (feed.level !== 1) throw new Error("feed is not fully verified");
  if (feed.age > 120) throw new Error(`feed is stale (${feed.age}s): refusing to continue (11 L2)`);

  const genesisHash = await connection.getGenesisHash();
  const isDevnet = genesisHash === DEVNET_GENESIS;
  if (!isDevnet && process.env.ALLOW_NON_DEVNET !== "1") throw new Error(`genesis ${genesisHash} is not devnet`);
  const genesis = new PublicKey(genesisHash).toBytes();
  const domain = computeDomain(genesis, PROGRAM_ID.toBytes());
  const mint = await getMint(connection, USDC_MINT);
  const scale = 10n ** BigInt(mint.decimals);
  for (const k of [K.operator, K.calendar, K.keeper, K.staker]) await ensureSol(k.publicKey, 0.2);

  // --- exchange (once), USDC, market, insurance ---
  if (!(await connection.getAccountInfo(exchangePda))) {
    const init = await program.methods
      .initializeExchange({ domain: Array.from(domain), guardian: K.guardian.publicKey, calendarAuthority: K.calendar.publicKey, feeConfig: { makerFeeBps: 100, takerFeeBps: 100 }, maxTotalOiPolicyBps: 100_000 })
      .accountsStrict({
        exchange: exchangePda, authority: deployer.publicKey, program: PROGRAM_ID,
        programData: PublicKey.findProgramAddressSync([PROGRAM_ID.toBuffer()], new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111"))[0],
        systemProgram: SystemProgram.programId,
      })
      .instruction();
    const ops = await program.methods.setOperators([K.operator.publicKey, PublicKey.default, PublicKey.default, PublicKey.default]).accountsStrict({ exchange: exchangePda, admin: deployer.publicKey }).instruction();
    record.initializeExchange = await send([init, ops], deployer);
  }
  const ex: any = await program.account.exchange.fetch(exchangePda);
  if (Buffer.compare(Buffer.from(ex.domain), Buffer.from(domain)) !== 0) throw new Error("Exchange.domain does not match this cluster and program (11 L3)");
  if (!(await connection.getAccountInfo(collateralPda))) {
    record.addCollateral = await send([
      await program.methods
        .addCollateral({ haircutBps: 0, pythFeedId: Array(32).fill(0), pythShardId: 0, maxOracleAgeSecs: bn(0), maxOracleConfidenceBps: 0, depositCap: bn(10_000_000n * scale), isSettlement: true, closedHaircutBps: 0, maxClosedAgeSecs: bn(0) })
        .accountsStrict({ exchange: exchangePda, admin: deployer.publicKey, mint: USDC_MINT, collateral: collateralPda, vault: vaultPda, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId })
        .instruction(),
    ], deployer);
  }
  if (!(await connection.getAccountInfo(marketPda))) {
    // SOL-PERP on the sponsored feed: max age 120 s (06 §8: ≥ 70 s on the
    // 55 s heartbeat), 1% execution band, IM 20% / MM 15%, no ramp or grace
    // so the session close bites at once (Closed maintenance 30%).
    record.createMarket = await send([
      await program.methods
        .createMarket(MARKET_ID, {
          baseAsset: Array.from(Buffer.from("SOL".padEnd(16, "\0"))), pythFeedId: Array.from(SOL_FEED), pythShardId: 0,
          maxLeverageBps: 50_000, initialMarginBps: 2_000, maintenanceMarginBps: 1_500, liquidationFeeBps: 50,
          maxOpenInterest: bn(1_000_000n * P), maxOracleAgeSecs: bn(120), maxOracleConfidenceBps: 100, maxExecutionDeviationBps: 100, oiPolicyBps: 0,
          sessionPolicy: { extendedMarginMultBps: 15_000, closedMarginMultBps: 20_000, closedBandBaseBps: 200, closedBandPerHourBps: 25, closedBandMaxBps: 1_500, closedOiCapBps: 5_000, closeRampSecs: 0, closeGraceSecs: 0 },
          fundingImbalanceCoeff: bn(P), fundingMaxRatePerHour: bn(P / 1_000n),
        })
        .accountsStrict({ exchange: exchangePda, admin: deployer.publicKey, market: marketPda, systemProgram: SystemProgram.programId })
        .instruction(),
    ], deployer);
  }
  if (!(await connection.getAccountInfo(insurancePda))) {
    record.initInsurance = await send([
      await program.methods.initInsurance(bn(7 * 86_400), { maxRewardBps: 20, partialLiquidationBps: 5_000 })
        .accountsStrict({ exchange: exchangePda, admin: deployer.publicKey, insurance: insurancePda, settlementCollateral: collateralPda, systemProgram: SystemProgram.programId })
        .instruction(),
    ], deployer);
    const stakerWallet = await fundUsdc(K.staker.publicKey, 1_000n * scale);
    record.stake = await send([
      await program.methods.stake(bn(1_000n * scale)).accountsStrict({
        exchange: exchangePda, insurance: insurancePda, staker: K.staker.publicKey, stakePosition: stakePda(K.staker.publicKey), settlementCollateral: collateralPda,
        mint: USDC_MINT, vault: vaultPda, stakerToken: stakerWallet, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId, eventAuthority, program: PROGRAM_ID,
      }).instruction(),
    ], K.staker);
  }

  // --- a short Regular session; two users at ~22% equity ---
  const start = (await chainNow()) + 10;
  const end = start + SESSION_SECS;
  record.postSessionCalendar = await send([
    await program.methods.postSessionCalendar([{ start: bn(start), end: bn(end), session: 0 }])
      .accountsStrict({ exchange: exchangePda, calendarAuthority: K.calendar.publicKey, market: marketPda }).instruction(),
  ], K.calendar);
  const C = await newUser(K.carol, K.carol_session, 100n, scale);
  const D = await newUser(K.dave, K.dave_session, 100n, scale);
  const keeper = await newUser(K.keeper, null, 500n, scale);
  await sleepUntil(start + 1);

  feed = await readFeed();
  if (feed.age > 120) throw new Error(`feed went stale (${feed.age}s)`);
  const px = toWire(feed.price, feed.expo); // SOL at the oracle, 1e9
  // Notional ≈ 100 / 0.22 USDC.
  const size = (100n * W * W * 100n) / (22n * px);
  const expiry = BigInt(end + 3_600);
  const nonce = BigInt(Date.now());
  const orders: Order[] = [C, D].map((u, i) => ({
    domain, owner: u.owner.publicKey.toBytes(), subId: 0, marketId: MARKET_ID, flags: i === 0 ? FLAG_IS_LONG : 0,
    size, limitPrice: px, nonce, expiryTs: expiry,
  }));
  const msgs = orders.map(encodeOrder);
  const ed = new TransactionInstruction({
    programId: new PublicKey(ED25519_PROGRAM_ID), keys: [],
    data: Buffer.from(ed25519InstructionData([C, D].map((u, i) => ({ publicKey: u.signer.publicKey.toBytes(), signature: signEd25519(u.signer.secretKey, msgs[i]), message: msgs[i] })))),
  });
  const arg = (o: Order) => ({ marketId: o.marketId, flags: o.flags, size: bn(o.size), limitPrice: bn(o.limitPrice), nonce: bn(o.nonce), expiryTs: bn(o.expiryTs) });
  const remaining: AccountMeta[] = [
    { pubkey: C.user, isSigner: false, isWritable: true },
    { pubkey: D.user, isSigner: false, isWritable: true },
    { pubkey: orderPda(C.owner.publicKey, nonce), isSigner: false, isWritable: true },
    { pubkey: orderPda(D.owner.publicKey, nonce), isSigner: false, isWritable: true },
  ];
  const settle = await program.methods
    .settleFills([{ maker: arg(orders[0]), taker: arg(orders[1]), fillSize: bn(size), fillPrice: bn(px), makerSig: { ixIndex: 2, sigIndex: 0 }, takerSig: { ixIndex: 2, sigIndex: 1 } }])
    .accountsStrict({
      exchange: exchangePda, operator: K.operator.publicKey, market: marketPda, priceUpdate, settlementCollateral: collateralPda,
      instructions: SYSVAR_INSTRUCTIONS_PUBKEY, systemProgram: SystemProgram.programId, insurance: insurancePda, eventAuthority, program: PROGRAM_ID,
    })
    .remainingAccounts(remaining)
    .instruction();
  // ix 0 = compute price (added by send), 1 = compute limit, 2 = ed25519, 3 = settle.
  record.settleFills = await send([ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }), ed, settle], K.operator);
  console.log(`fill: carol long / dave short ${Number(size) / 1e9} SOL @ ${Number(px) / 1e9} → ${explorer(record.settleFills as string)}`);

  record.updateFunding = await send([
    await program.methods.updateFunding().accountsStrict({ exchange: exchangePda, market: marketPda, priceUpdate, eventAuthority, program: PROGRAM_ID }).instruction(),
  ], K.keeper);
  console.log(`update_funding → ${explorer(record.updateFunding as string)}`);

  // --- the session closes: Closed ×2 maintenance (30%) > ~22% equity ---
  console.log(`waiting for the session to close at ${end}…`);
  await sleepUntil(end + 2);
  const liquidations: string[] = [];
  for (const victim of [C, D]) {
    const u: any = await program.account.userAccount.fetch(victim.user);
    const pos = u.positions.find((p: any) => p.inUse);
    const sig = await send([
      ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
      await program.methods.liquidate(bn(pos.positionId.toString())).accountsStrict({
        exchange: exchangePda, insurance: insurancePda, liquidator: keeper.owner.publicKey, liquidatorAccount: keeper.user, userAccount: victim.user,
        market: marketPda, priceUpdate, eventAuthority, program: PROGRAM_ID,
      }).instruction(),
    ], keeper.owner);
    liquidations.push(sig);
    const after: any = await program.account.userAccount.fetch(victim.user);
    const left = after.positions.find((p: any) => p.inUse);
    const taken = i128(pos.size) - (left ? i128(left.size) : 0n);
    console.log(`liquidate: keeper took ${Number(taken) / 1e18} SOL → ${explorer(sig)}`);
  }
  record.liquidations = liquidations;
  const m: any = await program.account.market.fetch(marketPda);
  if (i128(m.oiLong) !== i128(m.oiShort)) throw new Error("OI not two-sided");
  record.accounts = {
    exchange: exchangePda.toBase58(), market: marketPda.toBase58(), usdcMint: USDC_MINT.toBase58(), settlementCollateral: collateralPda.toBase58(),
    vault: vaultPda.toBase58(), insurance: insurancePda.toBase58(), solUsdPushFeed: priceUpdate.toBase58(),
    operator: K.operator.publicKey.toBase58(), calendarAuthority: K.calendar.publicKey.toBase58(), guardian: K.guardian.publicKey.toBase58(),
  };
  record.at = new Date().toISOString();
  record.genesisHash = genesisHash;
  const out = isDevnet ? "deployments/devnet.json" : ".devnet/rehearsal.json";
  mkdirSync(out.slice(0, out.lastIndexOf("/")), { recursive: true });
  writeFileSync(out, JSON.stringify(record, null, 2) + "\n");
  console.log(
    isDevnet
      ? "PHASE 2 DEVNET GATE: PASS (a liquidation executed on devnet; deployments/devnet.json written)"
      : `rehearsal passed on a non-devnet cluster (${out})`,
  );
}

main().catch((e) => {
  console.error(e);
  console.error("PHASE 2 DEVNET GATE: FAIL");
  process.exit(1);
});
