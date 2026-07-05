import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  __evalHarnessTestHooks,
  buildEvalPromotionDecisionMarkdown,
  runOfflineEval,
  runStickyVsColdEval,
  type EvalScenarioInput,
  type EvalScorecard,
  type StickyVsColdScenarioInput
} from "../src/eval-harness.js";

const nodeRequire = createRequire(import.meta.url);
const tsxCli = nodeRequire.resolve("tsx/cli");

function promotionScorecard(input: {
  labels: number;
  p0p1Labels: number;
  maxWilsonLowerBound: number;
}): EvalScorecard {
  return {
    evalName: "evaos-zcode-review-bot-comparison-v0.1",
    runId: "promotion-scorecard",
    suite: "canary_shadow",
    repo: "electricsheephq/evaos-code-review-bot",
    pullNumber: 282,
    headSha: "abc123",
    counts: {
      botFindings: input.labels,
      labels: input.labels,
      truePositive: input.labels,
      falsePositive: 0,
      falseNegative: 0,
      exactLineMatches: input.labels,
      nearbyLineMatches: 0,
      semanticMatches: 0,
      droppedFromSchema: 0,
      secretFindings: 0,
      duplicateFindings: 0,
      inlinePreviews: 0,
      ciMetadata: 0,
      mergedFixes: 0,
      p0p1Labels: input.p0p1Labels
    },
    metrics: {
      precision: 1,
      recall: 1,
      seededRecall: 1,
      maxWilsonLowerBound: input.maxWilsonLowerBound
    },
    matchedLabelKeys: [],
    thresholds: {
      minPrecision: 0.8,
      minRecall: 0.6,
      minSeededRecall: 1,
      maxSecretFindings: 0,
      maxDuplicateFindings: 0
    },
    gates: []
  };
}

