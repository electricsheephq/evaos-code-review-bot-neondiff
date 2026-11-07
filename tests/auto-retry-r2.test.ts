import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfigFromObject } from "../src/config.js";
import { GitHubApi, GitHubApiRequestError, GitHubApiTimeoutError } from "../src/github.js";
import { buildOperatorDashboard, collectOperatorReviewQueue } from "../src/operator-cli.js";
import { buildReviewHeadGate } from "../src/review-head-gate.js";
import type { CoverageAuditReport } from "../src/coverage-audit.js";
import { ReviewRunBudget } from "../src/review-budget.js";
import { collectReleaseStatus } from "../src/release-status.js";
import { runScheduledCycleWithDeps } from "../src/scheduler.js";
import { ReviewStateStore } from "../src/state.js";
import type { PullRequestSummary } from "../src/types.js";
import { classifyAutoRetry, retryFailedHeadWithDeps, reviewPull } from "../src/worker.js";
import { testLicenseAdmission } from "./helpers/license-admission.js";

vi.mock("../src/git.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/git.js")>();
  return {
    ...actual,
    preparePullWorktree: vi.fn((input: { workRoot: string; expectedHeadSha: string }) => {
      const path = join(input.workRoot, "mock-worktree");
      mkdirSync(path, { recursive: true });
      return { path, headSha: input.expectedHeadSha };
    }),
    computeOwnDiffFingerprint: vi.fn(async () => ({ error: "fixture has no git checkout" })),
    assertGitClean: vi.fn()
  };
});

