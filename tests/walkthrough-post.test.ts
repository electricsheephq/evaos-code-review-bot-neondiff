import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { postWalkthroughComment, reviewBodyAfterWalkthroughPost } from "../src/walkthrough-post.js";

describe("walkthrough comment posting", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("records a non-fatal error when sticky comment posting fails", async () => {
    const evidenceDir = mkdtempSync(join(tmpdir(), "walkthrough-post-"));
    roots.push(evidenceDir);

    const result = await postWalkthroughComment({
      github: {
        canPostAsApp: () => true,
        upsertIssueComment: async () => {
          throw new Error("GitHub API 502 bad gateway for /issues/comments");
        }
      },
      repo: "owner/repo",
      pullNumber: 42,
      evidenceDir,
      walkthrough: {
        marker: "<!-- evaos-code-review-bot:walkthrough repo=owner/repo pr=42 -->",
        body: "body",
        postIssueComment: true
      }
    });

    expect(result).toEqual({ posted: false, reason: "upsert_failed" });
    const errorPath = join(evidenceDir, "walkthrough-comment-error.txt");
    expect(existsSync(errorPath)).toBe(true);
    expect(readFileSync(errorPath, "utf8")).toContain("GitHub API 502 bad gateway");
  });

  it("skips sticky comment posting when App credentials are unavailable", async () => {
    const evidenceDir = mkdtempSync(join(tmpdir(), "walkthrough-post-"));
    roots.push(evidenceDir);

    const result = await postWalkthroughComment({
      github: {
        canPostAsApp: () => false,
        upsertIssueComment: async () => {
          throw new Error("should not be called");
        }
      },
      repo: "owner/repo",
      pullNumber: 42,
      evidenceDir,
      walkthrough: {
        marker: "<!-- evaos-code-review-bot:walkthrough repo=owner/repo pr=42 -->",
        body: "body",
        postIssueComment: true
      }
    });

    expect(result).toEqual({ posted: false, reason: "missing_app_credentials" });
    expect(existsSync(join(evidenceDir, "walkthrough-comment-error.txt"))).toBe(false);
  });

  it("falls back to the walkthrough review body when sticky posting is unavailable", () => {
    expect(
      reviewBodyAfterWalkthroughPost({
        summary: "compact summary",
        walkthrough: {
          marker: "<!-- evaos-code-review-bot:walkthrough repo=owner/repo pr=42 -->",
          body: "walkthrough body",
          postIssueComment: true
        },
        walkthroughComment: { posted: false, reason: "missing_app_credentials" }
      })
    ).toBe("walkthrough body");
  });

  it("keeps the compact review body when sticky posting succeeds", () => {
    expect(
      reviewBodyAfterWalkthroughPost({
        summary: "compact summary",
        walkthrough: {
          marker: "<!-- evaos-code-review-bot:walkthrough repo=owner/repo pr=42 -->",
          body: "walkthrough body",
          postIssueComment: true
        },
        walkthroughComment: { posted: true, action: "updated", id: 123 }
      })
    ).toBe("compact summary");
  });
});
