/**
 * Whether an expired-but-unconfirmed `settle_fill` job is worth retrying
 * (a fresh blockhash, same fill args) versus rolling back — the "retry if
 * the job is still valid, else roll back" half of the reconciler (roadmap
 * Phase 3 item e).
 *
 * Pure and DB-shape-agnostic on purpose: `reconcile.ts` feeds it whatever
 * the current `Order` row says, so this stays testable without Postgres.
 */
export interface OrderState {
  cancelled: boolean;
  expiryTs: bigint; // unix seconds
  size: bigint; // wire scale, 1e9
  filledSize: bigint;
}

export interface RetryDecisionInput {
  maker: OrderState | null; // null if the order row is gone entirely (should never happen — Order rows are never deleted)
  taker: OrderState | null;
  attempts: number;
  maxAttempts: number;
  nowUnix: bigint;
}

export type RetryDecision = { retry: true } | { retry: false; reason: string };

/**
 * A job is worth retrying only if both its orders are still capable of
 * settling this exact fill: neither cancelled, neither past its expiry, and
 * (from `filledSize` alone — `queuedSize` already reserves this fill's own
 * size, so it isn't part of this check) settling it still fits within
 * `size`. Anything else — including simply having retried too many times —
 * rolls back instead, so a job can never spin forever holding its
 * `queuedSize` reservation open.
 */
export function decideRetry(input: RetryDecisionInput, fillSize: bigint): RetryDecision {
  if (input.attempts >= input.maxAttempts) return { retry: false, reason: `exceeded max attempts (${input.attempts} >= ${input.maxAttempts})` };
  if (!input.maker) return { retry: false, reason: "maker order no longer exists" };
  if (!input.taker) return { retry: false, reason: "taker order no longer exists" };
  for (const [label, o] of [["maker", input.maker], ["taker", input.taker]] as const) {
    if (o.cancelled) return { retry: false, reason: `${label} order was cancelled` };
    if (input.nowUnix > o.expiryTs) return { retry: false, reason: `${label} order expired (expiryTs ${o.expiryTs} < now ${input.nowUnix})` };
    if (o.filledSize + fillSize > o.size) return { retry: false, reason: `${label} order would overfill (filled ${o.filledSize} + fill ${fillSize} > size ${o.size})` };
  }
  return { retry: true };
}
