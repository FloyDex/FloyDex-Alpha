import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cancelOnBook,
  placeOnBook,
  pulseBook,
  resetBooksForTests,
  seedDeskQuotes,
  snapshotBook,
  type RestingOrder,
} from "./onchain-book";

function order(partial: Partial<RestingOrder> & Pick<RestingOrder, "isLong" | "price" | "size">): RestingOrder {
  return {
    owner: partial.owner ?? "Buyer11111111111111111111111111111111111",
    marketId: 1,
    nonce: partial.nonce ?? String(Date.now()) + Math.random(),
    expiryTs: Math.floor(Date.now() / 1000) + 3600,
    reduceOnly: false,
    ...partial,
  };
}

test("desk quotes produce a two-sided book", () => {
  resetBooksForTests();
  seedDeskQuotes(1, 0.22);
  const snap = snapshotBook(1);
  assert.ok(snap.bids.length >= 4);
  assert.ok(snap.asks.length >= 4);
  assert.ok(parseFloat(snap.bids[0].price) < parseFloat(snap.asks[0].price), "book must not lock or cross");
  assert.ok(parseFloat(snap.bids[0].price) < 0.22, `best bid ${snap.bids[0].price}`);
  assert.ok(parseFloat(snap.asks[0].price) > 0.22, `best ask ${snap.asks[0].price}`);
});

test("a crossing buy lifts the ask and prints a trade", () => {
  resetBooksForTests();
  seedDeskQuotes(1, 0.22);
  const before = snapshotBook(1);
  const bestAsk = parseFloat(before.asks[0].price);
  const { fills, book } = placeOnBook(
    order({
      owner: "Taker11111111111111111111111111111111111",
      isLong: true,
      price: bestAsk * 2,
      size: 1,
      nonce: "1",
    }),
  );
  assert.ok(fills.length >= 1, "crossing buy should print");
  assert.ok(Math.abs(fills[0].price - bestAsk) < 1e-8);
  assert.equal(fills[0].size, 1);
  assert.ok(book.asks.length > 0);
});

test("ioc market order does not rest residual size", () => {
  resetBooksForTests();
  seedDeskQuotes(1, 0.22);
  const before = snapshotBook(1);
  const bestAsk = parseFloat(before.asks[0].price);
  const askSize = parseFloat(before.asks[0].size);
  placeOnBook(
    order({
      owner: "TakerIOC1111111111111111111111111111111",
      isLong: true,
      price: bestAsk * 2,
      size: askSize + 5,
      nonce: "ioc-1",
      ioc: true,
    }),
  );
  const after = snapshotBook(1);
  const residual = after.bids.find((l) => parseFloat(l.price) >= bestAsk * 1.5);
  assert.equal(residual, undefined, "ioc must not leave an aggressive bid");
});

test("pulse twitches desk size without crossing the book", () => {
  resetBooksForTests();
  seedDeskQuotes(1, 0.22);
  const before = snapshotBook(1);
  pulseBook(1, 0.2202);
  const after = snapshotBook(1);
  assert.ok(parseFloat(after.bids[0].price) < parseFloat(after.asks[0].price));
  const beforeSize = before.bids.reduce((n, l) => n + parseFloat(l.size), 0);
  const afterSize = after.bids.reduce((n, l) => n + parseFloat(l.size), 0);
  assert.ok(Math.abs(afterSize - beforeSize) > 1e-9 || after.asks[0].size !== before.asks[0].size);
});

test("cancel removes a resting bid", () => {
  resetBooksForTests();
  placeOnBook(
    order({
      owner: "Maker11111111111111111111111111111111111",
      isLong: true,
      price: 0.21,
      size: 10,
      nonce: "99",
    }),
  );
  assert.ok(snapshotBook(1).bids.some((l) => l.price.startsWith("0.21")));
  assert.equal(cancelOnBook("Maker11111111111111111111111111111111111", "99"), true);
  assert.equal(snapshotBook(1).bids.some((l) => l.price.startsWith("0.21")), false);
});
