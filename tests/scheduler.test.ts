import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BotConfig } from "../src/config.js";
import { runScheduledCycleWithDeps, type SchedulerGitHubApi } from "../src/scheduler.js";
import { ReviewStateStore } from "../src/state.js";
import type { PullRequestSummary } from "../src/types.js";
import type { ReviewPullInput, ReviewPullResult } from "../src/worker.js";

describe("provider-aware review scheduler", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("queues a multi-repo burst and leases up to provider capacity with per-repo caps", async () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-scheduler-burst-"));
    roots.push(root);
    const config = schedulerConfig(root, ["org/repo-a", "org/repo-b", "org/repo-c", "org/repo-d"]);
    const state = new ReviewStateStore(config.statePath);
    const pullsByRepo = new Map([
      ["org/repo-a", [pull("org/repo-a", 1, "a1"), pull("org/repo-a", 2, "a2"), pull("org/repo-a", 3, "a3")]],
      ["org/repo-b", [pull("org/repo-b", 1, "b1"), pull("org/repo-b", 2, "b2"), pull("org/repo-b", 3, "b3")]],
      ["org/repo-c", [pull("org/repo-c", 1, "c1"), pull("org/repo-c", 2, "c2")]],
      ["org/repo-d", [pull("org/repo-d", 1, "d1"), pull("org/repo-d", 2, "d2")]]
    ]);
    const reviewed: string[] = [];

    const result = await runScheduledCycleWithDeps({
      config,
      github: githubFromMap(pullsByRepo),
      state,
      options: { dryRun: true, useZCode: false },
      reviewPullImpl: async ({ state: reviewState, repo, pull: reviewPull }) => {
        reviewed.push(`${repo}#${reviewPull.number}`);
        reviewState.recordProcessed({
          repo,
          pullNumber: reviewPull.number,
          headSha: reviewPull.head.sha,
          status: "dry_run",
          event: "COMMENT"
        });
        return "reviewed";
      },
      now: new Date("2026-07-01T00:00:00.000Z")
    });

    expect(result.queue).toMatchObject({
      enqueued: 10,
      leased: 2,
      completed: 2,
      remainingQueued: 10
    });
    expect(reviewed).toHaveLength(2);
    expect(new Set(reviewed.map((entry) => entry.split("#")[0]))).toHaveLength(2);
    expect(state.listReviewQueueJobs({ state: "posted" })).toHaveLength(0);
    expect(state.listReviewQueueJobs({ state: "queued" })).toHaveLength(10);
    expect(state.listReviewQueueJobs({ state: "queued" })
      .filter((job) => job.lastError === "dry_run_completed_not_posted")).toHaveLength(2);
    state.close();
  });

  it("records provider throttle on one repo without blocking an unrelated leased repo", async () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-scheduler-provider-throttle-"));
    roots.push(root);
    const config = schedulerConfig(root, ["org/repo-a", "org/repo-b", "org/repo-c"]);
    const state = new ReviewStateStore(config.statePath);
    const pullsByRepo = new Map([
      ["org/repo-a", [pull("org/repo-a", 1, "a1")]],
      ["org/repo-b", [pull("org/repo-b", 1, "b1")]],
      ["org/repo-c", [pull("org/repo-c", 1, "c1")]]
    ]);

    const result = await runScheduledCycleWithDeps({
      config,
      github: githubFromMap(pullsByRepo),
      state,
      options: { dryRun: false, useZCode: true },
      reviewPullImpl: async ({ state: reviewState, repo, pull: reviewPull }) => {
        if (repo === "org/repo-a") {
          throw new Error("ProviderBusinessError: [1302][Rate limit reached for requests]");
        }
        reviewState.recordProcessed({
          repo,
          pullNumber: reviewPull.number,
          headSha: reviewPull.head.sha,
          status: "posted",
          event: "COMMENT",
          reviewUrl: `https://github.com/${repo}/pull/${reviewPull.number}#pullrequestreview-1`
        });
        return "reviewed";
      },
      now: new Date("2026-07-01T00:00:00.000Z")
    });

    expect(result.reviewed).toBe(1);
    expect(result.skippedProviderCooldown).toBe(1);
    expect(state.getActiveRepoProviderCooldown("org/repo-a", new Date("2026-07-01T00:00:01.000Z"))).toBeDefined();
    expect(state.getActiveRepoProviderCooldown("org/repo-b", new Date("2026-07-01T00:00:01.000Z"))).toBeUndefined();
    expect(state.listReviewQueueJobs({ state: "provider_deferred" })).toEqual([
      expect.objectContaining({ repo: "org/repo-a", pullNumber: 1, nextEligibleAt: "2026-07-01T00:01:30.000Z" })
    ]);
    expect(state.listReviewQueueJobs({ state: "posted" })).toEqual([
      expect.objectContaining({ repo: "org/repo-b", pullNumber: 1 })
    ]);
    state.close();
  });

  it("retries expired provider-deferred queue jobs with failed-head retry policy", async () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-scheduler-provider-deferred-retry-"));
    roots.push(root);
    const config = schedulerConfig(root, ["org/repo-a"]);
    const state = new ReviewStateStore(config.statePath);
    state.recordProcessed({
      repo: "org/repo-a",
      pullNumber: 1,
      headSha: "a1",
      status: "skipped",
      error: "provider_rate_limit_cooldown_until=2026-07-01T00:01:00.000Z; reason=provider_request_rate_limit"
    });
    const job = state.enqueueReviewQueueJob({
      repo: "org/repo-a",
      pullNumber: 1,
      headSha: "a1",
      baseSha: "base",
      providerId: "zai",
      now: new Date("2026-07-01T00:00:00.000Z")
    }).job;
    state.updateReviewQueueJobState({
      jobId: job.jobId,
      state: "provider_deferred",
      nextEligibleAt: "2026-07-01T00:01:00.000Z",
      lastError: "provider_rate_limit_cooldown_until=2026-07-01T00:01:00.000Z; reason=provider_request_rate_limit",
      now: new Date("2026-07-01T00:00:01.000Z")
    });
    const policies: Array<ReviewPullInput["processedHeadPolicy"]> = [];

    const result = await runScheduledCycleWithDeps({
      config,
      github: githubFromMap(new Map([
        ["org/repo-a", [pull("org/repo-a", 1, "a1")]]
      ])),
      state,
      options: { dryRun: false, useZCode: false },
      reviewPullImpl: async ({ state: reviewState, repo, pull: reviewPull, processedHeadPolicy }) => {
        policies.push(processedHeadPolicy);
        reviewState.recordProcessed({
          repo,
          pullNumber: reviewPull.number,
          headSha: reviewPull.head.sha,
          status: "posted",
          event: "COMMENT",
          reviewUrl: `https://github.com/${repo}/pull/${reviewPull.number}#pullrequestreview-2`
        });
        return "reviewed";
      },
      now: new Date("2026-07-01T00:01:01.000Z")
    });

    expect(result.reviewed).toBe(1);
    expect(result.skippedProcessed).toBe(1);
    expect(policies).toEqual(["retry_failed_head"]);
    expect(state.getReviewQueueJob(job.jobId)).toMatchObject({
      state: "posted",
      reviewUrl: "https://github.com/org/repo-a/pull/1#pullrequestreview-2"
    });
    state.close();
  });

  it("retires stale and closed queued jobs before running review work", async () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-scheduler-retire-"));
    roots.push(root);
    const config = schedulerConfig(root, []);
    const state = new ReviewStateStore(config.statePath);
    state.enqueueReviewQueueJob({ repo: "org/repo-a", pullNumber: 1, headSha: "old-a", baseSha: "base" });
    state.enqueueReviewQueueJob({ repo: "org/repo-b", pullNumber: 2, headSha: "closed-b", baseSha: "base" });
    let attempts = 0;

    const result = await runScheduledCycleWithDeps({
      config,
      github: githubFromMap(new Map([
        ["org/repo-a", [pull("org/repo-a", 1, "new-a")]],
        ["org/repo-b", [pull("org/repo-b", 2, "closed-b", "base", { state: "closed" })]]
      ])),
      state,
      options: { dryRun: true, useZCode: false },
      reviewPullImpl: async () => {
        attempts += 1;
        return "reviewed";
      },
      now: new Date("2026-07-01T00:00:00.000Z")
    });

    expect(attempts).toBe(0);
    expect(result.queue.staleRetired).toBe(1);
    expect(result.queue.closedRetired).toBe(1);
    expect(state.listReviewQueueJobs({ state: "stale_retired" })).toEqual([
      expect.objectContaining({ repo: "org/repo-a", headSha: "old-a" })
    ]);
    expect(state.listReviewQueueJobs({ state: "closed_retired" })).toEqual([
      expect.objectContaining({ repo: "org/repo-b", headSha: "closed-b" })
    ]);
    state.close();
  });

  it("reserves provider capacity for trusted manual-command queue jobs", async () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-scheduler-manual-reserve-"));
    roots.push(root);
    const config = schedulerConfig(root, ["org/repo-a", "org/repo-b", "org/repo-c"]);
    const state = new ReviewStateStore(config.statePath);
    state.enqueueReviewQueueJob({ repo: "org/repo-a", pullNumber: 1, headSha: "a1", baseSha: "base" });
    state.enqueueReviewQueueJob({ repo: "org/repo-b", pullNumber: 1, headSha: "b1", baseSha: "base" });
    state.enqueueReviewQueueJob({
      repo: "org/repo-c",
      pullNumber: 1,
      headSha: "c1",
      baseSha: "base",
      source: "manual_command",
      lane: "manual",
      commentId: 123,
      priority: 10
    });
    const reviewed: string[] = [];

    const result = await runScheduledCycleWithDeps({
      config,
      github: githubFromMap(new Map([
        ["org/repo-a", [pull("org/repo-a", 1, "a1")]],
        ["org/repo-b", [pull("org/repo-b", 1, "b1")]],
        ["org/repo-c", [pull("org/repo-c", 1, "c1")]]
      ])),
      state,
      options: { dryRun: false, useZCode: false },
      reviewPullImpl: async ({ state: reviewState, repo, pull: reviewPull }) => {
        reviewed.push(`${repo}#${reviewPull.number}`);
        reviewState.recordProcessed({
          repo,
          pullNumber: reviewPull.number,
          headSha: reviewPull.head.sha,
          status: "dry_run",
          event: "COMMENT"
        });
        return "reviewed";
      },
      now: new Date("2026-07-01T00:00:00.000Z")
    });

    expect(result.queue.leased).toBe(2);
    expect(reviewed).toContain("org/repo-c#1");
    expect(state.listReviewQueueJobs({ state: "posted" })).toEqual(expect.arrayContaining([
      expect.objectContaining({ repo: "org/repo-c", lane: "manual", commentId: 123 })
    ]));
    state.close();
  });

  it("honors per-repo queue capacity before active provider cooldown enqueue", async () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-scheduler-cooldown-capacity-"));
    roots.push(root);
    const config = schedulerConfig(root, ["org/repo-a"]);
    config.reviewScheduler!.maxQueuedPerRepo = 1;
    const state = new ReviewStateStore(config.statePath);
    state.recordRepoProviderCooldown({
      repo: "org/repo-a",
      cooldownUntil: new Date("2026-07-01T00:05:00.000Z"),
      reason: "provider_request_rate_limit"
    });

    const result = await runScheduledCycleWithDeps({
      config,
      github: githubFromMap(new Map([
        ["org/repo-a", [pull("org/repo-a", 1, "a1"), pull("org/repo-a", 2, "a2")]]
      ])),
      state,
      options: { dryRun: true, useZCode: false },
      reviewPullImpl: async () => "reviewed",
      now: new Date("2026-07-01T00:00:00.000Z")
    });

    expect(result.skippedProviderCooldown).toBe(1);
    expect(result.skippedCapacity).toBe(1);
    expect(state.listReviewQueueJobs({ repo: "org/repo-a" })).toEqual([
      expect.objectContaining({
        pullNumber: 1,
        state: "provider_deferred",
        nextEligibleAt: "2026-07-01T00:05:00.000Z"
      })
    ]);
    state.close();
  });
});

