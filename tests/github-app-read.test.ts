import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GitHubApi, normalizeAndValidateGitHubInstallationIdentity } from "../src/github.js";

describe("GitHub App read authentication", () => {
  const roots: string[] = [];
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("projects required identity fields from normal installation metadata", () => {
    const response = canonicalInstallation({
      app_slug: " EVAOS-CODE-REVIEW-BOT[bot] ",
      account: { id: 7, login: "Owner", type: "Organization" },
      events: [{ id: 1, payload: { action: "created" } }],
      single_file_paths: [".github/CODEOWNERS"],
      permissions: { contents: "read" }
    });
    const identity = normalizeAndValidateGitHubInstallationIdentity(response, {
      expectedAppId: "4184532", expectedBotLogin: " evaos-code-review-bot ", repo: "OWNER/repo"
    });
    expect(identity).toEqual({
      id: 123, app_id: 4184532, account_id: 7, account_login: "owner", account_type: "Organization",
      app_slug: "evaos-code-review-bot", bot_login: "evaos-code-review-bot[bot]"
    });
    expect(Object.isFrozen(identity)).toBe(true);
    (response.account as Record<string, unknown>).login = "changed";
    expect(identity.account_login).toBe("owner");
  });

  it.each([
    ["App mismatch", { app_id: 4184533 }, undefined],
    ["account mismatch", { account: { id: 7, login: "other", type: "User" } }, undefined],
    ["account type mismatch", { account: { id: 7, login: "owner", type: "Bot" } }, undefined],
    ["bot mismatch", { app_slug: "other-app" }, undefined],
    ["repository mismatch", {}, "other/repo"],
    ["missing account id", { account: { login: "owner", type: "User" } }, undefined],
    ["missing account type", { account: { id: 7, login: "owner" } }, undefined]
  ])("fails closed for required identity mismatch: %s", (_name, override, repo) => {
    expect(() => normalizeAndValidateGitHubInstallationIdentity(canonicalInstallation(override), {
      expectedAppId: "4184532", expectedBotLogin: "evaos-code-review-bot[bot]", repo: repo ?? "owner/repo"
    })).toThrow(/canonical validation/);
  });

  it("rejects hostile required fields without executing traps or getters", () => {
    let executions = 0;
    const trap = { get: () => (++executions, 1), ownKeys: () => (++executions, []), getPrototypeOf: () => (++executions, Object.prototype) };
    const revocable = Proxy.revocable(canonicalInstallation(), trap);
    revocable.revoke();
    const accessor = canonicalInstallation();
    Object.defineProperty(accessor, "id", { enumerable: true, get: () => (++executions, 123) });
    const nestedAccessor = canonicalInstallation({ account: Object.defineProperty({ id: 7, type: "User" }, "login", {
      enumerable: true, get: () => (++executions, "owner")
    }) });
    const map = canonicalInstallation({ account: new Map([["id", 7]]) });
    const set = canonicalInstallation({ account: new Set([7]) });
    const array = canonicalInstallation({ account: [7, "owner", "User"] });
    const symbol = canonicalInstallation({ app_id: Symbol("app") });
    const cycle: Record<string, unknown> = {};
    cycle.login = cycle;
    const cyclic = canonicalInstallation({ account: { id: 7, login: cycle, type: "User" } });
    const inherited = canonicalInstallation({ account: Object.assign(Object.create({ login: "owner" }), { id: 7, type: "User" }) });
    for (const value of [new Proxy(canonicalInstallation(), trap), revocable.proxy, accessor, nestedAccessor, map, set, array, symbol, cyclic, inherited]) {
      expect(() => normalizeAndValidateGitHubInstallationIdentity(value, {
        expectedAppId: "4184532", expectedBotLogin: "evaos-code-review-bot[bot]", repo: "owner/repo"
      })).toThrow(/canonical validation/);
    }
    expect(executions).toBe(0);
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
        return jsonResponse(canonicalInstallation());
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

  it("applies a finite default request timeout", async () => {
    let signal: AbortSignal | null | undefined;
    globalThis.fetch = vi.fn(async (_url, init) => {
      signal = init?.signal;
      return jsonResponse({ full_name: "owner/repo", private: false });
    }) as typeof fetch;

    await new GitHubApi({ token: "fallback-token" }).getRepo("owner/repo");

    expect(signal).toBeInstanceOf(AbortSignal);
  });

  it("classifies a bounded GitHub timeout", async () => {
    globalThis.fetch = vi.fn((_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    })) as typeof fetch;

    const request = new GitHubApi({ token: "fallback-token", requestTimeoutMs: 10 }).getRepo("owner/repo");

    await expect(request).rejects.toMatchObject({
      name: "GitHubApiTimeoutError",
      failureKind: "timeout",
      timeoutMs: 10
    });
  });

  it("binds a created review to the validated expected commit", async () => {
    const root = mkdtempSync(join(tmpdir(), "github-app-create-review-head-"));
    roots.push(root);
    const privateKeyPath = join(root, "app.pem");
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    writeFileSync(privateKeyPath, privateKey.export({ type: "pkcs1", format: "pem" }));
    const headSha = "a".repeat(40);
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    globalThis.fetch = vi.fn(async (url, init) => {
      calls.push({
        url: String(url),
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : undefined
      });
      if (String(url).endsWith("/repos/owner/repo/installation")) return jsonResponse(canonicalInstallation());
      if (String(url).endsWith("/app/installations/123/access_tokens")) {
        return jsonResponse({ token: "installation-token", expires_at: "2999-01-01T00:00:00Z" });
      }
      if (String(url).endsWith("/repos/owner/repo/pulls/42/reviews")) {
        return jsonResponse({ id: 77, html_url: "https://github.test/review/77" });
      }
      return jsonResponse({ message: "unexpected" }, 404);
    }) as typeof fetch;

    const github = new GitHubApi({ appId: "4184532", privateKeyPath });
    await github.createReview({
      repo: "owner/repo",
      pullNumber: 42,
      headSha,
      event: "COMMENT",
      body: "Review summary",
      comments: []
    });

    expect(calls.find((call) => call.url.endsWith("/repos/owner/repo/pulls/42/reviews"))).toMatchObject({
      method: "POST",
      body: {
        commit_id: headSha,
        event: "COMMENT",
        body: "Review summary",
        comments: []
      }
    });
  });

  it("reads only the exact queued issue comment id", async () => {
    const root = mkdtempSync(join(tmpdir(), "github-app-exact-comment-"));
    roots.push(root);
    const privateKeyPath = join(root, "app.pem");
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    writeFileSync(privateKeyPath, privateKey.export({ type: "pkcs1", format: "pem" }));
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (url) => {
      calls.push(String(url));
      if (String(url).endsWith("/repos/owner/repo/installation")) return jsonResponse(canonicalInstallation());
      if (String(url).endsWith("/app/installations/123/access_tokens")) {
        return jsonResponse({ token: "installation-token", expires_at: "2999-01-01T00:00:00Z" });
      }
      if (String(url).endsWith("/repos/owner/repo/issues/comments/41")) {
        return jsonResponse({ id: 41, body: "bounded command", user: { login: "owner", type: "User" } });
      }
      return jsonResponse({ message: "unexpected" }, 404);
    }) as typeof fetch;

    const github = new GitHubApi({ appId: "4184532", privateKeyPath });
    await expect(github.getIssueComment("owner/repo", 41)).resolves.toMatchObject({ id: 41 });

    expect(calls.filter((url) => url.includes("/issues/"))).toEqual([
      expect.stringMatching(/\/repos\/owner\/repo\/issues\/comments\/41$/)
    ]);
  });

  it("rejects an invalid review head before posting", async () => {
    const root = mkdtempSync(join(tmpdir(), "github-app-create-review-invalid-head-"));
    roots.push(root);
    const privateKeyPath = join(root, "app.pem");
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    writeFileSync(privateKeyPath, privateKey.export({ type: "pkcs1", format: "pem" }));
    globalThis.fetch = vi.fn(async () => jsonResponse({ message: "must not be called" }, 500)) as typeof fetch;

    const github = new GitHubApi({ appId: "4184532", privateKeyPath });
    await expect(github.createReview({
      repo: "owner/repo",
      pullNumber: 42,
      headSha: "not-a-head",
      event: "COMMENT",
      body: "Review summary",
      comments: []
    })).rejects.toThrow(/headSha must be a 40-character hexadecimal commit SHA/);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("preserves GitHub Enterprise API base paths for read calls", async () => {
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (url) => {
      calls.push(String(url));
      if (String(url) === "https://ghe.example.com/api/v3/repos/owner/repo/pulls?state=open&per_page=100&page=1") {
        return jsonResponse([]);
      }
      return jsonResponse({ message: "unexpected" }, 404);
    }) as typeof fetch;

    const github = new GitHubApi({
      token: "fallback-token",
      apiBaseUrl: "https://ghe.example.com/api/v3"
    });
    await github.listOpenPulls("owner/repo");

    expect(calls).toEqual(["https://ghe.example.com/api/v3/repos/owner/repo/pulls?state=open&per_page=100&page=1"]);
  });

  it("rejects credentialed and non-loopback HTTP GitHub API bases", () => {
    expect(() => new GitHubApi({ apiBaseUrl: "https://token@ghe.example.com/api/v3" })).toThrow(/must not include username or password/);
    expect(() => new GitHubApi({ apiBaseUrl: "http://ghe.example.com/api/v3" })).toThrow(/must use https/);
    expect(() => new GitHubApi({ apiBaseUrl: "http://127.0.0.1:3000/api/v3" })).not.toThrow();
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
        return jsonResponse(canonicalInstallation());
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
        return jsonResponse(canonicalInstallation());
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

  it("probes App installation scope, repo visibility, and pull request read access", async () => {
    const root = mkdtempSync(join(tmpdir(), "github-app-scope-proof-"));
    roots.push(root);
    const privateKeyPath = join(root, "app.pem");
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    writeFileSync(privateKeyPath, privateKey.export({ type: "pkcs1", format: "pem" }));

    const calls: Array<{ url: string; authorization?: string }> = [];
    globalThis.fetch = vi.fn(async (url, init) => {
      const authorization = new Headers(init?.headers).get("authorization") ?? undefined;
      calls.push({ url: String(url), authorization });
      if (String(url).endsWith("/repos/owner/repo/installation")) {
        return jsonResponse({
          id: 123,
          app_id: 4184532,
          account: { id: 7, login: "owner", type: "Organization" },
          app_slug: "customer-review-app"
        });
      }
      if (String(url).endsWith("/app/installations/123/access_tokens")) {
        return jsonResponse({ token: "installation-token", expires_at: "2999-01-01T00:00:00Z" });
      }
      if (String(url).endsWith("/repos/owner/repo")) {
        return jsonResponse({ full_name: "owner/repo", private: false, visibility: "public" });
      }
      if (String(url).endsWith("/repos/owner/repo/pulls?state=open&per_page=100&page=1")) {
        return jsonResponse([pull(1, { private: false, visibility: "public" })]);
      }
      return jsonResponse({ message: "unexpected" }, 404);
    }) as typeof fetch;

    const github = new GitHubApi({ appId: "4184532", privateKeyPath });
    const proof = await github.probeRepositoryAccess("owner/repo");

    expect(proof).toMatchObject({
      repo_full_name: "owner/repo",
      readMode: "app_installation",
      visibility_result: "public",
      visibility_source: "repository_api",
      installation_id_present: true,
      installation_id: 123,
      installation_account: "owner",
      app_id: 4184532,
      app_slug: "customer-review-app",
      app_can_read_metadata: true,
      app_can_read_pull_requests: true,
      openPullCount: 1
    });
    expect(calls.find((call) => call.url.endsWith("/repos/owner/repo"))?.authorization).toBe("Bearer installation-token");
    expect(calls.find((call) => call.url.endsWith("/repos/owner/repo/pulls?state=open&per_page=100&page=1"))?.authorization)
      .toBe("Bearer installation-token");
  });

  it("rejects missing and malformed authoritative installation identity before token exchange", async () => {
    const root = mkdtempSync(join(tmpdir(), "github-app-invalid-installation-"));
    roots.push(root);
    const privateKeyPath = join(root, "app.pem");
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    writeFileSync(privateKeyPath, privateKey.export({ type: "pkcs1", format: "pem" }));
    const valid = {
      id: 123,
      app_id: 4184532,
      account: { id: 7, login: "owner", type: "Organization" },
      app_slug: "customer-review-app"
    };
    const cases: Array<{ name: string; installation: unknown }> = [
      { name: "missing installation id", installation: { ...valid, id: undefined } },
      { name: "null installation id", installation: { ...valid, id: null } },
      { name: "wrong-type installation id", installation: { ...valid, id: "123" } },
      { name: "non-positive installation id", installation: { ...valid, id: 0 } },
      { name: "fractional installation id", installation: { ...valid, id: 1.5 } },
      { name: "missing App id", installation: { ...valid, app_id: undefined } },
      { name: "null App id", installation: { ...valid, app_id: null } },
      { name: "wrong-type App id", installation: { ...valid, app_id: "4184532" } },
      { name: "non-positive App id", installation: { ...valid, app_id: -1 } },
      { name: "missing account", installation: { ...valid, account: undefined } },
      { name: "missing account login", installation: { ...valid, account: {} } },
      { name: "null account login", installation: { ...valid, account: { login: null } } },
      { name: "wrong-type account login", installation: { ...valid, account: { login: 42 } } },
      { name: "empty account login", installation: { ...valid, account: { login: "" } } },
      { name: "malformed account login", installation: { ...valid, account: { login: "-bad--owner" } } },
      { name: "oversized account login", installation: { ...valid, account: { login: "a".repeat(40) } } },
      { name: "missing App slug", installation: { ...valid, app_slug: undefined } },
      { name: "null App slug", installation: { ...valid, app_slug: null } },
      { name: "wrong-type App slug", installation: { ...valid, app_slug: 42 } },
      { name: "malformed App slug", installation: { ...valid, app_slug: "Bad_App" } },
      { name: "oversized App slug", installation: { ...valid, app_slug: "a".repeat(101) } }
    ];

    for (const scenario of cases) {
      const calls: string[] = [];
      globalThis.fetch = vi.fn(async (url) => {
        calls.push(String(url));
        return jsonResponse(scenario.installation);
      }) as typeof fetch;
      const proof = await new GitHubApi({ appId: "4184532", privateKeyPath }).probeRepositoryAccess("owner/repo");
      expect(proof, scenario.name).toMatchObject({
        installation_id_present: false,
        app_can_read_metadata: false,
        app_can_read_pull_requests: false,
        github_api_error_class: "unknown"
      });
      expect(calls, scenario.name).toHaveLength(1);
    }
  });

  it("classifies App install-scope and visibility lookup failures without treating them as public", async () => {
    const root = mkdtempSync(join(tmpdir(), "github-app-scope-failures-"));
    roots.push(root);
    const privateKeyPath = join(root, "app.pem");
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    writeFileSync(privateKeyPath, privateKey.export({ type: "pkcs1", format: "pem" }));

    const scenarios: Array<{
      name: string;
      handler: (url: string) => Response;
      expected: Record<string, unknown>;
    }> = [
      {
        name: "missing installation",
        handler: (url) => url.endsWith("/repos/owner/repo/installation")
          ? jsonResponse({ message: "Not Found" }, 404, "Not Found")
          : jsonResponse({ message: "unexpected" }, 404),
        expected: {
          installation_id_present: false,
          app_can_read_metadata: false,
          app_can_read_pull_requests: false,
          github_api_status: 404,
          github_api_error_class: "not_found"
        }
      },
      {
        name: "suspended installation",
        handler: (url) => url.endsWith("/repos/owner/repo/installation")
          ? jsonResponse({ message: "This installation has been suspended" }, 403, "Forbidden")
          : jsonResponse({ message: "unexpected" }, 404),
        expected: {
          installation_id_present: false,
          github_api_status: 403,
          github_api_error_class: "suspended_installation"
        }
      },
      {
        name: "metadata resource inaccessible",
        handler: installThenTokenThen((url) => url.endsWith("/repos/owner/repo")
          ? jsonResponse({ message: "Resource not accessible by integration" }, 403, "Forbidden")
          : jsonResponse({ message: "unexpected" }, 404)),
        expected: {
          installation_id_present: true,
          app_can_read_metadata: false,
          github_api_status: 403,
          github_api_error_class: "resource_not_accessible"
        }
      },
      {
        name: "removed repo metadata",
        handler: installThenTokenThen((url) => url.endsWith("/repos/owner/repo")
          ? jsonResponse({ message: "Not Found" }, 404, "Not Found")
          : jsonResponse({ message: "unexpected" }, 404)),
        expected: {
          installation_id_present: true,
          app_can_read_metadata: false,
          github_api_status: 404,
          github_api_error_class: "not_found"
        }
      },
      {
        name: "renamed or transferred repo metadata",
        handler: installThenTokenThen((url) => url.endsWith("/repos/owner/repo")
          ? jsonResponse({ message: "Moved Permanently" }, 301, "Moved Permanently")
          : jsonResponse({ message: "unexpected" }, 404)),
        expected: {
          installation_id_present: true,
          app_can_read_metadata: false,
          github_api_status: 301,
          github_api_error_class: "renamed_or_transferred"
        }
      },
      {
        name: "rate limited metadata",
        handler: installThenTokenThen((url) => url.endsWith("/repos/owner/repo")
          ? jsonResponse({ message: "API rate limit exceeded" }, 403, "Forbidden")
          : jsonResponse({ message: "unexpected" }, 404)),
        expected: {
          installation_id_present: true,
          app_can_read_metadata: false,
          github_api_status: 403,
          github_api_error_class: "rate_limited"
        }
      },
      {
        name: "missing pull request permission",
        handler: installThenTokenThen((url) => {
          if (url.endsWith("/repos/owner/repo")) {
            return jsonResponse({ full_name: "owner/repo", private: true, visibility: "private" });
          }
          if (url.endsWith("/repos/owner/repo/pulls?state=open&per_page=100&page=1")) {
            return jsonResponse({ message: "Resource not accessible by integration" }, 403, "Forbidden");
          }
          return jsonResponse({ message: "unexpected" }, 404);
        }),
        expected: {
          visibility_result: "private",
          visibility_source: "repository_api",
          installation_id_present: true,
          app_can_read_metadata: true,
          app_can_read_pull_requests: false,
          github_api_status: 403,
          github_api_error_class: "resource_not_accessible"
        }
      }
    ];

    for (const scenario of scenarios) {
      globalThis.fetch = vi.fn(async (url) => scenario.handler(String(url))) as typeof fetch;
      const github = new GitHubApi({ appId: "4184532", privateKeyPath });

      const proof = await github.probeRepositoryAccess("owner/repo");
      expect(proof).toMatchObject({
        repo_full_name: "owner/repo",
        visibility_result: scenario.expected.visibility_result ?? "unknown",
        visibility_source: scenario.expected.visibility_source ?? "unavailable",
        ...scenario.expected
      });
    }
  });

  it("keeps manual redirects scoped to access probes and reuses installation-specific tokens", async () => {
    const root = mkdtempSync(join(tmpdir(), "github-app-redirect-scope-"));
    roots.push(root);
    const privateKeyPath = join(root, "app.pem");
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    writeFileSync(privateKeyPath, privateKey.export({ type: "pkcs1", format: "pem" }));

    const calls: Array<{ url: string; method: string; redirect?: RequestRedirect }> = [];
    globalThis.fetch = vi.fn(async (url, init) => {
      const requestUrl = String(url);
      const method = init?.method ?? "GET";
      const redirect = init?.redirect;
      calls.push({ url: requestUrl, method, redirect });
      if (requestUrl.endsWith("/repos/owner/repo/installation")) {
        return jsonResponse({
          id: 123,
          app_id: 4184532,
          account: { id: 7, login: "owner", type: "Organization" },
          app_slug: "customer-review-app"
        });
      }
      if (requestUrl.endsWith("/app/installations/123/access_tokens")) {
        return jsonResponse({ token: "installation-token", expires_at: "2999-01-01T00:00:00Z" });
      }
      if (requestUrl.endsWith("/repos/owner/repo") && redirect === "manual") {
        return jsonResponse({ message: "Moved Permanently" }, 301, "Moved Permanently");
      }
      if (requestUrl.endsWith("/repos/owner/repo/pulls/42/files?per_page=100&page=1")) {
        return jsonResponse([{ filename: "src/index.ts", patch: "@@ -1 +1 @@" }]);
      }
      return jsonResponse({ message: "unexpected" }, 404);
    }) as typeof fetch;

    const github = new GitHubApi({ appId: "4184532", privateKeyPath });
    await expect(github.probeRepositoryAccess("owner/repo")).resolves.toMatchObject({
      visibility_result: "unknown",
      github_api_status: 301,
      github_api_error_class: "renamed_or_transferred"
    });
    await expect(github.listPullFiles("owner/repo", 42)).resolves.toEqual([{ filename: "src/index.ts", patch: "@@ -1 +1 @@" }]);

    const tokenCalls = calls.filter((call) => call.url.endsWith("/app/installations/123/access_tokens"));
    expect(tokenCalls).toHaveLength(1);
    const installationCalls = calls.filter((call) => call.url.endsWith("/repos/owner/repo/installation"));
    expect(installationCalls).toHaveLength(1);
    const fileReadCall = calls.find((call) => call.url.endsWith("/repos/owner/repo/pulls/42/files?per_page=100&page=1"));
    expect(fileReadCall?.redirect).toBeUndefined();
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
        return jsonResponse(canonicalInstallation());
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
      if (String(url).endsWith("/repos/owner/repo/installation")) return jsonResponse(canonicalInstallation());
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
      if (String(url).endsWith("/repos/owner/repo/installation")) return jsonResponse(canonicalInstallation());
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
      if (String(url).endsWith("/repos/owner/repo/installation")) return jsonResponse(canonicalInstallation());
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
      if (String(url).endsWith("/repos/owner/repo/installation")) return jsonResponse(canonicalInstallation());
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
      if (String(url).endsWith("/repos/owner/repo/installation")) return jsonResponse(canonicalInstallation());
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
    const leakedToken = "ghp_fake_token";

    globalThis.fetch = vi.fn(async (url) => {
      if (String(url).endsWith("/repos/owner/repo/installation")) return jsonResponse(canonicalInstallation());
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
        return jsonResponse(canonicalInstallation());
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

  it("updates a legacy mixed-case issue enrichment marker without creating a duplicate", async () => {
    const root = mkdtempSync(join(tmpdir(), "github-app-issue-enrichment-casefold-"));
    roots.push(root);
    const privateKeyPath = join(root, "app.pem");
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    writeFileSync(privateKeyPath, privateKey.export({ type: "pkcs1", format: "pem" }));

    const marker = "<!-- evaos-code-review-bot:enrichment repo=owner/repo issue=42 -->";
    const legacyMarker = "<!-- evaos-code-review-bot:enrichment repo=Owner/Repo issue=42 -->";
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    globalThis.fetch = vi.fn(async (url, init) => {
      const method = init?.method ?? "GET";
      calls.push({
        url: String(url),
        method,
        body: init?.body ? JSON.parse(String(init.body)) : undefined
      });
      if (String(url).endsWith("/repos/owner/repo/installation")) {
        return jsonResponse(canonicalInstallation());
      }
      if (String(url).endsWith("/app/installations/123/access_tokens")) {
        return jsonResponse({ token: "installation-token", expires_at: "2999-01-01T00:00:00Z" });
      }
      if (String(url).endsWith("/repos/owner/repo/issues/42/comments?per_page=100&page=1")) {
        return jsonResponse([{
          id: 101,
          html_url: "https://github.test/comment/101",
          body: `${legacyMarker}\nold`,
          user: { login: "evaos-code-review-bot[bot]", type: "Bot" }
        }]);
      }
      if (String(url).endsWith("/repos/owner/repo/issues/comments/101") && method === "PATCH") {
        return jsonResponse({ id: 101, html_url: "https://github.test/comment/101" });
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

    expect(result).toEqual({ action: "updated", html_url: "https://github.test/comment/101", id: 101 });
    expect(calls.find((call) => call.method === "PATCH")?.body).toEqual({ body: `${marker}\nnew` });
    expect(calls.some((call) => call.method === "POST" && call.url.endsWith("/repos/owner/repo/issues/42/comments"))).toBe(false);
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
        return jsonResponse(canonicalInstallation());
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

  it("listPullReviewComments is hard-capped: it stops paging after the cap even if pages stay full (#371 bounded read)", async () => {
    // Every page returns a FULL page (100) so the `chunk.length < 100` terminator never fires; only the
    // hard page cap can stop the loop. Assert it does — an unbounded loop would page forever here.
    const pagesRequested: number[] = [];
    globalThis.fetch = vi.fn(async (url) => {
      const match = /\/repos\/owner\/repo\/pulls\/7\/comments\?per_page=100&page=(\d+)$/.exec(String(url));
      if (match) {
        pagesRequested.push(Number(match[1]));
        return jsonResponse(Array.from({ length: 100 }, (_unused, index) => ({ id: Number(match[1]) * 1000 + index })));
      }
      return jsonResponse({ message: "unexpected" }, 404);
    }) as typeof fetch;

    const github = new GitHubApi({ token: "fallback-token" });
    const comments = await github.listPullReviewComments("owner/repo", 7);

    // The reader stopped at the hard cap (5 pages), never paging unboundedly.
    expect(pagesRequested).toEqual([1, 2, 3, 4, 5]);
    expect(comments).toHaveLength(500);
  });

  it("listIssueComments keeps command reads complete beyond the evidence cap", async () => {
    const pagesRequested: number[] = [];
    globalThis.fetch = vi.fn(async (url) => {
      const match = /\/repos\/owner\/repo\/issues\/853\/comments\?per_page=100&page=(\d+)$/.exec(String(url));
      if (match) {
        pagesRequested.push(Number(match[1]));
        if (Number(match[1]) === 6) {
          return jsonResponse([{
            id: 6001,
            body: "@evaos-code-review-bot stop",
            user: { login: "100yenadmin" }
          }]);
        }
        return jsonResponse(Array.from({ length: 100 }, (_unused, index) => ({ id: Number(match[1]) * 1000 + index })));
      }
      return jsonResponse({ message: "unexpected" }, 404);
    }) as typeof fetch;

    const result = await new GitHubApi({ token: "fixture" }).listIssueComments("owner/repo", 853);

    expect(result).toHaveLength(501);
    expect(result.find((comment) => comment.id === 6001)).toMatchObject({
      body: "@evaos-code-review-bot stop"
    });
    expect(pagesRequested).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("listIssueCommentsForEnrichment returns raw-count metadata when its bounded read truncates", async () => {
    globalThis.fetch = vi.fn(async (url) => {
      const match = /\/repos\/owner\/repo\/issues\/853\/comments\?per_page=100&page=(\d+)$/.exec(String(url));
      if (match) return jsonResponse(Array.from({ length: 100 }, (_unused, index) => ({ id: Number(match[1]) * 1000 + index })));
      return jsonResponse({ message: "unexpected" }, 404);
    }) as typeof fetch;

    const result = await new GitHubApi({ token: "fixture" }).listIssueCommentsForEnrichment("owner/repo", 853);

    expect(result).toHaveLength(500);
    expect(result.items).toHaveLength(500);
    expect(result.rawCount).toBe(500);
    expect(result.truncated).toBe(true);
    expect(result.overflow).toBe(true);
  });

  it("listIssueLabelEvents reads only the newest five pages from trusted pagination metadata", async () => {
    const pagesRequested: number[] = [];
    globalThis.fetch = vi.fn(async (url) => {
      const match = /\/repos\/owner\/repo\/issues\/970\/events\?per_page=100&page=(\d+)$/.exec(String(url));
      if (!match) return jsonResponse({ message: "unexpected" }, 404);
      const page = Number(match[1]);
      pagesRequested.push(page);
      if (page > 8) return jsonResponse([]);
      const link = page < 8
        ? `<https://api.github.com/repos/owner/repo/issues/970/events?per_page=100&page=${page + 1}>; rel="next", <https://api.github.com/repos/owner/repo/issues/970/events?per_page=100&page=8>; rel="last"`
        : `<https://api.github.com/repos/owner/repo/issues/970/events?per_page=100&page=1>; rel="first", <https://api.github.com/repos/owner/repo/issues/970/events?per_page=100&page=7>; rel="prev"`;
      return jsonResponse(Array.from({ length: 100 }, (_unused, index) => ({ id: page * 100 + index })), 200, "", { Link: link });
    }) as typeof fetch;
    const result = await new GitHubApi({ token: "fixture" }).listIssueLabelEvents("owner/repo", 970); expect(pagesRequested).toEqual([1, 4, 5, 6, 7, 8]);
    expect(result).toHaveLength(500); expect(result).toMatchObject({ pagesRead: 6, lastPage: 8, terminal: "bounded_tail", truncated: true, overflow: false });
    pagesRequested.length = 0; globalThis.fetch = vi.fn(async (url) => { const page = Number(new URL(String(url)).searchParams.get("page")); pagesRequested.push(page); const link = page === 1 ? '<https://api.github.com/repos/owner/repo/issues/970/events?per_page=100&page=2>; rel="next", <https://api.github.com/repos/owner/repo/issues/970/events?per_page=100&page=2>; rel="last"' : '<https://api.github.com/repos/owner/repo/issues/970/events?per_page=100&page=1>; rel="first", <https://api.github.com/repos/owner/repo/issues/970/events?per_page=100&page=1>; rel="prev"'; return jsonResponse(Array.from({ length: 100 }, (_unused, id) => ({ id: page * 100 + id })), 200, "", { Link: link }); }) as typeof fetch;
    const complete = await new GitHubApi({ token: "fixture" }).listIssueLabelEvents("owner/repo", 970); expect(pagesRequested).toEqual([1, 2]); expect(complete).toMatchObject({ lastPage: 2, terminal: "complete", truncated: false, overflow: false });
    pagesRequested.length = 0;
    globalThis.fetch = vi.fn(async (url) => { const page = Number(new URL(String(url)).searchParams.get("page")); pagesRequested.push(page); return jsonResponse(page <= 2 ? Array.from({ length: 100 }, (_unused, index) => ({ id: page * 100 + index })) : []); }) as typeof fetch;
    const overflow = await new GitHubApi({ token: "fixture" }).listIssueLabelEvents("owner/repo", 970); expect(pagesRequested).toEqual([1, 2]);
    expect(overflow).toMatchObject({ pagesRead: 2, terminal: "event_history_unbounded", truncated: true, overflow: true });
    pagesRequested.length = 0;
    globalThis.fetch = vi.fn(async () => { pagesRequested.push(1); return jsonResponse(Array.from({ length: 50 }, (_unused, id) => ({ id })), 200, "", { Link: '<https://api.github.com/repos/owner/repo/issues/970/events?per_page=100&page=2>; rel="next", <https://api.github.com/repos/owner/repo/issues/970/events?per_page=100&page=2>; rel="last"' }); }) as typeof fetch;
    const contradiction = await new GitHubApi({ token: "fixture" }).listIssueLabelEvents("owner/repo", 970);
    expect(contradiction).toMatchObject({ pagesRead: 1, lastPage: 2, terminal: "event_history_unbounded", overflow: true });
    globalThis.fetch = vi.fn(async (url) => { const page = Number(new URL(String(url)).searchParams.get("page")); return jsonResponse(page === 1 ? Array.from({ length: 100 }, (_unused, id) => ({ id })) : [], 200, "", page === 2 ? { Link: '<https://evil.invalid/repos/owner/repo/issues/970/events?per_page=100&page=2>; rel="last"' } : {}); }) as typeof fetch;
    expect(await new GitHubApi({ token: "fixture" }).listIssueLabelEvents("owner/repo", 970)).toMatchObject({ terminal: "event_history_unbounded", overflow: true });
    globalThis.fetch = vi.fn(async (url) => { const page = Number(new URL(String(url)).searchParams.get("page")); return jsonResponse(Array.from({ length: page === 1 ? 100 : 50 }, (_unused, id) => ({ id: page * 100 + id }))); }) as typeof fetch;
    expect(await new GitHubApi({ token: "fixture" }).listIssueLabelEvents("owner/repo", 970)).toMatchObject({ length: 150, terminal: "complete", truncated: false });
    globalThis.fetch = vi.fn(async (url) => { const page = Number(new URL(String(url)).searchParams.get("page")); if (page === 4) throw new Error("tail unavailable"); return jsonResponse(Array.from({ length: 100 }, (_unused, id) => ({ id })), 200, "", { Link: '<https://api.github.com/repos/owner/repo/issues/970/events?per_page=100&page=2>; rel="next", <https://api.github.com/repos/owner/repo/issues/970/events?per_page=100&page=8>; rel="last"' }); }) as typeof fetch;
    await expect(new GitHubApi({ token: "fixture" }).listIssueLabelEvents("owner/repo", 970)).rejects.toThrow("tail unavailable");
  });
});

function jsonResponse(body: unknown, status = 200, statusText = "", headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: { "Content-Type": "application/json", ...headers }
  });
}

function canonicalInstallation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 123,
    app_id: 4184532,
    account: { id: 7, login: "owner", type: "Organization" },
    app_slug: "evaos-code-review-bot",
    ...overrides
  };
}

function installThenTokenThen(handler: (url: string) => Response): (url: string) => Response {
  return (url: string) => {
    if (url.endsWith("/repos/owner/repo/installation")) {
      return jsonResponse({
        id: 123,
        app_id: 4184532,
        account: { id: 7, login: "owner", type: "Organization" },
        app_slug: "customer-review-app"
      });
    }
    if (url.endsWith("/app/installations/123/access_tokens")) {
      return jsonResponse({ token: "installation-token", expires_at: "2999-01-01T00:00:00Z" });
    }
    return handler(url);
  };
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
