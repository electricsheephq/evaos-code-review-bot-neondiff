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
  PUBLIC_REVIEW_PROFILE_FRAGMENT_WORD_WINDOW,
  publicReviewForbiddenProfileFragments,
  type ResolvedRepoProfile
} from "../src/repo-policy.js";
import { buildReviewPrompt, parseZCodeReviewOutput, reviewPromptForbiddenFragments } from "../src/zcode.js";

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

  it("budgets a risk lens against the exact rendered non-profile prompt", () => {
    expect(() => buildReviewPrompt({
      repo: "owner/repo",
      pull: {
        number: 1,
        title: "x",
        draft: false,
        head: { sha: "a".repeat(40), ref: "feature/x", repo: { full_name: "owner/repo" } },
        base: { sha: "b".repeat(40), ref: "main", repo: { full_name: "owner/repo" } },
        html_url: "https://github.test/owner/repo/pull/1"
      },
      files: [],
      repoProfile: {
        repo: "owner/repo",
        canonicalRepo: "owner/repo",
        source: "explicit",
        reviewRiskLens: "x"
      }
    })).not.toThrow();
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
      "Repo-specific instruction: hidden policy",
      "Review-settings-preview",
      "Path\u2011instructions",
      "prompt-Note: hidden configuration",
      "review-Risk-Lens: hidden configuration",
      "proof-Expectations: hidden configuration",
      "validation-Hints: hidden configuration",
      "readiness-Hints: hidden configuration",
      "promptNote: hidden configuration",
      "reviewRiskLens: hidden configuration",
      "proofExpectations: hidden configuration",
      "validationHints: hidden configuration",
      "readinessHints: hidden configuration",
      "reviewSettingsPreview: hidden configuration",
      "enabledSections: hidden configuration",
      "pathInstructions: hidden configuration",
      "suggestionBehavior: hidden configuration",
      "roadmapOnlySettings: hidden configuration",
      "repoSpecificInstruction: hidden configuration",
      "PROMPTNOTE: hidden configuration",
      "REVIEWRISKLENS: hidden configuration",
      "PROOFEXPECTATIONS: hidden configuration",
      "VALIDATIONHINTS: hidden configuration",
      "READINESSHINTS: hidden configuration",
      "REVIEWSETTINGSPREVIEW: hidden configuration",
      "ENABLEDSECTIONS: hidden configuration",
      "PATHINSTRUCTIONS: hidden configuration",
      "SUGGESTIONBEHAVIOR: hidden configuration",
      "ROADMAPONLYSETTINGS: hidden configuration",
      "REPOSPECIFICINSTRUCTION: hidden configuration"
    ]) {
      expect(() => assertPublicReviewOutputSafe(leaked)).toThrow("public_review_config_leak_rejected");
    }
    expect(() => assertPublicReviewOutputSafe(
      "The PROMPTNOTEBOOK helper was renamed and the previewer remains unchanged."
    )).not.toThrow();

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
      "Check lossless ordering",
      publicReviewForbiddenProfileFragments(profile),
      PUBLIC_REVIEW_PROFILE_FRAGMENT_WORD_WINDOW
    )).not.toThrow();
    expect(() => assertPublicReviewOutputSafe(
      "Check-lossless-ordering",
      publicReviewForbiddenProfileFragments(profile),
      PUBLIC_REVIEW_PROFILE_FRAGMENT_WORD_WINDOW
    )).not.toThrow();
    expect(() => assertPublicReviewOutputSafe(
      "Check lossless ordering provenance and crash safe SQLite",
      publicReviewForbiddenProfileFragments(profile),
      PUBLIC_REVIEW_PROFILE_FRAGMENT_WORD_WINDOW
    )).toThrow("public_review_config_leak_rejected");
    expect(() => assertPublicReviewOutputSafe(
      "Assistant messages with a null tool-call field now serialize without crashing; the diff adds direct regression coverage.",
      publicReviewForbiddenProfileFragments(profile),
      PUBLIC_REVIEW_PROFILE_FRAGMENT_WORD_WINDOW
    )).not.toThrow();
    const canaryProfile: ResolvedRepoProfile = {
      ...profile,
      reviewRiskLens: "Focus on lossless ordering and provenance; session and profile isolation; source coverage and fresh-tail behavior; tool-call and result grouping; SQLite concurrency, crash recovery, and import idempotency."
    };
    expect(() => assertPublicReviewOutputSafe(
      "Tool-call/result grouping is unchanged for valid non-empty tool_calls lists; the modified branch only normalizes falsy values.",
      publicReviewForbiddenProfileFragments(canaryProfile),
      PUBLIC_REVIEW_PROFILE_FRAGMENT_WORD_WINDOW
    )).not.toThrow();
    expect(() => assertPublicReviewOutputSafe(
      "session and profile isolation source coverage and fresh tail",
      publicReviewForbiddenProfileFragments(canaryProfile),
      PUBLIC_REVIEW_PROFILE_FRAGMENT_WORD_WINDOW
    )).toThrow("public_review_config_leak_rejected");
    expect(() => assertPublicReviewOutputSafe(
      "Do not modify files",
      reviewPromptForbiddenFragments()
    )).toThrow("public_review_config_leak_rejected");
    expect(() => assertPublicReviewOutputSafe(
      "Do-not-modify-files",
      reviewPromptForbiddenFragments()
    )).toThrow("public_review_config_leak_rejected");
    expect(() => assertPublicReviewOutputSafe(
      "Use P0/P1 only for validated correctness",
      reviewPromptForbiddenFragments()
    )).toThrow("public_review_config_leak_rejected");
    expect(() => assertIssueAnalysisPublicSafe(
      "No reproduction or invariant evidence exists at the inspected main SHA.",
      { validationSuggestions: [], suggestedLabels: [], suggestedReviewers: [], labelAliases: {} }
    )).not.toThrow();
    expect(() => assertIssueAnalysisPublicSafe(
      "You are producing one strict",
      { validationSuggestions: [], suggestedLabels: [], suggestedReviewers: [], labelAliases: {} }
    )).toThrow("issue_analysis_public_leak_rejected");
    expect(() => assertIssueAnalysisPublicSafe(
      "You-are-producing-one-strict",
      { validationSuggestions: [], suggestedLabels: [], suggestedReviewers: [], labelAliases: {} }
    )).toThrow("issue_analysis_public_leak_rejected");
    expect(() => assertIssueAnalysisPublicSafe(
      "Suggestion-behavior",
      { validationSuggestions: [], suggestedLabels: [], suggestedReviewers: [], labelAliases: {} }
    )).toThrow("issue_analysis_public_leak_rejected");
    for (const leaked of [
      "advisory-Policy: hidden configuration",
      "validation-Suggestions: hidden configuration",
      "Repo-policy: hidden configuration",
      "repoPolicy: hidden configuration",
      "advisoryPolicy: hidden configuration",
      "validationSuggestions: hidden configuration",
      "reviewSettingsPreview: hidden configuration",
      "enabledSections: hidden configuration",
      "pathInstructions: hidden configuration",
      "suggestionBehavior: hidden configuration",
      "roadmapOnlySettings: hidden configuration",
      "agentStartPacket: hidden configuration",
      "buildBorrowBuyScan: hidden configuration",
      "contextSourceTaxonomy: hidden configuration",
      "REPOPOLICY: hidden configuration",
      "ADVISORYPOLICY: hidden configuration",
      "VALIDATIONSUGGESTIONS: hidden configuration",
      "REVIEWSETTINGSPREVIEW: hidden configuration",
      "ENABLEDSECTIONS: hidden configuration",
      "PATHINSTRUCTIONS: hidden configuration",
      "SUGGESTIONBEHAVIOR: hidden configuration",
      "ROADMAPONLYSETTINGS: hidden configuration",
      "AGENTSTARTPACKET: hidden configuration",
      "BUILDBORROWBUYSCAN: hidden configuration",
      "CONTEXTSOURCETAXONOMY: hidden configuration",
      "### `RepoPolicy`",
      "`Repo policy`"
    ]) {
      expect(() => assertIssueAnalysisPublicSafe(
        leaked,
        { validationSuggestions: [], suggestedLabels: [], suggestedReviewers: [], labelAliases: {} }
      )).toThrow("issue_analysis_public_leak_rejected");
    }
    expect(() => assertIssueAnalysisPublicSafe(
      "Source: src/repo-policy.ts:1-2",
      { validationSuggestions: [], suggestedLabels: [], suggestedReviewers: [], labelAliases: {} }
    )).not.toThrow();
    expect(() => assertIssueAnalysisPublicSafe(
      "The REPOPOLICYMODULE parser resolves that source path.",
      { validationSuggestions: [], suggestedLabels: [], suggestedReviewers: [], labelAliases: {} }
    )).not.toThrow();
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
