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
  it("preserves distinct order and uses a stable casefolded durable identity", () => {
    const value = config(["z/repo", "Owner/Repo", "a/repo", "owner/repo"], {});
    expect(canonicalIssueEnrichmentRepositories(value).map(({ key, repo }) => ({ key, repo }))).toEqual([
      { key: "z/repo", repo: "z/repo" },
      { key: "owner/repo", repo: "owner/repo" },
      { key: "a/repo", repo: "a/repo" }
    ]);
    expect(canonicalIssueEnrichmentRepositories(config(["owner/repo", "Owner/Repo"], {}))[0]?.repo).toBe("owner/repo");
    expect(canonicalIssueEnrichmentRepositories(config(["Owner/Repo", "owner/repo"], {}))[0]?.repo).toBe("owner/repo");
  });

  it("uses the durable-identity override before deterministic casefolded fallback", () => {
    const durable = thresholds({ maxIssuesPerCycle: 2 });
    const alias = thresholds({ maxIssuesPerCycle: 7 });
    expect(canonicalIssueEnrichmentRepositories(config(
      ["Owner/Repo", "owner/repo"],
      { "Owner/Repo": alias, "owner/repo": durable }
    ))[0]?.override).toBe(durable);
    expect(canonicalIssueEnrichmentRepositories(config(
      ["Owner/Repo"],
      { "Owner/Repo": alias }
    ), ["owner/repo"])[0]).toMatchObject({ repo: "owner/repo", override: alias });
  });

  it("aligns disabled and missing-threshold policy with live preflight", () => {
    const disabled = config(["Owner/Repo", "owner/repo"], { "owner/repo": { enabled: false } });
    expect(buildIssueEnrichmentStatus({
      config: { issueEnrichment: disabled, codexRuntime: { enabled: true } },
      canPostAsApp: true,
      modelAnalysisAvailable: true
    })).toMatchObject({ ok: true, state: "ready", liveThresholdsMissingRepos: [] });
    const missing = config(["Owner/Repo", "owner/repo"], { "Owner/Repo": { maxIssuesPerCycle: 1 } });
    expect(buildIssueEnrichmentStatus({
      config: { issueEnrichment: missing, codexRuntime: { enabled: true } },
      canPostAsApp: true,
      modelAnalysisAvailable: true
    }).liveThresholdsMissingRepos).toEqual(["owner/repo"]);
  });

  it("keeps live preflight aligned with runtime policy after alias addition", () => {
    const value = config(
      ["Owner/Repo", "owner/repo"],
      { "Owner/Repo": { maxIssuesPerCycle: 9 }, "owner/repo": thresholds() }
    );
    expect(resolveIssueEnrichmentRepoPolicy(value, "Owner/Repo").allowed).toBe(true);
    expect(buildIssueEnrichmentStatus({
      config: { issueEnrichment: value, codexRuntime: { enabled: true } },
      canPostAsApp: true,
      modelAnalysisAvailable: true
    })).toMatchObject({ ok: true, state: "ready", liveThresholdsMissingRepos: [] });
  });
});
