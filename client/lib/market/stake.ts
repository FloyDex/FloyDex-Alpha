/** No public ticker yet — filled in when the operator announces launch. */
export const STAKE_TOKEN = "";
export const STAKE_FEE_BPS = 25;
/** Local `next dev` only. Production stays off until protocol-token locking is ready. */
export const STAKE_PUBLIC = process.env.NODE_ENV !== "production";

export type StakeTerm = {
  days: number;
  /** Term yield, not calendar APY. 0.15 → +15% of principal at unlock. */
  apy: number;
};

export const STAKE_TERMS: StakeTerm[] = [
  { days: 7, apy: 0.035 },
  { days: 30, apy: 0.15 },
  { days: 90, apy: 0.45 },
  { days: 180, apy: 0.9 },
  { days: 360, apy: 1.8 },
];

export type StakeQuote = {
  days: number;
  apy: number;
  principal: number;
  reward: number;
  receive: number;
  unlockAt: number;
};

export type StakePosition = {
  id: string;
  owner: string;
  days: number;
  apy: number;
  principal: number;
  reward: number;
  receive: number;
  lockedAt: number;
  unlockAt: number;
};

export function termByDays(days: number): StakeTerm | null {
  return STAKE_TERMS.find((t) => t.days === days) ?? null;
}

export function quoteStake(amount: number, term: StakeTerm, now = Date.now()): StakeQuote | null {
  if (!(amount > 0) || !Number.isFinite(amount)) return null;
  const reward = amount * term.apy;
  return {
    days: term.days,
    apy: term.apy,
    principal: amount,
    reward,
    receive: amount + reward,
    unlockAt: now + term.days * 86_400_000,
  };
}

export function formatApy(apy: number): string {
  const pct = apy * 100;
  const digits = Number.isInteger(pct) ? 0 : 1;
  return `${pct.toFixed(digits)}%`;
}

export function formatStakeQty(n: number, digits = 2): string {
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/** @deprecated Use formatStakeQty — kept as alias during rename. */
export const formatKry = formatStakeQty;

export function compactStakeQty(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(2)}K`;
  return formatStakeQty(n, abs >= 1 ? 0 : 2);
}

/** @deprecated Use compactStakeQty */
export const compactKry = compactStakeQty;

export function formatUnlock(ts: number): string {
  return new Date(ts).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function isOpenStake(row: StakePosition, now = Date.now()): boolean {
  return row.unlockAt > now;
}
