import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertIssueAnalysisPublicSafe,
  assertIssueAnalysisSourceRefs,
  parseIssueAnalysis,
  type IssueAnalysis
} from "../src/issue-analysis.js";
import {
  assertIssueSnapshotCurrent,
  isTrustedIssuePromotion,
  shouldDeferPreservationPreviewToPromotion,
  type IssuePromotionEvidence
} from "../src/issue-enrichment.js";
import {
  assertPublicReviewOutputSafe,
  buildRepoProfilePromptSection,
  publicReviewForbiddenProfileFragments,
  type ResolvedRepoProfile
} from "../src/repo-policy.js";
import { parseZCodeReviewOutput, reviewPromptForbiddenFragments } from "../src/zcode.js";

const v2Analysis: IssueAnalysis = {
  classification: "data-integrity",
  priority: "P2",
  priorityState: "provisional",
  confidence: "likely",
  repositoryImpact: "Replay can duplicate durable messages.",
  currentMainApplicability: "The affected importer exists at the inspected main SHA.",
  verifiedFacts: [
    {
      claim: "The importer inserts a replay row before the transaction commits.",
      sourceRef: {
        kind: "source",
        repo: "electricsheephq/lcm-x",
        sha: "a".repeat(40),
        path: "src/importer.py",
        startLine: 2,
        endLine: 2,
        excerpt: "insert_replay_row(message)"
      }
    }
  ],
  reproductionOrInvariantGap: "Interrupt after insertion and rerun against the same database.",
  relatedWork: ["https://github.com/electricsheephq/lcm-x/issues/14"],
  migrationDisposition: "migrate",
  nextGate: "Add an interruption regression at the inspected main SHA.",
  limitations: ["No runtime reproduction was executed by issue enrichment."],
  labelProposals: ["data-integrity", "needs-repro"]
};

