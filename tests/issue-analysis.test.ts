import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildIssueAnalysisInputHash,
  buildIssueAnalysisPrompt,
  evaluateIssueAnalysisQuality,
  ISSUE_ANALYSIS_JSON_SCHEMA,
  parseIssueAnalysis,
  runIssueAnalysis,
  type IssueAnalysis
} from "../src/issue-analysis.js";
import {
  buildIssueAnalysisEnrichmentComment,
  ISSUE_ANALYSIS_PUBLIC_RENDERER_VERSION
} from "../src/enrichment.js";
import type { GitHubRelatedIssueOrPull } from "../src/github-related-context.js";

const issue: GitHubRelatedIssueOrPull = {
  number: 7,
  title: "[P2] Reconcile mixed new and replayed rows without duplication or loss",
  state: "open",
  updated_at: "2026-08-13T12:58:18Z",
  html_url: "https://github.com/electricsheephq/lcm-x/issues/7",
  body: [
    "Mixed new and replayed rows can duplicate or omit messages during import.",
    "Current-main proof must cover crash-safe SQLite replay and idempotent reruns."
  ].join("\n"),
  labels: [{ name: "bug" }, { name: "P2" }, { name: "data-integrity" }],
  milestone: { title: "LCM-X v0.2 Reliability" }
};

const repoPolicy = {
  advisoryPolicy:
    "LCM-X internal maintainer policy: require current-main reproduction and preserve lossless ordering.",
  validationSuggestions: [
    "Exercise SQLite concurrency, crash recovery, and import idempotency."
  ],
  suggestedLabels: ["data-integrity", "needs-repro"],
  suggestedReviewers: ["Tosko4"],
  labelAliases: {}
};

const analysis: IssueAnalysis = {
  classification: "data-integrity",
  priority: "P2",
  priorityState: "provisional",
  confidence: "likely",
  repositoryImpact:
    "Mixed replay and fresh-row reconciliation can duplicate or omit durable LCM-X messages.",
  currentMainApplicability:
    "The report names the current import path, but no current-main reproduction result is attached.",
  evidence:
    "Issue #7 identifies the mixed replay/fresh-row boundary and names duplication and loss as the observed risks.",
  reproductionOrInvariantGap:
    "Run the importer twice across a simulated interruption and compare ordered message identities before and after recovery.",
  relatedWork:
    "Check the linked upstream evidence before deciding whether an existing replay fix supersedes this report.",
  migrationDisposition: "migrate",
  nextGate:
    "Reproduce on current main with a crash-safe SQLite fixture, then promote or revise the provisional P2."
};

