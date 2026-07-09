import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  readReviewLensEvalScenario,
  runReviewLensEval
} from "../src/review-lens-eval.js";

const FIXTURE_DIR = "tests/fixtures/review-lenses-eval";
const NOW = new Date("2026-07-09T00:00:00.000Z");
const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const tsxCliPath = require.resolve("tsx/cli");

describe("review-lenses-eval", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("writes deterministic issue-enrichment baseline and lens evidence without posting", () => {
    const outputRoot = tempRoot(roots);
    const scenario = readReviewLensEvalScenario(join(FIXTURE_DIR, "issue-architecture-runtime.json"));

    const result = runReviewLensEval({
      scenarios: [scenario],
      outputRoot,
      mode: "deterministic",
      dryRun: true,
      now: NOW
    });

    expect(result.summary).toMatchObject({
      ok: true,
      command: "review-lenses-eval",
      mode: "deterministic",
      dryRun: true,
      scenarioCount: 1
    });
    expect(result.summary.proofBoundary).toContain("dry-run/eval plumbing only");
    expect(existsSync(join(outputRoot, "suite-summary.json"))).toBe(true);
    expect(existsSync(join(outputRoot, "promotion-decision.md"))).toBe(true);

    const runDir = join(outputRoot, "issue-architecture-runtime");
    expect(existsSync(join(runDir, "manifest.json"))).toBe(true);
    expect(existsSync(join(runDir, "baseline", "issue-enrichment.md"))).toBe(true);
    expect(existsSync(join(runDir, "lens", "issue-enrichment.md"))).toBe(true);
    expect(existsSync(join(runDir, "lens", "review-lens-issue_enrichment-packet.json"))).toBe(true);
    expect(existsSync(join(runDir, "lens", "review-lens-issue_enrichment-packet.md"))).toBe(true);
    expect(existsSync(join(runDir, "redaction-report.json"))).toBe(true);
    expect(existsSync(join(runDir, "lens-scorecard.json"))).toBe(true);

    const baseline = readFileSync(join(runDir, "baseline", "issue-enrichment.md"), "utf8");
    const lens = readFileSync(join(runDir, "lens", "issue-enrichment.md"), "utf8");
    expect(baseline).not.toContain("### First-principles lens");
    expect(lens).toContain("### First-principles lens");
    expect(lens).toContain("### Architecture lens");

    const scorecard = JSON.parse(readFileSync(join(runDir, "lens-scorecard.json"), "utf8"));
    expect(scorecard.gates).toContainEqual(expect.objectContaining({ name: "advisory_only", ok: true }));
    expect(scorecard.gates).toContainEqual(expect.objectContaining({ name: "packet_budget", ok: true }));
    expect(scorecard.counts.includedLenses).toBe(2);
    expect(scorecard.counts.secretFindings).toBe(0);
    const diffSummary = JSON.parse(readFileSync(join(runDir, "diff-summary.json"), "utf8"));
    expect(diffSummary.comparisons).toContainEqual(expect.objectContaining({
      artifact: "issue-enrichment.md",
      changed: true,
      baselineSha256: expect.any(String),
      lensSha256: expect.any(String)
    }));
  });

  it("writes lean PR shadow suggestions as non-blocking evidence only", () => {
    const outputRoot = tempRoot(roots);
    const scenario = readReviewLensEvalScenario(join(FIXTURE_DIR, "pr-overbuilt-lean.json"));

    const result = runReviewLensEval({
      scenarios: [scenario],
      outputRoot,
      mode: "deterministic",
      dryRun: true,
      now: NOW
    });

    expect(result.summary.ok).toBe(true);
    const runDir = join(outputRoot, "pr-overbuilt-lean");
    const shadow = JSON.parse(readFileSync(join(runDir, "lens", "lean-review-shadow.json"), "utf8"));
    expect(shadow.suggestions).toMatchObject([
      {
        tag: "native",
        blocking: false,
        requestChangesEligible: false
      }
    ]);
    const scorecard = JSON.parse(readFileSync(join(runDir, "lens-scorecard.json"), "utf8"));
    expect(scorecard.counts.leanSuggestions).toBeGreaterThan(0);
    expect(scorecard.counts.requestChangesEligibleSuggestions).toBe(0);
    expect(scorecard.gates).toContainEqual(expect.objectContaining({ name: "lean_shadow_non_blocking", ok: true }));
  });

  it("keeps safety negative controls from producing delete or shrink advice", () => {
    const outputRoot = tempRoot(roots);
    const scenario = readReviewLensEvalScenario(join(FIXTURE_DIR, "pr-safety-negative-control.json"));

    const result = runReviewLensEval({
      scenarios: [scenario],
      outputRoot,
      mode: "deterministic",
      dryRun: true,
      now: NOW
    });

    expect(result.summary.ok).toBe(true);
    const runDir = join(outputRoot, "pr-safety-negative-control");
    const shadow = JSON.parse(readFileSync(join(runDir, "lens", "lean-review-shadow.json"), "utf8"));
    expect(shadow.suggestions).toEqual([]);
    const scorecard = JSON.parse(readFileSync(join(runDir, "lens-scorecard.json"), "utf8"));
    expect(scorecard.gates).toContainEqual(expect.objectContaining({ name: "safety_negative_control", ok: true }));
  });

  it("redacts secret-like fixture text from every artifact", () => {
    const outputRoot = tempRoot(roots);
    const scenario = readReviewLensEvalScenario(join(FIXTURE_DIR, "issue-redaction-safety.json"));
    const rawSecret = ["ghp", "abcdefghijklmnopqrstuvwxyz123456"].join("_");
    if (!scenario.issue) throw new Error("expected issue fixture");
    scenario.issue.body = `The setup log included ${rawSecret} and needs a safe runbook correction.`;

    const result = runReviewLensEval({
      scenarios: [scenario],
      outputRoot,
      mode: "deterministic",
      dryRun: true,
      now: NOW
    });

    expect(result.summary.ok).toBe(true);
    const runDir = join(outputRoot, "issue-redaction-safety");
    expect(readFileSync(join(runDir, "lens", "issue-enrichment.md"), "utf8")).toContain("[redacted-secret]");
    const artifactText = [
      readFileSync(join(outputRoot, "suite-summary.json"), "utf8"),
      readFileSync(join(runDir, "manifest.json"), "utf8"),
      readFileSync(join(runDir, "baseline", "issue-enrichment.md"), "utf8"),
      readFileSync(join(runDir, "lens", "issue-enrichment.md"), "utf8"),
      readFileSync(join(runDir, "redaction-report.json"), "utf8"),
      readFileSync(join(runDir, "lens-scorecard.json"), "utf8")
    ].join("\n");
    expect(artifactText).not.toContain(rawSecret);
  });

  it("enforces architecture-section expectations from issue fixtures", () => {
    const outputRoot = tempRoot(roots);
    const scenario = readReviewLensEvalScenario(join(FIXTURE_DIR, "issue-routine-no-architecture.json"));

    const result = runReviewLensEval({
      scenarios: [scenario],
      outputRoot,
      mode: "deterministic",
      dryRun: true,
      now: NOW
    });

    expect(result.summary.ok).toBe(true);
    const runDir = join(outputRoot, "issue-routine-no-architecture");
    const lens = readFileSync(join(runDir, "lens", "issue-enrichment.md"), "utf8");
    expect(lens).not.toContain("### Architecture lens");
    const scorecard = JSON.parse(readFileSync(join(runDir, "lens-scorecard.json"), "utf8"));
    expect(scorecard.gates).toContainEqual(expect.objectContaining({ name: "architecture_section_expectation", ok: true }));
  });

  it("rejects reusable or symlinked output roots before writing artifacts", () => {
    const scenario = readReviewLensEvalScenario(join(FIXTURE_DIR, "pr-overbuilt-lean.json"));
    const nonEmptyRoot = tempRoot(roots);
    writeFileSync(join(nonEmptyRoot, "stale.json"), "{}\n");

    expect(() =>
      runReviewLensEval({
        scenarios: [scenario],
        outputRoot: nonEmptyRoot,
        mode: "deterministic",
        dryRun: true,
        now: NOW
      })
    ).toThrow(/outputRoot must be empty/);

    const realRoot = tempRoot(roots);
    const symlinkRoot = `${realRoot}-link`;
    roots.push(symlinkRoot);
    symlinkSync(realRoot, symlinkRoot, "dir");
    expect(() =>
      runReviewLensEval({
        scenarios: [scenario],
        outputRoot: symlinkRoot,
        mode: "deterministic",
        dryRun: true,
        now: NOW
      })
    ).toThrow(/outputRoot must not be a symbolic link/);
  });

  it("rejects non-dry-run model-shadow execution and keeps dry-run model-shadow provider-free", () => {
    const scenario = readReviewLensEvalScenario(join(FIXTURE_DIR, "pr-overbuilt-lean.json"));

    expect(() =>
      runReviewLensEval({
        scenarios: [scenario],
        outputRoot: tempRoot(roots),
        mode: "model-shadow",
        dryRun: false,
        now: NOW
      })
    ).toThrow(/review-lenses-eval is dry-run only/);

    const outputRoot = tempRoot(roots);
    const result = runReviewLensEval({
      scenarios: [scenario],
      outputRoot,
      mode: "model-shadow",
      dryRun: true,
      now: NOW
    });

    expect(result.summary.ok).toBe(true);
    const modelShadow = JSON.parse(readFileSync(join(outputRoot, "pr-overbuilt-lean", "model-shadow-summary.json"), "utf8"));
    expect(modelShadow).toMatchObject({
      mode: "model-shadow",
      providerCalls: 0,
      githubPosts: 0
    });
    expect(modelShadow.proofBoundary).toContain("No provider call or GitHub posting was performed");
  });

  it("runs the CLI command against a fixture directory and writes suite artifacts", async () => {
    const outputRoot = tempRoot(roots);

    const { stdout } = await execFileAsync(process.execPath, [
      tsxCliPath,
      "src/cli.ts",
      "review-lenses-eval",
      "--input-dir",
      FIXTURE_DIR,
      "--output-root",
      outputRoot,
      "--mode",
      "deterministic",
      "--dry-run",
      "true"
    ], { cwd: process.cwd(), env: { ...process.env, NODE_OPTIONS: "--experimental-sqlite" } });
    const parsed = JSON.parse(stdout);

    expect(parsed).toMatchObject({
      ok: true,
      command: "review-lenses-eval",
      mode: "deterministic",
      dryRun: true,
      scenarioCount: 6
    });
    expect(existsSync(join(outputRoot, "suite-summary.json"))).toBe(true);
    expect(existsSync(join(outputRoot, "promotion-decision.md"))).toBe(true);
    expect(readFileSync(join(outputRoot, "promotion-decision.md"), "utf8")).toContain("Live activation: disabled");
  });
});

function tempRoot(roots: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "neondiff-review-lenses-eval-"));
  roots.push(root);
  return root;
}