describe("offline eval harness", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("writes the required comparison packet and scorecard for matching bot findings", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-eval-harness-pass-"));
    roots.push(root);
    const scenario: EvalScenarioInput = {
      evalName: "evaos-zcode-review-bot-comparison-v0.1",
      runId: "seeded-pass",
      repo: "electricsheephq/WorldOS",
      pullNumber: 1234,
      headSha: "abc123",
      suite: "seeded_defect_recall",
      rawOutput: { findings: [{ body: "raw output stays local" }] },
      botFindings: {
        findings: [
          {
            severity: "P1",
            path: "Assets/Scripts/CombatTurn.cs",
            line: 26,
            title: "Combat health reset breaks fights",
            body: "The player health reset during combat turn resolution makes healthy players nearly dead.",
            confidence: 0.95
          },
          {
            severity: "P2",
            path: "src/review.ts",
            line: 13,
            title: "Review summary misses failure state",
            body: "The summary omits the failed status from the retry output.",
            confidence: 0.75
          }
        ]
      },
      labels: [
        {
          source: "seeded_defect",
          severity: "P1",
          path: "Assets/Scripts/CombatTurn.cs",
          line: 26,
          title: "Combat health reset breaks active fights",
          body: "The new assignment resets player health during turn resolution.",
          sourceId: "seed-combat-health-reset"
        },
        {
          source: "coderabbit",
          severity: "P2",
          path: "src/review.ts",
          line: 15,
          title: "Retry output omits failure status",
          body: "The review summary misses failed retry state in the output.",
          sourceUrl: "https://github.com/electricsheephq/WorldOS/pull/1234#discussion_r1",
          author: "coderabbitai"
        }
      ],
      thresholds: {
        minPrecision: 1,
        minRecall: 1,
        minSeededRecall: 1
      }
    };

    const result = runOfflineEval(scenario, {
      outputDir: root,
      now: new Date("2026-07-01T07:00:00Z")
    });

    expect(result.ok).toBe(true);
    for (const artifact of [
      "manifest.json",
      "raw-output.json",
      "normalized-findings.json",
      "inline-previews.json",
      "ci-metadata.json",
      "merged-fixes.json",
      "redaction-report.json",
      "duplicate-report.json",
      "comparison.csv",
      "labels.json",
      "calibration-report.json",
      "scorecard.json"
    ]) {
      expect(existsSync(join(root, artifact)), artifact).toBe(true);
    }
    const scorecard = JSON.parse(readFileSync(join(root, "scorecard.json"), "utf8"));
    expect(scorecard).toMatchObject({
      counts: {
        truePositive: 2,
        falsePositive: 0,
        falseNegative: 0,
        exactLineMatches: 1,
        nearbyLineMatches: 1
      },
      metrics: {
        precision: 1,
        recall: 1,
        seededRecall: 1
      }
    });
    expect(scorecard.counts.inlinePreviews).toBe(2);
    const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
    expect(manifest).toMatchObject({
      artifactVersion: "0.2",
      mode: "gating",
      thresholds: {
        minPrecision: 1,
        minRecall: 1,
        minSeededRecall: 1,
        maxSecretFindings: 0,
        maxDuplicateFindings: 0
      },
      metadataCounts: {
        inlinePreviews: 2,
        ciMetadata: 0,
        mergedFixes: 0
      }
    });
    expect(manifest.artifactInventory.length).toBe(11);
    const labels = JSON.parse(readFileSync(join(root, "labels.json"), "utf8"));
    expect(labels[1].evidence).toMatchObject({ author: "coderabbitai" });
    expect(readFileSync(join(root, "comparison.csv"), "utf8")).toContain("true_positive,exact_line");
    const calibration = JSON.parse(readFileSync(join(root, "calibration-report.json"), "utf8"));
    expect(calibration).toMatchObject({
      claim: "uncalibrated",
      publicDisplayPolicy: {
        defaultLabel: "uncalibrated",
        minWilsonLowerBound: 0.95,
        minLabeledFindings: 100,
        minP0P1Labels: 30,
        minNegativeControlScenarios: 10
      },
      promotion: {
        eligible: false,
        reason: "insufficient_labeled_findings"
      }
    });
    expect(calibration.bins[2]).toMatchObject({
      minConfidence: 0.8,
      maxConfidence: 1,
      findings: 1,
      matched: 1,
      empiricalPrecision: 1,
      publicLabel: "uncalibrated"
    });
    expect(calibration.bins[2].wilsonLowerBound).toBeLessThan(0.95);
  });

  it("fails closed on duplicate findings and secret-like raw output", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-eval-harness-fail-"));
    roots.push(root);
    const token = ["ghp", "1234567890abcdefghijklmnopqrstuvwx"].join("_");
    const scenario: EvalScenarioInput = {
      runId: "safety-fail",
      repo: "100yenadmin/evaOS-GUI",
      pullNumber: 497,
      headSha: "def456",
      suite: "safety_redaction",
      mode: "exploratory",
      rawOutput: `raw model response contained ${token}`,
      botFindings: {
        findings: [
          {
            severity: "P2",
            path: "src/a.ts",
            line: 10,
            title: "Duplicate issue",
            body: "The same finding appears twice.",
            confidence: 0.8
          },
          {
            severity: "P2",
            path: "src/a.ts",
            line: 10,
            title: "Same bug with different words",
            body: "The same finding appears twice.",
            confidence: 0.7
          }
        ]
      },
      labels: [],
      thresholds: {
        minPrecision: 0,
        minRecall: 0,
        maxDuplicateFindings: 0,
        maxSecretFindings: 0
      }
    };

    const result = runOfflineEval(scenario, { outputDir: root });

    expect(result.ok).toBe(false);
    expect(result.scorecard.gates.find((gate) => gate.name === "duplicate_suppression")).toMatchObject({ ok: false });
    expect(result.scorecard.gates.find((gate) => gate.name === "secret_redaction")).toMatchObject({ ok: false });
    expect(readFileSync(join(root, "raw-output.json"), "utf8")).not.toContain(token);
    expect(readFileSync(join(root, "raw-output.json"), "utf8")).toContain("[redacted-secret]");
  });

  it("fails closed on secret-like finding content while writing redacted artifacts", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-eval-harness-finding-secret-"));
    roots.push(root);
    const token = ["ghp", "1234567890abcdefghijklmnopqrstuvwx"].join("_");

    const result = runOfflineEval({
      runId: "finding-secret",
      repo: "electricsheephq/evaos-code-review-bot",
      pullNumber: 60,
      headSha: "abc",
      suite: "safety_redaction",
      mode: "exploratory",
      botFindings: {
        findings: [
          {
            severity: "P1",
            path: "src/a.ts",
            line: 1,
            title: "Leaked token",
            body: `The model repeated ${token}.`,
            confidence: 0.9
          }
        ]
      },
      labels: [],
      thresholds: {
        minPrecision: 0,
        minRecall: 0,
        maxSecretFindings: 0
      }
    }, { outputDir: root });

    expect(result.ok).toBe(false);
    expect(result.scorecard.gates.find((gate) => gate.name === "secret_redaction")).toMatchObject({ ok: false });
    const normalized = readFileSync(join(root, "normalized-findings.json"), "utf8");
    expect(normalized).not.toContain(token);
    expect(normalized).toContain("[redacted-secret]");
  });

  it("fails closed on malformed findings dropped by schema parsing", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-eval-harness-schema-"));
    roots.push(root);

    const result = runOfflineEval({
      runId: "schema-drop",
      repo: "electricsheephq/evaos-code-review-bot",
      pullNumber: 61,
      headSha: "abc",
      suite: "canary_shadow",
      mode: "exploratory",
      botFindings: {
        findings: [
          {
            severity: "P1",
            path: "src/a.ts",
            line: "not-a-number",
            title: "Bad schema",
            body: "This should be dropped.",
            confidence: 0.9
          }
        ]
      },
      labels: [],
      thresholds: {
        minPrecision: 0,
        minRecall: 0
      }
    }, { outputDir: root });

    expect(result.ok).toBe(false);
    expect(result.scorecard.counts.droppedFromSchema).toBe(1);
    expect(result.scorecard.gates.find((gate) => gate.name === "schema_valid")).toMatchObject({ ok: false });
  });

  it("rejects missing botFindings instead of treating the scenario as empty", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-eval-harness-missing-"));
    roots.push(root);

    expect(() => runOfflineEval({
      runId: "missing-findings",
      repo: "electricsheephq/evaos-code-review-bot",
      pullNumber: 61,
      headSha: "abc",
      suite: "canary_shadow",
      labels: []
    } as unknown as EvalScenarioInput, { outputDir: root }))
      .toThrow("botFindings is required");
  });

  it("requires semantic overlap even for exact-line matches", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-eval-harness-exact-overlap-"));
    roots.push(root);

    const result = runOfflineEval({
      runId: "exact-overlap",
      repo: "electricsheephq/evaos-code-review-bot",
      pullNumber: 61,
      headSha: "abc",
      suite: "seeded_defect_recall",
      mode: "exploratory",
      botFindings: {
        findings: [
          {
            severity: "P1",
            path: "src/eval-harness.ts",
            line: 10,
            title: "Completely unrelated cache bug",
            body: "This text has no useful overlap with the expected issue.",
            confidence: 0.9
          }
        ]
      },
      labels: [
        {
          source: "seeded_defect",
          severity: "P1",
          path: "src/eval-harness.ts",
          line: 10,
          title: "Secret redaction misses object keys",
          body: "Raw output can store credentials in JSON object keys."
        }
      ],
      thresholds: {
        minPrecision: 0,
        minRecall: 1,
        minSeededRecall: 1
      }
    }, { outputDir: root });

    expect(result.ok).toBe(false);
    expect(result.scorecard.counts).toMatchObject({
      truePositive: 0,
      falsePositive: 1,
      falseNegative: 1,
      exactLineMatches: 0
    });
  });

  it("prefers exact-line matches globally before lower-ranked matches", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-eval-harness-global-exact-"));
    roots.push(root);

    const result = runOfflineEval({
      runId: "global-exact",
      repo: "electricsheephq/evaos-code-review-bot",
      pullNumber: 61,
      headSha: "abc",
      suite: "seeded_defect_recall",
      mode: "exploratory",
      botFindings: {
        findings: [
          {
            severity: "P1",
            path: "src/eval-harness.ts",
            line: 10,
            title: "Secret redaction misses keys",
            body: "Raw output object keys can keep leaked secret tokens.",
            confidence: 0.8
          }
        ]
      },
      labels: [
        {
          source: "human",
          severity: "P1",
          path: "src/eval-harness.ts",
          line: 12,
          title: "Secret redaction misses keys nearby",
          body: "Object keys can keep leaked tokens."
        },
        {
          source: "seeded_defect",
          severity: "P1",
          path: "src/eval-harness.ts",
          line: 10,
          title: "Secret redaction misses keys",
          body: "Raw output object keys can keep leaked tokens."
        }
      ],
      thresholds: {
        minPrecision: 1,
        minRecall: 0.5,
        minSeededRecall: 1
      }
    }, { outputDir: root });

    expect(result.ok).toBe(true);
    expect(readFileSync(join(root, "comparison.csv"), "utf8")).toContain("true_positive,exact_line,bot-1,label-2");
  });

  it("scans fallback botFindings and redacts secret-looking object keys", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-eval-harness-secret-key-"));
    roots.push(root);
    const token = ["ghp", "1234567890abcdefghijklmnopqrstuvwx"].join("_");

    const result = runOfflineEval({
      runId: "secret-key",
      repo: "electricsheephq/evaos-code-review-bot",
      pullNumber: 61,
      headSha: "abc",
      suite: "safety_redaction",
      mode: "exploratory",
      botFindings: {
        findings: [],
        [token]: "secret in key"
      },
      labels: [],
      thresholds: {
        minPrecision: 0,
        minRecall: 0,
        maxSecretFindings: 0
      }
    }, { outputDir: root });

    expect(result.ok).toBe(false);
    expect(result.scorecard.gates.find((gate) => gate.name === "secret_redaction")).toMatchObject({ ok: false });
    const rawOutput = readFileSync(join(root, "raw-output.json"), "utf8");
    expect(rawOutput).not.toContain(token);
    expect(rawOutput).toContain("[redacted-secret]");
  });

  it("writes output under an explicit test directory", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-eval-harness-default-path-"));
    roots.push(root);
    const scenario: EvalScenarioInput = {
      runId: "default-path",
      repo: "electricsheephq/evaos-code-review-bot",
      pullNumber: 60,
      headSha: "abc",
      suite: "canary_shadow",
      botFindings: { findings: [] },
      labels: []
    };

    const result = runOfflineEval(scenario, {
      outputDir: root,
      now: new Date("2026-07-01T07:00:00Z")
    });

    expect(result.outputDir).toBe(root);
    expect(result.ok).toBe(true);
  });

  it("runs a complete local fixture set across every required suite", () => {
    const fixtureDir = join(process.cwd(), "tests/fixtures/eval-suite-scenarios");
    const expectedSuites = [
      "canary_shadow",
      "historical_pr_replay",
      "seeded_defect_recall",
      "safety_redaction",
      "duplicate_suppression"
    ];

    for (const suite of expectedSuites) {
      const root = mkdtempSync(join(tmpdir(), `evaos-eval-harness-${suite}-`));
      roots.push(root);
      const scenario = JSON.parse(readFileSync(join(fixtureDir, `${suite}.json`), "utf8")) as EvalScenarioInput;
      const result = runOfflineEval(scenario, { outputDir: root });

      expect(result.ok, suite).toBe(true);
      expect(result.scorecard.suite).toBe(suite);
      expect(existsSync(join(root, "inline-previews.json")), suite).toBe(true);
      expect(existsSync(join(root, "ci-metadata.json")), suite).toBe(true);
      expect(existsSync(join(root, "merged-fixes.json")), suite).toBe(true);
    }
  });

  it("rejects loosened gating thresholds unless the scenario is exploratory", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-eval-harness-threshold-policy-"));
    roots.push(root);

    expect(() => runOfflineEval({
      runId: "unsafe-threshold",
      repo: "electricsheephq/evaos-code-review-bot",
      pullNumber: 9,
      headSha: "abc",
      suite: "canary_shadow",
      botFindings: { findings: [] },
      labels: [],
      thresholds: {
        minPrecision: 0
      }
    }, { outputDir: root })).toThrow('minPrecision below the default requires mode="exploratory"');
  });

  it("rejects seeded defect recall scenarios with no seeded labels", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-eval-harness-seeded-requirement-"));
    roots.push(root);

    const result = runOfflineEval({
      runId: "missing-seeded-label",
      repo: "electricsheephq/evaos-code-review-bot",
      pullNumber: 9,
      headSha: "abc",
      suite: "seeded_defect_recall",
      botFindings: { findings: [] },
      labels: []
    }, { outputDir: root });

    expect(result.ok).toBe(false);
    expect(result.scorecard.gates.find((gate) => gate.name === "suite_requirements")).toMatchObject({ ok: false });
  });

  it("does not match findings when severity differs from the label", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-eval-harness-severity-"));
    roots.push(root);

    const result = runOfflineEval({
      runId: "severity-mismatch",
      repo: "electricsheephq/evaos-code-review-bot",
      pullNumber: 9,
      headSha: "abc",
      suite: "seeded_defect_recall",
      mode: "exploratory",
      botFindings: {
        findings: [{
          severity: "P2",
          path: "src/a.ts",
          line: 10,
          title: "Dangerous retry loop",
          body: "The retry loop can repeat a dangerous operation.",
          confidence: 0.9
        }]
      },
      labels: [{
        source: "seeded_defect",
        severity: "P1",
        path: "src/a.ts",
        line: 10,
        title: "Dangerous retry loop",
        body: "The retry loop can repeat a dangerous operation."
      }],
      thresholds: {
        minPrecision: 0.8,
        minRecall: 1,
        minSeededRecall: 1
      }
    }, { outputDir: root });

    expect(result.ok).toBe(false);
    expect(result.scorecard.counts).toMatchObject({
      truePositive: 0,
      falsePositive: 1,
      falseNegative: 1
    });
  });

  it("detects nearby semantic duplicate findings", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-eval-harness-nearby-duplicate-"));
    roots.push(root);

    const result = runOfflineEval({
      runId: "nearby-duplicate",
      repo: "electricsheephq/evaos-code-review-bot",
      pullNumber: 9,
      headSha: "abc",
      suite: "duplicate_suppression",
      mode: "exploratory",
      botFindings: {
        findings: [
          {
            severity: "P2",
            path: "src/a.ts",
            line: 10,
            title: "Retry failure state omitted",
            body: "The retry output omits failed provider state from the summary.",
            confidence: 0.8
          },
          {
            severity: "P2",
            path: "src/a.ts",
            line: 12,
            title: "Retry failure state omitted again",
            body: "The retry output omits failed provider state from the summary.",
            confidence: 0.7
          }
        ]
      },
      labels: [],
      thresholds: {
        minPrecision: 0,
        minRecall: 0,
        maxDuplicateFindings: 0
      }
    }, { outputDir: root });

    expect(result.ok).toBe(false);
    expect(result.scorecard.counts.duplicateFindings).toBe(1);
  });

  it("rejects output under the repo checkout", () => {
    expect(() => runOfflineEval({
      runId: "repo-output",
      repo: "electricsheephq/evaos-code-review-bot",
      pullNumber: 9,
      headSha: "abc",
      suite: "canary_shadow",
      botFindings: { findings: [] },
      labels: []
    }, { outputDir: join(process.cwd(), ".eval-output") }))
      .toThrow("outputDir must not be inside the current git checkout");
  });

  it("rejects output under a symlinked repo checkout path", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-eval-harness-symlink-"));
    roots.push(root);
    const link = join(root, "repo-link");
    symlinkSync(process.cwd(), link, "dir");

    expect(() => runOfflineEval({
      runId: "symlink-output",
      repo: "electricsheephq/evaos-code-review-bot",
      pullNumber: 9,
      headSha: "abc",
      suite: "canary_shadow",
      botFindings: { findings: [] },
      labels: []
    }, { outputDir: join(link, ".eval-output") }))
      .toThrow("outputDir must not be inside the current git checkout");
  });

  it("counts secret-like label evidence in the redaction gate", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-eval-harness-label-evidence-secret-"));
    roots.push(root);
    const token = ["ghp", "1234567890abcdefghijklmnopqrstuvwx"].join("_");

    const result = runOfflineEval({
      runId: "label-evidence-secret",
      repo: "electricsheephq/evaos-code-review-bot",
      pullNumber: 9,
      headSha: "abc",
      suite: "safety_redaction",
      mode: "exploratory",
      botFindings: { findings: [] },
      labels: [{
        source: "human",
        severity: "P2",
        path: "src/a.ts",
        line: 1,
        title: "Secret in label evidence",
        body: "The label metadata contains a token.",
        sourceUrl: `https://github.test/review?token=${token}`,
        expected: false
      }],
      thresholds: {
        minPrecision: 0,
        minRecall: 0,
        maxSecretFindings: 0
      }
    }, { outputDir: root });

    expect(result.ok).toBe(false);
    expect(result.scorecard.gates.find((gate) => gate.name === "secret_redaction")).toMatchObject({ ok: false });
    expect(readFileSync(join(root, "labels.json"), "utf8")).not.toContain(token);
  });

  it("requires external evidence metadata for historical replay suite", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-eval-harness-historical-evidence-"));
    roots.push(root);

    const result = runOfflineEval({
      runId: "historical-no-evidence",
      repo: "electricsheephq/evaos-code-review-bot",
      pullNumber: 9,
      headSha: "abc",
      suite: "historical_pr_replay",
      botFindings: { findings: [] },
      labels: [{
        source: "human",
        severity: "P2",
        path: "src/a.ts",
        line: 1,
        title: "Human comparison label",
        body: "A comparison label without CI or merged-fix evidence."
      }]
    }, { outputDir: root });

    expect(result.ok).toBe(false);
    expect(result.scorecard.gates.find((gate) => gate.name === "suite_requirements")).toMatchObject({ ok: false });
  });

  it("keeps raw Wilson lower bounds for promotion gating instead of rounded display values", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-eval-harness-wilson-boundary-"));
    roots.push(root);
    const botFindings = Array.from({ length: 109 }, (_, index) => ({
      severity: "P1" as const,
      path: "src/calibration.ts",
      line: (index + 1) * 10,
      title: `Boundary finding ${index + 1}`,
      body: `Boundary regression finding ${index + 1} should preserve raw Wilson math.`,
      confidence: 0.9
    }));
    const labels = botFindings.slice(0, 108).map((finding, index) => ({
      source: "human" as const,
      severity: finding.severity,
      path: finding.path,
      line: finding.line,
      title: finding.title,
      body: finding.body,
      sourceId: `label-${index + 1}`
    }));

    const result = runOfflineEval({
      runId: "wilson-boundary",
      repo: "electricsheephq/evaos-code-review-bot",
      pullNumber: 8,
      headSha: "boundary",
      suite: "canary_shadow",
      botFindings: { findings: botFindings },
      labels,
      thresholds: {
        minPrecision: 0.8,
        minRecall: 0.6
      }
    }, { outputDir: root });

    expect(result.ok).toBe(true);
    expect(result.scorecard.metrics.maxWilsonLowerBound).toBeLessThan(0.95);
    expect(result.scorecard.metrics.maxWilsonLowerBound).toBeGreaterThan(0.949);
    const calibration = JSON.parse(readFileSync(join(root, "calibration-report.json"), "utf8"));
    expect(calibration.bins[2].wilsonLowerBound).toBe(0.95);
  });

  it("fails closed instead of returning NaN for malformed Wilson success counts", () => {
    expect(__evalHarnessTestHooks.wilsonLowerBound95(2, 1)).toBe(0);
    expect(__evalHarnessTestHooks.wilsonLowerBound95(Number.POSITIVE_INFINITY, 10)).toBe(0);
    expect(__evalHarnessTestHooks.wilsonLowerBound95(Number.NaN, 10)).toBe(0);
  });

  it("keeps raw promotion Wilson math aligned with confidence-bin stats", () => {
    const botFindings = [
      {
        id: "bot-low",
        source: "bot" as const,
        severity: "P2" as const,
        path: "src/a.ts",
        line: 10,
        title: "Low-confidence match",
        body: "Low confidence bin should be counted.",
        confidence: 0.25
      },
      {
        id: "bot-mid",
        source: "bot" as const,
        severity: "P2" as const,
        path: "src/b.ts",
        line: 20,
        title: "Mid-confidence miss",
        body: "Mid confidence bin should be counted.",
        confidence: 0.65
      },
      {
        id: "bot-high",
        source: "bot" as const,
        severity: "P1" as const,
        path: "src/c.ts",
        line: 30,
        title: "High-confidence match",
        body: "High confidence bin should be counted.",
        confidence: 0.95
      }
    ];
    const matches = [
      { botFindingId: "bot-low", labelId: "label-low", kind: "exact_line" as const },
      { botFindingId: "bot-high", labelId: "label-high", kind: "semantic" as const }
    ];
    const stats = __evalHarnessTestHooks.computeConfidenceBinStats(botFindings, matches);
    const maxFromBins = Math.max(0, ...stats.map((bin) => bin.rawWilsonLowerBound));

    expect(__evalHarnessTestHooks.maxRawWilsonLowerBound(botFindings, matches)).toBe(maxFromBins);
  });

  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY]
  ])("fails closed when promotion Wilson evidence is %s", (_name, maxWilsonLowerBound) => {
    const scorecards = [
      promotionScorecard({
        labels: 100,
        p0p1Labels: 30,
        maxWilsonLowerBound
      }),
      ...Array.from({ length: 10 }, () => promotionScorecard({
        labels: 0,
        p0p1Labels: 0,
        maxWilsonLowerBound: 0.99
      }))
    ];

    const markdown = buildEvalPromotionDecisionMarkdown({
      ok: true,
      scenarioCount: scorecards.length,
      missingSuites: [],
      scorecards
    });

    expect(markdown).toContain("Decision: not enough evidence");
    expect(markdown).toContain("Calibrated public confidence: disabled");
    expect(markdown).toContain("- wilson_lower_bound_below_threshold");
  });

  it("writes suite-level summary and promotion decision artifacts for eval-suite", () => {
    const fixtureDir = join(process.cwd(), "tests/fixtures/eval-suite-scenarios");
    const outputRoot = mkdtempSync(join(tmpdir(), "evaos-eval-suite-success-output-"));
    roots.push(outputRoot);

    const output = execFileSync(process.execPath, [
      tsxCli,
      "src/cli.ts",
      "eval-suite",
      "--input-dir",
      fixtureDir,
      "--output-root",
      outputRoot
    ], { cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

    const summary = JSON.parse(output);
    expect(summary.ok).toBe(true);
    expect(existsSync(join(outputRoot, "suite-summary.json"))).toBe(true);
    expect(readFileSync(join(outputRoot, "suite-summary.json"), "utf8")).toContain("missingSuites");
    const promotionDecision = readFileSync(join(outputRoot, "promotion-decision.md"), "utf8");
    expect(promotionDecision).toContain("# Eval Promotion Decision");
    expect(promotionDecision).toContain("Decision: not enough evidence");
    expect(promotionDecision).toContain("Calibrated public confidence: disabled");
  });

  it("rejects eval-suite output roots inside the checkout before writing root artifacts", () => {
    const fixtureDir = join(process.cwd(), "tests/fixtures/eval-suite-scenarios");
    const outputRoot = join(process.cwd(), ".tmp-eval-suite-output-inside-checkout");
    roots.push(outputRoot);
    rmSync(outputRoot, { recursive: true, force: true });

    let stderr = "";
    try {
      execFileSync(process.execPath, [
        tsxCli,
        "src/cli.ts",
        "eval-suite",
        "--input-dir",
        fixtureDir,
        "--output-root",
        outputRoot
      ], { cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      stderr = String((error as { stderr?: string }).stderr ?? "");
    }

    expect(stderr).toContain("outputDir must not be inside the current git checkout");
    expect(existsSync(join(outputRoot, "suite-summary.json"))).toBe(false);
    expect(existsSync(join(outputRoot, "promotion-decision.md"))).toBe(false);
  });

  it("reports duplicate runIds as structured eval-suite failures", () => {
    const inputDir = mkdtempSync(join(tmpdir(), "evaos-eval-suite-duplicates-input-"));
    const outputRoot = mkdtempSync(join(tmpdir(), "evaos-eval-suite-duplicates-output-"));
    roots.push(inputDir, outputRoot);
    const scenario = {
      runId: "duplicate-run",
      repo: "electricsheephq/evaos-code-review-bot",
      pullNumber: 9,
      headSha: "abc",
      suite: "canary_shadow",
      botFindings: { findings: [] },
      labels: []
    };
    writeFileSync(join(inputDir, "a.json"), `${JSON.stringify(scenario)}\n`);
    writeFileSync(join(inputDir, "b.json"), `${JSON.stringify(scenario)}\n`);

    let output = "";
    try {
      execFileSync(process.execPath, [
        tsxCli,
        "src/cli.ts",
        "eval-suite",
        "--input-dir",
        inputDir,
        "--output-root",
        outputRoot
      ], { cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      output = String((error as { stdout?: string }).stdout ?? "");
    }

    const summary = JSON.parse(output);
    expect(summary.ok).toBe(false);
    expect(summary.results[1]).toMatchObject({
      ok: false,
      error: expect.stringContaining("duplicate runId")
    });
  });

  it("fails eval-suite when a required suite fixture is missing", () => {
    const inputDir = mkdtempSync(join(tmpdir(), "evaos-eval-suite-missing-input-"));
    const outputRoot = mkdtempSync(join(tmpdir(), "evaos-eval-suite-missing-output-"));
    roots.push(inputDir, outputRoot);
    writeFileSync(join(inputDir, "canary.json"), `${JSON.stringify({
      runId: "canary-only",
      repo: "electricsheephq/evaos-code-review-bot",
      pullNumber: 9,
      headSha: "abc",
      suite: "canary_shadow",
      botFindings: { findings: [] },
      labels: []
    })}\n`);

    let output = "";
    try {
      execFileSync(process.execPath, [
        tsxCli,
        "src/cli.ts",
        "eval-suite",
        "--input-dir",
        inputDir,
        "--output-root",
        outputRoot
      ], { cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      output = String((error as { stdout?: string }).stdout ?? "");
    }

    const summary = JSON.parse(output);
    expect(summary.ok).toBe(false);
    expect(summary.missingSuites).toEqual([
      "historical_pr_replay",
      "seeded_defect_recall",
      "safety_redaction",
      "duplicate_suppression"
    ]);
  });

  it("writes paired sticky-vs-cold packets and an advisory report", () => {
    const outputRoot = mkdtempSync(join(tmpdir(), "evaos-sticky-vs-cold-output-"));
    roots.push(outputRoot);
    const scenario = JSON.parse(
      readFileSync(join(process.cwd(), "tests/fixtures/sticky-vs-cold/seeded_quality_packet.json"), "utf8")
    ) as StickyVsColdScenarioInput;

    const result = runStickyVsColdEval(scenario, {
      outputRoot,
      now: new Date("2026-07-03T08:00:00Z")
    });

    expect(result.ok).toBe(true);
    expect(result.summary).toMatchObject({
      decision: "advisory",
      publicConfidence: "uncalibrated",
      deltas: {
        falsePositive: -1,
        providerAttempts: -1,
        latencyMs: -5000
      },
      evidenceCounts: {
        pairedScenarios: 1,
        labeledFindings: 1,
        p0p1Labels: 1,
        negativeControlScenarios: 0
      }
    });
    expect(existsSync(join(outputRoot, "cold", "scorecard.json"))).toBe(true);
    expect(existsSync(join(outputRoot, "sticky", "scorecard.json"))).toBe(true);
    expect(existsSync(join(outputRoot, "sticky-vs-cold-summary.json"))).toBe(true);
    expect(existsSync(join(outputRoot, "sticky-vs-cold-report.md"))).toBe(true);
    expect(readFileSync(join(outputRoot, "sticky-vs-cold-report.md"), "utf8")).toContain("Decision: advisory");
    expect(result.summary.artifactInventory.map((artifact) => artifact.name)).toEqual([
      "sticky-vs-cold-report.md",
      "cold/scorecard.json",
      "sticky/scorecard.json",
      "cold/manifest.json",
      "sticky/manifest.json"
    ]);
  });

  it("rejects non-empty sticky-vs-cold output roots to avoid stale artifacts", () => {
    const outputRoot = mkdtempSync(join(tmpdir(), "evaos-sticky-vs-cold-stale-root-"));
    roots.push(outputRoot);
    writeFileSync(join(outputRoot, "stale-artifact.json"), "{}\n");
    const scenario = JSON.parse(
      readFileSync(join(process.cwd(), "tests/fixtures/sticky-vs-cold/seeded_quality_packet.json"), "utf8")
    ) as StickyVsColdScenarioInput;

    expect(() => runStickyVsColdEval(scenario, { outputRoot })).toThrow("outputRoot must be empty");
    expect(readFileSync(join(outputRoot, "stale-artifact.json"), "utf8")).toBe("{}\n");
  });

  it("preflights both sticky-vs-cold packet threshold policies before writing artifacts", () => {
    const outputRoot = mkdtempSync(join(tmpdir(), "evaos-sticky-vs-cold-preflight-policies-"));
    roots.push(outputRoot);
    const scenario = JSON.parse(
      readFileSync(join(process.cwd(), "tests/fixtures/sticky-vs-cold/seeded_quality_packet.json"), "utf8")
    ) as StickyVsColdScenarioInput;

    expect(() => runStickyVsColdEval({
      ...scenario,
      sticky: {
        ...scenario.sticky,
        mode: "gating",
        thresholds: {
          ...scenario.sticky.thresholds,
          minPrecision: 0
        }
      }
    }, { outputRoot })).toThrow('sticky.minPrecision below the default requires mode="exploratory"');
    expect(existsSync(join(outputRoot, "cold"))).toBe(false);
    expect(existsSync(join(outputRoot, "sticky"))).toBe(false);
  });

  it("fails sticky-vs-cold when sticky introduces a safety regression", () => {
    const outputRoot = mkdtempSync(join(tmpdir(), "evaos-sticky-vs-cold-regression-"));
    roots.push(outputRoot);
    const token = ["ghp", "1234567890abcdefghijklmnopqrstuvwx"].join("_");
    const scenario: StickyVsColdScenarioInput = {
      runId: "sticky-vs-cold-safety-regression",
      cold: {
        runId: "cold-safe",
        repo: "electricsheephq/evaos-code-review-bot",
        pullNumber: 85,
        headSha: "abc",
        suite: "safety_redaction",
        mode: "exploratory",
        botFindings: { findings: [] },
        labels: [],
        thresholds: {
          minPrecision: 0,
          minRecall: 0
        }
      },
      sticky: {
        runId: "sticky-secret",
        repo: "electricsheephq/evaos-code-review-bot",
        pullNumber: 85,
        headSha: "abc",
        suite: "safety_redaction",
        mode: "exploratory",
        botFindings: {
          findings: [
            {
              severity: "P1",
              path: "src/worker.ts",
              line: 1,
              title: "Leaked token",
              body: `The sticky run repeated ${token}.`,
              confidence: 0.9
            }
          ]
        },
        labels: [],
        thresholds: {
          minPrecision: 0,
          minRecall: 0
        }
      },
      coldRuntime: { providerAttempts: 1 },
      stickyRuntime: { providerAttempts: 1 }
    };

    const result = runStickyVsColdEval(scenario, { outputRoot });

    expect(result.ok).toBe(false);
    expect(result.summary.decision).toBe("not_enough_evidence");
    expect(result.summary.gates.find((gate) => gate.name === "sticky_packet_ok")).toMatchObject({ ok: false });
    expect(result.summary.gates.find((gate) => gate.name === "sticky_has_no_secrets")).toMatchObject({ ok: false });
    expect(result.summary.gates.find((gate) => gate.name === "no_secret_regression")).toMatchObject({ ok: false });
    for (const artifact of [
      join(outputRoot, "sticky", "normalized-findings.json"),
      join(outputRoot, "sticky", "scorecard.json"),
      join(outputRoot, "sticky", "manifest.json"),
      join(outputRoot, "sticky-vs-cold-summary.json")
    ]) {
      expect(readFileSync(artifact, "utf8"), artifact).not.toContain(token);
    }
  });

  it("fails sticky-vs-cold when sticky has secret-like findings even without a secret-count delta", () => {
    const outputRoot = mkdtempSync(join(tmpdir(), "evaos-sticky-vs-cold-secret-same-count-"));
    roots.push(outputRoot);
    const token = ["ghp", "1234567890abcdefghijklmnopqrstuvwx"].join("_");
    const secretFinding = {
      severity: "P1" as const,
      path: "src/worker.ts",
      line: 1,
      title: "Leaked token",
      body: `The packet repeated ${token}.`,
      confidence: 0.9
    };
    const packet = {
      repo: "electricsheephq/evaos-code-review-bot",
      pullNumber: 85,
      headSha: "abc",
      suite: "canary_shadow" as const,
      mode: "exploratory" as const,
      botFindings: { findings: [secretFinding] },
      labels: [],
      thresholds: {
        minPrecision: 0,
        minRecall: 0,
        maxSecretFindings: 1
      }
    };

    const result = runStickyVsColdEval({
      runId: "sticky-vs-cold-secret-same-count",
      cold: { ...packet, runId: "cold-secret" },
      sticky: { ...packet, runId: "sticky-secret" },
      coldRuntime: { providerAttempts: 1 },
      stickyRuntime: { providerAttempts: 1, staleContext: false, repoMemoryAgeSeconds: 60 }
    }, { outputRoot });

    expect(result.ok).toBe(false);
    expect(result.summary.decision).toBe("not_enough_evidence");
    expect(result.summary.deltas.secretFindings).toBe(0);
    expect(result.summary.gates.find((gate) => gate.name === "sticky_has_no_secrets")).toMatchObject({
      ok: false,
      status: "fail"
    });
  });

  it("fails sticky-vs-cold closed when the cold baseline packet fails", () => {
    const outputRoot = mkdtempSync(join(tmpdir(), "evaos-sticky-vs-cold-cold-fail-"));
    roots.push(outputRoot);
    const label = {
      source: "seeded_defect" as const,
      severity: "P1" as const,
      path: "src/worker.ts",
      line: 44,
      title: "Provider timeout kills the review loop",
      body: "A provider timeout escaping the per-PR boundary can stop the worker from scanning later repos."
    };

    const result = runStickyVsColdEval({
      runId: "sticky-vs-cold-cold-fail",
      cold: {
        runId: "cold-missed-seed",
        repo: "electricsheephq/evaos-code-review-bot",
        pullNumber: 85,
        headSha: "abc",
        suite: "seeded_defect_recall",
        botFindings: { findings: [] },
        labels: [label]
      },
      sticky: {
        runId: "sticky-found-seed",
        repo: "electricsheephq/evaos-code-review-bot",
        pullNumber: 85,
        headSha: "abc",
        suite: "seeded_defect_recall",
        botFindings: {
          findings: [{
            severity: "P1",
            path: "src/worker.ts",
            line: 44,
            title: "Provider timeout kills the review loop",
            body: "The provider timeout escapes the per-PR review boundary and can stop later repos from being scanned.",
            confidence: 0.93
          }]
        },
        labels: [label]
      },
      coldRuntime: { providerAttempts: 1 },
      stickyRuntime: { providerAttempts: 1 }
    }, { outputRoot });

    expect(result.ok).toBe(false);
    expect(result.summary.decision).toBe("not_enough_evidence");
    expect(result.summary.gates.find((gate) => gate.name === "cold_packet_ok")).toMatchObject({ ok: false, status: "fail" });
    expect(result.summary.gates.find((gate) => gate.name === "no_secret_regression")).toMatchObject({ ok: true, status: "skip" });
    expect(result.summary.gates.find((gate) => gate.name === "no_duplicate_regression")).toMatchObject({ ok: true, status: "skip" });
    expect(result.summary.gates.find((gate) => gate.name === "no_schema_drop_regression")).toMatchObject({ ok: true, status: "skip" });
    expect(result.summary.gates.find((gate) => gate.name === "recall_not_lower")).toMatchObject({ ok: true, status: "skip" });
  });

  it("fails sticky-vs-cold when sticky misses a label matched by cold", () => {
    const outputRoot = mkdtempSync(join(tmpdir(), "evaos-sticky-vs-cold-matched-label-regression-"));
    roots.push(outputRoot);
    const labelA = {
      source: "seeded_defect" as const,
      severity: "P1" as const,
      path: "src/worker.ts",
      line: 44,
      title: "Provider timeout kills the review loop",
      body: "A provider timeout escaping the per-PR boundary can stop the worker from scanning later repos.",
      sourceId: "seed-provider-timeout-loop"
    };
    const labelB = {
      source: "seeded_defect" as const,
      severity: "P1" as const,
      path: "src/state.ts",
      line: 88,
      title: "Duplicate head state is overwritten",
      body: "A duplicate head row overwrite can hide a pending review lease from the scheduler.",
      sourceId: "seed-duplicate-head-state"
    };
    const packetBase = {
      repo: "electricsheephq/evaos-code-review-bot",
      pullNumber: 85,
      headSha: "abc",
      suite: "seeded_defect_recall" as const,
      mode: "exploratory" as const,
      labels: [labelA, labelB],
      thresholds: {
        minPrecision: 0.5,
        minRecall: 0.5,
        minSeededRecall: 0.5
      }
    };

    const result = runStickyVsColdEval({
      runId: "sticky-vs-cold-matched-label-regression",
      cold: {
        ...packetBase,
        runId: "cold-label-a",
        botFindings: {
          findings: [{
            severity: "P1",
            path: labelA.path,
            line: labelA.line,
            title: labelA.title,
            body: labelA.body,
            confidence: 0.9
          }]
        }
      },
      sticky: {
        ...packetBase,
        runId: "sticky-label-b",
        botFindings: {
          findings: [{
            severity: "P1",
            path: labelB.path,
            line: labelB.line,
            title: labelB.title,
            body: labelB.body,
            confidence: 0.9
          }]
        }
      },
      coldRuntime: { providerAttempts: 1 },
      stickyRuntime: { providerAttempts: 1, staleContext: false, repoMemoryAgeSeconds: 60 }
    }, { outputRoot });

    expect(result.ok).toBe(false);
    expect(result.summary.decision).toBe("not_enough_evidence");
    expect(result.summary.deltas.recall).toBe(0);
    expect(result.summary.gates.find((gate) => gate.name === "sticky_preserves_cold_matches")).toMatchObject({
      ok: false,
      status: "fail"
    });
  });

  it("fails sticky-vs-cold when sticky regresses recall against the same labels", () => {
    const outputRoot = mkdtempSync(join(tmpdir(), "evaos-sticky-vs-cold-recall-regression-"));
    roots.push(outputRoot);
    const labels = [{
      source: "seeded_defect" as const,
      severity: "P1" as const,
      path: "src/worker.ts",
      line: 44,
      title: "Provider timeout kills the review loop",
      body: "A provider timeout escaping the per-PR boundary can stop the worker from scanning later repos."
    }];

    const result = runStickyVsColdEval({
      runId: "sticky-vs-cold-recall-regression",
      cold: {
        runId: "cold-found-seed",
        repo: "electricsheephq/evaos-code-review-bot",
        pullNumber: 85,
        headSha: "abc",
        suite: "seeded_defect_recall",
        botFindings: {
          findings: [{
            severity: "P1",
            path: "src/worker.ts",
            line: 44,
            title: "Provider timeout kills the review loop",
            body: "The provider timeout escapes the per-PR review boundary and can stop later repos from being scanned.",
            confidence: 0.93
          }]
        },
        labels
      },
      sticky: {
        runId: "sticky-missed-seed",
        repo: "electricsheephq/evaos-code-review-bot",
        pullNumber: 85,
        headSha: "abc",
        suite: "seeded_defect_recall",
        mode: "exploratory",
        botFindings: { findings: [] },
        labels,
        thresholds: {
          minPrecision: 0,
          minRecall: 0,
          minSeededRecall: 0
        }
      },
      coldRuntime: { providerAttempts: 1 },
      stickyRuntime: { providerAttempts: 1 }
    }, { outputRoot });

    expect(result.ok).toBe(false);
    expect(result.summary.decision).toBe("not_enough_evidence");
    expect(result.summary.gates.find((gate) => gate.name === "no_false_negative_regression")).toMatchObject({ ok: false, status: "fail" });
    expect(result.summary.gates.find((gate) => gate.name === "recall_not_lower")).toMatchObject({ ok: false, status: "fail" });
    expect(result.summary.gates.find((gate) => gate.name === "seeded_recall_not_lower")).toMatchObject({ ok: false, status: "fail" });
  });

  it("rejects sticky-vs-cold scenarios with different expected labels", () => {
    const outputRoot = mkdtempSync(join(tmpdir(), "evaos-sticky-vs-cold-label-mismatch-"));
    roots.push(outputRoot);
    const scenario = JSON.parse(
      readFileSync(join(process.cwd(), "tests/fixtures/sticky-vs-cold/seeded_quality_packet.json"), "utf8")
    ) as StickyVsColdScenarioInput;

    expect(() => runStickyVsColdEval({
      ...scenario,
      sticky: {
        ...scenario.sticky,
        labels: []
      }
    }, { outputRoot })).toThrow("cold and sticky expected labels must match");
  });

  it("counts negative-control evidence only when explicitly declared", () => {
    const outputRoot = mkdtempSync(join(tmpdir(), "evaos-sticky-vs-cold-negative-control-"));
    roots.push(outputRoot);
    const base = {
      repo: "electricsheephq/evaos-code-review-bot",
      pullNumber: 85,
      headSha: "abc",
      suite: "canary_shadow" as const,
      botFindings: { findings: [] },
      labels: []
    };

    const implicit = runStickyVsColdEval({
      runId: "sticky-vs-cold-implicit-empty-labels",
      cold: { ...base, runId: "cold-empty" },
      sticky: { ...base, runId: "sticky-empty" },
      coldRuntime: { providerAttempts: 1 },
      stickyRuntime: { providerAttempts: 1, staleContext: false }
    }, { outputRoot: join(outputRoot, "implicit") });
    const explicit = runStickyVsColdEval({
      runId: "sticky-vs-cold-explicit-negative-control",
      negativeControl: true,
      cold: { ...base, runId: "cold-negative" },
      sticky: { ...base, runId: "sticky-negative" },
      coldRuntime: { providerAttempts: 1 },
      stickyRuntime: { providerAttempts: 1, staleContext: false }
    }, { outputRoot: join(outputRoot, "explicit") });

    expect(implicit.summary.evidenceCounts.negativeControlScenarios).toBe(0);
    expect(explicit.summary.evidenceCounts.negativeControlScenarios).toBe(1);
  });

  it("fails declared negative-control evidence when either packet emits findings", () => {
    const outputRoot = mkdtempSync(join(tmpdir(), "evaos-sticky-vs-cold-dirty-negative-control-"));
    roots.push(outputRoot);
    const finding = {
      severity: "P3" as const,
      path: "src/worker.ts",
      line: 12,
      title: "Noisy advisory",
      body: "A clean negative-control packet should not produce findings.",
      confidence: 0.4
    };
    const packet = {
      repo: "electricsheephq/evaos-code-review-bot",
      pullNumber: 85,
      headSha: "abc",
      suite: "canary_shadow" as const,
      mode: "exploratory" as const,
      botFindings: { findings: [finding] },
      labels: [],
      thresholds: {
        minPrecision: 0,
        minRecall: 0
      }
    };

    const result = runStickyVsColdEval({
      runId: "sticky-vs-cold-dirty-negative-control",
      negativeControl: true,
      cold: { ...packet, runId: "cold-noisy" },
      sticky: { ...packet, runId: "sticky-noisy" },
      coldRuntime: { providerAttempts: 1 },
      stickyRuntime: { providerAttempts: 1, staleContext: false, repoMemoryAgeSeconds: 60 }
    }, { outputRoot });

    expect(result.ok).toBe(false);
    expect(result.summary.decision).toBe("not_enough_evidence");
    expect(result.summary.evidenceCounts.negativeControlScenarios).toBe(0);
    expect(result.summary.gates.find((gate) => gate.name === "negative_control_clean")).toMatchObject({
      ok: false,
      status: "fail"
    });
  });

  it("rejects declared negative-control scenarios with expected labels", () => {
    const outputRoot = mkdtempSync(join(tmpdir(), "evaos-sticky-vs-cold-negative-labels-"));
    roots.push(outputRoot);
    const scenario = JSON.parse(
      readFileSync(join(process.cwd(), "tests/fixtures/sticky-vs-cold/seeded_quality_packet.json"), "utf8")
    ) as StickyVsColdScenarioInput;

    expect(() => runStickyVsColdEval({
      ...scenario,
      negativeControl: true
    }, { outputRoot })).toThrow("negativeControl sticky-vs-cold scenarios must not include expected labels");
  });

  it("fails sticky-vs-cold when sticky runtime reports stale context", () => {
    const outputRoot = mkdtempSync(join(tmpdir(), "evaos-sticky-vs-cold-stale-context-"));
    roots.push(outputRoot);
    const scenario = JSON.parse(
      readFileSync(join(process.cwd(), "tests/fixtures/sticky-vs-cold/seeded_quality_packet.json"), "utf8")
    ) as StickyVsColdScenarioInput;

    const result = runStickyVsColdEval({
      ...scenario,
      stickyRuntime: {
        ...scenario.stickyRuntime,
        staleContext: true
      }
    }, { outputRoot });

    expect(result.ok).toBe(false);
    expect(result.summary.decision).toBe("not_enough_evidence");
    expect(result.summary.gates.find((gate) => gate.name === "sticky_context_fresh")).toMatchObject({
      ok: false,
      status: "fail"
    });
  });

  it("fails sticky-vs-cold when sticky repo memory is older than the freshness threshold", () => {
    const outputRoot = mkdtempSync(join(tmpdir(), "evaos-sticky-vs-cold-stale-memory-"));
    roots.push(outputRoot);
    const scenario = JSON.parse(
      readFileSync(join(process.cwd(), "tests/fixtures/sticky-vs-cold/seeded_quality_packet.json"), "utf8")
    ) as StickyVsColdScenarioInput;

    const result = runStickyVsColdEval({
      ...scenario,
      stickyRuntime: {
        ...scenario.stickyRuntime,
        repoMemoryAgeSeconds: 90000,
        staleContext: false
      }
    }, { outputRoot });

    expect(result.ok).toBe(false);
    expect(result.summary.decision).toBe("not_enough_evidence");
    expect(result.summary.gates.find((gate) => gate.name === "sticky_repo_memory_fresh")).toMatchObject({
      ok: false,
      status: "fail"
    });
  });

  it("rejects loosened sticky-vs-cold promotion thresholds", () => {
    const scenario = JSON.parse(
      readFileSync(join(process.cwd(), "tests/fixtures/sticky-vs-cold/seeded_quality_packet.json"), "utf8")
    ) as StickyVsColdScenarioInput;
    const minRoot = mkdtempSync(join(tmpdir(), "evaos-sticky-vs-cold-loosen-min-"));
    const deltaRoot = mkdtempSync(join(tmpdir(), "evaos-sticky-vs-cold-loosen-delta-"));
    const providerRoot = mkdtempSync(join(tmpdir(), "evaos-sticky-vs-cold-loosen-provider-"));
    const memoryRoot = mkdtempSync(join(tmpdir(), "evaos-sticky-vs-cold-loosen-memory-"));
    roots.push(minRoot, deltaRoot, providerRoot, memoryRoot);

    expect(() => runStickyVsColdEval({
      ...scenario,
      thresholds: { minRuntimeSafeScenarios: 0 }
    }, { outputRoot: minRoot }))
      .toThrow("minRuntimeSafeScenarios cannot be loosened");
    expect(() => runStickyVsColdEval({
      ...scenario,
      thresholds: { maxFalsePositiveDelta: 1 }
    }, { outputRoot: deltaRoot }))
      .toThrow("maxFalsePositiveDelta cannot be loosened");
    expect(() => runStickyVsColdEval({
      ...scenario,
      thresholds: { minRecallDelta: -1 }
    }, { outputRoot: deltaRoot }))
      .toThrow("minRecallDelta cannot be loosened");
    expect(() => runStickyVsColdEval({
      ...scenario,
      thresholds: { requireProviderAttemptsNotHigher: false }
    }, { outputRoot: providerRoot }))
      .toThrow("requireProviderAttemptsNotHigher cannot be disabled");
    expect(() => runStickyVsColdEval({
      ...scenario,
      thresholds: { maxRepoMemoryAgeSeconds: 172800 }
    }, { outputRoot: memoryRoot }))
      .toThrow("maxRepoMemoryAgeSeconds cannot be loosened");
  });

  it("rejects paired scenarios for different heads", () => {
    const outputRoot = mkdtempSync(join(tmpdir(), "evaos-sticky-vs-cold-head-mismatch-"));
    roots.push(outputRoot);
    const scenario = JSON.parse(
      readFileSync(join(process.cwd(), "tests/fixtures/sticky-vs-cold/seeded_quality_packet.json"), "utf8")
    ) as StickyVsColdScenarioInput;

    expect(() => runStickyVsColdEval({
      ...scenario,
      sticky: {
        ...scenario.sticky,
        headSha: "different-head"
      }
    }, { outputRoot })).toThrow("cold.headSha must match sticky.headSha");
  });

  it("runs sticky-vs-cold eval through the CLI", () => {
    const outputRoot = mkdtempSync(join(tmpdir(), "evaos-sticky-vs-cold-cli-"));
    roots.push(outputRoot);
    const output = execFileSync(process.execPath, [
      tsxCli,
      "src/cli.ts",
      "eval-sticky-vs-cold",
      "--input",
      join(process.cwd(), "tests/fixtures/sticky-vs-cold/seeded_quality_packet.json"),
      "--output-root",
      outputRoot
    ], { cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

    const summary = JSON.parse(output);
    expect(summary).toMatchObject({
      ok: true,
      decision: "advisory",
      publicConfidence: "uncalibrated"
    });
    expect(existsSync(join(outputRoot, "sticky-vs-cold-summary.json"))).toBe(true);
    expect(existsSync(join(outputRoot, "sticky-vs-cold-report.md"))).toBe(true);
  });

  it("reports malformed sticky-vs-cold CLI input with path context", () => {
    const inputDir = mkdtempSync(join(tmpdir(), "evaos-sticky-vs-cold-bad-input-"));
    const outputRoot = mkdtempSync(join(tmpdir(), "evaos-sticky-vs-cold-bad-output-"));
    roots.push(inputDir, outputRoot);
    const inputPath = join(inputDir, "bad.json");
    writeFileSync(inputPath, "{ bad json\n");

    let stderr = "";
    try {
      execFileSync(process.execPath, [
        tsxCli,
        "src/cli.ts",
        "eval-sticky-vs-cold",
        "--input",
        inputPath,
        "--output-root",
        outputRoot
      ], { cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      stderr = String((error as { stderr?: string }).stderr ?? "");
    }

    expect(stderr).toContain(`failed to parse --input ${inputPath}`);
  });

  it("rejects sticky-vs-cold output roots inside the checkout", () => {
    const outputRoot = join(process.cwd(), ".tmp-sticky-vs-cold-output-inside-checkout");
    roots.push(outputRoot);
    rmSync(outputRoot, { recursive: true, force: true });
    const scenario = JSON.parse(
      readFileSync(join(process.cwd(), "tests/fixtures/sticky-vs-cold/seeded_quality_packet.json"), "utf8")
    ) as StickyVsColdScenarioInput;

    expect(() => runStickyVsColdEval(scenario, { outputRoot }))
      .toThrow("outputDir must not be inside the current git checkout");
    expect(existsSync(join(outputRoot, "sticky-vs-cold-summary.json"))).toBe(false);
  });
});

describe("offline negative-control flag (#284)", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function baseScenario(overrides: Partial<EvalScenarioInput> = {}): EvalScenarioInput {
    return {
      runId: "neg-control-284",
      repo: "electricsheephq/WorldOS",
      pullNumber: 4242,
      headSha: "sha284",
      suite: "seeded_defect_recall",
      botFindings: { findings: [] },
      labels: [],
      ...overrides
    };
  }

  function runInto(scenario: EvalScenarioInput, prefix: string) {
    const root = mkdtempSync(join(tmpdir(), prefix));
    roots.push(root);
    runOfflineEval(scenario, { outputDir: root });
    return {
      manifest: JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")),
      calibration: JSON.parse(readFileSync(join(root, "calibration-report.json"), "utf8")),
      scorecard: JSON.parse(readFileSync(join(root, "scorecard.json"), "utf8"))
    };
  }

  it("gives an unlabeled scenario WITHOUT the flag zero negative-control credit", () => {
    const { manifest, calibration } = runInto(baseScenario(), "evaos-neg-control-implicit-");

    expect(manifest.negativeControl).toBe(false);
    // Empty labels no longer implies a negative control; promotion still fails on labeled-finding
    // count, but the reason must not be an unearned negative-control credit.
    expect(calibration.promotion.eligible).toBe(false);
  });

  it("credits an unlabeled scenario WITH the explicit flag as a negative control", () => {
    const { manifest } = runInto(baseScenario({ negativeControl: true }), "evaos-neg-control-explicit-");

    expect(manifest.negativeControl).toBe(true);
  });

  it("rejects a declared negative control that carries expected labels", () => {
    const scenario = baseScenario({
      negativeControl: true,
      botFindings: { findings: [] },
      labels: [
        {
          source: "human",
          severity: "P1",
          path: "src/x.ts",
          line: 3,
          title: "Real defect",
          body: "A genuinely expected label.",
          expected: true
        }
      ]
    });

    expect(() => runOfflineEval(scenario, { outputDir: mkdtempSync(join(tmpdir(), "evaos-neg-control-reject-")) }))
      .toThrow("negativeControl scenarios must not include expected labels");
  });

  it("sums negative-control credit across multiple scorecards in the promotion decision", () => {
    // #284 second derivation site: suite-level promotion aggregates the explicit per-scorecard
    // count. One flagged control + one merely-unlabeled scenario must aggregate to exactly 1.
    const flagged = runInto(
      baseScenario({ runId: "neg-control-284-flagged", negativeControl: true }),
      "evaos-neg-control-agg-flagged-"
    );
    const unlabeled = runInto(
      baseScenario({ runId: "neg-control-284-unlabeled" }),
      "evaos-neg-control-agg-unlabeled-"
    );

    const markdown = buildEvalPromotionDecisionMarkdown({
      ok: true,
      scenarioCount: 2,
      missingSuites: [],
      scorecards: [flagged.scorecard, unlabeled.scorecard]
    });

    expect(markdown).toContain("- Negative-control scenarios: 1 /");
    expect(markdown).not.toContain("- Negative-control scenarios: 2 /");
    expect(markdown).toContain("Decision: not enough evidence");
  });

  it("rejects a non-boolean negativeControl flag", () => {
    const scenario = baseScenario({ negativeControl: "yes" as unknown as boolean });

    expect(() => runOfflineEval(scenario, { outputDir: mkdtempSync(join(tmpdir(), "evaos-neg-control-type-")) }))
      .toThrow("negativeControl must be a boolean");
  });
});
