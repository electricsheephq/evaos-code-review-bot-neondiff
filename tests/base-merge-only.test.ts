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
import { buildReviewStatusComment } from "../src/review-status-comment.js";
import { testLicenseAdmission } from "./helpers/license-admission.js";

const mocks = vi.hoisted(() => ({ provider: vi.fn(), prepare: vi.fn(), patchOutput: undefined as string | undefined }));
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return { ...actual, spawn: (command: string, args: string[], options: object) =>
    mocks.patchOutput !== undefined && args.includes("patch-id")
      // The fixture output travels in the environment, not in the evaluated code.
      ? actual.spawn(process.execPath, ["-e", "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(process.env.NEONDIFF_TEST_PATCH_OUTPUT));"],
        { ...options, env: { ...((options as { env?: NodeJS.ProcessEnv }).env ?? process.env), NEONDIFF_TEST_PATCH_OUTPUT: mocks.patchOutput } })
      : actual.spawn(command, args, options) };
});
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
  vi.restoreAllMocks(); vi.clearAllMocks(); mocks.patchOutput = undefined;
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
  vi.spyOn(GitHubApi.prototype, "createReview").mockImplementation(post);
  const run = (extra = {}) => reviewPull({ config, github, state, repo: "org/repo", pull, dryRun: false,
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
  expect(await f.run({ dryRun: false })).toBe("skipped_base_merge_only");
  expect(mocks.provider).not.toHaveBeenCalled(); expect(f.post).not.toHaveBeenCalled();
  expect(f.state.getProcessedReview("org/repo", 1, f.pull.head.sha)).toMatchObject({
    status: "skipped", error: "base_merge_only", carriedFromHead: f.h1, baseRef: "main", baseSha: f.pull.base.sha });
  expect(f.state.getReviewReadiness("org/repo", 1, f.pull.head.sha)).toMatchObject({ state: "skipped", reason: "base_merge_only" });
  expect(f.evidence()).toMatchObject({ decision: "skipped", previousHead: f.h1, newHead: f.pull.head.sha });
  f.mergeBase(); expect(await f.run({ dryRun: false })).toBe("skipped_base_merge_only");
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
it("reviews an edit moved between identical blocks despite a matching fingerprint", async () => {
  const f = fixture();
  const block = "def g():\n    a()\n    b()\n    target()\n    c()\n    d()\n    e()\n";
  const file = (first: string, second: string) =>
    block.replace("target", first) + "\n# one\n# two\n# three\n# four\n\n" + block.replace("target", second);
  f.git("checkout", "main"); f.pull.base.sha = f.commit("review.py", file("target", "target"));
  f.git("checkout", "pr"); f.git("merge", "--no-edit", "-X", "theirs", "main");
  const h1 = f.pull.head.sha = f.commit("review.py", file("changed", "target"));
  const fp = await computeOwnDiffFingerprint(f.root, f.pull.base.sha, h1);
  if ("error" in fp) throw new Error(fp.error);
  f.state.recordProcessed({ repo: "org/repo", pullNumber: 1, headSha: h1, status: "posted", event: "COMMENT",
    reviewUrl: "https://github.com/org/repo/pull/1#pullrequestreview-1", baseRef: "main", baseSha: f.pull.base.sha,
    diffFingerprint: fp.fingerprint });
  f.mergeBase(); f.pull.head.sha = f.commit("review.py", file("target", "changed"));
  // The own-diff fingerprint ignores hunk coordinates, so it cannot tell the two blocks apart.
  expect(await computeOwnDiffFingerprint(f.root, f.pull.base.sha, f.pull.head.sha))
    .toMatchObject({ fingerprint: fp.fingerprint });
  expect(await f.run()).toBe("reviewed"); expect(mocks.provider).toHaveBeenCalledOnce();
  expect(f.evidence()).toMatchObject({ decision: "reviewed", reason: "merge_tree_differs" });
});
it("does not bypass a newer fingerprint-less posted review for an older eligible anchor", async () => {
  const f = fixture(); await f.anchor(); const h2 = f.mergeBase();
  f.state.recordProcessed({ repo: "org/repo", pullNumber: 1, headSha: h2, status: "posted", event: "REQUEST_CHANGES",
    reviewUrl: "https://github.com/org/repo/pull/1#pullrequestreview-2", baseRef: "main", baseSha: f.pull.base.sha });
  f.mergeBase();
  expect(await f.run()).toBe("reviewed"); expect(f.evidence()).toMatchObject({ decision: "reviewed", reason: "no_anchor" });
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
  expect(check().gates[0]?.detail).toContain(`status=posted event=${event}`);
  expect(check().gates[0]?.detail).toContain(`carried from ${f.h1.slice(0, 12)} via a base-merge-only push`);
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
  expect(f.state.listReviewQueueJobsForPull({ repo: "org/repo", pullNumber: 1 })[0]).toMatchObject({
    state: "stale_retired", lastError: "base_merge_only" });
  await cycle(); expect(upsert).not.toHaveBeenCalled(); expect(f.post).not.toHaveBeenCalled(); expect(mocks.provider).not.toHaveBeenCalled();
  expect(f.state.getReviewReadiness("org/repo", 1, f.pull.head.sha)).toMatchObject({ state: "skipped", reason: "base_merge_only" });
});
it.each(["queued", "failed"] as const)("normalizes %s queue retirement for an existing carried skip", async (queueState) => {
  const f = fixture(); await f.anchor(); f.mergeBase();
  expect(await f.run()).toBe("skipped_base_merge_only");
  f.config.reviewScheduler!.enabled = true;
  const queued = f.state.enqueueReviewQueueJob({ repo: "org/repo", pullNumber: 1,
    headSha: f.pull.head.sha, baseSha: f.pull.base.sha });
  if (queueState === "failed") f.state.updateReviewQueueJobState({ jobId: queued.job.jobId,
    state: "failed", lastError: "processed_head_already_skipped" });
  await runScheduledCycleWithDeps({ config: f.config, state: f.state,
    github: { ...f.github, listOpenPulls: async () => [f.pull] }, options: { dryRun: false },
    reviewPullImpl: reviewPull, licenseAdmission: testLicenseAdmission });
  expect(f.state.listReviewQueueJobsForPull({ repo: "org/repo", pullNumber: 1 })[0]).toMatchObject({
    state: "stale_retired", lastError: "base_merge_only" });
});
it.each(["failed", "cooldown"])("retires a %s retry as a successful policy skip", async (kind) => {
  const f = fixture(); await f.anchor(); f.mergeBase(); f.config.reviewStatusComment!.enabled = true;
  f.config.reviewScheduler!.enabled = true;
  f.state.recordProcessed({ repo: "org/repo", pullNumber: 1, headSha: f.pull.head.sha,
    status: kind === "failed" ? "failed" : "skipped",
    error: kind === "failed" ? "fixture failure" : "provider_rate_limit_cooldown_until=2020-01-01T00:00:00.000Z; reason=fixture" });
  f.state.enqueueReviewQueueJob({ repo: "org/repo", pullNumber: 1, headSha: f.pull.head.sha, baseSha: f.pull.base.sha });
  const result = await retryFailedHeadWithDeps({ config: f.config, state: f.state, github: f.github,
    budget: new ReviewRunBudget(1), options: { repo: "org/repo", pullNumber: 1, headSha: f.pull.head.sha, dryRun: false },
    reviewPullImpl: reviewPull, licenseAdmission: testLicenseAdmission });
  expect(result.status).toBe("skipped_base_merge_only"); expect(isSuccessfulRetryStatus(result.status)).toBe(true);
  const row = f.state.getProcessedReview("org/repo", 1, f.pull.head.sha);
  // This is the daemon's cooldown-retry selector, independent of scheduler mode.
  expect(f.state.listProviderCooldownReviews({ repo: "org/repo", expiredOnly: true })).toEqual([]);
  expect(row).toMatchObject({ status: "skipped", error: "base_merge_only", carriedFromHead: f.h1 });
  const prepareCount = mocks.prepare.mock.calls.length;
  await runScheduledCycleWithDeps({ config: f.config, state: f.state,
    github: { ...f.github, listOpenPulls: async () => [f.pull] }, options: { dryRun: false },
    reviewPullImpl: reviewPull, licenseAdmission: testLicenseAdmission });
  expect(mocks.prepare).toHaveBeenCalledTimes(prepareCount);
  expect(f.state.getProcessedReview("org/repo", 1, f.pull.head.sha)).toEqual(row);
  expect(f.state.listReviewQueueJobsForPull({ repo: "org/repo", pullNumber: 1 })[0]).toMatchObject({
    state: "stale_retired", lastError: "base_merge_only" });
  expect(mocks.provider).not.toHaveBeenCalled(); expect(f.github.upsertIssueComment).not.toHaveBeenCalled();
});

it.each(["daemon", "retry"])("dry %s runs review rather than persisting a base-merge skip", async (kind) => {
  const f = fixture(); await f.anchor(); f.mergeBase();
  if (kind === "retry") f.state.recordProcessed({ repo: "org/repo", pullNumber: 1, headSha: f.pull.head.sha,
    status: "failed", error: "fixture failure" });
  expect(await f.run({ dryRun: true, ...(kind === "retry" ? { processedHeadPolicy: "retry_failed_head" } : {}) }))
    .not.toBe("skipped_base_merge_only");
  expect(mocks.provider).toHaveBeenCalledOnce();
  expect(f.state.getProcessedReview("org/repo", 1, f.pull.head.sha)?.error).not.toBe("base_merge_only");
});
it.each(["operator", "manual"])("%s can review an already skipped head", async (kind) => {
  const f = fixture(); await f.anchor(); f.mergeBase();
  expect(await f.run({ dryRun: false })).toBe("skipped_base_merge_only");
  // A leased manual queue job can arrive without another command lookup.
  const extra = kind === "operator" ? { explicitPullReview: { repo: "org/repo", pullNumber: 1 } } : { manualQueueJob: true };
  if (kind === "operator") expect(await f.run({ ...extra, dryRun: true, configRevision: "a".repeat(64) })).toMatch(/^reviewed/);
  vi.spyOn(GitHubApi.prototype, "createReview").mockImplementation(f.post);
  expect(await f.run({ ...extra, dryRun: false,
    ...(kind === "operator" ? { processedHeadPolicy: "approved_dry_run", configRevision: "a".repeat(64) } : {}) })).toMatch(/^reviewed/);
  expect(f.state.getProcessedReview("org/repo", 1, f.pull.head.sha)?.status).toBe("posted");
  expect(mocks.provider).toHaveBeenCalled();
});
it.each([false, true])("preserves a posted row arriving before %s dry-run/claim supersession", async (dryRun) => {
  const f = fixture(); await f.anchor(); f.mergeBase();
  expect(await f.run()).toBe("skipped_base_merge_only");
  const winner = { repo: "org/repo", pullNumber: 1, headSha: f.pull.head.sha, status: "posted" as const,
    reviewUrl: "https://github.com/org/repo/pull/1#pullrequestreview-99" };
  mocks.provider.mockImplementationOnce(async () => {
    f.state.recordProcessed(winner);
    return { findings: [], droppedFromSchema: [], rawResponse: '{"findings":[]}', attempts: 1, degradedRecovery: false };
  });
  const claim = vi.spyOn(f.state, "tryClaimReviewHeadWithOutcome");
  const record = vi.spyOn(f.state, "tryRecordDryRun");
  expect(await f.run({ dryRun, manualQueueJob: true })).toBe("skipped_processed");
  expect(f.state.getProcessedReview("org/repo", 1, f.pull.head.sha)).toMatchObject(winner);
  expect(f.post).not.toHaveBeenCalled();
  if (dryRun) expect(record).toHaveBeenCalledWith(expect.objectContaining({ allowBaseMergeOnlySupersession: false }));
  else expect(claim).toHaveBeenCalledWith(expect.objectContaining({ allowProcessedOwnerSupersession: false }));
});
it("re-checks the carried skip inside the claim transaction", async () => {
  const f = fixture(); await f.anchor(); f.mergeBase();
  expect(await f.run()).toBe("skipped_base_merge_only");
  const winner = { repo: "org/repo", pullNumber: 1, headSha: f.pull.head.sha, status: "posted" as const,
    reviewUrl: "https://github.com/org/repo/pull/1#pullrequestreview-99" };
  const realClaim = f.state.tryClaimReviewHeadWithOutcome.bind(f.state);
  // Another run posts after the pre-claim read but before this run's claim transaction.
  const claim = vi.spyOn(f.state, "tryClaimReviewHeadWithOutcome").mockImplementationOnce((input) => {
    f.state.recordProcessed(winner);
    return realClaim(input);
  });
  vi.spyOn(GitHubApi.prototype, "createReview").mockImplementation(f.post);
  expect(await f.run({ dryRun: false, manualQueueJob: true })).toBe("skipped_processed");
  expect(claim).toHaveBeenCalledWith(expect.objectContaining({ allowProcessedOwnerSupersession: true,
    requiredProcessedStatusForSupersession: "skipped", requiredProcessedErrorForSupersession: "base_merge_only" }));
  expect(f.state.getProcessedReview("org/repo", 1, f.pull.head.sha)).toMatchObject(winner);
  expect(f.post).not.toHaveBeenCalled();
});
it.each(["dry_run", "posted", "claim"])("a racing %s prevents the skip and readiness write", async (kind) => {
  const f = fixture(); await f.anchor(); f.mergeBase();
  const selectAnchor = f.state.getBaseMergeOnlyAnchor.bind(f.state);
  let claimId: string | undefined;
  // The winner lands after anchor selection, so only the skip writer can refuse it.
  vi.spyOn(f.state, "getBaseMergeOnlyAnchor").mockImplementationOnce((...args) => {
    const anchor = selectAnchor(...args);
    if (kind === "claim") claimId = f.state.tryClaimReviewHead({ repo: "org/repo", pullNumber: 1,
      headSha: f.pull.head.sha, claimTtlMs: 60_000 })?.claimId;
    else f.state.recordProcessed({ repo: "org/repo", pullNumber: 1, headSha: f.pull.head.sha, status: kind });
    f.state.recordReviewReadiness({ repo: "org/repo", pullNumber: 1, headSha: f.pull.head.sha, state: "reviewing", reason: "winner" });
    return anchor;
  });
  expect(await f.run({ dryRun: false })).toBe("skipped_processed");
  expect(f.evidence()).toMatchObject({ decision: "refused", reason: kind === "claim" ? "active_claim" : "existing_row" });
  expect(f.state.getProcessedReview("org/repo", 1, f.pull.head.sha)?.status).toBe(kind === "claim" ? undefined : kind);
  expect(f.state.getReviewReadiness("org/repo", 1, f.pull.head.sha)?.reason).toBe("winner");
  if (claimId) {
    expect(f.state.tryClaimReviewHeadWithOutcome({ repo: "org/repo", pullNumber: 1, headSha: f.pull.head.sha,
      claimTtlMs: 60_000 })).toMatchObject({ status: "blocked", reason: "active_claim" });
    f.state.releaseReviewHeadClaim(claimId);
  }
});
it.each(["settled", "missing", "disabled", "dry_run"])("benign %s status settlement makes no call or failure", async (kind) => {
  const f = fixture(); await f.anchor(); f.mergeBase();
  expect(await f.run()).toBe("skipped_base_merge_only");
  f.config.reviewScheduler!.enabled = true; f.config.reviewStatusComment!.enabled = kind !== "disabled";
  const comment = buildReviewStatusComment({ repo: "org/repo", pullNumber: 1, headSha: f.pull.head.sha,
    state: kind === "settled" ? "completed" : "provider_deferred",
    reviewUrl: kind === "settled" ? "https://github.com/org/repo/pull/1#pullrequestreview-1" : undefined });
  const list = vi.fn(async () => kind === "missing" ? [] : [{ id: 9, body: comment.body,
    user: { login: f.config.github.botLogin ?? "evaos-code-review-bot[bot]", type: "Bot" } }]);
  const result = await runScheduledCycleWithDeps({ config: f.config, state: f.state,
    github: { ...f.github, listIssueComments: list, listOpenPulls: async () => [f.pull] }, options: { dryRun: kind === "dry_run" },
    reviewPullImpl: reviewPull, licenseAdmission: testLicenseAdmission });
  expect(f.github.upsertIssueComment).not.toHaveBeenCalled();
  expect(result).toMatchObject({ failed: 0, statusCommentFailures: 0 });
  if (["settled", "missing"].includes(kind)) expect(list).toHaveBeenCalled();
  else expect(list).not.toHaveBeenCalled();
});

it("repairs a base-merge status comment on the next sweep after a failed settle", async () => {
  const f = fixture(); await f.anchor(); f.mergeBase();
  f.config.reviewScheduler!.enabled = true; f.config.reviewStatusComment!.enabled = true;
  const comment = buildReviewStatusComment({ repo: "org/repo", pullNumber: 1, headSha: f.pull.head.sha, state: "provider_deferred" });
  f.github.listIssueComments = async () => [{ id: 9, body: comment.body,
    user: { login: f.config.github.botLogin ?? "evaos-code-review-bot[bot]", type: "Bot" } }];
  const upsert = vi.mocked(f.github.upsertIssueComment);
  upsert.mockRejectedValueOnce(new Error("fixture settle failed"));
  upsert.mockResolvedValue({ action: "updated", id: 9 });
  const cycle = () => runScheduledCycleWithDeps({ config: f.config, state: f.state,
    github: { ...f.github, listOpenPulls: async () => [f.pull] }, options: { dryRun: false },
    reviewPullImpl: reviewPull, licenseAdmission: testLicenseAdmission });
  expect(await cycle()).toMatchObject({ statusCommentFailures: 1 });
  expect(await cycle()).toMatchObject({ statusCommentFailures: 0 });
  expect(upsert).toHaveBeenCalledTimes(2);
  expect(upsert).toHaveBeenLastCalledWith(expect.objectContaining({ body: expect.stringContaining("status=completed") }));
  expect(mocks.provider).not.toHaveBeenCalled();
});
it.each(["scheduler", "retry"].flatMap((kind) =>
  ["provider_deferred", "queued", "failed"].map((status) => [kind, status] as const)
))("settles existing comments on %s skip from %s", async (kind, status) => {
  const f = fixture(); await f.anchor(); f.mergeBase();
  f.config.reviewScheduler!.enabled = true; f.config.reviewStatusComment!.enabled = true;
  const deferred = buildReviewStatusComment({ repo: "org/repo", pullNumber: 1, headSha: f.pull.head.sha, state: status as "provider_deferred" | "queued" | "failed" });
  f.github.listIssueComments = async () => [{ id: 9, body: deferred.body,
    user: { login: f.config.github.botLogin ?? "evaos-code-review-bot[bot]", type: "Bot" } }];
  if (kind === "retry") {
    f.state.recordProcessed({ repo: "org/repo", pullNumber: 1, headSha: f.pull.head.sha, status: "skipped",
      error: "provider_rate_limit_cooldown_until=2020-01-01T00:00:00.000Z; reason=fixture" });
    await retryFailedHeadWithDeps({ config: f.config, state: f.state, github: f.github, budget: new ReviewRunBudget(1),
      options: { repo: "org/repo", pullNumber: 1, headSha: f.pull.head.sha, dryRun: false },
      reviewPullImpl: reviewPull, licenseAdmission: testLicenseAdmission });
  } else {
    await runScheduledCycleWithDeps({ config: f.config, state: f.state,
      github: { ...f.github, listOpenPulls: async () => [f.pull] }, options: { dryRun: false },
      reviewPullImpl: reviewPull, licenseAdmission: testLicenseAdmission });
  }
  expect(f.github.upsertIssueComment).toHaveBeenCalledWith(expect.objectContaining({
    body: expect.stringContaining("status=completed") }));
  expect(f.github.upsertIssueComment).toHaveBeenCalledWith(expect.objectContaining({
    body: expect.stringContaining("https://github.com/org/repo/pull/1#pullrequestreview-1") }));
});

it.each(["missing", "failed", "cooldown", "capacity"])("dedicated skip writer admits only retryable truth: %s", (kind) => {
  const f = fixture();
  if (kind !== "missing") f.state.recordProcessed({ repo: "org/repo", pullNumber: 1, headSha: f.h1,
    status: kind === "failed" ? "failed" : "skipped", error: kind === "cooldown"
      ? "provider_rate_limit_cooldown_until=2020-01-01T00:00:00.000Z; reason=fixture" : "repo_queue_capacity_full" });
  expect(f.state.recordBaseMergeOnlySkip({ repo: "org/repo", pullNumber: 1, headSha: f.h1, carriedFromHead: "anchor" })).toBe(true);
  expect(f.state.getProcessedReview("org/repo", 1, f.h1)).toMatchObject({ status: "skipped", error: "base_merge_only", carriedFromHead: "anchor" });
  expect(f.state.recordBaseMergeOnlySkip({ repo: "org/repo", pullNumber: 1, headSha: f.h1, carriedFromHead: "other" })).toBe(false);
});
it.each(["multiline", "blank_line_tail", "extra_token", "invalid_second_sha", "oversized"])("rejects %s patch-id output", async (kind) => {
  const f = fixture(), hex = "a".repeat(40);
  mocks.patchOutput = kind === "multiline" ? `${hex} ${hex}\n${hex} ${hex}\n`
    : kind === "blank_line_tail" ? `${hex} ${hex}\n\n`
    : kind === "extra_token" ? `${hex} ${hex} extra\n`
    : kind === "invalid_second_sha" ? `${hex} invalid\n` : "a".repeat(257);
  expect(await computeOwnDiffFingerprint(f.root, f.base, f.h1)).toHaveProperty("error");
});
it("manual dry-run can supersede a base-merge skip without posting", async () => {
  const f = fixture(); await f.anchor(); f.mergeBase();
  expect(await f.run()).toBe("skipped_base_merge_only");
  f.config.commands.enabled = true; f.config.commands.trustedAuthors = ["owner"];
  f.github.listIssueComments = async () => [{ id: 42, body: "@neondiff re-review", user: { login: "owner", type: "User" } }];
  expect(await f.run({ dryRun: true })).toBe("reviewed_command");
  expect(f.post).not.toHaveBeenCalled();
  expect(f.state.getProcessedReview("org/repo", 1, f.pull.head.sha)?.status).toBe("dry_run");
});
