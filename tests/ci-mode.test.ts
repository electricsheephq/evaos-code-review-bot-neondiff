import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCiConfig, readCiPullContext } from "../src/ci-mode.js";
import { runOnce } from "../src/worker.js";
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
    expect(requests.map((r) => r.method)).toEqual(["POST", "GET", "POST", "GET", "PATCH"]);
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

});


// Exercise argument routing through the real CLI with only its execution seam mocked.
async function invokeCiCli(event: unknown, eventName: string, extra: string[] = []) {
  vi.resetModules();
  const env = context(event, eventName);
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  const { GitHubApi: CliGitHub } = await import("../src/github.js");
  const getPull = vi.spyOn(CliGitHub.prototype, "getPull").mockResolvedValue({ head: { sha } } as any);
  const run = vi.fn(async (_input: unknown) => ({ output: JSON.stringify({ ok: true }), exitCode: 0 }));
  vi.doMock("../src/run-once-cli.js", () => ({ runOnceCliCommand: run }));
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const argv = process.argv;
  try {
    process.argv = [argv[0], "src/cli.ts", "review-pr", "--ci", ...extra];
    await import("../src/cli.js");
    await vi.waitFor(() => expect(log).toHaveBeenCalled());
    expect(run).toHaveBeenCalledOnce();
    return { input: run.mock.calls[0][0] as any, getPull };
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
    const { input, getPull } = await invokeCiCli({ issue: { number: 4, pull_request: {} } }, "issue_comment", ["--dry-run", "true"]);
    expect(getPull).toHaveBeenCalledWith("owner/repo", 4);
    expect(input.options).toMatchObject({ dryRun: true, expectedHeadSha: sha, processedHeadPolicy: "refresh_dry_run" });
  });
});
