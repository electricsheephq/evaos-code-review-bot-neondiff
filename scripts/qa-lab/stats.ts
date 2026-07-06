/**
 * Percentile stats for the QA lab timing harness (#341). Small, dependency-free, and pure so it is
 * trivially unit-testable in isolation from the timing runner.
 */

export interface PercentileSummary {
  count: number;
  minMs: number;
  maxMs: number;
  meanMs: number;
  p50Ms: number;
  p90Ms: number;
}

/**
 * Nearest-rank percentile over a copied, ascending-sorted view of `samples`. Nearest-rank (not
 * linear interpolation) is used deliberately: it always returns an observed sample value, which
 * keeps p50/p90 traceable to a real run in the evidence packet instead of an interpolated number
 * that no single run actually produced.
 */
export function percentile(samples: number[], p: number): number {
  if (samples.length === 0) throw new Error("percentile requires at least one sample");
  if (p < 0 || p > 1) throw new Error(`percentile p must be within [0, 1], got ${p}`);
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.ceil(p * sorted.length);
  const index = Math.min(Math.max(rank, 1), sorted.length) - 1;
  return sorted[index]!;
}

export function summarizePercentiles(samplesMs: number[]): PercentileSummary {
  if (samplesMs.length === 0) throw new Error("summarizePercentiles requires at least one sample");
  const sum = samplesMs.reduce((total, value) => total + value, 0);
  return {
    count: samplesMs.length,
    minMs: Math.min(...samplesMs),
    maxMs: Math.max(...samplesMs),
    meanMs: sum / samplesMs.length,
    p50Ms: percentile(samplesMs, 0.5),
    p90Ms: percentile(samplesMs, 0.9)
  };
}
