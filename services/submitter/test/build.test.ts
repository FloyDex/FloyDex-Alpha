import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import { FLAG_IS_LONG, FLAG_REDUCE_ONLY } from "../../../sdk/src/order.ts";
import { signEd25519 } from "../../../sdk/src/ed25519.ts";
import { rebuildOrderMessage, type StoredFillPayload, type StoredOrderArgs } from "../src/message.ts";
import { buildFillPlan, settleFillsStaticAccounts, type BuildInputs, type UserContext } from "../src/build.ts";
import { derivePushFeedAddress, marketPda, type ChainDirectory } from "../src/accounts.ts";

const programId = Keypair.generate().publicKey;
const domain = new Uint8Array(32).fill(1);

function noPositions(): UserContext {
  return { account: { positions: [], balances: [] } };
}

function makeSide(owner: Keypair, isLong: boolean, marketId: number, nonce: number): StoredOrderArgs {
  const side: StoredOrderArgs = {
    owner: owner.publicKey.toBase58(),
    subId: 0,
    marketId,
    flags: isLong ? FLAG_IS_LONG : 0,
    size: "1000000000",
    limitPrice: "100000000000",
    nonce: String(nonce),
    expiryTs: "9999999999",
    signature: null,
    signerPubkey: null,
  };
  const message = rebuildOrderMessage(domain, side);
  const signature = signEd25519(owner.secretKey, message);
  return { ...side, signature: Buffer.from(signature).toString("base64"), signerPubkey: owner.publicKey.toBase58() };
}

function fill(marketId: number, makerNonce: number, takerNonce: number): { payload: StoredFillPayload; maker: Keypair; taker: Keypair } {
  const maker = Keypair.generate();
  const taker = Keypair.generate();
  return {
    payload: {
      marketId,
      maker: makeSide(maker, true, marketId, makerNonce),
      taker: makeSide(taker, false, marketId, takerNonce),
      fillSize: "500000000",
      fillPrice: "100000000000",
    },
    maker,
    taker,
  };
}

function baseInput(fills: StoredFillPayload[], users: Map<string, UserContext>): BuildInputs {
  const dir: ChainDirectory = {
    programId,
    markets: new Map([[fills[0]!.marketId, { marketId: fills[0]!.marketId, marketPda: marketPda(programId, fills[0]!.marketId), priceUpdate: derivePushFeedAddress(0, new Uint8Array(32).fill(2)) }]]),
    collaterals: new Map(),
  };
  return {
    programId,
    dir,
    domain,
    operator: Keypair.generate().publicKey,
    exchange: Keypair.generate().publicKey,
    market: dir.markets.get(fills[0]!.marketId)!.marketPda,
    priceUpdate: dir.markets.get(fills[0]!.marketId)!.priceUpdate,
    settlementCollateral: Keypair.generate().publicKey,
    insurance: null,
    computeUnitLimit: 300_000,
    priorityFeeMicroLamports: 1,
    settlementIndex: 0,
    fills,
    users,
  };
}

test("buildFillPlan produces one Ed25519 signature pair per fill and matching sig indices", () => {
  const f = fill(1, 1, 2);
  const users = new Map([
    [`${f.maker.publicKey.toBase58()}:0`, noPositions()],
    [`${f.taker.publicKey.toBase58()}:0`, noPositions()],
  ]);
  const plan = buildFillPlan(baseInput([f.payload], users));
  assert.equal(plan.fillArgs.length, 1);
  assert.equal(plan.fillArgs[0]!.makerSig.sigIndex, 0);
  assert.equal(plan.fillArgs[0]!.takerSig.sigIndex, 1);
  assert.equal(plan.fillArgs[0]!.makerSig.ixIndex, 1);
  // 4 fixed accounts (maker_user, taker_user, maker_order, taker_order) + 0 risk accounts (flat users).
  assert.equal(plan.remainingAccounts.length, 4);
  assert.equal(plan.computeIxs.length, 2);
});

test("buildFillPlan packs two same-market fills with distinct sig indices and doubles the fixed remaining accounts", () => {
  const f1 = fill(1, 1, 2);
  const f2 = fill(1, 3, 4);
  const users = new Map([
    [`${f1.maker.publicKey.toBase58()}:0`, noPositions()],
    [`${f1.taker.publicKey.toBase58()}:0`, noPositions()],
    [`${f2.maker.publicKey.toBase58()}:0`, noPositions()],
    [`${f2.taker.publicKey.toBase58()}:0`, noPositions()],
  ]);
  const plan = buildFillPlan(baseInput([f1.payload, f2.payload], users));
  assert.equal(plan.fillArgs.length, 2);
  assert.equal(plan.fillArgs[0]!.makerSig.sigIndex, 0);
  assert.equal(plan.fillArgs[0]!.takerSig.sigIndex, 1);
  assert.equal(plan.fillArgs[1]!.makerSig.sigIndex, 2);
  assert.equal(plan.fillArgs[1]!.takerSig.sigIndex, 3);
  assert.equal(plan.remainingAccounts.length, 8);
});

test("buildFillPlan rejects a batch that mixes markets", () => {
  const f1 = fill(1, 1, 2);
  const f2 = fill(2, 3, 4);
  const users = new Map<string, UserContext>();
  assert.throws(() => buildFillPlan(baseInput([f1.payload, f2.payload], users)), /mixed markets/);
});

test("buildFillPlan includes a side's other-market risk accounts", () => {
  const f = fill(1, 1, 2);
  const otherMarketId = 2;
  const users = new Map([
    [`${f.maker.publicKey.toBase58()}:0`, { account: { positions: [{ in_use: 1, market_id: otherMarketId }], balances: [] } }],
    [`${f.taker.publicKey.toBase58()}:0`, noPositions()],
  ]);
  const input = baseInput([f.payload], users);
  input.dir.markets.set(otherMarketId, { marketId: otherMarketId, marketPda: marketPda(programId, otherMarketId), priceUpdate: derivePushFeedAddress(0, new Uint8Array(32).fill(3)) });
  const plan = buildFillPlan(input);
  // 4 fixed + 2 (maker's other-market risk pair) + 0 (taker).
  assert.equal(plan.remainingAccounts.length, 6);
});

test("settleFillsStaticAccounts omits insurance when null and includes it when set", () => {
  const f = fill(1, 1, 2);
  const input = baseInput([f.payload], new Map());
  assert.equal(settleFillsStaticAccounts(input).insurance, null);
  input.insurance = new PublicKey("11111111111111111111111111111111");
  assert.ok(settleFillsStaticAccounts(input).insurance!.equals(input.insurance));
});

test("buildFillPlan throws MissingSignatureError-shaped error when a side has no signature persisted", () => {
  const f = fill(1, 1, 2);
  f.payload.maker.signature = null;
  const users = new Map([
    [`${f.maker.publicKey.toBase58()}:0`, noPositions()],
    [`${f.taker.publicKey.toBase58()}:0`, noPositions()],
  ]);
  assert.throws(() => buildFillPlan(baseInput([f.payload], users)));
});
