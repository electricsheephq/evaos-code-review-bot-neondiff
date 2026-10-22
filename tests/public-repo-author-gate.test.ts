import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfigFromObject } from "../src/config.js";
import type { GitHubApi } from "../src/github.js";
import { codexChildUsesApiKeyOnly, isPublicRepoAuthorBlocked } from "../src/public-repo-author-gate.js";
import { buildCodexRuntimeEnv } from "../src/codex-runtime.js";
import { ReviewStateStore } from "../src/state.js";
import type { PullRequestSummary } from "../src/types.js";
import { recordPublicRepoAuthorGateSkip, reviewPull, retryFailedHeadWithDeps } from "../src/worker.js";
import { ReviewRunBudget } from "../src/review-budget.js";
import { runScheduledCycleWithDeps } from "../src/scheduler.js";
import { buildOperatorDashboard, formatOperatorDashboardHuman } from "../src/operator-cli.js";
import type { CoverageAuditReport } from "../src/coverage-audit.js";
import { testLicenseAdmission } from "./helpers/license-admission.js";

const mocks = vi.hoisted(() => ({ provider: vi.fn(), prepare: vi.fn() }));
vi.mock("../src/codex-runtime.js", async (original) => ({
  ...await original<typeof import("../src/codex-runtime.js")>(), runCodexReview: mocks.provider
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
function config() {
  return loadConfigFromObject({ codexRuntime: { enabled: true, cliPath: "/test/codex" },
    pilotRepos: ["org/repo"], repoProfiles: { repos: { "org/repo": { enabled: true } } },
    reviewGate: { publicRepoAuthorGate: {} }, commands: { enabled: false }, walkthrough: { enabled: false }, contextBudget: { enabled: false },
    activation: { reviewExistingOpenPrsOnActivation: true } });
}
function pull(visibility: string, association?: string, login = "fixture-author"): PullRequestSummary {
  return { number: 1, title: "Fixture", draft: false, state: "open", authorAssociation: association, authorLogin: login,
    head: { sha: "a".repeat(40), ref: "fixture" },
    base: { sha: "b".repeat(40), ref: "main", repo: { full_name: "org/repo",
      ...(visibility !== "unknown" ? { visibility: visibility as "public" | "private" | "internal" } : {}) } },
    html_url: "https://github.test/org/repo/pull/1" };
}
function apiEnv(key?: string) {
  vi.stubEnv("CODEX_API_KEY", key === "codex" ? "fake-api-key" : "");
  vi.stubEnv("OPENAI_API_KEY", key === "openai" ? "fake-api-key" : "");
  // Isolate from any real ChatGPT login on the test machine.
  vi.stubEnv("CODEX_HOME", mkdtempSync(join(tmpdir(), "neondiff-codex-home-")));
}
describe("Codex child authentication", () => {
  it("counts API-key auth only when the key reaches the child and no ChatGPT login file exists", () => {
    const none = vi.fn(() => false);
    expect(codexChildUsesApiKeyOnly({}, none)).toBe(false);
    expect(codexChildUsesApiKeyOnly({ CODEX_API_KEY: "fake-api-key", CODEX_HOME: "/fixture/home" }, none)).toBe(true);
    expect(none).toHaveBeenCalledWith("/fixture/home/auth.json");
    expect(codexChildUsesApiKeyOnly({ OPENAI_API_KEY: "fake-api-key", CODEX_HOME: "/fixture/home" },
      (path) => path === "/fixture/home/auth.json")).toBe(false);
    const defaultHome = vi.fn(() => false);
    expect(codexChildUsesApiKeyOnly({ OPENAI_API_KEY: "fake-api-key" }, defaultHome)).toBe(true);
    expect(String(defaultHome.mock.calls[0]?.[0])).toMatch(/[\\/]\.codex[\\/]auth\.json$/);
  });
  it("keeps the gate on when the parent has a key that the Codex child never receives", () => {
    vi.stubEnv("OPENAI_API_KEY", "fake-api-key");
    vi.stubEnv("CODEX_HOME", mkdtempSync(join(tmpdir(), "neondiff-codex-home-")));
    const child = buildCodexRuntimeEnv(process.env);
    expect(codexChildUsesApiKeyOnly()).toBe(Boolean(child.OPENAI_API_KEY || child.CODEX_API_KEY));
    if (!child.OPENAI_API_KEY && !child.CODEX_API_KEY) {
      expect(isPublicRepoAuthorBlocked(config(), pull("public", "CONTRIBUTOR"))).toBe(true);
    }
  });
});

describe("public repository author gate", () => {
  for (const key of [undefined, "codex", "openai"]) {
    for (const visibility of ["public", "private", "internal", "unknown"]) {
      for (const association of ["OWNER", "MEMBER", "COLLABORATOR", "CONTRIBUTOR", "NONE", undefined]) {
        it(`auto: key=${key ?? "none"} visibility=${visibility} association=${association ?? "missing"}`, async () => {
          apiEnv(key);
          const cfg = config();
          const pr = pull(visibility, association);
          // A key only lifts the gate once it reaches the Codex child; the runtime allowlist does not forward it.
          const child = buildCodexRuntimeEnv(process.env);
          const keyReachesCodex = Boolean(child.CODEX_API_KEY || child.OPENAI_API_KEY);
          const blocked = !keyReachesCodex && ["public", "unknown"].includes(visibility) &&
            !["OWNER", "MEMBER", "COLLABORATOR"].includes(association ?? "");
          expect(isPublicRepoAuthorBlocked(cfg, pr)).toBe(blocked);
          const root = mkdtempSync(join(tmpdir(), "neondiff-author-gate-")); roots.push(root);
          cfg.evidenceDir = join(root, "evidence"); cfg.workRoot = join(root, "work");
          const state = new ReviewStateStore(join(root, "state.sqlite"));
          mocks.prepare.mockImplementation(({ expectedHeadSha }) => {
            const path = join(root, "worktree"); mkdirSync(path, { recursive: true });
            return { path, headSha: expectedHeadSha };
          });
          mocks.provider.mockResolvedValue({ findings: [], droppedFromSchema: [], rawResponse: '{"findings":[]}', attempts: 1, degradedRecovery: false });
          const post = vi.fn(); const files = vi.fn(async () => [{ filename: "src/fixture.ts", status: "modified", patch: "@@ -1 +1 @@\n-old\n+new", additions: 1, deletions: 1, changes: 2 }]);
          const github = { getPull: async () => pr, listPullFiles: files, canPostAsApp: () => true,
            createReview: post, upsertIssueComment: post } as unknown as GitHubApi;
          try {
            // Allowed paths run the dry review with a mocked model; blocked paths request live mode.
            const status = await reviewPull({ config: cfg, github, state, repo: "org/repo", pull: pr,
              dryRun: !blocked, useZCode: true, licenseAdmission: testLicenseAdmission });
            if (blocked) {
              expect(status).toBe("untrusted_author_public_repo");
              expect(files).not.toHaveBeenCalled(); expect(mocks.prepare).not.toHaveBeenCalled();
              expect(mocks.provider).not.toHaveBeenCalled(); expect(post).not.toHaveBeenCalled();
              expect(state.getProcessedReview("org/repo", 1, pr.head.sha)).toMatchObject({
                status: "skipped", error: "untrusted_author_public_repo" });
              expect(state.getReviewReadiness("org/repo", 1, pr.head.sha)).toMatchObject({
                state: "skipped", reason: "untrusted_author_public_repo" });
              const evidence = findFile(cfg.evidenceDir, "author-gate.json");
              expect(JSON.parse(readFileSync(evidence!, "utf8"))).toMatchObject({ reason: "untrusted_author_public_repo" });
            } else {
              expect(status).not.toBe("untrusted_author_public_repo");
              if (visibility !== "unknown") {
                expect(files).toHaveBeenCalledOnce(); expect(mocks.provider).toHaveBeenCalledOnce();
                expect(status).toBe("reviewed");
              }
            }
          } finally { state.close(); }
        });
      }
    }
  }
  it.each(["public", "unknown"])("scheduler %s discovery and pre-existing queues never post", async (visibility) => {
    apiEnv();
    for (const queued of [false, true]) {
      const root = mkdtempSync(join(tmpdir(), "neondiff-author-scheduler-")); roots.push(root);
      const cfg = config(); cfg.reviewScheduler!.enabled = true; cfg.reviewStatusComment!.enabled = true;
      cfg.commands.enabled = true; cfg.commands.acknowledge = true;
      cfg.evidenceDir = join(root, "evidence"); cfg.statePath = join(root, "state.sqlite");
      const state = new ReviewStateStore(cfg.statePath); const pr = pull(visibility, "NONE");
      if (queued) state.enqueueReviewQueueJob({ repo: "org/repo", pullNumber: 1, headSha: pr.head.sha, baseSha: pr.base.sha });
      const post = vi.fn(); const commands = vi.fn(); const provider = vi.fn();
      try {
        const result = await runScheduledCycleWithDeps({ config: cfg, state,
          github: { listOpenPulls: async () => queued ? [] : [pr], getPull: async () => pr,
            listIssueComments: commands, canPostAsApp: () => true, upsertIssueComment: post },
          options: { dryRun: false }, reviewPullImpl: provider, licenseAdmission: testLicenseAdmission });
        expect(result.skippedPolicy).toBe(1);
        expect(result.queue.staleRetired).toBe(queued ? 1 : 0);
        expect(provider).not.toHaveBeenCalled(); expect(post).not.toHaveBeenCalled(); expect(commands).not.toHaveBeenCalled();
        expect(state.getProcessedReview("org/repo", 1, pr.head.sha)).toMatchObject({ status: "skipped", error: "untrusted_author_public_repo" });
        if (queued) {
          // Terminal, so the job is never re-leased on later cycles.
          expect(state.listReviewQueueJobsForPull({ repo: "org/repo", pullNumber: 1 })[0]).toMatchObject({
            state: "stale_retired", lastError: "untrusted_author_public_repo" });
          const getPull = vi.fn(async () => pr);
          await runScheduledCycleWithDeps({ config: cfg, state,
            github: { listOpenPulls: async () => [], getPull, listIssueComments: commands, canPostAsApp: () => true, upsertIssueComment: post },
            options: { dryRun: false }, reviewPullImpl: provider, licenseAdmission: testLicenseAdmission });
          expect(getPull).not.toHaveBeenCalled();
        }
      } finally { state.close(); }
    }
  });
  it("retires a closed untrusted PR's queued job as closed, not as author-blocked", async () => {
    apiEnv(); const root = mkdtempSync(join(tmpdir(), "neondiff-author-closed-")); roots.push(root);
    const cfg = config(); cfg.reviewScheduler!.enabled = true;
    cfg.evidenceDir = join(root, "evidence"); cfg.statePath = join(root, "state.sqlite");
    const state = new ReviewStateStore(cfg.statePath); const pr = { ...pull("public", "NONE"), state: "closed" };
    state.enqueueReviewQueueJob({ repo: "org/repo", pullNumber: 1, headSha: pr.head.sha, baseSha: pr.base.sha });
    try {
      await runScheduledCycleWithDeps({ config: cfg, state,
        github: { listOpenPulls: async () => [], getPull: async () => pr, canPostAsApp: () => true, upsertIssueComment: vi.fn() },
        options: { dryRun: false }, reviewPullImpl: vi.fn(), licenseAdmission: testLicenseAdmission });
      expect(state.listReviewQueueJobsForPull({ repo: "org/repo", pullNumber: 1 })[0]).toMatchObject({ state: "closed_retired" });
      expect(state.getProcessedReview("org/repo", 1, pr.head.sha)?.error).not.toBe("untrusted_author_public_repo");
    } finally { state.close(); }
  });
  it("reviews a previously gate-skipped head once the gate allows it", async () => {
    apiEnv(); const root = mkdtempSync(join(tmpdir(), "neondiff-author-recover-")); roots.push(root);
    const cfg = config(); cfg.reviewScheduler!.enabled = true;
    cfg.evidenceDir = join(root, "evidence"); cfg.statePath = join(root, "state.sqlite");
    const state = new ReviewStateStore(cfg.statePath); const pr = pull("public", "NONE");
    const github = { listOpenPulls: async () => [pr], getPull: async () => pr, listIssueComments: vi.fn(async () => []),
      canPostAsApp: () => true, upsertIssueComment: vi.fn() };
    const provider = vi.fn(async () => "reviewed" as const);
    try {
      await runScheduledCycleWithDeps({ config: cfg, state, github, options: { dryRun: true },
        reviewPullImpl: provider, licenseAdmission: testLicenseAdmission });
      expect(state.getProcessedReview("org/repo", 1, pr.head.sha)).toMatchObject({ status: "skipped", error: "untrusted_author_public_repo" });
      expect(provider).not.toHaveBeenCalled();
      const gate = cfg.reviewGate!.publicRepoAuthorGate;
      cfg.reviewGate!.publicRepoAuthorGate = { ...gate, allowedLogins: [...gate.allowedLogins, "fixture-author"] };
      await runScheduledCycleWithDeps({ config: cfg, state, github, options: { dryRun: true },
        reviewPullImpl: provider, licenseAdmission: testLicenseAdmission });
      expect(state.getProcessedReview("org/repo", 1, pr.head.sha)?.error).not.toBe("untrusted_author_public_repo");
      const queued = state.listReviewQueueJobsForPull({ repo: "org/repo", pullNumber: 1 });
      expect(provider.mock.calls.length + queued.length).toBeGreaterThan(0);
    } finally { state.close(); }
  });
  it("still records the skip when evidence cannot be written, so discovery is not aborted", () => {
    apiEnv(); const root = mkdtempSync(join(tmpdir(), "neondiff-author-evidence-fail-")); roots.push(root);
    const statePath = join(root, "state.sqlite"); const state = new ReviewStateStore(statePath);
    // The state database is a regular file, so creating evidence directories beneath it fails.
    const cfg = config(); cfg.evidenceDir = join(statePath, "evidence"); const pr = pull("public", "NONE");
    try {
      expect(recordPublicRepoAuthorGateSkip({ config: cfg, state, repo: "org/repo", pull: pr })).toBe(true);
      expect(state.getProcessedReview("org/repo", 1, pr.head.sha)).toMatchObject({ status: "skipped", error: "untrusted_author_public_repo" });
    } finally { state.close(); }
  });
  it("does not rewrite skip evidence on every poll of a still-blocked head", () => {
    apiEnv(); const root = mkdtempSync(join(tmpdir(), "neondiff-author-idempotent-")); roots.push(root);
    const cfg = config(); cfg.evidenceDir = join(root, "evidence");
    const state = new ReviewStateStore(join(root, "state.sqlite")); const pr = pull("public", "NONE");
    try {
      expect(recordPublicRepoAuthorGateSkip({ config: cfg, state, repo: "org/repo", pull: pr })).toBe(true);
      const evidence = findFile(cfg.evidenceDir, "author-gate.json")!;
      rmSync(evidence);
      expect(recordPublicRepoAuthorGateSkip({ config: cfg, state, repo: "org/repo", pull: pr })).toBe(true);
      expect(findFile(cfg.evidenceDir, "author-gate.json")).toBeUndefined();
    } finally { state.close(); }
  });
  it("keeps existing non-failed processed rows when the gate blocks, so clearing the gate cannot drop them", () => {
    apiEnv(); const root = mkdtempSync(join(tmpdir(), "neondiff-author-preserve-")); roots.push(root);
    const cfg = config(); cfg.evidenceDir = join(root, "evidence");
    const state = new ReviewStateStore(join(root, "state.sqlite"));
    try {
      for (const [index, row] of [{ status: "skipped", error: "activation_baseline" }, { status: "dry_run" }].entries()) {
        const pr = { ...pull("public", "NONE"), head: { sha: String(index).repeat(40), ref: "fixture" } };
        state.recordProcessed({ repo: "org/repo", pullNumber: 1, headSha: pr.head.sha, ...row } as Parameters<typeof state.recordProcessed>[0]);
        expect(recordPublicRepoAuthorGateSkip({ config: cfg, state, repo: "org/repo", pull: pr })).toBe(true);
        expect(state.getProcessedReview("org/repo", 1, pr.head.sha)).toMatchObject(row);
        const gate = cfg.reviewGate!.publicRepoAuthorGate;
        const allowed = { ...cfg, reviewGate: { ...cfg.reviewGate!, publicRepoAuthorGate: { ...gate, allowedLogins: ["fixture-author"] } } };
        expect(recordPublicRepoAuthorGateSkip({ config: allowed, state, repo: "org/repo", pull: pr })).toBe(false);
        expect(state.getProcessedReview("org/repo", 1, pr.head.sha)).toMatchObject(row);
      }
    } finally { state.close(); }
  });
  it("failed-head retry preserves the author skip and suppresses status comments", async () => {
    apiEnv(); const root = mkdtempSync(join(tmpdir(), "neondiff-author-retry-")); roots.push(root);
    const cfg = config(); cfg.reviewStatusComment!.enabled = true; cfg.evidenceDir = join(root, "evidence");
    const state = new ReviewStateStore(join(root, "state.sqlite")); const pr = pull("public", "NONE");
    state.recordProcessed({ repo: "org/repo", pullNumber: 1, headSha: pr.head.sha, status: "failed", error: "fixture_failure" });
    const post = vi.fn();
    try {
      const result = await retryFailedHeadWithDeps({ config: cfg, state, budget: new ReviewRunBudget(1),
        github: { getPull: async () => pr, canPostAsApp: () => true, upsertIssueComment: post } as unknown as GitHubApi,
        options: { repo: "org/repo", pullNumber: 1, headSha: pr.head.sha, dryRun: false },
        reviewPullImpl: reviewPull, licenseAdmission: testLicenseAdmission });
      expect(result.status).toBe("untrusted_author_public_repo"); expect(post).not.toHaveBeenCalled();
      expect(state.getProcessedReview("org/repo", 1, pr.head.sha)).toMatchObject({ status: "skipped", error: result.status });
    } finally { state.close(); }
  });
  it("renders the stored reason in operator/dashboard output without a new status enum", () => {
    const coverage: CoverageAuditReport = { ok: true, checkedAt: "2026-10-22T00:00:00Z",
      summary: { reposScanned: 1, pullsSeen: 1, processed: 1, providerDeferred: 0, queued: 0, unprocessed: 0, skipped: 0, staleHeads: 0, readFailures: 0 },
      processed: [{ repo: "org/repo", pullNumber: 1, headSha: "a".repeat(40), title: "Fixture", url: "https://github.test/fixture", draft: false,
        status: "skipped", error: "untrusted_author_public_repo", createdAt: "2026-10-22T00:00:00Z" }],
      providerDeferred: [], queued: [], unprocessed: [], skipped: [], staleHeads: [], readFailures: [] };
    const dashboard = buildOperatorDashboard({ coverage });
    expect(dashboard.items[0].reason).toBe("untrusted_author_public_repo");
    expect(formatOperatorDashboardHuman(dashboard)).toContain("reason=untrusted_author_public_repo");
  });
  it("supports forced modes, disabled Codex, exact case-insensitive bots, and custom associations", () => {
    apiEnv(); const cfg = config(); const stranger = pull("public", "NONE");
    cfg.codexRuntime!.enabled = false;
    expect(isPublicRepoAuthorBlocked(cfg, stranger)).toBe(false);
    cfg.reviewGate!.publicRepoAuthorGate = { mode: "on", allowedAssociations: ["CONTRIBUTOR"], allowedLogins: ["dependabot[bot]"] };
    expect(isPublicRepoAuthorBlocked(cfg, stranger)).toBe(true);
    expect(isPublicRepoAuthorBlocked(cfg, pull("public", "CONTRIBUTOR"))).toBe(false);
    for (const login of ["DEPENDABOT[BOT]", "dependabot[bot]"]) expect(isPublicRepoAuthorBlocked(cfg, pull("public", undefined, login))).toBe(false);
    expect(isPublicRepoAuthorBlocked(cfg, pull("public", undefined, "dependabot[bot]-fake"))).toBe(true);
    apiEnv("codex"); expect(isPublicRepoAuthorBlocked(cfg, stranger)).toBe(true);
    cfg.reviewGate!.publicRepoAuthorGate.mode = "off";
    expect(isPublicRepoAuthorBlocked(cfg, stranger)).toBe(false);
    apiEnv(); const defaults = config();
    expect(isPublicRepoAuthorBlocked(defaults, pull("public", undefined, "ReNoVaTe[BoT]"))).toBe(false);
  });
  it.each([{ mode: "invalid" }, { mode: null }, { allowedAssociations: ["owner"] },
    { allowedAssociations: ["BOGUS"] }, { allowedAssociations: "OWNER" }, { allowedLogins: [""] },
    { allowedLogins: null }, { unexpected: true }])("rejects invalid config %j", (gate) => {
    expect(() => loadConfigFromObject({ reviewGate: { publicRepoAuthorGate: gate } })).toThrow(/publicRepoAuthorGate/);
  });
});
function findFile(root: string, name: string): string | undefined {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isFile() && entry.name === name) return path;
    if (entry.isDirectory()) { const found = findFile(path, name); if (found) return found; }
  }
}
