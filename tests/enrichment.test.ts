import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import {
  buildEnrichmentComment,
  buildEnrichmentMarker,
  buildIssueEnrichmentComment,
  buildIssueEnrichmentDryRunOutput,
  buildIssueEnrichmentMarker,
  ENRICHMENT_MARKER_PREFIX,
  ENRICHMENT_STATE_MARKER_PREFIX,
  postEnrichmentComment
} from "../src/enrichment.js";
import type { GitHubRelatedIssueOrPull } from "../src/github-related-context.js";
import { buildIssueEnrichmentStatus, collectIssueEnrichmentScan } from "../src/issue-enrichment.js";
import type { PullFilePatch, PullRequestSummary } from "../src/types.js";

const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);

const pull: PullRequestSummary = {
  number: 77,
  title: "Harden review queue #22",
  draft: false,
  body: "Closes #22. ghp_123456789012345678901234",
  head: { sha: HEAD_A, ref: "feature/enrich", repo: { full_name: "electricsheephq/evaos-code-review-bot" } },
  base: { sha: "b".repeat(40), ref: "main", repo: { full_name: "electricsheephq/evaos-code-review-bot" } },
  html_url: "https://github.test/electricsheephq/evaos-code-review-bot/pull/77",
  requested_reviewers: [{ login: "reviewer-one" }],
  labels: [{ name: "enhancement" }]
};

