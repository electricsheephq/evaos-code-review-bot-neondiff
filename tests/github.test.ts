import { describe, expect, it, vi } from "vitest";
import { GitHubApi } from "../src/github.js";

const json = (body: unknown, link?: string) => new Response(JSON.stringify(body), { status: 200, headers: { ...(link ? { link } : {}) } });
const page = (start: number, count = 100) => Array.from({ length: count }, (_, i) => ({ id: start + i, event: "labeled" }));
const run = async (handler: (n: number) => Response) => {
  const old = globalThis.fetch; const calls: number[] = [];
  globalThis.fetch = vi.fn(async (url) => { const n = Number(new URL(String(url)).searchParams.get("page")); calls.push(n); return handler(n); }) as typeof fetch;
  try { return { result: await new GitHubApi({ token: "fixture" }).listIssueLabelEvents("owner/repo", 970), calls }; }
  finally { globalThis.fetch = old; }
};

describe("bounded newest issue-event pagination", () => {
  it("keeps a short history bounded", async () => {
    const { result, calls } = await run(() => json(page(1, 2)));
    expect(calls).toEqual([1]); expect(result.terminal).toBe("short_page"); expect(result.pagesRead).toBe(1);
  });
  it("uses a five-page tail, skips page-one overlap, and deduplicates IDs", async () => {
    const { result, calls } = await run((n) => {
      const body = n === 1 ? page(1) : n === 4 ? [{ id: 401, event: "labeled" }, ...page(402, 99)] : n === 5 ? [{ id: 401, event: "labeled" }, ...page(502, 99)] : page(n * 100 + 1, n === 8 ? 50 : 100);
      return json(body, '<https://api.github.com/events?page=8>; rel="last"');
    });
    expect(calls).toEqual([1, 4, 5, 6, 7, 8]); expect(result.lastPage).toBe(8);
    expect(result.pagesRead).toBe(6); expect(result.uniqueCount).toBe(549); expect(result.duplicateCount).toBe(1); expect(result.terminal).toBe("bounded_tail");
  });
  it("reads exactly five pages when the last page is five", async () => {
    const { result, calls } = await run((n) => json(page((n - 1) * 100 + 1), '<https://api.github.com/events?page=5>; rel="last"'));
    expect(calls).toEqual([1, 2, 3, 4, 5]); expect(result).toHaveLength(500); expect(result.lastPage).toBe(5);
  });
  it.each([undefined, '<https://api.github.com/events?page=nope>; rel="last"', '<https://api.github.com/events?page=0>; rel="last"', '<https://api.github.com/events?page=3>; rel="next", <https://api.github.com/events?page=2>; rel="last"'])
    ("makes untrusted last-page metadata terminal", async (link) => {
      const { result, calls } = await run(() => json(page(1), link));
      expect(calls).toEqual([1]); expect(result.terminal).toBe("event_history_unbounded"); expect(result.overflow).toBe(true);
    });
});
