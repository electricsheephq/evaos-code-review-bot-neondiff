import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BotConfig } from "../src/config.js";
import { runScheduledCycleWithDeps as runScheduledCycleWithDepsImpl, type SchedulerGitHubApi } from "../src/scheduler.js";
import { ReviewStateStore } from "../src/state.js";
import type { PullRequestSummary } from "../src/types.js";
import { reviewPull as reviewPullImpl, type ReviewPullInput, type ReviewPullResult } from "../src/worker.js";
import { createTestLicenseAdmission, testLicenseAdmission } from "./helpers/license-admission.js";

const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);
const HEAD_C = "c".repeat(40);
const HEAD_D = "d".repeat(40);
const HEAD_F = "f".repeat(40);
const SELF_REPO_CURRENT = "electricsheephq/evaos-code-review-bot-neondiff";
const SELF_REPO_LEGACY = "electricsheephq/evaos-code-review-bot";
const publicOnlyTestLicenseAdmission = await createTestLicenseAdmission({
  operation: "review_cycle",
  scope: "public",
  privateRepoAllowed: false
});
const reviewPull = (input: ReviewPullInput) => reviewPullImpl({
  ...input,
  pull: testVisiblePull(input.pull),
  licenseAdmission: input.licenseAdmission ?? testLicenseAdmission
});
const runScheduledCycleWithDeps = (
  input: Parameters<typeof runScheduledCycleWithDepsImpl>[0]
) => runScheduledCycleWithDepsImpl({ ...input, licenseAdmission: input.licenseAdmission ?? testLicenseAdmission });

function testVisiblePull(pull: PullRequestSummary): PullRequestSummary {
  return {
    ...pull,
    base: { ...pull.base, repo: { ...pull.base.repo, private: false, visibility: "public" } }
  };
}