describe("sticky enrichment comments", () => {
  it("loads default-off enrichment config", () => {
    expect(loadConfig().enrichment).toMatchObject({
      enabled: false,
      postIssueComment: false,
      packetVersion: "enrichment-comment-v0.1"
    });
    expect(loadConfig().issueEnrichment).toMatchObject({
      enabled: false,
      postIssueComment: false,
      allowlist: [],
      maxIssuesPerCycle: 5,
      maxCommentsPerCycle: 0,
      maxIssuesPerBurst: 10,
      processExistingOpenIssuesOnActivation: false
    });
  });

  it("keeps issue enrichment allowlist and throttles separate from PR monitoring", () => {
    const root = mkdtempSync(join(tmpdir(), "issue-enrichment-config-"));
    try {
      const configPath = join(root, "config.json");
      writeFileSync(configPath, `${JSON.stringify({
        pilotRepos: ["owner/pr-review-repo"],
        issueEnrichment: {
          enabled: false,
          postIssueComment: false,
          allowlist: ["owner/issue-repo"],
          maxIssuesPerCycle: 2,
          maxCommentsPerCycle: 1,
          cooldownMs: 3_600_000,
          burstWindowMs: 3_600_000,
          maxIssuesPerBurst: 8,
          lookbackMs: 600_000,
          processExistingOpenIssuesOnActivation: false,
          repos: {
            "owner/issue-repo": {
              maxIssuesPerCycle: 3,
              maxCommentsPerCycle: 2
            }
          }
        }
      })}\n`);

      const config = loadConfig(configPath);
      const issueConfig = config.issueEnrichment;
      expect(issueConfig).toBeDefined();

      expect(config.pilotRepos).toEqual(["owner/pr-review-repo"]);
      expect(issueConfig?.allowlist).toEqual(["owner/issue-repo"]);
      expect(issueConfig?.allowlist).not.toContain("owner/pr-review-repo");
      expect(issueConfig?.repos?.["owner/issue-repo"]).toMatchObject({
        maxIssuesPerCycle: 3,
        maxCommentsPerCycle: 2
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports issue enrichment blockers without failing when the lane is disabled", () => {
    const disabled = buildIssueEnrichmentStatus({
      config: loadConfig(),
      canPostAsApp: false
    });

    expect(disabled).toMatchObject({
      ok: true,
      state: "disabled",
      separateAllowlist: true,
      allowlist: [],
      blockers: ["issue_enrichment_disabled", "issue_enrichment_allowlist_empty", "issue_enrichment_live_posting_disabled"]
    });

    const root = mkdtempSync(join(tmpdir(), "issue-enrichment-status-"));
    try {
      const configPath = join(root, "config.json");
      writeFileSync(configPath, `${JSON.stringify({
        issueEnrichment: {
          enabled: true,
          postIssueComment: true,
          allowlist: ["owner/issue-repo"]
        }
      })}\n`);

      const enabled = buildIssueEnrichmentStatus({
        config: loadConfig(configPath),
        canPostAsApp: false
      });

      expect(enabled.ok).toBe(false);
      expect(enabled.state).toBe("blocked");
      expect(enabled.blockers).toContain("github_app_credentials_required_for_live_issue_comments");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("renders a stable marker with head-specific state and suggestion-only text", () => {
    const files: PullFilePatch[] = [
      { filename: "src/worker.ts", status: "modified", additions: 10, deletions: 2 },
      { filename: "tests/worker-failure.test.ts", status: "modified", additions: 12, deletions: 1 }
    ];

    const first = buildEnrichmentComment({
      repo: "electricsheephq/evaos-code-review-bot",
      pull,
      files,
      suggestedLabels: ["bot", "release"],
      suggestedReviewers: ["runtime-owner"],
      validationSuggestions: ["Run release-status after launchd restart."],
      postIssueComment: true
    });
    const second = buildEnrichmentComment({
      repo: "electricsheephq/evaos-code-review-bot",
      pull: { ...pull, head: { ...pull.head, sha: HEAD_B } },
      files,
      suggestedLabels: ["bot", "release"],
      suggestedReviewers: ["runtime-owner"],
      validationSuggestions: ["Run release-status after launchd restart."],
      postIssueComment: true
    });
    const changedSuggestion = buildEnrichmentComment({
      repo: "electricsheephq/evaos-code-review-bot",
      pull,
      files,
      suggestedLabels: ["bot", "release"],
      suggestedReviewers: ["runtime-owner"],
      validationSuggestions: ["Run dashboard and release-status after launchd restart."],
      postIssueComment: true
    });

    expect(first.marker).toBe(buildEnrichmentMarker({ repo: "electricsheephq/evaos-code-review-bot", pullNumber: 77 }));
    expect(first.marker).toBe(second.marker);
    expect(first.body).toContain(`${ENRICHMENT_MARKER_PREFIX} repo=electricsheephq/evaos-code-review-bot pr=77 -->`);
    expect(first.body).toContain(`${ENRICHMENT_STATE_MARKER_PREFIX} version=1 repo=electricsheephq/evaos-code-review-bot pr=77 sha=${HEAD_A}`);
    expect(second.body).toContain(`sha=${HEAD_B}`);
    expect(first.body).toContain("Suggested labels: bot, release");
    expect(first.body).toContain("Suggested reviewers: runtime-owner, reviewer-one");
    expect(first.body).toContain("Related issues/PRs: #22");
    expect(first.body).toContain("No labels or reviewers were applied by this bot.");
    expect(first.body).not.toContain("ghp_123456789012345678901234");
    expect(extractStateHash(first.body)).not.toBe(extractStateHash(changedSuggestion.body));
  });

  it("posts only when enabled and App credentials are present", async () => {
    const calls: unknown[] = [];
    const comment = buildEnrichmentComment({
      repo: "owner/repo",
      pull: { ...pull, number: 5, head: { ...pull.head, sha: HEAD_A } },
      files: [],
      postIssueComment: true
    });

    const dryRun = await postEnrichmentComment({
      enabled: true,
      dryRun: true,
      github: {
        canPostAsApp: () => true,
        upsertIssueComment: async (input) => {
          calls.push(input);
          return { action: "created", id: 1 };
        }
      },
      repo: "owner/repo",
      pullNumber: 5,
      enrichment: comment
    });
    expect(dryRun).toEqual({ posted: false, reason: "dry_run" });

    const missingCreds = await postEnrichmentComment({
      enabled: true,
      dryRun: false,
      github: {
        canPostAsApp: () => false,
        upsertIssueComment: async () => {
          throw new Error("should not be called");
        }
      },
      repo: "owner/repo",
      pullNumber: 5,
      enrichment: comment
    });
    expect(missingCreds).toEqual({ posted: false, reason: "missing_app_credentials" });

    const posted = await postEnrichmentComment({
      enabled: true,
      dryRun: false,
      github: {
        canPostAsApp: () => true,
        upsertIssueComment: async (input) => {
          calls.push(input);
          return { action: "updated", id: 7, html_url: "https://github.test/comment/7" };
        }
      },
      repo: "owner/repo",
      pullNumber: 5,
      enrichment: comment
    });
    expect(posted).toEqual({ posted: true, action: "updated", id: 7, html_url: "https://github.test/comment/7" });
    expect(calls).toHaveLength(1);
  });

  it("records a redacted error when sticky enrichment posting fails", async () => {
    const evidenceDir = mkdtempSync(join(tmpdir(), "enrichment-error-"));
    try {
      const result = await postEnrichmentComment({
        enabled: true,
        dryRun: false,
        github: {
          canPostAsApp: () => true,
          upsertIssueComment: async () => {
            throw new Error("GitHub API 502 ghp_123456789012345678901234");
          }
        },
        repo: "owner/repo",
        pullNumber: 5,
        enrichment: buildEnrichmentComment({
          repo: "owner/repo",
          pull: { ...pull, number: 5, head: { ...pull.head, sha: HEAD_A } },
          files: [],
          postIssueComment: true
        }),
        evidenceDir
      });

      expect(result).toMatchObject({ posted: false, reason: "upsert_failed" });
      if (result.posted) throw new Error("expected failed enrichment post");
      expect(result.error).toContain("GitHub API 502");
      expect(result.error).not.toContain("ghp_123456789012345678901234");
      const errorPath = join(evidenceDir, "enrichment-comment-error.txt");
      expect(existsSync(errorPath)).toBe(true);
      expect(readFileSync(errorPath, "utf8")).not.toContain("ghp_123456789012345678901234");
    } finally {
      rmSync(evidenceDir, { recursive: true, force: true });
    }
  });

  it("renders sticky issue enrichment with suggestion-only text and redaction", () => {
    const issue: GitHubRelatedIssueOrPull = {
      number: 88,
      title: "Triage support escalation #22",
      state: "open",
      html_url: "https://github.test/electricsheephq/evaos-code-review-bot/issues/88",
      body: "Customer path missing validation evidence. ghp_123456789012345678901234",
      user: { login: "issue-author" },
      labels: [{ name: "support" }],
      milestone: { title: "v0.2" }
    };

    const comment = buildIssueEnrichmentComment({
      repo: "electricsheephq/evaos-code-review-bot",
      issue,
      suggestedLabels: ["triage", "support"],
      suggestedOwners: ["runtime-owner"],
      validationSuggestions: ["Confirm owner and acceptance criteria before implementation."],
      postIssueComment: true
    });

    expect(comment.marker).toBe(buildIssueEnrichmentMarker({ repo: "electricsheephq/evaos-code-review-bot", issueNumber: 88 }));
    expect(comment.body).toContain(`${ENRICHMENT_MARKER_PREFIX} repo=electricsheephq/evaos-code-review-bot issue=88 -->`);
    expect(comment.body).toContain(`${ENRICHMENT_STATE_MARKER_PREFIX} version=1 repo=electricsheephq/evaos-code-review-bot issue=88 state=open`);
    expect(comment.body).toMatch(/^<!-- evaos-code-review-bot:enrichment repo=electricsheephq\/evaos-code-review-bot issue=88 -->\n<!-- evaos-code-review-bot:enrichment-state version=1 repo=electricsheephq\/evaos-code-review-bot issue=88 state=open hash=[0-9a-f]{64} -->\n## evaOS issue enrichment/);
    expect(comment.body).toContain("Issue: electricsheephq/evaos-code-review-bot#88 - Triage support escalation #22");
    expect(comment.body).toContain("Related issues/PRs: #22");
    expect(comment.body).toContain("Existing labels: support");
    expect(comment.body).toContain("Suggested labels: triage");
    expect(comment.body).toContain("Suggested owners: runtime-owner");
    expect(comment.body).toContain("No labels, owners, reviewers, or roadmap fields were changed by this bot.");
    expect(comment.body).not.toContain("ghp_123456789012345678901234");
  });

  it("rejects stale or pull-request-shaped issues at the comment builder boundary", () => {
    const closedIssue: GitHubRelatedIssueOrPull = {
      number: 90,
      title: "Closed",
      state: "closed",
      body: "Done"
    };
    const pullRequestIssue: GitHubRelatedIssueOrPull = {
      number: 91,
      title: "PR shaped issue",
      state: "open",
      pull_request: {},
      body: "This is a pull request record."
    };
    const closedPullRequestIssue: GitHubRelatedIssueOrPull = {
      number: 92,
      title: "Closed PR shaped issue",
      state: "closed",
      pull_request: {},
      body: "This is a closed pull request record."
    };

    expect(() => buildIssueEnrichmentComment({ repo: "electricsheephq/evaos-code-review-bot", issue: closedIssue })).toThrow("stale_issue_closed");
    expect(() => buildIssueEnrichmentComment({ repo: "electricsheephq/evaos-code-review-bot", issue: pullRequestIssue })).toThrow("issue_is_pull_request");
    expect(() => buildIssueEnrichmentComment({ repo: "electricsheephq/evaos-code-review-bot", issue: closedPullRequestIssue })).toThrow("issue_is_pull_request");
  });

  it("includes issue URL on successful issue enrichment dry runs", () => {
    const issue: GitHubRelatedIssueOrPull = {
      number: 92,
      title: "Open issue",
      state: "open",
      html_url: "https://github.test/electricsheephq/evaos-code-review-bot/issues/92",
      body: "Acceptance criteria present."
    };

    const output = buildIssueEnrichmentDryRunOutput({
      repo: "electricsheephq/evaos-code-review-bot",
      issue,
      maxRelatedRefs: 8,
      maxSuggestions: 8
    });

    expect(output).toMatchObject({
      ok: true,
      skipped: false,
      repo: "electricsheephq/evaos-code-review-bot",
      issueNumber: 92,
      state: "open",
      url: "https://github.test/electricsheephq/evaos-code-review-bot/issues/92"
    });
  });

  it("skips stale closed issues for issue enrichment dry runs", () => {
    const issue: GitHubRelatedIssueOrPull = {
      number: 89,
      title: "Already handled",
      state: "closed",
      html_url: "https://github.test/electricsheephq/evaos-code-review-bot/issues/89",
      body: "Done"
    };

    const output = buildIssueEnrichmentDryRunOutput({
      repo: "electricsheephq/evaos-code-review-bot",
      issue,
      maxRelatedRefs: 8,
      maxSuggestions: 8
    });

    expect(output).toMatchObject({
      ok: true,
      skipped: true,
      reason: "stale_issue_closed",
      repo: "electricsheephq/evaos-code-review-bot",
      issueNumber: 89,
      state: "closed"
    });
    expect(JSON.stringify(output)).not.toContain("body");
  });

  it("skips pull-request-shaped issues for issue enrichment dry runs", () => {
    const issue: GitHubRelatedIssueOrPull = {
      number: 93,
      title: "Actually a pull request",
      state: "open",
      html_url: "https://github.test/electricsheephq/evaos-code-review-bot/pull/93",
      pull_request: {},
      body: "PR payload"
    };

    const output = buildIssueEnrichmentDryRunOutput({
      repo: "electricsheephq/evaos-code-review-bot",
      issue,
      maxRelatedRefs: 8,
      maxSuggestions: 8
    });

    expect(output).toMatchObject({
      ok: true,
      skipped: true,
      reason: "issue_is_pull_request",
      repo: "electricsheephq/evaos-code-review-bot",
      issueNumber: 93,
      state: "open"
    });
    expect(JSON.stringify(output)).not.toContain("body");
  });

  it("normalizes issue state casing without treating unknown states as closed", () => {
    const uppercaseOpen: GitHubRelatedIssueOrPull = {
      number: 94,
      title: "Uppercase open issue",
      state: "OPEN",
      body: "Acceptance criteria present."
    };
    const unknownState: GitHubRelatedIssueOrPull = {
      number: 95,
      title: "Unknown state issue",
      state: "needs-triage",
      body: "Acceptance criteria present."
    };

    const openOutput = buildIssueEnrichmentDryRunOutput({
      repo: "electricsheephq/evaos-code-review-bot",
      issue: uppercaseOpen,
      maxRelatedRefs: 8,
      maxSuggestions: 8
    });
    const unknownOutput = buildIssueEnrichmentDryRunOutput({
      repo: "electricsheephq/evaos-code-review-bot",
      issue: unknownState,
      maxRelatedRefs: 8,
      maxSuggestions: 8
    });

    expect(openOutput).toMatchObject({ skipped: false, state: "open" });
    expect(unknownOutput).toMatchObject({ skipped: false, state: "unknown" });
  });

  it("caps issue enrichment related refs, labels, and owners", () => {
    const issue: GitHubRelatedIssueOrPull = {
      number: 96,
      title: "Runtime regression #1 #2 #3",
      state: "open",
      body: "Bug docs test support references #4 #5 #6.",
      labels: [{ name: "bug" }]
    };

    const comment = buildIssueEnrichmentComment({
      repo: "electricsheephq/evaos-code-review-bot",
      issue,
      suggestedLabels: ["Bug", "runtime", "Runtime", "docs", "tests"],
      suggestedOwners: ["owner-a", "owner-b", "owner-c", "owner-d"],
      maxRelatedRefs: 2,
      maxSuggestions: 3
    });

    const relatedRefsLine = comment.body.split("\n").find((line) => line.startsWith("Related issues/PRs:"));
    expect(relatedRefsLine).toBe("Related issues/PRs: #1, #2.");
    expect(relatedRefsLine).not.toContain("#3");
    expect(comment.body).toContain("Existing labels: bug.");
    expect(comment.body).toContain("Suggested labels: runtime, docs, tests.");
    expect(comment.body).not.toContain("Suggested labels: runtime, Runtime");
    expect(comment.body).not.toContain("Suggested labels: Bug");
    expect(comment.body).toContain("Suggested owners: owner-a, owner-b, owner-c.");
    expect(comment.body).not.toContain("owner-d");
  });

  it("dry-run scans only the issue-enrichment allowlist and skips closed issues and PR-shaped issues", async () => {
    const root = mkdtempSync(join(tmpdir(), "issue-enrichment-scan-"));
    try {
      const configPath = join(root, "config.json");
      writeFileSync(configPath, `${JSON.stringify({
        pilotRepos: ["owner/pr-review-repo"],
        issueEnrichment: {
          enabled: false,
          postIssueComment: true,
          allowlist: ["owner/issue-repo"],
          maxIssuesPerCycle: 3,
          maxCommentsPerCycle: 1,
          maxIssuesPerBurst: 10,
          processExistingOpenIssuesOnActivation: false
        }
      })}\n`);
      const reposScanned: string[] = [];

      const scan = await collectIssueEnrichmentScan({
        config: loadConfig(configPath),
        dryRun: true,
        includeExisting: true,
        checkedAt: "2026-07-03T00:00:00.000Z",
        reader: {
          listIssuesForEnrichment: async (repo) => {
            reposScanned.push(repo);
            return [
              { number: 10, title: "New issue", state: "open", body: "Acceptance criteria and owner present." },
              { number: 11, title: "Closed issue", state: "closed", body: "Done." },
              { number: 12, title: "PR issue", state: "open", pull_request: {}, body: "Pull request record." },
              { number: 13, title: "Another new issue", state: "open", body: "Acceptance criteria and owner present." }
            ];
          }
        }
      });

      expect(reposScanned).toEqual(["owner/issue-repo"]);
      expect(reposScanned).not.toContain("owner/pr-review-repo");
      expect(scan.ok).toBe(true);
      expect(scan.summary).toMatchObject({
        reposScanned: 1,
        issuesSeen: 4,
        eligible: 2,
        skipped: 2,
        wouldComment: 1,
        deferred: 1
      });
      expect(scan.items.find((item) => item.issueNumber === 11)).toMatchObject({ action: "skipped", reason: "stale_issue_closed" });
      expect(scan.items.find((item) => item.issueNumber === 12)).toMatchObject({ action: "skipped", reason: "issue_is_pull_request" });
      expect(scan.items.find((item) => item.issueNumber === 13)).toMatchObject({ action: "deferred", reason: "repo_max_comments_per_cycle" });
      expect(scan.items.find((item) => item.issueNumber === 13)).toMatchObject({
        nextEligibleAt: "2026-07-03T01:00:00.000Z"
      });
      expect(JSON.stringify(scan)).not.toMatch(/ghp_|BEGIN RSA|PRIVATE KEY/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not call the reader for explicit repos outside the issue-enrichment allowlist", async () => {
    const root = mkdtempSync(join(tmpdir(), "issue-enrichment-outside-allowlist-"));
    try {
      const configPath = join(root, "config.json");
      writeFileSync(configPath, `${JSON.stringify({
        issueEnrichment: {
          enabled: false,
          postIssueComment: false,
          allowlist: ["owner/allowed-repo"]
        }
      })}\n`);
      let readerCalls = 0;

      const scan = await collectIssueEnrichmentScan({
        config: loadConfig(configPath),
        dryRun: true,
        repo: "owner/not-allowed",
        reader: {
          listIssuesForEnrichment: async () => {
            readerCalls += 1;
            return [];
          }
        }
      });

      expect(readerCalls).toBe(0);
      expect(scan.summary).toMatchObject({ reposScanned: 0, reposSkipped: 1 });
      expect(scan.repos[0]).toMatchObject({
        repo: "owner/not-allowed",
        allowed: false,
        skipReason: "not_issue_enrichment_allowlisted"
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not call the reader for a disabled per-repo issue-enrichment override", async () => {
    const root = mkdtempSync(join(tmpdir(), "issue-enrichment-disabled-repo-"));
    try {
      const configPath = join(root, "config.json");
      writeFileSync(configPath, `${JSON.stringify({
        issueEnrichment: {
          enabled: false,
          postIssueComment: false,
          allowlist: ["owner/disabled-repo"],
          repos: {
            "owner/disabled-repo": {
              enabled: false
            }
          }
        }
      })}\n`);
      let readerCalls = 0;

      const scan = await collectIssueEnrichmentScan({
        config: loadConfig(configPath),
        dryRun: true,
        reader: {
          listIssuesForEnrichment: async () => {
            readerCalls += 1;
            return [];
          }
        }
      });

      expect(readerCalls).toBe(0);
      expect(scan.summary).toMatchObject({ reposScanned: 0, reposSkipped: 1 });
      expect(scan.repos[0]).toMatchObject({
        repo: "owner/disabled-repo",
        allowed: false,
        skipReason: "issue_enrichment_repo_disabled"
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("defers large issue bursts instead of enriching every issue in a milestone filing wave", async () => {
    const root = mkdtempSync(join(tmpdir(), "issue-enrichment-burst-"));
    try {
      const configPath = join(root, "config.json");
      writeFileSync(configPath, `${JSON.stringify({
        issueEnrichment: {
          enabled: true,
          postIssueComment: false,
          allowlist: ["owner/issue-repo"],
          maxIssuesPerCycle: 5,
          maxCommentsPerCycle: 2,
          maxIssuesPerBurst: 2
        }
      })}\n`);

      const scan = await collectIssueEnrichmentScan({
        config: loadConfig(configPath),
        dryRun: true,
        includeExisting: true,
        checkedAt: "2026-07-03T00:00:00.000Z",
        reader: {
          listIssuesForEnrichment: async () => [
            { number: 20, title: "Issue 20", state: "open", body: "Acceptance criteria and owner present." },
            { number: 21, title: "Issue 21", state: "open", body: "Acceptance criteria and owner present." },
            { number: 22, title: "Issue 22", state: "open", body: "Acceptance criteria and owner present." }
          ]
        }
      });

      expect(scan.ok).toBe(true);
      expect(scan.summary).toMatchObject({
        issuesSeen: 3,
        eligible: 3,
        wouldEnrich: 0,
        wouldComment: 0,
        deferred: 3
      });
      expect(scan.items.every((item) => item.action === "deferred" && item.reason === "burst_threshold_exceeded")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses the burst window and enough pages to prove configured burst thresholds", async () => {
    const root = mkdtempSync(join(tmpdir(), "issue-enrichment-burst-window-"));
    try {
      const configPath = join(root, "config.json");
      writeFileSync(configPath, `${JSON.stringify({
        issueEnrichment: {
          enabled: true,
          postIssueComment: false,
          allowlist: ["owner/issue-repo"],
          maxIssuesPerCycle: 25,
          maxCommentsPerCycle: 0,
          cooldownMs: 600_000,
          burstWindowMs: 3_600_000,
          maxIssuesPerBurst: 150,
          lookbackMs: 300_000,
          processExistingOpenIssuesOnActivation: false
        }
      })}\n`);
      const calls: Array<{ repo: string; since?: string; pageLimit?: number }> = [];

      const scan = await collectIssueEnrichmentScan({
        config: loadConfig(configPath),
        dryRun: true,
        checkedAt: "2026-07-03T12:00:00.000Z",
        reader: {
          listIssuesForEnrichment: async (repo, options) => {
            calls.push({ repo, since: options?.since, pageLimit: options?.pageLimit });
            return [];
          }
        }
      });

      expect(scan.ok).toBe(true);
      expect(calls).toEqual([{
        repo: "owner/issue-repo",
        since: "2026-07-03T11:00:00.000Z",
        pageLimit: 2
      }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function extractStateHash(body: string): string {
  const match = body.match(/hash=([0-9a-f]{64})/i);
  if (!match) throw new Error(`missing state hash in body:\n${body}`);
  return match[1]!;
}
