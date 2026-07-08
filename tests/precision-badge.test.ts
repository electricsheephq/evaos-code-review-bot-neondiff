import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildPrecisionBadgeEndpoint, writePrecisionBadgeEndpoint } from "../src/precision-badge.js";
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
    observedAt: "2026-07-08T00:00:00.000Z",
    ...overrides
  };
}

const PASSING_AGGREGATE = {
  labeledFindings: 120,
  p0p1Labels: 35,
  negativeControlScenarios: 12,
  bins: [
    {
      minConfidence: 0.8,
      maxConfidence: 1,
      findings: 120,
      matched: 119,
      empiricalPrecision: 119 / 120,
      rawWilsonLowerBound: 0.9543025846256779
    }
  ],
  bestWilsonLowerBound: 0.9543025846256779,
  categoryPrecision: [],
  thresholds: {
    minLabeledFindings: 100,
    minP0P1Labels: 30,
    minNegativeControlScenarios: 10,
    minWilsonLowerBound: 0.95
  },
  eligible: true,
  reason: "eligible"
};

const PASSING_MULTI_BIN_AGGREGATE = {
  ...PASSING_AGGREGATE,
  labeledFindings: 160,
  bins: [
    ...PASSING_AGGREGATE.bins,
    {
      minConfidence: 0.5,
      maxConfidence: 0.8,
      findings: 40,
      matched: 20,
      empiricalPrecision: 0.5,
      rawWilsonLowerBound: 0.35198494879084225
    }
  ],
  categoryPrecision: []
};

const CALIBRATED_POLICY = {
  mode: "calibrated" as const,
  evidenceUrl: "https://github.com/electricsheephq/evaos-code-review-bot-neondiff/actions/runs/123",
  datasetId: "neondiff-calibration-v1",
  minLabeledFindings: 100,
  labeledFindings: 120,
  minP0P1Labels: 30,
  p0p1Labels: 35,
  minNegativeControlScenarios: 10,
  negativeControlScenarios: 12,
  minWilsonLowerBound: 0.95,
  wilsonLowerBound: 0.9543025846256779
};

