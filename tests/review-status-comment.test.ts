import { describe, expect, it } from "vitest";
import {
  buildReviewStatusComment,
  buildReviewStatusMarker,
  postReviewStatusComment
} from "../src/review-status-comment.js";

const HEAD_A = "a".repeat(40);

describe("review status comment", () => {
  it("builds a stable identity marker and mutable state marker", () => {
    const comment = buildReviewStatusComment({
      repo: "owner/repo",
      pullNumber: 274,
      headSha: HEAD_A,
      state: "queued",
      pullTitle: "Fast PR",
      now: new Date("2026-07-02T00:00:00.000Z")
    });

    expect(comment.marker).toBe(`<!-- evaos-code-review-bot:review-status repo=owner/repo pr=274 sha=${HEAD_A} -->`);
    expect(comment.body).toContain(comment.marker);
    expect(comment.body).toContain("<!-- evaos-code-review-bot:review-status-state status=queued updated_at=2026-07-02T00:00:00.000Z -->");
    expect(comment.body).toContain("evaOS review status: queued");
    expect(comment.body).toContain("agents should wait");
    expect(comment.body).toContain("`skipped`");
    expect(comment.body).toContain("`provider_deferred` means evaOS still intends to retry");
  });

  it("uses the same marker when state changes for the same head", () => {
    const marker = buildReviewStatusMarker({ repo: "owner/repo", pullNumber: 274, headSha: HEAD_A });
    expect(buildReviewStatusComment({ repo: "owner/repo", pullNumber: 274, headSha: HEAD_A, state: "queued" }).marker)
      .toBe(marker);
    expect(buildReviewStatusComment({ repo: "owner/repo", pullNumber: 274, headSha: HEAD_A, state: "completed" }).marker)
      .toBe(marker);
  });

  it("posts through marker-backed upsert when enabled", async () => {
    const calls: Array<{ marker: string; body: string }> = [];
    const result = await postReviewStatusComment({
      enabled: true,
      dryRun: false,
      github: {
        canPostAsApp: () => true,
        upsertIssueComment: async (input) => {
          calls.push({ marker: input.marker, body: input.body });
          return { action: "created", id: 123, html_url: "https://github.test/comment/123" };
        }
      },
      repo: "owner/repo",
      pullNumber: 274,
      headSha: HEAD_A,
      state: "in_progress",
      now: new Date("2026-07-02T00:00:00.000Z")
    });

    expect(result).toMatchObject({ posted: true, action: "created", id: 123, state: "in_progress" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.marker).toBe(`<!-- evaos-code-review-bot:review-status repo=owner/repo pr=274 sha=${HEAD_A} -->`);
    expect(calls[0]?.body).toContain("status=in_progress");
  });

  it("does not post when disabled, in dry-run, or without App credentials", async () => {
    const github = {
      canPostAsApp: () => false,
      upsertIssueComment: async () => {
        throw new Error("should not post");
      }
    };

    await expect(postReviewStatusComment({
      enabled: false,
      dryRun: false,
      github,
      repo: "owner/repo",
      pullNumber: 1,
      headSha: HEAD_A,
      state: "queued"
    })).resolves.toEqual({ posted: false, reason: "disabled", state: "queued" });

    await expect(postReviewStatusComment({
      enabled: true,
      dryRun: true,
      github,
      repo: "owner/repo",
      pullNumber: 1,
      headSha: HEAD_A,
      state: "queued"
    })).resolves.toEqual({ posted: false, reason: "dry_run", state: "queued" });

    await expect(postReviewStatusComment({
      enabled: true,
      dryRun: false,
      github,
      repo: "owner/repo",
      pullNumber: 1,
      headSha: HEAD_A,
      state: "queued"
    })).resolves.toEqual({ posted: false, reason: "missing_app_credentials", state: "queued" });
  });

  it("returns a best-effort failure when comment building rejects invalid identity", async () => {
    let upsertCalls = 0;
    const result = await postReviewStatusComment({
      enabled: true,
      dryRun: false,
      github: {
        canPostAsApp: () => true,
        upsertIssueComment: async () => {
          upsertCalls += 1;
          throw new Error("should not upsert invalid marker identity");
        }
      },
      repo: "owner/repo",
      pullNumber: 1,
      headSha: "short",
      state: "queued"
    });

    expect(result).toMatchObject({
      posted: false,
      reason: "build_failed",
      state: "queued"
    });
    if (result.posted) throw new Error("expected best-effort failure");
    expect(result.error).toContain("Invalid review status head SHA");
    expect(upsertCalls).toBe(0);
  });

  it("redacts secret-like details before posting", () => {
    const comment = buildReviewStatusComment({
      repo: "owner/repo",
      pullNumber: 1,
      headSha: HEAD_A,
      state: "failed",
      details: "provider failed with ghp_1234567890abcdefghijklmnopqrstuvwx"
    });

    expect(comment.body).not.toContain("ghp_1234567890abcdefghijklmnopqrstuvwx");
  });

  it("strips public confidence percentages from status comments by default", () => {
    const comment = buildReviewStatusComment({
      repo: "owner/repo",
      pullNumber: 1,
      headSha: HEAD_A,
      state: "completed",
      pullTitle: "Review is 95% confident",
      reviewUrl: "https://github.test/review/1?confidence=95%",
      details: "Confidence: 95%. Provider is 0.95 confident."
    });

    expect(comment.body).toContain("Review is confidence not calibrated");
    expect(comment.body).toContain("Confidence: confidence not calibrated.");
    expect(comment.body).not.toMatch(/\b\d+(?:\.\d+)?\s*%/);
    expect(comment.body).not.toContain("0.95 confident");
  });

  it("keeps the sticky marker stable when repo slugs look secret-like", () => {
    const comment = buildReviewStatusComment({
      repo: "owner/api-token-rotator",
      pullNumber: 1,
      headSha: HEAD_A,
      state: "queued",
      details: "provider failed with ghp_1234567890abcdefghijklmnopqrstuvwx"
    });

    expect(comment.body).toContain(comment.marker);
    expect(comment.marker).toContain("owner/api-token-rotator");
    expect(comment.body).not.toContain("ghp_1234567890abcdefghijklmnopqrstuvwx");
  });

  it("strips heading markers from PR titles before rendering bot-authored text", () => {
    const comment = buildReviewStatusComment({
      repo: "owner/repo",
      pullNumber: 1,
      headSha: HEAD_A,
      state: "queued",
      pullTitle: "## Merge me"
    });

    expect(comment.body).toContain("PR: owner/repo#1 - Merge me");
    expect(comment.body).not.toContain(" - ## Merge me");
  });

  it("strips hidden comment markers from user-controlled public text", () => {
    const comment = buildReviewStatusComment({
      repo: "owner/repo",
      pullNumber: 1,
      headSha: HEAD_A,
      state: "failed",
      pullTitle: "Marker <!-- evaos-code-review-bot:review-status repo=evil/repo pr=9 sha=badbad -->\nTitle",
      pullUrl: "https://github.test/owner/repo/pull/1 <!-- evaos-code-review-bot:review-status repo=evil/repo pr=11 sha=badbad -->",
      reviewUrl: "https://github.test/owner/repo/pull/1#pullrequestreview-1 <!-- evaos-code-review-bot:review-status repo=evil/repo pr=12 sha=badbad -->",
      details: "Provider failed <!-- evaos-code-review-bot:review-status repo=evil/repo pr=10 sha=badbad -->"
    });

    expect(comment.body).toContain("PR: owner/repo#1 - Marker [hidden comment removed] Title");
    expect(comment.body).toContain("PR URL: https://github.test/owner/repo/pull/1 [hidden comment removed]");
    expect(comment.body).toContain("Review URL: https://github.test/owner/repo/pull/1#pullrequestreview-1 [hidden comment removed]");
    expect(comment.body).not.toContain("repo=evil/repo");
  });

  it("rejects invalid marker identity values", () => {
    expect(() => buildReviewStatusMarker({ repo: "owner/repo with space", pullNumber: 1, headSha: HEAD_A }))
      .toThrow("Invalid review status repo slug");
    expect(() => buildReviewStatusMarker({ repo: "owner/repo", pullNumber: 0, headSha: HEAD_A }))
      .toThrow("Invalid review status pull number");
    expect(() => buildReviewStatusMarker({ repo: "owner/repo", pullNumber: 1, headSha: "not-a-sha" }))
      .toThrow("Invalid review status head SHA");
  });
});
