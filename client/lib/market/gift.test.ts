import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GIFT_USD,
  GIFT_UNLOCK_PROFIT,
  giftClaimDenied,
  giftUnlocked,
  giftWithdrawError,
  recordGiftClaim,
  toGiftStatus,
  topUpGiftCredit,
  withdrawableNow,
  type GiftClaims,
} from "./gift";

test("gift stays locked until $500 profit from the $5 credit", () => {
  assert.equal(GIFT_USD, 5);
  assert.equal(GIFT_UNLOCK_PROFIT, 500);
  assert.equal(giftUnlocked(0, 0), true);
  assert.equal(giftUnlocked(5, 0), false);
  assert.equal(giftUnlocked(5, 499.99), false);
  assert.equal(giftUnlocked(5, 500), true);
  assert.equal(giftUnlocked(5, 512), true);
});

test("withdraw error names the remaining profit", () => {
  const msg = giftWithdrawError(5, 12.5);
  assert.ok(msg && msg.includes("$12.50") && msg.includes("$500.00") && msg.includes("$5"));
  assert.equal(giftWithdrawError(5, 500), null);
  assert.equal(giftWithdrawError(0, 0), null);
  // Funded principal can leave while the gift is locked.
  assert.equal(giftWithdrawError(5, 0, 1.09, 1.0951), null);
  assert.ok(giftWithdrawError(5, 0, 2, 1.0951));
});

test("withdrawableNow caps to principal while gift is locked", () => {
  assert.equal(withdrawableNow(5, 0, 6.01, 1.0951), 1.0951);
  assert.equal(withdrawableNow(5, 500, 6.01, 1.0951), 6.01);
  assert.equal(withdrawableNow(0, 0, 3, 1), 3);
  assert.equal(withdrawableNow(5, 0, 0.5, 1.0951), 0.5);
});

test("status is omitted when no gift was claimed", () => {
  assert.equal(toGiftStatus(0, 0), null);
  const s = toGiftStatus(5, 40);
  assert.equal(s?.unlocked, false);
  assert.equal(s?.unlockAt, 500);
  assert.equal(s?.amount, 5);
});

test("legacy $1 credits top up to $5 without a second claim", () => {
  const next = topUpGiftCredit(1, 1);
  assert.equal(next.giftUsd, 5);
  assert.equal(next.deposited, 5);
  assert.equal(next.credited, 4);
  assert.equal(topUpGiftCredit(5, 5).credited, 0);
  assert.equal(topUpGiftCredit(0, 0).credited, 0);
});

test("one claim per wallet, IP, and device", () => {
  const claims: GiftClaims = { byOwner: {}, byIp: {}, byDevice: {} };
  assert.equal(giftClaimDenied(claims, "a", "ip1", "dev1"), null);
  recordGiftClaim(claims, "a", "ip1", "dev1", 1);
  assert.equal(giftClaimDenied(claims, "a", "ip2", "dev2")?.code, "claimed_owner");
  assert.equal(giftClaimDenied(claims, "b", "ip1", "dev2")?.code, "claimed_ip");
  assert.equal(giftClaimDenied(claims, "b", "ip2", "dev1")?.code, "claimed_device");
  assert.equal(giftClaimDenied(claims, "b", "ip2", "dev2"), null);
});
