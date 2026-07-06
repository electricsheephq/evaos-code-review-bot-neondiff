import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { aggregateCalibrationLabels, writeCalibrationAggregatePacket } from "../src/calibration-aggregate.js";
import { computeConfidenceBinStats, PUBLIC_CONFIDENCE_POLICY } from "../src/eval-harness.js";
import { ReviewStateStore, type FindingOutcomeLabelRecord } from "../src/state.js";

const tsxCli = createRequire(import.meta.url).resolve("tsx/cli");

let seq = 0;
function label(overrides: Partial<FindingOutcomeLabelRecord> & Pick<FindingOutcomeLabelRecord, "confidence" | "verdict">): FindingOutcomeLabelRecord {
  seq += 1;
  return {
    fingerprint: `finding:${String(seq).padStart(64, "0")}`,
    repo: "owner/repo",
    pullNumber: seq,
    headSha: `sha${seq}`,
    severity: "P1",
    category: "data_loss",
    labelSource: "merged_fix",
    observedAt: "2026-07-06T00:00:00.000Z",
    ...overrides
  };
}

describe("calibration aggregation (#286 PR B)", () => {
  it("computes per-bin stats identically to computeConfidenceBinStats on the same label set", () => {
    const labels: FindingOutcomeLabelRecord[] = [
      label({ confidence: 0.9, verdict: "true_positive" }),
      label({ confidence: 0.85, verdict: "false_positive" }),
      label({ confidence: 0.6, verdict: "true_positive" }),
      label({ confidence: 0.2, verdict: "false_positive" }),
      label({ confidence: 0.95, verdict: "unvalidated" }) // earns nothing
    ];

    const aggregate = aggregateCalibrationLabels(labels);

    // Build the SAME inputs the aggregator feeds the shared math and assert byte-equal bins.
    const validated = labels.filter((l) => l.verdict !== "unvalidated");
    const findings = validated.map((l) => ({ id: l.fingerprint, confidence: l.confidence }));
    const matches = validated.filter((l) => l.verdict === "true_positive").map((l) => ({ botFindingId: l.fingerprint }));
    expect(aggregate.bins).toEqual(computeConfidenceBinStats(findings, matches));
  });

  it("counts labeledFindings and p0p1Labels from validated labels only (unvalidated earns nothing)", () => {
    const aggregate = aggregateCalibrationLabels([
      label({ confidence: 0.9, verdict: "true_positive", severity: "P0" }),
      label({ confidence: 0.8, verdict: "false_positive", severity: "P1" }),
      label({ confidence: 0.7, verdict: "true_positive", severity: "P2" }),
      label({ confidence: 0.6, verdict: "unvalidated", severity: "P0" })
    ]);

    expect(aggregate.labeledFindings).toBe(3); // the unvalidated one excluded
    expect(aggregate.p0p1Labels).toBe(2); // P0 tp + P1 fp; P2 not counted; unvalidated P0 excluded
  });

  it("reports negativeControlScenarios as 0 (no explicit-control source in the label store yet)", () => {
    const aggregate = aggregateCalibrationLabels([
      label({ confidence: 0.9, verdict: "true_positive" }),
      label({ confidence: 0.5, verdict: "false_positive", labelSource: "none_observed" })
    ]);
    expect(aggregate.negativeControlScenarios).toBe(0);
  });

  it("computes per-category rolling precision from validated labels", () => {
    const aggregate = aggregateCalibrationLabels([
      label({ confidence: 0.9, verdict: "true_positive", category: "data_loss" }),
      label({ confidence: 0.8, verdict: "true_positive", category: "data_loss" }),
      label({ confidence: 0.7, verdict: "false_positive", category: "data_loss" }),
      label({ confidence: 0.6, verdict: "true_positive", category: "auth" }),
      label({ confidence: 0.5, verdict: "unvalidated", category: "auth" }) // excluded
    ]);

    const byCategory = Object.fromEntries(aggregate.categoryPrecision.map((c) => [c.category, c]));
    expect(byCategory.data_loss).toMatchObject({ labeled: 3, matched: 2 });
    expect(byCategory.data_loss?.precision).toBeCloseTo(2 / 3, 10);
    expect(byCategory.auth).toMatchObject({ labeled: 1, matched: 1, precision: 1 });
  });

  it("evaluates the public-confidence floors but reports NOT eligible without mutating anything", () => {
    const aggregate = aggregateCalibrationLabels([label({ confidence: 0.9, verdict: "true_positive" })]);

    expect(aggregate.thresholds).toMatchObject({
      minLabeledFindings: PUBLIC_CONFIDENCE_POLICY.minLabeledFindings,
      minP0P1Labels: PUBLIC_CONFIDENCE_POLICY.minP0P1Labels,
      minNegativeControlScenarios: PUBLIC_CONFIDENCE_POLICY.minNegativeControlScenarios,
      minWilsonLowerBound: PUBLIC_CONFIDENCE_POLICY.minWilsonLowerBound
    });
    expect(aggregate.eligible).toBe(false);
    expect(aggregate.reason).toMatch(/insufficient/i);
  });

  it("produces a clean zero-evidence aggregate from an empty label set", () => {
    const aggregate = aggregateCalibrationLabels([]);
    expect(aggregate.labeledFindings).toBe(0);
    expect(aggregate.p0p1Labels).toBe(0);
    expect(aggregate.categoryPrecision).toEqual([]);
    expect(aggregate.eligible).toBe(false);
    expect(aggregate.bins).toHaveLength(3);
    expect(aggregate.bins.every((bin) => bin.findings === 0)).toBe(true);
  });
});

