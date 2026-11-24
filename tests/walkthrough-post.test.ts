import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildReviewBodyForPost, postWalkthroughComment, reviewBodyAfterWalkthroughPost } from "../src/walkthrough-post.js";

describe("walkthrough comment posting", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("uses only path and line when the assembled review would exceed the GitHub safety limit", () => {
    const finding = {
      path: "src/generated.ts", line: 7, title: "Fallback title", body: "Full detail ".repeat(125),
      severity: "P2" as const, category: "runtime_correctness" as const, confidence: 0.9, fingerprint: "fixture"
    };
    const result = buildReviewBodyForPost({
      repo: "owner/repo", model: "fixture", outsideDiffFindings: [finding],
      render: (lines) => `${"a".repeat(59_500)}\n\n${lines.join("\n")}`
    });
    expect(result.body.length).toBeLessThanOrEqual(60_000);
    expect(result.body).toContain("src/generated.ts:7");
    expect(result.body).not.toContain("Fallback title");
    expect(result.body).not.toContain("Full detail");
    expect(result.publishedOutsideDiffFindings).toEqual([finding]);
  });

  it("uses an evidence count when even titles would displace the LCM assessment", () => {
    const finding = {
      path: "src/generated.ts", line: 7, title: "Long title ".repeat(40), body: "Full detail ".repeat(125),
      severity: "P2" as const, category: "runtime_correctness" as const, confidence: 0.9, fingerprint: "fixture"
    };
    const assessment = "<!-- lcm-x-ai-review:v2\nfixture\n-->";
    const result = buildReviewBodyForPost({
      repo: "ElectricSheepHQ/LCM-X", model: "fixture", outsideDiffFindings: [finding], assessment,
      render: (lines) => `${"a".repeat(8000)}\n\n${lines.join("\n")}`
    });
    expect(result.body).toContain("Findings outside the diff view: 1.");
    expect(result.body.endsWith(assessment)).toBe(true);
    expect(result.publishedOutsideDiffFindings).toEqual([]);
  });

  it("records a non-fatal error when sticky comment posting fails", async () => {
    const evidenceDir = mkdtempSync(join(tmpdir(), "walkthrough-post-"));
    roots.push(evidenceDir);

    const result = await postWalkthroughComment({
      github: {
        canPost: () => true,
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
        canPost: () => false,
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
