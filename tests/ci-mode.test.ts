import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCiConfig, ciGitAuthToken, ciLicenseMachineId, findPostedCiReview, readCiPullContext } from "../src/ci-mode.js";
import { buildReviewProviderMetadata, codexRuntimeCredentialNote, runOnce } from "../src/worker.js";
import { runOnceCliExitCode } from "../src/run-once-cli.js";
import { loadConfig } from "../src/config.js";
import { GitHubApi } from "../src/github.js";
import { buildCodexRuntimeEnv } from "../src/codex-runtime.js";
import { appendReviewAttribution, reviewBodyAfterWalkthroughPost } from "../src/walkthrough-post.js";
import { requireActiveProductionLicense, authorizeAdmissionForVisibility, requireActiveDaemonCycleAdmissions } from "../src/license-admission.js";

vi.mock("node:fs", async original => ({ ...await original<typeof import("node:fs")>() }));

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
    config.github.token = "fixture-git-credential";
    expect(ciGitAuthToken(config)).toBe(config.github.token);
    expect(ciGitAuthToken({ ...config })).toBeUndefined();
    expect(ciGitAuthToken(base)).toBeUndefined();
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
      expect(buildCiConfig(base, ctx, { ...env, PATH: ["", ".", env.PATH].join(":") }).codexRuntime!.cliPath).toBe(realpathSync(join(env.PATH, "codex")));
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
  it("admits public without reading keys or calling the license API, while keyless daemon stays public-only", async () => {
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
    const daemon = await requireActiveDaemonCycleAdmissions(common);
    expect(daemon.ok).toBe(true);
    if (daemon.ok) {
      expect(daemon.admissions.issueEnrichment).toBeUndefined();
      for (const admission of [daemon.admissions.daemonCycle, daemon.admissions.reviewDiscovery]) {
        expect(admission).toMatchObject({ repoVisibilityScope: "public", privateRepoAllowed: false, updateEntitlement: false });
        expect(authorizeAdmissionForVisibility(admission, "public").ok).toBe(true);
        for (const visibility of ["private", "unknown"] as const) expect(authorizeAdmissionForVisibility(admission, visibility).ok).toBe(false);
      }
    }
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
    expect(await runOnce(options)).toMatchObject({ scopedStatus: "skipped_draft", skippedDraft: 1, failed: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
    // A head that moved after the triggering event is a superseded CI run: skipped, never reviewed.
    const stale = await runOnce({ ...options, expectedHeadSha: "b".repeat(40) });
    expect(stale).toMatchObject({ scopedStatus: "skipped_stale_head", skippedStaleHead: 1, reviewed: 0, failed: 0, scopedPull: { headSha: sha } });
    expect(runOnceCliExitCode(stale, { commandName: "review-pr", dryRun: false, ci: true })).toBe(0);
    expect(runOnceCliExitCode(stale, { commandName: "review-pr", dryRun: false })).toBe(1);
    const { ciConfig: _ci, ...nonCi } = options;
    await expect(runOnce({ ...nonCi, configPath: undefined, expectedHeadSha: "b".repeat(40) })).rejects.toThrow(/head/i);
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
    // The runtime evidence note names the same credential as the display name.
    expect(codexRuntimeCredentialNote({ OPENAI_API_KEY: "fixture" })).toMatch(/API key/);
    expect(codexRuntimeCredentialNote({ CODEX_API_KEY: "fixture" })).toMatch(/API key/);
    expect(codexRuntimeCredentialNote({})).toMatch(/existing authenticated session/);
  });

});

