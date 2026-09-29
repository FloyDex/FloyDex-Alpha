import { PLATFORM_FEE_BPS } from "@/config";
import { FLOYDEX_TOKEN } from "@/config/token";

/** Stake is live. The benefit is a lower desk fee, not a minted yield. */
export const STAKE_PUBLIC = true;

export const STAKE_MINT = FLOYDEX_TOKEN.mint;
export const STAKE_DECIMALS = 6;
export const STAKE_SUPPLY = 1_000_000_000;

/** Wallet balance (not locked) that cuts the 1% desk fee. */
export const HOLD_FEE_TIERS = [
  { minTokens: 10_000_000, bps: 40 },
  { minTokens: 1_000_000, bps: 60 },
  { minTokens: 100_000, bps: 80 },
  { minTokens: 0, bps: PLATFORM_FEE_BPS },
] as const;

/** Open stake that cuts the fee further. Below 100,000 the lock still holds tokens but the fee stays at the hold tier. */
export const STAKE_FEE_TIERS = [
  { minTokens: 1_000_000, bps: 25 },
  { minTokens: 100_000, bps: 50 },
  { minTokens: 0, bps: PLATFORM_FEE_BPS },
] as const;

/** Lowest desk fee a holder or staker can reach. */
export const STAKE_FEE_BPS = 25;

export type FeeTier = { minTokens: number; bps: number };

export type StakeTerm = { days: number };

export const STAKE_TERMS: StakeTerm[] = [
  { days: 7 },
  { days: 30 },
  { days: 90 },
  { days: 180 },
  { days: 360 },
];

export type StakePosition = {
  id: string;
  owner: string;
  days: number;
  principal: number;
  lockedAt: number;
  unlockAt: number;
  signature: string;
  returned?: boolean;
  returnSignature?: string;
};

export function termByDays(days: number): StakeTerm | null {
  return STAKE_TERMS.find((t) => t.days === days) ?? null;
}

export function isOpenStake(row: StakePosition, now = Date.now()): boolean {
  return !row.returned && row.unlockAt > now;
}

export function tierBps(tiers: readonly FeeTier[], amount: number): number {
  const qty = Number.isFinite(amount) && amount > 0 ? amount : 0;
  const sorted = [...tiers].sort((a, b) => b.minTokens - a.minTokens);
  for (const tier of sorted) {
    if (qty + 1e-9 >= tier.minTokens) return tier.bps;
  }
  return PLATFORM_FEE_BPS;
}

/** Lower of the hold-tier fee and the stake-tier fee. Same tokens are not discounted twice. */
export function feeBpsForBalances(walletTokens: number, stakedTokens: number): number {
  return Math.min(
    tierBps(HOLD_FEE_TIERS, walletTokens),
    tierBps(STAKE_FEE_TIERS, stakedTokens),
    PLATFORM_FEE_BPS,
  );
}

export function formatStakeQty(n: number, digits = 2): string {
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function compactStakeQty(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(2)}K`;
  return formatStakeQty(n, abs >= 1 ? 0 : 2);
}

export function formatUnlock(at: number): string {
  return new Date(at).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function bpsToPct(bps: number): string {
  return (bps / 100).toFixed(2);
}
