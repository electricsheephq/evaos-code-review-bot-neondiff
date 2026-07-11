import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BotConfig } from "../src/config.js";
import type { GitHubApi } from "../src/github.js";
import { buildReviewBudgetStatus, ReviewRunBudget } from "../src/review-budget.js";
import { ReviewStateStore, type ReviewQueueJobRecord } from "../src/state.js";
import type { PullRequestSummary } from "../src/types.js";
import { reviewPull } from "../src/worker.js";
import { testLicenseAdmission } from "./helpers/license-admission.js";

describe("review run budget", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("caps concurrent active review runs", () => {
    const budget = new ReviewRunBudget(5);

    expect(Array.from({ length: 5 }, () => budget.tryStart())).toEqual([true, true, true, true, true]);
    expect(budget.tryStart()).toBe(false);
    expect(budget.activeRuns).toBe(5);

    budget.finish();

    expect(budget.activeRuns).toBe(4);
    expect(budget.tryStart()).toBe(true);
    expect(budget.activeRuns).toBe(5);
  });

  it("rejects invalid max active run settings", () => {
    expect(() => new ReviewRunBudget(0)).toThrow("maxActiveRuns must be at least 1");
    expect(() => new ReviewRunBudget(5.5)).toThrow("maxActiveRuns must be an integer");
  });

  it("does not let activeRuns go negative on extra finish calls", () => {
    const budget = new ReviewRunBudget(2);

    budget.finish();

    expect(budget.activeRuns).toBe(0);
    expect(budget.tryStart()).toBe(true);
    expect(budget.tryStart()).toBe(true);
    expect(budget.tryStart()).toBe(false);
  });

  it("prevents worker review work when the active run cap is reached", async () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-review-budget-config-"));
    roots.push(root);
    const budget = new ReviewRunBudget(1);
    expect(budget.tryStart()).toBe(true);

    const status = await reviewPull({
      config: minimalConfig(root),
      github: {} as GitHubApi,
      state: {
        hasProcessed: () => false
      } as unknown as ReviewStateStore,
      repo: "electricsheephq/WorldOS",
      pull: pull(1190, "new-head"),
      dryRun: true,
      useZCode: false,
      licenseAdmission: testLicenseAdmission,
      budget
    });

    expect(status).toBe("skipped_capacity");
    expect(budget.activeRuns).toBe(1);
  });

  it("falls back to concurrency settings when scheduler config is absent", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-review-budget-status-fallback-"));
    roots.push(root);

    const status = buildReviewBudgetStatus({
      config: minimalConfig(root),
      jobs: [],
      now: new Date("2026-07-01T00:00:00.000Z")
    });

    expect(status.enabled).toBe(false);
    expect(status.config.scheduler).toMatchObject({
      enabled: false,
      maxProviderActive: 5,
      maxOrgActive: 5,
      maxRepoActive: 1
    });
  });

  it("explains provider cooldown, active capacity, repo caps, and manual reserve delays", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-review-budget-status-"));
    roots.push(root);
    const config = {
      ...minimalConfig(root),
      reviewScheduler: {
        enabled: true,
        maxProviderActive: 2,
        maxOrgActive: 10,
        maxRepoActive: 1,
        maxQueuedPerRepo: 10,
        manualCommandReserve: 1,
        backgroundPriority: 50
      }
    };
    const now = new Date("2026-07-01T00:00:00.000Z");
    const jobs = [
      queueJob("active-a", { repo: "owner/repo-a", state: "running", priority: 10 }),
      queueJob("repo-cap", { repo: "owner/repo-a", state: "queued", priority: 20 }),
      queueJob("manual-reserve", { repo: "owner/repo-b", state: "queued", priority: 30 }),
      queueJob("manual-slot", { repo: "owner/repo-c", state: "queued", lane: "manual", source: "manual_command", priority: 40 }),
      queueJob("cooldown", {
        repo: "owner/repo-d",
        state: "provider_deferred",
        priority: 50,
        nextEligibleAt: "2026-07-01T00:05:00.000Z"
      })
    ];

    const status = buildReviewBudgetStatus({ config, jobs, now });

    expect(status.active.total).toBe(1);
    expect(status.queued).toMatchObject({
      total: 4,
      manual: 1,
      background: 3,
      providerDeferred: 1,
      retryableProviderDeferred: 0
    });
    expect(status.providerDeferred).toMatchObject({
      total: 1,
      retryable: 0,
      readyToRetry: 0,
      waitingCooldown: 1,
      waitingProviderCapacity: 0,
      waitingOrgCapacity: 0,
      waitingRepoCapacity: 0,
      waitingManualReserve: 0,
      waitingLeaseLimit: 0
    });
    expect(status.wouldLease.map((entry) => entry.jobId)).toEqual(["manual-slot"]);
    expect(status.delayedByReason).toMatchObject({
      repo_capacity: 1,
      manual_reserve: 1,
      provider_cooldown: 1
    });
    expect(status.manualReserve).toMatchObject({
      configured: 1,
      activeManual: 0,
      queuedManual: 1,
      reservedSlotsOpen: 1,
      backgroundSlotsAvailableBeforeReserve: 0
    });
  });

  it("separates retryable provider-deferred jobs from actionable ready-to-retry jobs", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-review-budget-provider-deferred-"));
    roots.push(root);
    const config = {
      ...minimalConfig(root),
      reviewScheduler: {
        enabled: true,
        maxProviderActive: 1,
        maxOrgActive: 10,
        maxRepoActive: 10,
        maxQueuedPerRepo: 10,
        manualCommandReserve: 0,
        backgroundPriority: 50
      }
    };
    const now = new Date("2026-07-01T00:05:00.000Z");

    const capacityBlocked = buildReviewBudgetStatus({
      config,
      now,
      jobs: [
        queueJob("active", { repo: "owner/active", state: "running", priority: 1 }),
        queueJob("retryable", {
          repo: "owner/retryable",
          state: "provider_deferred",
          priority: 2,
          nextEligibleAt: "2026-07-01T00:01:00.000Z"
        }),
        queueJob("cooldown", {
          repo: "owner/cooldown",
          state: "provider_deferred",
          priority: 3,
          nextEligibleAt: "2026-07-01T00:10:00.000Z"
        })
      ]
    });

    expect(capacityBlocked.queued).toMatchObject({
      providerDeferred: 2,
      retryableProviderDeferred: 1
    });
    expect(capacityBlocked.providerDeferred).toMatchObject({
      total: 2,
      retryable: 1,
      readyToRetry: 0,
      waitingCooldown: 1,
      waitingProviderCapacity: 1
    });

    const ready = buildReviewBudgetStatus({
      config,
      now,
      jobs: [
        queueJob("retryable", {
          repo: "owner/retryable",
          state: "provider_deferred",
          priority: 2,
          nextEligibleAt: "2026-07-01T00:01:00.000Z"
        })
      ]
    });

    expect(ready.providerDeferred).toMatchObject({
      total: 1,
      retryable: 1,
      readyToRetry: 1,
      waitingCooldown: 0,
      waitingProviderCapacity: 0
    });
    expect(ready.wouldLease).toEqual([
      expect.objectContaining({
        jobId: "retryable",
        state: "provider_deferred",
        nextEligibleAt: "2026-07-01T00:01:00.000Z"
      })
    ]);
  });

  it("uses repo-profile scheduler active caps in budget projection", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-review-budget-repo-profile-"));
    roots.push(root);
    const config = {
      ...minimalConfig(root),
      reviewScheduler: {
        enabled: true,
        maxProviderActive: 3,
        maxOrgActive: 10,
        maxRepoActive: 3,
        maxQueuedPerRepo: 10,
        manualCommandReserve: 0,
        backgroundPriority: 50
      },
      repoProfiles: {
        repos: {
          "100yenadmin/Lossless-Codex-Orchestrator-LCO": {
            reviewScheduler: {
              maxActiveHeads: 1
            }
          }
        }
      }
    };

    const status = buildReviewBudgetStatus({
      config,
      now: new Date("2026-07-04T00:00:00.000Z"),
      jobs: [
        queueJob("lco-active", {
          repo: "100yenadmin/Lossless-Codex-Orchestrator-LCO",
          state: "running",
          priority: 1,
          updatedAt: "2026-07-04T00:00:00.000Z"
        }),
        queueJob("lco-queued", { repo: "100yenadmin/Lossless-Codex-Orchestrator-LCO", state: "queued", priority: 2 }),
        queueJob("self-queued", { repo: "electricsheephq/evaos-code-review-bot-neondiff", state: "queued", priority: 3 })
      ]
    });

    expect(status.active.byRepo).toEqual([
      expect.objectContaining({
        name: "100yenadmin/Lossless-Codex-Orchestrator-LCO",
        active: 1,
        limit: 1,
        remaining: 0
      })
    ]);
    expect(status.delayed).toEqual([
      expect.objectContaining({ jobId: "lco-queued", reason: "repo_capacity" })
    ]);
    expect(status.wouldLease).toEqual([
      expect.objectContaining({ jobId: "self-queued" })
    ]);
  });

  it("does not count expired leased or running jobs against active capacity", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-review-budget-expired-lease-"));
    roots.push(root);
    const config = {
      ...minimalConfig(root),
      reviewConcurrency: {
        maxActiveRuns: 1,
        leaseTtlMs: 60_000
      },
      reviewScheduler: {
        enabled: true,
        maxProviderActive: 1,
        maxOrgActive: 1,
        maxRepoActive: 1,
        maxQueuedPerRepo: 10,
        manualCommandReserve: 0,
        backgroundPriority: 50
      }
    };

    const status = buildReviewBudgetStatus({
      config,
      now: new Date("2026-07-01T00:05:00.000Z"),
      jobs: [
        queueJob("expired-running", {
          repo: "owner/repo-a",
          state: "running",
          leaseId: "old-lease",
          leaseExpiresAt: "2026-07-01T00:04:00.000Z",
          priority: 10
        }),
        queueJob("fresh-queued", {
          repo: "owner/repo-b",
          state: "queued",
          priority: 20
        })
      ]
    });

    expect(status.active.total).toBe(0);
    expect(status.queued.total).toBe(2);
    expect(status.wouldLease).toEqual([
      expect.objectContaining({
        jobId: "expired-running",
        repo: "owner/repo-a"
      })
    ]);
    expect(status.delayedByReason).toEqual({
      provider_capacity: 1
    });
  });

  it("uses SQLite leases to cap overlapping worker entrypoints", async () => {
    const store = createStore(roots);
    const root = mkdtempSync(join(tmpdir(), "evaos-review-budget-config-"));
    roots.push(root);
    const lease = store.tryAcquireReviewRunLease(1, 60_000, new Date());
    expect(lease).toBeDefined();

    const budget = new ReviewRunBudget(5);
    const status = await reviewPull({
      config: {
        ...minimalConfig(root),
        reviewConcurrency: {
          maxActiveRuns: 1,
          leaseTtlMs: 60_000
        }
      },
      github: {} as GitHubApi,
      state: store,
      repo: "electricsheephq/WorldOS",
      pull: pull(1190, "new-head"),
      dryRun: true,
      useZCode: false,
      licenseAdmission: testLicenseAdmission,
      budget
    });

    expect(status).toBe("skipped_capacity");
    expect(budget.activeRuns).toBe(0);
    store.close();
  });
});

