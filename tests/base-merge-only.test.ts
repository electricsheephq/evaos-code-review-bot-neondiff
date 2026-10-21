import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { loadConfigFromObject } from "../src/config.js";
import { computeOwnDiffFingerprint } from "../src/git.js";
import { GitHubApi } from "../src/github.js";
import { buildReviewHeadGate } from "../src/review-head-gate.js";
import { ReviewStateStore } from "../src/state.js";
import type { PullRequestSummary } from "../src/types.js";
import { ReviewRunBudget } from "../src/review-budget.js";
import { runScheduledCycleWithDeps } from "../src/scheduler.js";
import { isSuccessfulRetryStatus, recoverPostedReviewReceiptForCurrentHead, retryFailedHeadWithDeps, reviewPull } from "../src/worker.js";
import { testLicenseAdmission } from "./helpers/license-admission.js";

const mocks = vi.hoisted(() => ({ provider: vi.fn(), prepare: vi.fn() }));
vi.mock("../src/codex-runtime.js", async (original) => ({
  ...await original<typeof import("../src/codex-runtime.js")>(), runCodexReview: mocks.provider
}));
vi.mock("../src/git.js", async (original) => ({
  ...await original<typeof import("../src/git.js")>(), preparePullWorktree: mocks.prepare
}));
const roots: string[] = [];
const stores: ReviewStateStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks(); vi.clearAllMocks();
});
function fixture() {
  const temp = mkdtempSync(join(tmpdir(), "neondiff-base-merge-")); roots.push(temp);
  const root = join(temp, "repo"); mkdirSync(root);
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-b", "main"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.test");
  const commit = (name: string, text: string) => {
    writeFileSync(join(root, name), text); git("add", name); git("commit", "-m", "fixture"); return git("rev-parse", "HEAD");
  };
  const base = commit("review.py", "def f():\n    before()\n");
  git("checkout", "-b", "pr"); const h1 = commit("review.py", "def f():\n    after()\n");
  const state = new ReviewStateStore(join(temp, "state.sqlite")); stores.push(state);
  const config = loadConfigFromObject({ workRoot: join(temp, "work"), evidenceDir: join(temp, "evidence"),
    pilotRepos: ["org/repo"], repoProfiles: { repos: { "org/repo": { enabled: true } } },
    codexRuntime: { enabled: true }, commands: { enabled: false }, walkthrough: { enabled: false },
    contextBudget: { enabled: false }, activation: { reviewExistingOpenPrsOnActivation: true } });
  const pull: PullRequestSummary = { number: 1, title: "Fixture", draft: false, state: "open", authorAssociation: "OWNER",
    head: { sha: h1, ref: "pr" }, base: { sha: base, ref: "main", repo: { full_name: "org/repo", visibility: "private" } },
    html_url: "https://github.com/org/repo/pull/1" };
  const post = vi.fn(async () => ({ id: 1, html_url: "https://github.com/org/repo/pull/1#pullrequestreview-1" }));
  const github = { getPull: vi.fn(async () => pull), listPullFiles: async () => [{ filename: "review.py", status: "modified",
    patch: "@@ -1,2 +1,2 @@\n def f():\n-    before()\n+    after()", additions: 1, deletions: 1, changes: 2 }],
    listIssueComments: async () => [], listPullReviewComments: async () => [],
    canPostAsApp: () => true, canPost: () => true, createReview: post, upsertIssueComment: vi.fn() } as unknown as GitHubApi;
  mocks.prepare.mockImplementation(({ expectedHeadSha }) => ({ path: root, headSha: expectedHeadSha }));
  mocks.provider.mockResolvedValue({ findings: [], droppedFromSchema: [], rawResponse: '{"findings":[]}', attempts: 1, degradedRecovery: false });
  const run = (extra = {}) => reviewPull({ config, github, state, repo: "org/repo", pull, dryRun: true,
    useZCode: true, licenseAdmission: testLicenseAdmission, ...extra });
  const anchor = async (error?: string) => {
    const fp = await computeOwnDiffFingerprint(root, base, h1);
    if ("error" in fp) throw new Error(fp.error);
    state.recordProcessed({ repo: "org/repo", pullNumber: 1, headSha: h1, status: "posted", event: "COMMENT",
      reviewUrl: "https://github.com/org/repo/pull/1#pullrequestreview-1", baseRef: "main", baseSha: base, diffFingerprint: fp.fingerprint,
      ...(error ? { error } : {}) });
    return fp;
  };
  const mergeBase = () => {
    git("checkout", "main"); const sha = commit("base.txt", `${git("rev-parse", "HEAD")}\n`);
    git("checkout", "pr"); git("merge", "--no-edit", "main");
    pull.head.sha = git("rev-parse", "HEAD"); pull.base.sha = sha; return pull.head.sha;
  };
  const evidence = () => {
    const find = (dir: string): string | undefined => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.name === "base-merge-only.json") return path;
        if (entry.isDirectory()) { const found = find(path); if (found) return found; }
      }
    };
    const path = find(config.evidenceDir); return path ? JSON.parse(readFileSync(path, "utf8")) : undefined;
  };
  return { root, git, commit, base, h1, state, config, pull, github, post, run, anchor, mergeBase, evidence };
}
it("skips only base merges, writes evidence/readiness, and compares skip chains directly to H1", async () => {
  const f = fixture(); await f.anchor("review_posted_head_changed"); f.mergeBase();
  expect(await f.run()).toBe("skipped_base_merge_only");
  expect(mocks.provider).not.toHaveBeenCalled(); expect(f.post).not.toHaveBeenCalled();
  expect(f.state.getProcessedReview("org/repo", 1, f.pull.head.sha)).toMatchObject({
    status: "skipped", error: "base_merge_only", carriedFromHead: f.h1, baseRef: "main", baseSha: f.pull.base.sha });
  expect(f.state.getReviewReadiness("org/repo", 1, f.pull.head.sha)).toMatchObject({ state: "skipped", reason: "base_merge_only" });
  expect(f.evidence()).toMatchObject({ decision: "skipped", previousHead: f.h1, newHead: f.pull.head.sha });
  f.mergeBase(); expect(await f.run()).toBe("skipped_base_merge_only");
  expect(f.state.getProcessedReview("org/repo", 1, f.pull.head.sha)?.carriedFromHead).toBe(f.h1);
  expect(isSuccessfulRetryStatus("skipped_base_merge_only")).toBe(true);
});
it.each(["new_commit", "indentation", "conflict"])("reviews a real change: %s", async (kind) => {
  const f = fixture(); await f.anchor();
  if (kind === "conflict") {
    f.git("checkout", "main"); f.pull.base.sha = f.commit("review.py", "def f():\n    base_change()\n"); f.git("checkout", "pr");
    expect(() => f.git("merge", "--no-edit", "main")).toThrow();
    f.pull.head.sha = f.commit("review.py", "def f():\n    resolved()\n");
  } else {
    f.pull.head.sha = f.commit("review.py", kind === "indentation" ? "def f():\n        after()\n" : "def f():\n    changed_again()\n");
    f.mergeBase();
  }
  expect(await f.run()).toBe("reviewed"); expect(mocks.provider).toHaveBeenCalledOnce();
  expect(f.evidence()).toMatchObject({ decision: "reviewed", reason: "fingerprint_differs" });
});
it("reviews a rebased identical own diff because the anchor is no longer an ancestor", async () => {
  const f = fixture(); const old = await f.anchor();
  f.git("checkout", "main"); f.pull.base.sha = f.commit("base.txt", "base\n");
  f.git("checkout", "pr"); f.git("rebase", "main"); f.pull.head.sha = f.git("rev-parse", "HEAD");
  expect(await computeOwnDiffFingerprint(f.root, f.pull.base.sha, f.pull.head.sha)).toMatchObject({ fingerprint: old.fingerprint });
  expect(await f.run()).toBe("reviewed"); expect(f.evidence().reason).toBe("not_ancestor");
});
it("reviews a retargeted PR", async () => {
  const f = fixture(); await f.anchor(); f.mergeBase(); f.pull.base.ref = "release";
  expect(await f.run()).toBe("reviewed"); expect(f.evidence().reason).toBe("base_ref_changed");
});
it.each(["skipped", "dry_run", "failed", "legacy", "unverified", "other_error"])("does not anchor %s rows", async (kind) => {
  const f = fixture(); await f.anchor();
  const row = f.state.getProcessedReview("org/repo", 1, f.h1)!;
  f.state.recordProcessed({ ...row, status: ["skipped", "dry_run", "failed"].includes(kind) ? kind as "skipped" | "dry_run" | "failed" : "posted",
    diffFingerprint: kind === "legacy" ? undefined : row.diffFingerprint,
    error: kind === "unverified" ? "post_review_head_unverified" : kind === "other_error" ? "unexpected" : undefined });
  f.mergeBase(); expect(await f.run()).toBe("reviewed"); expect(f.evidence().reason).toBe("no_anchor");
});
it.each(["manual", "operator", "ci", "disabled", "excluded"])("always reviews %s runs", async (kind) => {
  const f = fixture(); await f.anchor(); f.mergeBase();
  const lookup = vi.spyOn(f.state, "getBaseMergeOnlyAnchor");
  if (kind === "disabled") f.config.baseMergeOnlySkip = { enabled: false };
  if (kind === "excluded") f.config.baseMergeOnlySkip = { excludeRepos: ["ORG/REPO"] };
  if (kind === "manual") {
    f.config.commands.enabled = true; f.config.commands.trustedAuthors = ["owner"];
    f.github.listIssueComments = async () => [{ id: 42, body: "@neondiff re-review", user: { login: "owner", type: "User" } }];
  }
  expect(await f.run({ ...(kind === "operator" ? { explicitPullReview: { repo: "org/repo", pullNumber: 1 } } : {}),
    ...(kind === "ci" ? { ci: true } : {}) })).toMatch(/^reviewed/);
  expect(mocks.provider).toHaveBeenCalledOnce();
  if (["manual", "operator", "ci"].includes(kind)) { expect(lookup).not.toHaveBeenCalled(); expect(f.evidence()).toBeUndefined(); }
  else expect(f.evidence().reason).toBe("excluded");
});
it("reviews on a fingerprint error", async () => {
  const f = fixture(); await f.anchor(); f.mergeBase(); f.pull.base.sha = "f".repeat(40);
  expect(await f.run()).toBe("reviewed"); expect(f.evidence().reason).toBe("fingerprint_error");
});
it("reviews criss-cross histories with multiple merge bases", async () => {
  const f = fixture(); await f.anchor();
  f.git("checkout", "main"); const b = f.commit("base.txt", "b\n");
  // Two merges of the same parents in opposite order have two best common ancestors.
  const tree = f.git("rev-parse", `${f.h1}^{tree}`);
  const aMerge = f.git("commit-tree", tree, "-p", f.h1, "-p", b, "-m", "merge-a");
  const bMerge = f.git("commit-tree", tree, "-p", b, "-p", f.h1, "-m", "merge-b");
  f.pull.head.sha = aMerge; f.pull.base.sha = bMerge;
  expect(f.git("merge-base", "--all", aMerge, bMerge).split("\n")).toHaveLength(2);
  expect(await f.run()).toBe("reviewed"); expect(f.evidence().reason).toBe("fingerprint_error");
});
it("stores the fingerprint on a real posted review", async () => {
  const f = fixture(); vi.spyOn(GitHubApi.prototype, "createReview").mockImplementation(f.post); expect(await f.run({ dryRun: false })).toBe("reviewed");
  expect(f.state.getProcessedReview("org/repo", 1, f.h1)).toMatchObject({ status: "posted", baseRef: "main", baseSha: f.base,
    diffFingerprint: expect.stringMatching(/^git-patch-id-verbatim-v1:[a-f0-9]{40}$/) });
});
it("migrates legacy state without losing rows and orders by original post time, then rowid", async () => {
  const root = mkdtempSync(join(tmpdir(), "neondiff-old-state-")); roots.push(root);
  const path = join(root, "old.sqlite"); const db = new DatabaseSync(path);
  db.exec(`create table processed_reviews (repo text, pull_number integer, head_sha text, status text, event text,
    review_url text, error text, created_at text, primary key(repo,pull_number,head_sha));
    insert into processed_reviews values ('org/repo',1,'legacy','posted','COMMENT','https://github.com/old',null,'2020-01-01');`);
  db.close(); const state = new ReviewStateStore(path); stores.push(state);
  expect(state.listProcessedReviewsForPull("org/repo", 1)).toHaveLength(1);
  expect(state.getBaseMergeOnlyAnchor("org/repo", 1)).toBeUndefined();
  const common = { repo: "org/repo", pullNumber: 1, status: "posted" as const, reviewUrl: "https://github.com/review", diffFingerprint: "fp" };
  state.recordProcessed({ ...common, headSha: "old" });
  state.recordProcessed({ ...common, headSha: "new" });
  const tie = new DatabaseSync(path);
  tie.exec("update processed_reviews set created_at='2026-10-01T00:00:00.000Z' where head_sha in ('old','new')"); tie.close();
  const newest = state.getBaseMergeOnlyAnchor("org/repo", 1)!; expect(newest.headSha).toBe("new");
  state.recordProcessed({ ...common, headSha: "old", error: "review_posted_head_changed" });
  expect(state.getBaseMergeOnlyAnchor("org/repo", 1)?.headSha).toBe(newest.headSha);
});
it.each(["COMMENT", "REQUEST_CHANGES"] as const)("carries exactly one hop of %s and leaves other skips alone", (event) => {
  const f = fixture(); const head = "a".repeat(40);
  f.state.recordProcessed({ repo: "org/repo", pullNumber: 1, headSha: f.h1, status: "posted", event });
  const check = () => buildReviewHeadGate({ state: f.state, repo: "org/repo", pullNumber: 1, headSha: head });
  f.state.recordProcessed({ repo: "org/repo", pullNumber: 1, headSha: head, status: "skipped", error: "base_merge_only", carriedFromHead: f.h1 });
  expect(check()).toMatchObject({ decision: event === "COMMENT" ? "passed" : "needs_fix", carriedFromHead: f.h1 });
  f.state.recordProcessed({ repo: "org/repo", pullNumber: 1, headSha: f.h1, status: "skipped", error: "other", carriedFromHead: "b".repeat(40) });
  expect(check().decision).toBe("skipped");
  f.state.recordProcessed({ repo: "org/repo", pullNumber: 1, headSha: head, status: "skipped", error: "base_merge_only", carriedFromHead: "c".repeat(40) });
  expect(check().decision).toBe("skipped");
  f.state.recordProcessed({ repo: "org/repo", pullNumber: 1, headSha: head, status: "skipped", error: "other", carriedFromHead: f.h1 });
  expect(check().decision).toBe("skipped");
});
it("rejects empty own diffs and invalid config", async () => {
  const f = fixture(); expect(await computeOwnDiffFingerprint(f.root, f.base, f.base)).toHaveProperty("error");
  expect(loadConfigFromObject({}).baseMergeOnlySkip).toEqual({ enabled: true, excludeRepos: [] });
  for (const value of [null, false, { enabled: "true" }, { excludeRepos: ["bad"] }, { excludeRepos: null }, { extra: true }]) {
    expect(() => loadConfigFromObject({ baseMergeOnlySkip: value })).toThrow(/baseMergeOnlySkip/);
  }
});

