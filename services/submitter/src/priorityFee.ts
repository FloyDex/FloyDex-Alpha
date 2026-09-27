/**
 * Dynamic priority fee, capped by env. Takes the cluster's recent
 * per-account prioritization fees (`connection.getRecentPrioritizationFees`)
 * and returns a microLamports-per-CU price: the median of the non-zero
 * recent fees, so one outlier slot doesn't spike every transaction, floored
 * at a minimum so a quiet cluster still lands promptly, and capped so a fee
 * spike can never silently burn an unbounded amount of the operator's SOL.
 */
export interface PriorityFeeSample {
  slot: number;
  prioritizationFee: number;
}

export interface PriorityFeeConfig {
  /** Floor, in microLamports per CU, applied even with no recent fee data. */
  minMicroLamports: number;
  /** Hard cap, in microLamports per CU — env-configured, never exceeded regardless of what the cluster reports. */
  maxMicroLamports: number;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** Pure: given recent fee samples and the config, returns the microLamports/CU price to set, always within `[minMicroLamports, maxMicroLamports]`. */
export function computePriorityFeeMicroLamports(samples: PriorityFeeSample[], config: PriorityFeeConfig): number {
  const nonZero = samples.map((s) => s.prioritizationFee).filter((f) => f > 0);
  const raw = Math.ceil(median(nonZero));
  return Math.min(config.maxMicroLamports, Math.max(config.minMicroLamports, raw));
}
