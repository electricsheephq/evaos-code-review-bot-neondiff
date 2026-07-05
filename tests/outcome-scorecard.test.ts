import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildOutcomeScorecard,
  parseOutcomeScorecardInput,
  writeOutcomeScorecardPacket,
  type OutcomeScorecardInput
} from "../src/outcome-scorecard.js";

const nodeRequire = createRequire(import.meta.url);
const tsxCli = nodeRequire.resolve("tsx/cli");
const fixtureRoot = join(process.cwd(), "tests/fixtures/outcome-scorecard");

describe("outcome scorecard fixtures", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("scores issue-enrichment build/borrow/buy fixtures on the 0-5 weighted rubric", () => {
    const scorecard = buildOutcomeScorecard(loadFixture("issue-build-borrow-buy.json"), {
      now: new Date("2026-07-05T15:00:00Z")
    });

    expect(scorecard).toMatchObject({
      artifactVersion: "0.1",
      ok: false,
      evalName: "evaos-outcome-scorecard-fixture-v0.1",
      runId: "issue-build-borrow-buy",
      surface: "issue_enrichment",
      generatedAt: "2026-07-05T15:00:00.000Z",
      publicClaim: "advisory_only",
      rawScoreUncapped: 3.6666666666666665,
      weightedScore: 3.7,
      maxScore: 5
    });
    expect(scorecard.proofBoundary).toContain("do not prove CodeRabbit parity");
    expect(scorecard.metrics.find((metric) => metric.id === "build_vs_buy_leverage")).toMatchObject({
      rawScore: 4,
      weightedContribution: 1
    });
  });

  it("lets negative-control docs fixtures pass only when noise and latency are evidenced", () => {
    const scorecard = buildOutcomeScorecard(loadFixture("pr-docs-negative-control.json"));

    expect(scorecard.ok).toBe(true);
    expect(scorecard.scenario.negativeControl).toBe(true);
    expect(scorecard.weightedScore).toBeCloseTo(3.55);
    expect(scorecard.caps.find((cap) => cap.name === "evidence_required_for_high_scores")).toMatchObject({
      applied: false
    });
  });

  it("caps scores above 3 that lack direct evidence links", () => {
    const scorecard = buildOutcomeScorecard(loadFixture("high-score-without-evidence.json"));

    expect(scorecard.ok).toBe(false);
    expect(scorecard.weightedScore).toBe(3);
    expect(scorecard.maxScore).toBe(3);
    expect(scorecard.caps).toContainEqual(expect.objectContaining({
      name: "evidence_required_for_high_scores",
      applied: true
    }));
  });

  it("caps safety failures at 1 regardless of raw quality score", () => {
    const scorecard = buildOutcomeScorecard(loadFixture("safety-cap.json"));

    expect(scorecard.ok).toBe(false);
    expect(scorecard.weightedScore).toBe(1);
    expect(scorecard.maxScore).toBe(1);
    expect(scorecard.caps).toContainEqual(expect.objectContaining({
      name: "safety_cap",
      applied: true
    }));
  });

  it("gives unmeasurable metrics zero positive credit", () => {
    const scorecard = buildOutcomeScorecard({
      runId: "unmeasurable-metric",
      surface: "pr_review",
      scenario: {
        id: "unmeasurable-metric",
        title: "Unmeasurable metrics cannot pad the score"
      },
      metrics: [
        metric({ id: "measured", rawScore: 5, weight: 50 }),
        metric({
          id: "unmeasurable",
          weight: 50,
          state: "unmeasurable",
          unmeasurableReason: "No labeled post-merge outcome exists."
        })
      ]
    });

    expect(scorecard.ok).toBe(false);
    expect(scorecard.maxScore).toBe(5);
    expect(scorecard.weightedScore).toBe(2.5);
    expect(scorecard.metrics.find((entry) => entry.id === "unmeasurable")).toMatchObject({
      rawScore: 0,
      state: "unmeasurable",
      weightedContribution: 0,
      unmeasurableReason: "No labeled post-merge outcome exists."
    });
  });

  it("does not cap high weighted scores only because a low-weight metric is unmeasurable", () => {
    const scorecard = buildOutcomeScorecard({
      runId: "mostly-measured",
      surface: "pr_review",
      scenario: {
        id: "mostly-measured",
        title: "Mostly measured scorecard"
      },
      metrics: [
        metric({ id: "measured", rawScore: 5, weight: 90 }),
        metric({
          id: "unmeasurable",
          weight: 10,
          state: "unmeasurable",
          unmeasurableReason: "Post-merge data not available yet."
        })
      ]
    });

    expect(scorecard.ok).toBe(true);
    expect(scorecard.maxScore).toBe(5);
    expect(scorecard.weightedScore).toBe(4.5);
    expect(scorecard.caps).toContainEqual(expect.objectContaining({
      name: "unmeasurable_no_positive_credit",
      applied: true
    }));
  });

  it("redacts secret-like scorecard text and marks the packet non-ok", () => {
    const token = ["ghp", "1234567890abcdefghijklmnopqrstuvwx"].join("_");
    const scorecard = buildOutcomeScorecard({
      runId: token,
      surface: "issue_enrichment",
      scenario: {
        id: token,
        title: `Contains ${token}`
      },
      metrics: [
        metric({
          id: token,
          rawScore: 2,
          notes: [`raw provider log included ${token}`]
        })
      ],
      hardGates: [
        {
          name: token,
          ok: true,
          detail: `gate named ${token}`
        }
      ]
    });

    expect(scorecard.ok).toBe(false);
    expect(JSON.stringify(scorecard)).not.toContain(token);
    expect(scorecard.runId).toContain("redacted-secret");
    expect(scorecard.scenario.id).toContain("redacted-secret");
    expect(scorecard.metrics[0].id).toContain("redacted-secret");
    expect(scorecard.hardGates[0]?.name).toContain("redacted-secret");
    expect(scorecard.redaction).toMatchObject({
      ok: false,
      redactedSources: expect.arrayContaining([
        expect.objectContaining({ id: "input.runId" }),
        expect.objectContaining({ id: "input.scenario.id" }),
        expect.objectContaining({ id: "input.scenario.title" })
      ])
    });
  });

  it("honors the configured evidence-link threshold for scores above 3", () => {
    const scorecard = buildOutcomeScorecard({
      runId: "evidence-threshold",
      surface: "issue_enrichment",
      scenario: {
        id: "evidence-threshold",
        title: "Evidence threshold"
      },
      thresholds: {
        minEvidenceScoreForScoresAboveThree: 2
      },
      metrics: [
        metric({
          id: "high_score_one_link",
          rawScore: 4,
          evidenceUrls: ["https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/264"]
        })
      ]
    });

    expect(scorecard.ok).toBe(false);
    expect(scorecard.maxScore).toBe(3);
    expect(scorecard.weightedScore).toBe(3);
    expect(scorecard.caps).toContainEqual(expect.objectContaining({
      name: "evidence_required_for_high_scores",
      applied: true
    }));
  });

  it("writes a scorecard packet with stable manifest artifacts", () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-outcome-scorecard-packet-"));
    roots.push(root);
    const outputDir = join(root, "packet");

    const scorecard = writeOutcomeScorecardPacket({
      scorecardInput: loadFixture("pr-docs-negative-control.json"),
      outputDir,
      now: new Date("2026-07-05T16:00:00Z")
    });

    expect(scorecard.ok).toBe(true);
    for (const artifact of ["scorecard.json", "scorecard.md", "redaction-report.json", "manifest.json"]) {
      expect(existsSync(join(outputDir, artifact))).toBe(true);
    }
    const manifest = JSON.parse(readFileSync(join(outputDir, "manifest.json"), "utf8"));
    expect(manifest).toMatchObject({
      ok: true,
      runId: "pr-docs-negative-control",
      publicClaim: "advisory_only",
      rawScoreUncapped: 3.6666666666666665,
      scorecardSha256: scorecard.sha256,
      packetSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      artifacts: {
        "scorecard.json": expect.stringMatching(/^[a-f0-9]{64}$/)
      }
    });
  });

  it("exposes a dry-run-only CLI that writes executable fixture evidence", () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-outcome-scorecard-cli-"));
    roots.push(root);
    const inputPath = join(fixtureRoot, "pr-docs-negative-control.json");
    const outputDir = join(root, "packet");

    const output = execFileSync(process.execPath, [
      tsxCli,
      "src/cli.ts",
      "outcome-scorecard",
      "--input",
      inputPath,
      "--dry-run",
      "true",
      "--output-dir",
      outputDir
    ], {
      cwd: process.cwd(),
      encoding: "utf8"
    });

    const parsed = JSON.parse(output);
    expect(parsed).toMatchObject({
      ok: true,
      command: "outcome-scorecard",
      dryRun: true
    });
    expect(parsed.outputDir).toContain("/packet");
    expect(existsSync(join(outputDir, "scorecard.json"))).toBe(true);
  });

  it("defaults the CLI to dry-run when --dry-run is omitted", () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-outcome-scorecard-cli-default-"));
    roots.push(root);
    const outputDir = join(root, "packet");

    const output = execFileSync(process.execPath, [
      tsxCli,
      "src/cli.ts",
      "outcome-scorecard",
      "--input",
      join(fixtureRoot, "pr-docs-negative-control.json"),
      "--output-dir",
      outputDir
    ], {
      cwd: process.cwd(),
      encoding: "utf8"
    });

    const parsed = JSON.parse(output);
    expect(parsed).toMatchObject({
      ok: true,
      command: "outcome-scorecard",
      dryRun: true
    });
    expect(existsSync(join(outputDir, "scorecard.json"))).toBe(true);
  });

  it("refuses non-dry-run CLI execution", () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-outcome-scorecard-live-"));
    roots.push(root);

    expect(() => execFileSync(process.execPath, [
      tsxCli,
      "src/cli.ts",
      "outcome-scorecard",
      "--input",
      join(fixtureRoot, "pr-docs-negative-control.json"),
      "--dry-run",
      "false",
      "--output-dir",
      join(root, "packet")
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: "pipe"
    })).toThrow("outcome-scorecard is dry-run only in this release");
  });
});

function loadFixture(name: string): OutcomeScorecardInput {
  return parseOutcomeScorecardInput(JSON.parse(readFileSync(join(fixtureRoot, name), "utf8")));
}

function metric(overrides: Partial<OutcomeScorecardInput["metrics"][number]> = {}): OutcomeScorecardInput["metrics"][number] {
  return {
    id: "metric",
    label: "Metric",
    weight: 100,
    rawScore: 3,
    denominator: "Sample denominator",
    dataSource: "Sample data source",
    scoringRule: "Sample scoring rule",
    evidenceUrls: ["https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/264"],
    ...overrides
  };
}
