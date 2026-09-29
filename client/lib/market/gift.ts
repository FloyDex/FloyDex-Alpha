export const GIFT_USD = 5;
export const GIFT_UNLOCK_PROFIT = 500;

export type GiftStatus = {
  amount: number;
  realized: number;
  unlockAt: number;
  unlocked: boolean;
};

export type GiftClaims = {
  byOwner: Record<string, { ip: string; device: string; at: number }>;
  byIp: Record<string, string>;
  byDevice: Record<string, string>;
};

export function giftUnlocked(giftUsd: number, giftRealized: number): boolean {
  return !(giftUsd > 0) || giftRealized >= GIFT_UNLOCK_PROFIT;
}

export function giftWithdrawError(giftUsd: number, giftRealized: number): string | null {
  if (giftUnlocked(giftUsd, giftRealized)) return null;
  return `Make $${GIFT_UNLOCK_PROFIT.toFixed(0)} profit before withdrawing the $${GIFT_USD.toFixed(0)} credit ($${giftRealized.toFixed(2)} / $${GIFT_UNLOCK_PROFIT.toFixed(2)})`;
}

export function isDeviceId(value: string): boolean {
  return /^[0-9a-f-]{8,64}$/i.test(value);
}

export function toGiftStatus(giftUsd: number, giftRealized: number): GiftStatus | null {
  if (!(giftUsd > 0)) return null;
  return {
    amount: giftUsd,
    realized: giftRealized,
    unlockAt: GIFT_UNLOCK_PROFIT,
    unlocked: giftUnlocked(giftUsd, giftRealized),
  };
}

/** Raise a legacy $1 (or any smaller) credit to the current $5 signup bonus. */
export function topUpGiftCredit(
  giftUsd: number,
  deposited: number,
): { giftUsd: number; deposited: number; credited: number } {
  if (!(giftUsd > 0) || giftUsd >= GIFT_USD) {
    return { giftUsd, deposited, credited: 0 };
  }
  const credited = GIFT_USD - giftUsd;
  return { giftUsd: GIFT_USD, deposited: deposited + credited, credited };
}

export function giftClaimDenied(
  claims: GiftClaims,
  owner: string,
  ipHash: string,
  deviceHash: string,
): { code: "claimed_owner" | "claimed_ip" | "claimed_device"; error: string } | null {
  if (claims.byOwner[owner]) {
    return { code: "claimed_owner", error: "This wallet already claimed the credit" };
  }
  if (claims.byIp[ipHash]) {
    return { code: "claimed_ip", error: "This IP already claimed the $5 credit" };
  }
  if (claims.byDevice[deviceHash]) {
    return { code: "claimed_device", error: "This device already claimed the $5 credit" };
  }
  return null;
}

export function recordGiftClaim(
  claims: GiftClaims,
  owner: string,
  ipHash: string,
  deviceHash: string,
  at: number,
) {
  claims.byOwner[owner] = { ip: ipHash, device: deviceHash, at };
  claims.byIp[ipHash] = owner;
  claims.byDevice[deviceHash] = owner;
}