describe("precision badge endpoint (#425)", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("renders gray calibrating with n when the human publicDisplay flip is still off", () => {
    const badge = buildPrecisionBadgeEndpoint({
      aggregate: PASSING_AGGREGATE,
      publicDisplay: { ...CALIBRATED_POLICY, mode: "uncalibrated" }
    });

    expect(badge).toMatchObject({
      schemaVersion: 1,
      label: "NeonDiff precision",
      message: "calibrating (n=120)",
      color: "lightgrey"
    });
    expect(badge.message).not.toMatch(/\d+%/);
  });

  it("renders gray calibrating with n when aggregate evidence is below any public gate", () => {
    const badge = buildPrecisionBadgeEndpoint({
      aggregate: { ...PASSING_AGGREGATE, labeledFindings: 99, reason: "insufficient_labeled_findings" },
      publicDisplay: CALIBRATED_POLICY
    });

    expect(badge.message).toBe("calibrating (n=99)");
    expect(badge.color).toBe("lightgrey");
    expect(badge.message).not.toMatch(/\d+%/);
  });

  it("renders a floored percentage with n only after the existing public-confidence gate allows display", () => {
    const badge = buildPrecisionBadgeEndpoint({
      aggregate: PASSING_AGGREGATE,
      publicDisplay: CALIBRATED_POLICY
    });

    expect(badge).toMatchObject({
      schemaVersion: 1,
      label: "NeonDiff precision",
      message: "95% (n=120)",
      color: "green"
    });
  });

  it("renders the same Wilson metric used by the public gate even when bins diverge", () => {
    const badge = buildPrecisionBadgeEndpoint({
      aggregate: PASSING_MULTI_BIN_AGGREGATE,
      publicDisplay: CALIBRATED_POLICY
    });

    expect(badge).toMatchObject({
      schemaVersion: 1,
      label: "NeonDiff precision",
      message: "95% (n=160)",
      color: "green"
    });
  });

  it("writes a Shields endpoint JSON file without leaking non-schema metadata", () => {
    const dir = mkdtempSync(join(tmpdir(), "neondiff-badge-write-"));
    roots.push(dir);
    const output = join(dir, "precision.json");

    const result = writePrecisionBadgeEndpoint({
      aggregate: PASSING_AGGREGATE,
      publicDisplay: { ...CALIBRATED_POLICY, mode: "uncalibrated" },
      outputPath: output
    });

    expect(result.ok).toBe(true);
    expect(existsSync(output)).toBe(true);
    const parsed = JSON.parse(readFileSync(output, "utf8"));
    expect(parsed).toEqual({
      schemaVersion: 1,
      label: "NeonDiff precision",
      message: "calibrating (n=120)",
      color: "lightgrey"
    });
  });

  it("writes the calibrated Shields endpoint JSON file without leaking result metadata", () => {
    const dir = mkdtempSync(join(tmpdir(), "neondiff-badge-write-calibrated-"));
    roots.push(dir);
    const output = join(dir, "precision.json");

    const result = writePrecisionBadgeEndpoint({
      aggregate: PASSING_AGGREGATE,
      publicDisplay: CALIBRATED_POLICY,
      outputPath: output
    });

    expect(result.ok).toBe(true);
    expect(result.wilsonLowerBound).toBe(0.9543025846256779);
    expect(result.displayWilsonLowerBound).toBe(result.wilsonLowerBound);
    expect(existsSync(output)).toBe(true);
    const parsed = JSON.parse(readFileSync(output, "utf8"));
    expect(parsed).toEqual({
      schemaVersion: 1,
      label: "NeonDiff precision",
      message: "95% (n=120)",
      color: "green"
    });
    expect(parsed).not.toHaveProperty("wilsonLowerBound");
    expect(parsed).not.toHaveProperty("missingThresholds");
  });

  it("exposes a CLI that reads the real outcome-label store and writes the badge endpoint", () => {
    const dir = mkdtempSync(join(tmpdir(), "neondiff-badge-cli-"));
    roots.push(dir);
    const configPath = join(dir, "config.json");
    const outputPath = join(dir, "public", "precision.json");
    writeFileSync(configPath, `${JSON.stringify({
      pilotRepos: ["owner/repo"],
      workRoot: join(dir, "runtime"),
      statePath: join(dir, "state.sqlite"),
      evidenceDir: join(dir, "evidence")
    })}\n`);
    const store = new ReviewStateStore(join(dir, "state.sqlite"));
    store.recordFindingOutcomeLabel(label({ confidence: 0.9, verdict: "true_positive" }));
    store.close();

    const output = execFileSync(process.execPath, [
      tsxCli, "src/cli.ts", "badge", "--config", configPath, "--repo", "owner/repo", "--output", outputPath
    ], { cwd: process.cwd(), encoding: "utf8" });

    const parsed = JSON.parse(output);
    expect(parsed).toMatchObject({
      command: "badge",
      ok: true,
      outputPath,
      repo: "owner/repo",
      message: "calibrating (n=1)",
      publicMode: "uncalibrated"
    });
    expect(parsed).not.toHaveProperty("badge");
    expect(JSON.parse(readFileSync(outputPath, "utf8"))).toMatchObject({
      schemaVersion: 1,
      label: "NeonDiff precision",
      message: "calibrating (n=1)",
      color: "lightgrey"
    });
  });

  it("exposes a CLI calibrated path that writes the green percentage badge from config publicDisplay", () => {
    const dir = mkdtempSync(join(tmpdir(), "neondiff-badge-cli-calibrated-"));
    roots.push(dir);
    const configPath = join(dir, "config.json");
    const outputPath = join(dir, "public", "precision.json");
    writeFileSync(configPath, `${JSON.stringify({
      pilotRepos: ["owner/repo"],
      workRoot: join(dir, "runtime"),
      statePath: join(dir, "state.sqlite"),
      evidenceDir: join(dir, "evidence"),
      confidenceCalibration: {
        publicDisplay: CALIBRATED_POLICY
      }
    })}\n`);
    const store = new ReviewStateStore(join(dir, "state.sqlite"));
    for (let i = 0; i < 119; i += 1) {
      store.recordFindingOutcomeLabel(label({ confidence: 0.9, verdict: "true_positive" }));
    }
    store.recordFindingOutcomeLabel(label({ confidence: 0.9, verdict: "false_positive" }));
    for (let i = 0; i < 12; i += 1) {
      store.recordFindingOutcomeLabel(label({
        confidence: 0,
        verdict: "unvalidated",
        labelSource: "explicit_control"
      }));
    }
    store.close();

    const output = execFileSync(process.execPath, [
      tsxCli, "src/cli.ts", "badge", "--config", configPath, "--repo", "owner/repo", "--output", outputPath
    ], { cwd: process.cwd(), encoding: "utf8" });

    const parsed = JSON.parse(output);
    expect(parsed).toMatchObject({
      command: "badge",
      ok: true,
      outputPath,
      repo: "owner/repo",
      label: "NeonDiff precision",
      schemaVersion: 1,
      message: "95% (n=120)",
      color: "green",
      publicMode: "calibrated",
      allowed: true,
      labeledFindings: 120
    });
    expect(parsed).not.toHaveProperty("badge");
    expect(JSON.parse(readFileSync(outputPath, "utf8"))).toEqual({
      schemaVersion: 1,
      label: "NeonDiff precision",
      message: "95% (n=120)",
      color: "green"
    });
  }, 15_000);
});
