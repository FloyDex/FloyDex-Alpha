import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { derivePushFeedAddress, riskAccountsFor, marketPda, collateralPda, type ChainDirectory } from "../src/accounts.ts";

const programId = Keypair.generate().publicKey;
const SETTLEMENT_INDEX = 0;

// A PodI128 zero-copy amount, little-endian two's complement (`podI128ToBigInt`'s input shape).
function amount(v: bigint): { le: number[] } {
  const le: number[] = [];
  let x = BigInt.asUintN(128, v);
  for (let i = 0; i < 16; i++) {
    le.push(Number(x & 0xffn));
    x >>= 8n;
  }
  return { le };
}

function dir(markets: number[], collaterals: number[]): ChainDirectory {
  const m = new Map();
  for (const id of markets) {
    m.set(id, { marketId: id, marketPda: marketPda(programId, id), priceUpdate: derivePushFeedAddress(0, new Uint8Array(32).fill(id + 1)) });
  }
  const c = new Map();
  for (const idx of collaterals) {
    const mint = Keypair.generate().publicKey;
    c.set(idx, { index: idx, collateralPda: collateralPda(programId, mint), priceUpdate: derivePushFeedAddress(0, new Uint8Array(32).fill(idx + 10)), mint });
  }
  return { programId, markets: m, collaterals: c };
}

test("riskAccountsFor skips the fill's own (known) market", () => {
  const d = dir([1, 2], []);
  const user = { positions: [{ in_use: 1, market_id: 1 }], balances: [] };
  assert.equal(riskAccountsFor(d, user, [1], SETTLEMENT_INDEX).length, 0);
});

test("riskAccountsFor includes [Market, PriceUpdateV2] for each other open-position market, in slot order", () => {
  const d = dir([1, 2, 3], []);
  const user = {
    positions: [
      { in_use: 1, market_id: 2 },
      { in_use: 0, market_id: 3 }, // not in_use — skipped
      { in_use: 1, market_id: 3 },
    ],
    balances: [],
  };
  const out = riskAccountsFor(d, user, [1], SETTLEMENT_INDEX);
  assert.equal(out.length, 4);
  assert.deepEqual(out[0], d.markets.get(2)!.marketPda);
  assert.deepEqual(out[1], d.markets.get(2)!.priceUpdate);
  assert.deepEqual(out[2], d.markets.get(3)!.marketPda);
  assert.deepEqual(out[3], d.markets.get(3)!.priceUpdate);
});

test("riskAccountsFor dedupes a market seen in two position slots", () => {
  const d = dir([1, 2], []);
  const user = {
    positions: [
      { in_use: 1, market_id: 2 },
      { in_use: 1, market_id: 2 },
    ],
    balances: [],
  };
  assert.equal(riskAccountsFor(d, user, [1], SETTLEMENT_INDEX).length, 2);
});

test("riskAccountsFor throws when a position's market isn't in the directory (stale market registry, fail closed)", () => {
  const d = dir([1], []);
  const user = { positions: [{ in_use: 1, market_id: 99 }], balances: [] };
  assert.throws(() => riskAccountsFor(d, user, [1], SETTLEMENT_INDEX), /not in the chain directory/);
});

test("riskAccountsFor includes [Collateral, PriceUpdateV2, Mint] for each non-zero, non-settlement balance, in slot order", () => {
  const d = dir([1], [2, 3]);
  const user = {
    positions: [],
    balances: [
      { in_use: 1, collateral_index: SETTLEMENT_INDEX, amount: amount(1_000n) }, // settlement — never a remaining account
      { in_use: 0, collateral_index: 2, amount: amount(1_000n) }, // not in_use — skipped
      { in_use: 1, collateral_index: 2, amount: amount(0n) }, // zero amount — skipped, matching health.rs
      { in_use: 1, collateral_index: 2, amount: amount(500n) },
      { in_use: 1, collateral_index: 3, amount: amount(-200n) }, // a realized loss: still non-zero, still included
    ],
  };
  const out = riskAccountsFor(d, user, [], SETTLEMENT_INDEX);
  assert.equal(out.length, 6);
  assert.deepEqual(out[0], d.collaterals.get(2)!.collateralPda);
  assert.deepEqual(out[1], d.collaterals.get(2)!.priceUpdate);
  assert.deepEqual(out[2], d.collaterals.get(2)!.mint);
  assert.deepEqual(out[3], d.collaterals.get(3)!.collateralPda);
});

test("riskAccountsFor throws when a non-zero, non-settlement balance's collateral index isn't in the directory (stale collateral registry, fail closed)", () => {
  const d = dir([1], [2]);
  const user = { positions: [], balances: [{ in_use: 1, collateral_index: 7, amount: amount(500n) }] };
  assert.throws(() => riskAccountsFor(d, user, [], SETTLEMENT_INDEX), /not in the chain directory/);
});

test("marketPda/collateralPda are deterministic PDAs of the program id", () => {
  const a = marketPda(programId, 5);
  const b = marketPda(programId, 5);
  assert.ok(a.equals(b));
  assert.ok(!a.equals(marketPda(programId, 6)));
});
