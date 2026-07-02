import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import {
  buildEnrichmentComment,
  buildEnrichmentMarker,
  ENRICHMENT_MARKER_PREFIX,
  ENRICHMENT_STATE_MARKER_PREFIX,
  postEnrichmentComment
} from "../src/enrichment.js";
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
});

function extractStateHash(body: string): string {
  const match = body.match(/hash=([0-9a-f]{64})/i);
  if (!match) throw new Error(`missing state hash in body:\n${body}`);
  return match[1]!;
}