describe("calibration aggregate packet + CLI (#286 PR B)", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("writes a redacted evidence packet + machine-readable aggregate json", () => {
    const dir = mkdtempSync(join(tmpdir(), "evaos-calib-packet-"));
    roots.push(dir);
    const token = ["ghp", "1234567890abcdefghijklmnopqrstuvwx"].join("_");
    // A category name carrying secret-like text must be redacted in the written packet.
    const result = writeCalibrationAggregatePacket({
      labels: [label({ confidence: 0.9, verdict: "true_positive", category: `data_loss ${token}` })],
      outputDir: join(dir, "packet")
    });

    expect(result.ok).toBe(true);
    expect(existsSync(join(dir, "packet", "aggregate-calibration.json"))).toBe(true);
    expect(existsSync(join(dir, "packet", "calibration-aggregate-packet.json"))).toBe(true);
    const packet = readFileSync(join(dir, "packet", "calibration-aggregate-packet.json"), "utf8");
    expect(packet).not.toContain(token);
    expect(packet).toContain("proofBoundary");
  });

  it("exposes a read-only CLI that reads the store and never mutates config", () => {
    const dir = mkdtempSync(join(tmpdir(), "evaos-calib-cli-"));
    roots.push(dir);
    const configPath = join(dir, "config.json");
    writeFileSync(configPath, `${JSON.stringify({
      pilotRepos: ["owner/repo"],
      workRoot: join(dir, "runtime"),
      statePath: join(dir, "state.sqlite"),
      evidenceDir: join(dir, "evidence")
    })}\n`);
    const store = new ReviewStateStore(join(dir, "state.sqlite"));
    store.recordFindingOutcomeLabel(label({ confidence: 0.9, verdict: "true_positive" }));
    store.close();
    const outputDir = join(dir, "packet");

    const output = execFileSync(process.execPath, [
      tsxCli, "src/cli.ts", "calibration-aggregate", "--config", configPath, "--output-dir", outputDir
    ], { cwd: process.cwd(), encoding: "utf8" });

    const parsed = JSON.parse(output);
    expect(parsed).toMatchObject({ command: "calibration-aggregate", ok: true, labeledFindings: 1, eligible: false });
    expect(existsSync(join(outputDir, "aggregate-calibration.json"))).toBe(true);
    // Config file is untouched by an aggregation run.
    expect(readFileSync(configPath, "utf8")).not.toContain("calibrated");
  });
});
