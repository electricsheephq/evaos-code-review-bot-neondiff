import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCiConfig, findPostedCiReview, readCiPullContext } from "../src/ci-mode.js";
import { buildReviewProviderMetadata, runOnce } from "../src/worker.js";
import { loadConfig } from "../src/config.js";
import { GitHubApi } from "../src/github.js";
import { buildCodexRuntimeEnv } from "../src/codex-runtime.js";
import { appendReviewAttribution, reviewBodyAfterWalkthroughPost } from "../src/walkthrough-post.js";
import { requireActiveProductionLicense, authorizeAdmissionForVisibility, requireActiveDaemonCycleAdmissions } from "../src/license-admission.js";

const roots: string[] = [];
const sha = "a".repeat(40);
function context(event: unknown, name = "pull_request_target") {
  const root = mkdtempSync(join(tmpdir(), "neondiff-ci-test-")); roots.push(root);
  const path = join(root, "event.json"); writeFileSync(path, JSON.stringify(event));
  const codex = join(root, "codex"); writeFileSync(codex, "#!/bin/sh\nexit 0\n"); chmodSync(codex, 0o700);
  return { GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "owner/repo", GITHUB_EVENT_PATH: path, GITHUB_EVENT_NAME: name, PATH: root, RUNNER_TEMP: root };
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("CI review", () => {
  it("reads pull_request_target identity", () => {
    expect(readCiPullContext(context({ pull_request: { number: 42, head: { sha } } }))).toEqual({ repo: "owner/repo", pullNumber: 42, headSha: sha, eventName: "pull_request_target" });
  });
  it("reads issue_comment on a PR, requiring a live head lookup", () => {
    expect(readCiPullContext(context({ issue: { number: 7, pull_request: { url: "fixture" } } }, "issue_comment"))).toMatchObject({ pullNumber: 7, headSha: undefined });
  });
  it("rejects issue comments on ordinary issues", () => {
    expect(() => readCiPullContext(context({ issue: { number: 7 } }, "issue_comment"))).toThrow(/pull request/);
  });
  it("rejects missing environment and malformed event identities", () => {
    expect(() => readCiPullContext({})).toThrow(/GitHub Actions/);
    for (const key of ["GITHUB_REPOSITORY", "GITHUB_EVENT_PATH"]) {
      const env = context({ pull_request: { number: 1, head: { sha } } });
      delete (env as Record<string, string>)[key];
      expect(() => readCiPullContext(env)).toThrow(key);
    }
    expect(() => readCiPullContext(context({ pull_request: { number: -1, head: { sha } } }))).toThrow();
    expect(() => readCiPullContext(context({ pull_request: { number: 1, head: { sha: "bad" } } }))).toThrow(/head/);
    const env = context({}); writeFileSync(env.GITHUB_EVENT_PATH, "invalid json");
    expect(() => readCiPullContext(env)).toThrow(/JSON/);
  });
  it("overlays defaults without modifying the base, resolves codex from PATH and validates effort", () => {
    const env = context({ pull_request: { number: 1, head: { sha } } });
    const ctx = readCiPullContext(env), base = loadConfig();
    const config = buildCiConfig(base, ctx, { ...env, PATH: env.PATH, RUNNER_TEMP: roots[0] });
    expect(config.pilotRepos).toEqual(["owner/repo"]);
    expect(config.codexRuntime).toMatchObject({ enabled: true, model: "gpt-6.1-sol", reasoningEffort: "high" });
    expect(config.codexRuntime!.cliPath).toMatch(/\/codex$/);
    expect(config.commands.enabled).toBe(false);
    for (const path of [config.statePath, config.evidenceDir, config.workRoot]) expect(path.startsWith(roots[0] + "/")).toBe(true);
    expect(base.pilotRepos).not.toEqual(["owner/repo"]);
    const custom = buildCiConfig(base, ctx, { ...env, PATH: env.PATH, NEONDIFF_MODEL: "fixture-model", NEONDIFF_REASONING_EFFORT: "medium" });
    expect(custom.codexRuntime).toMatchObject({ model: "fixture-model", reasoningEffort: "medium" });
    expect(() => buildCiConfig(base, ctx, { ...env, NEONDIFF_REASONING_EFFORT: "invalid" })).toThrow(/effort/);
  });
  it("ignores empty and relative PATH entries so a PR-planted codex is never chosen", () => {
    const env = context({ pull_request: { number: 1, head: { sha } } });
    const ctx = readCiPullContext(env), base = loadConfig();
    const checkout = mkdtempSync(join(tmpdir(), "neondiff-ci-checkout-")); roots.push(checkout);
    const planted = join(checkout, "codex"); writeFileSync(planted, "#!/bin/sh\nexit 0\n"); chmodSync(planted, 0o700);
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(checkout);
    try {
      expect(() => buildCiConfig(base, ctx, { ...env, PATH: ["", ".", "bin"].join(":") })).toThrow(/codex on PATH/);
      expect(buildCiConfig(base, ctx, { ...env, PATH: ["", ".", env.PATH].join(":") }).codexRuntime!.cliPath).toBe(join(env.PATH, "codex"));
    } finally { cwd.mockRestore(); }
  });
  it("uses the fallback token for review and comment creation/update without App credentials", async () => {
    const requests: { url: string; method: string; body: any }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      const method = init?.method ?? "GET";
      requests.push({ url: String(url), method, body: init?.body ? JSON.parse(init.body) : undefined });
      const existing = requests.filter((r) => r.method === "POST" && r.url.endsWith("/comments")).length > 0;
      return new Response(JSON.stringify(method === "GET" ? (existing ? [{ id: 2, body: "marker", user: { type: "Bot", login: "github-actions[bot]" } }] : []) : { id: 2 }), { status: 200 });
    }));
    const github = new GitHubApi({ token: "fixture-token", botLogin: "github-actions[bot]" });
    expect(github.canPostAsApp()).toBe(false); expect(github.canPost()).toBe(true);
    await github.createReview({ repo: "owner/repo", pullNumber: 1, headSha: sha, event: "COMMENT", body: "review", comments: [] });
    expect((await github.upsertIssueComment({ repo: "owner/repo", issueNumber: 1, marker: "marker", body: "marker" })).action).toBe("created");
    expect((await github.upsertIssueComment({ repo: "owner/repo", issueNumber: 1, marker: "marker", body: "marker" })).action).toBe("updated");
    // The first upsert resolves the token identity once (GET /user); the fixture is not a user object, so the bot login stays.
    expect(requests.map((r) => r.method)).toEqual(["POST", "GET", "GET", "POST", "GET", "PATCH"]);
    expect(requests.filter((r) => r.url.endsWith("/user"))).toHaveLength(1);
  });
  it("passes API keys only through the child environment, preferring CODEX_API_KEY", () => {
    expect(buildCodexRuntimeEnv({ OPENAI_API_KEY: "fixture-openai", GITHUB_TOKEN: "fixture-github" })).toEqual({ OPENAI_API_KEY: "fixture-openai", CODEX_API_KEY: "fixture-openai" });
    expect(buildCodexRuntimeEnv({ OPENAI_API_KEY: "fixture-openai", CODEX_API_KEY: "fixture-codex" }).CODEX_API_KEY).toBe("fixture-codex");
  });
  it("adds the attribution once, including walkthrough fallback and separate review bodies", () => {
    const body = appendReviewAttribution("review", "gpt-6.1-sol");
    expect(appendReviewAttribution(body, "gpt-6.1-sol")).toBe(body);
    expect(body).toContain("Reviewed by [NeonDiff](https://www.neondiff.com/?utm_source=github&utm_medium=review&utm_campaign=footer) · gpt-6.1-sol");
    for (const posted of [true, false]) {
      const review = reviewBodyAfterWalkthroughPost({ summary: body, walkthrough: { body, postIssueComment: true } as any, walkthroughComment: { posted } as any });
      expect(review.match(/Reviewed by \[NeonDiff\]/g)).toHaveLength(1);
    }
  });
  it("admits public without reading keys or calling the license API, while other scopes and daemon stay denied", async () => {
    const config = loadConfig().license!;
    const read = vi.fn(() => undefined), fetchImpl = vi.fn();
    const common = { config, secretReader: { read }, fetchImpl };
    const result = await requireActiveProductionLicense({ ...common, operation: "review_cycle", visibility: "public" });
    expect(result.ok).toBe(true); expect(read).not.toHaveBeenCalled(); expect(fetchImpl).not.toHaveBeenCalled();
    if (result.ok) {
      expect(authorizeAdmissionForVisibility(result.admission, "public", "review_cycle").ok).toBe(true);
      expect(authorizeAdmissionForVisibility(result.admission, "private").ok).toBe(false);
      expect(authorizeAdmissionForVisibility(result.admission, "unknown").ok).toBe(false);
    }
    for (const visibility of ["private", "unknown"] as const) expect((await requireActiveProductionLicense({ ...common, operation: "review_cycle", visibility })).ok).toBe(false);
    expect((await requireActiveDaemonCycleAdmissions(common)).ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("runs scoped admission against GitHub metadata and preserves the stale-head check", async () => {
    const env = context({ pull_request: { number: 1, head: { sha } } });
    const ctx = readCiPullContext(env), ciConfig = buildCiConfig(loadConfig(), ctx, env);
    ciConfig.license = { ...ciConfig.license!, storageBackend: "file", keyPath: join(roots[0], "missing.key") };
    const metadata = vi.spyOn(GitHubApi.prototype, "getRepo").mockResolvedValue({ full_name: ctx.repo, private: false });
    vi.spyOn(GitHubApi.prototype, "getPull").mockResolvedValue({ number: 1, draft: true, head: { sha }, base: { repo: { private: false } } } as any);
    const fetchImpl = vi.fn(() => { throw new Error("unexpected API request"); }); vi.stubGlobal("fetch", fetchImpl);
    const options = { ciConfig, repo: ctx.repo, pullNumber: ctx.pullNumber, explicitPullReview: { repo: ctx.repo, pullNumber: ctx.pullNumber }, expectedHeadSha: sha, dryRun: true, useZCode: false };
    expect(await runOnce(options)).toMatchObject({ skippedDraft: 1, failed: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(runOnce({ ...options, expectedHeadSha: "b".repeat(40) })).rejects.toThrow(/head/i);
    for (const visibility of ["private", "internal", undefined]) {
      metadata.mockResolvedValue({ full_name: ctx.repo, ...(visibility ? { visibility } : {}) } as any);
      await expect(runOnce(options)).rejects.toThrow(/license/);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("finds only this identity's NeonDiff review on the exact head", async () => {
    const own = { login: "github-actions[bot]", type: "Bot" };
    const body = appendReviewAttribution("review", "gpt-6.1-sol");
    const github = (reviews: unknown[]) => ({
      postingIdentity: async () => ({ login: "github-actions[bot]", type: "Bot" as const }),
      listPullReviews: async () => reviews as any
    });
    expect(await findPostedCiReview(github([{ id: 1, commit_id: sha.toUpperCase(), body, user: own }]), "owner/repo", 1, sha)).toEqual({ id: 1 });
    for (const other of [
      { id: 2, commit_id: "b".repeat(40), body, user: own },
      { id: 3, commit_id: sha, body: "another action's review", user: own },
      { id: 4, commit_id: sha, body, user: { login: "github-actions[bot]", type: "User" } },
      { id: 5, commit_id: sha, body, user: { login: "someone", type: "User" } },
      { id: 6, commit_id: sha, body, user: null }
    ]) expect(await findPostedCiReview(github([other]), "owner/repo", 1, sha)).toBeUndefined();
  });
  it("resolves a personal access token's own identity so marker comments are updated, not duplicated", async () => {
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      const method = init?.method ?? "GET", path = new URL(String(url)).pathname;
      requests.push(`${method} ${path}`);
      if (path === "/user") return new Response(JSON.stringify({ login: "maintainer", type: "User" }), { status: 200 });
      if (method === "GET") return new Response(JSON.stringify([{ id: 5, body: "marker", user: { login: "maintainer", type: "User" } }]), { status: 200 });
      return new Response(JSON.stringify({ id: 5 }), { status: 200 });
    }));
    const github = new GitHubApi({ token: "fixture-pat", botLogin: "github-actions[bot]" });
    expect((await github.upsertIssueComment({ repo: "owner/repo", issueNumber: 1, marker: "marker", body: "marker" })).action).toBe("updated");
    expect(await github.postingIdentity()).toEqual({ login: "maintainer", type: "User" });
    expect(requests.filter((r) => r === "GET /user")).toHaveLength(1);
  });
  it("keeps the bot identity for App credentials and for tokens that cannot read /user", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "Resource not accessible by integration" }), { status: 403 }));
    vi.stubGlobal("fetch", fetchImpl);
    expect(await new GitHubApi({ token: "fixture-token", botLogin: "github-actions[bot]" }).postingIdentity()).toEqual({ login: "github-actions[bot]", type: "Bot" });
    fetchImpl.mockClear();
    expect(await new GitHubApi({ appId: "1", privateKey: "fixture-key", botLogin: "neondiff[bot]", token: "fixture-token" }).postingIdentity()).toEqual({ login: "neondiff[bot]", type: "Bot" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("labels API-key Codex runs in provider metadata while keeping the provider id stable", () => {
    const config = buildCiConfig(loadConfig(), readCiPullContext(context({ pull_request: { number: 1, head: { sha } } })), context({ pull_request: { number: 1, head: { sha } } }));
    expect(buildReviewProviderMetadata(config, { OPENAI_API_KEY: "fixture" })).toMatchObject({ providerId: "codex-cli-oauth", displayName: "Codex CLI (API key)" });
    expect(buildReviewProviderMetadata(config, { CODEX_API_KEY: "fixture" }).displayName).toBe("Codex CLI (API key)");
    expect(buildReviewProviderMetadata(config, {})).toMatchObject({ providerId: "codex-cli-oauth", displayName: "Codex CLI (existing OAuth session)" });
  });

});


// Exercise argument routing through the real CLI with only its execution seam mocked.
async function invokeCiCli(event: unknown, eventName: string, extra: string[] = [], reviews: unknown[] = [], expectRun = true) {
  vi.resetModules();
  const env = context(event, eventName);
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  const { GitHubApi: CliGitHub } = await import("../src/github.js");
  const getPull = vi.spyOn(CliGitHub.prototype, "getPull").mockResolvedValue({ head: { sha } } as any);
  const listPullReviews = vi.spyOn(CliGitHub.prototype, "listPullReviews").mockResolvedValue(reviews as any);
  vi.spyOn(CliGitHub.prototype, "postingIdentity").mockResolvedValue({ login: "github-actions[bot]", type: "Bot" });
  const run = vi.fn(async (_input: unknown) => ({ output: JSON.stringify({ ok: true }), exitCode: 0 }));
  vi.doMock("../src/run-once-cli.js", () => ({ runOnceCliCommand: run }));
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const argv = process.argv;
  try {
    process.argv = [argv[0], "src/cli.ts", "review-pr", "--ci", ...extra];
    await import("../src/cli.js");
    await vi.waitFor(() => expect(log).toHaveBeenCalled());
    if (expectRun) expect(run).toHaveBeenCalledOnce(); else expect(run).not.toHaveBeenCalled();
    return { input: run.mock.calls[0]?.[0] as any, getPull, listPullReviews, output: JSON.parse(String(log.mock.calls.at(-1)?.[0])) };
  } finally { process.argv = argv; vi.doUnmock("../src/run-once-cli.js"); }
}

describe("CI CLI routing", () => {
  it("implies live posting with no file, revision, confirmation, or ZCode flag", async () => {
    const { input, getPull } = await invokeCiCli({ pull_request: { number: 3, head: { sha } } }, "pull_request_target");
    expect(input.options).toMatchObject({ repo: "owner/repo", pullNumber: 3, expectedHeadSha: sha, dryRun: false, useZCode: false, processedHeadPolicy: "normal" });
    expect(input.options.configPath).toBeUndefined(); expect(input.options.expectedConfigRevision).toBeUndefined(); expect(input.admitImpl).toBeUndefined();
    expect(getPull).not.toHaveBeenCalled();
  });
  it("fetches the issue-comment PR head and honours explicit dry run", async () => {
    const { input, getPull, listPullReviews } = await invokeCiCli({ issue: { number: 4, pull_request: {} } }, "issue_comment", ["--dry-run", "true"]);
    expect(getPull).toHaveBeenCalledWith("owner/repo", 4);
    expect(input.options).toMatchObject({ dryRun: true, expectedHeadSha: sha, processedHeadPolicy: "refresh_dry_run" });
    expect(listPullReviews).not.toHaveBeenCalled();
  });
  it("rejects an unparseable --dry-run instead of posting live", async () => {
    const { output } = await invokeCiCli({ pull_request: { number: 3, head: { sha } } }, "pull_request_target", ["--dry-run", "ture"], [], false);
    expect(output).toMatchObject({ ok: false, command: "review-pr", error: "--dry-run must be true or false" });
  });
  it("skips a head that this token already reviewed in an earlier workflow run", async () => {
    const reviewed = [{ id: 9, commit_id: sha, html_url: "https://github.com/owner/repo/pull/3#pullrequestreview-9", body: appendReviewAttribution("review", "gpt-6.1-sol"), user: { login: "github-actions[bot]", type: "Bot" } }];
    const { output, listPullReviews } = await invokeCiCli({ pull_request: { number: 3, head: { sha } } }, "pull_request_target", [], reviewed, false);
    expect(listPullReviews).toHaveBeenCalledWith("owner/repo", 3);
    expect(output).toMatchObject({ ok: true, status: "skipped_already_reviewed", headSha: sha, reviewUrl: reviewed[0].html_url });
  });
});