it("keeps an existing posted row when a competing skip tries to replace it", async () => {
  const f = fixture(); await f.anchor();
  const posted = f.state.getProcessedReview("org/repo", 1, f.h1);
  f.state.recordProcessed({ repo: "org/repo", pullNumber: 1, headSha: f.h1, status: "skipped", error: "base_merge_only", carriedFromHead: "other" });
  expect(f.state.getProcessedReview("org/repo", 1, f.h1)).toEqual(posted);
});
it("streams a diff larger than the existing git helper buffer", async () => {
  const f = fixture();
  const head = f.commit("large.txt", "line for a large diff\n".repeat(550_000));
  expect(await computeOwnDiffFingerprint(f.root, f.base, head)).toHaveProperty("fingerprint");
});
it.each(["stale", "unverified", "recovery", "recovery_stale", "recovery_unverified"])("retains metadata through %s post persistence", async (kind) => {
  const f = fixture();
  vi.spyOn(GitHubApi.prototype, "createReview").mockImplementation(async () => {
    if (kind.includes("stale")) f.github.getPull = async () => ({ ...f.pull, head: { ...f.pull.head, sha: "f".repeat(40) } });
    if (kind.includes("unverified")) f.github.getPull = async () => { throw new Error("fixture lookup failure"); };
    return { id: 1, html_url: "https://github.com/org/repo/pull/1#pullrequestreview-1" };
  });
  if (kind.startsWith("recovery")) vi.spyOn(f.state, "recordProcessed").mockImplementationOnce(() => { throw new Error("fixture persistence failure"); });
  let result: unknown;
  try { result = await f.run({ dryRun: false }); }
  catch (error) { result = await recoverPostedReviewReceiptForCurrentHead({ config: f.config, github: f.github, state: f.state, repo: "org/repo", pull: f.pull, error }); }
  expect(result).toBe(kind.includes("stale") ? "posted_stale_head" : kind.includes("unverified") ? "posted_head_unverified" : "reviewed");
  expect(f.state.getProcessedReview("org/repo", 1, f.h1)).toMatchObject({ status: "posted", baseRef: "main", baseSha: f.base,
    diffFingerprint: expect.stringMatching(/^git-patch-id-verbatim-v1:[a-f0-9]{40}$/) });
  expect(Boolean(f.state.getBaseMergeOnlyAnchor("org/repo", 1))).toBe(!kind.includes("unverified"));
});
it("scheduler skips terminally, posts no status comment, and backfills skipped readiness without failure", async () => {
  const f = fixture(); await f.anchor(); f.mergeBase();
  f.config.reviewScheduler!.enabled = true; f.config.reviewStatusComment!.enabled = true;
  const upsert = vi.fn();
  const github = { ...f.github, listOpenPulls: async () => [f.pull], upsertIssueComment: upsert };
  const cycle = () => runScheduledCycleWithDeps({ config: f.config, github, state: f.state,
    options: { dryRun: false }, reviewPullImpl: reviewPull, licenseAdmission: testLicenseAdmission });
  const result = await cycle();
  expect(result).toMatchObject({ skippedPolicy: 1, failed: 0, queue: { staleRetired: 1, failedQueueJobs: 0 } });
  expect(f.state.listReviewQueueJobsForPull({ repo: "org/repo", pullNumber: 1 })[0]?.state).toBe("stale_retired");
  await cycle(); expect(upsert).not.toHaveBeenCalled(); expect(f.post).not.toHaveBeenCalled(); expect(mocks.provider).not.toHaveBeenCalled();
  expect(f.state.getReviewReadiness("org/repo", 1, f.pull.head.sha)).toMatchObject({ state: "skipped", reason: "base_merge_only" });
});
it.each(["failed", "cooldown"])("retires a %s retry as a successful policy skip", async (kind) => {
  const f = fixture(); await f.anchor(); f.mergeBase(); f.config.reviewStatusComment!.enabled = true;
  f.state.recordProcessed({ repo: "org/repo", pullNumber: 1, headSha: f.pull.head.sha,
    status: kind === "failed" ? "failed" : "skipped",
    error: kind === "failed" ? "fixture failure" : "provider_rate_limit_cooldown_until=2020-01-01T00:00:00.000Z; reason=fixture" });
  f.state.enqueueReviewQueueJob({ repo: "org/repo", pullNumber: 1, headSha: f.pull.head.sha, baseSha: f.pull.base.sha });
  const result = await retryFailedHeadWithDeps({ config: f.config, state: f.state, github: f.github,
    budget: new ReviewRunBudget(1), options: { repo: "org/repo", pullNumber: 1, headSha: f.pull.head.sha, dryRun: false },
    reviewPullImpl: reviewPull, licenseAdmission: testLicenseAdmission });
  expect(result.status).toBe("skipped_base_merge_only"); expect(isSuccessfulRetryStatus(result.status)).toBe(true);
  expect(f.state.listReviewQueueJobsForPull({ repo: "org/repo", pullNumber: 1 })[0]?.state).toBe("stale_retired");
  expect(mocks.provider).not.toHaveBeenCalled(); expect(f.github.upsertIssueComment).not.toHaveBeenCalled();
});
