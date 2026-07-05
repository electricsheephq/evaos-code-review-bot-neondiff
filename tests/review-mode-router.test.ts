import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { selectReviewMode, type ReviewModeSelectionInput } from "../src/review-mode-router.js";

const nodeRequire = createRequire(import.meta.url);
const tsxCli = nodeRequire.resolve("tsx/cli");

describe("review mode router", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("selects fast mode for docs-only pull requests", () => {
    const selection = selectReviewMode({
      subject: "pull_request",
      title: "docs: clarify setup",
      docsOnly: true,
      files: [
        { filename: "docs/SETUP.md", status: "modified", changes: 8 },
        { filename: "README.md", status: "modified", changes: 3 }
      ]
    });

    expect(selection).toMatchObject({
      mode: "fast",
      targetUse: "pull_request_review",
      budget: {
        targetMinutes: 5,
        disposition: "within_budget"
      }
    });
    expect(selection.matchedSignals).toContain("docs_only_surface");
    expect(selection.proofBoundary).toContain("does not change scheduler");
  });

  it("keeps security or product docs fast while recording hidden risk signals", () => {
    const selection = selectReviewMode({
      subject: "pull_request",
      title: "Update pricing and security docs",
      docsOnly: true,
      files: [
        { filename: "SECURITY.md", status: "modified", changes: 8 },
        { filename: "docs/pricing.md", status: "modified", changes: 3 }
      ]
    });

    expect(selection).toMatchObject({
      mode: "fast",
      targetUse: "pull_request_review"
    });
    expect(selection.riskAreas).toContain("docs_only");
    expect(selection.riskAreas).toContain("security_boundary");
    expect(selection.riskAreas).toContain("api_compatibility");
    expect(selection.matchedSignals).toContain("docs_security boundary path");
    expect(selection.matchedSignals).toContain("docs_billing/pricing path");
    expect(selection.matchedSignals).toContain("docs_product_pm_text");
  });

  it("does not classify security source directories as docs-only", () => {
    const selection = selectReviewMode({
      subject: "pull_request",
      title: "small refactor",
      files: [
        { filename: "src/security/auth.ts", status: "modified", changes: 8 }
      ]
    });

    expect(selection).toMatchObject({
      mode: "deep",
      targetUse: "pull_request_review"
    });
    expect(selection.riskAreas).toContain("security_boundary");
  });

  it("records outcome-weighted scoring dimensions for selected mode", () => {
    const selection = selectReviewMode({
      subject: "pull_request",
      title: "fix provider retry queue",
      files: [{ filename: "src/scheduler.ts", status: "modified", changes: 120 }]
    });

    expect(selection.mode).toBe("deep");
    expect(selection.outcomeWeights).toMatchObject({
      regressionPrevention: 35,
      contextProofAwareness: 20,
      safetyLifecycle: 10
    });
  });

  it("uses explicit reviewModes config for budget disposition evidence", () => {
    const selection = selectReviewMode({
      subject: "pull_request",
      title: "fix provider retry queue",
      files: [{ filename: "src/scheduler.ts", status: "modified", changes: 120 }],
      expectedRuntimeMs: 23 * 60_000,
      providerTimeoutMs: 40 * 60_000,
      reviewModes: {
        enabled: true,
        defaultMode: "fast",
        modes: {
          fast: modeConfig(5, 10),
          standard: modeConfig(15, 20),
          deep: modeConfig(22, 33),
          product_pm: modeConfig(15, 25),
          research: modeConfig(20, 30)
        }
      }
    });

    expect(selection).toMatchObject({
      mode: "deep",
      budget: {
        targetMinutes: 22,
        hardTimeoutMinutes: 33,
        disposition: "partial"
      }
    });
  });

  it("does not report hardTimeoutMinutes beyond a non-minute wholeRunDeadlineMs", () => {
    const hardTimeoutMs = 1_500_001;
    const selection = selectReviewMode({
      subject: "pull_request",
      title: "refactor parser utility",
      files: [{ filename: "src/parser.ts", status: "modified", changes: 20 }],
      providerTimeoutMs: 2_000_000,
      reviewModes: {
        enabled: true,
        defaultMode: "standard",
        modes: {
          fast: modeConfig(5, 10),
          standard: {
            ...modeConfig(15, 20),
            wholeRunDeadlineMs: hardTimeoutMs
          },
          deep: modeConfig(25, 35),
          product_pm: modeConfig(15, 25),
          research: modeConfig(20, 30)
        }
      }
    });

    expect(selection.mode).toBe("standard");
    expect(selection.budget.hardTimeoutMs).toBe(hardTimeoutMs);
    expect(selection.budget.hardTimeoutMinutes * 60_000).toBeLessThanOrEqual(hardTimeoutMs);
  });

  it("selects deep mode for runtime and provider risk paths", () => {
    const selection = selectReviewMode({
      subject: "pull_request",
      title: "fix provider retry queue",
      files: [
        { filename: "src/scheduler.ts", status: "modified", changes: 120 },
        { filename: "src/zcode-timeout.ts", status: "modified", changes: 12 }
      ]
    });

    expect(selection.mode).toBe("deep");
    expect(selection.riskAreas).toContain("runtime_correctness");
    expect(selection.matchedSignals).toContain("runtime/provider path");
    expect(selection.budget.targetMinutes).toBe(25);
  });

  it("selects deep mode for hyphenated runtime provider filenames with neutral title", () => {
    const selection = selectReviewMode({
      subject: "pull_request",
      title: "small refactor",
      files: [
        { filename: "src/provider-throttle.ts", status: "modified", changes: 8 },
        { filename: "src/zcode-timeout.ts", status: "modified", changes: 8 },
        { filename: "src/release-gate.ts", status: "modified", changes: 8 }
      ]
    });

    expect(selection.mode).toBe("deep");
    expect(selection.matchedSignals).toContain("runtime/provider path");
  });

  it("keeps generic runtime or release wording standard without corroborating risk", () => {
    const selection = selectReviewMode({
      subject: "pull_request",
      title: "fix runtime typo in release notes script",
      body: "Adds queue length wording to the status panel.",
      files: [
        { filename: "src/components/ReleaseNotesCopy.tsx", status: "modified", changes: 16 }
      ]
    });

    expect(selection.mode).toBe("standard");
    expect(selection.matchedSignals).toContain("default_standard");
    expect(selection.matchedSignals).not.toContain("deep_text");
    expect(selection.matchedSignals).not.toContain("corroborated_runtime_text");
  });

  it("uses deep mode for corroborated runtime incident wording", () => {
    const selection = selectReviewMode({
      subject: "pull_request",
      title: "fix provider throttle queue backlog",
      files: [
        { filename: "src/components/ProviderStatus.tsx", status: "modified", changes: 16 }
      ]
    });

    expect(selection.mode).toBe("deep");
    expect(selection.matchedSignals).toContain("corroborated_runtime_text");
    expect(selection.riskAreas).toContain("runtime_correctness");
  });

  it("selects deep mode for high churn files through additions/deletions fallback", () => {
    const selection = selectReviewMode({
      subject: "pull_request",
      title: "refactor utility module",
      files: [
        { filename: "src/utils/formatters.ts", status: "modified", additions: 260, deletions: 240 }
      ]
    });

    expect(selection.mode).toBe("deep");
    expect(selection.matchedSignals).toContain("high_churn_file");
    expect(selection.riskAreas).toContain("release_regression");
  });

  it("selects product_pm mode for UX and product intent when no deep risk matched", () => {
    const selection = selectReviewMode({
      subject: "pull_request",
      title: "Improve onboarding conversion UX",
      body: "Adjust dashboard copy and first-run workflow.",
      files: [
        { filename: "src/components/WelcomePanel.tsx", status: "modified", changes: 44 }
      ]
    });

    expect(selection).toMatchObject({
      mode: "product_pm",
      budget: {
        targetMinutes: 15
      }
    });
    expect(selection.matchedSignals).toContain("product_pm_text");
  });

  it("keeps research mode scoped to issue enrichment", () => {
    const issueSelection = selectReviewMode({
      subject: "issue",
      researchRequested: true,
      title: "Should we build or borrow this integration?"
    });
    const prSelection = selectReviewMode({
      subject: "pull_request",
      researchRequested: true,
      title: "Regular code change",
      files: [{ filename: "src/index.ts", status: "modified", changes: 10 }]
    });

    expect(issueSelection.mode).toBe("research");
    expect(issueSelection.targetUse).toBe("issue_enrichment");
    expect(prSelection.mode).toBe("standard");
  });

  it("keeps non-triggered issue inputs out of research mode", () => {
    const selection = selectReviewMode({
      subject: "issue",
      title: "Triage small follow-up"
    });

    expect(selection).toMatchObject({
      mode: "standard",
      targetUse: "issue_enrichment"
    });
    expect(selection.matchedSignals).toContain("issue_research_not_requested");
  });

  it("marks over-budget deep reviews as deferred instead of silent queue blockers", () => {
    const selection = selectReviewMode({
      subject: "pull_request",
      title: "release runtime provider queue fix",
      files: [{ filename: "src/provider-throttle-report.ts", status: "modified", changes: 80 }],
      expectedRuntimeMs: 40 * 60_000
    });

    expect(selection.mode).toBe("deep");
    expect(selection.budget).toMatchObject({
      disposition: "deferred",
      hardTimeoutMinutes: 35
    });
    expect(selection.budget.detail).toContain("silently blocking queue");
  });

  it("marks observed over-target reviews partial even when provider timeout allows completion", () => {
    const selection = selectReviewMode({
      subject: "pull_request",
      title: "refactor parser utility",
      files: [{ filename: "src/parser.ts", status: "modified", changes: 20 }],
      expectedRuntimeMs: 16 * 60_000,
      providerTimeoutMs: 25 * 60_000
    });

    expect(selection).toMatchObject({
      mode: "standard",
      budget: {
        targetMinutes: 15,
        disposition: "partial"
      }
    });
    expect(selection.budget.detail).toContain("exceeds target");
  });

  it("marks deep review partial when configured provider timeout is below target", () => {
    const selection = selectReviewMode({
      subject: "pull_request",
      title: "release runtime provider queue fix",
      files: [{ filename: "src/scheduler.ts", status: "modified", changes: 80 }],
      providerTimeoutMs: 20 * 60_000
    });

    expect(selection.mode).toBe("deep");
    expect(selection.budget).toMatchObject({
      targetMinutes: 25,
      disposition: "partial"
    });
    expect(selection.budget.detail).toContain("Configured provider timeout");
    expect(selection.proofBoundary).toContain("evidence-only");
  });

  it("keeps fast docs route within budget under a normal provider timeout", () => {
    const selection = selectReviewMode({
      subject: "pull_request",
      title: "docs: clarify setup",
      files: [{ filename: "docs/SETUP.md", status: "modified", changes: 2 }],
      providerTimeoutMs: 20 * 60_000
    });

    expect(selection).toMatchObject({
      mode: "fast",
      budget: {
        targetMinutes: 5,
        disposition: "within_budget"
      }
    });
  });

  it("marks standard route timeout_risk when provider timeout is below hard timeout but above target", () => {
    const selection = selectReviewMode({
      subject: "pull_request",
      title: "refactor parser utility",
      files: [{ filename: "src/parser.ts", status: "modified", changes: 20 }],
      providerTimeoutMs: 17 * 60_000
    });

    expect(selection).toMatchObject({
      mode: "standard",
      budget: {
        targetMinutes: 15,
        hardTimeoutMinutes: 20,
        disposition: "timeout_risk"
      }
    });
    expect(selection.budget.detail).toContain("below the 20 minute hard timeout");
  });

  it("exposes a dry-run-only CLI that can write evidence", () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-review-mode-"));
    roots.push(root);
    const inputPath = join(root, "input.json");
    const outputDir = join(root, "evidence");
    const input: ReviewModeSelectionInput = {
      subject: "pull_request",
      title: "docs only",
      files: [{ filename: "docs/README.md", status: "modified", changes: 1 }]
    };
    writeFileSync(inputPath, `${JSON.stringify(input, null, 2)}\n`);

    const output = execFileSync(process.execPath, [
      tsxCli,
      "src/cli.ts",
      "review-mode",
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
      command: "review-mode",
      dryRun: true,
      result: {
        mode: "fast"
      }
    });
    expect(existsSync(join(outputDir, "review-mode.json"))).toBe(true);
    expect(readFileSync(join(outputDir, "review-mode.json"), "utf8")).toContain("\"mode\": \"fast\"");
  });

  it("refuses live review-mode execution", () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-review-mode-live-"));
    roots.push(root);
    const inputPath = join(root, "input.json");
    writeFileSync(inputPath, `${JSON.stringify({ subject: "pull_request" }, null, 2)}\n`);

    expect(() => execFileSync(process.execPath, [
      tsxCli,
      "src/cli.ts",
      "review-mode",
      "--input",
      inputPath,
      "--dry-run",
      "false"
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: "pipe"
    })).toThrow("review-mode is dry-run only in this release");
  });
});

function modeConfig(targetMinutes: number, hardTimeoutMinutes: number) {
  return {
    targetMinutes,
    wholeRunDeadlineMs: hardTimeoutMinutes * 60_000,
    perAttemptTimeoutMs: targetMinutes * 60_000,
    maxPatchBytes: 80_000,
    maxContextBytes: 40_000,
    maxProviderAttempts: 1,
    allowedContextSources: ["patch" as const],
    queueWeight: 50,
    leaseTtlMs: 45 * 60_000,
    heartbeatMs: 60_000,
    escalation: {
      allowDepthEscalation: false,
      allowDepthEscalationWhileProviderBacklog: false,
      allowManualCommand: true,
      allowRequestChanges: false
    }
  };
}
