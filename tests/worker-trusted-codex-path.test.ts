import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configFilePaths, loadConfigFromObject, type BotConfig } from "../src/config.js";
import type { GitHubApi } from "../src/github.js";
import { ReviewRunBudget } from "../src/review-budget.js";
import { ReviewStateStore } from "../src/state.js";
import type { PullRequestSummary } from "../src/types.js";
import { retryFailedHeadWithDeps, reviewPull, type ReviewPullInput } from "../src/worker.js";
import { testLicenseAdmission } from "./helpers/license-admission.js";

const mocks = vi.hoisted(() => ({ provider: vi.fn(), prepare: vi.fn(), reads: vi.fn() }));
vi.mock("../src/codex-runtime.js", async (original) => ({
  ...await original<typeof import("../src/codex-runtime.js")>(), runCodexReview: mocks.provider,
  resolveCheckoutReadsStatus: (...args: unknown[]) => { mocks.reads(...args); return { status: "disabled" }; }
}));
vi.mock("../src/git.js", async (original) => ({
  ...await original<typeof import("../src/git.js")>(), preparePullWorktree: mocks.prepare,
  assertGitClean: vi.fn(), hydratePullFilePatchesFromWorktree: vi.fn(async ({ files }) => files)
}));
const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs(); vi.clearAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "neondiff-trusted-codex-")); roots.push(root);
  const config = loadConfigFromObject({ codexRuntime: { enabled: true, cliPath: "codex" },
    pilotRepos: ["org/repo"], repoProfiles: { repos: { "org/repo": { enabled: true } } },
    commands: { enabled: false }, walkthrough: { enabled: false }, contextBudget: { enabled: false },
    activation: { reviewExistingOpenPrsOnActivation: true } });
  config.evidenceDir = join(root, "evidence"); config.workRoot = join(root, "work");
  const pull: PullRequestSummary = { number: 1, title: "Fixture", draft: false, state: "open", authorAssociation: "OWNER",
    authorLogin: "fixture-owner", head: { sha: "a".repeat(40), ref: "fixture" },
    base: { sha: "b".repeat(40), ref: "main", repo: { full_name: "org/repo", visibility: "private" } },
    html_url: "https://github.test/org/repo/pull/1" };
  const state = new ReviewStateStore(join(root, "state.sqlite"));
  // A PATH with no codex on it: only a review that spawns Codex may require one.
  vi.stubEnv("PATH", mkdtempSync(join(root, "empty-path-")));
  mocks.prepare.mockImplementation(async () => { throw new Error("fixture stops after checkout preparation"); });
  const github = { listPullFiles: async () => [{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 1, changes: 2,
    patch: "@@ -1 +1 @@\n-a\n+b" }], getPull: async () => pull, canPostAsApp: () => true } as unknown as GitHubApi;
  return { root, config, pull, state, github };
}

describe("trusted Codex path pinning", () => {
  it.each([false, true])("pins Codex only when the review runs a provider (useZCode=%s)", async (useZCode) => {
    const f = fixture();
    try {
      const outcome = reviewPull({ config: f.config, github: f.github, state: f.state, repo: "org/repo", pull: f.pull,
        dryRun: true, useZCode, licenseAdmission: testLicenseAdmission });
      // Without a provider the review reaches checkout preparation; with one, the missing codex stops it first.
      await expect(outcome).rejects.toThrow(useZCode ? /Codex CLI not found on a trusted PATH/ : /fixture stops after checkout preparation/);
      expect(mocks.prepare).toHaveBeenCalledTimes(useZCode ? 0 : 1);
    } finally { f.state.close(); }
  });

  it("never runs a PATH codex for a review that spawns no provider", async () => {
    const f = fixture();
    const bin = mkdtempSync(join(f.root, "path-")); const marker = join(f.root, "path-codex-ran");
    writeFileSync(join(bin, "codex"), `#!/bin/sh\ntouch "${marker}"\necho codex-cli 0.163.0\n`); chmodSync(join(bin, "codex"), 0o755);
    vi.stubEnv("PATH", `${bin}:/usr/bin:/bin`);
    const checkout = mkdtempSync(join(f.root, "checkout-"));
    mocks.prepare.mockImplementation(async () => ({ path: checkout }));
    try {
      const outcome = await reviewPull({ config: f.config, github: f.github, state: f.state, repo: "org/repo", pull: f.pull,
        dryRun: true, useZCode: false, licenseAdmission: testLicenseAdmission }).then((status) => ({ status }), (error: Error) => ({ error: error.message }));
      // The no-provider dry run completes; the PATH binary never ran (not even for `--version`).
      expect(outcome).toEqual({ status: "reviewed" });
      expect(mocks.prepare).toHaveBeenCalledOnce();
      expect(existsSync(marker)).toBe(false);
    } finally { f.state.close(); }
  });

  it("checks both the inherited and the configured license key paths", async () => {
    const f = fixture();
    const bin = mkdtempSync(join(f.root, "trusted-bin-"));
    writeFileSync(join(bin, "codex"), "#!/bin/sh\necho codex-cli 0.163.0\n"); chmodSync(join(bin, "codex"), 0o755);
    vi.stubEnv("PATH", `${bin}:/usr/bin:/bin`);
    vi.stubEnv("NEONDIFF_LICENSE_KEY_FILE", "/fixture/inherited.key");
    f.config.license = { ...f.config.license!, keyPath: "/etc/neondiff/license.key" };
    mocks.prepare.mockImplementation(async () => ({ path: mkdtempSync(join(f.root, "checkout-")) }));
    try {
      await reviewPull({ config: f.config, github: f.github, state: f.state, repo: "org/repo", pull: f.pull,
        dryRun: true, useZCode: true, licenseAdmission: testLicenseAdmission }).catch(() => undefined);
      expect(mocks.reads).toHaveBeenCalledOnce();
      const sensitive = Object.values((mocks.reads.mock.calls[0]![0] as { sensitivePaths: Record<string, string | undefined> }).sensitivePaths);
      expect(sensitive).toEqual(expect.arrayContaining(["/fixture/inherited.key", "/etc/neondiff/license.key"]));
    } finally { f.state.close(); }
  });

  it("keeps the source config path on the failed-head retry config", async () => {
    const f = fixture();
    configFilePaths.set(f.config, "/fixture/config.local.json");
    f.state.recordProcessed({ repo: "org/repo", pullNumber: 1, headSha: f.pull.head.sha, status: "failed", error: "fixture_failure" });
    let seen: BotConfig | undefined;
    const reviewPullImpl = vi.fn(async (input: ReviewPullInput) => { seen = input.config; return "skipped_policy" as const; });
    try {
      await retryFailedHeadWithDeps({ config: f.config, state: f.state, budget: new ReviewRunBudget(1),
        github: { getPull: async () => f.pull, canPostAsApp: () => true } as unknown as GitHubApi,
        options: { repo: "org/repo", pullNumber: 1, headSha: f.pull.head.sha, dryRun: true },
        reviewPullImpl, licenseAdmission: testLicenseAdmission });
      expect(reviewPullImpl).toHaveBeenCalledOnce();
      expect(seen).not.toBe(f.config);
      expect(configFilePaths.get(seen!)).toBe("/fixture/config.local.json");
    } finally { f.state.close(); }
  });
});
