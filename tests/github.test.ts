import { afterEach, describe, expect, it, vi } from "vitest";
import { GitHubApi } from "../src/github.js";

describe("bounded issue-label pagination", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("returns overflow metadata after exactly five full pages", async () => {
    const pages: number[] = [];
    globalThis.fetch = vi.fn(async (url) => {
      const page = Number(new URL(String(url)).searchParams.get("page"));
      pages.push(page);
      return new Response(JSON.stringify(Array.from({ length: 100 }, () => ({ event: "labeled" }))), { status: 200 });
    }) as typeof fetch;

    const result = await new GitHubApi({ token: "fixture" }).listIssueLabelEvents("owner/repo", 738);

    expect(pages).toEqual([1, 2, 3, 4, 5]);
    expect(result).toHaveLength(500);
    expect(result.items).toHaveLength(500);
    expect(result.rawCount).toBe(500);
    expect(result.truncated).toBe(true);
    expect(result.overflow).toBe(true);
  });

  it("stops at the first short page without claiming truncation", async () => {
    const pages: number[] = [];
    globalThis.fetch = vi.fn(async (url) => {
      const page = Number(new URL(String(url)).searchParams.get("page"));
      pages.push(page);
      return new Response(JSON.stringify(Array.from({ length: page === 2 ? 2 : 100 }, () => ({ event: "labeled" }))), { status: 200 });
    }) as typeof fetch;

    const result = await new GitHubApi({ token: "fixture" }).listIssueLabelEvents("owner/repo", 738);

    expect(pages).toEqual([1, 2]);
    expect(result.rawCount).toBe(102);
    expect(result.truncated).toBe(false);
    expect(result.overflow).toBe(false);
  });
});