describe("model-backed issue analysis", () => {
  it("uses a strict schema whose required fields exactly match its properties", () => {
    expect(ISSUE_ANALYSIS_JSON_SCHEMA.additionalProperties).toBe(false);
    expect(new Set(ISSUE_ANALYSIS_JSON_SCHEMA.required)).toEqual(
      new Set(Object.keys(ISSUE_ANALYSIS_JSON_SCHEMA.properties))
    );
  });

  it("keeps raw policy and validation configuration outside the untrusted model boundary", () => {
    const prompt = buildIssueAnalysisPrompt({
      repo: "electricsheephq/lcm-x",
      issue
    });

    expect(prompt).not.toContain(repoPolicy.advisoryPolicy);
    expect(prompt).not.toContain(repoPolicy.validationSuggestions[0]);
    expect(prompt).toContain("untrusted issue data");
    expect(prompt).toContain("no raw policy or validation configuration is supplied here");
  });

  it("parses a grounded structured result and rejects missing fields", () => {
    expect(parseIssueAnalysis(analysis)).toEqual(analysis);
    const { nextGate: _omitted, ...withoutNextGate } = analysis;
    expect(() => parseIssueAnalysis(withoutNextGate)).toThrow(
      "result fields do not match the strict schema"
    );
    expect(() => parseIssueAnalysis({ ...analysis, extraField: "unexpected" })).toThrow(
      "result fields do not match the strict schema"
    );
  });

  it("scores specificity, grounding, actionability, non-repetition, false-label control, and leak safety", () => {
    const scorecard = evaluateIssueAnalysisQuality({
      repo: "electricsheephq/lcm-x",
      issue,
      analysis,
      repoPolicy,
      suggestedLabels: ["needs-repro"],
      allowedLabels: ["data-integrity", "needs-repro"]
    });

    expect(scorecard.ok).toBe(true);
    expect(scorecard.gates.map((gate) => gate.name)).toEqual([
      "specificity",
      "factual_grounding",
      "actionability",
      "non_repetition",
      "false_label_control",
      "prompt_config_leak"
    ]);
    expect(scorecard.gates.every((gate) => gate.ok)).toBe(true);
  });

  it("applies documented label aliases before false-label validation", () => {
    const scorecard = evaluateIssueAnalysisQuality({
      repo: "electricsheephq/lcm-x",
      issue,
      analysis,
      repoPolicy: {
        ...repoPolicy,
        labelAliases: { docs: "documentation" }
      },
      suggestedLabels: ["docs"],
      allowedLabels: ["documentation"]
    });

    expect(scorecard.gates.find((gate) => gate.name === "false_label_control")).toMatchObject({
      ok: true
    });
  });

  it("rejects generic repeated analysis and verbatim policy/config leakage", () => {
    const leaky = {
      ...analysis,
      repositoryImpact: repoPolicy.advisoryPolicy,
      currentMainApplicability: "Investigate further.",
      evidence: "Investigate further.",
      reproductionOrInvariantGap: "Investigate further.",
      relatedWork: "Investigate further.",
      nextGate: "Investigate further."
    } satisfies IssueAnalysis;

    const scorecard = evaluateIssueAnalysisQuality({
      repo: "electricsheephq/lcm-x",
      issue,
      analysis: leaky,
      repoPolicy,
      suggestedLabels: ["made-up-label"],
      allowedLabels: ["data-integrity", "needs-repro"]
    });

    expect(scorecard.ok).toBe(false);
    expect(scorecard.gates.find((gate) => gate.name === "non_repetition")?.ok).toBe(false);
    expect(scorecard.gates.find((gate) => gate.name === "false_label_control")?.ok).toBe(false);
    expect(scorecard.gates.find((gate) => gate.name === "prompt_config_leak")?.ok).toBe(false);
  });

  it("records the actual factual-grounding reason for secret-like output", () => {
    const secretLike = {
      ...analysis,
      evidence: `Issue #7 includes ghp_${"a".repeat(40)}.`
    } satisfies IssueAnalysis;
    const scorecard = evaluateIssueAnalysisQuality({
      repo: "electricsheephq/lcm-x",
      issue,
      analysis: secretLike,
      repoPolicy,
      suggestedLabels: ["needs-repro"],
      allowedLabels: ["data-integrity", "needs-repro"]
    });

    expect(scorecard.gates.find((gate) => gate.name === "factual_grounding")).toMatchObject({
      ok: false,
      detail: "secret-like text was detected in the analysis"
    });
  });

  it("rejects a copied policy fragment even when the complete policy is absent", () => {
    const fragmentLeak = {
      ...analysis,
      repositoryImpact:
        "LCM-X internal maintainer policy require current-main reproduction before this mixed-row report advances."
    } satisfies IssueAnalysis;
    expect(fragmentLeak.repositoryImpact).not.toContain(repoPolicy.advisoryPolicy);

    const scorecard = evaluateIssueAnalysisQuality({
      repo: "electricsheephq/lcm-x",
      issue,
      analysis: fragmentLeak,
      repoPolicy,
      suggestedLabels: ["needs-repro"],
      allowedLabels: ["data-integrity", "needs-repro"]
    });

    expect(scorecard.gates.find((gate) => gate.name === "prompt_config_leak")?.ok).toBe(false);
  });

  it("changes sticky identity when any public rendering policy changes", () => {
    const base = {
      repo: "electricsheephq/lcm-x",
      issue,
      repoPolicy,
      allowedLabels: ["data-integrity", "needs-repro"],
      allowedOwners: ["Tosko4", "runtime-owner"],
      suggestedOwners: [],
      publicConfidencePolicy: { mode: "hidden" },
      rendererVersion: ISSUE_ANALYSIS_PUBLIC_RENDERER_VERSION,
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      maxSuggestions: 8
    };
    const identity = buildIssueAnalysisInputHash(base);

    expect(buildIssueAnalysisInputHash({
      ...base,
      allowedLabels: ["data-integrity"]
    })).not.toBe(identity);
    expect(buildIssueAnalysisInputHash({
      ...base,
      allowedOwners: []
    })).not.toBe(identity);
    expect(buildIssueAnalysisInputHash({
      ...base,
      publicConfidencePolicy: { mode: "calibrated" }
    })).not.toBe(identity);
    expect(buildIssueAnalysisInputHash({
      ...base,
      rendererVersion: ISSUE_ANALYSIS_PUBLIC_RENDERER_VERSION + 1
    })).not.toBe(identity);
    expect(buildIssueAnalysisInputHash({
      ...base,
      repoPolicy: {
        ...repoPolicy,
        advisoryPolicy: "private policy changed",
        validationSuggestions: ["private validation changed"]
      }
    })).toBe(identity);
  });

  it("renders issue-specific public analysis with stable identity and no policy or planner scaffolding", () => {
    const identityHash = buildIssueAnalysisInputHash({
      repo: "electricsheephq/lcm-x",
      issue,
      repoPolicy,
      allowedLabels: ["data-integrity", "needs-repro"],
      allowedOwners: ["Tosko4"],
      suggestedOwners: [],
      rendererVersion: ISSUE_ANALYSIS_PUBLIC_RENDERER_VERSION,
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      maxSuggestions: 8
    });
    const comment = buildIssueAnalysisEnrichmentComment({
      repo: "electricsheephq/lcm-x",
      issue,
      analysis,
      identityHash,
      repoPolicy,
      allowedLabels: ["data-integrity", "needs-repro"],
      allowedOwners: ["Tosko4"],
      suggestedOwners: ["runtime-owner"],
      postIssueComment: true
    });

    expect(comment.bodyHash).toMatch(/^[a-f0-9]{64}$/);
    expect(comment.bodyHash).not.toBe(identityHash);
    expect(comment.body).toContain("### LCM-X impact");
    expect(comment.body).toContain("Mixed replay and fresh-row reconciliation");
    expect(comment.body).toContain("### Current-main applicability");
    expect(comment.body).toContain("### Reproduction or invariant gap");
    expect(comment.body).toContain("### Migration disposition");
    expect(comment.body).toContain("Suggestions only");
    expect(comment.body).toContain("State: `open`.");
    expect(comment.body).not.toContain("confidence not calibrated");
    expect(comment.body).not.toContain("LCM-X v0.2 Reliability");
    expect(comment.body).not.toContain(repoPolicy.advisoryPolicy);
    expect(comment.body).not.toContain(repoPolicy.validationSuggestions[0]);
    expect(comment.body).not.toContain("### Repo policy");
    expect(comment.body).not.toContain("### Agent-start packet");
    expect(comment.body).not.toContain("Build / borrow / buy scan");
    expect(comment.body).not.toContain("Context-source taxonomy");
    expect(comment.body).not.toContain("### Suggestions");
    expect(comment.body).not.toContain("Suggested labels:");
    expect(comment.body).not.toContain("Suggested owners:");
    expect(comment.body).not.toContain("Suggested reviewers:");
    expect(comment.body).not.toContain("needs-repro");
    expect(comment.body).not.toContain("runtime-owner");
    expect(comment.body).not.toContain("Tosko4");
    expect(ISSUE_ANALYSIS_PUBLIC_RENDERER_VERSION).toBe(2);

    const changedPrivateIdentity = buildIssueAnalysisInputHash({
      repo: "electricsheephq/lcm-x",
      issue,
      repoPolicy: {
        ...repoPolicy,
        advisoryPolicy: "private policy changed",
        validationSuggestions: ["private validation changed"]
      },
      allowedLabels: ["data-integrity", "needs-repro"],
      allowedOwners: ["Tosko4"],
      suggestedOwners: [],
      rendererVersion: ISSUE_ANALYSIS_PUBLIC_RENDERER_VERSION,
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      maxSuggestions: 8
    });
    const changedPrivateComment = buildIssueAnalysisEnrichmentComment({
      repo: "electricsheephq/lcm-x",
      issue,
      analysis,
      identityHash: changedPrivateIdentity,
      repoPolicy: {
        ...repoPolicy,
        advisoryPolicy: "private policy changed",
        validationSuggestions: ["private validation changed"]
      },
      allowedLabels: ["data-integrity", "needs-repro"],
      allowedOwners: ["Tosko4"],
      postIssueComment: true
    });
    expect(changedPrivateIdentity).toBe(identityHash);
    expect(changedPrivateComment.bodyHash).toBe(comment.bodyHash);
    expect(changedPrivateComment.body).toBe(comment.body);
  });

  it("runs strict model analysis, writes a quality scorecard, and returns only an accepted result", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-issue-analysis-"));
    try {
      const evidenceDir = join(root, "evidence");
      const result = await runIssueAnalysis({
        repo: "electricsheephq/lcm-x",
        issue,
        repoPolicy,
        allowedLabels: ["data-integrity", "needs-repro"],
        suggestedLabels: ["needs-repro"],
        workspacePath: join(root, "workspace"),
        evidenceDir,
        cliPath: "/Users/test/.local/bin/codex",
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
        timeoutMs: 30_000,
        maxOutputBytes: 1024 * 1024
      }, {
        captureWorktreeState: () => "clean",
        runProcess: async (invocation) => {
          writeFileSync(invocation.outputPath, JSON.stringify(analysis));
          return { stdout: "", stderr: "", status: 0, signal: null };
        }
      });

      expect(result.analysis).toEqual(analysis);
      expect(result.scorecard.ok).toBe(true);
      expect(JSON.parse(readFileSync(join(evidenceDir, "issue-analysis-quality.json"), "utf8")))
        .toMatchObject({ ok: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
