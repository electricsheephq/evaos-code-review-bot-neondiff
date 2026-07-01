import { describe, expect, it } from "vitest";
import {
  buildReviewStatusComment,
  buildReviewStatusMarker,
  postReviewStatusComment
} from "../src/review-status-comment.js";

describe("review status comment", () => {
  it("builds a stable identity marker and mutable state marker", () => {
    const comment = buildReviewStatusComment({
      repo: "owner/repo",
      pullNumber: 274,
      headSha: "abc123",
      state: "queued",
      pullTitle: "Fast PR",
      now: new Date("2026-07-02T00:00:00.000Z")
    });

    expect(comment.marker).toBe("<!-- evaos-code-review-bot:review-status repo=owner/repo pr=274 sha=abc123 -->");
    expect(comment.body).toContain(comment.marker);
    expect(comment.body).toContain("<!-- evaos-code-review-bot:review-status-state status=queued updated_at=2026-07-02T00:00:00.000Z -->");
    expect(comment.body).toContain("evaOS review status: queued");
    expect(comment.body).toContain("agents should wait");
    expect(comment.body).toContain("`provider_deferred` means evaOS still intends to retry");
  });

  it("uses the same marker when state changes for the same head", () => {
    const marker = buildReviewStatusMarker({ repo: "owner/repo", pullNumber: 274, headSha: "abc123" });
    expect(buildReviewStatusComment({ repo: "owner/repo", pullNumber: 274, headSha: "abc123", state: "queued" }).marker)
      .toBe(marker);
    expect(buildReviewStatusComment({ repo: "owner/repo", pullNumber: 274, headSha: "abc123", state: "completed" }).marker)
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
      headSha: "abc123",
      state: "in_progress",
      now: new Date("2026-07-02T00:00:00.000Z")
    });

    expect(result).toMatchObject({ posted: true, action: "created", id: 123, state: "in_progress" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.marker).toBe("<!-- evaos-code-review-bot:review-status repo=owner/repo pr=274 sha=abc123 -->");
    expect(calls[0]?.body).toContain("status=in_progress");
  });

  it("does not post in dry-run or without App credentials", async () => {
    const github = {
      canPostAsApp: () => false,
      upsertIssueComment: async () => {
        throw new Error("should not post");
      }
    };

    await expect(postReviewStatusComment({
      enabled: true,
      dryRun: true,
      github,
      repo: "owner/repo",
      pullNumber: 1,
      headSha: "abc123",
      state: "queued"
    })).resolves.toEqual({ posted: false, reason: "dry_run", state: "queued" });

    await expect(postReviewStatusComment({
      enabled: true,
      dryRun: false,
      github,
      repo: "owner/repo",
      pullNumber: 1,
      headSha: "abc123",
      state: "queued"
    })).resolves.toEqual({ posted: false, reason: "missing_app_credentials", state: "queued" });
  });

  it("redacts secret-like details before posting", () => {
    const comment = buildReviewStatusComment({
      repo: "owner/repo",
      pullNumber: 1,
      headSha: "abc123",
      state: "failed",
      details: "provider failed with ghp_1234567890abcdefghijklmnopqrstuvwx"
    });

    expect(comment.body).not.toContain("ghp_1234567890abcdefghijklmnopqrstuvwx");
  });

  it("strips hidden comment markers from user-controlled public text", () => {
    const comment = buildReviewStatusComment({
      repo: "owner/repo",
      pullNumber: 1,
      headSha: "abcdef",
      state: "failed",
      pullTitle: "Marker <!-- evaos-code-review-bot:review-status repo=evil/repo pr=9 sha=badbad -->\nTitle",
      details: "Provider failed <!-- evaos-code-review-bot:review-status repo=evil/repo pr=10 sha=badbad -->"
    });

    expect(comment.body).toContain("PR: owner/repo#1 - Marker [hidden comment removed] Title");
    expect(comment.body).not.toContain("repo=evil/repo");
  });

  it("rejects invalid marker identity values", () => {
    expect(() => buildReviewStatusMarker({ repo: "owner/repo with space", pullNumber: 1, headSha: "abcdef" }))
      .toThrow("Invalid review status repo slug");
    expect(() => buildReviewStatusMarker({ repo: "owner/repo", pullNumber: 0, headSha: "abcdef" }))
      .toThrow("Invalid review status pull number");
    expect(() => buildReviewStatusMarker({ repo: "owner/repo", pullNumber: 1, headSha: "not-a-sha" }))
      .toThrow("Invalid review status head SHA");
  });
});
