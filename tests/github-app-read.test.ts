import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GitHubApi } from "../src/github.js";

describe("GitHub App read authentication", () => {
  const roots: string[] = [];
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("uses installation tokens for PR read calls when App credentials are configured", async () => {
    const root = mkdtempSync(join(tmpdir(), "github-app-read-"));
    roots.push(root);
    const privateKeyPath = join(root, "app.pem");
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    writeFileSync(privateKeyPath, privateKey.export({ type: "pkcs1", format: "pem" }));

    const calls: Array<{ url: string; authorization?: string }> = [];
    globalThis.fetch = vi.fn(async (url, init) => {
      const authorization = new Headers(init?.headers).get("authorization") ?? undefined;
      calls.push({ url: String(url), authorization });
      if (String(url).endsWith("/repos/owner/repo/installation")) {
        return jsonResponse({ id: 123 });
      }
      if (String(url).endsWith("/app/installations/123/access_tokens")) {
        return jsonResponse({ token: "installation-token", expires_at: "2999-01-01T00:00:00Z" });
      }
      if (String(url).endsWith("/repos/owner/repo/pulls?state=open&per_page=100&page=1")) {
        return jsonResponse([]);
      }
      return jsonResponse({ message: "unexpected" }, 404);
    }) as typeof fetch;

    const github = new GitHubApi({ appId: "4184532", privateKeyPath, token: "fallback-token" });
    await github.listOpenPulls("owner/repo");

    const readCall = calls.find((call) => call.url.endsWith("/repos/owner/repo/pulls?state=open&per_page=100&page=1"));
    expect(readCall?.authorization).toBe("Bearer installation-token");
    expect(readCall?.authorization).not.toBe("Bearer fallback-token");
  });

  it("paginates open PR reads so activation can baseline every listed open head", async () => {
    const root = mkdtempSync(join(tmpdir(), "github-app-read-pages-"));
    roots.push(root);
    const privateKeyPath = join(root, "app.pem");
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    writeFileSync(privateKeyPath, privateKey.export({ type: "pkcs1", format: "pem" }));

    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (url) => {
      calls.push(String(url));
      if (String(url).endsWith("/repos/owner/repo/installation")) {
        return jsonResponse({ id: 123 });
      }
      if (String(url).endsWith("/app/installations/123/access_tokens")) {
        return jsonResponse({ token: "installation-token", expires_at: "2999-01-01T00:00:00Z" });
      }
      if (String(url).endsWith("/repos/owner/repo/pulls?state=open&per_page=100&page=1")) {
        return jsonResponse(Array.from({ length: 100 }, (_, index) => pull(index + 1)));
      }
      if (String(url).endsWith("/repos/owner/repo/pulls?state=open&per_page=100&page=2")) {
        return jsonResponse([pull(101)]);
      }
      return jsonResponse({ message: "unexpected" }, 404);
    }) as typeof fetch;

    const github = new GitHubApi({ appId: "4184532", privateKeyPath });
    const pulls = await github.listOpenPulls("owner/repo");

    expect(pulls).toHaveLength(101);
    expect(calls.some((url) => url.endsWith("/repos/owner/repo/pulls?state=open&per_page=100&page=1"))).toBe(true);
    expect(calls.some((url) => url.endsWith("/repos/owner/repo/pulls?state=open&per_page=100&page=2"))).toBe(true);
  });

  it("normalizes PR repo visibility from private flags on read payloads", async () => {
    const root = mkdtempSync(join(tmpdir(), "github-app-pr-visibility-"));
    roots.push(root);
    const privateKeyPath = join(root, "app.pem");
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    writeFileSync(privateKeyPath, privateKey.export({ type: "pkcs1", format: "pem" }));

    globalThis.fetch = vi.fn(async (url) => {
      if (String(url).endsWith("/repos/owner/repo/installation")) {
        return jsonResponse({ id: 123 });
      }
      if (String(url).endsWith("/app/installations/123/access_tokens")) {
        return jsonResponse({ token: "installation-token", expires_at: "2999-01-01T00:00:00Z" });
      }
      if (String(url).endsWith("/repos/owner/repo/pulls/42")) {
        return jsonResponse(pull(42, { private: true }));
      }
      return jsonResponse({ message: "unexpected" }, 404);
    }) as typeof fetch;

    const github = new GitHubApi({ appId: "4184532", privateKeyPath });
    const result = await github.getPull("owner/repo", 42);

    expect(result.base.repo.private).toBe(true);
    expect(result.base.repo.visibility).toBe("private");
  });

  it("uses installation tokens for related issue reads", async () => {
    const root = mkdtempSync(join(tmpdir(), "github-app-related-issue-"));
    roots.push(root);
    const privateKeyPath = join(root, "app.pem");
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    writeFileSync(privateKeyPath, privateKey.export({ type: "pkcs1", format: "pem" }));

    const calls: Array<{ url: string; authorization?: string }> = [];
    globalThis.fetch = vi.fn(async (url, init) => {
      const authorization = new Headers(init?.headers).get("authorization") ?? undefined;
      calls.push({ url: String(url), authorization });
      if (String(url).endsWith("/repos/owner/repo/installation")) {
        return jsonResponse({ id: 123 });
      }
      if (String(url).endsWith("/app/installations/123/access_tokens")) {
        return jsonResponse({ token: "installation-token", expires_at: "2999-01-01T00:00:00Z" });
      }
      if (String(url).endsWith("/repos/owner/repo/issues/17")) {
        return jsonResponse({ number: 17, title: "Linked issue", state: "open", html_url: "https://github.test/owner/repo/issues/17" });
      }
      return jsonResponse({ message: "unexpected" }, 404);
    }) as typeof fetch;

    const github = new GitHubApi({ appId: "4184532", privateKeyPath, token: "fallback-token" });
    const issue = await github.getIssueOrPull("owner/repo", 17);

    expect(issue?.title).toBe("Linked issue");
    const readCall = calls.find((call) => call.url.endsWith("/repos/owner/repo/issues/17"));
    expect(readCall?.authorization).toBe("Bearer installation-token");
    expect(readCall?.authorization).not.toBe("Bearer fallback-token");
  });

  it("returns undefined for unreadable issue lookups", async () => {
    const root = mkdtempSync(join(tmpdir(), "github-app-issue-missing-"));
    roots.push(root);
    const privateKeyPath = join(root, "app.pem");
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    writeFileSync(privateKeyPath, privateKey.export({ type: "pkcs1", format: "pem" }));

    globalThis.fetch = vi.fn(async (url) => {
      if (String(url).endsWith("/repos/owner/repo/installation")) return jsonResponse({ id: 123 });
      if (String(url).endsWith("/app/installations/123/access_tokens")) return jsonResponse({ token: "installation-token", expires_at: "2999-01-01T00:00:00Z" });
      if (String(url).endsWith("/repos/owner/repo/issues/404")) return jsonResponse({ message: "Resource not accessible by integration" }, 403);
      return jsonResponse({ message: "unexpected" }, 404);
    }) as typeof fetch;

    const github = new GitHubApi({ appId: "4184532", privateKeyPath, token: "fallback-token" });
    await expect(github.getIssueOrPull("owner/repo", 404, { tolerateUnreadable: true })).resolves.toBeUndefined();
    await expect(github.getIssueOrPull("owner/repo", 404)).rejects.toThrow(/Resource not accessible by integration/);
  });

  it("does not hide rate-limited issue lookups as unreadable", async () => {
    const root = mkdtempSync(join(tmpdir(), "github-app-issue-rate-limit-"));
    roots.push(root);
    const privateKeyPath = join(root, "app.pem");
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    writeFileSync(privateKeyPath, privateKey.export({ type: "pkcs1", format: "pem" }));

    globalThis.fetch = vi.fn(async (url) => {
      if (String(url).endsWith("/repos/owner/repo/installation")) return jsonResponse({ id: 123 });
      if (String(url).endsWith("/app/installations/123/access_tokens")) return jsonResponse({ token: "installation-token", expires_at: "2999-01-01T00:00:00Z" });
      if (String(url).endsWith("/repos/owner/repo/issues/403")) return jsonResponse({ message: "API rate limit exceeded for installation" }, 403);
      return jsonResponse({ message: "unexpected" }, 404);
    }) as typeof fetch;

    const github = new GitHubApi({ appId: "4184532", privateKeyPath, token: "fallback-token" });
    await expect(github.getIssueOrPull("owner/repo", 403)).rejects.toThrow(/rate limit/i);
  });

  it("rethrows non-allowlisted 403 issue lookup errors even when unreadable lookups are tolerated", async () => {
    const root = mkdtempSync(join(tmpdir(), "github-app-issue-forbidden-"));
    roots.push(root);
    const privateKeyPath = join(root, "app.pem");
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    writeFileSync(privateKeyPath, privateKey.export({ type: "pkcs1", format: "pem" }));

    globalThis.fetch = vi.fn(async (url) => {
      if (String(url).endsWith("/repos/owner/repo/installation")) return jsonResponse({ id: 123 });
      if (String(url).endsWith("/app/installations/123/access_tokens")) return jsonResponse({ token: "installation-token", expires_at: "2999-01-01T00:00:00Z" });
      if (String(url).endsWith("/repos/owner/repo/issues/403")) return jsonResponse({ message: "SAML enforcement blocks this installation" }, 403);
      return jsonResponse({ message: "unexpected" }, 404);
    }) as typeof fetch;

    const github = new GitHubApi({ appId: "4184532", privateKeyPath, token: "fallback-token" });
    await expect(github.getIssueOrPull("owner/repo", 403, { tolerateUnreadable: true })).rejects.toThrow(/SAML enforcement/);
  });

  it("does not treat the 403 reason phrase as an unreadable issue body", async () => {
    const root = mkdtempSync(join(tmpdir(), "github-app-issue-status-text-"));
    roots.push(root);
    const privateKeyPath = join(root, "app.pem");
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    writeFileSync(privateKeyPath, privateKey.export({ type: "pkcs1", format: "pem" }));

    globalThis.fetch = vi.fn(async (url) => {
      if (String(url).endsWith("/repos/owner/repo/installation")) return jsonResponse({ id: 123 });
      if (String(url).endsWith("/app/installations/123/access_tokens")) return jsonResponse({ token: "installation-token", expires_at: "2999-01-01T00:00:00Z" });
      if (String(url).endsWith("/repos/owner/repo/issues/403")) return jsonResponse({ message: "SAML enforcement blocks this installation" }, 403, "Forbidden");
      return jsonResponse({ message: "unexpected" }, 404);
    }) as typeof fetch;

    const github = new GitHubApi({ appId: "4184532", privateKeyPath, token: "fallback-token" });
    await expect(github.getIssueOrPull("owner/repo", 403, { tolerateUnreadable: true })).rejects.toThrow(/SAML enforcement/);
  });

  it("does not treat incidental Not Found text in a 403 body as an unreadable issue", async () => {
    const root = mkdtempSync(join(tmpdir(), "github-app-issue-403-not-found-text-"));
    roots.push(root);
    const privateKeyPath = join(root, "app.pem");
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    writeFileSync(privateKeyPath, privateKey.export({ type: "pkcs1", format: "pem" }));

    globalThis.fetch = vi.fn(async (url) => {
      if (String(url).endsWith("/repos/owner/repo/installation")) return jsonResponse({ id: 123 });
      if (String(url).endsWith("/app/installations/123/access_tokens")) return jsonResponse({ token: "installation-token", expires_at: "2999-01-01T00:00:00Z" });
      if (String(url).endsWith("/repos/owner/repo/issues/403")) return jsonResponse({ message: "SAML enforcement blocks this installation; nested error: Not Found" }, 403, "Forbidden");
      return jsonResponse({ message: "unexpected" }, 404);
    }) as typeof fetch;

    const github = new GitHubApi({ appId: "4184532", privateKeyPath, token: "fallback-token" });
    await expect(github.getIssueOrPull("owner/repo", 403, { tolerateUnreadable: true })).rejects.toThrow(/SAML enforcement/);
  });

  it("redacts secret-like text from rethrown GitHub response bodies", async () => {
    const root = mkdtempSync(join(tmpdir(), "github-app-issue-redacted-error-"));
    roots.push(root);
    const privateKeyPath = join(root, "app.pem");
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    writeFileSync(privateKeyPath, privateKey.export({ type: "pkcs1", format: "pem" }));
    const leakedToken = "ghp_123456789012345678901234567890123456";

    globalThis.fetch = vi.fn(async (url) => {
      if (String(url).endsWith("/repos/owner/repo/installation")) return jsonResponse({ id: 123 });
      if (String(url).endsWith("/app/installations/123/access_tokens")) return jsonResponse({ token: "installation-token", expires_at: "2999-01-01T00:00:00Z" });
      if (String(url).endsWith("/repos/owner/repo/issues/403")) return jsonResponse({ message: `SAML enforcement ${leakedToken}` }, 403, "Forbidden");
      return jsonResponse({ message: "unexpected" }, 404);
    }) as typeof fetch;

    const github = new GitHubApi({ appId: "4184532", privateKeyPath, token: "fallback-token" });
    await expect(github.getIssueOrPull("owner/repo", 403, { tolerateUnreadable: true })).rejects.toThrow("[redacted-secret]");
    await expect(github.getIssueOrPull("owner/repo", 403, { tolerateUnreadable: true })).rejects.not.toThrow(leakedToken);
  });

  it("updates an existing marked PR walkthrough comment with the App token", async () => {
    const root = mkdtempSync(join(tmpdir(), "github-app-comment-"));
    roots.push(root);
    const privateKeyPath = join(root, "app.pem");
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    writeFileSync(privateKeyPath, privateKey.export({ type: "pkcs1", format: "pem" }));

    const marker = "<!-- evaos-code-review-bot:walkthrough repo=owner/repo pr=42 -->";
    const calls: Array<{ url: string; method: string; authorization?: string; body?: unknown }> = [];
    globalThis.fetch = vi.fn(async (url, init) => {
      const method = init?.method ?? "GET";
      const authorization = new Headers(init?.headers).get("authorization") ?? undefined;
      calls.push({
        url: String(url),
        method,
        authorization,
        body: init?.body ? JSON.parse(String(init.body)) : undefined
      });
      if (String(url).endsWith("/repos/owner/repo/installation")) {
        return jsonResponse({ id: 123 });
      }
      if (String(url).endsWith("/app/installations/123/access_tokens")) {
        return jsonResponse({ token: "installation-token", expires_at: "2999-01-01T00:00:00Z" });
      }
      if (String(url).endsWith("/repos/owner/repo/issues/42/comments?per_page=100&page=1")) {
        return jsonResponse([
          {
            id: 99,
            html_url: "https://github.test/comment/99",
            body: `${marker}\nold`,
            user: { login: "evaos-code-review-bot[bot]", type: "Bot" }
          }
        ]);
      }
      if (String(url).endsWith("/repos/owner/repo/issues/comments/99") && method === "PATCH") {
        return jsonResponse({ id: 99, html_url: "https://github.test/comment/99" });
      }
      return jsonResponse({ message: "unexpected" }, 404);
    }) as typeof fetch;

    const github = new GitHubApi({ appId: "4184532", privateKeyPath });
    const result = await github.upsertIssueComment({
      repo: "owner/repo",
      issueNumber: 42,
      marker,
      body: `${marker}\nnew`
    });

    expect(result).toEqual({ action: "updated", html_url: "https://github.test/comment/99", id: 99 });
    const patchCall = calls.find((call) => call.method === "PATCH");
    expect(patchCall?.authorization).toBe("Bearer installation-token");
    expect(patchCall?.body).toEqual({ body: `${marker}\nnew` });
    expect(
      calls.some((call) => call.method === "POST" && call.url.endsWith("/repos/owner/repo/issues/42/comments"))
    ).toBe(false);
  });

  it("creates a marked PR walkthrough comment when only user-authored marker comments exist", async () => {
    const root = mkdtempSync(join(tmpdir(), "github-app-comment-create-"));
    roots.push(root);
    const privateKeyPath = join(root, "app.pem");
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    writeFileSync(privateKeyPath, privateKey.export({ type: "pkcs1", format: "pem" }));

    const marker = "<!-- evaos-code-review-bot:walkthrough repo=owner/repo pr=42 -->";
    const calls: Array<{ url: string; method: string; authorization?: string; body?: unknown }> = [];
    globalThis.fetch = vi.fn(async (url, init) => {
      const method = init?.method ?? "GET";
      const authorization = new Headers(init?.headers).get("authorization") ?? undefined;
      calls.push({
        url: String(url),
        method,
        authorization,
        body: init?.body ? JSON.parse(String(init.body)) : undefined
      });
      if (String(url).endsWith("/repos/owner/repo/installation")) {
        return jsonResponse({ id: 123 });
      }
      if (String(url).endsWith("/app/installations/123/access_tokens")) {
        return jsonResponse({ token: "installation-token", expires_at: "2999-01-01T00:00:00Z" });
      }
      if (String(url).endsWith("/repos/owner/repo/issues/42/comments?per_page=100&page=1")) {
        return jsonResponse([
          {
            id: 98,
            body: `${marker}\nuser seeded`,
            user: { login: "octocat", type: "User" }
          }
        ]);
      }
      if (String(url).endsWith("/repos/owner/repo/issues/42/comments") && method === "POST") {
        return jsonResponse({ id: 100, html_url: "https://github.test/comment/100" });
      }
      return jsonResponse({ message: "unexpected" }, 404);
    }) as typeof fetch;

    const github = new GitHubApi({ appId: "4184532", privateKeyPath });
    const result = await github.upsertIssueComment({
      repo: "owner/repo",
      issueNumber: 42,
      marker,
      body: `${marker}\nnew`
    });

    expect(result).toEqual({ action: "created", html_url: "https://github.test/comment/100", id: 100 });
    const postCall = calls.find((call) => call.method === "POST" && call.url.endsWith("/repos/owner/repo/issues/42/comments"));
    expect(postCall?.authorization).toBe("Bearer installation-token");
    expect(postCall?.body).toEqual({ body: `${marker}\nnew` });
    expect(calls.some((call) => call.method === "PATCH")).toBe(false);
  });
});

function jsonResponse(body: unknown, status = 200, statusText = ""): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: { "Content-Type": "application/json" }
  });
}

function pull(number: number, repo: { private?: boolean; visibility?: "public" | "private" | "internal" } = {}) {
  return {
    number,
    title: `PR ${number}`,
    draft: false,
    head: {
      sha: `head-${number}`,
      ref: `pr-${number}`
    },
    base: {
      sha: "base",
      ref: "main",
      repo: {
        full_name: "owner/repo",
        ...repo
      }
    },
    html_url: `https://github.test/owner/repo/pull/${number}`
  };
}
