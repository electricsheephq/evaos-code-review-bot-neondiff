import { describe, expect, it } from "vitest";
import { percentile, summarizePercentiles } from "../scripts/qa-lab/stats.js";

describe("percentile", () => {
  it("returns the single sample when there is only one", () => {
    expect(percentile([42], 0.5)).toBe(42);
    expect(percentile([42], 0.9)).toBe(42);
  });

  it("uses nearest-rank so p50/p90 are always an observed sample", () => {
    const samples = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    // Nearest-rank p50 over 10 sorted samples: ceil(0.5 * 10) = 5th smallest -> 50.
    expect(percentile(samples, 0.5)).toBe(50);
    // Nearest-rank p90 over 10 sorted samples: ceil(0.9 * 10) = 9th smallest -> 90.
    expect(percentile(samples, 0.9)).toBe(90);
  });

  it("is insensitive to input order", () => {
    const ascending = [1, 2, 3, 4, 5];
    const shuffled = [3, 1, 5, 2, 4];
    expect(percentile(shuffled, 0.5)).toBe(percentile(ascending, 0.5));
    expect(percentile(shuffled, 0.9)).toBe(percentile(ascending, 0.9));
  });

  it("rejects an empty sample set", () => {
    expect(() => percentile([], 0.5)).toThrow(/at least one sample/);
  });

  it("rejects an out-of-range percentile", () => {
    expect(() => percentile([1, 2, 3], 1.5)).toThrow(/within \[0, 1\]/);
    expect(() => percentile([1, 2, 3], -0.1)).toThrow(/within \[0, 1\]/);
  });
});

describe("summarizePercentiles", () => {
  it("computes count, min, max, mean, p50, and p90 over a sample set", () => {
    const summary = summarizePercentiles([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
    expect(summary.count).toBe(10);
    expect(summary.minMs).toBe(10);
    expect(summary.maxMs).toBe(100);
    expect(summary.meanMs).toBe(55);
    expect(summary.p50Ms).toBe(50);
    expect(summary.p90Ms).toBe(90);
  });

  it("rejects an empty sample set", () => {
    expect(() => summarizePercentiles([])).toThrow(/at least one sample/);
  });
});
