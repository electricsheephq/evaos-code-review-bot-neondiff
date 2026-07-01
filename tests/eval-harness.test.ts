import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runOfflineEval, type EvalScenarioInput } from "../src/eval-harness.js";

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
});
