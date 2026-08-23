import { afterEach, describe, expect, it, vi } from "vitest";
import { GitHubApi } from "../src/github.js";

describe("bounded GitHub pagination contracts", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("returns explicit truncation metadata for comments", async () => {
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (url) => {
      calls.push(String(url));
      return new Response(JSON.stringify(Array.from({ length: 100 }, (_, id) => ({ id, body: "fixture" }))), { status: 200 });
    }) as typeof fetch;
    const result = await new GitHubApi({ token: "fixture" }).listIssueComments("owner/repo", 451);
    expect(result).toHaveLength(500);
    expect(result.items).toHaveLength(500);
    expect(result.truncated).toBe(true);
    expect(result.overflow).toBe(true);
    expect(calls).toHaveLength(5);
  });

  it("returns explicit truncation metadata for label events", async () => {
    globalThis.fetch = vi.fn(async () => new Response(
      JSON.stringify(Array.from({ length: 100 }, (_, id) => ({ id, event: "labeled" }))),
      { status: 200 }
    )) as typeof fetch;
    const result = await new GitHubApi({ token: "fixture" }).listIssueLabelEvents("owner/repo", 451);
    expect(result.items).toHaveLength(500);
    expect(result.truncated).toBe(true);
    expect(result.overflow).toBe(true);
  });

  it("fails closed when marker duplicate detection reaches the cap", async () => {
    globalThis.fetch = vi.fn(async () => new Response(
      JSON.stringify(Array.from({ length: 100 }, (_, id) => ({ id, body: "fixture", user: { type: "Bot", login: "evaos-code-review-bot[bot]" } }))),
      { status: 200 }
    )) as typeof fetch;
    const api = new GitHubApi({ token: "fixture" }) as unknown as {
      findIssueCommentByMarker: (repo: string, issueNumber: number, marker: string, token: string) => Promise<unknown>;
    };
    await expect(api.findIssueCommentByMarker("owner/repo", 451, "marker", "fixture"))
      .rejects.toThrow("GitHub issue comment marker scan exceeded page limit");
  });
});
