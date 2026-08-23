import { afterEach, describe, expect, it, vi } from "vitest";
import { GitHubApi } from "../src/github.js";

describe("issue-enrichment GitHub pagination", () => {
  const originalFetch = globalThis.fetch;

  async function readFullPageStream(kind: "comments" | "events") {
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (url) => {
      calls.push(String(url));
      const page = Number(new URL(String(url)).searchParams.get("page"));
      if (page > 5) throw new Error("pagination probe reached page 6");
      return new Response(JSON.stringify(Array.from({ length: 100 }, (_, index) =>
        kind === "comments"
          ? { id: page * 100 + index, body: "fixture" }
          : { id: page * 100 + index, event: "labeled" }
      )), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const rows = kind === "comments"
      ? await new GitHubApi({ token: "fixture", requestTimeoutMs: 50 }).listIssueComments("owner/repo", 451)
      : await new GitHubApi({ token: "fixture", requestTimeoutMs: 50 }).listIssueLabelEvents("owner/repo", 451);
    return { rows, calls };
  }

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("bounds a permanently full issue-comment page stream", async () => {
    const { rows: comments, calls } = await readFullPageStream("comments");

    expect(comments).toHaveLength(500);
    expect(calls).toHaveLength(5);
    expect(calls.at(-1)).toContain("page=5");
  });

  it("bounds a permanently full issue-label-event page stream", async () => {
    const { rows: events, calls } = await readFullPageStream("events");

    expect(events).toHaveLength(500);
    expect(calls).toHaveLength(5);
    expect(calls.at(-1)).toContain("page=5");
  });
});
