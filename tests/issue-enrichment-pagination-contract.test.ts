import { afterEach, describe, expect, it, vi } from "vitest";
import { GithubPaginationOverflowError, GitHubApi } from "../src/github.js";

describe("bounded issue-enrichment GitHub readers", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("keeps issue comments in page order and marks a full five-page read", async () => {
    const pages: number[] = [];
    globalThis.fetch = fullPageTransport("comments", pages);
    const result = await new GitHubApi({ token: "fixture" }).listIssueCommentsForEnrichment("owner/repo", 738);

    expect(pages).toEqual([1, 2, 3, 4, 5]);
    expect(result).toHaveLength(500);
    expect(result.items.slice(0, 3).map((comment) => comment.id)).toEqual([100, 101, 102]);
    expect(result.items.slice(-3).map((comment) => comment.id)).toEqual([597, 598, 599]);
    expect(result.rawCount).toBe(500);
    expect(result.truncated).toBe(true);
    expect(result.overflow).toBe(true);
  });

  it("returns label events in page order with explicit truncation metadata", async () => {
    const pages: number[] = [];
    globalThis.fetch = fullPageTransport("events", pages);
    const result = await new GitHubApi({ token: "fixture" }).listIssueLabelEvents("owner/repo", 738);

    expect(pages).toEqual([1, 2, 3, 4, 5]);
    expect(result).toHaveLength(500);
    expect(result.items[0]?.event).toBe("1:0");
    expect(result.items[499]?.event).toBe("5:99");
    expect(result.rawCount).toBe(500);
    expect(result.truncated).toBe(true);
    expect(result.overflow).toBe(true);
  });

  it("fails closed after five full marker pages", async () => {
    const pages: number[] = [];
    globalThis.fetch = fullPageTransport("marker", pages);
    const api = new GitHubApi({ token: "fixture" });
    const findMarker = (api as unknown as { findIssueCommentByMarker: (...args: string[]) => Promise<unknown> }).findIssueCommentByMarker.bind(api);

    await expect(findMarker("owner/repo", "738", "marker", "fixture")).rejects.toMatchObject({
      name: "GithubPaginationOverflowError",
      kind: "issue_comment_marker"
    } satisfies Partial<GithubPaginationOverflowError>);
    expect(pages).toEqual([1, 2, 3, 4, 5]);
  });
});

function fullPageTransport(kind: "comments" | "events" | "marker", pages: number[]) {
  return vi.fn(async (url) => {
    const page = Number(new URL(String(url)).searchParams.get("page"));
    pages.push(page);
    const body = Array.from({ length: 100 }, (_unused, index) => {
      if (kind === "events") return { event: `${page}:${index}` };
      return {
        id: page * 100 + index,
        body: "unrelated",
        ...(kind === "marker" ? { user: { type: "Bot", login: "evaos-code-review-bot[bot]" } } : {})
      };
    });
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}
