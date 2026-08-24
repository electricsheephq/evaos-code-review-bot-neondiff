import { describe, expect, it, vi } from "vitest";
import { GitHubApi } from "../src/github.js";

const page = (start: number, count = 100) => Array.from({ length: count }, (_, i) => ({ id: start + i, event: "labeled" }));
const link = (last: number, next?: number) => `${next ? `<https://api.github.com/events?page=${next}>; rel="next", ` : ""}<https://api.github.com/events?page=${last}>; rel="last"`;

describe("bounded newest issue-event pagination", () => {
  it("probes exact-100 histories, keeps the newest tail, and fails closed on later metadata", async () => {
    const oldFetch = globalThis.fetch;
    try {
      let mode = "probe";
      const calls: number[] = [];
      globalThis.fetch = vi.fn(async (url) => {
        const n = Number(new URL(String(url)).searchParams.get("page")); calls.push(n);
        if (mode === "probe") return new Response(JSON.stringify(n === 1 ? page(1) : []));
        if (mode === "bad") return new Response(JSON.stringify(page(1)), { headers: { link: link(3, 2) } });
        const body = n === 1 ? page(1) : n === 4 ? [{ id: 401 }, ...page(402, 99)] : n === 5 ? [{ id: 401 }, ...page(502, 99)] : page(n * 100 + 1, n === 8 ? 50 : 100);
        return new Response(JSON.stringify(body), { headers: { link: link(8, n < 8 ? n + 1 : undefined) } });
      }) as typeof fetch;
      let result = await new GitHubApi({ token: "fixture" }).listIssueLabelEvents("owner/repo", 970);
      expect(calls).toEqual([1, 2]); expect(result.terminal).toBe("short_page"); expect(result).toHaveLength(100);
      calls.length = 0; mode = "tail";
      result = await new GitHubApi({ token: "fixture" }).listIssueLabelEvents("owner/repo", 970);
      expect(calls).toEqual([1, 4, 5, 6, 7, 8]); expect(result.terminal).toBe("bounded_tail"); expect(result.uniqueCount).toBe(549); expect(result.duplicateCount).toBe(1); expect(result.at(-1)?.id).toBe(850);
      calls.length = 0; mode = "bad";
      result = await new GitHubApi({ token: "fixture" }).listIssueLabelEvents("owner/repo", 970);
      expect(calls).toEqual([1, 2]); expect(result.terminal).toBe("event_history_unbounded"); expect(result.overflow).toBe(true);
    } finally { globalThis.fetch = oldFetch; }
  });
});
