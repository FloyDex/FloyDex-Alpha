import { FEE_COLLECTOR, PLATFORM_FEE_BPS } from "@/config";
import { FLOYDEX_TOKEN } from "@/config/token";

/** Stake is live: term yield at unlock + a lower desk fee while locked. */
export const STAKE_PUBLIC = true;

export const STAKE_MINT = FLOYDEX_TOKEN.mint;
export const STAKE_DECIMALS = 6;
export const STAKE_SUPPLY = 1_000_000_000;

/**
 * Wallet that receives locked $FLOYDEX. Unlock payouts (principal + reward)
 * must be signed by this wallet's key on the server.
 */
export const STAKE_TREASURY =
  (typeof process !== "undefined" && process.env.NEXT_PUBLIC_STAKE_TREASURY?.trim()) ||
  FEE_COLLECTOR;

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

/** Period yield labeled APY on the page (same schedule as OpenGap-style desks). */
export type StakeTerm = { days: number; apyPct: number };

export const STAKE_TERMS: StakeTerm[] = [
  { days: 7, apyPct: 3.5 },
  { days: 30, apyPct: 15 },
  { days: 90, apyPct: 45 },
  { days: 180, apyPct: 90 },
  { days: 360, apyPct: 180 },
];

export type StakePosition = {
  id: string;
  owner: string;
  days: number;
  principal: number;
  /** Period yield percent locked in at stake time. */
  apyPct: number;
  /** Token reward owed at unlock (principal × apyPct / 100). */
  reward: number;
  lockedAt: number;
  unlockAt: number;
  signature: string;
  returned?: boolean;
  returnSignature?: string;
};

export function termByDays(days: number): StakeTerm | null {
  return STAKE_TERMS.find((t) => t.days === days) ?? null;
}

/** Flat period reward — not annualized. 1000 @ 15% → 150. */
export function stakeReward(principal: number, apyPct: number): number {
  if (!(principal > 0) || !(apyPct > 0)) return 0;
  const scale = 10 ** STAKE_DECIMALS;
  return Math.round((principal * apyPct * scale) / 100) / scale;
}

export function stakePayout(principal: number, apyPct: number): number {
  return principal + stakeReward(principal, apyPct);
}

export function positionReward(row: Pick<StakePosition, "principal" | "days" | "apyPct" | "reward">): number {
  if (typeof row.reward === "number" && Number.isFinite(row.reward)) return row.reward;
  const apy = typeof row.apyPct === "number" ? row.apyPct : termByDays(row.days)?.apyPct ?? 0;
  return stakeReward(row.principal, apy);
}

export function positionPayout(row: Pick<StakePosition, "principal" | "days" | "apyPct" | "reward">): number {
  return row.principal + positionReward(row);
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
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatApy(apyPct: number): string {
  return Number.isInteger(apyPct) ? String(apyPct) : apyPct.toFixed(1);
}

export function bpsToPct(bps: number): string {
  return (bps / 100).toFixed(2);
}
