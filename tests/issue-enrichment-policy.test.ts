import { describe, expect, it } from "vitest";
import { loadConfigFromObject } from "../src/config.js";
import { buildIssueEnrichmentStatus, resolveIssueEnrichmentRepoPolicy } from "../src/issue-enrichment.js";

describe("issue enrichment rollout policy", () => {
  it("keeps issue enrichment allowlist and suggestions separate from PR review monitoring", () => {
    const config = loadConfigFromObject({
      pilotRepos: ["owner/pr-review-repo"],
      repoProfiles: {
        repos: {
          "owner/pr-review-repo": {
            suggestedLabels: ["pr-label"],
            suggestedReviewers: ["pr-reviewer"]
          }
        }
      },
      issueEnrichment: {
        enabled: true,
        postIssueComment: false,
        allowlist: ["owner/issue-repo"],
        allowedLabels: ["issue-label"],
        allowedReviewers: ["issue-reviewer"],
        repos: {
          "owner/issue-repo": {
            allowedLabels: ["repo-issue-label"],
            allowedReviewers: ["repo-issue-reviewer"]
          }
        }
      }
    });

    expect(resolveIssueEnrichmentRepoPolicy(config.issueEnrichment!, "owner/pr-review-repo")).toMatchObject({
      allowed: false,
      reason: "not_issue_enrichment_allowlisted"
    });
    expect(resolveIssueEnrichmentRepoPolicy(config.issueEnrichment!, "owner/issue-repo")).toMatchObject({
      allowed: true,
      suggestions: {
        allowedLabels: ["repo-issue-label"],
        allowedReviewers: ["repo-issue-reviewer"]
      }
    });
  });

  it("blocks live issue comments until every allowlisted repo has explicit repo throttle thresholds", () => {
    const config = loadConfigFromObject({
      issueEnrichment: {
        enabled: true,
        postIssueComment: true,
        allowlist: ["owner/issue-repo"]
      }
    });

    const status = buildIssueEnrichmentStatus({
      config,
      canPostAsApp: true,
      checkedAt: "2026-07-04T11:30:00.000Z"
    });

    expect(status).toMatchObject({
      ok: false,
      state: "blocked",
      blockers: ["issue_enrichment_live_repo_thresholds_required"],
      liveThresholdsMissingRepos: ["owner/issue-repo"]
    });
  });

  it("reports threshold blockers before missing App credentials for live operator triage", () => {
    const config = loadConfigFromObject({
      issueEnrichment: {
        enabled: true,
        postIssueComment: true,
        allowlist: ["owner/issue-repo"]
      }
    });

    const status = buildIssueEnrichmentStatus({
      config,
      canPostAsApp: false,
      checkedAt: "2026-07-04T11:30:00.000Z"
    });

    expect(status).toMatchObject({
      ok: false,
      state: "blocked",
      blockers: [
        "issue_enrichment_live_repo_thresholds_required",
        "github_app_credentials_required_for_live_issue_comments"
      ],
      liveThresholdsMissingRepos: ["owner/issue-repo"]
    });
  });

  it("treats partial repo thresholds as incomplete but exempts disabled repos", () => {
    const config = loadConfigFromObject({
      issueEnrichment: {
        enabled: true,
        postIssueComment: true,
        allowlist: ["owner/partial-repo", "owner/disabled-repo"],
        repos: {
          "owner/partial-repo": {
            enabled: true,
            maxIssuesPerCycle: 3
          },
          "owner/disabled-repo": {
            enabled: false
          }
        }
      }
    });

    const status = buildIssueEnrichmentStatus({
      config,
      canPostAsApp: true,
      checkedAt: "2026-07-04T11:30:00.000Z"
    });

    expect(status).toMatchObject({
      ok: false,
      state: "blocked",
      blockers: ["issue_enrichment_live_repo_thresholds_required"],
      liveThresholdsMissingRepos: ["owner/partial-repo"]
    });
  });

  it("allows live issue comments only after repo-specific throttle thresholds are configured", () => {
    const config = loadConfigFromObject({
      issueEnrichment: {
        enabled: true,
        postIssueComment: true,
        allowlist: ["owner/issue-repo"],
        repos: {
          "owner/issue-repo": {
            enabled: true,
            maxIssuesPerCycle: 3,
            maxCommentsPerCycle: 1,
            cooldownMs: 3_600_000,
            burstWindowMs: 3_600_000,
            maxIssuesPerBurst: 6,
            lookbackMs: 600_000,
            processExistingOpenIssuesOnActivation: false
          }
        }
      }
    });

    const status = buildIssueEnrichmentStatus({
      config,
      canPostAsApp: true,
      checkedAt: "2026-07-04T11:30:00.000Z"
    });

    expect(status).toMatchObject({
      ok: true,
      state: "ready",
      blockers: [],
      liveThresholdsMissingRepos: []
    });
  });

  it("blocks issue enrichment when an allowlisted repo lacks GitHub Issues API access", () => {
    const config = loadConfigFromObject({
      issueEnrichment: {
        enabled: true,
        postIssueComment: true,
        allowlist: ["owner/issue-repo"],
        repos: {
          "owner/issue-repo": {
            enabled: true,
            maxIssuesPerCycle: 3,
            maxCommentsPerCycle: 1,
            cooldownMs: 3_600_000,
            burstWindowMs: 3_600_000,
            maxIssuesPerBurst: 6,
            lookbackMs: 600_000,
            processExistingOpenIssuesOnActivation: false
          }
        }
      }
    });

    const status = buildIssueEnrichmentStatus({
      config,
      canPostAsApp: true,
      checkedAt: "2026-07-04T11:30:00.000Z",
      issueReadChecks: [
        {
          repo: "owner/issue-repo",
          ok: false,
          error: "GitHub API 403 for /repos/owner/issue-repo/issues?state=open: Resource not accessible by integration"
        }
      ]
    });

    expect(status).toMatchObject({
      ok: false,
      state: "blocked",
      blockers: ["github_app_issues_permission_required"],
      issueReadChecks: [
        {
          repo: "owner/issue-repo",
          ok: false
        }
      ]
    });
    expect(JSON.stringify(status)).not.toMatch(/ghp_|PRIVATE KEY|BEGIN RSA/);
  });
});
