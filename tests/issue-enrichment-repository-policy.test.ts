import { describe, expect, it } from "vitest";
import {
  buildIssueEnrichmentStatus,
  resolveIssueEnrichmentRepoPolicy,
  type IssueEnrichmentConfig,
  type IssueEnrichmentRepoOverride
} from "../src/issue-enrichment.js";
import { canonicalIssueEnrichmentRepositories } from "../src/issue-enrichment-repository-policy.js";

const thresholds = (overrides: IssueEnrichmentRepoOverride = {}): IssueEnrichmentRepoOverride => ({
  maxIssuesPerCycle: 1,
  maxCommentsPerCycle: 1,
  cooldownMs: 60_000,
  burstWindowMs: 60_000,
  maxIssuesPerBurst: 1,
  lookbackMs: 60_000,
  ...overrides
});

const config = (allowlist: string[], repos: Record<string, IssueEnrichmentRepoOverride>): IssueEnrichmentConfig => ({
  enabled: true,
  postIssueComment: true,
  allowlist,
  allowedLabels: [],
  allowedReviewers: [],
  maxIssuesPerCycle: 1,
  maxCommentsPerCycle: 1,
  globalMaxIssuesPerCycle: 1,
  globalMaxCommentsPerCycle: 1,
  maxActiveRuns: 1,
  leaseTtlMs: 60_000,
  cooldownMs: 60_000,
  burstWindowMs: 60_000,
  maxIssuesPerBurst: 1,
  lookbackMs: 60_000,
  processExistingOpenIssuesOnActivation: true,
  repos
});

describe("issue-enrichment canonical repository policy", () => {
  it("preserves distinct order and chooses a stable casefolded representative", () => {
    const value = config(["z/repo", "Owner/Repo", "a/repo", "owner/repo"], {});
    expect(canonicalIssueEnrichmentRepositories(value).map(({ key, repo }) => ({ key, repo }))).toEqual([
      { key: "z/repo", repo: "z/repo" },
      { key: "owner/repo", repo: "Owner/Repo" },
      { key: "a/repo", repo: "a/repo" }
    ]);
    expect(canonicalIssueEnrichmentRepositories(config(["owner/repo", "Owner/Repo"], {}))[0]?.repo).toBe("Owner/Repo");
  });

  it("uses exact representative overrides before stable casefolded fallback", () => {
    const exact = thresholds({ maxIssuesPerCycle: 2 });
    const alias = thresholds({ maxIssuesPerCycle: 7 });
    expect(canonicalIssueEnrichmentRepositories(config(
      ["owner/repo", "Owner/Repo"],
      { "Owner/Repo": exact, "owner/repo": alias }
    ))[0]?.override).toBe(exact);
    expect(canonicalIssueEnrichmentRepositories(config(
      ["Owner/Repo", "owner/repo"],
      { "owner/repo": alias }
    ))[0]?.override).toBe(alias);
  });

  it("aligns disabled and missing-threshold policy with live preflight", () => {
    const disabled = config(["Owner/Repo", "owner/repo"], { "owner/repo": { enabled: false } });
    expect(buildIssueEnrichmentStatus({
      config: { issueEnrichment: disabled, codexRuntime: { enabled: true } },
      canPostAsApp: true,
      modelAnalysisAvailable: true
    })).toMatchObject({ ok: true, state: "ready", liveThresholdsMissingRepos: [] });
    const missing = config(["Owner/Repo", "owner/repo"], { "owner/repo": { maxIssuesPerCycle: 1 } });
    expect(buildIssueEnrichmentStatus({
      config: { issueEnrichment: missing, codexRuntime: { enabled: true } },
      canPostAsApp: true,
      modelAnalysisAvailable: true
    }).liveThresholdsMissingRepos).toEqual(["Owner/Repo"]);
  });

  it("keeps live preflight aligned with the stable runtime representative", () => {
    const value = config(
      ["Owner/Repo", "owner/repo"],
      { "Owner/Repo": thresholds(), "owner/repo": { maxIssuesPerCycle: 9 } }
    );
    expect(resolveIssueEnrichmentRepoPolicy(value, "Owner/Repo").allowed).toBe(true);
    expect(buildIssueEnrichmentStatus({
      config: { issueEnrichment: value, codexRuntime: { enabled: true } },
      canPostAsApp: true,
      modelAnalysisAvailable: true
    })).toMatchObject({ ok: true, state: "ready", liveThresholdsMissingRepos: [] });
  });
});