function createStore(roots: string[]): ReviewStateStore {
  const root = mkdtempSync(join(tmpdir(), "evaos-review-budget-"));
  roots.push(root);
  return new ReviewStateStore(join(root, "state.sqlite"));
}

function minimalConfig(root: string): BotConfig {
  return {
    pilotRepos: ["electricsheephq/WorldOS"],
    pollIntervalMs: 60_000,
    skipDrafts: true,
    workRoot: join(root, "work"),
    statePath: join(root, "state.sqlite"),
    evidenceDir: join(root, "evidence"),
    activation: {
      reviewExistingOpenPrsOnActivation: false
    },
    reviewConcurrency: {
      maxActiveRuns: 5,
      leaseTtlMs: 60_000
    },
    providerCooldown: {
      enabled: true,
      durationMs: 15 * 60_000,
      requestRateLimitDurationMs: 5 * 60_000,
      overloadDurationMs: 2 * 60_000,
      quotaDurationMs: 30 * 60_000,
      overloadBackoffMaxDurationMs: 10 * 60_000,
      overloadBackoffJitterMs: 0,
      transientRetryAttempts: 2,
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
      timeoutMs: 1,
      maxPatchBytes: 1,
      retryMaxRetries: 0
    },
    github: {}
  };
}

function pull(number: number, sha: string): PullRequestSummary {
  return {
    number,
    title: `PR ${number}`,
    draft: false,
    head: {
      sha,
      ref: `pr-${number}`
    },
    base: {
      sha: "base",
      ref: "main",
      repo: {
        full_name: "owner/repo",
        private: true
      }
    },
    html_url: `https://github.test/owner/repo/pull/${number}`
  };
}