describe("provider-aware review scheduler", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("rejects a wrong-operation public token before scheduled work", async () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-scheduler-license-scope-"));
    roots.push(root);
    const config = schedulerConfig(root, ["org/private-repo"]);
    const state = new ReviewStateStore(config.statePath);
    const privatePull = pull("org/private-repo", 1, "private-head", "base", { visibility: "private" });
    let reviewCalls = 0;

    await expect(runScheduledCycleWithDeps({
      config,
      github: githubFromMap(new Map([["org/private-repo", [privatePull]]])),
      state,
      options: { dryRun: false },
      licenseAdmission: publicOnlyTestLicenseAdmission,
      reviewPullImpl: async () => {
        reviewCalls += 1;
        return "reviewed";
      }
    })).rejects.toThrow(/review-discovery admission is required/i);

    expect(reviewCalls).toBe(0);
    expect(state.listReviewQueueJobs()).toEqual([]);
    expect(state.getReviewReadiness("org/private-repo", 1, "private-head")).toBeUndefined();
    state.close();
  });

  it("counts unknown-visibility admission denials only as license-gate skips", async () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-scheduler-unknown-visibility-"));
    roots.push(root);
    const config = schedulerConfig(root, ["org/unknown-repo"]);
    const state = new ReviewStateStore(config.statePath);
    const sourcePull = pull("org/unknown-repo", 1, "unknown-head");
    const unknownPull: PullRequestSummary = {
      ...sourcePull,
      base: { ...sourcePull.base, repo: { full_name: "org/unknown-repo" } }
    };
    let reviewCalls = 0;

    const result = await runScheduledCycleWithDeps({
      config,
      github: githubFromMap(new Map([["org/unknown-repo", [unknownPull]]])),
      state,
      options: { dryRun: false },
      reviewPullImpl: async () => {
        reviewCalls += 1;
        return "reviewed";
      }
    });

    expect(result.skippedLicenseGate).toBe(1);
    expect(result.skippedPolicy).toBe(0);
    expect(reviewCalls).toBe(0);
    state.close();
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
    expect(result.queue.budget?.wouldLeaseCount).toBe(2);
    expect(result.queue.budget?.delayedCount).toBe(8);
    expect(result.queue.budget?.details.included).toBe(false);
    expect(result.queue.budget?.wouldLease).toHaveLength(0);
    expect(result.queue.budget?.delayed).toHaveLength(0);
    expect(Object.values(result.queue.delayedByReason).reduce((total, count) => total + count, 0)).toBe(8);
    expect(Object.keys(result.queue.delayedByReason).sort()).toEqual(
      expect.arrayContaining(["provider_capacity"])
    );
    expect(reviewed).toHaveLength(2);
    expect(new Set(reviewed.map((entry) => entry.split("#")[0]))).toHaveLength(2);
    expect(state.listReviewQueueJobs({ state: "posted" })).toHaveLength(0);
    expect(state.listReviewQueueJobs({ state: "queued" })).toHaveLength(10);
    expect(state.listReviewQueueJobs({ state: "queued" })
      .filter((job) => job.lastError === "dry_run_completed_not_posted")).toHaveLength(2);
    expect(state.listReviewReadiness({ states: ["queued"] }).length).toBeGreaterThan(0);
    state.close();
  });

  it("leases queued jobs just in time so provider capacity does not create idle leases", async () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-scheduler-jit-lease-"));
    roots.push(root);
    const config = schedulerConfig(root, ["org/repo-a", "org/repo-b"]);
    config.reviewScheduler!.maxProviderActive = 2;
    config.reviewScheduler!.maxOrgActive = 2;
    config.reviewScheduler!.maxRepoActive = 1;
    const state = new ReviewStateStore(config.statePath);
    const observedDuringFirstReview: Array<{ repo: string; state: string; startedAt?: string }> = [];
    const reviewed: string[] = [];

    const result = await runScheduledCycleWithDeps({
      config,
      github: githubFromMap(new Map([
        ["org/repo-a", [pull("org/repo-a", 1, HEAD_A)]],
        ["org/repo-b", [pull("org/repo-b", 1, HEAD_B)]]
      ])),
      state,
      options: { dryRun: true, useZCode: false },
      reviewPullImpl: async ({ state: reviewState, repo, pull: reviewPull }) => {
        reviewed.push(`${repo}#${reviewPull.number}`);
        if (repo === "org/repo-a") {
          observedDuringFirstReview.push(...reviewState.listReviewQueueJobs()
            .filter((job) => job.repo === "org/repo-b")
            .map((job) => ({
              repo: job.repo,
              state: job.state,
              ...(job.startedAt ? { startedAt: job.startedAt } : {})
            })));
        }
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

    expect(result.queue).toMatchObject({
      enqueued: 2,
      leased: 2,
      completed: 2,
      remainingQueued: 2
    });
    expect(reviewed).toEqual(["org/repo-a#1", "org/repo-b#1"]);
    expect(observedDuringFirstReview).toEqual([
      { repo: "org/repo-b", state: "queued" }
    ]);
    expect(state.listReviewQueueJobs({ state: "leased" })).toHaveLength(0);
    expect(state.listReviewQueueJobs({ state: "running" })).toHaveLength(0);
    state.close();
  });

  it("posts a sticky status comment from queued through completed for a live queued head", async () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-scheduler-status-completed-"));
    roots.push(root);
    const config = schedulerConfig(root, ["org/repo-a"]);
    config.reviewStatusComment!.enabled = true;
    const state = new ReviewStateStore(config.statePath);
    const statusCalls: StatusCommentCall[] = [];
    const readinessObservedDuringReview: string[] = [];

    const result = await runScheduledCycleWithDeps({
      config,
      github: githubFromMap(new Map([
        ["org/repo-a", [pull("org/repo-a", 1, HEAD_A)]]
      ]), new Map(), statusCalls),
      state,
      options: { dryRun: false, useZCode: false },
      reviewPullImpl: async ({ state: reviewState, repo, pull: reviewPull }) => {
        readinessObservedDuringReview.push(reviewState.getReviewReadiness(repo, reviewPull.number, reviewPull.head.sha)?.state ?? "missing");
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
    expect(readinessObservedDuringReview).toEqual(["reviewing"]);
    expect(statusCalls.map(statusFromBody)).toEqual(["queued", "in_progress", "completed"]);
    expect(new Set(statusCalls.map((call) => call.marker))).toEqual(new Set([
      `<!-- evaos-code-review-bot:review-status repo=org/repo-a pr=1 sha=${HEAD_A} -->`
    ]));
    expect(statusCalls.at(-1)?.body).toContain("https://github.com/org/repo-a/pull/1#pullrequestreview-status");
    expect(state.getReviewReadiness("org/repo-a", 1, HEAD_A)).toMatchObject({
      state: "ready_for_human",
      reason: "comment_review_posted",
      event: "COMMENT",
      reviewUrl: "https://github.com/org/repo-a/pull/1#pullrequestreview-status"
    });
    state.close();
  });

  it("persists REQUEST_CHANGES reviews as needs_fix readiness", async () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-scheduler-readiness-needs-fix-"));
    roots.push(root);
    const config = schedulerConfig(root, ["org/repo-a"]);
    const state = new ReviewStateStore(config.statePath);

    const result = await runScheduledCycleWithDeps({
      config,
      github: githubFromMap(new Map([
        ["org/repo-a", [pull("org/repo-a", 1, HEAD_A)]]
      ])),
      state,
      options: { dryRun: false, useZCode: false },
      reviewPullImpl: async ({ state: reviewState, repo, pull: reviewPull }) => {
        reviewState.recordProcessed({
          repo,
          pullNumber: reviewPull.number,
          headSha: reviewPull.head.sha,
          status: "posted",
          event: "REQUEST_CHANGES",
          reviewUrl: "https://github.com/org/repo-a/pull/1#pullrequestreview-blocking"
        });
        return "reviewed";
      },
      now: new Date("2026-07-02T00:00:00.000Z")
    });

    expect(result.reviewed).toBe(1);
    expect(state.getReviewReadiness("org/repo-a", 1, HEAD_A)).toMatchObject({
      state: "needs_fix",
      reason: "request_changes_review_posted",
      event: "REQUEST_CHANGES",
      reviewUrl: "https://github.com/org/repo-a/pull/1#pullrequestreview-blocking"
    });
    state.close();
  });

  it.each([
    ["posted_stale_head", "stale_retired", "stale", "stale_head"],
    ["posted_head_unverified", "failed", "failed", "failed"],
    ["skipped_consumed_authorization", "failed", "failed", "failed"]
  ] as const)("does not advertise %s as a completed review", async (workerStatus, queueState, readinessState, publicState) => {
    const root = mkdtempSync(join(tmpdir(), `evaos-scheduler-${workerStatus}-`));
    roots.push(root);
    const config = schedulerConfig(root, ["org/repo-a"]);
    config.reviewStatusComment!.enabled = true;
    const state = new ReviewStateStore(config.statePath);
    const statusCalls: StatusCommentCall[] = [];

    const result = await runScheduledCycleWithDeps({
      config,
      github: githubFromMap(new Map([["org/repo-a", [pull("org/repo-a", 1, HEAD_A)]]]), new Map(), statusCalls),
      state,
      options: { dryRun: false, useZCode: false },
      reviewPullImpl: async ({ state: reviewState, repo, pull: reviewPull }) => {
        if (workerStatus !== "skipped_consumed_authorization") {
          reviewState.recordProcessed({
            repo,
            pullNumber: reviewPull.number,
            headSha: reviewPull.head.sha,
            status: "posted",
            event: "REQUEST_CHANGES",
            reviewUrl: "https://github.com/org/repo-a/pull/1#pullrequestreview-incident"
          });
        }
        return workerStatus;
      },
      now: new Date("2026-07-13T00:00:00.000Z")
    });

    expect(result.reviewed).toBe(0);
    expect(result.queue.completed).toBe(0);
    expect(state.listReviewQueueJobs({ state: queueState })).toHaveLength(1);
    expect(state.getReviewReadiness("org/repo-a", 1, HEAD_A)).toMatchObject({ state: readinessState });
    expect(statusCalls.map(statusFromBody)).toEqual(["queued", "in_progress", publicState]);
    expect(statusCalls.map(statusFromBody)).not.toContain("completed");
    state.close();
  });

  it("maps context-budget skips into skipped readiness and failed durable queue state", async () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-scheduler-context-budget-skip-"));
    roots.push(root);
    const config = schedulerConfig(root, ["org/repo-a"]);
    config.reviewStatusComment!.enabled = true;
    const state = new ReviewStateStore(config.statePath);
    const statusCalls: StatusCommentCall[] = [];

    const result = await runScheduledCycleWithDeps({
      config,
      github: githubFromMap(new Map([
        ["org/repo-a", [pull("org/repo-a", 7, HEAD_D)]]
      ]), new Map(), statusCalls),
      state,
      options: { dryRun: false, useZCode: false },
      reviewPullImpl: async ({ state: reviewState, repo, pull: reviewPull }) => {
        reviewState.recordProcessed({
          repo,
          pullNumber: reviewPull.number,
          headSha: reviewPull.head.sha,
          status: "failed",
          error: "context_budget_overflow"
        });
        return "skipped_context_budget";
      },
      now: new Date("2026-07-02T00:00:00.000Z")
    });

    expect(result.skippedContextBudget).toBe(1);
    expect(result.queue.failedQueueJobs).toBe(1);
    expect(statusCalls.map(statusFromBody)).toEqual(["queued", "in_progress", "skipped"]);
    expect(state.getReviewReadiness("org/repo-a", 7, HEAD_D)).toMatchObject({
      state: "skipped",
      reason: "context_budget_overflow"
    });
    expect(state.listReviewQueueJobs({ repo: "org/repo-a" })).toEqual([
      expect.objectContaining({
        pullNumber: 7,
        headSha: HEAD_D,
        state: "failed",
        lastError: "context_budget_overflow"
      })
    ]);
    state.close();
  });

  it("preserves the worker-recorded license gate reason when scheduler syncs readiness", async () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-scheduler-license-gate-reason-"));
    roots.push(root);
    const config = schedulerConfig(root, ["org/repo-a"]);
    const state = new ReviewStateStore(config.statePath);
    const reason = "license API network failure: visibility lookup denied";

    const result = await runScheduledCycleWithDeps({
      config,
      github: githubFromMap(new Map([
        ["org/repo-a", [pull("org/repo-a", 1, HEAD_A)]]
      ])),
      state,
      options: { dryRun: false, useZCode: false },
      reviewPullImpl: async ({ state: reviewState, repo, pull: reviewPull }) => {
        reviewState.recordReviewReadiness({
          repo,
          pullNumber: reviewPull.number,
          headSha: reviewPull.head.sha,
          state: "blocked_on_proof",
          reason
        });
        return "skipped_license_gate";
      },
      now: new Date("2026-07-02T00:00:00.000Z")
    });

    expect(result.skippedPolicy).toBe(1);
    expect(state.getReviewReadiness("org/repo-a", 1, HEAD_A)).toMatchObject({
      state: "blocked_on_proof",
      reason
    });
    state.close();
  });

  it("preserves readiness state on duplicate processed-head scheduler cycles", async () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-scheduler-readiness-duplicate-"));
    roots.push(root);
    const config = schedulerConfig(root, ["org/repo-a"]);
    config.reviewStatusComment!.enabled = true;
    const state = new ReviewStateStore(config.statePath);
    const statusCalls: StatusCommentCall[] = [];
    const github = githubFromMap(new Map([
      ["org/repo-a", [pull("org/repo-a", 1, HEAD_A)]]
    ]), new Map(), statusCalls);

    const first = await runScheduledCycleWithDeps({
      config,
      github,
      state,
      options: { dryRun: false, useZCode: false },
      reviewPullImpl: async ({ state: reviewState, repo, pull: reviewPull }) => {
        reviewState.recordProcessed({
          repo,
          pullNumber: reviewPull.number,
          headSha: reviewPull.head.sha,
          status: "posted",
          event: "COMMENT",
          reviewUrl: "https://github.com/org/repo-a/pull/1#pullrequestreview-first"
        });
        return "reviewed";
      },
      now: new Date("2026-07-02T00:00:00.000Z")
    });
    const readiness = state.getReviewReadiness("org/repo-a", 1, HEAD_A);

    const second = await runScheduledCycleWithDeps({
      config,
      github,
      state,
      options: { dryRun: false, useZCode: false },
      reviewPullImpl: async () => {
        throw new Error("duplicate processed heads must not run review work");
      },
      now: new Date("2026-07-02T00:05:00.000Z")
    });

    expect(first.reviewed).toBe(1);
    expect(second.skippedProcessed).toBe(1);
    expect(state.getReviewReadiness("org/repo-a", 1, HEAD_A)).toEqual(readiness);
    expect(statusCalls.map(statusFromBody)).toEqual(["queued", "in_progress", "completed"]);
    state.close();
  });

  it("repairs stale duplicate processed-head scheduler status comments without updating settled markers", async () => {
    const scenarios = [
      { existingStatus: "in_progress", expectedStatusCalls: ["completed"] },
      { existingStatus: "completed", expectedStatusCalls: [] }
    ] as const;

    for (const scenario of scenarios) {
      const root = mkdtempSync(join(tmpdir(), `evaos-scheduler-status-repair-${scenario.existingStatus}-`));
      roots.push(root);
      const config = schedulerConfig(root, ["org/repo-a"]);
      config.reviewStatusComment!.enabled = true;
      const state = new ReviewStateStore(config.statePath);
      const reviewUrl = `https://github.com/org/repo-a/pull/1#pullrequestreview-${scenario.existingStatus}`;
      const statusCalls: StatusCommentCall[] = [];
      const comments = new Map([
        [`org/repo-a#1`, [
          {
            id: 9001,
            body: reviewStatusBody("org/repo-a", 1, HEAD_A, scenario.existingStatus),
            html_url: "https://github.test/comment/9001",
            user: {
              login: "evaos-code-review-bot[bot]",
              type: "Bot"
            }
          }
        ]]
      ]);
      state.recordProcessed({
        repo: "org/repo-a",
        pullNumber: 1,
        headSha: HEAD_A,
        status: "posted",
        event: "COMMENT",
        reviewUrl
      });
      const job = state.enqueueReviewQueueJob({
        repo: "org/repo-a",
        pullNumber: 1,
        headSha: HEAD_A,
        baseSha: "base"
      }).job;
      state.updateReviewQueueJobState({
        jobId: job.jobId,
        state: "posted",
        reviewUrl,
        lastError: "reviewed"
      });
      state.recordReviewReadiness({
        repo: "org/repo-a",
        pullNumber: 1,
        headSha: HEAD_A,
        state: "reviewing",
        reason: "queue_job_running",
        now: new Date("2026-07-02T00:00:00.000Z")
      });

      const result = await runScheduledCycleWithDeps({
        config,
        github: githubFromMap(new Map([
          ["org/repo-a", [pull("org/repo-a", 1, HEAD_A)]]
        ]), comments, statusCalls),
        state,
        options: { dryRun: false, useZCode: false },
        reviewPullImpl: async () => {
          throw new Error("duplicate processed heads must not run review work");
        },
        now: new Date("2026-07-02T00:05:00.000Z")
      });

      expect(result.skippedProcessed).toBe(1);
      expect(statusCalls.map(statusFromBody)).toEqual(scenario.expectedStatusCalls);
      expect(state.getReviewReadiness("org/repo-a", 1, HEAD_A)).toMatchObject({
        state: "ready_for_human",
        reason: "processed_head_already_posted",
        event: "COMMENT",
        reviewUrl
      });
      expect(state.getReviewQueueJob(job.jobId)).toMatchObject({
        state: "posted",
        reviewUrl,
        lastError: "reviewed"
      });
      if (statusCalls.length > 0) expect(statusCalls[0]?.body).toContain(reviewUrl);
      state.close();
    }
  });

  it("marks older readiness rows stale when a newer PR head is scanned", async () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-scheduler-readiness-superseded-"));
    roots.push(root);
    const config = schedulerConfig(root, ["org/repo-a"]);
    const state = new ReviewStateStore(config.statePath);
    state.recordReviewReadiness({
      repo: "org/repo-a",
      pullNumber: 1,
      headSha: HEAD_A,
      state: "needs_fix",
      reason: "request_changes_review_posted",
      event: "REQUEST_CHANGES",
      reviewUrl: "https://github.com/org/repo-a/pull/1#pullrequestreview-old",
      now: new Date("2026-07-02T00:00:00.000Z")
    });

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
          event: "COMMENT",
          reviewUrl: "https://github.com/org/repo-a/pull/1#pullrequestreview-new"
        });
        return "reviewed";
      },
      now: new Date("2026-07-02T00:05:00.000Z")
    });

    expect(state.getReviewReadiness("org/repo-a", 1, HEAD_A)).toMatchObject({
      state: "stale",
      reason: `superseded_by_head=${HEAD_B}`,
      event: "REQUEST_CHANGES",
      reviewUrl: "https://github.com/org/repo-a/pull/1#pullrequestreview-old"
    });
    expect(state.getReviewReadiness("org/repo-a", 1, HEAD_B)).toMatchObject({
      state: "ready_for_human",
      reason: "comment_review_posted"
    });
    state.close();
  });

  it("marks older readiness rows stale even when the new head is skipped by canary policy", async () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-scheduler-readiness-canary-superseded-"));
    roots.push(root);
    const config = schedulerConfig(root, ["org/repo-a"]);
    config.canaryPulls = ["org/repo-a#99"];
    const state = new ReviewStateStore(config.statePath);
    state.recordReviewReadiness({
      repo: "org/repo-a",
      pullNumber: 1,
      headSha: HEAD_A,
      state: "ready_for_human",
      reason: "comment_review_posted",
      event: "COMMENT",
      reviewUrl: "https://github.com/org/repo-a/pull/1#pullrequestreview-old",
      now: new Date("2026-07-02T00:00:00.000Z")
    });

    const result = await runScheduledCycleWithDeps({
      config,
      github: githubFromMap(new Map([
        ["org/repo-a", [pull("org/repo-a", 1, HEAD_B)]]
      ])),
      state,
      options: { dryRun: false, useZCode: false },
      reviewPullImpl: async () => {
        throw new Error("canary-skipped heads must not run review work");
      },
      now: new Date("2026-07-02T00:05:00.000Z")
    });

    expect(result.skippedCanary).toBe(1);
    expect(state.getReviewReadiness("org/repo-a", 1, HEAD_A)).toMatchObject({
      state: "stale",
      reason: `superseded_by_head=${HEAD_B}`,
      event: "COMMENT",
      reviewUrl: "https://github.com/org/repo-a/pull/1#pullrequestreview-old"
    });
    expect(state.getReviewReadiness("org/repo-a", 1, HEAD_B)).toMatchObject({
      state: "skipped",
      reason: "canary_policy"
    });
    state.close();
  });

  it("repairs non-terminal readiness rows from processed review truth", async () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-scheduler-readiness-backfill-"));
    roots.push(root);
    const config = schedulerConfig(root, ["org/repo-a"]);
    const state = new ReviewStateStore(config.statePath);
    state.recordProcessed({
      repo: "org/repo-a",
      pullNumber: 1,
      headSha: HEAD_A,
      status: "posted",
      event: "REQUEST_CHANGES",
      reviewUrl: "https://github.com/org/repo-a/pull/1#pullrequestreview-existing"
    });
    state.recordReviewReadiness({
      repo: "org/repo-a",
      pullNumber: 1,
      headSha: HEAD_A,
      state: "reviewing",
      reason: "queue_job_running",
      now: new Date("2026-07-02T00:00:00.000Z")
    });

    const result = await runScheduledCycleWithDeps({
      config,
      github: githubFromMap(new Map([
        ["org/repo-a", [pull("org/repo-a", 1, HEAD_A)]]
      ])),
      state,
      options: { dryRun: false, useZCode: false },
      reviewPullImpl: async () => {
        throw new Error("processed heads must not run review work");
      },
      now: new Date("2026-07-02T00:05:00.000Z")
    });

    expect(result.skippedProcessed).toBe(1);
    expect(state.getReviewReadiness("org/repo-a", 1, HEAD_A)).toMatchObject({
      state: "needs_fix",
      reason: "processed_head_already_posted",
      event: "REQUEST_CHANGES",
      reviewUrl: "https://github.com/org/repo-a/pull/1#pullrequestreview-existing",
      updatedAt: "2026-07-02T00:05:00.000Z"
    });
    state.close();
  });

  it("backfills readiness for already-active queue jobs", async () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-scheduler-readiness-active-job-"));
    roots.push(root);
    const config = schedulerConfig(root, ["org/repo-a"]);
    const state = new ReviewStateStore(config.statePath);
    const job = state.enqueueReviewQueueJob({
      repo: "org/repo-a",
      pullNumber: 1,
      headSha: HEAD_A,
      baseSha: "base",
      now: new Date("2026-07-02T00:00:00.000Z")
    }).job;
    state.updateReviewQueueJobState({
      jobId: job.jobId,
      state: "provider_deferred",
      nextEligibleAt: "2026-07-02T00:15:00.000Z",
      lastError: "provider_rate_limit_cooldown_until=2026-07-02T00:15:00.000Z; reason=provider_request_rate_limit",
      now: new Date("2026-07-02T00:00:01.000Z")
    });

    const result = await runScheduledCycleWithDeps({
      config,
      github: githubFromMap(new Map([
        ["org/repo-a", [pull("org/repo-a", 1, HEAD_A)]]
      ])),
      state,
      options: { dryRun: false, useZCode: false },
      reviewPullImpl: async () => {
        throw new Error("active queue jobs must not enqueue duplicate work");
      },
      now: new Date("2026-07-02T00:05:00.000Z")
    });

    expect(result.queue.enqueued).toBe(0);
    expect(state.getReviewReadiness("org/repo-a", 1, HEAD_A)).toMatchObject({
      state: "provider_deferred",
      reason: expect.stringContaining("active_queue_job_provider_deferred")
    });
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
    expect(statusCalls.at(-1)?.body).toContain("temporarily unavailable");
    expect(statusCalls.at(-1)?.body).not.toContain("ProviderBusinessError");
    expect(state.getReviewReadiness("org/repo-a", 1, HEAD_A)).toMatchObject({
      state: "provider_deferred",
      reason: "provider_rate_limit_cooldown"
    });

    await runScheduledCycleWithDeps({
      config,
      github: githubFromMap(new Map([
        ["org/repo-a", [pull("org/repo-a", 1, HEAD_A)]]
      ]), new Map(), statusCalls),
      state,
      options: { dryRun: false, useZCode: true },
      reviewPullImpl: async () => {
        throw new Error("provider-deferred processed heads must not rerun before retry");
      },
      now: new Date("2026-07-02T00:01:00.000Z")
    });
    expect(state.getReviewReadiness("org/repo-a", 1, HEAD_A)).toMatchObject({
      state: "provider_deferred"
    });
    state.close();
  });

  it("records scheduled provider cooldowns from failure handling time", async () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-scheduler-provider-cooldown-completion-time-"));
    roots.push(root);
    const config = schedulerConfig(root, ["org/repo-a"]);
    const state = new ReviewStateStore(config.statePath);

    const result = await runScheduledCycleWithDeps({
      config,
      github: githubFromMap(new Map([
        ["org/repo-a", [pull("org/repo-a", 1, HEAD_A)]]
      ])),
      state,
      options: { dryRun: false, useZCode: true },
      reviewPullImpl: async () => {
        throw new Error("ProviderBusinessError: [1302][Rate limit reached for requests]");
      },
      now: new Date("2026-07-02T00:00:00.000Z"),
      clock: () => new Date("2026-07-02T00:03:00.000Z")
    });

    expect(result.skippedProviderCooldown).toBe(1);
    expect(state.listReviewQueueJobs({ state: "provider_deferred" })).toEqual([
      expect.objectContaining({
        repo: "org/repo-a",
        pullNumber: 1,
        nextEligibleAt: "2026-07-02T00:04:30.000Z",
        lastError: expect.stringContaining("provider_rate_limit_cooldown_until=2026-07-02T00:04:30.000Z")
      })
    ]);
    expect(state.getProcessedReview("org/repo-a", 1, HEAD_A)).toMatchObject({
      status: "skipped",
      error: expect.stringContaining("provider_rate_limit_cooldown_until=2026-07-02T00:04:30.000Z")
    });
    state.close();
  });

  it("stops provider leasing after an overload without starting unstarted provider jobs", async () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-scheduler-provider-overload-stop-"));
    roots.push(root);
    const config = schedulerConfig(root, []);
    config.reviewScheduler!.maxProviderActive = 2;
    config.reviewScheduler!.maxOrgActive = 2;
    config.reviewScheduler!.maxRepoActive = 1;
    const state = new ReviewStateStore(config.statePath);
    const first = state.enqueueReviewQueueJob({
      repo: "org/repo-a",
      pullNumber: 1,
      headSha: HEAD_A,
      baseSha: "base",
      priority: 10,
      providerId: "zai-coding-plan",
      now: new Date("2026-07-02T00:00:00.000Z")
    }).job;
    const second = state.enqueueReviewQueueJob({
      repo: "org/repo-b",
      pullNumber: 2,
      headSha: HEAD_B,
      baseSha: "base",
      priority: 50,
      providerId: "zai-coding-plan",
      now: new Date("2026-07-02T00:00:01.000Z")
    }).job;
    const manual = state.enqueueReviewQueueJob({
      repo: "org/repo-c",
      pullNumber: 3,
      headSha: HEAD_C,
      baseSha: "base",
      source: "manual_command",
      priority: 99,
      providerId: "zai-coding-plan",
      commentId: 123,
      now: new Date("2026-07-02T00:00:02.000Z")
    }).job;
    const attempted: string[] = [];

    const result = await runScheduledCycleWithDeps({
      config,
      github: githubFromMap(new Map([
        ["org/repo-a", [pull("org/repo-a", 1, HEAD_A)]],
        ["org/repo-b", [pull("org/repo-b", 2, HEAD_B)]],
        ["org/repo-c", [pull("org/repo-c", 3, HEAD_C)]]
      ])),
      state,
      options: { dryRun: false, useZCode: true },
      reviewPullImpl: async ({ repo }) => {
        attempted.push(repo);
        throw new Error("ProviderBusinessError: [1305][The service may be temporarily overloaded]");
      },
      now: new Date("2026-07-02T00:05:00.000Z")
    });

    expect(attempted).toEqual(["org/repo-a"]);
    expect(result.skippedProviderCooldown).toBe(1);
    expect(result.queue.providerDeferred).toBe(2);
    expect(state.getReviewQueueJob(first.jobId)).toMatchObject({
      state: "provider_deferred",
      nextEligibleAt: "2026-07-02T00:07:00.000Z",
      lastError: expect.stringContaining("reason=provider_overloaded")
    });
    const secondAfterOverload = state.getReviewQueueJob(second.jobId);
    expect(secondAfterOverload).toMatchObject({
      state: "provider_deferred",
      nextEligibleAt: "2026-07-02T00:07:00.000Z",
      lastError: expect.stringContaining("provider_throttle_cycle_deferred_until=2026-07-02T00:07:00.000Z")
    });
    expect(secondAfterOverload?.startedAt).toBeUndefined();
    expect(state.getReviewQueueJob(manual.jobId)).toMatchObject({ state: "queued" });
    state.close();
  });

  it("prioritizes self-repo release PR heads ahead of ordinary background queue work", async () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-scheduler-self-repo-priority-"));
    roots.push(root);
    const config = schedulerConfig(root, ["org/repo-a", SELF_REPO_CURRENT]);
    config.reviewScheduler!.maxProviderActive = 1;
    const state = new ReviewStateStore(config.statePath);
    const reviewed: string[] = [];

    const result = await runScheduledCycleWithDeps({
      config,
      github: githubFromMap(new Map([
        ["org/repo-a", [pull("org/repo-a", 1, HEAD_A)]],
        [SELF_REPO_CURRENT, [pull(SELF_REPO_CURRENT, 165, HEAD_B)]]
      ])),
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
      now: new Date("2026-07-02T00:00:00.000Z")
    });

    expect(result.queue.enqueued).toBe(2);
    expect(result.reviewed).toBe(1);
    expect(reviewed).toEqual([`${SELF_REPO_CURRENT}#165`]);
    expect(state.listReviewQueueJobs({ repo: SELF_REPO_CURRENT })).toEqual([
      expect.objectContaining({ pullNumber: 165, priority: 1, lastError: "reviewed" })
    ]);
    expect(state.listReviewQueueJobs({ repo: "org/repo-a", state: "queued" })).toEqual([
      expect.objectContaining({ pullNumber: 1, priority: 50 })
    ]);
    state.close();
  });

  it("pins priority-1 scheduling for both self-repo identities", async () => {
    for (const selfRepo of [SELF_REPO_CURRENT, SELF_REPO_LEGACY]) {
      const root = mkdtempSync(join(tmpdir(), "evaos-scheduler-self-repo-identity-"));
      roots.push(root);
      const config = schedulerConfig(root, ["org/repo-a", selfRepo]);
      config.reviewScheduler!.maxProviderActive = 1;
      const state = new ReviewStateStore(config.statePath);
      const reviewed: string[] = [];

      const result = await runScheduledCycleWithDeps({
        config,
        github: githubFromMap(new Map([
          ["org/repo-a", [pull("org/repo-a", 1, HEAD_A)]],
          [selfRepo, [pull(selfRepo, 165, HEAD_B)]]
        ])),
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
        now: new Date("2026-07-02T00:00:00.000Z")
      });

      expect(result.reviewed).toBe(1);
      expect(reviewed).toEqual([`${selfRepo}#165`]);
      expect(state.listReviewQueueJobs({ repo: selfRepo })).toEqual([
        expect.objectContaining({ pullNumber: 165, priority: 1, lastError: "reviewed" })
      ]);
      state.close();
    }
  });

  it("reprioritizes existing queued self-repo jobs before ordinary backlog", async () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-scheduler-self-repo-existing-priority-"));
    roots.push(root);
    const config = schedulerConfig(root, ["org/repo-a", SELF_REPO_CURRENT]);
    config.reviewScheduler!.maxProviderActive = 1;
    config.reviewScheduler!.maxOrgActive = 1;
    config.reviewScheduler!.manualCommandReserve = 0;
    const state = new ReviewStateStore(config.statePath);
    const selfRepoJob = state.enqueueReviewQueueJob({
      repo: SELF_REPO_CURRENT,
      pullNumber: 172,
      headSha: HEAD_A,
      baseSha: "base",
      providerId: "zai-coding-plan",
      priority: 50,
      now: new Date("2026-07-03T00:00:00.000Z")
    }).job;
    const ordinaryJob = state.enqueueReviewQueueJob({
      repo: "org/repo-a",
      pullNumber: 1,
      headSha: HEAD_B,
      baseSha: "base",
      providerId: "zai-coding-plan",
      priority: 10,
      now: new Date("2026-07-03T00:00:01.000Z")
    }).job;
    const reviewed: string[] = [];

    const result = await runScheduledCycleWithDeps({
      config,
      github: githubFromMap(new Map([
        ["org/repo-a", [pull("org/repo-a", 1, HEAD_B)]],
        [SELF_REPO_CURRENT, [
          pull(SELF_REPO_CURRENT, 172, HEAD_A, "base", { state: "closed", mergedAt: "2026-07-03T00:00:30Z" })
        ]]
      ])),
      state,
      options: { dryRun: false, useZCode: false },
      reviewPullImpl: async ({ repo, pull: reviewPull }) => {
        reviewed.push(`${repo}#${reviewPull.number}`);
        return "reviewed";
      },
      now: new Date("2026-07-03T00:01:00.000Z")
    });

    expect(result.queue.leased).toBe(1);
    expect(result.queue.closedRetired).toBe(1);
    expect(reviewed).toEqual([]);
    expect(state.getReviewQueueJob(selfRepoJob.jobId)).toMatchObject({
      priority: 1,
      state: "closed_retired",
      lastError: "closed_or_merged_before_review state=closed"
    });
    expect(state.getReviewQueueJob(ordinaryJob.jobId)).toMatchObject({
      priority: 10,
      state: "queued"
    });
    state.close();
  });

  it("retires self-repo provider-deferred jobs when the PR closes before retry", async () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-scheduler-self-repo-provider-deferred-closed-"));
    roots.push(root);
    const config = schedulerConfig(root, []);
    const state = new ReviewStateStore(config.statePath);
    const job = state.enqueueReviewQueueJob({
      repo: "electricsheephq/evaos-code-review-bot",
      pullNumber: 165,
      headSha: HEAD_A,
      baseSha: "base",
      priority: 1,
      providerId: "zai-coding-plan",
      now: new Date("2026-07-02T00:00:00.000Z")
    }).job;
    state.updateReviewQueueJobState({
      jobId: job.jobId,
      state: "provider_deferred",
      nextEligibleAt: "2026-07-02T00:04:00.000Z",
      lastError: "provider_rate_limit_cooldown_until=2026-07-02T00:04:00.000Z; reason=provider_overloaded",
      now: new Date("2026-07-02T00:00:01.000Z")
    });

    const result = await runScheduledCycleWithDeps({
      config,
      github: githubFromMap(new Map([
        ["electricsheephq/evaos-code-review-bot", [
          pull("electricsheephq/evaos-code-review-bot", 165, HEAD_A, "base", { state: "closed", mergedAt: "2026-07-02T00:03:00Z" })
        ]]
      ])),
      state,
      options: { dryRun: false, useZCode: true },
      reviewPullImpl: async () => {
        throw new Error("closed provider-deferred self-repo PR must not run review work");
      },
      now: new Date("2026-07-02T00:05:00.000Z")
    });

    expect(result.queue.closedRetired).toBe(1);
    expect(state.getReviewQueueJob(job.jobId)).toMatchObject({
      state: "closed_retired",
      lastError: "closed_or_merged_before_review state=closed"
    });
    expect(state.getReviewReadiness("electricsheephq/evaos-code-review-bot", 165, HEAD_A)).toMatchObject({
      state: "closed",
      reason: "closed_or_merged_before_review state=closed"
    });
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
    expect(state.getReviewReadiness("org/repo-a", 1, HEAD_A)).toMatchObject({
      state: "failed",
      reason: expect.stringContaining("github_refetch_failed: GitHub API fetch failed")
    });
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

  it("persists terminal queue state before posting stale or closed sticky status comments", async () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-scheduler-status-retire-ordering-"));
    roots.push(root);
    const config = schedulerConfig(root, []);
    config.reviewStatusComment!.enabled = true;
    const state = new ReviewStateStore(config.statePath);
    const staleJob = state.enqueueReviewQueueJob({ repo: "org/repo-a", pullNumber: 1, headSha: HEAD_A, baseSha: "base" }).job;
    const closedJob = state.enqueueReviewQueueJob({ repo: "org/repo-b", pullNumber: 2, headSha: HEAD_F, baseSha: "base" }).job;
    const observedStates = new Map<string, string | undefined>();
    const statusCalls: StatusCommentCall[] = [];
    const baseGithub = githubFromMap(new Map([
      ["org/repo-a", [pull("org/repo-a", 1, HEAD_D)]],
      ["org/repo-b", [pull("org/repo-b", 2, HEAD_F, "base", { state: "closed" })]]
    ]), new Map(), statusCalls);

    await runScheduledCycleWithDeps({
      config,
      github: {
        ...baseGithub,
        upsertIssueComment: async (input) => {
          statusCalls.push(input);
          const status = statusFromBody(input);
          if (status === "stale_head") {
            observedStates.set(status, state.getReviewQueueJob(staleJob.jobId)?.state);
          }
          if (status === "closed_or_merged_before_review") {
            observedStates.set(status, state.getReviewQueueJob(closedJob.jobId)?.state);
          }
          return { action: statusCalls.filter((call) => call.marker === input.marker).length === 1 ? "created" : "updated", id: statusCalls.length };
        }
      },
      state,
      options: { dryRun: false, useZCode: false },
      reviewPullImpl: async () => {
        throw new Error("should not review retired jobs");
      },
      now: new Date("2026-07-02T00:00:00.000Z")
    });

    expect(observedStates.get("stale_head")).toBe("stale_retired");
    expect(observedStates.get("closed_or_merged_before_review")).toBe("closed_retired");
    expect(statusCalls.map(statusFromBody).sort()).toEqual(["closed_or_merged_before_review", "stale_head"]);
    state.close();
  });

  it("settles RepoSticky session jobs when scan-time retirement supersedes or closes queued jobs", async () => {
    const scenarios = [
      { name: "superseded", pull: pull("org/repo-a", 1, HEAD_B), expectedQueueState: "stale_retired" },
      { name: "closed", pull: pull("org/repo-a", 1, HEAD_A, "base", { state: "closed" }), expectedQueueState: "closed_retired" }
    ] as const;

    for (const scenario of scenarios) {
      const root = mkdtempSync(join(tmpdir(), `evaos-scheduler-session-retire-${scenario.name}-`));
      roots.push(root);
      const config = schedulerConfig(root, ["org/repo-a"]);
      config.reviewerSessions = {
        enabled: true,
        ttlMs: 8 * 60 * 60_000,
        headCountLimit: 10
      };
      const state = new ReviewStateStore(config.statePath);
      const assignment = state.assignReviewerSessionJob({
        repo: "org/repo-a",
        pullNumber: 1,
        headSha: HEAD_A,
        ttlMs: config.reviewerSessions.ttlMs,
        headCountLimit: config.reviewerSessions.headCountLimit,
        now: new Date("2026-07-02T00:00:00.000Z")
      });
      if (!assignment.assigned) throw new Error("expected test session assignment");
      const job = state.enqueueReviewQueueJob({
        repo: "org/repo-a",
        pullNumber: 1,
        headSha: HEAD_A,
        baseSha: "base",
        sessionId: assignment.session.sessionId
      }).job;

      await runScheduledCycleWithDeps({
        config,
        github: githubFromMap(new Map([["org/repo-a", [scenario.pull]]])),
        state,
        options: scenario.name === "closed"
          ? { repo: "org/repo-a", pullNumber: 1, dryRun: false, useZCode: false }
          : { dryRun: false, useZCode: false },
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
        now: new Date("2026-07-02T00:01:00.000Z")
      });

      expect(state.getReviewQueueJob(job.jobId)).toMatchObject({ state: scenario.expectedQueueState });
      expect(state.getReviewerSessionJob("org/repo-a", 1, HEAD_A)).toMatchObject({
        jobState: "skipped",
        processedReviewStatus: "skipped"
      });
      state.close();
    }
  });

  it("maps duplicate processed-head status comments from the stored processed outcome", async () => {
    const cooldownError = "provider_rate_limit_cooldown_until=2026-07-02T00:10:00.000Z; reason=provider_overloaded";
    const scenarios = [
      { processedStatus: "posted", expectedStatus: "completed", expectedQueueState: "posted" },
      { processedStatus: "dry_run", expectedStatus: "completed", expectedQueueState: "queued" },
      { processedStatus: "failed", expectedStatus: "failed", expectedQueueState: "failed" },
      { processedStatus: "skipped", expectedStatus: "skipped", expectedQueueState: "stale_retired" },
      {
        processedStatus: "skipped",
        error: cooldownError,
        expectedStatus: "provider_deferred",
        expectedQueueState: "provider_deferred",
        expectedLastError: cooldownError
      },
      {
        processedStatus: undefined,
        expectedStatus: "queued",
        expectedQueueState: "queued",
        expectedLastError: "processed_head_already_unknown"
      }
    ] as const;

    for (const [index, scenario] of scenarios.entries()) {
      const root = mkdtempSync(join(tmpdir(), `evaos-scheduler-status-processed-${scenario.processedStatus}-${index}-`));
      roots.push(root);
      const config = schedulerConfig(root, ["org/repo-a"]);
      config.reviewStatusComment!.enabled = true;
      const state = new ReviewStateStore(config.statePath);
      if (scenario.processedStatus) {
        state.recordProcessed({
          repo: "org/repo-a",
          pullNumber: 1,
          headSha: HEAD_A,
          status: scenario.processedStatus,
          ...("error" in scenario ? { error: scenario.error } : {}),
          ...(scenario.processedStatus === "posted"
            ? { event: "COMMENT" as const, reviewUrl: "https://github.com/org/repo-a/pull/1#pullrequestreview-existing" }
            : {})
        });
      }
      const job = state.enqueueReviewQueueJob({ repo: "org/repo-a", pullNumber: 1, headSha: HEAD_A, baseSha: "base" }).job;
      const statusCalls: StatusCommentCall[] = [];

      await runScheduledCycleWithDeps({
        config,
        github: githubFromMap(new Map([
          ["org/repo-a", [pull("org/repo-a", 1, HEAD_A)]]
        ]), new Map(), statusCalls),
        state,
        options: { dryRun: false, useZCode: false },
        reviewPullImpl: async () => "skipped_processed",
        now: new Date("2026-07-02T00:00:00.000Z")
      });

      expect(statusCalls.map(statusFromBody)).toEqual(["in_progress", scenario.expectedStatus]);
      expect(state.getReviewQueueJob(job.jobId)).toMatchObject({
        state: scenario.expectedQueueState,
        lastError: "expectedLastError" in scenario ? scenario.expectedLastError : `processed_head_already_${scenario.processedStatus}`
      });
      if (scenario.processedStatus === "posted") {
        expect(statusCalls.at(-1)?.body).toContain("https://github.com/org/repo-a/pull/1#pullrequestreview-existing");
      }
      state.close();
    }
  });

  it("keeps RepoSticky session jobs assigned when processed-head status is missing", async () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-scheduler-status-processed-missing-session-"));
    roots.push(root);
    const config = schedulerConfig(root, ["org/repo-a"]);
    config.reviewStatusComment!.enabled = true;
    config.reviewerSessions = {
      enabled: true,
      ttlMs: 8 * 60 * 60_000,
      headCountLimit: 10
    };
    const state = new ReviewStateStore(config.statePath);
    const assignment = state.assignReviewerSessionJob({
      repo: "org/repo-a",
      pullNumber: 1,
      headSha: HEAD_A,
      ttlMs: 8 * 60 * 60_000,
      headCountLimit: 10,
      allowProcessed: true,
      now: new Date("2026-07-02T00:00:00.000Z")
    });
    if (!assignment.session) throw new Error("expected session assignment");
    const job = state.enqueueReviewQueueJob({
      repo: "org/repo-a",
      pullNumber: 1,
      headSha: HEAD_A,
      baseSha: "base",
      sessionId: assignment.session.sessionId
    }).job;
    const statusCalls: StatusCommentCall[] = [];

    await runScheduledCycleWithDeps({
      config,
      github: githubFromMap(new Map([
        ["org/repo-a", [pull("org/repo-a", 1, HEAD_A)]]
      ]), new Map(), statusCalls),
      state,
      options: { dryRun: false, useZCode: false },
      reviewPullImpl: async () => "skipped_processed",
      now: new Date("2026-07-02T00:01:00.000Z")
    });

    expect(statusCalls.map(statusFromBody)).toEqual(["in_progress", "queued"]);
    expect(state.getReviewQueueJob(job.jobId)).toMatchObject({
      state: "queued",
      lastError: "processed_head_already_unknown"
    });
    const sessionJob = state.getReviewerSessionJob("org/repo-a", 1, HEAD_A);
    expect(sessionJob).toMatchObject({ jobState: "assigned" });
    expect(sessionJob?.processedReviewStatus).toBeUndefined();
    state.close();
  });

  it("reconciles historical failed queue rows for already-skipped processed heads", async () => {
    const cooldownError = "provider_rate_limit_cooldown_until=2026-07-02T00:10:00.000Z; reason=provider_overloaded";
    const scenarios = [
      {
        name: "ordinary-skip",
        headSha: HEAD_A,
        expectedState: "stale_retired",
        expectedLastError: "processed_head_already_skipped_reconciled"
      },
      {
        name: "provider-cooldown",
        headSha: HEAD_B,
        error: cooldownError,
        expectedState: "provider_deferred",
        expectedLastError: cooldownError
      }
    ] as const;

    for (const scenario of scenarios) {
      const root = mkdtempSync(join(tmpdir(), `evaos-scheduler-reconcile-processed-skip-${scenario.name}-`));
      roots.push(root);
      const config = schedulerConfig(root, ["org/repo-a"]);
      const state = new ReviewStateStore(config.statePath);
      state.recordProcessed({
        repo: "org/repo-a",
        pullNumber: 1,
        headSha: scenario.headSha,
        status: "skipped",
        ...("error" in scenario ? { error: scenario.error } : {})
      });
      const job = state.enqueueReviewQueueJob({
        repo: "org/repo-a",
        pullNumber: 1,
        headSha: scenario.headSha,
        baseSha: "base"
      }).job;
      state.updateReviewQueueJobState({
        jobId: job.jobId,
        state: "failed",
        lastError: "processed_head_already_skipped",
        now: new Date("2026-07-02T00:00:00.000Z")
      });

      const result = await runScheduledCycleWithDeps({
        config,
        github: githubFromMap(new Map([
          ["org/repo-a", [pull("org/repo-a", 1, scenario.headSha)]]
        ])),
        state,
        options: { dryRun: false, useZCode: false },
        reviewPullImpl: async () => {
          throw new Error("reconciled historical failed rows should not call reviewPull");
        },
        now: new Date("2026-07-02T00:01:00.000Z")
      });

      expect(state.getReviewQueueJob(job.jobId)).toMatchObject({
        state: scenario.expectedState,
        lastError: scenario.expectedLastError
      });
      if (scenario.expectedState === "provider_deferred") {
        expect(result.queue.providerDeferred).toBe(1);
      } else {
        expect(result.queue.staleRetired).toBe(1);
      }
      state.close();
    }
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
    expect(state.getReviewReadiness("org/repo-a", 1, HEAD_A)).toMatchObject({
      state: "closed",
      reason: "closed_or_merged_before_review state=closed"
    });
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
    expect(state.getReviewReadiness("org/repo-a", 1, HEAD_A)).toMatchObject({
      state: "ready_for_human",
      reason: "comment_review_posted",
      event: "COMMENT"
    });
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

  it("keeps a failed terminal status from being resurrected after in-progress posted", async () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-scheduler-status-failed-rerun-"));
    roots.push(root);
    const config = schedulerConfig(root, ["org/repo-a"]);
    config.reviewStatusComment!.enabled = true;
    const state = new ReviewStateStore(config.statePath);
    const statusCalls: StatusCommentCall[] = [];
    const github = githubFromMap(new Map([
      ["org/repo-a", [pull("org/repo-a", 1, HEAD_A)]]
    ]), new Map(), statusCalls);

    const first = await runScheduledCycleWithDeps({
      config,
      github,
      state,
      options: { dryRun: false, useZCode: false },
      reviewPullImpl: async () => {
        throw new Error("synthetic review failure after in-progress status");
      },
      now: new Date("2026-07-02T00:00:00.000Z")
    });

    expect(first.failed).toBe(1);
    expect(statusCalls.map(statusFromBody)).toEqual(["queued", "in_progress", "failed"]);
    expect(state.listReviewQueueJobs({ state: "failed" })).toEqual([
      expect.objectContaining({ lastError: "synthetic review failure after in-progress status" })
    ]);
    expect(state.getReviewReadiness("org/repo-a", 1, HEAD_A)).toMatchObject({
      state: "failed",
      reason: "review_failed: synthetic review failure after in-progress status"
    });

    const second = await runScheduledCycleWithDeps({
      config,
      github,
      state,
      options: { dryRun: false, useZCode: false },
      reviewPullImpl: async () => {
        throw new Error("processed failed heads must not rerun automatically");
      },
      now: new Date("2026-07-02T00:01:00.000Z")
    });

    expect(second.skippedProcessed).toBe(1);
    expect(statusCalls.map(statusFromBody)).toEqual(["queued", "in_progress", "failed"]);
    state.close();
  });

  it("sets terminal skipped status when a queued job becomes policy-skipped after in-progress", async () => {
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
    expect(statusCalls.map(statusFromBody)).toEqual(["queued", "in_progress", "skipped"]);
    expect(state.listReviewQueueJobs({ state: "failed" })).toHaveLength(1);
    expect(state.getReviewReadiness("org/repo-a", 1, HEAD_A)).toMatchObject({
      state: "failed",
      reason: "unexpected_scheduler_review_status=skipped_policy"
    });
    state.close();
  });

  it("retires a queued job as skipped, not failed, when it becomes draft after in-progress", async () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-scheduler-status-draft-skip-"));
    roots.push(root);
    const config = schedulerConfig(root, ["org/repo-a"]);
    config.reviewStatusComment!.enabled = true;
    const state = new ReviewStateStore(config.statePath);
    const statusCalls: StatusCommentCall[] = [];
    let listedPull = pull("org/repo-a", 1, HEAD_A);
    let refetchedPull = pull("org/repo-a", 1, HEAD_A, "base", { draft: true });
    const github: SchedulerGitHubApi = {
      ...githubFromMap(new Map(), new Map(), statusCalls),
      listOpenPulls: async () => [listedPull],
      getPull: async () => refetchedPull
    };

    const first = await runScheduledCycleWithDeps({
      config,
      github,
      state,
      options: { dryRun: false, useZCode: false },
      reviewPullImpl: async ({ pull: reviewPull }) => reviewPull.draft ? "skipped_draft" : "reviewed",
      now: new Date("2026-07-02T00:00:00.000Z")
    });

    expect(first.skippedDraft).toBe(1);
    expect(statusCalls.map(statusFromBody)).toEqual(["queued", "in_progress", "skipped"]);
    expect(state.listReviewQueueJobs({ state: "failed" })).toHaveLength(0);
    expect(state.listReviewQueueJobs({ state: "stale_retired" })).toEqual([
      expect.objectContaining({ repo: "org/repo-a", pullNumber: 1, headSha: HEAD_A, lastError: "draft_pr" })
    ]);
    expect(state.getProcessedReview("org/repo-a", 1, HEAD_A)).toBeUndefined();
    expect(state.getReviewReadiness("org/repo-a", 1, HEAD_A)).toMatchObject({
      state: "skipped",
      reason: "draft_pr"
    });

    listedPull = pull("org/repo-a", 1, HEAD_A, "base", { draft: true });
    refetchedPull = listedPull;
    const stillDraft = await runScheduledCycleWithDeps({
      config,
      github,
      state,
      options: { dryRun: false, useZCode: false },
      reviewPullImpl: async () => {
        throw new Error("draft pull should skip before review work");
      },
      now: new Date("2026-07-02T00:00:30.000Z")
    });

    expect(stillDraft.skippedDraft).toBe(1);
    expect(stillDraft.queue.enqueued).toBe(0);
    expect(stillDraft.reviewed).toBe(0);
    expect(statusCalls.map(statusFromBody)).toEqual(["queued", "in_progress", "skipped"]);
    expect(state.listReviewQueueJobs({ state: "failed" })).toHaveLength(0);

    listedPull = pull("org/repo-a", 1, HEAD_A);
    refetchedPull = listedPull;
    const second = await runScheduledCycleWithDeps({
      config,
      github,
      state,
      options: { dryRun: false, useZCode: false },
      reviewPullImpl: async ({ state: reviewState, repo, pull: reviewPull }) => {
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
      now: new Date("2026-07-02T00:01:00.000Z")
    });

    expect(second.queue.enqueued).toBe(1);
    expect(second.reviewed).toBe(1);
    expect(state.listReviewQueueJobs({ state: "posted" })).toEqual([
      expect.objectContaining({ repo: "org/repo-a", pullNumber: 1, headSha: HEAD_A })
    ]);
    expect(state.getReviewReadiness("org/repo-a", 1, HEAD_A)).toMatchObject({
      state: "ready_for_human",
      reason: "comment_review_posted"
    });
    state.close();
  });

  it("sets blocked proof readiness when a queued job becomes license-skipped after in-progress", async () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-scheduler-status-license-skip-"));
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
      reviewPullImpl: async () => "skipped_license_gate",
      now: new Date("2026-07-02T00:00:00.000Z")
    });

    expect(result.skippedPolicy).toBe(1);
    expect(statusCalls.map(statusFromBody)).toEqual(["queued", "in_progress", "skipped"]);
    expect(state.listReviewQueueJobs({ state: "blocked_on_proof" })).toHaveLength(1);
    expect(state.listReviewQueueJobs({ state: "blocked_on_proof" })[0]).toMatchObject({
      nextEligibleAt: "2026-07-02T00:15:00.000Z"
    });
    expect(state.getReviewReadiness("org/repo-a", 1, HEAD_A)).toMatchObject({
      state: "blocked_on_proof",
      reason: "license_entitlement_required"
    });
    state.close();
  });

  it("moves in-progress status to provider_deferred when legacy capacity is busy", async () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-scheduler-status-capacity-"));
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
      reviewPullImpl: async () => "skipped_capacity",
      now: new Date("2026-07-02T00:00:00.000Z")
    });

    expect(result.skippedCapacity).toBe(1);
    expect(statusCalls.map(statusFromBody)).toEqual(["queued", "in_progress", "provider_deferred"]);
    expect(state.listReviewQueueJobs({ state: "queued" })).toEqual([
      expect.objectContaining({ lastError: "legacy_review_capacity_busy" })
    ]);
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

  it("retires an expired running closed job without failing the queue", async () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-scheduler-expired-running-closed-"));
    roots.push(root);
    const config = schedulerConfig(root, []);
    config.reviewStatusComment!.enabled = true;
    const state = new ReviewStateStore(config.statePath);
    const job = state.enqueueReviewQueueJob({
      repo: "org/repo-a",
      pullNumber: 1,
      headSha: HEAD_A,
      baseSha: "base"
    }).job;
    state.updateReviewQueueJobState({
      jobId: job.jobId,
      state: "running",
      leaseId: "expired-running-lease",
      leaseExpiresAt: "2026-07-02T00:00:00.000Z",
      clearLease: false,
      now: new Date("2026-07-01T23:58:00.000Z")
    });
    const statusCalls: StatusCommentCall[] = [];

    const result = await runScheduledCycleWithDeps({
      config,
      github: githubFromMap(new Map([
        ["org/repo-a", [pull("org/repo-a", 1, HEAD_A, "base", { state: "closed", mergedAt: "2026-07-02T00:00:30Z" })]]
      ]), new Map(), statusCalls),
      state,
      options: { dryRun: false, useZCode: false },
      reviewPullImpl: async () => {
        throw new Error("expired closed active jobs must not run review work");
      },
      now: new Date("2026-07-02T00:01:00.000Z")
    });

    expect(result.queue.closedRetired).toBe(1);
    expect(result.queue.failedQueueJobs).toBe(0);
    expect(statusCalls.map(statusFromBody)).toEqual(["closed_or_merged_before_review"]);
    expect(state.getReviewQueueJob(job.jobId)).toMatchObject({
      state: "closed_retired",
      lastError: "closed_or_merged_before_review state=closed"
    });
    expect(state.listReviewQueueJobs({ state: "failed" })).toHaveLength(0);
    state.close();
  });

  it("records provider throttle and stops leasing more provider jobs", async () => {
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

    expect(result.reviewed).toBe(0);
    expect(result.skippedProviderCooldown).toBe(1);
    expect(result.queue.providerDeferred).toBe(3);
    expect(state.getActiveRepoProviderCooldown("org/repo-a", new Date("2026-07-01T00:00:01.000Z"))).toBeDefined();
    expect(state.getActiveRepoProviderCooldown("org/repo-b", new Date("2026-07-01T00:00:01.000Z"))).toBeUndefined();
    expect(state.listReviewQueueJobs({ state: "provider_deferred" })).toEqual([
      expect.objectContaining({ repo: "org/repo-a", pullNumber: 1, nextEligibleAt: "2026-07-01T00:01:30.000Z" }),
      expect.objectContaining({
        repo: "org/repo-b",
        pullNumber: 1,
        nextEligibleAt: "2026-07-01T00:01:30.000Z",
        lastError: expect.stringContaining("provider_throttle_cycle_deferred_until=2026-07-01T00:01:30.000Z")
      }),
      expect.objectContaining({
        repo: "org/repo-c",
        pullNumber: 1,
        nextEligibleAt: "2026-07-01T00:01:30.000Z",
        lastError: expect.stringContaining("trigger_repo=org/repo-a")
      })
    ]);
    expect(state.listReviewQueueJobs({ state: "queued" })).toEqual([]);
    expect(state.listReviewQueueJobs({ state: "provider_deferred" })
      .filter((job) => job.repo !== "org/repo-a")
      .every((job) => job.startedAt === undefined)).toBe(true);
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

  it("retries blocked_on_proof queue jobs after entitlement activation", async () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-scheduler-blocked-proof-retry-"));
    roots.push(root);
    const config = schedulerConfig(root, ["org/repo-a"]);
    config.reviewStatusComment!.enabled = true;
    const state = new ReviewStateStore(config.statePath);
    const statusCalls: StatusCommentCall[] = [];
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
      state: "blocked_on_proof",
      lastError: "license_entitlement_required",
      nextEligibleAt: "2026-07-01T00:00:30.000Z",
      now: new Date("2026-07-01T00:00:01.000Z")
    });
    const policies: Array<ReviewPullInput["processedHeadPolicy"]> = [];

    const result = await runScheduledCycleWithDeps({
      config,
      github: githubFromMap(new Map([
        ["org/repo-a", [pull("org/repo-a", 1, "a1")]]
      ]), new Map(), statusCalls),
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
          reviewUrl: `https://github.com/${repo}/pull/${reviewPull.number}#pullrequestreview-blocked-proof-retry`
        });
        return "reviewed";
      },
      now: new Date("2026-07-01T00:01:00.000Z")
    });

    expect(result.reviewed).toBe(1);
    expect(policies).toEqual(["normal"]);
    expect(statusCalls.map(statusFromBody)).not.toContain("in_progress");
    expect(state.getReviewQueueJob(job.jobId)).toMatchObject({
      state: "posted",
      reviewUrl: "https://github.com/org/repo-a/pull/1#pullrequestreview-blocked-proof-retry"
    });
    state.close();
  });

  it("does not retry blocked_on_proof queue jobs before their proof cooldown expires", async () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-scheduler-blocked-proof-cooldown-"));
    roots.push(root);
    const config = schedulerConfig(root, ["org/repo-a"]);
    const state = new ReviewStateStore(config.statePath);
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
      state: "blocked_on_proof",
      lastError: "license_entitlement_required",
      nextEligibleAt: "2026-07-01T00:15:00.000Z",
      now: new Date("2026-07-01T00:00:01.000Z")
    });

    const result = await runScheduledCycleWithDeps({
      config,
      github: githubFromMap(new Map([
        ["org/repo-a", [pull("org/repo-a", 1, "a1")]]
      ])),
      state,
      options: { dryRun: false, useZCode: false },
      reviewPullImpl: async () => {
        throw new Error("blocked_on_proof cooldown must not call reviewPull");
      },
      now: new Date("2026-07-01T00:01:00.000Z")
    });

    expect(result.reviewed).toBe(0);
    expect(result.queue.leased).toBe(0);
    expect(result.queue.remainingQueued).toBe(1);
    expect(result.queue.delayedByReason).toMatchObject({ proof_cooldown: 1 });
    expect(state.getReviewQueueJob(job.jobId)).toMatchObject({
      state: "blocked_on_proof",
      nextEligibleAt: "2026-07-01T00:15:00.000Z"
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
    config.reviewStatusComment!.enabled = true;
    const state = new ReviewStateStore(config.statePath);
    state.recordProcessed({
      repo: "org/repo-a",
      pullNumber: 1,
      headSha: HEAD_A,
      status: "posted",
      event: "COMMENT",
      reviewUrl: "https://github.com/org/repo-a/pull/1#pullrequestreview-old"
    });
    const pullMap = new Map([["org/repo-a", [pull("org/repo-a", 1, HEAD_A)]]]);
    const comments = new Map([
      ["org/repo-a#1", [comment(222, "100yenadmin", "@evaos-code-review-bot re-review")]]
    ]);
    const statusCalls: StatusCommentCall[] = [];
    const readinessObservedDuringCommandReview: string[] = [];

    const result = await runScheduledCycleWithDeps({
      config,
      github: githubFromMap(pullMap, comments, statusCalls),
      state,
      options: { dryRun: false, useZCode: false },
      reviewPullImpl: async ({ state: reviewState, repo, pull: reviewPull }) => {
        const readiness = reviewState.getReviewReadiness(repo, reviewPull.number, reviewPull.head.sha);
        readinessObservedDuringCommandReview.push(`${readiness?.state ?? "missing"}:${readiness?.reason ?? "missing"}`);
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
    expect(readinessObservedDuringCommandReview).toEqual(["reviewing:queue_job_running"]);
    expect(statusCalls.map(statusFromBody)).toEqual(["queued", "completed"]);
    expect(state.getReviewReadiness("org/repo-a", 1, HEAD_A)).toMatchObject({
      state: "ready_for_human",
      reason: "comment_review_posted",
      commandAction: "re-review",
      commandCommentId: 222
    });
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

  it("does not fetch commands for activation-baselined existing heads", async () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-scheduler-command-baseline-skip-"));
    roots.push(root);
    const config = schedulerConfig(root, ["org/repo-a"]);
    config.activation.reviewExistingOpenPrsOnActivation = false;
    config.commands = {
      enabled: true,
      botMentions: ["@evaos-code-review-bot"],
      trustedAuthors: ["100yenadmin"],
      acknowledge: false
    };
    const state = new ReviewStateStore(config.statePath);
    let issueCommentReads = 0;

    const result = await runScheduledCycleWithDeps({
      config,
      github: {
        ...githubFromMap(new Map([[
          "org/repo-a",
          [pull("org/repo-a", 1, "historical-a"), pull("org/repo-a", 2, "historical-b")]
        ]])),
        listIssueComments: async () => {
          issueCommentReads += 1;
          throw new Error("activation-baselined heads should not read issue comments");
        }
      },
      state,
      options: { dryRun: false, useZCode: false },
      reviewPullImpl: async () => {
        throw new Error("activation-baselined heads should not be reviewed");
      },
      now: new Date("2026-07-01T00:00:00.000Z")
    });

    expect(result.baselinedExisting).toBe(2);
    expect(result.skippedProcessed).toBe(2);
    expect(result.commandFetchErrors).toBe(0);
    expect(result.queue.enqueued).toBe(0);
    expect(result.queue.leased).toBe(0);
    expect(issueCommentReads).toBe(0);
    expect(state.getProcessedReview("org/repo-a", 1, "historical-a")).toMatchObject({
      status: "skipped",
      error: "activation_baseline_existing_head"
    });
    state.close();
  });

  it("allows scoped trusted commands for activation-baselined heads", async () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-scheduler-command-baseline-scoped-"));
    roots.push(root);
    const config = schedulerConfig(root, ["org/repo-a"]);
    config.activation.reviewExistingOpenPrsOnActivation = false;
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
      headSha: "historical-a",
      status: "skipped",
      error: "activation_baseline_existing_head"
    });
    const comments = new Map([
      ["org/repo-a#1", [comment(444, "100yenadmin", "@evaos-code-review-bot review")]]
    ]);
    let issueCommentReads = 0;

    const result = await runScheduledCycleWithDeps({
      config,
      github: {
        ...githubFromMap(
          new Map([["org/repo-a", [pull("org/repo-a", 1, "historical-a")]]]),
          comments
        ),
        listIssueComments: async (repo, issueNumber) => {
          issueCommentReads += 1;
          return comments.get(`${repo}#${issueNumber}`) ?? [];
        }
      },
      state,
      options: { repo: "org/repo-a", pullNumber: 1, dryRun: false, useZCode: false },
      reviewPullImpl: async ({ state: reviewState, repo, pull: reviewPull }) => {
        reviewState.recordProcessed({
          repo,
          pullNumber: reviewPull.number,
          headSha: reviewPull.head.sha,
          status: "posted",
          event: "COMMENT",
          reviewUrl: "https://github.com/org/repo-a/pull/1#pullrequestreview-scoped"
        });
        return "reviewed_command";
      },
      now: new Date("2026-07-01T00:00:00.000Z")
    });

    expect(result.commandReviewRequested).toBe(1);
    expect(result.reviewed).toBe(1);
    expect(issueCommentReads).toBe(1);
    expect(state.listReviewQueueJobs({ state: "posted" })).toEqual([
      expect.objectContaining({
        repo: "org/repo-a",
        pullNumber: 1,
        source: "manual_command",
        commentId: 444
      })
    ]);
    state.close();
  });

  it("allows scoped trusted commands for new heads on pre-activation PRs", async () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-scheduler-command-preactivation-new-head-"));
    roots.push(root);
    const config = schedulerConfig(root, ["org/repo-a"]);
    config.activation.reviewExistingOpenPrsOnActivation = false;
    config.commands = {
      enabled: true,
      botMentions: ["@evaos-code-review-bot"],
      trustedAuthors: ["100yenadmin"],
      acknowledge: false
    };
    const state = new ReviewStateStore(config.statePath);
    state.recordRepoActivation("org/repo-a", "2026-07-02T16:58:09.555Z");
    state.recordProcessed({
      repo: "org/repo-a",
      pullNumber: 950,
      headSha: "old-baselined-head",
      status: "skipped",
      error: "activation_baseline_existing_head"
    });
    const comments = new Map([
      ["org/repo-a#950", [comment(555, "100yenadmin", "@evaos-code-review-bot review")]]
    ]);

    const result = await runScheduledCycleWithDeps({
      config,
      github: githubFromMap(
        new Map([[
          "org/repo-a",
          [pull("org/repo-a", 950, "new-head-on-old-pr", "base", { createdAt: "2026-06-30T05:34:43Z" })]
        ]]),
        comments
      ),
      state,
      options: { repo: "org/repo-a", pullNumber: 950, dryRun: false, useZCode: false },
      reviewPullImpl: async ({ state: reviewState, repo, pull: reviewPull }) => {
        reviewState.recordProcessed({
          repo,
          pullNumber: reviewPull.number,
          headSha: reviewPull.head.sha,
          status: "posted",
          event: "COMMENT",
          reviewUrl: "https://github.com/org/repo-a/pull/950#pullrequestreview-scoped"
        });
        return "reviewed_command";
      },
      now: new Date("2026-07-02T17:45:00.000Z")
    });

    expect(result.commandReviewRequested).toBe(1);
    expect(result.reviewed).toBe(1);
    expect(result.skippedProcessed).toBe(0);
    expect(state.listReviewQueueJobs({ state: "posted" })).toEqual([
      expect.objectContaining({
        repo: "org/repo-a",
        pullNumber: 950,
        headSha: "new-head-on-old-pr",
        source: "manual_command",
        commentId: 555
      })
    ]);
    expect(state.getProcessedReview("org/repo-a", 950, "new-head-on-old-pr")).toMatchObject({
      status: "posted",
      event: "COMMENT"
    });
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
    expect(state.getReviewReadiness("org/repo-a", 1, "a1")).toMatchObject({
      state: "skipped",
      reason: "manual_command_stop",
      commandAction: "stop",
      commandCommentId: 333
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

    const result = await runScheduledCycleWithDeps({
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

  it("reconciles expired and dead reviewer sessions at scheduler cycle boundaries", async () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-scheduler-reposticky-reconcile-"));
    roots.push(root);
    const config = schedulerConfig(root, ["org/repo-a"]);
    config.reviewerSessions = {
      enabled: true,
      ttlMs: 8 * 60 * 60_000,
      headCountLimit: 10
    };
    const state = new ReviewStateStore(config.statePath);
    const expired = state.assignReviewerSessionJob({
      repo: "org/repo-expired",
      pullNumber: 1,
      headSha: "expired-head",
      ttlMs: 1_000,
      headCountLimit: 10,
      now: new Date("2026-07-01T00:00:00.000Z")
    });
    const deadWorker = state.assignReviewerSessionJob({
      repo: "org/repo-dead",
      pullNumber: 2,
      headSha: "dead-head",
      ttlMs: 60_000,
      headCountLimit: 10,
      workerPid: 999_999_999,
      now: new Date("2026-07-01T00:00:00.000Z")
    });
    const healthy = state.assignReviewerSessionJob({
      repo: "org/repo-healthy",
      pullNumber: 3,
      headSha: "healthy-head",
      ttlMs: 60_000,
      headCountLimit: 10,
      now: new Date("2026-07-01T00:00:00.000Z")
    });
    if (!expired.assigned || !deadWorker.assigned || !healthy.assigned) throw new Error("expected assignments");

    await runScheduledCycleWithDeps({
      config,
      github: githubFromMap(new Map([["org/repo-a", []]])),
      state,
      options: { dryRun: false, useZCode: false },
      reviewPullImpl: reviewPull,
      now: new Date("2026-07-01T00:00:02.000Z")
    });

    expect(state.getReviewerSession(expired.session.sessionId)).toMatchObject({ state: "expired" });
    expect(state.getReviewerSession(deadWorker.session.sessionId)).toMatchObject({
      state: "failed",
      lastError: "owner_pid_not_alive:999999999"
    });
    expect(state.getReviewerSession(healthy.session.sessionId)).toMatchObject({ state: "active" });
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
    expect(state.getReviewReadiness("org/repo-a", 1, "a1")).toMatchObject({
      state: "command_recorded",
      reason: "trusted_explain_command",
      commandAction: "explain",
      commandCommentId: 336
    });

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
      now: new Date("2026-07-01T00:01:00.000Z")
    });
    const readinessAfterAutomaticReview = state.getReviewReadiness("org/repo-a", 1, "a1");
    expect(readinessAfterAutomaticReview).toMatchObject({
      state: "ready_for_human",
      reason: "comment_review_posted"
    });
    expect(readinessAfterAutomaticReview?.commandAction).toBeUndefined();
    expect(readinessAfterAutomaticReview?.commandCommentId).toBeUndefined();
    state.close();
  });

  it("does not consume RepoSticky session head budget for finishing-touch commands", async () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-scheduler-reposticky-finishing-touch-command-"));
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
    config.repoProfiles = {
      repos: {
        "org/repo-a": {
          finishingTouches: {
            unitTests: { enabled: true }
          }
        }
      }
    };
    const state = new ReviewStateStore(config.statePath);
    const pullMap = new Map([["org/repo-a", [pull("org/repo-a", 1, HEAD_A)]]]);
    const comments = new Map([
      ["org/repo-a#1", [comment(338, "100yenadmin", "@evaos-code-review-bot generate tests")]]
    ]);

    const result = await runScheduledCycleWithDeps({
      config,
      github: githubFromMap(pullMap, comments),
      state,
      options: { dryRun: false, useZCode: false },
      reviewPullImpl: reviewPull,
      now: new Date("2026-07-01T00:00:00.000Z")
    });

    expect(result.skippedCommandExplain).toBe(0);
    expect(result.skippedFinishingTouchDraft).toBe(1);
    expect(result.queue.leased).toBe(0);
    expect(state.listReviewerSessions({ repo: "org/repo-a" })).toHaveLength(0);
    const [recordedJob] = state.listReviewQueueJobs({ state: "command_recorded" });
    expect(recordedJob).toMatchObject({
      commentId: 338,
      source: "manual_command",
      lastError: "manual_command_finishing_touch_draft_recorded"
    });
    expect(recordedJob?.sessionId).toBeUndefined();
    expect(state.getReviewReadiness("org/repo-a", 1, HEAD_A)).toMatchObject({
      state: "command_recorded",
      reason: "trusted_generate_tests_command",
      commandAction: "generate_tests",
      commandCommentId: 338
    });
    expect(state.getFinishingTouchDraft({
      repo: "org/repo-a",
      pullNumber: 1,
      headSha: HEAD_A,
      commandCommentId: 338
    })).toMatchObject({
      action: "generate_tests",
      status: "drafted"
    });
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

  it("does not retire superseded queued heads when a trusted non-review command is recorded", async () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-scheduler-stop-no-stale-retire-"));
    roots.push(root);
    const config = schedulerConfig(root, ["org/repo-a"]);
    config.reviewStatusComment!.enabled = true;
    config.commands = {
      enabled: true,
      botMentions: ["@evaos-code-review-bot"],
      trustedAuthors: ["100yenadmin"],
      acknowledge: false
    };
    const state = new ReviewStateStore(config.statePath);
    const oldJob = state.enqueueReviewQueueJob({
      repo: "org/repo-a",
      pullNumber: 1,
      headSha: HEAD_A,
      baseSha: "base"
    }).job;
    const comments = new Map([
      ["org/repo-a#1", [comment(501, "100yenadmin", "@evaos-code-review-bot stop")]]
    ]);
    const statusCalls: StatusCommentCall[] = [];

    const result = await runScheduledCycleWithDeps({
      config,
      github: githubFromMap(new Map([
        ["org/repo-a", [pull("org/repo-a", 1, HEAD_B)]]
      ]), comments, statusCalls),
      state,
      options: { dryRun: false, useZCode: false },
      reviewPullImpl: async () => "skipped_command_stop",
      now: new Date("2026-07-01T00:00:00.000Z")
    });

    expect(result.skippedCommandStop).toBe(1);
    expect(result.queue.staleRetired).toBe(0);
    expect(statusCalls).toHaveLength(0);
    expect(state.getReviewQueueJob(oldJob.jobId)).toMatchObject({ state: "queued" });
    expect(state.listReviewQueueJobs({ state: "command_recorded" })).toEqual([
      expect.objectContaining({ repo: "org/repo-a", pullNumber: 1, headSha: HEAD_B, commentId: 501 })
    ]);
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

  it("stale-retires automatic base-drift jobs and posts a terminal same-head status", async () => {
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
    expect(statusCalls.map(statusFromBody)).toEqual(["stale_head"]);
    expect(state.listReviewQueueJobs({ state: "stale_retired" })).toEqual([
      expect.objectContaining({ lastError: "base_changed_before_review live=new-base" })
    ]);
    expect(state.getReviewReadiness("org/repo-a", 1, HEAD_A)).toMatchObject({
      state: "stale",
      reason: "base_changed_before_review live=new-base"
    });
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

  it("does not fetch changed files for risk weighting while a repo provider cooldown is active", async () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-scheduler-risk-cooldown-"));
    roots.push(root);
    const config = schedulerConfig(root, ["org/repo-a"]);
    config.riskWeightedQueue = {
      enabled: true,
      elevatedPriority: 5,
      docsOnlyPriority: 80
    };
    const state = new ReviewStateStore(config.statePath);
    state.recordRepoProviderCooldown({
      repo: "org/repo-a",
      cooldownUntil: new Date("2026-07-01T00:05:00.000Z"),
      reason: "provider_request_rate_limit"
    });
    let fileFetches = 0;
    const github: SchedulerGitHubApi = {
      ...githubFromMap(new Map([
        ["org/repo-a", [pull("org/repo-a", 1, "a1")]]
      ])),
      listPullFiles: async () => {
        fileFetches += 1;
        return [{ filename: "src/auth/session.ts" }];
      }
    };

    const result = await runScheduledCycleWithDeps({
      config,
      github,
      state,
      options: { dryRun: true, useZCode: false },
      reviewPullImpl: async () => {
        throw new Error("provider-deferred head must not run review work");
      },
      now: new Date("2026-07-01T00:00:00.000Z")
    });

    expect(fileFetches).toBe(0);
    expect(result.skippedProviderCooldown).toBe(1);
    expect(result.queue.providerDeferred).toBe(1);
    expect(state.listReviewQueueJobs({ repo: "org/repo-a" })).toEqual([
      expect.objectContaining({
        pullNumber: 1,
        state: "provider_deferred",
        priority: 50,
        nextEligibleAt: "2026-07-01T00:05:00.000Z"
      })
    ]);
    state.close();
  });

  it("does not fetch changed files when risk weighting is disabled", async () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-scheduler-risk-disabled-"));
    roots.push(root);
    const config = schedulerConfig(root, ["org/repo-a"]);
    config.riskWeightedQueue = { enabled: false };
    const state = new ReviewStateStore(config.statePath);
    let fileFetches = 0;
    const github: SchedulerGitHubApi = {
      ...githubFromMap(new Map([
        ["org/repo-a", [pull("org/repo-a", 1, "a1")]]
      ])),
      listPullFiles: async () => {
        fileFetches += 1;
        throw new Error("listPullFiles must not be called when risk weighting is disabled");
      }
    };
    let reviewed = 0;

    const result = await runScheduledCycleWithDeps({
      config,
      github,
      state,
      options: { dryRun: true, useZCode: false },
      reviewPullImpl: async ({ state: reviewState, repo, pull: reviewPull }) => {
        reviewed += 1;
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

    expect(fileFetches).toBe(0);
    expect(reviewed).toBe(1);
    expect(result.reviewed).toBe(1);
    expect(state.listReviewQueueJobs({ repo: "org/repo-a" })).toEqual([
      expect.objectContaining({ pullNumber: 1, priority: 50 })
    ]);
    state.close();
  });

  it("falls back to flat priority and redacted logs when risk file fetch fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-scheduler-risk-fetch-fail-"));
    roots.push(root);
    const config = schedulerConfig(root, ["org/repo-a"]);
    config.riskWeightedQueue = {
      enabled: true,
      elevatedPriority: 5,
      docsOnlyPriority: 80
    };
    const state = new ReviewStateStore(config.statePath);
    let fileFetches = 0;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const github: SchedulerGitHubApi = {
      ...githubFromMap(new Map([
        ["org/repo-a", [pull("org/repo-a", 1, "a1")]]
      ])),
      listPullFiles: async () => {
        fileFetches += 1;
        throw new Error("GitHub failed with ghp_fake_token");
      }
    };
    let reviewed = 0;

    try {
      const result = await runScheduledCycleWithDeps({
        config,
        github,
        state,
        options: { dryRun: true, useZCode: false },
        reviewPullImpl: async ({ state: reviewState, repo, pull: reviewPull }) => {
          reviewed += 1;
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

      const warning = warn.mock.calls.map((call) => call.join(" ")).join("\n");
      expect(fileFetches).toBe(1);
      expect(reviewed).toBe(1);
      expect(result.reviewed).toBe(1);
      expect(warning).toContain("[risk-queue] changed-surface fetch failed");
      expect(warning).not.toContain("ghp_fake_token");
      expect(state.listReviewQueueJobs({ repo: "org/repo-a" })).toEqual([
        expect.objectContaining({ pullNumber: 1, priority: 50 })
      ]);
    } finally {
      warn.mockRestore();
      state.close();
    }
  });

  it("uses repo-profile queue overflow policy to mark burst heads explicitly provider-deferred", async () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-scheduler-profile-capacity-"));
    roots.push(root);
    const repo = "100yenadmin/Lossless-Codex-Orchestrator-LCO";
    const config = schedulerConfig(root, [repo]);
    config.reviewStatusComment!.enabled = true;
    config.reviewScheduler!.maxProviderActive = 2;
    config.reviewScheduler!.maxQueuedPerRepo = 10;
    config.repoProfiles = {
      repos: {
        [repo]: {
          reviewScheduler: {
            maxQueuedHeads: 1,
            overflowAction: "defer"
          }
        }
      }
    };
    const state = new ReviewStateStore(config.statePath);
    const statusCalls: StatusCommentCall[] = [];

    const result = await runScheduledCycleWithDeps({
      config,
      github: githubFromMap(new Map([
        [repo, [pull(repo, 461, HEAD_A), pull(repo, 462, HEAD_B)]]
      ]), new Map(), statusCalls),
      state,
      options: { dryRun: false, useZCode: false },
      reviewPullImpl: async ({ state: reviewState, repo: reviewRepo, pull: reviewPull }) => {
        reviewState.recordProcessed({
          repo: reviewRepo,
          pullNumber: reviewPull.number,
          headSha: reviewPull.head.sha,
          status: "posted",
          event: "COMMENT"
        });
        return "reviewed";
      },
      now: new Date("2026-07-04T12:00:00.000Z")
    });

    expect(result.queue.enqueued).toBe(1);
    expect(result.skippedCapacity).toBe(1);
    expect(state.listReviewQueueJobs({ repo })).toEqual([
      expect.objectContaining({ pullNumber: 461, headSha: HEAD_A })
    ]);
    expect(result.queue.remainingQueued).toBe(0);
    expect(result.queue.budget?.queued.total).toBe(1);
    expect(state.getReviewReadiness(repo, 462, HEAD_B)).toMatchObject({
      state: "provider_deferred",
      reason: "repo_queue_capacity_full"
    });
    expect(statusCalls.map(statusFromBody)).toEqual(["queued", "provider_deferred", "in_progress", "completed"]);
    expect(statusCalls.find((call) => call.issueNumber === 462)?.body).toContain("Repo review queue capacity is full");
    state.close();
  });

  it("applies repo-profile active caps to freshly enqueued jobs in the same cycle", async () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-scheduler-profile-active-cap-"));
    roots.push(root);
    const repo = "100yenadmin/Lossless-Codex-Orchestrator-LCO";
    const config = schedulerConfig(root, [repo]);
    config.reviewScheduler!.maxProviderActive = 2;
    config.reviewScheduler!.maxRepoActive = 2;
    config.repoProfiles = {
      repos: {
        [repo]: {
          reviewScheduler: {
            maxActiveHeads: 1,
            maxQueuedHeads: 10,
            overflowAction: "defer"
          }
        }
      }
    };
    const state = new ReviewStateStore(config.statePath);
    const reviewed: number[] = [];

    const result = await runScheduledCycleWithDeps({
      config,
      github: githubFromMap(new Map([
        [repo, [pull(repo, 461, HEAD_A), pull(repo, 462, HEAD_B)]]
      ])),
      state,
      options: { dryRun: false, useZCode: false },
      reviewPullImpl: async ({ state: reviewState, repo: reviewRepo, pull: reviewPull }) => {
        reviewed.push(reviewPull.number);
        reviewState.recordProcessed({
          repo: reviewRepo,
          pullNumber: reviewPull.number,
          headSha: reviewPull.head.sha,
          status: "posted",
          event: "COMMENT"
        });
        return "reviewed";
      },
      now: new Date("2026-07-04T12:00:00.000Z")
    });

    expect(result.queue.enqueued).toBe(2);
    expect(result.reviewed).toBe(1);
    expect(reviewed).toEqual([461]);
    expect(state.listReviewQueueJobs({ repo, state: "queued" })).toEqual([
      expect.objectContaining({ pullNumber: 462, headSha: HEAD_B })
    ]);
    state.close();
  });

  it("does not re-post capacity-deferred status when a repo stays at queue capacity", async () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-scheduler-profile-capacity-idempotent-"));
    roots.push(root);
    const repo = "100yenadmin/Lossless-Codex-Orchestrator-LCO";
    const config = schedulerConfig(root, [repo]);
    config.reviewStatusComment!.enabled = true;
    config.reviewScheduler!.maxQueuedPerRepo = 10;
    config.reviewScheduler!.maxProviderActive = 1;
    config.repoProfiles = {
      repos: {
        [repo]: {
          reviewScheduler: {
            maxQueuedHeads: 1,
            overflowAction: "defer"
          }
        }
      }
    };
    const state = new ReviewStateStore(config.statePath);
    const blocking = state.enqueueReviewQueueJob({
      repo,
      pullNumber: 460,
      headSha: HEAD_A,
      baseSha: "base",
      source: "automatic",
      lane: "background",
      providerId: "zai-coding-plan",
      now: new Date("2026-07-04T12:00:00.000Z")
    }).job;
    state.updateReviewQueueJobState({
      jobId: blocking.jobId,
      state: "running",
      leaseId: "blocking-lease",
      leaseExpiresAt: "2026-07-04T12:10:00.000Z",
      clearLease: false,
      now: new Date("2026-07-04T12:00:01.000Z")
    });
    const statusCalls: StatusCommentCall[] = [];

    const first = await runScheduledCycleWithDeps({
      config,
      github: githubFromMap(new Map([
        [repo, [pull(repo, 462, HEAD_B)]]
      ]), new Map(), statusCalls),
      state,
      options: { dryRun: false, useZCode: false },
      reviewPullImpl: async () => {
        throw new Error("capacity-deferred head must not run review work");
      },
      now: new Date("2026-07-04T12:01:00.000Z")
    });

    expect(first.skippedCapacity).toBe(1);
    expect(statusCalls.map(statusFromBody)).toEqual(["provider_deferred"]);
    const readiness = state.getReviewReadiness(repo, 462, HEAD_B);
    expect(readiness).toMatchObject({
      state: "provider_deferred",
      reason: "repo_queue_capacity_full",
      updatedAt: "2026-07-04T12:01:00.000Z"
    });

    const second = await runScheduledCycleWithDeps({
      config,
      github: githubFromMap(new Map([
        [repo, [pull(repo, 462, HEAD_B)]]
      ]), new Map(), statusCalls),
      state,
      options: { dryRun: false, useZCode: false },
      reviewPullImpl: async () => {
        throw new Error("capacity-deferred head must not run review work");
      },
      now: new Date("2026-07-04T12:02:00.000Z")
    });

    expect(second.skippedCapacity).toBe(1);
    expect(statusCalls.map(statusFromBody)).toEqual(["provider_deferred"]);
    expect(state.getReviewReadiness(repo, 462, HEAD_B)).toEqual(readiness);

    state.updateReviewQueueJobState({
      jobId: blocking.jobId,
      state: "posted",
      reviewUrl: "https://github.com/100yenadmin/Lossless-Codex-Orchestrator-LCO/pull/460#pullrequestreview-1",
      lastError: "reviewed",
      now: new Date("2026-07-04T12:02:30.000Z")
    });
    const third = await runScheduledCycleWithDeps({
      config,
      github: githubFromMap(new Map([
        [repo, [pull(repo, 462, HEAD_B)]]
      ]), new Map(), statusCalls),
      state,
      options: { dryRun: false, useZCode: false },
      reviewPullImpl: async ({ state: reviewState, repo: reviewRepo, pull: reviewPull }) => {
        reviewState.recordProcessed({
          repo: reviewRepo,
          pullNumber: reviewPull.number,
          headSha: reviewPull.head.sha,
          status: "posted",
          event: "COMMENT"
        });
        return "reviewed";
      },
      now: new Date("2026-07-04T12:03:00.000Z")
    });

    expect(third.queue.enqueued).toBe(1);
    expect(third.reviewed).toBe(1);
    expect(statusCalls.map(statusFromBody)).toEqual(["provider_deferred", "queued", "in_progress", "completed"]);
    expect(state.getReviewReadiness(repo, 462, HEAD_B)).toMatchObject({
      state: "ready_for_human",
      reason: "comment_review_posted"
    });
    state.close();
  });

  it("treats repo-profile skip overflow as an explicit terminal skip for the exact head", async () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-scheduler-profile-capacity-skip-"));
    roots.push(root);
    const repo = "100yenadmin/Lossless-Codex-Orchestrator-LCO";
    const config = schedulerConfig(root, [repo]);
    config.reviewStatusComment!.enabled = true;
    config.reviewScheduler!.maxProviderActive = 2;
    config.reviewScheduler!.maxQueuedPerRepo = 10;
    config.repoProfiles = {
      repos: {
        [repo]: {
          reviewScheduler: {
            maxQueuedHeads: 1,
            overflowAction: "skip"
          }
        }
      }
    };
    const state = new ReviewStateStore(config.statePath);
    const statusCalls: StatusCommentCall[] = [];

    const first = await runScheduledCycleWithDeps({
      config,
      github: githubFromMap(new Map([
        [repo, [pull(repo, 461, HEAD_A), pull(repo, 462, HEAD_B)]]
      ]), new Map(), statusCalls),
      state,
      options: { dryRun: false, useZCode: false },
      reviewPullImpl: async ({ state: reviewState, repo: reviewRepo, pull: reviewPull }) => {
        reviewState.recordProcessed({
          repo: reviewRepo,
          pullNumber: reviewPull.number,
          headSha: reviewPull.head.sha,
          status: "posted",
          event: "COMMENT"
        });
        return "reviewed";
      },
      now: new Date("2026-07-04T12:00:00.000Z")
    });

    expect(first.queue.enqueued).toBe(1);
    expect(first.skippedCapacity).toBe(1);
    expect(state.getProcessedReview(repo, 462, HEAD_B)).toMatchObject({
      status: "skipped",
      error: "repo_queue_capacity_full"
    });
    expect(state.getReviewReadiness(repo, 462, HEAD_B)).toMatchObject({
      state: "skipped",
      reason: "repo_queue_capacity_full"
    });
    expect(statusCalls.map(statusFromBody)).toEqual(["queued", "skipped", "in_progress", "completed"]);

    const second = await runScheduledCycleWithDeps({
      config,
      github: githubFromMap(new Map([
        [repo, [pull(repo, 462, HEAD_B)]]
      ]), new Map(), statusCalls),
      state,
      options: { dryRun: false, useZCode: false },
      reviewPullImpl: async () => {
        throw new Error("terminal skip overflow heads must not be re-enqueued automatically");
      },
      now: new Date("2026-07-04T12:05:00.000Z")
    });

    expect(second.skippedProcessed).toBe(1);
    expect(state.listReviewQueueJobs({ repo }).filter((job) => job.pullNumber === 462)).toHaveLength(0);
    expect(statusCalls.map(statusFromBody)).toEqual(["queued", "skipped", "in_progress", "completed"]);
    state.close();
  });

  it("skips pre-activation PRs when their head changes after repo activation", async () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-scheduler-preactivation-head-"));
    roots.push(root);
    const config = schedulerConfig(root, ["org/repo-a"]);
    config.activation.reviewExistingOpenPrsOnActivation = false;
    const state = new ReviewStateStore(config.statePath);
    state.recordRepoActivation("org/repo-a", "2026-07-02T16:58:09.555Z");
    state.recordProcessed({
      repo: "org/repo-a",
      pullNumber: 950,
      headSha: "old-baselined-head",
      status: "skipped",
      error: "activation_baseline_existing_head"
    });
    const reviewed: string[] = [];

    const result = await runScheduledCycleWithDeps({
      config,
      github: githubFromMap(new Map([
        [
          "org/repo-a",
          [
            pull("org/repo-a", 950, "new-head-on-old-pr", "base", { createdAt: "2026-06-30T05:34:43Z" }),
            pull("org/repo-a", 960, "new-head-on-new-pr", "base", { createdAt: "2026-07-02T17:39:37Z" })
          ]
        ]
      ])),
      state,
      options: { dryRun: true, useZCode: false },
      reviewPullImpl: async ({ repo, pull: reviewPull }) => {
        reviewed.push(`${repo}#${reviewPull.number}`);
        return "reviewed";
      },
      now: new Date("2026-07-02T17:45:00.000Z")
    });

    expect(result.skippedProcessed).toBe(1);
    expect(result.queue.enqueued).toBe(1);
    expect(state.getProcessedReview("org/repo-a", 950, "new-head-on-old-pr")).toMatchObject({
      status: "skipped",
      error: "activation_baseline_existing_head"
    });
    expect(state.getReviewReadiness("org/repo-a", 950, "new-head-on-old-pr")).toMatchObject({
      state: "skipped",
      reason: "activation_baseline_existing_head"
    });
    expect(state.listReviewQueueJobs({ repo: "org/repo-a" })).toEqual([
      expect.objectContaining({ pullNumber: 960, headSha: "new-head-on-new-pr", state: "queued" })
    ]);
    expect(reviewed).toEqual(["org/repo-a#960"]);
    state.close();
  });

  it("retires stale queued heads before skipping changed pre-activation PRs", async () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-scheduler-preactivation-retire-stale-"));
    roots.push(root);
    const config = schedulerConfig(root, ["org/repo-a"]);
    config.activation.reviewExistingOpenPrsOnActivation = false;
    const state = new ReviewStateStore(config.statePath);
    state.recordRepoActivation("org/repo-a", "2026-07-02T16:58:09.555Z");
    state.recordProcessed({
      repo: "org/repo-a",
      pullNumber: 950,
      headSha: "old-baselined-head",
      status: "skipped",
      error: "activation_baseline_existing_head"
    });
    state.enqueueReviewQueueJob({
      repo: "org/repo-a",
      pullNumber: 950,
      headSha: "old-queued-head",
      baseSha: "base",
      source: "manual_command",
      lane: "manual",
      commentId: 777
    });

    const result = await runScheduledCycleWithDeps({
      config,
      github: githubFromMap(new Map([
        [
          "org/repo-a",
          [pull("org/repo-a", 950, "new-head-on-old-pr", "base", { createdAt: "2026-06-30T05:34:43Z" })]
        ]
      ])),
      state,
      options: { dryRun: true, useZCode: false },
      reviewPullImpl: async () => {
        throw new Error("pre-activation skipped heads should not run review work");
      },
      now: new Date("2026-07-02T17:45:00.000Z")
    });

    expect(result.skippedProcessed).toBe(1);
    expect(state.listReviewQueueJobs({ state: "stale_retired" })).toEqual([
      expect.objectContaining({
        repo: "org/repo-a",
        pullNumber: 950,
        headSha: "old-queued-head",
        lastError: "superseded_by_head=new-head-on-old-pr"
      })
    ]);
    expect(state.getReviewReadiness("org/repo-a", 950, "old-queued-head")).toMatchObject({
      state: "stale",
      reason: "superseded_by_head=new-head-on-old-pr"
    });
    state.close();
  });

  it("queues an exact trusted request-changes command over an already-posted advisory", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-scheduler-request-changes-advisory-"));
    roots.push(root);
    const config = schedulerConfig(root, ["org/repo-a"]);
    config.commands = {
      enabled: true,
      botMentions: ["@neondiff"],
      trustedAuthors: ["maintainer"],
      acknowledge: false
    };
    const state = new ReviewStateStore(config.statePath);
    state.recordProcessed({
      repo: "org/repo-a",
      pullNumber: 1,
      headSha: HEAD_A,
      status: "posted",
      event: "COMMENT"
    });
    const comments = new Map([["org/repo-a#1", [
      comment(901, "maintainer", `@neondiff request-changes --repo org/repo-a --pr 1 --head ${HEAD_A}`)
    ]]]);
    const seenCommentIds: Array<number | undefined> = [];

    const result = await runScheduledCycleWithDeps({
      config,
      github: githubFromMap(new Map([["org/repo-a", [pull("org/repo-a", 1, HEAD_A)]]]), comments),
      state,
      options: { dryRun: false, useZCode: false },
      reviewPullImpl: async ({ state: reviewState, repo, pull: reviewPull, commandCommentId }) => {
        seenCommentIds.push(commandCommentId);
        reviewState.recordProcessed({
          repo,
          pullNumber: reviewPull.number,
          headSha: reviewPull.head.sha,
          status: "posted",
          event: "REQUEST_CHANGES"
        });
        return "reviewed_command";
      }
    });

    expect(result.commandReviewRequested).toBe(1);
    expect(seenCommentIds).toEqual([901]);
    expect(state.listReviewQueueJobs({ state: "posted" })).toEqual([
      expect.objectContaining({ source: "manual_command", lane: "manual", commentId: 901 })
    ]);
    expect(state.hasProcessedCommand("org/repo-a", 1, HEAD_A, 901)).toBe(true);
    expect(state.getReviewReadiness("org/repo-a", 1, HEAD_A)).toMatchObject({
      state: "needs_fix",
      reason: "request_changes_review_posted",
      event: "REQUEST_CHANGES",
      commandAction: "request-changes",
      commandCommentId: 901
    });
    state.close();
  });

  it("does not re-enqueue the same request-changes comment after its job becomes terminal", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-scheduler-request-changes-dedupe-"));
    roots.push(root);
    const config = schedulerConfig(root, ["org/repo-a"]);
    config.commands = {
      enabled: true,
      botMentions: ["@neondiff"],
      trustedAuthors: ["maintainer"],
      acknowledge: false
    };
    const state = new ReviewStateStore(config.statePath);
    const comments = new Map([["org/repo-a#1", [
      comment(902, "maintainer", `@neondiff request-changes --repo org/repo-a --pr 1 --head ${HEAD_A}`)
    ]]]);
    const github = githubFromMap(new Map([["org/repo-a", [pull("org/repo-a", 1, HEAD_A)]]]), comments);
    let reviewCalls = 0;
    const reviewPullImpl: (input: ReviewPullInput) => Promise<ReviewPullResult> = async ({ state: reviewState, repo, pull: reviewPull }) => {
      reviewCalls += 1;
      reviewState.recordProcessed({
        repo,
        pullNumber: reviewPull.number,
        headSha: reviewPull.head.sha,
        status: "posted",
        event: "COMMENT"
      });
      return "reviewed_command";
    };

    const first = await runScheduledCycleWithDeps({
      config,
      github,
      state,
      options: { dryRun: false, useZCode: false },
      reviewPullImpl
    });
    const second = await runScheduledCycleWithDeps({
      config,
      github,
      state,
      options: { dryRun: false, useZCode: false },
      reviewPullImpl
    });

    expect(first.commandReviewRequested).toBe(1);
    expect(second.commandReviewRequested).toBe(0);
    expect(reviewCalls).toBe(1);
    expect(state.listReviewQueueJobs()).toHaveLength(1);
    expect(state.getReviewReadiness("org/repo-a", 1, HEAD_A)).toMatchObject({
      state: "ready_for_human",
      event: "COMMENT",
      commandAction: "request-changes",
      commandCommentId: 902
    });
    state.close();
  });

  it("queues a second new same-head command while the one-shot ledger keeps it advisory", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-scheduler-request-changes-second-command-"));
    roots.push(root);
    const config = schedulerConfig(root, ["org/repo-a"]);
    config.commands = {
      enabled: true,
      botMentions: ["@neondiff"],
      trustedAuthors: ["maintainer"],
      acknowledge: false
    };
    const state = new ReviewStateStore(config.statePath);
    const commentsForPull = [
      comment(940, "maintainer", `@neondiff request-changes --repo org/repo-a --pr 1 --head ${HEAD_A}`)
    ];
    const comments = new Map([["org/repo-a#1", commentsForPull]]);
    const github = githubFromMap(new Map([["org/repo-a", [pull("org/repo-a", 1, HEAD_A)]]]), comments);
    const selectedEvents: string[] = [];
    const reviewPullImpl: (input: ReviewPullInput) => Promise<ReviewPullResult> = async ({
      state: reviewState,
      repo,
      pull: reviewPull,
      commandCommentId
    }) => {
      const consumed = reviewState.tryConsumeReviewEventAuthorization({
        repo,
        pullNumber: reviewPull.number,
        headSha: reviewPull.head.sha,
        commentId: commandCommentId!,
        author: "maintainer"
      });
      const event = consumed ? "REQUEST_CHANGES" as const : "COMMENT" as const;
      selectedEvents.push(event);
      reviewState.recordProcessed({
        repo,
        pullNumber: reviewPull.number,
        headSha: reviewPull.head.sha,
        status: "posted",
        event
      });
      return "reviewed_command";
    };

    const first = await runScheduledCycleWithDeps({
      config,
      github,
      state,
      options: { dryRun: false, useZCode: false },
      reviewPullImpl
    });
    commentsForPull.push(
      comment(941, "maintainer", `@neondiff request-changes --repo org/repo-a --pr 1 --head ${HEAD_A}`)
    );
    const second = await runScheduledCycleWithDeps({
      config,
      github,
      state,
      options: { dryRun: false, useZCode: false },
      reviewPullImpl
    });

    expect(first.commandReviewRequested).toBe(1);
    expect(second.commandReviewRequested).toBe(1);
    expect(selectedEvents).toEqual(["REQUEST_CHANGES", "COMMENT"]);
    expect(state.listReviewQueueJobs().map((job) => job.commentId)).toEqual([940, 941]);
    expect(state.getReviewReadiness("org/repo-a", 1, HEAD_A)).toMatchObject({
      state: "ready_for_human",
      event: "COMMENT",
      commandAction: "request-changes",
      commandCommentId: 941
    });
    state.close();
  });

  for (const newerAction of ["review", "re-review"] as const) {
    it(`does not let a newer ${newerAction} command erase exact request-changes authority`, async () => {
      const root = mkdtempSync(join(tmpdir(), `neondiff-scheduler-request-changes-${newerAction}-`));
      roots.push(root);
      const config = schedulerConfig(root, ["org/repo-a"]);
      config.commands = {
        enabled: true,
        botMentions: ["@neondiff"],
        trustedAuthors: ["maintainer"],
        acknowledge: false
      };
      const state = new ReviewStateStore(config.statePath);
      const comments = new Map([["org/repo-a#1", [
        comment(910, "maintainer", `@neondiff request-changes --repo org/repo-a --pr 1 --head ${HEAD_A}`),
        comment(911, "maintainer", `@neondiff ${newerAction}`)
      ]]]);
      const seenCommentIds: Array<number | undefined> = [];

      const result = await runScheduledCycleWithDeps({
        config,
        github: githubFromMap(new Map([["org/repo-a", [pull("org/repo-a", 1, HEAD_A)]]]), comments),
        state,
        options: { dryRun: false, useZCode: false },
        reviewPullImpl: async ({ state: reviewState, repo, pull: reviewPull, commandCommentId }) => {
          seenCommentIds.push(commandCommentId);
          reviewState.recordProcessed({
            repo,
            pullNumber: reviewPull.number,
            headSha: reviewPull.head.sha,
            status: "posted",
            event: "REQUEST_CHANGES"
          });
          return "reviewed_command";
        }
      });

      expect(result.commandReviewRequested).toBe(1);
      expect(seenCommentIds).toEqual([910]);
      expect(state.hasProcessedCommand("org/repo-a", 1, HEAD_A, 910)).toBe(true);
      expect(state.hasProcessedCommand("org/repo-a", 1, HEAD_A, 911)).toBe(false);
      state.close();
    });
  }

  it("keeps a newer stop ahead of an older request-changes authorization across scans", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-scheduler-request-changes-stop-"));
    roots.push(root);
    const config = schedulerConfig(root, ["org/repo-a"]);
    config.commands = {
      enabled: true,
      botMentions: ["@neondiff"],
      trustedAuthors: ["maintainer"],
      acknowledge: false
    };
    const state = new ReviewStateStore(config.statePath);
    const comments = new Map([["org/repo-a#1", [
      comment(920, "maintainer", `@neondiff request-changes --repo org/repo-a --pr 1 --head ${HEAD_A}`),
      comment(921, "maintainer", "@neondiff stop")
    ]]]);
    const github = githubFromMap(new Map([["org/repo-a", [pull("org/repo-a", 1, HEAD_A)]]]), comments);

    const first = await runScheduledCycleWithDeps({
      config,
      github,
      state,
      options: { dryRun: false, useZCode: false },
      reviewPullImpl: reviewPull
    });
    const second = await runScheduledCycleWithDeps({
      config,
      github,
      state,
      options: { dryRun: false, useZCode: false },
      reviewPullImpl: reviewPull
    });

    expect(first.skippedCommandStop).toBe(1);
    expect(first.commandReviewRequested).toBe(0);
    expect(second.commandReviewRequested).toBe(0);
    expect(state.listReviewQueueJobs().some((job) => job.commentId === 920)).toBe(false);
    state.close();
  });

  it("does not queue untrusted, wildcard-only, malformed, or stale request-changes attempts", async () => {
    const cases = [
      { name: "untrusted", trustedAuthors: ["maintainer"], author: "outside", body: `@neondiff request-changes --repo org/repo-a --pr 1 --head ${HEAD_A}` },
      { name: "wildcard-only", trustedAuthors: ["*"], author: "outside", body: `@neondiff request-changes --repo org/repo-a --pr 1 --head ${HEAD_A}` },
      { name: "malformed", trustedAuthors: ["maintainer"], author: "maintainer", body: `@neondiff request-changes --pr 1 --repo org/repo-a --head ${HEAD_A}` },
      { name: "stale", trustedAuthors: ["maintainer"], author: "maintainer", body: `@neondiff request-changes --repo org/repo-a --pr 1 --head ${HEAD_B}` }
    ];

    for (const testCase of cases) {
      const root = mkdtempSync(join(tmpdir(), `neondiff-scheduler-request-changes-denied-${testCase.name}-`));
      roots.push(root);
      const config = schedulerConfig(root, ["org/repo-a"]);
      config.commands = {
        enabled: true,
        botMentions: ["@neondiff"],
        trustedAuthors: testCase.trustedAuthors,
        acknowledge: false
      };
      const state = new ReviewStateStore(config.statePath);
      const comments = new Map([["org/repo-a#1", [comment(930, testCase.author, testCase.body)]]]);

      const result = await runScheduledCycleWithDeps({
        config,
        github: githubFromMap(new Map([["org/repo-a", [pull("org/repo-a", 1, HEAD_A)]]]), comments),
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
        }
      });

      expect(result.commandReviewRequested, testCase.name).toBe(0);
      expect(state.listReviewQueueJobs().filter((job) => job.source === "manual_command"), testCase.name).toEqual([]);
      state.close();
    }
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
      overloadBackoffMaxDurationMs: 10 * 60_000,
      overloadBackoffJitterMs: 0,
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

function reviewStatusBody(repo: string, pullNumber: number, headSha: string, status: string): string {
  return [
    `<!-- evaos-code-review-bot:review-status repo=${repo} pr=${pullNumber} sha=${headSha} -->`,
    `<!-- evaos-code-review-bot:review-status-state status=${status} updated_at=2026-07-02T00:00:00.000Z -->`
  ].join("\n");
}

function pull(
  repo: string,
  number: number,
  headSha: string,
  baseSha = "base",
  options: { state?: string; mergedAt?: string | null; createdAt?: string; draft?: boolean; visibility?: "public" | "private" } = {}
): PullRequestSummary {
  return {
    number,
    title: `${repo} PR ${number}`,
    draft: options.draft ?? false,
    ...(options.state ? { state: options.state } : {}),
    ...(options.createdAt ? { created_at: options.createdAt } : {}),
    ...(options.mergedAt !== undefined ? { merged_at: options.mergedAt } : {}),
    head: {
      sha: headSha,
      ref: `pr-${number}`,
      repo: { full_name: repo, private: options.visibility === "private", visibility: options.visibility ?? "public" }
    },
    base: {
      sha: baseSha,
      ref: "main",
      repo: { full_name: repo, private: options.visibility === "private", visibility: options.visibility ?? "public" }
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
