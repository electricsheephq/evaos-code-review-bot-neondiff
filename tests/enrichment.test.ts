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
import { buildIssueEnrichmentStatus, collectIssueEnrichmentScan, resolveIssueEnrichmentRepoPolicy, runIssueEnrichmentCycle } from "../src/issue-enrichment.js";
import { ReviewStateStore } from "../src/state.js";
import type { PullFilePatch, PullRequestSummary } from "../src/types.js";

const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);

const pull: PullRequestSummary = {
  number: 77,
  title: "Harden review queue #22",
  draft: false,
  body: "Closes #22. ghp_fake_token",
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
      allowedLabels: [],
      allowedReviewers: [],
      maxIssuesPerCycle: 5,
      maxCommentsPerCycle: 1,
      globalMaxIssuesPerCycle: 5,
      globalMaxCommentsPerCycle: 1,
      maxActiveRuns: 1,
      leaseTtlMs: 1_200_000,
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
          allowedLabels: ["issue-label"],
          allowedReviewers: ["issue-reviewer"],
          maxIssuesPerCycle: 2,
          maxCommentsPerCycle: 1,
          globalMaxIssuesPerCycle: 4,
          globalMaxCommentsPerCycle: 1,
          maxActiveRuns: 1,
          leaseTtlMs: 1_200_000,
          cooldownMs: 3_600_000,
          burstWindowMs: 3_600_000,
          maxIssuesPerBurst: 8,
          lookbackMs: 600_000,
          processExistingOpenIssuesOnActivation: false,
          repos: {
            "owner/issue-repo": {
              allowedLabels: ["repo-label"],
              allowedReviewers: ["repo-reviewer"],
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
      expect(issueConfig?.allowedLabels).toEqual(["issue-label"]);
      expect(issueConfig?.allowedReviewers).toEqual(["issue-reviewer"]);
      expect(issueConfig).toMatchObject({
        globalMaxIssuesPerCycle: 4,
        globalMaxCommentsPerCycle: 1,
        maxActiveRuns: 1,
        leaseTtlMs: 1_200_000
      });
      expect(issueConfig?.repos?.["owner/issue-repo"]).toMatchObject({
        allowedLabels: ["repo-label"],
        allowedReviewers: ["repo-reviewer"],
        maxIssuesPerCycle: 3,
        maxCommentsPerCycle: 2
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("backfills issue enrichment global caps for legacy partial configs", () => {
    const root = mkdtempSync(join(tmpdir(), "issue-enrichment-legacy-config-"));
    try {
      const configPath = join(root, "config.json");
      writeFileSync(configPath, `${JSON.stringify({
        issueEnrichment: {
          enabled: false,
          postIssueComment: false,
          allowlist: ["owner/issue-repo"],
          maxIssuesPerCycle: 2,
          maxCommentsPerCycle: 0,
          cooldownMs: 3_600_000,
          burstWindowMs: 3_600_000,
          maxIssuesPerBurst: 8,
          lookbackMs: 600_000,
          processExistingOpenIssuesOnActivation: false
        }
      })}\n`);

      expect(loadConfig(configPath).issueEnrichment).toMatchObject({
        maxIssuesPerCycle: 2,
        maxCommentsPerCycle: 0,
        globalMaxIssuesPerCycle: 5,
        globalMaxCommentsPerCycle: 1,
        maxActiveRuns: 1,
        leaseTtlMs: 1_200_000
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects issue enrichment global caps that could post more comments than processed issues", () => {
    const root = mkdtempSync(join(tmpdir(), "issue-enrichment-invalid-global-caps-"));
    try {
      const configPath = join(root, "config.json");
      writeFileSync(configPath, `${JSON.stringify({
        issueEnrichment: {
          enabled: false,
          postIssueComment: false,
          allowlist: ["owner/issue-repo"],
          maxIssuesPerCycle: 2,
          maxCommentsPerCycle: 1,
          globalMaxIssuesPerCycle: 1,
          globalMaxCommentsPerCycle: 2
        }
      })}\n`);

      expect(() => loadConfig(configPath)).toThrow(/globalMaxCommentsPerCycle must be <= .*globalMaxIssuesPerCycle/);
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
    expect(first.body).not.toContain("ghp_fake_token");
    expect(extractStateHash(first.body)).not.toBe(extractStateHash(changedSuggestion.body));
  });

  it("strips uncalibrated confidence claims from PR enrichment comments", () => {
    const comment = buildEnrichmentComment({
      repo: "electricsheephq/evaos-code-review-bot",
      pull: {
        ...pull,
        title: "Review confidence 95%",
        body: "Closes #22."
      },
      files: [],
      validationSuggestions: [
        "Run focused tests with confidence score of 0.95.",
        "Proof status: confidence 0.95."
      ],
      postIssueComment: true
    });

    expect(comment.body).toContain("Review [confidence not calibrated]");
    expect(comment.body).toContain("Run focused tests with [confidence not calibrated].");
    expect(comment.body).toContain("Proof status: [confidence not calibrated].");
    expect(comment.body).not.toMatch(/\b\d+(?:\.\d+)?\s*%/);
    expect(comment.body).not.toContain("0.95");
  });

  it("keeps inline confidence replacement text whole when sanitized titles lengthen", () => {
    const comment = buildEnrichmentComment({
      repo: "electricsheephq/evaos-code-review-bot",
      pull: {
        ...pull,
        title: `${"a".repeat(176)} Confidence: 95%.`,
        body: "Closes #22."
      },
      files: [],
      postIssueComment: true
    });

    const title = comment.body.match(new RegExp(`PR: electricsheephq/evaos-code-review-bot#${pull.number} - (.+)`))?.[1] ?? "";
    expect(title).toHaveLength(200);
    expect(comment.body).not.toContain("95%");
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
            throw new Error("GitHub API 502 ghp_fake_token");
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
      expect(result.error).not.toContain("ghp_fake_token");
      const errorPath = join(evidenceDir, "enrichment-comment-error.txt");
      expect(existsSync(errorPath)).toBe(true);
      expect(readFileSync(errorPath, "utf8")).not.toContain("ghp_fake_token");
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
      body: "Customer path missing validation evidence. ghp_fake_token",
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
    expect(comment.body).not.toContain("ghp_fake_token");
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

  it("filters issue label and owner suggestions through issue-enrichment allowlists", () => {
    const issue: GitHubRelatedIssueOrPull = {
      number: 97,
      title: "Bug docs support escalation #22",
      state: "open",
      body: "Bug docs tests support failure with acceptance criteria and owner present.",
      labels: [{ name: "support" }]
    };

    const comment = buildIssueEnrichmentComment({
      repo: "electricsheephq/evaos-code-review-bot",
      issue,
      suggestedLabels: ["triage", "security", "docs"],
      suggestedOwners: ["pr-reviewer", "issue-owner"],
      allowedLabels: ["security"],
      allowedOwners: ["issue-owner"],
      maxSuggestions: 5
    });

    const suggestedLabelsLine = comment.body.split("\n").find((line) => line.startsWith("Suggested labels:"));
    const suggestedOwnersLine = comment.body.split("\n").find((line) => line.startsWith("Suggested owners:"));
    expect(suggestedLabelsLine).toBe("Suggested labels: security.");
    expect(suggestedLabelsLine).not.toContain("triage");
    expect(suggestedLabelsLine).not.toContain("docs");
    expect(suggestedLabelsLine).not.toContain("bug");
    expect(suggestedOwnersLine).toBe("Suggested owners: issue-owner.");
    expect(suggestedOwnersLine).not.toContain("pr-reviewer");
  });

  it("treats empty issue suggestion allowlists as unrestricted", () => {
    const issue: GitHubRelatedIssueOrPull = {
      number: 197,
      title: "Bug docs test support escalation #22",
      state: "open",
      body: "Bug docs tests support failure with acceptance criteria and owner present.",
      labels: [{ name: "support" }]
    };

    const comment = buildIssueEnrichmentComment({
      repo: "electricsheephq/evaos-code-review-bot",
      issue,
      suggestedOwners: ["runtime-owner"],
      allowedLabels: [],
      allowedOwners: [],
      maxSuggestions: 5
    });

    const suggestedLabelsLine = comment.body.split("\n").find((line) => line.startsWith("Suggested labels:"));
    const suggestedOwnersLine = comment.body.split("\n").find((line) => line.startsWith("Suggested owners:"));
    expect(suggestedLabelsLine).toBe("Suggested labels: bug, docs, tests.");
    expect(suggestedOwnersLine).toBe("Suggested owners: runtime-owner.");
  });

  it("dedupes issue owner suggestions case-insensitively", () => {
    const issue: GitHubRelatedIssueOrPull = {
      number: 198,
      title: "Runtime owner handoff",
      state: "open",
      body: "Acceptance criteria and owner present."
    };

    const comment = buildIssueEnrichmentComment({
      repo: "electricsheephq/evaos-code-review-bot",
      issue,
      suggestedOwners: ["Runtime-Owner", "runtime-owner", "incident-owner"],
      allowedOwners: ["runtime-owner", "incident-owner"],
      maxSuggestions: 5
    });

    const suggestedOwnersLine = comment.body.split("\n").find((line) => line.startsWith("Suggested owners:"));
    expect(suggestedOwnersLine).toBe("Suggested owners: Runtime-Owner, incident-owner.");
  });

  it("falls back to global issue suggestion allowlists for empty per-repo overrides", () => {
    const config = loadConfig();
    config.issueEnrichment = {
      ...config.issueEnrichment!,
      enabled: true,
      allowlist: ["owner/issue-repo"],
      allowedLabels: ["docs"],
      allowedReviewers: ["global-owner"],
      repos: {
        "owner/issue-repo": {
          allowedLabels: [],
          allowedReviewers: []
        }
      }
    };

    const policy = resolveIssueEnrichmentRepoPolicy(config.issueEnrichment, "owner/issue-repo");
    expect(policy.allowed).toBe(true);
    expect(policy.suggestions.allowedLabels).toEqual(["docs"]);
    expect(policy.suggestions.allowedReviewers).toEqual(["global-owner"]);
  });

  it("infers issue label suggestions before applying allowlists without inventing owners", () => {
    const issue: GitHubRelatedIssueOrPull = {
      number: 98,
      title: "Docs runbook gap #22",
      state: "open",
      body: "Acceptance criteria and owner are present. Update the runbook docs before rollout.",
      labels: [{ name: "support" }]
    };

    const comment = buildIssueEnrichmentComment({
      repo: "electricsheephq/evaos-code-review-bot",
      issue,
      allowedLabels: ["docs", "security"],
      allowedOwners: ["issue-owner", "incident-reviewer"],
      maxSuggestions: 5
    });

    const suggestedLabelsLine = comment.body.split("\n").find((line) => line.startsWith("Suggested labels:"));
    const suggestedOwnersLine = comment.body.split("\n").find((line) => line.startsWith("Suggested owners:"));
    expect(suggestedLabelsLine).toBe("Suggested labels: docs.");
    expect(suggestedLabelsLine).not.toContain("security");
    expect(suggestedOwnersLine).toBe("Suggested owners: none.");
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
      expect(scan.recommendedActions).toContain(
        "standalone issue-enrichment scans are stateless; live cycles exclude already-processed issue rows from cap accounting"
      );
      expect(scan.recommendedActions).toContain(
        "inspect deferred issue-enrichment rows before throttle changes; summary.eligible includes cap- and burst-deferred issues, while wouldEnrich/wouldComment show current-cycle throughput"
      );
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
        pageLimit: 10
      }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("requests open issue-only pages so PR-heavy repositories cannot starve issue enrichment", async () => {
    const root = mkdtempSync(join(tmpdir(), "issue-enrichment-issue-only-scan-"));
    try {
      const configPath = join(root, "config.json");
      writeFileSync(configPath, `${JSON.stringify({
        issueEnrichment: {
          enabled: true,
          postIssueComment: false,
          allowlist: ["owner/pr-heavy-repo"],
          maxIssuesPerCycle: 3,
          maxCommentsPerCycle: 0,
          cooldownMs: 600_000,
          burstWindowMs: 3_600_000,
          maxIssuesPerBurst: 10,
          lookbackMs: 300_000,
          processExistingOpenIssuesOnActivation: false
        }
      })}\n`);
      const calls: Array<{
        repo: string;
        state?: string;
        pageLimit?: number;
        excludePullRequests?: boolean;
        minIssueResults?: number;
      }> = [];

      const scan = await collectIssueEnrichmentScan({
        config: loadConfig(configPath),
        dryRun: true,
        checkedAt: "2026-07-03T12:00:00.000Z",
        reader: {
          listIssuesForEnrichment: async (repo, options) => {
            calls.push({
              repo,
              state: options?.state,
              pageLimit: options?.pageLimit,
              excludePullRequests: options?.excludePullRequests,
              minIssueResults: options?.minIssueResults
            });
            return [
              {
                number: 101,
                title: "Real issue behind a PR-heavy first page",
                state: "open",
                updated_at: "2026-07-03T11:59:00.000Z",
                body: "Acceptance criteria and owner present."
              }
            ];
          }
        }
      });

      expect(scan.ok).toBe(true);
      expect(calls).toEqual([{
        repo: "owner/pr-heavy-repo",
        state: "open",
        pageLimit: 10,
        excludePullRequests: true,
        minIssueResults: 11
      }]);
      expect(scan.summary).toMatchObject({ issuesSeen: 1, eligible: 1, skipped: 0 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("omits issue scan since only for explicit backfill modes", async () => {
    const root = mkdtempSync(join(tmpdir(), "issue-enrichment-backfill-"));
    try {
      const configPath = join(root, "config.json");
      writeFileSync(configPath, `${JSON.stringify({
        issueEnrichment: {
          enabled: true,
          postIssueComment: false,
          allowlist: ["owner/default-repo", "owner/backfill-repo"],
          maxIssuesPerCycle: 5,
          maxCommentsPerCycle: 0,
          lookbackMs: 600_000,
          burstWindowMs: 3_600_000,
          processExistingOpenIssuesOnActivation: false,
          repos: {
            "owner/backfill-repo": {
              processExistingOpenIssuesOnActivation: true
            }
          }
        }
      })}\n`);
      const calls: Array<{ repo: string; since?: string }> = [];

      const normal = await collectIssueEnrichmentScan({
        config: loadConfig(configPath),
        dryRun: true,
        repo: "owner/default-repo",
        checkedAt: "2026-07-03T12:00:00.000Z",
        reader: {
          listIssuesForEnrichment: async (repo, options) => {
            calls.push({ repo, since: options?.since });
            return [];
          }
        }
      });
      const explicitBackfill = await collectIssueEnrichmentScan({
        config: loadConfig(configPath),
        dryRun: true,
        repo: "owner/default-repo",
        includeExisting: true,
        checkedAt: "2026-07-03T12:00:00.000Z",
        reader: {
          listIssuesForEnrichment: async (repo, options) => {
            calls.push({ repo, since: options?.since });
            return [];
          }
        }
      });
      const overrideBackfill = await collectIssueEnrichmentScan({
        config: loadConfig(configPath),
        dryRun: true,
        repo: "owner/backfill-repo",
        checkedAt: "2026-07-03T12:00:00.000Z",
        reader: {
          listIssuesForEnrichment: async (repo, options) => {
            calls.push({ repo, since: options?.since });
            return [];
          }
        }
      });

      expect(normal.ok).toBe(true);
      expect(explicitBackfill.ok).toBe(true);
      expect(overrideBackfill.ok).toBe(true);
      expect(calls).toEqual([
        { repo: "owner/default-repo", since: "2026-07-03T11:00:00.000Z" },
        { repo: "owner/default-repo", since: undefined },
        { repo: "owner/backfill-repo", since: undefined }
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("applies per-repo issue-enrichment throttles to defer bursts and comments", async () => {
    const root = mkdtempSync(join(tmpdir(), "issue-enrichment-repo-throttle-"));
    try {
      const configPath = join(root, "config.json");
      writeFileSync(configPath, `${JSON.stringify({
        issueEnrichment: {
          enabled: true,
          postIssueComment: true,
          allowlist: ["owner/comment-capped-repo", "owner/burst-capped-repo"],
          maxIssuesPerCycle: 10,
          maxCommentsPerCycle: 10,
          maxIssuesPerBurst: 10,
          cooldownMs: 3_600_000,
          repos: {
            "owner/comment-capped-repo": {
              maxIssuesPerCycle: 2,
              maxCommentsPerCycle: 1,
              cooldownMs: 120_000
            },
            "owner/burst-capped-repo": {
              maxIssuesPerBurst: 1,
              cooldownMs: 300_000
            }
          }
        }
      })}\n`);

      const scan = await collectIssueEnrichmentScan({
        config: loadConfig(configPath),
        dryRun: true,
        includeExisting: true,
        checkedAt: "2026-07-03T12:00:00.000Z",
        reader: {
          listIssuesForEnrichment: async (repo) => [
            { number: repo.endsWith("comment-capped-repo") ? 101 : 201, title: "Issue one", state: "open", body: "Acceptance criteria and owner present." },
            { number: repo.endsWith("comment-capped-repo") ? 102 : 202, title: "Issue two", state: "open", body: "Acceptance criteria and owner present." }
          ]
        }
      });

      expect(scan.ok).toBe(true);
      expect(scan.repos.find((repo) => repo.repo === "owner/comment-capped-repo")?.throttle).toMatchObject({
        maxIssuesPerCycle: 2,
        maxCommentsPerCycle: 1,
        cooldownMs: 120_000
      });
      expect(scan.items.find((item) => item.issueNumber === 101)).toMatchObject({ action: "would_comment", reason: "eligible" });
      expect(scan.items.find((item) => item.issueNumber === 102)).toMatchObject({
        action: "deferred",
        reason: "repo_max_comments_per_cycle",
        nextEligibleAt: "2026-07-03T12:02:00.000Z"
      });
      expect(scan.repos.find((repo) => repo.repo === "owner/burst-capped-repo")?.throttle).toMatchObject({
        maxIssuesPerBurst: 1,
        cooldownMs: 300_000
      });
      expect(scan.items.filter((item) => item.repo === "owner/burst-capped-repo")).toEqual([
        expect.objectContaining({
          issueNumber: 201,
          action: "deferred",
          reason: "burst_threshold_exceeded",
          nextEligibleAt: "2026-07-03T12:05:00.000Z"
        }),
        expect.objectContaining({
          issueNumber: 202,
          action: "deferred",
          reason: "burst_threshold_exceeded",
          nextEligibleAt: "2026-07-03T12:05:00.000Z"
        })
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("applies global issue-enrichment caps across allowlisted repos", async () => {
    const root = mkdtempSync(join(tmpdir(), "issue-enrichment-global-caps-"));
    try {
      const configPath = join(root, "config.json");
      writeFileSync(configPath, `${JSON.stringify({
        issueEnrichment: {
          enabled: true,
          postIssueComment: true,
          allowlist: ["owner/repo-a", "owner/repo-b", "owner/repo-c"],
          maxIssuesPerCycle: 10,
          maxCommentsPerCycle: 10,
          globalMaxIssuesPerCycle: 3,
          globalMaxCommentsPerCycle: 1,
          cooldownMs: 120_000,
          maxIssuesPerBurst: 10,
          processExistingOpenIssuesOnActivation: true
        }
      })}\n`);

      const scan = await collectIssueEnrichmentScan({
        config: loadConfig(configPath),
        dryRun: true,
        includeExisting: true,
        checkedAt: "2026-07-03T04:00:00.000Z",
        reader: {
          listIssuesForEnrichment: async (repo) => [
            { number: repo.endsWith("repo-a") ? 101 : repo.endsWith("repo-b") ? 201 : 301, title: "Issue one", state: "open", body: "Acceptance criteria and owner present." },
            { number: repo.endsWith("repo-a") ? 102 : repo.endsWith("repo-b") ? 202 : 302, title: "Issue two", state: "open", body: "Acceptance criteria and owner present." }
          ]
        }
      });

      expect(scan.ok).toBe(true);
      expect(scan.status.globalLimits).toMatchObject({
        globalMaxIssuesPerCycle: 3,
        globalMaxCommentsPerCycle: 1,
        maxActiveRuns: 1,
        leaseTtlMs: 1_200_000
      });
      expect(scan.summary).toMatchObject({
        issuesSeen: 6,
        eligible: 6,
        wouldComment: 1,
        deferred: 5
      });
      expect(scan.items.filter((item) => item.action === "would_comment")).toEqual([
        expect.objectContaining({ repo: "owner/repo-a", issueNumber: 101, reason: "eligible" })
      ]);
      expect(scan.items.find((item) => item.issueNumber === 102)).toMatchObject({
        action: "deferred",
        reason: "global_max_comments_per_cycle",
        nextEligibleAt: "2026-07-03T04:02:00.000Z"
      });
      expect(scan.items.find((item) => item.issueNumber === 201)).toMatchObject({
        action: "deferred",
        reason: "global_max_comments_per_cycle",
        nextEligibleAt: "2026-07-03T04:02:00.000Z"
      });
      expect(scan.items.find((item) => item.issueNumber === 202)).toMatchObject({
        action: "deferred",
        reason: "global_max_issues_per_cycle",
        nextEligibleAt: "2026-07-03T04:02:00.000Z"
      });
      expect(scan.items.filter((item) => item.reason === "global_max_issues_per_cycle")).toHaveLength(3);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses the global cooldown floor for issue-enrichment global deferrals", async () => {
    const root = mkdtempSync(join(tmpdir(), "issue-enrichment-global-cooldown-"));
    try {
      const configPath = join(root, "config.json");
      writeFileSync(configPath, `${JSON.stringify({
        issueEnrichment: {
          enabled: true,
          postIssueComment: true,
          allowlist: ["owner/repo-a", "owner/repo-b"],
          maxIssuesPerCycle: 10,
          maxCommentsPerCycle: 10,
          globalMaxIssuesPerCycle: 1,
          globalMaxCommentsPerCycle: 1,
          cooldownMs: 600_000,
          maxIssuesPerBurst: 10,
          processExistingOpenIssuesOnActivation: true,
          repos: {
            "owner/repo-a": {
              cooldownMs: 60_000
            }
          }
        }
      })}\n`);

      const scan = await collectIssueEnrichmentScan({
        config: loadConfig(configPath),
        dryRun: true,
        includeExisting: true,
        checkedAt: "2026-07-03T04:00:00.000Z",
        reader: {
          listIssuesForEnrichment: async (repo) => [
            { number: repo.endsWith("repo-a") ? 101 : 201, title: "Issue one", state: "open", body: "Acceptance criteria and owner present." },
            { number: repo.endsWith("repo-a") ? 102 : 202, title: "Issue two", state: "open", body: "Acceptance criteria and owner present." }
          ]
        }
      });

      expect(scan.ok).toBe(true);
      expect(scan.items.find((item) => item.repo === "owner/repo-a" && item.issueNumber === 101)).toMatchObject({
        action: "would_comment",
        reason: "eligible"
      });
      expect(scan.items.find((item) => item.repo === "owner/repo-a" && item.issueNumber === 102)).toMatchObject({
        action: "deferred",
        reason: "global_max_issues_per_cycle",
        nextEligibleAt: "2026-07-03T04:10:00.000Z"
      });
      expect(scan.items.find((item) => item.repo === "owner/repo-b" && item.issueNumber === 201)).toMatchObject({
        action: "deferred",
        reason: "global_max_issues_per_cycle",
        nextEligibleAt: "2026-07-03T04:10:00.000Z"
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("applies global issue caps to dry-run enrichment records without comment posting", async () => {
    const root = mkdtempSync(join(tmpdir(), "issue-enrichment-global-issue-cap-"));
    try {
      const configPath = join(root, "config.json");
      writeFileSync(configPath, `${JSON.stringify({
        issueEnrichment: {
          enabled: true,
          postIssueComment: false,
          allowlist: ["owner/repo-a", "owner/repo-b"],
          maxIssuesPerCycle: 10,
          maxCommentsPerCycle: 0,
          globalMaxIssuesPerCycle: 2,
          globalMaxCommentsPerCycle: 0,
          cooldownMs: 300_000,
          maxIssuesPerBurst: 10,
          processExistingOpenIssuesOnActivation: true,
          repos: {
            "owner/repo-b": {
              cooldownMs: 60_000
            }
          }
        }
      })}\n`);

      const scan = await collectIssueEnrichmentScan({
        config: loadConfig(configPath),
        dryRun: true,
        includeExisting: true,
        checkedAt: "2026-07-03T04:00:00.000Z",
        reader: {
          listIssuesForEnrichment: async (repo) => [
            { number: repo.endsWith("repo-a") ? 101 : 201, title: "Issue one", state: "open", body: "Acceptance criteria and owner present." },
            { number: repo.endsWith("repo-a") ? 102 : 202, title: "Issue two", state: "open", body: "Acceptance criteria and owner present." }
          ]
        }
      });

      expect(scan.ok).toBe(true);
      expect(scan.summary).toMatchObject({
        issuesSeen: 4,
        eligible: 4,
        wouldEnrich: 2,
        wouldComment: 0,
        deferred: 2
      });
      expect(scan.items.filter((item) => item.action === "would_enrich")).toEqual([
        expect.objectContaining({ repo: "owner/repo-a", issueNumber: 101, reason: "eligible" }),
        expect.objectContaining({ repo: "owner/repo-a", issueNumber: 102, reason: "eligible" })
      ]);
      expect(scan.items.find((item) => item.issueNumber === 201)).toMatchObject({
        action: "deferred",
        reason: "global_max_issues_per_cycle",
        nextEligibleAt: "2026-07-03T04:05:00.000Z"
      });
      expect(scan.items.find((item) => item.issueNumber === 202)).toMatchObject({
        action: "deferred",
        reason: "global_max_issues_per_cycle",
        nextEligibleAt: "2026-07-03T04:05:00.000Z"
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("records dry-run-only issue enrichment once per unchanged issue update", async () => {
    const root = mkdtempSync(join(tmpdir(), "issue-enrichment-cycle-dry-run-"));
    try {
      const configPath = join(root, "config.json");
      const statePath = join(root, "state.sqlite");
      writeFileSync(configPath, `${JSON.stringify({
        statePath,
        issueEnrichment: {
          enabled: true,
          postIssueComment: false,
          allowlist: ["owner/issue-repo"],
          maxIssuesPerCycle: 5,
          maxCommentsPerCycle: 0,
          processExistingOpenIssuesOnActivation: true
        }
      })}\n`);
      const state = new ReviewStateStore(statePath);
      try {
        const issue: GitHubRelatedIssueOrPull = {
          number: 31,
          title: "Add issue enrichment scheduler",
          state: "open",
          updated_at: "2026-07-03T01:00:00.000Z",
          body: "Acceptance criteria and owner present."
        };
        const reader = { listIssuesForEnrichment: async () => [issue] };

        const first = await runIssueEnrichmentCycle({
          config: loadConfig(configPath),
          state,
          github: {
            ...reader,
            canPostAsApp: () => false,
            upsertIssueComment: async () => {
              throw new Error("should not post in dry-run-only mode");
            }
          },
          dryRun: false,
          checkedAt: "2026-07-03T01:05:00.000Z"
        });
        const second = await runIssueEnrichmentCycle({
          config: loadConfig(configPath),
          state,
          github: {
            ...reader,
            canPostAsApp: () => false,
            upsertIssueComment: async () => {
              throw new Error("should not post in dry-run-only mode");
            }
          },
          dryRun: false,
          checkedAt: "2026-07-03T01:06:00.000Z"
        });

        expect(first.summary).toMatchObject({ dryRunRecorded: 1, alreadyProcessed: 0, posted: 0, failed: 0 });
        expect(second.summary).toMatchObject({ dryRunRecorded: 0, alreadyProcessed: 1, posted: 0, failed: 0 });
        expect(state.getIssueEnrichmentRecord("owner/issue-repo", 31)).toMatchObject({
          status: "dry_run",
          issueUpdatedAt: "2026-07-03T01:00:00.000Z",
          reason: "dry_run_only"
        });
      } finally {
        state.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not let already processed issues consume live global caps forever", async () => {
    const root = mkdtempSync(join(tmpdir(), "issue-enrichment-global-cap-progress-"));
    try {
      const configPath = join(root, "config.json");
      const statePath = join(root, "state.sqlite");
      writeFileSync(configPath, `${JSON.stringify({
        statePath,
        issueEnrichment: {
          enabled: true,
          postIssueComment: false,
          allowlist: ["owner/issue-repo"],
          maxIssuesPerCycle: 10,
          maxCommentsPerCycle: 1,
          globalMaxIssuesPerCycle: 2,
          globalMaxCommentsPerCycle: 1,
          cooldownMs: 60_000,
          maxIssuesPerBurst: 10,
          processExistingOpenIssuesOnActivation: true
        }
      })}\n`);
      const state = new ReviewStateStore(statePath);
      try {
        const issues: GitHubRelatedIssueOrPull[] = [1, 2, 3, 4].map((number) => ({
          number,
          title: `Issue ${number}`,
          state: "open",
          updated_at: "2026-07-03T06:00:00.000Z",
          body: "Acceptance criteria and owner present."
        }));
        const github = {
          listIssuesForEnrichment: async () => issues,
          canPostAsApp: () => false,
          upsertIssueComment: async () => {
            throw new Error("should not post in dry-run-only mode");
          }
        };

        const first = await runIssueEnrichmentCycle({
          config: loadConfig(configPath),
          state,
          github,
          dryRun: false,
          checkedAt: "2026-07-03T06:01:00.000Z"
        });
        const second = await runIssueEnrichmentCycle({
          config: loadConfig(configPath),
          state,
          github,
          dryRun: false,
          checkedAt: "2026-07-03T06:03:00.000Z"
        });

        expect(first.summary).toMatchObject({ dryRunRecorded: 2, deferredRecorded: 2, alreadyProcessed: 0 });
        expect(second.summary).toMatchObject({ dryRunRecorded: 2, deferredRecorded: 0, alreadyProcessed: 2 });
        expect(state.getIssueEnrichmentRecord("owner/issue-repo", 1)).toMatchObject({ status: "dry_run" });
        expect(state.getIssueEnrichmentRecord("owner/issue-repo", 2)).toMatchObject({ status: "dry_run" });
        expect(state.getIssueEnrichmentRecord("owner/issue-repo", 3)).toMatchObject({ status: "dry_run" });
        expect(state.getIssueEnrichmentRecord("owner/issue-repo", 4)).toMatchObject({ status: "dry_run" });
      } finally {
        state.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("posts new issues in order on the second live cycle after global-cap deferrals", async () => {
    const root = mkdtempSync(join(tmpdir(), "issue-enrichment-global-cap-live-progress-"));
    try {
      const configPath = join(root, "config.json");
      const statePath = join(root, "state.sqlite");
      writeFileSync(configPath, `${JSON.stringify({
        statePath,
        issueEnrichment: {
          enabled: true,
          postIssueComment: true,
          allowlist: ["owner/issue-repo"],
          maxIssuesPerCycle: 10,
          maxCommentsPerCycle: 2,
          globalMaxIssuesPerCycle: 2,
          globalMaxCommentsPerCycle: 2,
          cooldownMs: 60_000,
          maxIssuesPerBurst: 10,
          processExistingOpenIssuesOnActivation: true,
          repos: {
            "owner/issue-repo": {
              maxIssuesPerCycle: 10,
              maxCommentsPerCycle: 2,
              cooldownMs: 60_000,
              burstWindowMs: 3_600_000,
              maxIssuesPerBurst: 10,
              lookbackMs: 600_000
            }
          }
        }
      })}\n`);
      const state = new ReviewStateStore(statePath);
      try {
        const issues: GitHubRelatedIssueOrPull[] = [1, 2, 3, 4].map((number) => ({
          number,
          title: `Issue ${number}`,
          state: "open",
          updated_at: "2026-07-03T06:00:00.000Z",
          body: "Acceptance criteria and owner present."
        }));
        const posted: number[] = [];
        const github = {
          listIssuesForEnrichment: async () => issues,
          canPostAsApp: () => true,
          upsertIssueComment: async (input: { issueNumber: number }) => {
            const issueNumber = input.issueNumber;
            posted.push(issueNumber);
            return {
              action: "created" as const,
              id: issueNumber,
              html_url: `https://github.test/owner/issue-repo/issues/${issueNumber}#issuecomment-${issueNumber}`
            };
          }
        };

        const first = await runIssueEnrichmentCycle({
          config: loadConfig(configPath),
          state,
          github,
          dryRun: false,
          checkedAt: "2026-07-03T06:01:00.000Z"
        });
        const second = await runIssueEnrichmentCycle({
          config: loadConfig(configPath),
          state,
          github,
          dryRun: false,
          checkedAt: "2026-07-03T06:03:00.000Z"
        });

        expect(first.summary).toMatchObject({ posted: 2, deferredRecorded: 2, alreadyProcessed: 0, failed: 0 });
        expect(second.summary).toMatchObject({ posted: 2, deferredRecorded: 0, alreadyProcessed: 2, failed: 0 });
        expect(posted).toEqual([1, 2, 3, 4]);
        expect(state.getIssueEnrichmentRecord("owner/issue-repo", 1)).toMatchObject({ status: "posted" });
        expect(state.getIssueEnrichmentRecord("owner/issue-repo", 2)).toMatchObject({ status: "posted" });
        expect(state.getIssueEnrichmentRecord("owner/issue-repo", 3)).toMatchObject({ status: "posted" });
        expect(state.getIssueEnrichmentRecord("owner/issue-repo", 4)).toMatchObject({ status: "posted" });
      } finally {
        state.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("baselines a newly allowlisted repo before scanning issue history", async () => {
    const root = mkdtempSync(join(tmpdir(), "issue-enrichment-cycle-baseline-"));
    try {
      const configPath = join(root, "config.json");
      const statePath = join(root, "state.sqlite");
      writeFileSync(configPath, `${JSON.stringify({
        statePath,
        issueEnrichment: {
          enabled: true,
          postIssueComment: false,
          allowlist: ["owner/issue-repo"],
          maxIssuesPerCycle: 5,
          maxCommentsPerCycle: 0,
          processExistingOpenIssuesOnActivation: false
        }
      })}\n`);
      const state = new ReviewStateStore(statePath);
      const calls: Array<{ since?: string }> = [];
      try {
        const first = await runIssueEnrichmentCycle({
          config: loadConfig(configPath),
          state,
          github: {
            listIssuesForEnrichment: async () => {
              throw new Error("newly allowlisted repo should baseline before scanning old issues");
            },
            canPostAsApp: () => false,
            upsertIssueComment: async () => {
              throw new Error("should not post in dry-run-only mode");
            }
          },
          dryRun: false,
          checkedAt: "2026-07-03T04:00:00.000Z"
        });

        const second = await runIssueEnrichmentCycle({
          config: loadConfig(configPath),
          state,
          github: {
            listIssuesForEnrichment: async (_repo, options) => {
              calls.push({ since: options?.since });
              return [
                {
                  number: 71,
                  title: "New issue after activation",
                  state: "open",
                  updated_at: "2026-07-03T04:01:00.000Z",
                  body: "Acceptance criteria and owner present."
                }
              ];
            },
            canPostAsApp: () => false,
            upsertIssueComment: async () => {
              throw new Error("should not post in dry-run-only mode");
            }
          },
          dryRun: false,
          checkedAt: "2026-07-03T04:02:00.000Z"
        });

        expect(first.summary).toMatchObject({
          reposScanned: 0,
          issuesSeen: 0,
          baselinedRepos: 1,
          dryRunRecorded: 0,
          failed: 0
        });
        expect(first.repos[0]).toMatchObject({
          repo: "owner/issue-repo",
          allowed: true,
          baselined: true,
          since: "2026-07-03T04:00:00.000Z"
        });
        expect(calls).toEqual([{ since: "2026-07-03T04:00:00.000Z" }]);
        expect(second.summary).toMatchObject({ reposScanned: 1, issuesSeen: 1, dryRunRecorded: 1, failed: 0 });
        expect(state.getIssueEnrichmentRepoWatermark("owner/issue-repo")).toMatchObject({
          activatedAt: "2026-07-03T04:00:00.000Z",
          lastCheckedAt: "2026-07-03T04:02:00.000Z"
        });
      } finally {
        state.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses explicit existing-issue activation backfill only once after a clean scan", async () => {
    const root = mkdtempSync(join(tmpdir(), "issue-enrichment-cycle-backfill-once-"));
    try {
      const configPath = join(root, "config.json");
      const statePath = join(root, "state.sqlite");
      writeFileSync(configPath, `${JSON.stringify({
        statePath,
        issueEnrichment: {
          enabled: true,
          postIssueComment: false,
          allowlist: ["owner/issue-repo"],
          maxIssuesPerCycle: 5,
          maxCommentsPerCycle: 0,
          processExistingOpenIssuesOnActivation: true
        }
      })}\n`);
      const state = new ReviewStateStore(statePath);
      const calls: Array<{ since?: string }> = [];
      try {
        const first = await runIssueEnrichmentCycle({
          config: loadConfig(configPath),
          state,
          github: {
            listIssuesForEnrichment: async (_repo, options) => {
              calls.push({ since: options?.since });
              return [
                {
                  number: 81,
                  title: "Existing issue",
                  state: "open",
                  updated_at: "2026-07-03T03:00:00.000Z",
                  body: "Acceptance criteria and owner present."
                }
              ];
            },
            canPostAsApp: () => false,
            upsertIssueComment: async () => {
              throw new Error("should not post in dry-run-only mode");
            }
          },
          dryRun: false,
          checkedAt: "2026-07-03T04:00:00.000Z"
        });
        const second = await runIssueEnrichmentCycle({
          config: loadConfig(configPath),
          state,
          github: {
            listIssuesForEnrichment: async (_repo, options) => {
              calls.push({ since: options?.since });
              return [];
            },
            canPostAsApp: () => false,
            upsertIssueComment: async () => {
              throw new Error("should not post in dry-run-only mode");
            }
          },
          dryRun: false,
          checkedAt: "2026-07-03T04:05:00.000Z"
        });

        expect(first.summary).toMatchObject({ reposScanned: 1, dryRunRecorded: 1, failed: 0 });
        expect(second.summary).toMatchObject({ reposScanned: 1, issuesSeen: 0, failed: 0 });
        expect(calls).toEqual([{ since: undefined }, { since: "2026-07-03T04:00:00.000Z" }]);
        expect(state.getIssueEnrichmentRepoWatermark("owner/issue-repo")).toMatchObject({
          activatedAt: "2026-07-03T04:00:00.000Z",
          lastCheckedAt: "2026-07-03T04:05:00.000Z"
        });
      } finally {
        state.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not advance issue enrichment watermarks past deferred or failed issue work", async () => {
    const root = mkdtempSync(join(tmpdir(), "issue-enrichment-cycle-hold-watermark-"));
    try {
      const configPath = join(root, "config.json");
      const statePath = join(root, "state.sqlite");
      writeFileSync(configPath, `${JSON.stringify({
        statePath,
        issueEnrichment: {
          enabled: true,
          postIssueComment: true,
          allowlist: ["owner/deferred-repo", "owner/failed-repo"],
          maxIssuesPerCycle: 5,
          maxCommentsPerCycle: 0,
          cooldownMs: 60_000,
          repos: {
            "owner/deferred-repo": {
              maxIssuesPerCycle: 5,
              maxCommentsPerCycle: 0,
              cooldownMs: 60_000,
              burstWindowMs: 3_600_000,
              maxIssuesPerBurst: 10,
              lookbackMs: 600_000
            },
            "owner/failed-repo": {
              maxIssuesPerCycle: 5,
              cooldownMs: 60_000,
              burstWindowMs: 3_600_000,
              maxIssuesPerBurst: 10,
              lookbackMs: 600_000,
              maxCommentsPerCycle: 1
            }
          }
        }
      })}\n`);
      const state = new ReviewStateStore(statePath);
      state.recordIssueEnrichmentRepoWatermark({
        repo: "owner/deferred-repo",
        activatedAt: "2026-07-03T04:00:00.000Z",
        lastCheckedAt: "2026-07-03T04:00:00.000Z",
        now: new Date("2026-07-03T04:00:00.000Z")
      });
      state.recordIssueEnrichmentRepoWatermark({
        repo: "owner/failed-repo",
        activatedAt: "2026-07-03T04:00:00.000Z",
        lastCheckedAt: "2026-07-03T04:00:00.000Z",
        now: new Date("2026-07-03T04:00:00.000Z")
      });
      try {
        const result = await runIssueEnrichmentCycle({
          config: loadConfig(configPath),
          state,
          github: {
            listIssuesForEnrichment: async (repo) => [
              {
                number: repo.endsWith("deferred-repo") ? 91 : 92,
                title: "Needs enrichment",
                state: "open",
                updated_at: "2026-07-03T04:01:00.000Z",
                body: "Acceptance criteria and owner present."
              }
            ],
            canPostAsApp: () => true,
            upsertIssueComment: async () => {
              throw new Error("GitHub post failed");
            }
          },
          dryRun: false,
          checkedAt: "2026-07-03T04:05:00.000Z"
        });

        expect(result.summary).toMatchObject({ deferredRecorded: 1, failed: 1 });
        expect(state.getIssueEnrichmentRecord("owner/deferred-repo", 91)).toMatchObject({ status: "deferred" });
        expect(state.getIssueEnrichmentRecord("owner/failed-repo", 92)).toMatchObject({ status: "failed" });
        expect(state.getIssueEnrichmentRepoWatermark("owner/deferred-repo")).toMatchObject({
          lastCheckedAt: "2026-07-03T04:00:00.000Z"
        });
        expect(state.getIssueEnrichmentRepoWatermark("owner/failed-repo")).toMatchObject({
          lastCheckedAt: "2026-07-03T04:00:00.000Z"
        });
      } finally {
        state.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not advance issue enrichment watermarks after saturated page-limited scans", async () => {
    const root = mkdtempSync(join(tmpdir(), "issue-enrichment-cycle-truncated-"));
    try {
      const configPath = join(root, "config.json");
      const statePath = join(root, "state.sqlite");
      writeFileSync(configPath, `${JSON.stringify({
        statePath,
        issueEnrichment: {
          enabled: true,
          postIssueComment: false,
          allowlist: ["owner/issue-repo"],
          maxIssuesPerCycle: 1,
          maxIssuesPerBurst: 1,
          processExistingOpenIssuesOnActivation: false
        }
      })}\n`);
      const state = new ReviewStateStore(statePath);
      state.recordIssueEnrichmentRepoWatermark({
        repo: "owner/issue-repo",
        activatedAt: "2026-07-03T04:00:00.000Z",
        lastCheckedAt: "2026-07-03T04:00:00.000Z",
        now: new Date("2026-07-03T04:00:00.000Z")
      });
      try {
        const result = await runIssueEnrichmentCycle({
          config: loadConfig(configPath),
          state,
          github: {
            listIssuesForEnrichment: async () =>
              Array.from({ length: 100 }, (_, index) => ({
                number: 200 + index,
                title: `Closed issue ${index}`,
                state: "closed",
                updated_at: "2026-07-03T04:01:00.000Z",
                body: "Closed."
              })),
            canPostAsApp: () => false,
            upsertIssueComment: async () => {
              throw new Error("should not post in dry-run-only mode");
            }
          },
          dryRun: false,
          checkedAt: "2026-07-03T04:05:00.000Z"
        });

        expect(result.summary).toMatchObject({ reposScanned: 1, truncatedRepos: 1, skippedRecorded: 100 });
        expect(result.repos[0]).toMatchObject({ truncated: true });
        expect(state.getIssueEnrichmentRepoWatermark("owner/issue-repo")).toMatchObject({
          lastCheckedAt: "2026-07-03T04:00:00.000Z"
        });
      } finally {
        state.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not mutate issue enrichment watermarks during dry-run cycles", async () => {
    const root = mkdtempSync(join(tmpdir(), "issue-enrichment-cycle-baseline-dry-run-"));
    try {
      const configPath = join(root, "config.json");
      const statePath = join(root, "state.sqlite");
      writeFileSync(configPath, `${JSON.stringify({
        statePath,
        issueEnrichment: {
          enabled: true,
          postIssueComment: false,
          allowlist: ["owner/issue-repo"],
          processExistingOpenIssuesOnActivation: false
        }
      })}\n`);
      const state = new ReviewStateStore(statePath);
      try {
        const result = await runIssueEnrichmentCycle({
          config: loadConfig(configPath),
          state,
          github: {
            listIssuesForEnrichment: async () => {
              throw new Error("dry-run baseline should not scan old issues");
            },
            canPostAsApp: () => false,
            upsertIssueComment: async () => {
              throw new Error("dry-run baseline should not post");
            }
          },
          dryRun: true,
          checkedAt: "2026-07-03T04:30:00.000Z"
        });

        expect(result.summary).toMatchObject({ reposScanned: 0, issuesSeen: 0, baselinedRepos: 1 });
        expect(state.getIssueEnrichmentRepoWatermark("owner/issue-repo")).toBeUndefined();
      } finally {
        state.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not baseline activation watermarks when manual selected runs disable watermark advancement", async () => {
    const root = mkdtempSync(join(tmpdir(), "issue-enrichment-cycle-baseline-manual-"));
    try {
      const configPath = join(root, "config.json");
      const statePath = join(root, "state.sqlite");
      writeFileSync(configPath, `${JSON.stringify({
        statePath,
        issueEnrichment: {
          enabled: true,
          postIssueComment: true,
          allowlist: ["owner/issue-repo"],
          maxIssuesPerCycle: 5,
          maxCommentsPerCycle: 1,
          processExistingOpenIssuesOnActivation: false,
          repos: {
            "owner/issue-repo": {
              maxIssuesPerCycle: 5,
              maxCommentsPerCycle: 1,
              cooldownMs: 3_600_000,
              burstWindowMs: 3_600_000,
              maxIssuesPerBurst: 10,
              lookbackMs: 600_000,
              processExistingOpenIssuesOnActivation: false
            }
          }
        }
      })}\n`);
      const state = new ReviewStateStore(statePath);
      try {
        const result = await runIssueEnrichmentCycle({
          config: loadConfig(configPath),
          state,
          github: {
            listIssuesForEnrichment: async () => {
              throw new Error("manual selected baseline should not scan old issues");
            },
            canPostAsApp: () => true,
            upsertIssueComment: async () => {
              throw new Error("manual selected baseline should not post");
            }
          },
          dryRun: false,
          checkedAt: "2026-07-03T04:35:00.000Z",
          advanceWatermarks: false
        });

        expect(result.summary).toMatchObject({ reposScanned: 0, issuesSeen: 0, baselinedRepos: 1 });
        expect(state.getIssueEnrichmentRepoWatermark("owner/issue-repo")).toBeUndefined();
      } finally {
        state.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("posts sticky issue enrichment when live comments are explicitly enabled and skips unchanged reruns", async () => {
    const root = mkdtempSync(join(tmpdir(), "issue-enrichment-cycle-post-"));
    try {
      const configPath = join(root, "config.json");
      const statePath = join(root, "state.sqlite");
      writeFileSync(configPath, `${JSON.stringify({
        statePath,
        issueEnrichment: {
          enabled: true,
          postIssueComment: true,
          allowlist: ["owner/issue-repo"],
          allowedLabels: ["docs", "security"],
          allowedReviewers: ["issue-owner", "incident-reviewer"],
          maxIssuesPerCycle: 5,
          maxCommentsPerCycle: 2,
          processExistingOpenIssuesOnActivation: true,
          repos: {
            "owner/issue-repo": {
              maxIssuesPerCycle: 5,
              maxCommentsPerCycle: 2,
              cooldownMs: 3_600_000,
              burstWindowMs: 3_600_000,
              maxIssuesPerBurst: 10,
              lookbackMs: 600_000
            }
          }
        }
      })}\n`);
      const state = new ReviewStateStore(statePath);
      const posts: Array<{ issueNumber: number; marker: string; body: string }> = [];
      try {
        const issue: GitHubRelatedIssueOrPull = {
          number: 41,
          title: "Route issue enrichment #10",
          state: "open",
          updated_at: "2026-07-03T02:00:00.000Z",
          html_url: "https://github.test/owner/issue-repo/issues/41",
          body: "Acceptance criteria and owner present. Update the docs runbook."
        };
        const github = {
          listIssuesForEnrichment: async () => [issue],
          canPostAsApp: () => true,
          upsertIssueComment: async (input: { issueNumber: number; marker: string; body: string }) => {
            posts.push(input);
            return { action: "created" as const, id: 4100, html_url: `https://github.test/comment/${posts.length}` };
          }
        };

        const first = await runIssueEnrichmentCycle({
          config: loadConfig(configPath),
          state,
          github,
          dryRun: false,
          checkedAt: "2026-07-03T02:05:00.000Z"
        });
        const second = await runIssueEnrichmentCycle({
          config: loadConfig(configPath),
          state,
          github,
          dryRun: false,
          checkedAt: "2026-07-03T02:06:00.000Z"
        });

      expect(first.summary).toMatchObject({ posted: 1, alreadyProcessed: 0, failed: 0 });
      expect(second.summary).toMatchObject({ posted: 0, alreadyProcessed: 1, failed: 0 });
      expect(second.repos[0]).toMatchObject({ eligible: 0, wouldEnrich: 0, wouldComment: 0, deferred: 0 });
      expect(posts).toHaveLength(1);
        expect(posts[0]!.marker).toContain("issue=41");
        expect(posts[0]!.body).toContain("## evaOS issue enrichment");
        expect(posts[0]!.body).toContain("Suggested labels: docs.");
        expect(posts[0]!.body).not.toContain("Suggested labels: docs, security");
        expect(posts[0]!.body).toContain("Suggested owners: none.");
        expect(posts[0]!.body).not.toContain("issue-owner");
        expect(posts[0]!.body).not.toContain("incident-reviewer");
        expect(state.getIssueEnrichmentRecord("owner/issue-repo", 41)).toMatchObject({
          status: "posted",
          issueUpdatedAt: "2026-07-03T02:00:00.000Z",
          commentUrl: "https://github.test/comment/1"
        });
      } finally {
        state.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed without scanning or posting when live issue comments lack App credentials", async () => {
    const root = mkdtempSync(join(tmpdir(), "issue-enrichment-cycle-missing-app-"));
    try {
      const configPath = join(root, "config.json");
      const statePath = join(root, "state.sqlite");
      writeFileSync(configPath, `${JSON.stringify({
        statePath,
        issueEnrichment: {
          enabled: true,
          postIssueComment: true,
          allowlist: ["owner/issue-repo"],
          maxIssuesPerCycle: 5,
          maxCommentsPerCycle: 2,
          processExistingOpenIssuesOnActivation: true,
          repos: {
            "owner/issue-repo": {
              maxIssuesPerCycle: 5,
              maxCommentsPerCycle: 2,
              cooldownMs: 3_600_000,
              burstWindowMs: 3_600_000,
              maxIssuesPerBurst: 10,
              lookbackMs: 600_000
            }
          }
        }
      })}\n`);
      const state = new ReviewStateStore(statePath);
      try {
        const result = await runIssueEnrichmentCycle({
          config: loadConfig(configPath),
          state,
          github: {
            listIssuesForEnrichment: async () => {
              throw new Error("should not scan when live issue comments are blocked");
            },
            canPostAsApp: () => false,
            upsertIssueComment: async () => {
              throw new Error("should not post without App credentials");
            }
          },
          dryRun: false,
          checkedAt: "2026-07-03T02:10:00.000Z"
        });

        expect(result.ok).toBe(false);
        expect(result.status.state).toBe("blocked");
        expect(result.status.blockers).toContain("github_app_credentials_required_for_live_issue_comments");
        expect(result.summary).toMatchObject({
          reposScanned: 0,
          issuesSeen: 0,
          posted: 0,
          failed: 0
        });
        expect(result.items).toEqual([]);
        expect(state.listIssueEnrichmentRecords()).toEqual([]);
      } finally {
        state.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("records redacted issue-enrichment posting failures without leaking provider tokens", async () => {
    const root = mkdtempSync(join(tmpdir(), "issue-enrichment-cycle-post-fail-"));
    try {
      const configPath = join(root, "config.json");
      const statePath = join(root, "state.sqlite");
      writeFileSync(configPath, `${JSON.stringify({
        statePath,
        issueEnrichment: {
          enabled: true,
          postIssueComment: true,
          allowlist: ["owner/issue-repo"],
          maxIssuesPerCycle: 5,
          maxCommentsPerCycle: 2,
          processExistingOpenIssuesOnActivation: true,
          repos: {
            "owner/issue-repo": {
              maxIssuesPerCycle: 5,
              maxCommentsPerCycle: 2,
              cooldownMs: 3_600_000,
              burstWindowMs: 3_600_000,
              maxIssuesPerBurst: 10,
              lookbackMs: 600_000
            }
          }
        }
      })}\n`);
      const state = new ReviewStateStore(statePath);
      try {
        const issue: GitHubRelatedIssueOrPull = {
          number: 61,
          title: "Handle post failure",
          state: "open",
          updated_at: "2026-07-03T02:20:00.000Z",
          body: "Acceptance criteria and owner present."
        };
        const result = await runIssueEnrichmentCycle({
          config: loadConfig(configPath),
          state,
          github: {
            listIssuesForEnrichment: async () => [issue],
            canPostAsApp: () => true,
            upsertIssueComment: async () => {
              throw new Error("GitHub rejected comment with ghp_fake_token");
            }
          },
          dryRun: false,
          checkedAt: "2026-07-03T02:25:00.000Z"
        });

        expect(result.ok).toBe(false);
        expect(result.summary).toMatchObject({ posted: 0, failed: 1 });
        expect(result.items[0]).toMatchObject({ recordStatus: "failed" });
        expect(result.items[0]!.error).not.toContain("ghp_fake_token");
        const record = state.getIssueEnrichmentRecord("owner/issue-repo", 61);
        expect(record).toMatchObject({
          status: "failed",
          reason: "post_failed"
        });
        expect(record?.error).not.toContain("ghp_fake_token");
      } finally {
        state.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps disabled issue enrichment as a no-op with no state writes", async () => {
    const root = mkdtempSync(join(tmpdir(), "issue-enrichment-cycle-disabled-"));
    try {
      const statePath = join(root, "state.sqlite");
      const state = new ReviewStateStore(statePath);
      try {
        const result = await runIssueEnrichmentCycle({
          config: loadConfig(),
          state,
          github: {
            listIssuesForEnrichment: async () => {
              throw new Error("disabled issue enrichment should not scan");
            },
            canPostAsApp: () => false,
            upsertIssueComment: async () => {
              throw new Error("disabled issue enrichment should not post");
            }
          },
          dryRun: false,
          checkedAt: "2026-07-03T03:00:00.000Z"
        });

        expect(result.summary).toMatchObject({
          reposScanned: 0,
          issuesSeen: 0,
          posted: 0,
          dryRunRecorded: 0,
          failed: 0
        });
        expect(state.listIssueEnrichmentRecords()).toEqual([]);
      } finally {
        state.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("releases live issue enrichment leases when the issue reader fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "issue-enrichment-reader-failure-lease-"));
    try {
      const configPath = join(root, "config.json");
      const statePath = join(root, "state.sqlite");
      writeFileSync(configPath, `${JSON.stringify({
        statePath,
        issueEnrichment: {
          enabled: true,
          postIssueComment: true,
          allowlist: ["owner/issue-repo"],
          maxIssuesPerCycle: 5,
          maxCommentsPerCycle: 1,
          globalMaxIssuesPerCycle: 5,
          globalMaxCommentsPerCycle: 1,
          maxActiveRuns: 1,
          leaseTtlMs: 1_200_000,
          processExistingOpenIssuesOnActivation: true,
          repos: {
            "owner/issue-repo": {
              maxIssuesPerCycle: 5,
              maxCommentsPerCycle: 1,
              cooldownMs: 3_600_000,
              burstWindowMs: 3_600_000,
              maxIssuesPerBurst: 10,
              lookbackMs: 600_000
            }
          }
        }
      })}\n`);
      const state = new ReviewStateStore(statePath);
      try {
        const result = await runIssueEnrichmentCycle({
          config: loadConfig(configPath),
          state,
          github: {
            listIssuesForEnrichment: async () => {
              throw new Error("GitHub read failed");
            },
            canPostAsApp: () => true,
            upsertIssueComment: async () => {
              throw new Error("reader failure test must not post");
            }
          },
          dryRun: false,
          checkedAt: "2026-07-03T05:00:00.000Z"
        });
        const afterFailure = state.tryAcquireIssueEnrichmentRunLease(1, 1_200_000, new Date("2026-07-03T05:01:00.000Z"));

        expect(result.ok).toBe(false);
        expect(result.summary).toMatchObject({
          readFailures: 1,
          posted: 0,
          failed: 0
        });
        expect(afterFailure).toBeDefined();
        expect(state.listIssueEnrichmentRecords()).toEqual([]);
      } finally {
        state.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("skips live issue enrichment when the one-worker lease is already held", async () => {
    const root = mkdtempSync(join(tmpdir(), "issue-enrichment-worker-lease-"));
    try {
      const configPath = join(root, "config.json");
      const statePath = join(root, "state.sqlite");
      writeFileSync(configPath, `${JSON.stringify({
        statePath,
        issueEnrichment: {
          enabled: true,
          postIssueComment: true,
          allowlist: ["owner/issue-repo"],
          maxIssuesPerCycle: 5,
          maxCommentsPerCycle: 1,
          globalMaxIssuesPerCycle: 5,
          globalMaxCommentsPerCycle: 1,
          maxActiveRuns: 1,
          leaseTtlMs: 1_200_000,
          processExistingOpenIssuesOnActivation: true,
          repos: {
            "owner/issue-repo": {
              maxIssuesPerCycle: 5,
              maxCommentsPerCycle: 1,
              cooldownMs: 3_600_000,
              burstWindowMs: 3_600_000,
              maxIssuesPerBurst: 10,
              lookbackMs: 600_000
            }
          }
        }
      })}\n`);
      const state = new ReviewStateStore(statePath);
      try {
        const held = state.tryAcquireIssueEnrichmentRunLease(1, 1_200_000, new Date("2026-07-03T05:00:00.000Z"));
        expect(held).toBeDefined();
        let readerCalls = 0;
        let postCalls = 0;

        const result = await runIssueEnrichmentCycle({
          config: loadConfig(configPath),
          state,
          github: {
            listIssuesForEnrichment: async () => {
              readerCalls += 1;
              return [{ number: 71, title: "New issue", state: "open", body: "Acceptance criteria and owner present." }];
            },
            canPostAsApp: () => true,
            upsertIssueComment: async () => {
              postCalls += 1;
              return {
                action: "created",
                id: 1,
                html_url: "https://github.test/owner/issue-repo/issues/71#issuecomment-1"
              };
            }
          },
          dryRun: false,
          checkedAt: "2026-07-03T05:01:00.000Z"
        });

        expect(readerCalls).toBe(0);
        expect(postCalls).toBe(0);
        expect(result.ok).toBe(true);
        expect(result.status).toMatchObject({
          ok: true,
          state: "ready",
          blockers: []
        });
        expect(result.summary).toMatchObject({
          reposScanned: 0,
          issuesSeen: 0,
          workerSkipped: 1,
          posted: 0,
          failed: 0
        });
        expect(result.recommendedActions).toContain("issue enrichment worker is busy; retry after the active lease expires");
        expect(state.listIssueEnrichmentRecords()).toEqual([]);
      } finally {
        state.close();
      }
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
