import { afterEach, describe, expect, it, vi } from "vitest";
import { GitHubApi } from "../src/github.js";

describe("bounded issue-comment pagination primitive", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("caps a permanently full stream at five pages and deduplicates in first-seen order", async () => {
    const pages: number[] = [];
    globalThis.fetch = vi.fn(async (url) => {
      const request = new URL(String(url));
      const page = Number(request.searchParams.get("page"));
      pages.push(page);
      const ids = Array.from({ length: 100 }, (_unused, index) => page * 1000 + index);
      if (page > 1) ids[0] = 1000;
      return jsonResponse(ids.map((id) => ({ id })));
    }) as typeof fetch;

    const result = await new GitHubApi({ token: "fixture" }).listIssueCommentsBounded("owner/repo", 738);

    expect(pages).toEqual([1, 2, 3, 4, 5]);
    expect(result.items.slice(0, 4).map((comment) => comment.id)).toEqual([1000, 1001, 1002, 1003]);
    expect(result.items.at(-1)?.id).toBe(5099);
    expect(result.items).toHaveLength(496);
    expect(result.pagesRead).toBe(5);
    expect(result.rawCount).toBe(500);
    expect(result.uniqueCount).toBe(496);
    expect(result.duplicateCount).toBe(4);
    expect(result.terminal).toBe("page_cap");
    expect(result.truncated).toBe(true);
    expect(result.overflow).toBe(true);
  });

  it("stops on a short page and records terminal metadata", async () => {
    const pages: number[] = [];
    globalThis.fetch = vi.fn(async (url) => {
      const request = new URL(String(url));
      const page = Number(request.searchParams.get("page"));
      pages.push(page);
      if (page === 1) return jsonResponse(Array.from({ length: 100 }, (_unused, index) => ({ id: index + 1 })));
      return jsonResponse([{ id: 100 }, { id: 101 }]);
    }) as typeof fetch;

    const result = await new GitHubApi({ token: "fixture" }).listIssueCommentsBounded("owner/repo", 738);

    expect(pages).toEqual([1, 2]);
    expect(result.items.map((comment) => comment.id).slice(-3)).toEqual([99, 100, 101]);
    expect(result.items).toHaveLength(101);
    expect(result.pagesRead).toBe(2);
    expect(result.rawCount).toBe(102);
    expect(result.uniqueCount).toBe(101);
    expect(result.duplicateCount).toBe(1);
    expect(result.terminal).toBe("short_page");
    expect(result.truncated).toBe(false);
    expect(result.overflow).toBe(false);
  });

  it("bounds label-event reads and preserves short-page termination", async () => {
    const pages: number[] = [];
    globalThis.fetch = vi.fn(async (url) => {
      const request = new URL(String(url));
      const page = Number(request.searchParams.get("page"));
      pages.push(page);
      const events = page === 2 ? [{ event: "labeled" }] : Array.from({ length: 100 }, () => ({ event: "labeled" }));
      return jsonResponse(events);
    }) as typeof fetch;
    const result = await new GitHubApi({ token: "fixture" }).listIssueLabelEvents("owner/repo", 738);
    expect(pages).toEqual([1, 2]);
    expect(result).toHaveLength(101);
    expect(result.rawCount).toBe(101);
    expect(result.truncated).toBe(false);
    expect(result.overflow).toBe(false);

    globalThis.fetch = vi.fn(async () => jsonResponse(Array.from({ length: 100 }, () => ({ event: "labeled" })))) as typeof fetch;
    const overflow = await new GitHubApi({ token: "fixture" }).listIssueLabelEvents("owner/repo", 738);
    expect(overflow).toHaveLength(500);
    expect(overflow.rawCount).toBe(500);
    expect(overflow.truncated).toBe(true);
    expect(overflow.overflow).toBe(true);
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}
