import { afterEach, describe, expect, it, vi } from "vitest";
import { GitHubApi } from "../src/github.js";

describe("issue-enrichment GitHub pagination", () => {
  const originalFetch = globalThis.fetch;

  async function readFullPageStream(kind: "comments" | "events") {
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (url) => {
      calls.push(String(url));
      const page = Number(new URL(String(url)).searchParams.get("page"));
      if (page > 5) throw new Error("pagination probe reached omitted newer unauthorized event");
      return new Response(JSON.stringify(Array.from({ length: 100 }, (_, index) => kind === "comments" ? { id: page * 100 + index, body: "fixture" } : page === 1 && index === 0 ? { event: "labeled", created_at: "2026-08-01T00:00:00Z", actor: { login: "older-trusted" }, label: { name: "active-continuation" } } : { event: "labeled" })), { status: 200 });
    }) as typeof fetch;
    try {
      const api = new GitHubApi({ token: "fixture", requestTimeoutMs: 50 });
      const rows = kind === "comments" ? await api.listIssueComments("owner/repo", 451) : await api.listIssueLabelEvents("owner/repo", 451);
      return { rows, calls };
    } catch (error) {
      return { rows: [], calls, error };
    }
  }

  afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

  it("bounds a permanently full issue-comment page stream", async () => {
    const { rows: comments, calls } = await readFullPageStream("comments"); expect(comments).toHaveLength(500); expect(calls).toHaveLength(5);
  });

  it("fails closed on a permanently full issue-label-event page stream", async () => {
    const { calls, error } = await readFullPageStream("events"); expect(error).toMatchObject({ message: "GitHub issue label event scan exceeded page limit" }); expect(calls).toHaveLength(5);
  });
});