describe("CI owner license admission", () => {
  const fakeKey = ["nd", "live", "ci_fake_license_1173"].join("_");
  const conflict = "this license is active for a different GitHub organization or account; deactivate it there or use another license";

  function fixture(repo = "owner/first", ownerId: string | undefined = "123") {
    const env = {
      ...context({ pull_request: { number: 1, head: { sha } } }),
      GITHUB_REPOSITORY: repo,
      GITHUB_REPOSITORY_OWNER_ID: ownerId,
      NEONDIFF_LICENSE_KEY_FILE: ""
    };
    env.NEONDIFF_LICENSE_KEY_FILE = join(env.RUNNER_TEMP, "license.key");
    writeFileSync(env.NEONDIFF_LICENSE_KEY_FILE, fakeKey + "\n", { mode: 0o600 });
    const ciConfig = buildCiConfig(loadConfig(), readCiPullContext(env), env);
    return { env, ciConfig, options: {
      ciConfig, repo, pullNumber: 1, explicitPullReview: { repo, pullNumber: 1 },
      expectedHeadSha: sha, dryRun: true, useZCode: false
    } };
  }

  function apiDouble() {
    let seatOwner: string | undefined;
    let boundRepo: string | undefined;
    const requests: { path: string; repo: string; machineId: string }[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const path = new URL(String(url)).pathname;
      requests.push({ path, repo: body.repo, machineId: body.machineId });
      // Mirrors the license service: an activation that named a repo refuses a different repo.
      if (path.endsWith("/activate") && seatOwner === body.machineId && boundRepo && body.repo && boundRepo !== body.repo) {
        return new Response(JSON.stringify({ status: "scope_mismatch", detail: "license activation is already bound to a different repository" }), { status: 409 });
      }
      if (path.endsWith("/activate") && (!seatOwner || seatOwner === body.machineId)) {
        seatOwner = body.machineId;
        boundRepo ??= body.repo;
      }
      if (seatOwner !== body.machineId) return new Response(JSON.stringify({ status: "seat_exhausted", detail: fakeKey }), { status: 409 });
      return new Response(JSON.stringify({ status: "active", repoVisibilityScope: "all", privateRepoAllowed: true, updateEntitlement: true }));
    });
    vi.stubGlobal("fetch", fetchImpl);
    return { requests, fetchImpl };
  }

  function github(visibility: string | undefined = "private") {
    vi.spyOn(GitHubApi.prototype, "getRepo").mockResolvedValue({ visibility } as any);
    // A draft stops immediately after real admission, without checkout/provider/posting.
    vi.spyOn(GitHubApi.prototype, "getPull").mockResolvedValue({ number: 1, draft: true, head: { sha } } as any);
  }

  function captureOutput() {
    const captured: string[] = [];
    for (const method of ["log", "warn", "error"] as const) vi.spyOn(console, method).mockImplementation((...args) => { captured.push(args.map(String).join(" ")); });
    return captured;
  }

  async function rejectedReview(options: Parameters<typeof runOnce>[0]) {
    const message = await runOnce(options).then(() => "unexpected success", (error: Error) => error.message);
    expect(message).not.toBe("unexpected success");
    expect(message).not.toContain(fakeKey);
    return message;
  }

  it("hashes the numeric owner ID deterministically into a 43-character thumbprint", () => {
    const id = ciLicenseMachineId({ GITHUB_REPOSITORY_OWNER_ID: "123" });
    expect(id).toBe("-WeFVQbDOhHofRAh-kU-0dNlD1Rfw4e4lv9mZFr-jaM");
    expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(id).toBe(ciLicenseMachineId({ GITHUB_REPOSITORY_OWNER_ID: "123", GITHUB_REPOSITORY_OWNER: "renamed" }));
    expect(id).not.toBe(ciLicenseMachineId({ GITHUB_REPOSITORY_OWNER_ID: "124" }));
    for (const value of [undefined, "", "0", "-1", "1.2", "1e3", " 123", "123\n", "user"]) {
      expect(ciLicenseMachineId({ GITHUB_REPOSITORY_OWNER_ID: value })).toBeUndefined();
    }
  });

  it("activates then validates two fresh runs under one owner, refusing a different owner", async () => {
    const output = captureOutput(); github();
    const { requests } = apiDouble();
    for (const repo of ["owner/first", "renamed/second"]) {
      const { ciConfig, env, options } = fixture(repo);
      expect(ciConfig.license).toMatchObject({ storageBackend: "file", keyPath: env.NEONDIFF_LICENSE_KEY_FILE, cachePath: join(env.RUNNER_TEMP, "neondiff-ci/license/cache.json") });
      expect(await runOnce(options)).toMatchObject({ skippedDraft: 1, failed: 0 });
      expect(readFileSync(ciConfig.license!.cachePath, "utf8")).not.toContain(fakeKey);
      expect(existsSync(env.NEONDIFF_LICENSE_KEY_FILE)).toBe(false);
    }
    expect(requests.map((r) => r.path)).toEqual(["/v1/license/activate", "/v1/license/validate", "/v1/license/activate", "/v1/license/validate"]);
    expect(new Set(requests.map((r) => r.machineId))).toEqual(new Set([ciLicenseMachineId({ GITHUB_REPOSITORY_OWNER_ID: "123" })]));
    // Owner-scoped activation names no repo, so a second repository under the same owner is admitted.
    expect(requests.map((r) => r.repo)).toEqual([undefined, "owner/first", undefined, "renamed/second"]);
    const other = fixture("other/repo", "124");
    expect(await rejectedReview(other.options)).toContain(conflict);
    expect(requests.map((r) => r.path).slice(4)).toEqual(["/v1/license/activate"]);
    expect(existsSync(other.ciConfig.license!.cachePath)).toBe(false);
    expect(output.join("\n")).not.toContain(fakeKey);
  });

  it("warns without failing admission when unlink of the consumed key fails", async () => {
    const output = captureOutput(); github(); apiDouble();
    const { env, options } = fixture();
    const fs = await import("node:fs");
    const unlink = vi.spyOn(fs, "unlinkSync").mockImplementation(() => { throw new Error("fixture failure"); });
    try {
      expect(await runOnce(options)).toMatchObject({ skippedDraft: 1, failed: 0 });
      expect(unlink).toHaveBeenCalledWith(env.NEONDIFF_LICENSE_KEY_FILE);
      expect(output.join("\n")).toContain("CI license key cleanup failed");
    } finally { unlink.mockRestore(); }
  });

  it("makes no license call or key read for a public repo, even with an unsafe file and no owner ID", async () => {
    const output = captureOutput(); github("public");
    const { fetchImpl } = apiDouble();
    const { env, options } = fixture("owner/public");
    env.GITHUB_REPOSITORY_OWNER_ID = undefined;
    options.ciConfig = buildCiConfig(loadConfig(), readCiPullContext(env), env);
    chmodSync(env.NEONDIFF_LICENSE_KEY_FILE, 0o644);
    expect(await runOnce(options)).toMatchObject({ skippedDraft: 1, failed: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(existsSync(env.NEONDIFF_LICENSE_KEY_FILE)).toBe(true);
    expect(output.join("\n")).not.toContain(fakeKey);
  });

  it("fails closed for private/internal/unknown repos without the file variable, ignoring raw-key env input", async () => {
    const output = captureOutput(); const { fetchImpl } = apiDouble();
    const metadata = vi.spyOn(GitHubApi.prototype, "getRepo");
    vi.stubEnv("NEONDIFF_LICENSE_KEY", fakeKey);
    for (const visibility of ["private", "internal", undefined]) {
      metadata.mockResolvedValue({ visibility } as any);
      const { env, options } = fixture();
      env.NEONDIFF_LICENSE_KEY_FILE = "";
      options.ciConfig = buildCiConfig(loadConfig(), readCiPullContext(env), env);
      expect(await rejectedReview(options)).toMatch(/NEONDIFF_LICENSE_KEY_FILE/);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(output.join("\n")).not.toContain(fakeKey);
  });

  it.each(["unsafe-mode", "symlink", "missing-file", "missing-owner"])("refuses %s before license traffic", async (failure) => {
    const output = captureOutput(); github(); const { fetchImpl } = apiDouble();
    const { env, options } = fixture();
    let expected = /license secret/;
    if (failure === "unsafe-mode") chmodSync(env.NEONDIFF_LICENSE_KEY_FILE, 0o644);
    if (failure === "symlink") {
      symlinkSync(env.NEONDIFF_LICENSE_KEY_FILE, join(env.RUNNER_TEMP, "symlink.key"));
      env.NEONDIFF_LICENSE_KEY_FILE = join(env.RUNNER_TEMP, "symlink.key");
    }
    if (failure === "missing-file") { env.NEONDIFF_LICENSE_KEY_FILE += ".missing"; expected = /NEONDIFF_LICENSE_KEY_FILE/; }
    if (failure === "missing-owner") { env.GITHUB_REPOSITORY_OWNER_ID = undefined; expected = /GITHUB_REPOSITORY_OWNER_ID/; }
    options.ciConfig = buildCiConfig(loadConfig(), readCiPullContext(env), env);
    expect(await rejectedReview(options)).toMatch(expected);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(output.join("\n")).not.toContain(fakeKey);
  });

  it("fails unknown visibility closed even with a live entitlement", async () => {
    const output = captureOutput(); github("unknown"); const { requests } = apiDouble(); const { options } = fixture();
    expect(await rejectedReview(options)).toMatch(/visibility is unknown/);
    expect(requests.map((r) => r.path)).toEqual(["/v1/license/activate", "/v1/license/validate"]);
    expect(output.join("\n")).not.toContain(fakeKey);
  });

  it("redacts a submitted key from activation network errors and captured output", async () => {
    const output = captureOutput(); github(); const { options } = fixture();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network " + fakeKey); }));
    expect(await rejectedReview(options)).toContain("network");
    expect(output.join("\n")).not.toContain(fakeKey);
  });
});


// Exercise argument routing through the real CLI with only its execution seam mocked.
async function invokeCiCli(event: unknown, eventName: string, extra: string[] = [], reviews: unknown[] = [], expectRun = true, draft = false, terminalStatus?: "untrusted_author_restricted_unavailable" | "skipped_policy") {
  vi.resetModules();
  const env = context(event, eventName);
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  const { GitHubApi: CliGitHub } = await import("../src/github.js");
  const getPull = vi.spyOn(CliGitHub.prototype, "getPull").mockResolvedValue({ number: 3, draft, title: "fixture", html_url: "https://github.com/owner/repo/pull/3", head: { sha } } as any);
  const listPullReviews = vi.spyOn(CliGitHub.prototype, "listPullReviews").mockResolvedValue(reviews as any);
  vi.spyOn(CliGitHub.prototype, "postingIdentity").mockResolvedValue({ login: "github-actions[bot]", type: "Bot" });
  vi.spyOn(CliGitHub.prototype, "getRepo").mockResolvedValue({ full_name: "owner/repo", private: false });
  const actual = await vi.importActual<typeof import("../src/run-once-cli.js")>("../src/run-once-cli.js");
  const run = vi.fn(async (input: Parameters<typeof actual.runOnceCliCommand>[0]) => draft
    ? actual.runOnceCliCommand({ ...input, runOnceImpl: async (options) => {
        const { runOnce } = await import("../src/worker.js");
        const result = await runOnce(options);
        return terminalStatus ? { ...result, scopedStatus: terminalStatus, skippedDraft: 0, skippedPolicy: 1 } : result;
      } })
    : ({ report: { ok: true }, output: JSON.stringify({ ok: true }), exitCode: 0 }));
  vi.doMock("../src/run-once-cli.js", () => ({ runOnceCliCommand: run }));
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
  const argv = process.argv, previousExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    process.argv = [argv[0], "src/cli.ts", "review-pr", "--ci", ...extra];
    await import("../src/cli.js");
    await vi.waitFor(() => expect(log).toHaveBeenCalled());
    if (expectRun) expect(run).toHaveBeenCalledOnce(); else expect(run).not.toHaveBeenCalled();
    return { input: run.mock.calls[0]?.[0] as any, getPull, listPullReviews, output: JSON.parse(String(log.mock.calls.at(-1)?.[0])), exitCode: process.exitCode ?? 0, stderr: stderr.mock.calls.map(([line]) => String(line)) };
  } finally { process.argv = argv; process.exitCode = previousExitCode; vi.doUnmock("../src/run-once-cli.js"); }
}

describe("CI CLI routing", () => {
  it("exits zero for a draft PR in CI with one stderr notice and pure JSON stdout", async () => {
    const result = await invokeCiCli({ pull_request: { number: 3, head: { sha } } }, "pull_request_target", [], [], true, true);
    expect(result.exitCode).toBe(0);
    expect(result.input.ci).toBe(true);
    expect(result.output).toMatchObject({ ok: true, result: { scopedStatus: "skipped_draft", skippedDraft: 1 } });
    expect(result.stderr).toEqual(["::notice::NeonDiff skipped owner/repo#3: skipped_draft"]);
  });
  it.each([
    ["untrusted_author_restricted_unavailable", 0, ["::warning::NeonDiff did not review owner/repo#3: untrusted_author_restricted_unavailable"]],
    ["skipped_policy", 1, []]
  ] as const)("routes terminal status %s to the right exit and stderr annotation", async (status, exitCode, stderr) => {
    const result = await invokeCiCli({ pull_request: { number: 3, head: { sha } } }, "pull_request_target", [], [], true, true, status);
    expect(result.exitCode).toBe(exitCode);
    expect(result.output).toMatchObject({ ok: exitCode === 0, result: { scopedStatus: status } });
    expect(result.stderr).toEqual(stderr);
  });
  it("emits no CI skip annotation for a draft dry run", async () => {
    const result = await invokeCiCli({ pull_request: { number: 3, head: { sha } } }, "pull_request_target", ["--dry-run", "true"], [], true, true);
    expect(result.exitCode).toBe(0);
    expect(result.output).toMatchObject({ result: { scopedStatus: "skipped_draft" } });
    expect(result.stderr).toEqual([]);
  });
  it("implies live posting that runs the configured review, with no file, revision, confirmation, or ZCode flag", async () => {
    const { input, getPull } = await invokeCiCli({ pull_request: { number: 3, head: { sha } } }, "pull_request_target");
    expect(input.options).toMatchObject({ repo: "owner/repo", pullNumber: 3, expectedHeadSha: sha, dryRun: false, useZCode: true, processedHeadPolicy: "normal" });
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