function schedulerConfig(root: string, repos: string[]): BotConfig {
  return {
    pilotRepos: repos,
    pollIntervalMs: 60_000,
    skipDrafts: true,
    workRoot: join(root, "work"),
    statePath: join(root, "state.sqlite"),
    evidenceDir: join(root, "evidence"),
    activation: {
      reviewExistingOpenPrsOnActivation: true
    },
    reviewConcurrency: {
      maxActiveRuns: 2,
      leaseTtlMs: 60_000
    },
    reviewerSessions: {
      enabled: false,
      ttlMs: 8 * 60 * 60_000,
      headCountLimit: 10
    },
    reviewScheduler: {
      enabled: true,
      maxProviderActive: 2,
      maxOrgActive: 3,
      maxRepoActive: 1,
      maxQueuedPerRepo: 10,
      manualCommandReserve: 1,
      backgroundPriority: 50
    },
    providerCooldown: {
      enabled: true,
      durationMs: 15 * 60_000,
      requestRateLimitDurationMs: 90_000,
      overloadDurationMs: 2 * 60_000,
      quotaDurationMs: 30 * 60_000,
      transientRetryAttempts: 0,
      transientRetryBaseDelayMs: 1,
      transientRetryMaxDelayMs: 1
    },
    walkthrough: {
      enabled: false,
      postIssueComment: false
    },
    commands: {
      enabled: false,
      botMentions: ["@evaos-code-review-bot"],
      trustedAuthors: [],
      acknowledge: false
    },
    zcode: {
      cliPath: "/unused/zcode.cjs",
      appConfigPath: "/unused/config.json",
      model: "GLM-5.2",
      providerId: "zai-coding-plan",
      timeoutMs: 1,
      maxPatchBytes: 1,
      retryMaxRetries: 0
    },
    github: {}
  };
}

function githubFromMap(pullsByRepo: Map<string, PullRequestSummary[]>): SchedulerGitHubApi {
  return {
    listOpenPulls: async (repo) => pullsByRepo.get(repo)?.filter((entry) => entry.state === undefined || entry.state === "open") ?? [],
    getPull: async (repo, pullNumber) => {
      const pull = pullsByRepo.get(repo)?.find((entry) => entry.number === pullNumber);
      if (!pull) throw new Error(`missing pull ${repo}#${pullNumber}`);
      return pull;
    }
  };
}

function pull(
  repo: string,
  number: number,
  headSha: string,
  baseSha = "base",
  options: { state?: string; mergedAt?: string | null } = {}
): PullRequestSummary {
  return {
    number,
    title: `${repo} PR ${number}`,
    draft: false,
    ...(options.state ? { state: options.state } : {}),
    ...(options.mergedAt !== undefined ? { merged_at: options.mergedAt } : {}),
    head: {
      sha: headSha,
      ref: `pr-${number}`,
      repo: { full_name: repo }
    },
    base: {
      sha: baseSha,
      ref: "main",
      repo: { full_name: repo }
    },
    html_url: `https://github.com/${repo}/pull/${number}`
  };
}
