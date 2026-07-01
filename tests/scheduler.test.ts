import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BotConfig } from "../src/config.js";
import { runScheduledCycleWithDeps, type SchedulerGitHubApi } from "../src/scheduler.js";
import { ReviewStateStore } from "../src/state.js";
import type { PullRequestSummary } from "../src/types.js";
import { reviewPull, type ReviewPullInput, type ReviewPullResult } from "../src/worker.js";

const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);
const HEAD_C = "c".repeat(40);
const HEAD_D = "d".repeat(40);
const HEAD_F = "f".repeat(40);

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

  it("posts a sticky status comment from queued through completed for a live queued head", async () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-scheduler-status-completed-"));
    roots.push(root);
    const config = schedulerConfig(root, ["org/repo-a"]);
    config.reviewStatusComment!.enabled = true;
    const state = new ReviewStateStore(config.statePath);
    const statusCalls: StatusCommentCall[] = [];

    const result = await runScheduledCycleWithDeps({
      config,
      github: githubFromMap(new Map([
        ["org/repo-a", [pull("org/repo-a", 1, HEAD_A)]]
      ]), new Map(), statusCalls),
      state,
      options: { dryRun: false, useZCode: false },
      reviewPullImpl: async ({ state: reviewState, repo, pull: reviewPull }) => {
        reviewState.recordProcessed({
          repo,
          pullNumber: reviewPull.number,
          headSha: reviewPull.head.sha,
          status: "posted",
          event: "COMMENT",
          reviewUrl: "https://github.com/org/repo-a/pull/1#pullrequestreview-status"
        });
        return "reviewed";
      },
      now: new Date("2026-07-02T00:00:00.000Z")
    });

    expect(result.reviewed).toBe(1);
    expect(statusCalls.map(statusFromBody)).toEqual(["queued", "in_progress", "completed"]);
    expect(new Set(statusCalls.map((call) => call.marker))).toEqual(new Set([
      `<!-- evaos-code-review-bot:review-status repo=org/repo-a pr=1 sha=${HEAD_A} -->`
    ]));
    expect(statusCalls.at(-1)?.body).toContain("https://github.com/org/repo-a/pull/1#pullrequestreview-status");
    state.close();
  });

  it("updates sticky status to provider_deferred when a leased review hits provider cooldown", async () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-scheduler-status-provider-deferred-"));
    roots.push(root);
    const config = schedulerConfig(root, ["org/repo-a"]);
    config.reviewStatusComment!.enabled = true;
    const state = new ReviewStateStore(config.statePath);
    const statusCalls: StatusCommentCall[] = [];

    const result = await runScheduledCycleWithDeps({
      config,
      github: githubFromMap(new Map([
        ["org/repo-a", [pull("org/repo-a", 1, HEAD_A)]]
      ]), new Map(), statusCalls),
      state,
      options: { dryRun: false, useZCode: true },
      reviewPullImpl: async () => {
        throw new Error("ProviderBusinessError: [1302][Rate limit reached for requests]");
      },
      now: new Date("2026-07-02T00:00:00.000Z")
    });

    expect(result.skippedProviderCooldown).toBe(1);
    expect(statusCalls.map(statusFromBody)).toEqual(["queued", "in_progress", "provider_deferred"]);
    expect(statusCalls.at(-1)?.body).toContain("temporarily unavailable or rate-limited");
    expect(statusCalls.at(-1)?.body).not.toContain("ProviderBusinessError");
    state.close();
  });

  it("marks a queued status failed when refetching the leased pull fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-scheduler-status-refetch-failed-"));
    roots.push(root);
    const config = schedulerConfig(root, []);
    config.reviewStatusComment!.enabled = true;
    const state = new ReviewStateStore(config.statePath);
    state.enqueueReviewQueueJob({ repo: "org/repo-a", pullNumber: 1, headSha: HEAD_A, baseSha: "base" });
    const statusCalls: StatusCommentCall[] = [];

    const result = await runScheduledCycleWithDeps({
      config,
      github: {
        ...githubFromMap(new Map(), new Map(), statusCalls),
        getPull: async () => {
          throw new Error("GitHub API fetch failed for /repos/org/repo-a/pulls/1: internal host detail");
        }
      },
      state,
      options: { dryRun: false, useZCode: false },
      reviewPullImpl: async () => {
        throw new Error("should not review failed refetch");
      },
      now: new Date("2026-07-02T00:00:00.000Z")
    });

    expect(result.failed).toBe(1);
    expect(statusCalls.map(statusFromBody)).toEqual(["failed"]);
    expect(statusCalls[0]?.body).toContain("GitHub refetch failed; see bot evidence");
    expect(statusCalls[0]?.body).not.toContain("internal host detail");
    expect(state.listReviewQueueJobs({ state: "failed" })).toHaveLength(1);
    state.close();
  });

  it("updates sticky status for stale and closed queued heads before running review work", async () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-scheduler-status-retire-"));
    roots.push(root);
    const config = schedulerConfig(root, []);
    config.reviewStatusComment!.enabled = true;
    const state = new ReviewStateStore(config.statePath);
    state.enqueueReviewQueueJob({ repo: "org/repo-a", pullNumber: 1, headSha: HEAD_A, baseSha: "base" });
    state.enqueueReviewQueueJob({ repo: "org/repo-b", pullNumber: 2, headSha: HEAD_F, baseSha: "base" });
    const statusCalls: StatusCommentCall[] = [];

    const result = await runScheduledCycleWithDeps({
      config,
      github: githubFromMap(new Map([
        ["org/repo-a", [pull("org/repo-a", 1, HEAD_D)]],
        ["org/repo-b", [pull("org/repo-b", 2, HEAD_F, "base", { state: "closed" })]]
      ]), new Map(), statusCalls),
      state,
      options: { dryRun: false, useZCode: false },
      reviewPullImpl: async () => {
        throw new Error("should not review retired jobs");
      },
      now: new Date("2026-07-02T00:00:00.000Z")
    });

    expect(result.queue.staleRetired).toBe(1);
    expect(result.queue.closedRetired).toBe(1);
    expect(statusCalls.map(statusFromBody).sort()).toEqual(["closed_or_merged_before_review", "stale_head"]);
    expect(statusCalls.map((call) => call.marker).sort()).toEqual([
      `<!-- evaos-code-review-bot:review-status repo=org/repo-a pr=1 sha=${HEAD_A} -->`,
      `<!-- evaos-code-review-bot:review-status repo=org/repo-b pr=2 sha=${HEAD_F} -->`
    ]);
    state.close();
  });

  it("retires superseded queued status comments when a newer head is enqueued", async () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-scheduler-status-superseded-head-"));
    roots.push(root);
    const config = schedulerConfig(root, ["org/repo-a"]);
    config.reviewStatusComment!.enabled = true;
    const state = new ReviewStateStore(config.statePath);
    const oldJob = state.enqueueReviewQueueJob({
      repo: "org/repo-a",
      pullNumber: 1,
      headSha: HEAD_A,
      baseSha: "base"
    }).job;
    state.updateReviewQueueJobState({
      jobId: oldJob.jobId,
      state: "provider_deferred",
      nextEligibleAt: "2026-07-02T00:05:00.000Z",
      lastError: "provider cooldown",
      now: new Date("2026-07-02T00:00:00.000Z")
    });
    const statusCalls: StatusCommentCall[] = [];

    const result = await runScheduledCycleWithDeps({
      config,
      github: githubFromMap(new Map([
        ["org/repo-a", [pull("org/repo-a", 1, HEAD_D)]]
      ]), new Map(), statusCalls),
      state,
      options: { dryRun: false, useZCode: false },
      reviewPullImpl: async ({ state: reviewState, repo, pull: reviewPull }) => {
        reviewState.recordProcessed({
          repo,
          pullNumber: reviewPull.number,
          headSha: reviewPull.head.sha,
          status: "posted",
          event: "COMMENT"
        });
        return "reviewed";
      },
      now: new Date("2026-07-02T00:00:00.000Z")
    });

    expect(result.reviewed).toBe(1);
    expect(state.getReviewQueueJob(oldJob.jobId)).toMatchObject({
      state: "stale_retired",
      lastError: `superseded_by_head=${HEAD_D}`
    });
    expect(statusCalls.map(statusFromBody)).toEqual(["stale_head", "queued", "in_progress", "completed"]);
    expect(statusCalls[0]?.marker).toBe(`<!-- evaos-code-review-bot:review-status repo=org/repo-a pr=1 sha=${HEAD_A} -->`);
    expect(statusCalls.at(-1)?.marker).toBe(`<!-- evaos-code-review-bot:review-status repo=org/repo-a pr=1 sha=${HEAD_D} -->`);
    state.close();
  });

  it("retires queued status comments when a scoped pull is already closed", async () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-scheduler-status-closed-scan-"));
    roots.push(root);
    const config = schedulerConfig(root, []);
    config.reviewStatusComment!.enabled = true;
    const state = new ReviewStateStore(config.statePath);
    const oldJob = state.enqueueReviewQueueJob({
      repo: "org/repo-a",
      pullNumber: 1,
      headSha: HEAD_A,
      baseSha: "base"
    }).job;
    const statusCalls: StatusCommentCall[] = [];

    const result = await runScheduledCycleWithDeps({
      config,
      github: githubFromMap(new Map([
        ["org/repo-a", [pull("org/repo-a", 1, HEAD_A, "base", { state: "closed" })]]
      ]), new Map(), statusCalls),
      state,
      options: { repo: "org/repo-a", pullNumber: 1, dryRun: false, useZCode: false },
      reviewPullImpl: async () => {
        throw new Error("should not review closed pull");
      },
      now: new Date("2026-07-02T00:00:00.000Z")
    });

    expect(result.queue.closedRetired).toBe(1);
    expect(state.getReviewQueueJob(oldJob.jobId)).toMatchObject({ state: "closed_retired" });
    expect(statusCalls.map(statusFromBody)).toEqual(["closed_or_merged_before_review"]);
    state.close();
  });

  it("does not post sticky status comments during dry-run scheduler cycles", async () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-scheduler-status-dry-run-"));
    roots.push(root);
    const config = schedulerConfig(root, ["org/repo-a"]);
    config.reviewStatusComment!.enabled = true;
    const state = new ReviewStateStore(config.statePath);
    const statusCalls: StatusCommentCall[] = [];

    await runScheduledCycleWithDeps({
      config,
      github: githubFromMap(new Map([
        ["org/repo-a", [pull("org/repo-a", 1, HEAD_A)]]
      ]), new Map(), statusCalls),
      state,
      options: { dryRun: true, useZCode: false },
      reviewPullImpl: async ({ state: reviewState, repo, pull: reviewPull }) => {
        reviewState.recordProcessed({
          repo,
          pullNumber: reviewPull.number,
          headSha: reviewPull.head.sha,
          status: "dry_run",
          event: "COMMENT"
        });
        return "reviewed";
      },
      now: new Date("2026-07-02T00:00:00.000Z")
    });

    expect(statusCalls).toHaveLength(0);
    state.close();
  });

  it("does not throw or upsert status comments when App credentials are absent", async () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-scheduler-status-token-mode-"));
    roots.push(root);
    const config = schedulerConfig(root, ["org/repo-a"]);
    config.reviewStatusComment!.enabled = true;
    const state = new ReviewStateStore(config.statePath);
    let upsertCalls = 0;

    const result = await runScheduledCycleWithDeps({
      config,
      github: {
        ...githubFromMap(new Map([
          ["org/repo-a", [pull("org/repo-a", 1, HEAD_A)]]
        ])),
        canPostAsApp: () => false,
        upsertIssueComment: async () => {
          upsertCalls += 1;
          throw new Error("should not upsert without App credentials");
        }
      },
      state,
      options: { dryRun: false, useZCode: false },
      reviewPullImpl: async ({ state: reviewState, repo, pull: reviewPull }) => {
        reviewState.recordProcessed({
          repo,
          pullNumber: reviewPull.number,
          headSha: reviewPull.head.sha,
          status: "posted",
          event: "COMMENT"
        });
        return "reviewed";
      },
      now: new Date("2026-07-02T00:00:00.000Z")
    });

    expect(result.reviewed).toBe(1);
    expect(result.statusCommentFailures).toBe(3);
    expect(upsertCalls).toBe(0);
    state.close();
  });

  it("counts status-comment upsert failures without failing the review", async () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-scheduler-status-upsert-failure-"));
    roots.push(root);
    const config = schedulerConfig(root, ["org/repo-a"]);
    config.reviewStatusComment!.enabled = true;
    const state = new ReviewStateStore(config.statePath);

    const result = await runScheduledCycleWithDeps({
      config,
      github: {
        ...githubFromMap(new Map([
          ["org/repo-a", [pull("org/repo-a", 1, HEAD_A)]]
        ])),
        canPostAsApp: () => true,
        upsertIssueComment: async () => {
          throw new Error("GitHub API 500");
        }
      },
      state,
      options: { dryRun: false, useZCode: false },
      reviewPullImpl: async ({ state: reviewState, repo, pull: reviewPull }) => {
        reviewState.recordProcessed({
          repo,
          pullNumber: reviewPull.number,
          headSha: reviewPull.head.sha,
          status: "posted",
          event: "COMMENT"
        });
        return "reviewed";
      },
      now: new Date("2026-07-02T00:00:00.000Z")
    });

    expect(result.reviewed).toBe(1);
    expect(result.statusCommentFailures).toBe(3);
    state.close();
  });

  it("sets terminal failed status when a queued job becomes policy-skipped after in-progress", async () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-scheduler-status-policy-skip-"));
    roots.push(root);
    const config = schedulerConfig(root, ["org/repo-a"]);
    config.reviewStatusComment!.enabled = true;
    const state = new ReviewStateStore(config.statePath);
    const statusCalls: StatusCommentCall[] = [];

    const result = await runScheduledCycleWithDeps({
      config,
      github: githubFromMap(new Map([
        ["org/repo-a", [pull("org/repo-a", 1, HEAD_A)]]
      ]), new Map(), statusCalls),
      state,
      options: { dryRun: false, useZCode: false },
      reviewPullImpl: async () => "skipped_policy",
      now: new Date("2026-07-02T00:00:00.000Z")
    });

    expect(result.skippedPolicy).toBe(1);
    expect(statusCalls.map(statusFromBody)).toEqual(["queued", "in_progress", "failed"]);
    expect(state.listReviewQueueJobs({ state: "failed" })).toHaveLength(1);
    state.close();
  });

  it("retires superseded queue jobs even when status comments are disabled", async () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-scheduler-disabled-status-superseded-"));
    roots.push(root);
    const config = schedulerConfig(root, ["org/repo-a"]);
    config.reviewStatusComment!.enabled = false;
    const state = new ReviewStateStore(config.statePath);
    const oldJob = state.enqueueReviewQueueJob({
      repo: "org/repo-a",
      pullNumber: 1,
      headSha: HEAD_A,
      baseSha: "base"
    }).job;

    const result = await runScheduledCycleWithDeps({
      config,
      github: githubFromMap(new Map([
        ["org/repo-a", [pull("org/repo-a", 1, HEAD_B)]]
      ])),
      state,
      options: { dryRun: false, useZCode: false },
      reviewPullImpl: async ({ state: reviewState, repo, pull: reviewPull }) => {
        reviewState.recordProcessed({
          repo,
          pullNumber: reviewPull.number,
          headSha: reviewPull.head.sha,
          status: "posted",
          event: "COMMENT"
        });
        return "reviewed";
      },
      now: new Date("2026-07-02T00:00:00.000Z")
    });

    expect(result.reviewed).toBe(1);
    expect(result.statusCommentFailures).toBe(0);
    expect(state.getReviewQueueJob(oldJob.jobId)).toMatchObject({
      state: "stale_retired",
      lastError: `superseded_by_head=${HEAD_B}`
    });
    state.close();
  });

  it("retires closed queue jobs even when status comments are disabled", async () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-scheduler-disabled-status-closed-"));
    roots.push(root);
    const config = schedulerConfig(root, []);
    config.reviewStatusComment!.enabled = false;
    const state = new ReviewStateStore(config.statePath);
    const oldJob = state.enqueueReviewQueueJob({
      repo: "org/repo-a",
      pullNumber: 1,
      headSha: HEAD_A,
      baseSha: "base"
    }).job;

    const result = await runScheduledCycleWithDeps({
      config,
      github: githubFromMap(new Map([
        ["org/repo-a", [pull("org/repo-a", 1, HEAD_A, "base", { state: "closed" })]]
      ])),
      state,
      options: { repo: "org/repo-a", pullNumber: 1, dryRun: false, useZCode: false },
      reviewPullImpl: async () => {
        throw new Error("should not review closed pull");
      },
      now: new Date("2026-07-02T00:00:00.000Z")
    });

    expect(result.queue.closedRetired).toBe(1);
    expect(result.statusCommentFailures).toBe(0);
    expect(state.getReviewQueueJob(oldJob.jobId)).toMatchObject({ state: "closed_retired" });
    state.close();
  });

  it("posts stale_head for a leased job whose head no longer matches the live pull", async () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-scheduler-leased-head-mismatch-"));
    roots.push(root);
    const config = schedulerConfig(root, []);
    config.reviewStatusComment!.enabled = true;
    const state = new ReviewStateStore(config.statePath);
    state.enqueueReviewQueueJob({
      repo: "org/repo-a",
      pullNumber: 1,
      headSha: HEAD_A,
      baseSha: "base"
    });
    const statusCalls: StatusCommentCall[] = [];

    const result = await runScheduledCycleWithDeps({
      config,
      github: githubFromMap(new Map([
        ["org/repo-a", [pull("org/repo-a", 1, HEAD_B)]]
      ]), new Map(), statusCalls),
      state,
      options: { dryRun: false, useZCode: false },
      reviewPullImpl: async () => {
        throw new Error("should not review stale head");
      },
      now: new Date("2026-07-02T00:00:00.000Z")
    });

    expect(result.skippedStaleHead).toBe(1);
    expect(statusCalls.map(statusFromBody)).toEqual(["stale_head"]);
    expect(statusCalls[0]?.marker).toBe(`<!-- evaos-code-review-bot:review-status repo=org/repo-a pr=1 sha=${HEAD_A} -->`);
    expect(state.listReviewQueueJobs({ state: "stale_retired" })).toHaveLength(1);
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

  it("returns RepoSticky session jobs to assigned on provider cooldown", async () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-scheduler-reposticky-provider-throttle-"));
    roots.push(root);
    const config = schedulerConfig(root, ["org/repo-a"]);
    config.reviewerSessions = {
      enabled: true,
      ttlMs: 8 * 60 * 60_000,
      headCountLimit: 10
    };
    const state = new ReviewStateStore(config.statePath);

    const result = await runScheduledCycleWithDeps({
      config,
      github: githubFromMap(new Map([
        ["org/repo-a", [pull("org/repo-a", 1, "a1")]]
      ])),
      state,
      options: { dryRun: false, useZCode: true },
      reviewPullImpl: async () => {
        throw new Error("ProviderBusinessError: [1302][Rate limit reached for requests]");
      },
      now: new Date("2026-07-01T00:00:00.000Z")
    });

    expect(result.skippedProviderCooldown).toBe(1);
    expect(state.listReviewQueueJobs({ state: "provider_deferred" })).toEqual([
      expect.objectContaining({
        repo: "org/repo-a",
        pullNumber: 1,
        nextEligibleAt: "2026-07-01T00:01:30.000Z"
      })
    ]);
    expect(state.getReviewerSessionJob("org/repo-a", 1, "a1")).toMatchObject({
      jobState: "assigned"
    });
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

  it("uses head-only stale detection for legacy queue jobs without a base SHA", async () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-scheduler-missing-base-"));
    roots.push(root);
    const config = schedulerConfig(root, []);
    const state = new ReviewStateStore(config.statePath);
    const job = state.enqueueReviewQueueJob({ repo: "org/repo-a", pullNumber: 1, headSha: "head-a" }).job;
    let attempts = 0;

    const result = await runScheduledCycleWithDeps({
      config,
      github: githubFromMap(new Map([
        ["org/repo-a", [pull("org/repo-a", 1, "head-a", "new-base")]]
      ])),
      state,
      options: { dryRun: false, useZCode: false },
      reviewPullImpl: async ({ state: reviewState, repo, pull: reviewPull }) => {
        attempts += 1;
        reviewState.recordProcessed({
          repo,
          pullNumber: reviewPull.number,
          headSha: reviewPull.head.sha,
          status: "posted",
          event: "COMMENT",
          reviewUrl: `https://github.com/${repo}/pull/${reviewPull.number}#pullrequestreview-3`
        });
        return "reviewed";
      },
      now: new Date("2026-07-01T00:00:00.000Z")
    });

    expect(attempts).toBe(1);
    expect(result.skippedStaleHead).toBe(0);
    expect(state.getReviewQueueJob(job.jobId)).toMatchObject({ state: "posted" });
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

  it("enqueues trusted command reviews even when the current head is already processed", async () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-scheduler-command-processed-"));
    roots.push(root);
    const config = schedulerConfig(root, ["org/repo-a"]);
    config.commands = {
      enabled: true,
      botMentions: ["@evaos-code-review-bot"],
      trustedAuthors: ["100yenadmin"],
      acknowledge: false
    };
    const state = new ReviewStateStore(config.statePath);
    state.recordProcessed({
      repo: "org/repo-a",
      pullNumber: 1,
      headSha: "a1",
      status: "posted",
      event: "COMMENT",
      reviewUrl: "https://github.com/org/repo-a/pull/1#pullrequestreview-old"
    });
    const pullMap = new Map([["org/repo-a", [pull("org/repo-a", 1, "a1")]]]);
    const comments = new Map([
      ["org/repo-a#1", [comment(222, "100yenadmin", "@evaos-code-review-bot re-review")]]
    ]);

    const result = await runScheduledCycleWithDeps({
      config,
      github: githubFromMap(pullMap, comments),
      state,
      options: { dryRun: false, useZCode: false },
      reviewPullImpl: async ({ state: reviewState, repo, pull: reviewPull }) => {
        reviewState.recordProcessed({
          repo,
          pullNumber: reviewPull.number,
          headSha: reviewPull.head.sha,
          status: "posted",
          event: "COMMENT",
          reviewUrl: "https://github.com/org/repo-a/pull/1#pullrequestreview-command"
        });
        return "reviewed_command";
      },
      now: new Date("2026-07-01T00:00:00.000Z")
    });

    expect(result.reviewed).toBe(1);
    expect(result.commandReviewRequested).toBe(1);
    expect(state.listReviewQueueJobs({ state: "posted" })).toEqual([
      expect.objectContaining({
        source: "manual_command",
        lane: "manual",
        commentId: 222,
        repo: "org/repo-a",
        pullNumber: 1
      })
    ]);
    state.close();
  });

  it("records trusted stop commands as terminal skips for the current head", async () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-scheduler-command-stop-"));
    roots.push(root);
    const config = schedulerConfig(root, ["org/repo-a"]);
    config.commands = {
      enabled: true,
      botMentions: ["@evaos-code-review-bot"],
      trustedAuthors: ["100yenadmin"],
      acknowledge: false
    };
    const state = new ReviewStateStore(config.statePath);
    const pullMap = new Map([["org/repo-a", [pull("org/repo-a", 1, "a1")]]]);
    const comments = new Map([
      ["org/repo-a#1", [comment(333, "100yenadmin", "@evaos-code-review-bot stop")]]
    ]);

    const result = await runScheduledCycleWithDeps({
      config,
      github: githubFromMap(pullMap, comments),
      state,
      options: { dryRun: false, useZCode: false },
      reviewPullImpl: reviewPull,
      now: new Date("2026-07-01T00:00:00.000Z")
    });

    expect(result.skippedCommandStop).toBe(1);
    expect(state.getProcessedReview("org/repo-a", 1, "a1")).toMatchObject({
      status: "skipped",
      error: expect.stringContaining("manual_command_stop")
    });
    expect(state.listReviewQueueJobs({ state: "command_recorded" })).toEqual([
      expect.objectContaining({
        source: "manual_command",
        lane: "manual",
        commentId: 333,
        lastError: "manual_command_stop_recorded"
      })
    ]);
    state.close();
  });

  it("does not replay an old processed stop command onto a new head", async () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-scheduler-command-stop-new-head-"));
    roots.push(root);
    const config = schedulerConfig(root, ["org/repo-a"]);
    config.commands = {
      enabled: true,
      botMentions: ["@evaos-code-review-bot"],
      trustedAuthors: ["100yenadmin"],
      acknowledge: false
    };
    const state = new ReviewStateStore(config.statePath);
    state.recordProcessedCommand({
      repo: "org/repo-a",
      pullNumber: 1,
      headSha: "old-head",
      commentId: 335,
      action: "stop",
      status: "stopped",
      author: "100yenadmin"
    });
    const pullMap = new Map([["org/repo-a", [pull("org/repo-a", 1, "new-head")]]]);
    const comments = new Map([
      ["org/repo-a#1", [comment(335, "100yenadmin", "@evaos-code-review-bot stop")]]
    ]);

    const result = await runScheduledCycleWithDeps({
      config,
      github: githubFromMap(pullMap, comments),
      state,
      options: { dryRun: false, useZCode: false },
      reviewPullImpl: async ({ state: reviewState, repo, pull: reviewPull }) => {
        reviewState.recordProcessed({
          repo,
          pullNumber: reviewPull.number,
          headSha: reviewPull.head.sha,
          status: "posted",
          event: "COMMENT"
        });
        return "reviewed";
      },
      now: new Date("2026-07-01T00:00:00.000Z")
    });

    expect(result.reviewed).toBe(1);
    expect(result.skippedCommandStop).toBe(0);
    expect(state.getProcessedReview("org/repo-a", 1, "new-head")).toMatchObject({ status: "posted" });
    state.close();
  });

  it("does not let trusted stop commands clobber an existing posted review row", async () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-scheduler-command-stop-posted-"));
    roots.push(root);
    const config = schedulerConfig(root, ["org/repo-a"]);
    config.commands = {
      enabled: true,
      botMentions: ["@evaos-code-review-bot"],
      trustedAuthors: ["100yenadmin"],
      acknowledge: false
    };
    const state = new ReviewStateStore(config.statePath);
    state.recordProcessed({
      repo: "org/repo-a",
      pullNumber: 1,
      headSha: "a1",
      status: "posted",
      event: "COMMENT",
      reviewUrl: "https://github.com/org/repo-a/pull/1#pullrequestreview-original"
    });
    const pullMap = new Map([["org/repo-a", [pull("org/repo-a", 1, "a1")]]]);
    const comments = new Map([
      ["org/repo-a#1", [comment(334, "100yenadmin", "@evaos-code-review-bot stop")]]
    ]);

    await runScheduledCycleWithDeps({
      config,
      github: githubFromMap(pullMap, comments),
      state,
      options: { dryRun: false, useZCode: false },
      reviewPullImpl: reviewPull,
      now: new Date("2026-07-01T00:00:00.000Z")
    });

    expect(state.getProcessedReview("org/repo-a", 1, "a1")).toMatchObject({
      status: "posted",
      reviewUrl: "https://github.com/org/repo-a/pull/1#pullrequestreview-original"
    });
    state.close();
  });

  it("keeps a comment fetch failure scoped to that pull instead of failing the scheduler cycle", async () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-scheduler-command-fetch-failure-"));
    roots.push(root);
    const config = schedulerConfig(root, ["org/repo-a", "org/repo-b"]);
    config.commands = {
      enabled: true,
      botMentions: ["@evaos-code-review-bot"],
      trustedAuthors: ["100yenadmin"],
      acknowledge: false
    };
    const state = new ReviewStateStore(config.statePath);
    const pullMap = new Map([
      ["org/repo-a", [pull("org/repo-a", 1, "a1")]],
      ["org/repo-b", [pull("org/repo-b", 1, "b1")]]
    ]);
    const reviewed: string[] = [];

    const result = await runScheduledCycleWithDeps({
      config,
      github: {
        ...githubFromMap(pullMap),
        listIssueComments: async (repo, issueNumber) => {
          if (repo === "org/repo-a" && issueNumber === 1) throw new Error("GitHub 500");
          return [];
        }
      },
      state,
      options: { dryRun: false, useZCode: false },
      reviewPullImpl: async ({ state: reviewState, repo, pull: reviewPull }) => {
        reviewed.push(`${repo}#${reviewPull.number}`);
        reviewState.recordProcessed({
          repo,
          pullNumber: reviewPull.number,
          headSha: reviewPull.head.sha,
          status: "posted",
          event: "COMMENT"
        });
        return "reviewed";
      },
      now: new Date("2026-07-01T00:00:00.000Z")
    });

    expect(result.failed).toBe(0);
    expect(result.commandFetchErrors).toBe(1);
    expect(reviewed).toHaveLength(2);
    state.close();
  });

  it("assigns scheduler jobs to reusable repo-sticky reviewer sessions when enabled", async () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-scheduler-reposticky-"));
    roots.push(root);
    const config = schedulerConfig(root, ["org/repo-a"]);
    config.reviewerSessions = {
      enabled: true,
      ttlMs: 8 * 60 * 60_000,
      headCountLimit: 10
    };
    const state = new ReviewStateStore(config.statePath);
    const pullMap = new Map([
      ["org/repo-a", [pull("org/repo-a", 1, "a1"), pull("org/repo-a", 2, "a2")]]
    ]);

    const result = await runScheduledCycleWithDeps({
      config,
      github: githubFromMap(pullMap),
      state,
      options: { dryRun: false, useZCode: false },
      reviewPullImpl: async ({ state: reviewState, repo, pull: reviewPull }) => {
        reviewState.recordProcessed({
          repo,
          pullNumber: reviewPull.number,
          headSha: reviewPull.head.sha,
          status: "posted",
          event: "COMMENT",
          reviewUrl: `https://github.com/${repo}/pull/${reviewPull.number}#pullrequestreview-sticky`
        });
        return "reviewed";
      },
      now: new Date("2026-07-01T00:00:00.000Z")
    });

    const jobs = state.listReviewQueueJobs({ repo: "org/repo-a" });
    expect(result.queue.enqueued).toBe(2);
    expect(result.queue.leased).toBe(1);
    expect(new Set(jobs.map((job) => job.sessionId)).size).toBe(1);
    expect(state.listReviewerSessions({ repo: "org/repo-a" })).toEqual([
      expect.objectContaining({
        repo: "org/repo-a",
        state: "active",
        headCountUsed: 2,
        provider: "zai-coding-plan"
      })
    ]);
    expect(state.getReviewerSessionJob("org/repo-a", 1, "a1")).toMatchObject({
      jobState: "completed",
      processedReviewStatus: "posted"
    });
    expect(state.getReviewerSessionJob("org/repo-a", 2, "a2")).toMatchObject({
      jobState: "assigned"
    });
    state.close();
  });

  it("does not consume RepoSticky session head budget for stop or explain commands", async () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-scheduler-reposticky-command-non-review-"));
    roots.push(root);
    const config = schedulerConfig(root, ["org/repo-a"]);
    config.commands = {
      enabled: true,
      botMentions: ["@evaos-code-review-bot"],
      trustedAuthors: ["100yenadmin"],
      acknowledge: false
    };
    config.reviewerSessions = {
      enabled: true,
      ttlMs: 8 * 60 * 60_000,
      headCountLimit: 10
    };
    const state = new ReviewStateStore(config.statePath);
    const pullMap = new Map([["org/repo-a", [pull("org/repo-a", 1, "a1")]]]);
    const comments = new Map([
      ["org/repo-a#1", [comment(336, "100yenadmin", "@evaos-code-review-bot explain")]]
    ]);

    await runScheduledCycleWithDeps({
      config,
      github: githubFromMap(pullMap, comments),
      state,
      options: { dryRun: false, useZCode: false },
      reviewPullImpl: reviewPull,
      now: new Date("2026-07-01T00:00:00.000Z")
    });

    expect(state.listReviewerSessions({ repo: "org/repo-a" })).toHaveLength(0);
    const [recordedJob] = state.listReviewQueueJobs({ state: "command_recorded" });
    expect(recordedJob).toMatchObject({ commentId: 336 });
    expect(recordedJob?.sessionId).toBeUndefined();
    state.close();
  });

  it("attaches processed-head re-review commands to RepoSticky sessions", async () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-scheduler-reposticky-command-rereview-"));
    roots.push(root);
    const config = schedulerConfig(root, ["org/repo-a"]);
    config.commands = {
      enabled: true,
      botMentions: ["@evaos-code-review-bot"],
      trustedAuthors: ["100yenadmin"],
      acknowledge: false
    };
    config.reviewerSessions = {
      enabled: true,
      ttlMs: 8 * 60 * 60_000,
      headCountLimit: 10
    };
    const state = new ReviewStateStore(config.statePath);
    state.recordProcessed({
      repo: "org/repo-a",
      pullNumber: 1,
      headSha: "a1",
      status: "posted",
      event: "COMMENT"
    });
    const pullMap = new Map([["org/repo-a", [pull("org/repo-a", 1, "a1")]]]);
    const comments = new Map([
      ["org/repo-a#1", [comment(337, "100yenadmin", "@evaos-code-review-bot re-review")]]
    ]);

    await runScheduledCycleWithDeps({
      config,
      github: githubFromMap(pullMap, comments),
      state,
      options: { dryRun: false, useZCode: false },
      reviewPullImpl: async ({ state: reviewState, repo, pull: reviewPull }) => {
        reviewState.recordProcessed({
          repo,
          pullNumber: reviewPull.number,
          headSha: reviewPull.head.sha,
          status: "posted",
          event: "COMMENT"
        });
        return "reviewed_command";
      },
      now: new Date("2026-07-01T00:00:00.000Z")
    });

    const [job] = state.listReviewQueueJobs({ repo: "org/repo-a" });
    expect(job).toMatchObject({ source: "manual_command", commentId: 337 });
    expect(job.sessionId).toBeDefined();
    expect(state.listReviewerSessions({ repo: "org/repo-a" })).toHaveLength(1);
    state.close();
  });

  it("preserves dry-run processed status in repo-sticky reviewer session jobs", async () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-scheduler-reposticky-dry-run-"));
    roots.push(root);
    const config = schedulerConfig(root, ["org/repo-a"]);
    config.reviewerSessions = {
      enabled: true,
      ttlMs: 8 * 60 * 60_000,
      headCountLimit: 10
    };
    const state = new ReviewStateStore(config.statePath);

    await runScheduledCycleWithDeps({
      config,
      github: githubFromMap(new Map([
        ["org/repo-a", [pull("org/repo-a", 1, "a1")]]
      ])),
      state,
      options: { dryRun: true, useZCode: false },
      reviewPullImpl: async ({ state: reviewState, repo, pull: reviewPull }) => {
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

    expect(state.getReviewerSessionJob("org/repo-a", 1, "a1")).toMatchObject({
      jobState: "completed",
      processedReviewStatus: "dry_run"
    });
    const [queueJob] = state.listReviewQueueJobs();
    expect(queueJob).toMatchObject({
      state: "queued",
      lastError: "dry_run_completed_not_posted"
    });
    state.close();
  });

  it("binds manual queue jobs to their queued command comment id", async () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-scheduler-manual-comment-binding-"));
    roots.push(root);
    const config = schedulerConfig(root, []);
    config.commands = {
      enabled: true,
      botMentions: ["@evaos-code-review-bot"],
      trustedAuthors: ["100yenadmin"],
      acknowledge: false
    };
    const state = new ReviewStateStore(config.statePath);
    state.enqueueReviewQueueJob({
      repo: "org/repo-a",
      pullNumber: 1,
      headSha: "a1",
      baseSha: "base",
      source: "manual_command",
      lane: "manual",
      commentId: 401
    });
    const comments = new Map([
      ["org/repo-a#1", [
        comment(401, "100yenadmin", "@evaos-code-review-bot review"),
        comment(402, "100yenadmin", "@evaos-code-review-bot stop")
      ]]
    ]);

    const commandCommentIds: Array<number | undefined> = [];
    const result = await runScheduledCycleWithDeps({
      config,
      github: githubFromMap(new Map([
        ["org/repo-a", [pull("org/repo-a", 1, "a1")]]
      ]), comments),
      state,
      options: { dryRun: false, useZCode: false },
      reviewPullImpl: async ({ state: reviewState, repo, pull: reviewPull, commandCommentId }) => {
        commandCommentIds.push(commandCommentId);
        reviewState.recordProcessedCommand({
          repo,
          pullNumber: reviewPull.number,
          headSha: reviewPull.head.sha,
          commentId: commandCommentId ?? 0,
          action: "review",
          status: "triggered",
          author: "100yenadmin"
        });
        reviewState.recordProcessed({
          repo,
          pullNumber: reviewPull.number,
          headSha: reviewPull.head.sha,
          status: "posted",
          event: "COMMENT"
        });
        return "reviewed_command";
      },
      now: new Date("2026-07-01T00:00:00.000Z")
    });

    expect(result.reviewed).toBe(1);
    expect(result.skippedCommandStop).toBe(0);
    expect(commandCommentIds).toEqual([401]);
    expect(state.hasProcessedCommand("org/repo-a", 1, "a1", 401)).toBe(true);
    expect(state.hasProcessedCommand("org/repo-a", 1, "a1", 402)).toBe(false);
    state.close();
  });

  it("does not stale-retire manual command jobs when only the base SHA changed", async () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-scheduler-manual-base-drift-"));
    roots.push(root);
    const config = schedulerConfig(root, []);
    const state = new ReviewStateStore(config.statePath);
    state.enqueueReviewQueueJob({
      repo: "org/repo-a",
      pullNumber: 1,
      headSha: "a1",
      baseSha: "old-base",
      source: "manual_command",
      lane: "manual",
      commentId: 403
    });

    const result = await runScheduledCycleWithDeps({
      config,
      github: githubFromMap(new Map([
        ["org/repo-a", [pull("org/repo-a", 1, "a1", "new-base")]]
      ])),
      state,
      options: { dryRun: false, useZCode: false },
      reviewPullImpl: async ({ state: reviewState, repo, pull: reviewPull }) => {
        reviewState.recordProcessed({
          repo,
          pullNumber: reviewPull.number,
          headSha: reviewPull.head.sha,
          status: "posted",
          event: "COMMENT"
        });
        return "reviewed";
      },
      now: new Date("2026-07-01T00:00:00.000Z")
    });

    expect(result.reviewed).toBe(1);
    expect(result.skippedStaleHead).toBe(0);
    expect(state.listReviewQueueJobs({ state: "posted" })).toHaveLength(1);
    state.close();
  });

  it("stale-retires automatic base-drift jobs without posting a terminal same-head status", async () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-scheduler-automatic-base-drift-"));
    roots.push(root);
    const config = schedulerConfig(root, []);
    config.reviewStatusComment!.enabled = true;
    const state = new ReviewStateStore(config.statePath);
    state.enqueueReviewQueueJob({
      repo: "org/repo-a",
      pullNumber: 1,
      headSha: HEAD_A,
      baseSha: "old-base"
    });
    const statusCalls: StatusCommentCall[] = [];

    const result = await runScheduledCycleWithDeps({
      config,
      github: githubFromMap(new Map([
        ["org/repo-a", [pull("org/repo-a", 1, HEAD_A, "new-base")]]
      ]), new Map(), statusCalls),
      state,
      options: { dryRun: false, useZCode: false },
      reviewPullImpl: async ({ state: reviewState, repo, pull: reviewPull }) => {
        reviewState.recordProcessed({
          repo,
          pullNumber: reviewPull.number,
          headSha: reviewPull.head.sha,
          status: "posted",
          event: "COMMENT"
        });
        return "reviewed";
      },
      now: new Date("2026-07-01T00:00:00.000Z")
    });

    expect(result.reviewed).toBe(0);
    expect(result.skippedStaleHead).toBe(1);
    expect(statusCalls).toHaveLength(0);
    expect(state.listReviewQueueJobs({ state: "stale_retired" })).toEqual([
      expect.objectContaining({ lastError: "base_changed_before_review live=new-base" })
    ]);
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
    reviewStatusComment: {
      enabled: false
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

function githubFromMap(
  pullsByRepo: Map<string, PullRequestSummary[]>,
  commentsByPull = new Map<string, ReturnType<typeof comment>[]>(),
  statusCalls?: StatusCommentCall[]
): SchedulerGitHubApi {
  return {
    listOpenPulls: async (repo) => pullsByRepo.get(repo)?.filter((entry) => entry.state === undefined || entry.state === "open") ?? [],
    getPull: async (repo, pullNumber) => {
      const pull = pullsByRepo.get(repo)?.find((entry) => entry.number === pullNumber);
      if (!pull) throw new Error(`missing pull ${repo}#${pullNumber}`);
      return pull;
    },
    listIssueComments: async (repo, issueNumber) => commentsByPull.get(`${repo}#${issueNumber}`) ?? [],
    ...(statusCalls
      ? {
          canPostAsApp: () => true,
          upsertIssueComment: async (input: StatusCommentCall) => {
            statusCalls.push(input);
            return { action: statusCalls.filter((call) => call.marker === input.marker).length === 1 ? "created" as const : "updated" as const, id: statusCalls.length };
          }
        }
      : {})
  };
}

interface StatusCommentCall {
  repo: string;
  issueNumber: number;
  marker: string;
  body: string;
}

function statusFromBody(call: StatusCommentCall): string {
  const match = call.body.match(/review-status-state status=([^ ]+)/);
  if (!match?.[1]) throw new Error(`missing status marker in ${call.body}`);
  return match[1];
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

function comment(id: number, login: string, body: string) {
  return {
    id,
    body,
    html_url: `https://github.test/comment/${id}`,
    user: {
      login,
      type: login.endsWith("bot") ? "Bot" : "User"
    }
  };
}