function queueJob(
  jobId: string,
  input: Partial<ReviewQueueJobRecord> & {
    repo: string;
    state: ReviewQueueJobRecord["state"];
  }
): ReviewQueueJobRecord {
  const [org] = input.repo.split("/");
  return {
    jobId,
    attemptId: `attempt-${jobId}`,
    source: input.source ?? "automatic",
    lane: input.lane ?? "background",
    repo: input.repo,
    org: input.org ?? org ?? "owner",
    pullNumber: input.pullNumber ?? 1,
    headSha: input.headSha ?? `head-${jobId}`,
    ...(input.baseSha ? { baseSha: input.baseSha } : {}),
    providerId: input.providerId ?? "zai-coding-plan",
    priority: input.priority ?? 50,
    state: input.state,
    ...(input.nextEligibleAt ? { nextEligibleAt: input.nextEligibleAt } : {}),
    ...(input.leaseId ? { leaseId: input.leaseId } : {}),
    ...(input.leaseExpiresAt ? { leaseExpiresAt: input.leaseExpiresAt } : {}),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.commentId ? { commentId: input.commentId } : {}),
    ...(input.reviewUrl ? { reviewUrl: input.reviewUrl } : {}),
    ...(input.lastError ? { lastError: input.lastError } : {}),
    createdAt: input.createdAt ?? "2026-07-01T00:00:00.000Z",
    updatedAt: input.updatedAt ?? "2026-07-01T00:00:00.000Z",
    ...(input.startedAt ? { startedAt: input.startedAt } : {}),
    ...(input.finishedAt ? { finishedAt: input.finishedAt } : {})
  };
}
