import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findPostedCiReview } from "../src/ci-mode.js";
import { buildWalkthroughComment, buildWalkthroughMarker } from "../src/walkthrough.js";
import { appendReviewAttribution, buildReviewBodyForPost, postWalkthroughComment, reviewBodyAfterWalkthroughPost } from "../src/walkthrough-post.js";

function findReview(body: string, repo: string) {
  const user = { login: "neondiff[bot]", type: "Bot" as const };
  const head = "a".repeat(40);
  return findPostedCiReview({
    postingIdentity: async () => user,
    listPullReviews: async () => [{ id: 1, commit_id: head, body, user }]
  }, repo, 42, head);
}

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
      render: (lines) => `${"a".repeat(64_500)}\n\n${lines.join("\n")}`
    });
    expect(result.body.length).toBeLessThanOrEqual(65_000);
    expect(result.body).toContain("src/generated.ts:7");
    expect(result.body).not.toContain("Fallback title");
    expect(result.body).not.toContain("Full detail");
    expect(result.publishedOutsideDiffFindings).toEqual([finding]);
  });

  it("leaves a formerly postable 63,000-character body intact", () => {
    const prose = "a".repeat(63_000);
    const result = buildReviewBodyForPost({ repo: "owner/repo", model: "fixture", outsideDiffFindings: [], render: () => prose });
    expect(result.body).toBe(appendReviewAttribution(prose, "fixture"));
  });

  it.each(["owner/repo", "ElectricSheepHQ/LCM-X"])("keeps a trailing walkthrough marker when truncating prose for %s", async (repo) => {
    const marker = buildWalkthroughMarker({ repo, pullNumber: 42 });
    const prose = `<details>\n\n\`\`\`ts\nif (a < b) start();\n${"a".repeat(66_000)}\n\`\`\`\n\n</details>\n${marker}`;
    const { body } = buildReviewBodyForPost({ repo, model: "fixture", outsideDiffFindings: [], render: () => prose });
    expect(body.length).toBeLessThanOrEqual(65_000);
    expect(body).toContain(`\n~~~\n\n… (truncated)\n\n${marker}`);
    expect(body).toMatch(/^~~~\n<details>\n/);
    expect(body).toContain("if (a < b) start();");
    if (repo === "owner/repo") expect(body).toBe(appendReviewAttribution(body, "fixture"));
    await expect(findReview(body, repo)).resolves.toEqual({ id: 1 });
  });

  it("cuts before the last fitting generated section and preserves both walkthrough markers and the footer", async () => {
    const repo = "owner/repo";
    const head = "a".repeat(40);
    const { body } = buildReviewBodyForPost({
      repo, model: "fixture", outsideDiffFindings: [],
      render: (_lines, _countMode, sectionStarts) => buildWalkthroughComment({
        repo, files: [], comments: [], dropped: [], event: "COMMENT", sectionStarts,
        pull: { number: 42, title: "Fixture", draft: false, html_url: "", head: { sha: head, ref: "feature" },
          base: { sha: "b".repeat(40), ref: "main", repo: { full_name: repo } } },
        modelSummary: { changedBehavior: Array(20).fill("first line\n### Injected heading\n" + "x".repeat(4000)),
          invariants: [], evidence: [], limitations: [], noFindingRationale: "fixture" }
      }).body
    });
    expect(body.length).toBeLessThanOrEqual(65_000);
    expect(body).toMatch(/^<!-- evaos-code-review-bot:walkthrough .* -->\n<!-- evaos-code-review-bot:walkthrough-state .* -->\n## Walkthrough/);
    expect(body).toContain("### Review Signal\n\nNo validated inline findings.");
    expect(body).toContain("High-severity findings: 0.\n\n… (truncated: later sections omitted)\n\nReviewed by");
    expect(body).not.toMatch(/### (Maintainer Analysis|Injected heading)/);
    await expect(findReview(body, repo)).resolves.toEqual({ id: 1 });
  });

  it("still finds an oversized summary by its attribution footer alone", async () => {
    const repo = "owner/repo";
    const { body } = buildReviewBodyForPost({ repo, model: "fixture", outsideDiffFindings: [], render: () => "a".repeat(66_000) });
    expect(body).toBe(appendReviewAttribution(body, "fixture"));
    await expect(findReview(body, repo)).resolves.toEqual({ id: 1 });
  });

  it.each([8000, 8150])("keeps the LCM assessment and includes the severity count when it fits (%i characters)", async (length) => {
    const finding = {
      path: "src/generated.ts", line: 7, title: "Long title ".repeat(40), body: "Full detail ".repeat(125),
      severity: "P1" as const, category: "runtime_correctness" as const, confidence: 0.9, fingerprint: "fixture"
    };
    const assessment = "<!-- lcm-x-ai-review:v2\nfixture\n-->";
    const result = buildReviewBodyForPost({
      repo: "ElectricSheepHQ/LCM-X", model: "fixture", outsideDiffFindings: [finding], assessment,
      render: (lines) => `${"a".repeat(length)}\n\n${lines.join("\n")}`
    });
    expect(result.body.includes("Findings outside the diff view: 1 finding, highest P1.")).toBe(length === 8000);
    expect(result.body).not.toContain("See the review evidence");
    expect(result.body.endsWith(assessment)).toBe(true);
    expect(result.publishedOutsideDiffFindings).toEqual([]);
    await expect(findReview(result.body, "ElectricSheepHQ/LCM-X")).resolves.toEqual({ id: 1 });
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
