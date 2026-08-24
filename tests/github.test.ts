import { describe, expect, it, vi } from "vitest";
import { GitHubApi } from "../src/github.js";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

describe("bounded label-event pagination", () => {
  it("terminates on a short page and caps a permanently full stream at five pages", async () => {
    const originalFetch = globalThis.fetch;
    try {
      const pages: number[] = [];
      globalThis.fetch = vi.fn(async (url) => {
        const page = Number(new URL(String(url)).searchParams.get("page"));
        pages.push(page);
        return jsonResponse(page === 2 ? [{ event: "labeled" }] : Array.from({ length: 100 }, () => ({ event: "labeled" })));
      }) as typeof fetch;
      const complete = await new GitHubApi({ token: "fixture" }).listIssueLabelEvents("owner/repo", 738);
      expect(pages).toEqual([1, 2]);
      expect(complete).toHaveLength(101);
      expect(complete.truncated).toBe(false);
      expect(complete.overflow).toBe(false);

      pages.length = 0;
      globalThis.fetch = vi.fn(async (url) => {
        pages.push(Number(new URL(String(url)).searchParams.get("page")));
        return jsonResponse(Array.from({ length: 100 }, () => ({ event: "labeled" })));
      }) as typeof fetch;
      const overflow = await new GitHubApi({ token: "fixture" }).listIssueLabelEvents("owner/repo", 738);
      expect(pages).toEqual([1, 2, 3, 4, 5]);
      expect(overflow).toHaveLength(500);
      expect(overflow.rawCount).toBe(500);
      expect(overflow.truncated).toBe(true);
      expect(overflow.overflow).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