describe("automatic retry round two", () => {
  const roots: string[] = [];
  const stores: ReviewStateStore[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    for (const state of stores.splice(0)) state.close();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function fixture() {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-07T00:00:00.000Z"));
    const root = mkdtempSync(join(tmpdir(), "neondiff-auto-retry-r2-")); roots.push(root);
    const repo = "org/repo";
    const key = { repo, pullNumber: 1, headSha: "0".repeat(40) };
    const config = loadConfigFromObject({
      pilotRepos: [repo], workRoot: join(root, "work"), statePath: join(root, "state.sqlite"), evidenceDir: join(root, "evidence"),
      activation: { reviewExistingOpenPrsOnActivation: true },
      reviewAutoRetry: { enabled: true, maxRetries: 2, delaysMs: [1000, 2000] },
      reviewScheduler: { enabled: true }, reviewerSessions: { enabled: false },
      reviewStatusComment: { enabled: false }, walkthrough: { enabled: false }, enrichment: { enabled: false },
      commands: { enabled: false }, repoWiki: { enabled: false }, gitnexus: { enabled: false }
    });
    const state = new ReviewStateStore(config.statePath); stores.push(state);
    const pull: PullRequestSummary = { number: 1, title: "Fixture", draft: false, state: "open",
      head: { sha: key.headSha, ref: "feature", repo: { full_name: repo } },
      base: { sha: "base-a", ref: "main", repo: { full_name: repo, private: false, visibility: "public" } },
      html_url: "https://github.com/org/repo/pull/1" };
    const github = {
      getPull: vi.fn(async () => pull), listOpenPulls: async () => pull.state === "open" ? [pull] : [],
      listIssueComments: async () => [], listPullReviewComments: async () => [],
      listPullFiles: vi.fn(async () => []), canPost: () => true,
      postingIdentity: async () => ({ login: "neondiff[bot]", type: "Bot" })
    } as unknown as GitHubApi;
    const post = vi.spyOn(GitHubApi.prototype, "createReview").mockResolvedValue({ id: 1, html_url: "https://github.com/org/repo/pull/1#pullrequestreview-1" });
    const cycle = (reviewPullImpl = reviewPull) => runScheduledCycleWithDeps({ config, state, github, options: { dryRun: false, useZCode: false },
      reviewPullImpl, licenseAdmission: testLicenseAdmission, now: new Date(), clock: () => new Date() });
    const grant = () => {
      state.recordProcessed({ ...key, status: "failed", error: "original timeout" });
      const result = state.scheduleAutoRetry({ ...key, reason: "fixture", maxRetries: 2, delaysMs: [1000, 2000] });
      if (!result.granted) throw new Error("fixture grant refused");
      return result;
    };
    const queue = () => {
      const retry = grant(); vi.setSystemTime(new Date(retry.nextEligibleAt));
      const result = state.enqueueDueAutoRetry({ ...key, baseSha: pull.base.sha });
      if (!result?.enqueued) throw new Error("fixture enqueue refused");
      return result.job;
    };
    const manual = (dryRun = false) => retryFailedHeadWithDeps({ config, state, github, budget: new ReviewRunBudget(1),
      options: { ...key, dryRun, useZCode: false }, reviewPullImpl: reviewPull, licenseAdmission: testLicenseAdmission });
    const cooldown = () => state.recordRepoProviderCooldown({ repo, cooldownUntil: new Date(Date.now() + 60000), reason: "fixture" });
    return { root, repo, key, config, state, pull, github, post, cycle, grant, queue, manual, cooldown };
  }

  it("R1 queued retry cannot post after CLI retry-failed has an ambiguous POST timeout", async () => {
    const f = fixture(); const job = f.queue();
    const timeout = new GitHubApiTimeoutError({ path: "/reviews", timeoutMs: 100 });
    f.post.mockRejectedValueOnce(timeout);
    expect((await f.manual()).status).toBe("failed");
    expect(timeout).toHaveProperty("reviewPostAttempted", true);
    expect(f.state.getProcessedReview(f.repo, 1, f.key.headSha)).toMatchObject({ status: "failed", error: expect.stringContaining("retry_error=") });
    expect(f.post).toHaveBeenCalledTimes(1); f.post.mockClear();
    const processed = f.state.getProcessedReview(f.repo, 1, f.key.headSha);
    await f.cycle();
    expect(f.post).not.toHaveBeenCalled();
    expect(f.state.getProcessedReview(f.repo, 1, f.key.headSha)).toEqual(processed);
    expect(f.state.getReviewQueueJob(job.jobId)).toMatchObject({ state: "stale_retired", lastError: "auto_retry_superseded" });
  });

  it("R1 pending retry cannot post after a manual-command ambiguous POST timeout", async () => {
    const f = fixture(); const retry = f.grant();
    f.config.commands = { enabled: true, botMentions: ["@neondiff"], trustedAuthors: ["maintainer"], acknowledge: false };
    vi.spyOn(f.github, "listIssueComments").mockResolvedValue([{ id: 99, body: "@neondiff review", user: { login: "maintainer", type: "User" } }]);
    f.post.mockRejectedValueOnce(new GitHubApiTimeoutError({ path: "/reviews", timeoutMs: 100 }));
    expect((await f.cycle()).failed).toBe(1);
    expect(f.post).toHaveBeenCalledTimes(1);
    expect(f.state.listReviewQueueJobs()[0]?.source).toBe("manual_command");
    expect(f.state.getAutoRetry(f.repo, 1, f.key.headSha)?.nextEligibleAt).toBe(retry.nextEligibleAt);
    f.config.commands.enabled = false; f.post.mockClear();
    vi.setSystemTime(new Date(retry.nextEligibleAt));
    await f.cycle();
    expect(f.post).not.toHaveBeenCalled();
    expect(f.state.listReviewQueueJobs().find((job) => job.attemptId.includes(":auto-retry="))).toMatchObject({ state: "stale_retired", lastError: "auto_retry_superseded" });
  });

  it("R1 cooldown leaves a successfully manually posted row unchanged", async () => {
    const f = fixture(); const job = f.queue();
    expect((await f.manual()).status).toBe("reviewed");
    expect(f.state.getReviewQueueJob(job.jobId)?.state).toBe("queued");
    const processed = f.state.getProcessedReview(f.repo, 1, f.key.headSha);
    expect(processed?.status).toBe("posted"); f.cooldown();
    await f.cycle();
    expect(f.state.getProcessedReview(f.repo, 1, f.key.headSha)).toEqual(processed);
    expect(f.post).toHaveBeenCalledTimes(1);
  });

  it("R1 cooldown leaves an operator-retired row unchanged", async () => {
    const f = fixture(); const job = f.queue();
    f.state.retireFailedReview({ ...f.key, reason: "closed_or_stale" });
    const processed = f.state.getProcessedReview(f.repo, 1, f.key.headSha); f.cooldown();
    await f.cycle();
    expect(f.state.getProcessedReview(f.repo, 1, f.key.headSha)).toEqual(processed);
    expect(f.state.getReviewQueueJob(job.jobId)?.state).toBe("stale_retired");
    expect(f.post).not.toHaveBeenCalled();
  });

  it("R1 cooldown defers the same retry without rewriting its pin and then posts exactly once", async () => {
    const f = fixture(); const job = f.queue(); f.cooldown();
    const processed = f.state.getProcessedReview(f.repo, 1, f.key.headSha);
    await f.cycle();
    expect(f.state.getProcessedReview(f.repo, 1, f.key.headSha)).toEqual(processed);
    const deferred = f.state.getReviewQueueJob(job.jobId)!;
    expect(deferred).toMatchObject({ state: "provider_deferred", attemptId: job.attemptId });
    expect(f.post).not.toHaveBeenCalled();
    vi.setSystemTime(new Date(deferred.nextEligibleAt!));
    await f.cycle(); await f.cycle();
    expect(f.state.getReviewQueueJob(job.jobId)).toMatchObject({ state: "posted", attemptId: job.attemptId });
    expect(f.post).toHaveBeenCalledTimes(1);
    expect(f.state.getAutoRetry(f.repo, 1, f.key.headSha)?.attempts).toBe(1);
  });

  it.each(["rewritten timestamp", "different attempt", "missing getter"])("R1 rejects a grant with %s before any gate", async (mode) => {
    const f = fixture(); const job = f.queue();
    if (mode === "rewritten timestamp") {
      vi.setSystemTime(new Date(Date.now() + 1));
      f.state.recordProcessed({ ...f.key, status: "failed", error: "original timeout" });
    }
    if (mode === "missing getter") Object.defineProperty(f.state, "getAutoRetry", { value: undefined });
    const processed = f.state.getProcessedReview(f.repo, 1, f.key.headSha);
    const result = await reviewPull({ config: f.config, github: f.github, state: f.state, repo: f.repo, pull: f.pull,
      dryRun: false, useZCode: false, autoRetryJob: true,
      autoRetryAttempt: mode === "different attempt" ? 2 : Number(job.attemptId.split(":auto-retry=")[1]),
      processedHeadPolicy: "retry_failed_head", licenseAdmission: testLicenseAdmission });
    expect(result).toBe("skipped_processed");
    expect(f.state.getProcessedReview(f.repo, 1, f.key.headSha)).toEqual(processed);
    expect(f.github.listPullFiles).not.toHaveBeenCalled(); expect(f.post).not.toHaveBeenCalled();
  });

  it.each([true, false])("R2 refetch retryability %s controls the next grant", async (retryable) => {
    const f = fixture(); const job = f.queue();
    vi.spyOn(f.github, "getPull").mockRejectedValueOnce(retryable
      ? new GitHubApiTimeoutError({ path: "/pulls/1", timeoutMs: 100 })
      : new GitHubApiRequestError({ path: "/pulls/1", status: 404, statusText: "Not Found", responseText: "" }));
    await f.cycle();
    expect(f.state.getReviewQueueJob(job.jobId)?.state).toBe("failed");
    expect(f.state.getAutoRetry(f.repo, 1, f.key.headSha)).toMatchObject({ attempts: retryable ? 2 : 1,
      nextEligibleAt: retryable ? expect.any(String) : null });
    expect(f.post).not.toHaveBeenCalled();
    if (retryable) {
      vi.setSystemTime(new Date(f.state.getAutoRetry(f.repo, 1, f.key.headSha)!.nextEligibleAt!));
      await f.cycle(); expect(f.post).toHaveBeenCalledTimes(1);
    }
  });

  it("R2 base change rearms the same attempt with a new base-bound job id", async () => {
    const f = fixture(); const job = f.queue(); f.pull.base.sha = "base-b";
    await f.cycle();
    expect(f.state.getReviewQueueJob(job.jobId)).toMatchObject({ state: "stale_retired", lastError: "base_changed_before_review live=base-b" });
    expect(f.state.getAutoRetry(f.repo, 1, f.key.headSha)).toMatchObject({ attempts: 1, nextEligibleAt: new Date().toISOString() });
    await f.cycle(); await f.cycle();
    const jobs = f.state.listReviewQueueJobs(); expect(jobs).toHaveLength(2);
    expect(jobs[1]).toMatchObject({ state: "posted", baseSha: "base-b" });
    expect(jobs[1]!.attemptId).not.toBe(job.attemptId);
    expect(jobs[1]!.attemptId).toContain(":auto-retry=1");
    expect(f.state.getAutoRetry(f.repo, 1, f.key.headSha)?.attempts).toBe(1);
    expect(f.post).toHaveBeenCalledTimes(1);
  });

  it("R3 dry-run retry-failed preserves the pending grant", async () => {
    const f = fixture(); f.grant();
    const retry = f.state.getAutoRetry(f.repo, 1, f.key.headSha);
    await f.manual(true);
    expect(f.state.getAutoRetry(f.repo, 1, f.key.headSha)).toEqual(retry);
    expect(f.post).not.toHaveBeenCalled();
  });

  it.each(["superseded", "closed"])("R4 pendingAutoRetries excludes %s heads", async (reason) => {
    const f = fixture(); f.grant();
    const count = () => collectReleaseStatus({ cwd: f.root, statePath: f.config.statePath,
      configPath: join(f.root, "absent.json"), launchdLabel: "test.neondiff.auto-retry" }).database.pendingAutoRetries;
    expect(count()).toBe(1);
    if (reason === "closed") f.pull.state = "closed"; else f.pull.head.sha = "b".repeat(40);
    await runScheduledCycleWithDeps({ config: f.config, state: f.state, github: f.github,
      options: { dryRun: false, useZCode: false, pullNumber: 1 }, reviewPullImpl: reviewPull,
      licenseAdmission: testLicenseAdmission, now: new Date(), clock: () => new Date() });
    expect(count()).toBe(0);
    expect(f.state.getAutoRetry(f.repo, 1, f.key.headSha)).toMatchObject({ nextEligibleAt: null, lastReason: reason });
  });

  it("R5 a provider-classified timeout cause stays provider-owned", () => {
    const cause = new GitHubApiTimeoutError({ path: "/rate_limit", timeoutMs: 100 });
    cause.message = "rate limit reached";
    expect(classifyAutoRetry(new Error("wrapper", { cause }))).toEqual({ retryable: false, reason: "provider_classified" });
  });

  it("R6 refetch failure cannot regrant after a CLI ambiguous POST timeout", async () => {
    const f = fixture(); f.queue();
    f.post.mockRejectedValueOnce(new GitHubApiTimeoutError({ path: "/reviews", timeoutMs: 100 }));
    expect((await f.manual()).status).toBe("failed");
    const processed = f.state.getProcessedReview(f.repo, 1, f.key.headSha);
    const retry = f.state.getAutoRetry(f.repo, 1, f.key.headSha);
    vi.spyOn(f.github, "getPull").mockRejectedValueOnce(new GitHubApiTimeoutError({ path: "/pulls/1", timeoutMs: 100 }));
    await f.cycle();
    expect(f.state.getAutoRetry(f.repo, 1, f.key.headSha)).toEqual(retry);
    expect(f.state.getProcessedReview(f.repo, 1, f.key.headSha)).toEqual(processed);
    vi.setSystemTime(new Date(Date.now() + 3600000)); await f.cycle();
    expect(f.post).toHaveBeenCalledTimes(1);
  });

  it("R7 a provider rate limit keeps the pin and resumes the same attempt exactly once", async () => {
    const f = fixture(); const job = f.queue();
    const processed = f.state.getProcessedReview(f.repo, 1, f.key.headSha);
    const retry = f.state.getAutoRetry(f.repo, 1, f.key.headSha);
    vi.spyOn(f.github, "listPullFiles").mockRejectedValueOnce(new Error("rate limit reached"));
    await f.cycle();
    expect(f.state.getProcessedReview(f.repo, 1, f.key.headSha)).toEqual(processed);
    expect(f.state.getAutoRetry(f.repo, 1, f.key.headSha)).toEqual(retry);
    const deferred = f.state.getReviewQueueJob(job.jobId)!;
    expect(deferred).toMatchObject({ state: "provider_deferred", attemptId: job.attemptId, nextEligibleAt: expect.any(String) });
    expect(f.state.getActiveRepoProviderCooldown(f.repo)).toBeDefined();
    expect(f.post).not.toHaveBeenCalled();
    vi.setSystemTime(new Date(deferred.nextEligibleAt!));
    await f.cycle(); await f.cycle();
    expect(f.state.getReviewQueueJob(job.jobId)).toMatchObject({ state: "posted", attemptId: job.attemptId });
    expect(f.post).toHaveBeenCalledTimes(1);
  });

  it.each(["retire", "CLI F2"])("R8 thrown failure preserves a concurrent %s and cannot regrant", async (actor) => {
    const f = fixture(); const job = f.queue();
    let processed: ReturnType<ReviewStateStore["getProcessedReview"]>;
    let readiness: ReturnType<ReviewStateStore["getReviewReadiness"]>;
    vi.spyOn(f.github, "listPullFiles").mockImplementationOnce(async () => {
      if (actor === "retire") f.state.retireFailedReview({ ...f.key, reason: "closed_or_stale" });
      else f.state.recordProcessed({ ...f.key, status: "failed", error: "original timeout; retry_error=ambiguous POST timeout" });
      processed = f.state.getProcessedReview(f.repo, 1, f.key.headSha);
      readiness = f.state.getReviewReadiness(f.repo, 1, f.key.headSha);
      throw new Error("codex_runtime_nonzero_exit: fixture");
    });
    const retry = f.state.getAutoRetry(f.repo, 1, f.key.headSha);
    await f.cycle();
    expect(f.state.getProcessedReview(f.repo, 1, f.key.headSha)).toEqual(processed!);
    expect(f.state.getReviewReadiness(f.repo, 1, f.key.headSha)).toEqual(readiness!);
    expect(f.state.getAutoRetry(f.repo, 1, f.key.headSha)).toEqual(retry);
    expect(f.state.getReviewQueueJob(job.jobId)).toMatchObject({ state: "stale_retired", lastError: "auto_retry_superseded: codex_runtime_nonzero_exit: fixture" });
    vi.setSystemTime(new Date(Date.now() + 3600000)); await f.cycle();
    expect(f.post).not.toHaveBeenCalled();
  });

  it("R9 a CLI F2 between the start pin check and the retry read cannot post", async () => {
    const f = fixture(); const job = f.queue();
    const getProcessed = f.state.getProcessedReview.bind(f.state);
    // The start guard reads F1; an actor rewrites it immediately afterwards.
    await f.cycle(async (input) => {
      vi.spyOn(f.state, "getAutoRetry").mockImplementationOnce((...args) => {
        const retry = ReviewStateStore.prototype.getAutoRetry.apply(f.state, args);
        f.state.recordProcessed({ ...f.key, status: "failed", error: "CLI F2; retry_error=ambiguous POST timeout" });
        return retry;
      });
      return reviewPull(input);
    });
    expect(getProcessed(f.repo, 1, f.key.headSha)?.error).toBe("CLI F2; retry_error=ambiguous POST timeout");
    expect(f.state.getReviewQueueJob(job.jobId)?.state).toBe("stale_retired");
    expect(f.post).not.toHaveBeenCalled();
  });

  it("R9 the head claim pins the grant even if F2 arrives after the retry read", async () => {
    const f = fixture(); const job = f.queue();
    vi.spyOn(f.github, "listPullFiles").mockImplementationOnce(async () => {
      f.state.recordProcessed({ ...f.key, status: "failed", error: "CLI F2; retry_error=ambiguous POST timeout" });
      return [];
    });
    const claim = vi.spyOn(f.state, "tryClaimReviewHeadWithOutcome");
    await f.cycle();
    expect(claim).toHaveBeenCalledWith(expect.objectContaining({ requiredProcessedErrorForSupersession: "original timeout" }));
    expect(f.state.getReviewQueueJob(job.jobId)?.state).toBe("stale_retired");
    expect(f.post).not.toHaveBeenCalled();
  });

  it("R10 a base flip back runs a suffixed attempt id once", async () => {
    const f = fixture(); const job = f.queue(); f.pull.base.sha = "base-b";
    await f.cycle();
    const queued = f.state.enqueueDueAutoRetry({ ...f.key, baseSha: "base-b" });
    expect(queued?.enqueued).toBe(true);
    f.pull.base.sha = "base-a"; await f.cycle();
    await f.cycle(); await f.cycle();
    const jobs = f.state.listReviewQueueJobs();
    expect(jobs).toHaveLength(3);
    expect(jobs[2]).toMatchObject({ state: "posted", attemptId: expect.stringContaining(`${job.attemptId}:after-terminal:`) });
    expect(f.state.getAutoRetry(f.repo, 1, f.key.headSha)?.attempts).toBe(1);
    expect(f.post).toHaveBeenCalledTimes(1);
  });

  it.each(["retire", "rewritten timestamp"])("R11 a base change cannot rearm after %s", async (actor) => {
    const f = fixture(); f.queue();
    if (actor === "retire") f.state.retireFailedReview({ ...f.key, reason: "closed_or_stale" });
    else {
      vi.setSystemTime(new Date(Date.now() + 1));
      f.state.recordProcessed({ ...f.key, status: "failed", error: "original timeout" });
    }
    const retry = f.state.getAutoRetry(f.repo, 1, f.key.headSha);
    f.pull.base.sha = "base-b"; await f.cycle();
    expect(f.state.getAutoRetry(f.repo, 1, f.key.headSha)).toEqual(retry);
    expect(f.post).not.toHaveBeenCalled();
  });

  it("R12 a complete daemon poll cancels a closed PR's pending retry", async () => {
    const f = fixture(); f.grant(); f.pull.state = "closed";
    await f.cycle();
    expect(f.state.getAutoRetry(f.repo, 1, f.key.headSha)).toMatchObject({ nextEligibleAt: null, lastReason: "closed" });
  });

  it("R12 a failed poll leaves pending retries unchanged", async () => {
    const f = fixture(); f.grant();
    const retry = f.state.getAutoRetry(f.repo, 1, f.key.headSha);
    vi.spyOn(f.github, "listOpenPulls").mockRejectedValueOnce(new Error("fixture discovery failure"));
    await f.cycle();
    expect(f.state.getAutoRetry(f.repo, 1, f.key.headSha)).toEqual(retry);
  });

  it.each([false, true])("R13 superseded POST timeout invalidates the newer grant (concurrent retire=%s)", async (retire) => {
    const f = fixture(); f.queue();
    const before = f.state.getProcessedReview(f.repo, 1, f.key.headSha)!;
    let retired: typeof before | undefined;
    let due!: string;
    const timeout = new GitHubApiTimeoutError({ path: "/repos/org/repo/pulls/1/reviews", timeoutMs: 100 });
    f.post.mockImplementationOnce(async () => {
      // Copy A regrants attempt 2 while copy B is already inside its POST.
      const grant = f.state.scheduleAutoRetry({ ...f.key, reason: "fixture", maxRetries: 2,
        delaysMs: [1000, 2000], expected: { attempt: 1 } });
      expect(grant.granted).toBe(true);
      if (grant.granted) due = grant.nextEligibleAt;
      vi.setSystemTime(new Date(Date.now() + 1));
      if (retire) {
        f.state.retireFailedReview({ ...f.key, reason: "closed_or_stale" });
        retired = f.state.getProcessedReview(f.repo, 1, f.key.headSha);
      }
      throw timeout; // reviewPull attaches reviewPostAttempted without changing the message.
    });
    await f.cycle();
    expect(timeout).toHaveProperty("reviewPostAttempted", true);
    expect(classifyAutoRetry(timeout)).toEqual({ retryable: false, reason: "review_post_attempted" });
    vi.setSystemTime(new Date(due)); await f.cycle(); await f.cycle();
    expect(f.post).toHaveBeenCalledTimes(1);
    expect(f.state.getAutoRetry(f.repo, 1, f.key.headSha)).toMatchObject({ attempts: 2,
      pinnedProcessedAt: null, nextEligibleAt: null, lastReason: "superseded_after_post_attempt" });
    const processed = f.state.getProcessedReview(f.repo, 1, f.key.headSha)!;
    if (retire) expect(processed).toEqual(retired);
    else {
      expect(processed).toMatchObject({ status: "failed", error: timeout.message });
      expect(processed.createdAt).not.toBe(before.createdAt);
    }
    const invalidated = f.state.getAutoRetry(f.repo, 1, f.key.headSha);
    f.state.rearmAutoRetry(f.key);
    expect(f.state.scheduleAutoRetry({ ...f.key, reason: "fixture", maxRetries: 5, delaysMs: [1000, 2000, 3000],
      expected: { attempt: 2 } })).toEqual({ granted: false });
    expect(f.state.getAutoRetry(f.repo, 1, f.key.headSha)).toEqual(invalidated);
  });

  it("R14 a superseded retry finishes its running reviewer-session job", async () => {
    const f = fixture(); f.config.reviewerSessions.enabled = true; const job = f.queue();
    const assignment = f.state.assignReviewerSessionJob({ ...f.key, allowProcessed: true,
      ttlMs: f.config.reviewerSessions.ttlMs, headCountLimit: f.config.reviewerSessions.headCountLimit });
    f.state.updateReviewQueueJobState({ jobId: job.jobId, state: "queued", sessionId: assignment.session!.sessionId });
    await f.cycle(async () => {
      expect(f.state.getReviewerSessionJob(f.repo, 1, f.key.headSha)?.jobState).toBe("running");
      f.state.retireFailedReview({ ...f.key, reason: "closed_or_stale" });
      throw new Error("codex_runtime_nonzero_exit: fixture");
    });
    expect(f.state.getReviewQueueJob(job.jobId)?.state).toBe("stale_retired");
    expect(f.state.getReviewerSessionJob(f.repo, 1, f.key.headSha)).toMatchObject({ jobState: "skipped",
      processedReviewStatus: "skipped", finishedAt: expect.any(String) });
  });

  it("R15 a superseded rate limit records the repo cooldown without changing the processed row", async () => {
    const f = fixture(); const job = f.queue();
    let retired: ReturnType<ReviewStateStore["getProcessedReview"]>;
    vi.spyOn(f.github, "listPullFiles").mockImplementationOnce(async () => {
      f.state.retireFailedReview({ ...f.key, reason: "closed_or_stale" });
      retired = f.state.getProcessedReview(f.repo, 1, f.key.headSha);
      throw new Error("rate limit reached");
    });
    const retry = f.state.getAutoRetry(f.repo, 1, f.key.headSha);
    await f.cycle();
    expect(f.state.getActiveRepoProviderCooldown(f.repo)).toBeDefined();
    expect(f.state.getProcessedReview(f.repo, 1, f.key.headSha)).toEqual(retired!);
    expect(f.state.getAutoRetry(f.repo, 1, f.key.headSha)).toEqual(retry);
    expect(f.state.getReviewQueueJob(job.jobId)?.state).toBe("stale_retired");
    expect(f.post).not.toHaveBeenCalled();
  });

  it.each(["manual-command post", "rewritten error", "rewritten timestamp"])("R16 reporting excludes a non-live grant after %s", async (actor) => {
    const f = fixture(); const grant = f.grant();
    const releaseCount = () => collectReleaseStatus({ cwd: f.root, statePath: f.config.statePath,
      configPath: join(f.root, "absent.json"), launchdLabel: "test.neondiff.auto-retry" }).database.pendingAutoRetries;
    expect(releaseCount()).toBe(1);
    expect(collectOperatorReviewQueue(f.config.statePath).pendingAutoRetries).toHaveLength(1);
    expect(buildReviewHeadGate({ state: f.state, ...f.key }).gates[0]?.detail).toContain("automatic retry scheduled");
    if (actor === "manual-command post") {
      f.config.commands = { enabled: true, botMentions: ["@neondiff"], trustedAuthors: ["maintainer"], acknowledge: false };
      vi.spyOn(f.github, "listIssueComments").mockResolvedValue([{ id: 99, body: "@neondiff review", user: { login: "maintainer", type: "User" } }]);
      await f.cycle();
      expect(f.post).toHaveBeenCalledTimes(1);
      expect(f.state.getProcessedReview(f.repo, 1, f.key.headSha)?.status).toBe("posted");
    } else {
      if (actor === "rewritten timestamp") vi.setSystemTime(new Date(Date.now() + 1));
      f.state.recordProcessed({ ...f.key, status: "failed", error: actor === "rewritten error" ? "F2" : "original timeout" });
      const job = f.state.enqueueReviewQueueJob({ ...f.key, baseSha: f.pull.base.sha }).job;
      f.state.updateReviewQueueJobState({ jobId: job.jobId, state: "failed" });
      f.state.recordReviewReadiness({ ...f.key, state: "failed", reason: "review_failed: fixture" });
    }
    // Reporting must filter the void grant, rather than cancelling its durable history.
    expect(f.state.getAutoRetry(f.repo, 1, f.key.headSha)?.nextEligibleAt).toBe(grant.nextEligibleAt);
    expect.soft(releaseCount()).toBe(0);
    const queue = collectOperatorReviewQueue(f.config.statePath);
    expect.soft(queue.pendingAutoRetries).toEqual([]);
    expect.soft(buildReviewHeadGate({ state: f.state, ...f.key }).gates[0]?.detail).not.toContain("automatic retry scheduled");
    const coverage = { checkedAt: new Date().toISOString(), processed: [], unprocessed: [], providerDeferred: [],
      staleHeads: [], readFailures: [], queued: [], skipped: [], summary: {} } as unknown as CoverageAuditReport;
    for (const readiness of [undefined, [f.state.getReviewReadiness(f.repo, 1, f.key.headSha)!].filter(Boolean)]) {
      const dashboard = buildOperatorDashboard({ coverage, durableQueue: queue, readiness });
      expect.soft(dashboard.items.some((item) => item.nextAction.includes("automatic retry scheduled"))).toBe(false);
    }
  });

  it("R17 a listing of 100 PRs leaves an omitted PR's retry pending", async () => {
    const f = fixture(); f.grant();
    const retry = f.state.getAutoRetry(f.repo, 1, f.key.headSha);
    vi.spyOn(f.github, "listOpenPulls").mockResolvedValue(Array.from({ length: 100 }, (_, i) => ({
      ...f.pull, number: i + 2, draft: true
    })));
    await f.cycle();
    expect(f.state.getAutoRetry(f.repo, 1, f.key.headSha)).toEqual(retry);
    expect(f.post).not.toHaveBeenCalled();
  });

});
