import { describe, expect, it } from "vitest";
import { buildBaselineTable, parseArgs, resolveConfigVariant, WARMUP_ITERATIONS, type TimingEvidence } from "../scripts/qa-lab/run-timing.js";

describe("parseArgs", () => {
  it("parses --samples and other flags into a args map", () => {
    const args = parseArgs(["--config", "a.json", "--samples", "10", "--output-dir", "/tmp/out"]);
    expect(args).toEqual({ config: "a.json", samples: "10", "output-dir": "/tmp/out" });
  });

  it("throws when a flag has no following value", () => {
    expect(() => parseArgs(["--samples"])).toThrow(/--samples requires a value/);
  });

  it("throws when a flag's value looks like another flag", () => {
    expect(() => parseArgs(["--config", "--samples", "10"])).toThrow(/--config requires a value/);
  });
});

describe("resolveConfigVariant", () => {
  it("resolves the baseline variant (hermetic-executable)", () => {
    const variant = resolveConfigVariant("baseline");
    expect(variant.id).toBe("baseline");
  });

  it("rejects an unknown variant id, listing known variants", () => {
    expect(() => resolveConfigVariant("not-a-real-variant" as never)).toThrow(/unknown --config-variant/);
  });

  it("rejects a known but non-hermetic variant with a clear out-of-scope error", () => {
    expect(() => resolveConfigVariant("github_related_context")).toThrow(/requires live provider\/GitHub calls/);
    expect(() => resolveConfigVariant("self_consistency")).toThrow(/out of.*scope for the hermetic pass-1 timing runner/s);
  });
});

describe("WARMUP_ITERATIONS", () => {
  it("is a small positive integer", () => {
    expect(Number.isInteger(WARMUP_ITERATIONS)).toBe(true);
    expect(WARMUP_ITERATIONS).toBeGreaterThan(0);
  });
});

describe("buildBaselineTable", () => {
  it("renders a markdown table with one row per scenario and the warm-up count", () => {
    const evidence: TimingEvidence = {
      evidenceVersion: "0.1",
      generatedAt: "2026-07-06T00:00:00.000Z",
      commitSha: "deadbeef",
      nodeVersion: "v20.0.0",
      configVariant: "baseline",
      configPath: "tests/fixtures/qa-lab/config.baseline.json",
      samplesPerScenario: 25,
      warmupIterations: WARMUP_ITERATIONS,
      proofBoundary: "hermetic deterministic-pipeline timing only",
      scenarios: [
        {
          scenarioId: "docs-only-readme-typo",
          scenarioClass: "docs_only",
          description: "desc",
          configVariant: "baseline",
          samples: 25,
          warmupIterations: WARMUP_ITERATIONS,
          stats: { count: 25, minMs: 0.1, maxMs: 0.5, meanMs: 0.3, p50Ms: 0.3, p90Ms: 0.45 },
          lastRunOutcome: { event: "COMMENT", acceptedComments: 1, droppedFindings: 0 }
        }
      ]
    };
    const table = buildBaselineTable(evidence);
    expect(table).toContain("# QA Lab Timing Baseline");
    expect(table).toContain("Commit: deadbeef");
    expect(table).toContain("| docs-only-readme-typo | docs_only | 25 | 0.300 | 0.450 |");
  });
});
