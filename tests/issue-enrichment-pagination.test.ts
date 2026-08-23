import { afterEach, describe, expect, it, vi } from "vitest";
import { GitHubApi } from "../src/github.js";

describe("issue-enrichment GitHub pagination", () => {
  const originalFetch = globalThis.fetch;

  async function fullStream(kind: "comments" | "events") {
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (url) => {
      calls.push(String(url));
      const page = Number(new URL(String(url)).searchParams.get("page"));
      if (page > 5) throw new Error("pagination probe reached page 6");
      return new Response(JSON.stringify(Array.from({ length: 100 }, (_, index) =>
        kind === "comments" ? { id: page * 100 + index, body: "fixture" } : { event: "labeled" }
      )), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      const api = new GitHubApi({ token: "fixture", requestTimeoutMs: 50 });
      const rows = kind === "comments"
        ? await api.listIssueCommentsForEnrichment("owner/repo", 451)
        : await api.listIssueLabelEvents("owner/repo", 451);
      return { rows, calls };
    } catch (error) {
      return { rows: [], calls, error };
    }
  }

  afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

  it("bounds permanently full enrichment comments", async () => {
    const { rows, calls } = await fullStream("comments");
    expect(rows).toHaveLength(500);
    expect((rows as { overflow?: boolean }).overflow).toBe(true);
    expect(calls).toHaveLength(5);
  });

  it("fails closed on permanently full label events", async () => {
    const { calls, error } = await fullStream("events");
    expect(error).toMatchObject({ message: "GitHub issue label event scan exceeded page limit" });
    expect(calls).toHaveLength(5);
  });

  it("fails closed when marker lookup reaches five full pages", async () => {
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (url) => {
      calls.push(String(url));
      const page = Number(new URL(String(url)).searchParams.get("page"));
      if (page > 5) throw new Error("pagination probe reached page 6");
      return new Response(JSON.stringify(Array.from({ length: 100 }, (_, index) => ({
        id: page * 100 + index, body: "unrelated", user: { type: "Bot", login: "evaos-code-review-bot[bot]" }
      }))), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const api = new GitHubApi({ token: "fixture", requestTimeoutMs: 50 });
    const findMarker = (api as unknown as { findIssueCommentByMarker: (...args: string[]) => Promise<unknown> }).findIssueCommentByMarker.bind(api);
    await expect(findMarker("owner/repo", "451", "marker", "fixture"))
      .rejects.toThrow("GitHub issue comment marker scan exceeded page limit");
    expect(calls).toHaveLength(5);
  });
});