describe("review and issue-enrichment quality v2", () => {
  it("uses a bounded risk lens instead of the legacy prompt/config dump", () => {
    const profile: ResolvedRepoProfile = {
      repo: "electricsheephq/lcm-x",
      canonicalRepo: "electricsheephq/lcm-x",
      source: "explicit",
      enabled: true,
      reviewProfile: "assertive",
      promptNote: "legacy prompt note that must not be injected",
      reviewRiskLens: "Check lossless ordering, provenance, session isolation, and crash-safe SQLite writes.",
      proofExpectations: ["legacy proof configuration"],
      validationHints: ["legacy validation configuration"],
      readinessHints: ["legacy readiness configuration"]
    };

    const prompt = buildRepoProfilePromptSection(profile, { nonProfileTokenEstimate: 4_000 });

    expect(prompt).toContain("Repository risk lens");
    expect(prompt).toContain("lossless ordering");
    expect(prompt).not.toContain(profile.promptNote);
    expect(prompt).not.toContain("legacy proof configuration");
    expect(prompt).not.toContain("legacy validation configuration");
    expect(prompt).not.toContain("legacy readiness configuration");
  });

  it("rejects a risk lens that exceeds either the fixed or proportional budget", () => {
    const profile: ResolvedRepoProfile = {
      repo: "owner/repo",
      canonicalRepo: "owner/repo",
      source: "explicit",
      reviewRiskLens: "x".repeat(2_100)
    };
    expect(() => buildRepoProfilePromptSection(profile, { nonProfileTokenEstimate: 4_000 }))
      .toThrow("review_risk_lens_budget_exceeded");
    expect(() => buildRepoProfilePromptSection(
      { ...profile, reviewRiskLens: "x".repeat(240) },
      { nonProfileTokenEstimate: 100 }
    )).toThrow("review_risk_lens_budget_exceeded");
  });

  it("preserves a strict structured model summary", () => {
    const summary = {
      changedBehavior: ["Issue enrichment now inspects the exact default-branch checkout."],
      invariants: ["Preservation records receive no comments."],
      evidence: ["tests/issue-analysis.test.ts covers source references."],
      limitations: ["No customer-runtime claim."],
      noFindingRationale: "No additional current-diff defect was validated."
    };
    const result = parseZCodeReviewOutput([
      JSON.stringify({ response: JSON.stringify({ findings: [], summary }) })
    ]);
    expect(result.summary).toEqual(summary);
  });

  it("rejects internal review configuration in public output", () => {
    expect(() => assertPublicReviewOutputSafe("Useful walkthrough with evidence and limitations."))
      .not.toThrow();
    for (const leaked of [
      "### Review Settings Preview",
      "Enabled sections: walkthrough",
      "Path instructions: src/**",
      "Suggestion behavior: auto",
      "Roadmap-only settings",
      "Repo-specific instruction: hidden policy"
    ]) {
      expect(() => assertPublicReviewOutputSafe(leaked)).toThrow("public_review_config_leak_rejected");
    }

    const profile: ResolvedRepoProfile = {
      repo: "electricsheephq/lcm-x",
      canonicalRepo: "electricsheephq/lcm-x",
      source: "explicit",
      reviewRiskLens: "Check lossless ordering, provenance, and crash-safe SQLite writes."
    };
    expect(() => assertPublicReviewOutputSafe(
      `Inline finding: ${profile.reviewRiskLens}`,
      publicReviewForbiddenProfileFragments(profile)
    )).toThrow("public_review_config_leak_rejected");
    expect(() => assertPublicReviewOutputSafe(
      "Do not call Bash or shell commands.",
      reviewPromptForbiddenFragments()
    )).toThrow("public_review_config_leak_rejected");
    expect(() => assertIssueAnalysisPublicSafe(
      "You are producing one strict structured maintainer analysis for a GitHub issue.",
      { validationSuggestions: [], suggestedLabels: [], suggestedReviewers: [], labelAliases: {} }
    )).toThrow("issue_analysis_public_leak_rejected");
  });

  it("defers preservation promotion to the authenticated cycle and rejects stale issue snapshots", () => {
    expect(shouldDeferPreservationPreviewToPromotion("preservation_only_upstream_intake")).toBe(true);
    expect(shouldDeferPreservationPreviewToPromotion("stale_issue_closed")).toBe(false);
    const original = {
      number: 127,
      state: "open",
      updated_at: "2026-08-16T10:01:00Z",
      labels: [{ name: "upstream-intake" }, { name: "active-continuation" }]
    };
    expect(() => assertIssueSnapshotCurrent(original, { ...original })).not.toThrow();
    expect(() => assertIssueSnapshotCurrent(original, {
      ...original,
      updated_at: "2026-08-16T10:03:00Z"
    })).toThrow("issue_enrichment_stale_issue_state");
  });

  it("requires every verified source fact to resolve to the exact SHA, line, and excerpt", () => {
    const root = mkdtempSync(join(tmpdir(), "issue-analysis-source-ref-"));
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(join(root, "src/importer.py"), "def replay(message):\n    insert_replay_row(message)\n");
      expect(parseIssueAnalysis(v2Analysis)).toEqual(v2Analysis);
      expect(() => assertIssueAnalysisSourceRefs({
        analysis: v2Analysis,
        workspacePath: root,
        repo: "electricsheephq/lcm-x",
        headSha: "a".repeat(40)
      })).not.toThrow();
      expect(() => assertIssueAnalysisSourceRefs({
        analysis: {
          ...v2Analysis,
          verifiedFacts: [{
            ...v2Analysis.verifiedFacts[0]!,
            sourceRef: { ...v2Analysis.verifiedFacts[0]!.sourceRef, excerpt: "not present" }
          }]
        },
        workspacePath: root,
        repo: "electricsheephq/lcm-x",
        headSha: "a".repeat(40)
      })).toThrow("issue_analysis_source_ref_unverified");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("requires event-time and current maintainer authority for active-continuation", () => {
    const evidence: IssuePromotionEvidence = {
      upstreamIntake: true,
      activeContinuation: true,
      labelEvent: {
        actor: "Tosko4",
        createdAt: "2026-08-16T10:00:00Z"
      },
      allowlist: [{
        login: "Tosko4",
        validFrom: "2026-08-01T00:00:00Z",
        validUntil: "2026-09-01T00:00:00Z"
      }],
      currentPermission: "maintain"
    };
    expect(isTrustedIssuePromotion(evidence)).toBe(true);
    expect(isTrustedIssuePromotion({ ...evidence, currentPermission: "read" })).toBe(false);
    expect(isTrustedIssuePromotion({
      ...evidence,
      labelEvent: { actor: "spoofed", createdAt: evidence.labelEvent.createdAt }
    })).toBe(false);
  });
});
