import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanupReviewWorktreesFromConfig,
  runDaemonCycle as runDaemonCycleImpl,
  shouldExitDaemonAfterFailedCycle,
  waitForIssueEnrichmentPass,
  waitForOperatorCommentPass,
  type RunDaemonCycleOptions
} from "../src/daemon.js";
import type { BotConfig } from "../src/config.js";
import type { IssueEnrichmentCycleResult } from "../src/issue-enrichment.js";
import { requireActiveDaemonCycleAdmissions, type ProductionLicenseAdmission } from "../src/license-admission.js";
import { withRuntimeGitHubCredentials } from "../src/runtime-github-credentials.js";
import { ReviewStateStore } from "../src/state.js";
import { runScheduledObservePass } from "../src/outcome-observer.js";
import { DEFAULT_BOT_LOGIN, GitHubApi } from "../src/github.js";
import { findPostedCiReview } from "../src/ci-mode.js";

// Cycles no longer await issue enrichment; settle the detached pass so each test sees its own lane output.
const runDaemonCycle = async (input: RunDaemonCycleOptions) => {
  const result = await runDaemonCycleImpl({
    ...input,
    recordFailureImpl: input.recordFailureImpl ?? (() => undefined),
    admitDaemonCycleImpl: input.admitDaemonCycleImpl ?? (async () => undefined)
  });
  await waitForIssueEnrichmentPass();
  return result;
};

describe("daemon cycle resilience", () => {
  it("skips unlicensed enrichment once per process and warns once per public-only cycle", async () => {
    const admitted = await requireActiveDaemonCycleAdmissions({ config: {} as NonNullable<BotConfig["license"]>, secretReader: { read: () => undefined } });
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) throw new Error("expected keyless daemon admission");
    const stdout: string[] = [], stderr: string[] = [];
    const enrichment = vi.fn();
    for (const cycle of [1, 2]) {
      const result = await runDaemonCycle({ cycle, dryRun: true, pilotRepos: [], monitoredRepos: [], canaryPulls: [], commandsEnabled: false,
        reviewSchedulerEnabled: true, issueEnrichmentEnabled: true, admitDaemonCycleImpl: async () => admitted.admissions,
        runOnceImpl: async () => ({ ...successfulRunOnceResult(), reviewed: 1, skippedLicenseGate: 2 }),
        issueEnrichmentCycleImpl: enrichment, recordHeartbeatImpl: () => undefined,
        stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) });
      expect(result.ok).toBe(true);
    }
    expect(enrichment).not.toHaveBeenCalled();
    expect(stdout.filter((line) => line.includes("issue enrichment requires a Solo or Team license"))).toHaveLength(1);
    expect(stderr.filter((line) => line.includes("2 pull requests on private, internal or unknown-visibility repositories were skipped: a Solo or Team license is required"))).toHaveLength(2);
  });

  it("fails closed and closes state when the production open-handle probe fails", () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-daemon-cleanup-probe-"));
    const close = vi.spyOn(ReviewStateStore.prototype, "close");
    const config = {
      statePath: join(root, "state.sqlite"),
      workRoot: join(root, "runtime"),
      reviewConcurrency: { maxActiveRuns: 1, leaseTtlMs: 20 * 60_000 },
      worktreeCleanup: { enabled: true, retentionMs: 2 * 60 * 60_000, intervalMs: 30 * 60_000 }
    } as BotConfig;

    try {
      expect(() => cleanupReviewWorktreesFromConfig(
        { dryRun: false },
        {
          loadConfigImpl: () => config,
          probeOpenReviewWorktreePathsImpl: () => ({
            ok: false,
            paths: new Set(),
            error: "lsof unavailable"
          })
        }
      )).toThrow("worktree cleanup open-handle probe failed: lsof unavailable");
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      close.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("honors a live cleanup disablement before opening state or probing handles", () => {
    const probe = vi.fn(() => ({ ok: true, paths: new Set<string>() }));
    const close = vi.spyOn(ReviewStateStore.prototype, "close");
    const config = {
      statePath: "/unused/state.sqlite",
      workRoot: "/runtime",
      reviewConcurrency: { maxActiveRuns: 1, leaseTtlMs: 20 * 60_000 },
      worktreeCleanup: { enabled: false, retentionMs: 2 * 60 * 60_000, intervalMs: 30 * 60_000 }
    } as BotConfig;

    try {
      expect(cleanupReviewWorktreesFromConfig(
        { dryRun: false },
        {
          loadConfigImpl: () => config,
          probeOpenReviewWorktreePathsImpl: probe
        }
      )).toEqual({
        worktreesRoot: "/runtime/worktrees",
        retentionMs: 2 * 60 * 60_000,
        checked: 0,
        deleted: 0,
        skipped: 0,
        errors: 0,
        outcomes: []
      });
      expect(probe).not.toHaveBeenCalled();
      expect(close).not.toHaveBeenCalled();
    } finally {
      close.mockRestore();
    }
  });

  it("exits on activation denial but keeps long-running daemons alive after recoverable runtime failures", () => {
    const admissionDenied = { ok: false, failureKind: "admission_denied", error: "license missing" } as const;
    const runtimeFailure = { ok: false, failureKind: "runtime_failure", error: "transient timeout" } as const;

    expect(shouldExitDaemonAfterFailedCycle(admissionDenied, false)).toBe(true);
    expect(shouldExitDaemonAfterFailedCycle(runtimeFailure, false)).toBe(false);
    expect(shouldExitDaemonAfterFailedCycle(runtimeFailure, true)).toBe(true);
  });

  it("threads one cycle validation bundle into review, retry, and enrichment work", async () => {
    const daemonCycle = { operation: "daemon_cycle" } as ProductionLicenseAdmission;
    const reviewDiscovery = { operation: "review_discovery" } as ProductionLicenseAdmission;
    const issueEnrichment = { operation: "issue_enrichment" } as ProductionLicenseAdmission;
    const seen: unknown[] = [];

    const result = await runDaemonCycleImpl({
      cycle: 1,
      dryRun: true,
      pilotRepos: [],
      monitoredRepos: [],
      canaryPulls: [],
      commandsEnabled: false,
      issueEnrichmentEnabled: true,
      admitDaemonCycleImpl: async () => ({ daemonCycle, reviewDiscovery, issueEnrichment }),
      runOnceImpl: async (options) => {
        seen.push(options.licenseAdmission);
        return successfulRunOnceResult();
      },
      retryProviderCooldownsImpl: async (options) => {
        seen.push(options.licenseAdmission);
        return successfulRetryResult();
      },
      issueEnrichmentCycleImpl: async (options) => {
        seen.push(options.licenseAdmission);
        return successfulIssueEnrichmentCycleResult();
      },
      recordHeartbeatImpl: () => undefined,
      stdout: () => undefined,
      stderr: () => undefined
    });

    await waitForIssueEnrichmentPass();
    expect(result.ok).toBe(true);
    expect(seen).toEqual([issueEnrichment, reviewDiscovery, reviewDiscovery]);
  });

  it("runs a due worktree cleanup before review work and logs bounded outcomes", async () => {
    const calls: string[] = [];
    const stdout: string[] = [];
    const result = await runDaemonCycle({
      cycle: 1,
      dryRun: false,
      pilotRepos: [],
      monitoredRepos: [],
      canaryPulls: [],
      commandsEnabled: false,
      worktreeCleanupDue: true,
      cleanupReviewWorktreesImpl: () => {
        calls.push("cleanup");
        return {
          worktreesRoot: "/tmp/neondiff/runtime/worktrees",
          retentionMs: 7_200_000,
          checked: 2,
          deleted: 1,
          skipped: 1,
          errors: 0,
          outcomes: [
            { path: "/tmp/neondiff/runtime/worktrees/a", status: "deleted", reason: "stale_clean_owned" },
            { path: "/tmp/neondiff/runtime/worktrees/b", status: "skipped", reason: "recent" }
          ]
        };
      },
      runOnceImpl: async () => {
        calls.push("review");
        return successfulRunOnceResult();
      },
      retryProviderCooldownsImpl: async () => successfulRetryResult(),
      recordHeartbeatImpl: () => undefined,
      stdout: (line) => stdout.push(line),
      stderr: () => undefined
    });

    expect(result.ok).toBe(true);
    expect(calls).toEqual(["cleanup", "review"]);
    expect(JSON.parse(stdout[0]!)).toMatchObject({
      event: "daemon_worktree_cleanup",
      result: {
        deleted: 1,
        skipped: 1,
        errors: 0,
        outcomeCounts: {
          "deleted:stale_clean_owned": 1,
          "skipped:recent": 1
        }
      }
    });
  });

  it("defers a due worktree cleanup while an enrichment pass is in flight and runs it on the first clear cycle", async () => {
    const stdout: string[] = [];
    const calls: string[] = [];
    let releaseIssue!: () => void;
    const issueBarrier = new Promise<void>((resolve) => { releaseIssue = resolve; });
    const cycle = (number: number, worktreeCleanupDue: boolean, issueEnrichmentEnabled = true) => runDaemonCycleImpl({
      cycle: number, dryRun: false, pilotRepos: [], monitoredRepos: [], canaryPulls: [], commandsEnabled: false,
      reviewSchedulerEnabled: true, issueEnrichmentEnabled, worktreeCleanupDue, admitDaemonCycleImpl: async () => undefined,
      cleanupReviewWorktreesImpl: () => { calls.push(`cleanup:${number}`); return emptyCleanupSummary(); },
      runOnceImpl: async () => successfulRunOnceResult(),
      issueEnrichmentCycleImpl: async () => { calls.push(`pass:${number}`); await issueBarrier; return successfulIssueEnrichmentCycleResult(); },
      recordHeartbeatImpl: () => undefined, stdout: (line) => stdout.push(line), stderr: () => undefined
    });
    try {
      await cycle(31, false);
      await cycle(32, true);
      await cycle(33, false);
      expect(calls).toEqual(["pass:31"]);
      expect(stdout.map((line) => JSON.parse(line)).filter((event) => event.event === "daemon_worktree_cleanup_deferred")).toEqual([
        expect.objectContaining({ cycle: 32, dryRun: false, startedCycle: 31 }),
        expect.objectContaining({ cycle: 33, dryRun: false, startedCycle: 31 })
      ]);
    } finally {
      releaseIssue();
      await waitForIssueEnrichmentPass();
    }
    await cycle(34, false, false);
    await cycle(35, false, false);
    expect(calls).toEqual(["pass:31", "cleanup:34"]);
  });

  it("runs a due cleanup on its cycle, before that cycle starts a pass, when no pass is in flight", async () => {
    const calls: string[] = [];
    await runDaemonCycleImpl({
      cycle: 36, dryRun: false, pilotRepos: [], monitoredRepos: [], canaryPulls: [], commandsEnabled: false,
      reviewSchedulerEnabled: true, issueEnrichmentEnabled: true, worktreeCleanupDue: true, admitDaemonCycleImpl: async () => undefined,
      cleanupReviewWorktreesImpl: () => { calls.push("cleanup"); return emptyCleanupSummary(); },
      runOnceImpl: async () => successfulRunOnceResult(),
      issueEnrichmentCycleImpl: async () => { calls.push("pass"); return successfulIssueEnrichmentCycleResult(); },
      recordHeartbeatImpl: () => undefined, stdout: () => undefined, stderr: () => undefined
    });
    await waitForIssueEnrichmentPass();
    expect(calls).toEqual(["cleanup", "pass"]);
  });

  it("keeps the review cycle alive when worktree cleanup fails closed", async () => {
    const stderr: string[] = [];
    let reviewRan = false;
    const result = await runDaemonCycle({
      cycle: 1,
      dryRun: false,
      pilotRepos: [],
      monitoredRepos: [],
      canaryPulls: [],
      commandsEnabled: false,
      worktreeCleanupDue: true,
      cleanupReviewWorktreesImpl: () => { throw new Error("open-handle probe unavailable"); },
      runOnceImpl: async () => {
        reviewRan = true;
        return successfulRunOnceResult();
      },
      retryProviderCooldownsImpl: async () => successfulRetryResult(),
      recordHeartbeatImpl: () => undefined,
      stdout: () => undefined,
      stderr: (line) => stderr.push(line)
    });

    expect(result.ok).toBe(true);
    expect(reviewRan).toBe(true);
    expect(JSON.parse(stderr[0]!)).toMatchObject({
      event: "daemon_worktree_cleanup_failed",
      level: "error",
      error: "open-handle probe unavailable"
    });
  });

  it("denies a cycle before heartbeat, review, retry, or enrichment work", async () => {
    const calls = { heartbeat: 0, review: 0, retry: 0, enrichment: 0 };
    const stderr: string[] = [];
    const recordFailure = vi.fn(() => expect(stderr).toHaveLength(1));
    const result = await runDaemonCycleImpl({
      cycle: 1,
      dryRun: false,
      pilotRepos: ["electricsheephq/WorldOS"],
      monitoredRepos: ["electricsheephq/WorldOS"],
      canaryPulls: [],
      commandsEnabled: false,
      issueEnrichmentEnabled: true,
      admitDaemonCycleImpl: async () => { throw new Error("license missing: no license key is stored"); },
      recordFailureImpl: recordFailure,
      recordHeartbeatImpl: () => { calls.heartbeat += 1; },
      runOnceImpl: async () => { calls.review += 1; throw new Error("must not run"); },
      retryProviderCooldownsImpl: async () => { calls.retry += 1; throw new Error("must not run"); },
      issueEnrichmentCycleImpl: async () => { calls.enrichment += 1; throw new Error("must not run"); },
      stdout: () => undefined,
      stderr: (line) => stderr.push(line)
    });

    expect(result).toEqual({
      ok: false,
      failureKind: "admission_denied",
      error: "license missing: no license key is stored"
    });
    expect(calls).toEqual({ heartbeat: 0, review: 0, retry: 0, enrichment: 0 });
    expect(stderr).toHaveLength(1);
    expect(recordFailure).toHaveBeenCalledExactlyOnceWith({
      failureKind: "admission_denied", message: "license missing: no license key is stored"
    });
  });

  it.each(["admission_denied", "runtime_failure"] as const)("preserves the %s result when failure recording throws", async (failureKind) => {
    const run = (recordFailureImpl: NonNullable<RunDaemonCycleOptions["recordFailureImpl"]>) => runDaemonCycle({
      cycle: 9, dryRun: true, pilotRepos: [], monitoredRepos: [], canaryPulls: [], commandsEnabled: false,
      admitDaemonCycleImpl: async () => {
        if (failureKind === "admission_denied") throw new Error("cycle failed");
      },
      runOnceImpl: async () => { throw new Error("cycle failed"); },
      recordFailureImpl, recordHeartbeatImpl: () => undefined,
      stdout: () => undefined, stderr: () => undefined
    });
    const expected = await run(() => undefined);
    const throwing = vi.fn(() => { throw new Error("state unavailable"); });
    expect(await run(throwing)).toEqual(expected);
    expect(expected).toEqual({ ok: false, failureKind, error: "cycle failed" });
    expect(throwing).toHaveBeenCalledTimes(1);
    // An async recorder's rejection must stay inside the guard, not surface as an unhandled rejection.
    // A plain function on purpose: vi.fn() observes returned promises, which would mark the rejection handled.
    let rejectingCalls = 0;
    const rejecting = async () => { rejectingCalls += 1; throw new Error("state unavailable"); };
    expect(await run(rejecting)).toEqual(expected);
    expect(rejectingCalls).toBe(1);
  });

  it.each(["admission_denied", "runtime_failure"] as const)("persists %s through the configured default recorder", async (failureKind) => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-daemon-failure-recorder-"));
    const configPath = join(root, "config.json");
    const statePath = join(root, "state.sqlite");
    writeFileSync(configPath, JSON.stringify({ statePath }));
    const stderr: string[] = [];
    let heartbeatRunId: string | undefined;
    const run = () => runDaemonCycleImpl({
      cycle: 10, dryRun: true, configPath, pilotRepos: [], monitoredRepos: [], canaryPulls: [], commandsEnabled: false,
      admitDaemonCycleImpl: async () => {
        if (failureKind === "admission_denied") throw new Error("cycle failed");
      },
      runOnceImpl: async () => { throw new Error("cycle failed"); },
      recordHeartbeatImpl: (_event, _error, runId) => { heartbeatRunId = runId; },
      stdout: () => undefined, stderr: (line) => stderr.push(line)
    });
    try {
      const result = await run();
      expect(result).toEqual({ ok: false, failureKind, error: "cycle failed" });
      const store = new ReviewStateStore(statePath);
      try {
        expect(store.listRecentDaemonCycleFailures()).toEqual([{
          recordedAt: expect.any(String), cycle: 10, failureKind, message: "cycle failed",
          ...(failureKind === "runtime_failure" ? { runId: heartbeatRunId } : {})
        }]);
      } finally { store.close(); }
      expect(stderr.map((line) => JSON.parse(line).event)).toEqual(["daemon_cycle_failed"]);
      // A config load failure must emit one diagnostic and preserve the same cycle result.
      writeFileSync(configPath, "{");
      stderr.length = 0;
      expect(await run()).toEqual(result);
      expect(stderr.map((line) => JSON.parse(line).event)).toEqual(["daemon_cycle_failed", "daemon_failure_record_failed"]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("logs runtime cycle failures without throwing out of the daemon loop", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    const result = await runDaemonCycle({
      cycle: 8,
      dryRun: false,
      configPath: "/config.json",
      pilotRepos: ["electricsheephq/WorldOS"],
      monitoredRepos: ["electricsheephq/WorldOS"],
      canaryPulls: [],
      commandsEnabled: false,
      runOnceImpl: async () => {
        throw new Error("ZCode failed before completion: spawnSync node ETIMEDOUT with ghp_fake_token");
      },
      recordHeartbeatImpl: () => undefined,
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    });

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ failureKind: "runtime_failure" });
    expect(stdout).toHaveLength(1);
    expect(JSON.parse(stdout[0]!)).toMatchObject({
      event: "daemon_cycle_start",
      cycle: 8,
      dryRun: false
    });
    expect(stderr).toHaveLength(1);
    const failure = JSON.parse(stderr[0]!);
    expect(failure).toMatchObject({
      event: "daemon_cycle_failed",
      level: "error",
      cycle: 8,
      dryRun: false
    });
    expect(failure.error).toContain("ETIMEDOUT");
    expect(failure.error).not.toContain("ghp_fake_token");
  });

  it("records start and completion heartbeat events for successful cycles", async () => {
    const heartbeats: Array<{ event: string; runId?: string; reviewLane?: string }> = [];
    const recordFailure = vi.fn();

    const result = await runDaemonCycle({
      cycle: 2,
      dryRun: false,
      pilotRepos: ["electricsheephq/WorldOS"],
      monitoredRepos: ["electricsheephq/WorldOS"],
      canaryPulls: [],
      commandsEnabled: false,
      runOnceImpl: async () => ({
        reposScanned: 1,
        pullsSeen: 1,
        reviewed: 0,
        failed: 0,
        skippedDraft: 0,
        skippedCanary: 0,
        skippedPolicy: 0,
        skippedLicenseGate: 0,
        skippedCommandStop: 0,
        skippedCommandExplain: 0,
        skippedFinishingTouchDraft: 0,
        commandReviewRequested: 0,
        skippedProcessed: 1,
        skippedCapacity: 0,
        skippedContextBudget: 0,
        skippedProviderCooldown: 0,
        skippedStaleHead: 0,
        baselinedExisting: 0,
        policySkips: []
      }),
      retryProviderCooldownsImpl: async () => ({
        ok: true,
        checkedAt: "2026-07-01T00:00:00.000Z",
        dryRun: false,
        expiredOnly: true,
        limit: 1,
        candidates: 0,
        attempted: 0,
        results: [],
        summary: {
          reviewed: 0,
          dryRun: 0,
          remainedCooldown: 0,
          failed: 0,
          skippedStaleHead: 0,
          skippedProcessed: 0,
          skippedClosed: 0,
          skippedCapacity: 0,
          other: 0
        }
      }),
      recordHeartbeatImpl: (event, _error, runId, reviewLane) => {
        heartbeats.push({ event, runId, reviewLane });
      },
      recordFailureImpl: recordFailure,
      stdout: () => undefined,
      stderr: () => undefined
    });

    expect(result.ok).toBe(true);
    expect(heartbeats.map(({ event }) => event)).toEqual(["daemon_cycle_start", "daemon_cycle_progress", "daemon_cycle_complete"]);
    expect(new Set(heartbeats.map(({ runId }) => runId)).size).toBe(1);
    expect(new Set(heartbeats.map(({ reviewLane }) => reviewLane))).toEqual(new Set(["active"]));
    expect(heartbeats[0]?.runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(recordFailure).not.toHaveBeenCalled();
  });

  it("runs one bounded provider cooldown drain after successful review cycles", async () => {
    const events: string[] = [];

    const result = await runDaemonCycle({
      cycle: 4,
      dryRun: false,
      pilotRepos: ["electricsheephq/WorldOS"],
      monitoredRepos: ["electricsheephq/WorldOS"],
      canaryPulls: [],
      commandsEnabled: false,
      runOnceImpl: async () => ({
        reposScanned: 1,
        pullsSeen: 1,
        reviewed: 0,
        failed: 0,
        skippedDraft: 0,
        skippedCanary: 0,
        skippedPolicy: 0,
        skippedLicenseGate: 0,
        skippedCommandStop: 0,
        skippedCommandExplain: 0,
        skippedFinishingTouchDraft: 0,
        commandReviewRequested: 0,
        skippedProcessed: 1,
        skippedCapacity: 0,
        skippedContextBudget: 0,
        skippedProviderCooldown: 0,
        skippedStaleHead: 0,
        baselinedExisting: 0,
        policySkips: []
      }),
      retryProviderCooldownsImpl: async (options) => {
        events.push(`${options.dryRun}:${options.limit}:${options.expiredOnly}`);
        return {
          ok: true,
          checkedAt: "2026-07-01T00:00:00.000Z",
          dryRun: options.dryRun,
          expiredOnly: options.expiredOnly ?? true,
          limit: options.limit ?? 1,
          candidates: 1,
          attempted: 0,
          results: [],
          summary: {
            reviewed: 0,
            dryRun: 0,
            remainedCooldown: 1,
            failed: 0,
            skippedStaleHead: 0,
            skippedProcessed: 0,
            skippedClosed: 0,
            skippedCapacity: 0,
            other: 0
          }
        };
      },
      recordHeartbeatImpl: () => undefined,
      stdout: () => undefined,
      stderr: () => undefined
    });

    expect(result.ok).toBe(true);
    expect(events).toEqual(["false:1:true"]);
  });

  it("skips the legacy provider cooldown retry lane when scheduler owns queue retries", async () => {
    const stdout: string[] = [];
    let retryCalled = false;

    const result = await runDaemonCycle({
      cycle: 5,
      dryRun: false,
      pilotRepos: ["electricsheephq/WorldOS"],
      monitoredRepos: ["electricsheephq/WorldOS"],
      canaryPulls: [],
      commandsEnabled: false,
      reviewSchedulerEnabled: true,
      runOnceImpl: async () => ({
        reposScanned: 1,
        pullsSeen: 1,
        reviewed: 0,
        failed: 0,
        skippedDraft: 0,
        skippedCanary: 0,
        skippedPolicy: 0,
        skippedLicenseGate: 0,
        skippedCommandStop: 0,
        skippedCommandExplain: 0,
        skippedFinishingTouchDraft: 0,
        commandReviewRequested: 0,
        skippedProcessed: 1,
        skippedCapacity: 0,
        skippedContextBudget: 0,
        skippedProviderCooldown: 0,
        skippedStaleHead: 0,
        baselinedExisting: 0,
        policySkips: []
      }),
      retryProviderCooldownsImpl: async () => {
        retryCalled = true;
        throw new Error("legacy retry should not run");
      },
      recordHeartbeatImpl: () => undefined,
      stdout: (line) => stdout.push(line),
      stderr: () => undefined
    });

    expect(result.ok).toBe(true);
    expect(retryCalled).toBe(false);
    expect(stdout.map((line) => JSON.parse(line))).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event: "daemon_provider_cooldown_retry_skipped",
        reason: "review_scheduler_enabled"
      })
    ]));
  });

  it("records a failed heartbeat with the failure message", async () => {
    const heartbeats: Array<{ event: string; error?: string }> = [];
    const runIds: string[] = [];
    const recordFailure = vi.fn();

    const result = await runDaemonCycle({
      cycle: 3,
      dryRun: false,
      pilotRepos: ["electricsheephq/WorldOS"],
      monitoredRepos: ["electricsheephq/WorldOS"],
      canaryPulls: [],
      commandsEnabled: false,
      runOnceImpl: async () => {
        throw new Error("second timeout");
      },
      recordHeartbeatImpl: (event, error, runId) => {
        heartbeats.push({ event, ...(error ? { error } : {}) });
        runIds.push(runId!);
      },
      recordFailureImpl: recordFailure,
      stdout: () => undefined,
      stderr: () => undefined
    });

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ failureKind: "runtime_failure" });
    expect(heartbeats).toEqual([
      { event: "daemon_cycle_start" },
      { event: "daemon_cycle_failed", error: "daemon_cycle_failed" }
    ]);
    expect(new Set(runIds).size).toBe(1);
    expect(recordFailure).toHaveBeenCalledExactlyOnceWith({
      failureKind: "runtime_failure", message: "second timeout", runId: runIds[0]
    });
  });

  it("runs and logs the issue enrichment cycle when the default-off lane is enabled", async () => {
    const stdout: string[] = [];
    let issueCycleCalled = false;

    const result = await runDaemonCycle({
      cycle: 9,
      dryRun: false,
      pilotRepos: ["electricsheephq/WorldOS"],
      monitoredRepos: ["electricsheephq/WorldOS"],
      canaryPulls: [],
      commandsEnabled: false,
      reviewSchedulerEnabled: true,
      issueEnrichmentEnabled: true,
      runOnceImpl: async () => successfulRunOnceResult(),
      issueEnrichmentCycleImpl: async (options) => {
        issueCycleCalled = options.dryRun === false;
        return successfulIssueEnrichmentCycleResult();
      },
      recordHeartbeatImpl: () => undefined,
      stdout: (line) => stdout.push(line),
      stderr: () => undefined
    });

    expect(result.ok).toBe(true);
    expect(issueCycleCalled).toBe(true);
    expect(stdout.map((line) => JSON.parse(line))).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event: "daemon_issue_enrichment",
        phase: "complete",
        cycle: 9,
        receipt: expect.objectContaining({
          ok: true,
          code: "completed",
          counts: expect.objectContaining({ reposScanned: 1, dryRunRecorded: 1 })
        })
      })
    ]));
  });

  it("logs only the sanitized receipt for a resolved issue-lane failure", async () => {
    const stdout: string[] = [], sentinel = "raw-result-ghp_fake_token-https://customer.example";
    const failed = successfulIssueEnrichmentCycleResult() as IssueEnrichmentCycleResult & { rawSentinel: string };
    Object.assign(failed, { ok: false, dryRun: true, rawSentinel: sentinel, status: { ...failed.status, state: "blocked", blockers: ["issue_enrichment_model_runtime_required"] }, summary: { ...failed.summary, readFailures: 1, dryRunRecorded: 0 } });
    const result = await runDaemonCycle({ cycle: 14, dryRun: true, pilotRepos: [], monitoredRepos: [], canaryPulls: [], commandsEnabled: false, reviewSchedulerEnabled: true, issueEnrichmentEnabled: true,
      runOnceImpl: async () => successfulRunOnceResult(), issueEnrichmentCycleImpl: async () => failed, recordHeartbeatImpl: () => undefined,
      stdout: (line) => stdout.push(line), stderr: () => undefined });
    expect(result.ok).toBe(true);
    expect(stdout.map((line) => JSON.parse(line))).toEqual(expect.arrayContaining([expect.objectContaining({ event: "daemon_issue_enrichment", phase: "complete", receipt: expect.objectContaining({ ok: false, code: "result_not_ok", reason: "read_failure" }) })]));
    expect(stdout.join("\n")).not.toContain(sentinel);
  });

  it("holds PR review work while preserving live issue enrichment", async () => {
    const stdout: string[] = [];
    const calls = { review: 0, retry: 0, enrichment: 0 };
    const heartbeatReviewLanes: Array<string | undefined> = [];

    const result = await runDaemonCycle({
      cycle: 13,
      dryRun: false,
      pilotRepos: ["electricsheephq/WorldOS"],
      monitoredRepos: ["electricsheephq/WorldOS"],
      canaryPulls: [],
      commandsEnabled: false,
      reviewLane: "held",
      issueEnrichmentEnabled: true,
      runOnceImpl: async () => {
        calls.review += 1;
        throw new Error("held PR review lane must not run");
      },
      retryProviderCooldownsImpl: async () => {
        calls.retry += 1;
        throw new Error("held PR retry lane must not run");
      },
      issueEnrichmentCycleImpl: async (options) => {
        calls.enrichment += 1;
        expect(options.dryRun).toBe(false);
        return successfulIssueEnrichmentCycleResult();
      },
      recordHeartbeatImpl: (_event, _error, _runId, reviewLane) => {
        heartbeatReviewLanes.push(reviewLane);
      },
      stdout: (line) => stdout.push(line),
      stderr: () => undefined
    });

    expect(result).toEqual({
      ok: true,
      result: {
        reposScanned: 0,
        pullsSeen: 0,
        reviewed: 0,
        failed: 0,
        skippedDraft: 0,
        skippedCanary: 0,
        skippedPolicy: 0,
        skippedLicenseGate: 0,
        skippedCommandStop: 0,
        skippedCommandExplain: 0,
        skippedFinishingTouchDraft: 0,
        commandReviewRequested: 0,
        skippedProcessed: 0,
        skippedCapacity: 0,
        skippedContextBudget: 0,
        skippedProviderCooldown: 0,
        skippedStaleHead: 0,
        baselinedExisting: 0,
        policySkips: []
      }
    });
    expect(calls).toEqual({ review: 0, retry: 0, enrichment: 1 });
    expect(new Set(heartbeatReviewLanes)).toEqual(new Set(["held"]));
    expect(stdout.map((line) => JSON.parse(line))).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event: "daemon_review_lane_held",
        cycle: 13,
        dryRun: false,
        reason: "scoped_review_required"
      }),
      expect.objectContaining({ event: "daemon_issue_enrichment", phase: "complete", cycle: 13 }),
      expect.objectContaining({ event: "daemon_cycle_complete", cycle: 13 })
    ]));
  });

  it.each([false, true])("routes the raw daemon to active reviews and enrichment (scheduler=%s)", async (reviewSchedulerEnabled) => {
    const cliSource = readFileSync(join(process.cwd(), "src/cli.ts"), "utf8");
    const start = cliSource.indexOf("async function runRawDaemon");
    const end = cliSource.indexOf("\nasync function resolveCLIReviewRuntimeCredentials", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);

    const rawDaemonSource = cliSource.slice(start, end);
    expect(rawDaemonSource).toContain('reviewLane: "active"');
    expect(rawDaemonSource).not.toMatch(/args\[(?:"|')review-lane(?:"|')\]/);
    expect(rawDaemonSource).toContain('const dryRun = args["dry-run"] !== "false"');

    const reviewLane = rawDaemonSource.match(/reviewLane: "(active|held)"/)![1] as "active" | "held";
    const stdout: string[] = [];
    const review = vi.fn(async () => successfulRunOnceResult());
    const enrichment = vi.fn(async () => successfulIssueEnrichmentCycleResult());
    const result = await runDaemonCycle({
      cycle: 1,
      dryRun: true,
      reviewLane,
      pilotRepos: ["owner/repo"],
      monitoredRepos: ["owner/repo"],
      canaryPulls: [],
      commandsEnabled: false,
      reviewSchedulerEnabled,
      issueEnrichmentEnabled: true,
      runOnceImpl: review,
      retryProviderCooldownsImpl: async () => successfulRetryResult(),
      issueEnrichmentCycleImpl: enrichment,
      recordHeartbeatImpl: () => undefined,
      stdout: (line) => stdout.push(line),
      stderr: () => undefined
    });

    expect(result.ok).toBe(true);
    expect(review).toHaveBeenCalledWith({ dryRun: true, configPath: undefined });
    expect(enrichment).toHaveBeenCalledWith({ dryRun: true, configPath: undefined });
    expect(stdout.map((line) => JSON.parse(line).event)).not.toContain("daemon_review_lane_held");
  });

  it("starts issue enrichment while the review batch is still unresolved", async () => {
    const stdout: string[] = [];
    let releaseReview!: () => void;
    const reviewBarrier = new Promise<void>((resolve) => { releaseReview = resolve; });
    let issueStarted = false;

    const cycle = runDaemonCycle({
      cycle: 11,
      dryRun: false,
      pilotRepos: [],
      monitoredRepos: [],
      canaryPulls: [],
      commandsEnabled: false,
      reviewSchedulerEnabled: true,
      issueEnrichmentEnabled: true,
      runOnceImpl: async () => {
        await reviewBarrier;
        return successfulRunOnceResult();
      },
      issueEnrichmentCycleImpl: async () => {
        issueStarted = true;
        return successfulIssueEnrichmentCycleResult();
      },
      recordHeartbeatImpl: () => undefined,
      stdout: (line) => stdout.push(line),
      stderr: () => undefined
    });

    let overlapError: unknown;
    try {
      await vi.waitFor(() => expect(issueStarted).toBe(true), { timeout: 100 });
    } catch (error) {
      overlapError = error;
    } finally {
      releaseReview();
    }
    const result = await cycle;
    if (overlapError) throw overlapError;

    expect(result.ok).toBe(true);
    expect(stdout.map((line) => JSON.parse(line))).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: "daemon_issue_enrichment_start", cycle: 11 }),
      expect.objectContaining({ event: "daemon_issue_enrichment", phase: "complete", cycle: 11 })
    ]));
  });

  it("returns a review failure without waiting for the issue lane", async () => {
    let releaseIssue!: () => void;
    const issueBarrier = new Promise<void>((resolve) => { releaseIssue = resolve; });
    let issueSettled = false;
    const recordFailure = vi.fn();

    const result = await runDaemonCycleImpl({
      cycle: 12,
      dryRun: false,
      pilotRepos: [],
      monitoredRepos: [],
      canaryPulls: [],
      commandsEnabled: false,
      reviewSchedulerEnabled: true,
      issueEnrichmentEnabled: true,
      admitDaemonCycleImpl: async () => undefined,
      runOnceImpl: async () => { throw new Error("review batch failed"); },
      issueEnrichmentCycleImpl: async () => {
        await issueBarrier;
        issueSettled = true;
        return successfulIssueEnrichmentCycleResult();
      },
      recordHeartbeatImpl: () => undefined,
      recordFailureImpl: recordFailure,
      stdout: () => undefined,
      stderr: () => undefined
    });

    expect(result).toMatchObject({ ok: false, failureKind: "runtime_failure", error: "review batch failed" });
    expect(recordFailure).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      failureKind: "runtime_failure", message: "review batch failed"
    }));
    expect(issueSettled).toBe(false);
    releaseIssue();
    await waitForIssueEnrichmentPass();
    expect(issueSettled).toBe(true);
  });

  it("does not hold the next cycle's review run behind a slow enrichment pass, and never overlaps passes", async () => {
    const stdout: string[] = [];
    let releaseIssue!: () => void;
    const issueBarrier = new Promise<void>((resolve) => { releaseIssue = resolve; });
    let active = 0, maxActive = 0, passes = 0;
    const reviewRuns: number[] = [];
    const heartbeats: string[] = [];
    const cycle = (number: number, reviewLane: "active" | "held" = "active") => runDaemonCycleImpl({
      cycle: number, dryRun: false, reviewLane, pilotRepos: [], monitoredRepos: [], canaryPulls: [], commandsEnabled: false,
      reviewSchedulerEnabled: true, issueEnrichmentEnabled: true, admitDaemonCycleImpl: async () => undefined,
      runOnceImpl: async () => { reviewRuns.push(number); return successfulRunOnceResult(); },
      issueEnrichmentCycleImpl: async () => {
        passes += 1; active += 1; maxActive = Math.max(maxActive, active);
        try { if (passes === 1) await issueBarrier; return successfulIssueEnrichmentCycleResult(); } finally { active -= 1; }
      },
      recordHeartbeatImpl: (event) => { heartbeats.push(event); },
      stdout: (line) => stdout.push(line), stderr: () => undefined
    });

    expect((await cycle(1)).ok).toBe(true);
    expect((await cycle(2)).ok).toBe(true);
    expect((await cycle(3, "held")).ok).toBe(true);
    expect(reviewRuns).toEqual([1, 2]);
    expect(passes).toBe(1);
    expect(heartbeats.filter((event) => event === "daemon_cycle_complete")).toHaveLength(3);
    const events = stdout.map((line) => JSON.parse(line));
    expect(events.filter((event) => event.event === "daemon_issue_enrichment_in_flight")).toEqual([
      expect.objectContaining({ cycle: 2, startedCycle: 1 }),
      expect.objectContaining({ cycle: 3, startedCycle: 1 })
    ]);
    expect(events.some((event) => event.event === "daemon_issue_enrichment" && event.phase === "complete")).toBe(false);

    releaseIssue();
    await waitForIssueEnrichmentPass();
    expect((await cycle(4)).ok).toBe(true);
    await waitForIssueEnrichmentPass();
    expect(passes).toBe(2);
    expect(maxActive).toBe(1);
    expect(stdout.map((line) => JSON.parse(line)).filter((event) => event.event === "daemon_issue_enrichment")
      .map((event) => event.cycle)).toEqual([1, 4]);
  });

  it("logs a rejected detached pass without an unhandled rejection, even when the logger throws", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const stderr: string[] = [];
      let rejectIssue!: (error: Error) => void;
      const issueBarrier = new Promise<never>((_resolve, reject) => { rejectIssue = reject; });
      const base = {
        dryRun: false, pilotRepos: [], monitoredRepos: [], canaryPulls: [], commandsEnabled: false,
        reviewSchedulerEnabled: true, issueEnrichmentEnabled: true, admitDaemonCycleImpl: async () => undefined,
        runOnceImpl: async () => successfulRunOnceResult(), recordHeartbeatImpl: () => undefined, stdout: () => undefined
      };
      const result = await runDaemonCycleImpl({ ...base, cycle: 21, issueEnrichmentCycleImpl: () => issueBarrier,
        stderr: (line) => stderr.push(line) });
      expect(result.ok).toBe(true);
      rejectIssue(new Error("late failure ghp_fake_token"));
      await waitForIssueEnrichmentPass();
      expect(stderr.map((line) => JSON.parse(line))).toEqual([expect.objectContaining({
        event: "daemon_issue_enrichment_failed", level: "error", cycle: 21,
        receipt: expect.objectContaining({ ok: false, code: "cycle_failed" })
      })]);
      expect(stderr.join("\n")).not.toContain("ghp_fake_token");

      await runDaemonCycleImpl({ ...base, cycle: 22, issueEnrichmentCycleImpl: async () => { throw new Error("boom"); },
        stderr: () => { throw new Error("logger down"); } });
      await waitForIssueEnrichmentPass();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("keeps the daemon cycle healthy when issue enrichment fails", async () => {
    const stderr: string[] = [];

    const result = await runDaemonCycle({
      cycle: 10,
      dryRun: false,
      pilotRepos: ["electricsheephq/WorldOS"],
      monitoredRepos: ["electricsheephq/WorldOS"],
      canaryPulls: [],
      commandsEnabled: false,
      reviewSchedulerEnabled: true,
      issueEnrichmentEnabled: true,
      runOnceImpl: async () => successfulRunOnceResult(),
      issueEnrichmentCycleImpl: async () => {
        throw new Error("issue enrichment failed with ghp_fake_token");
      },
      recordHeartbeatImpl: () => undefined,
      stdout: () => undefined,
      stderr: (line) => stderr.push(line)
    });

    expect(result.ok).toBe(true);
    expect(stderr).toHaveLength(1);
    const failure = JSON.parse(stderr[0]!);
    expect(failure).toMatchObject({
      event: "daemon_issue_enrichment_failed",
      level: "error",
      cycle: 10,
      receipt: { ok: false, stage: "issue_enrichment", code: "cycle_failed", reason: "unknown_failure" }
    });
    expect(failure).not.toHaveProperty("error");
    expect(stderr.join("\n")).not.toContain("ghp_fake_token");
  });
});

describe("daemon operator comments", () => {
  const roots: string[] = [];
  const repo = "owner/repo";
  const user = { login: DEFAULT_BOT_LOGIN, type: "Bot" };
  const commentUrl = "https://github.test/owner/repo/pull/7#issuecomment-900";
  const body = "Follow-up shipped.";
  let privateKey: string | undefined;

  afterEach(async () => {
    await waitForOperatorCommentPass();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  async function fixture(options: { repo?: string; botLogin?: string | null; throwLoggers?: boolean } = {}) {
    const root = mkdtempSync(join(tmpdir(), "neondiff-operator-comment-daemon-"));
    roots.push(root);
    const statePath = join(root, "state.sqlite");
    const configPath = join(root, "config.json");
    const configuredRepo = options.repo ?? repo;
    writeFileSync(configPath, JSON.stringify({
      statePath, pilotRepos: [configuredRepo], commands: { trustedAuthors: ["*"] },
      github: { botLogin: options.botLogin === null ? undefined : options.botLogin ?? user.login }
    }));
    const admitted = await requireActiveDaemonCycleAdmissions({
      config: {} as NonNullable<BotConfig["license"]>, secretReader: { read: () => undefined }
    });
    if (!admitted.ok) throw new Error("expected public daemon admission");
    const credentials = {
      appId: "123",
      privateKey: privateKey ??= generateKeyPairSync("rsa", { modulusLength: 2048 })
        .privateKey.export({ type: "pkcs1", format: "pem" }).toString()
    };
    const postCalls: Array<{ path: string; body: string; auth: string | null }> = [];
    const order: string[] = [];
    const logs: string[] = [];
    const rest = {
      visibility: "public", postStatus: 201,
      respond: (_path: string, _init?: RequestInit): Response | undefined => undefined,
      page: (_page: number): unknown[] => [],
      waitBeforePost: Promise.resolve()
    };
    const fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(input);
      const path = url.pathname;
      const response = rest.respond(path, init);
      if (response) return response;
      if (path === `/repos/${configuredRepo}/installation`) return Response.json({ id: 123 });
      if (path === "/app/installations/123/access_tokens") {
        return Response.json({ token: "test-installation", expires_at: "2999-01-01T00:00:00Z" });
      }
      if (path === `/repos/${configuredRepo}`) return Response.json({ full_name: configuredRepo, visibility: rest.visibility });
      if (path === `/repos/${repo}/pulls/7`) return Response.json({
        number: 7, state: "closed", merged_at: "2026-07-06T10:00:00Z",
        head: { sha: "a".repeat(40) }, base: { repo: { visibility: "public" } }
      });
      if (path.startsWith(`/repos/${configuredRepo}/issues/`) && path.endsWith("/comments")) {
        if (init?.method === "POST") {
          const sentBody = JSON.parse(String(init.body)).body;
          postCalls.push({ path, body: sentBody, auth: new Headers(init?.headers).get("authorization") });
          order.push("post");
          await rest.waitBeforePost;
          return Response.json({ id: 900, html_url: commentUrl }, { status: rest.postStatus });
        }
        return Response.json(rest.page(Number(url.searchParams.get("page"))));
      }
      if (path === `/repos/${repo}/pulls/7/reviews`) return Response.json([]);
      throw new Error(`unexpected fixture request: ${path}`);
    });
    vi.stubGlobal("fetch", fetch);

    let cycle = 0;
    const runCycle = (dryRun = false, settle = true) => withRuntimeGitHubCredentials(credentials, async () => {
      const result = await runDaemonCycleImpl({
        cycle: ++cycle, dryRun, configPath, pilotRepos: [repo], monitoredRepos: [repo],
        canaryPulls: [], commandsEnabled: false,
        admitDaemonCycleImpl: async () => admitted.admissions,
        recordHeartbeatImpl: () => undefined,
        runOnceImpl: async () => { order.push("review"); return { ...successfulRunOnceResult(), reviewed: 1 }; },
        retryProviderCooldownsImpl: async () => { order.push("cooldown"); return successfulRetryResult(); },
        stdout: (line) => {
          if (options.throwLoggers && line.includes("daemon_operator_comment_posted")) throw new TypeError("fixture");
          logs.push(line);
        },
        stderr: (line) => {
          logs.push(line);
          if (options.throwLoggers && line.includes("daemon_operator_comment_pass_failed")) throw new Error("fixture");
        }
      });
      if (settle) await waitForOperatorCommentPass();
      return result;
    });
    const enqueue = (text = body, number = 7) => {
      const state = new ReviewStateStore(statePath);
      try {
        return state.enqueueOperatorComment({ repo, number, body: text, bodySha256: createHash("sha256").update(text).digest("hex") });
      } finally { state.close(); }
    };
    const status = (id: string) => ReviewStateStore.readOperatorCommentRequests(statePath, { id })[0];
    return { root, statePath, enqueue, status, runCycle, rest, fetch, postCalls, logs, order, credentials };
  }

  it("posts once as the App to a closed PR after review work and leaves the review and outcome ledgers untouched", async () => {
    const f = await fixture();
    const request = f.enqueue();
    const github = new GitHubApi({ ...f.credentials, botLogin: user.login });
    expect(await github.getPull(repo, 7)).toMatchObject({ state: "closed" });
    const result = await f.runCycle();
    expect(result).toMatchObject({ ok: true, result: { reviewed: 1 } });
    expect(f.order).toEqual(["review", "cooldown", "post"]);
    await f.runCycle();
    const postedBody = `${body}\n\n<!-- neondiff-operator-comment:${request.id}:${request.bodySha256} -->`;
    expect(f.postCalls).toEqual([{ path: "/repos/owner/repo/issues/7/comments", auth: "Bearer test-installation", body: postedBody }]);
    expect(f.status(request.id)).toMatchObject({ status: "posted", commentId: 900, commentUrl });
    expect(f.logs.filter((line) => line.includes("daemon_operator_comment_posted"))).toHaveLength(1);
    expect(f.logs.join("\n")).not.toContain(body);
    f.rest.page = () => [{ id: 900, body: postedBody, html_url: commentUrl, user }];
    expect(await github.listIssueComments(repo, 7)).toHaveLength(1);
    expect(await findPostedCiReview(github, repo, 7, "a".repeat(40))).toBeUndefined();
    const state = new ReviewStateStore(f.statePath);
    try {
      const fetchOutcome = vi.fn();
      expect(await runScheduledObservePass({
        state, config: { enabled: true, intervalMinutes: 1, lookbackDays: 30, maxPullsPerCycle: 5, perRepoCooldownMinutes: 1 },
        evidenceDir: join(f.root, "observe"), fetchOutcome
      })).toMatchObject({ targets: 0, labeled: 0 });
      expect(fetchOutcome).not.toHaveBeenCalled();
      expect(state.listReviewFindings()).toEqual([]);
      expect(state.listFindingOutcomeLabels()).toEqual([]);
    } finally { state.close(); }
  });

  it.each([
    ["a Docker restart with the same PID", process.pid, 0],
    ["an expired claim from another PID", process.pid + 1, 600_001]
  ])("reclaims after %s and reconciles an App marker on a later page", async (_reason, pid, age) => {
    const f = await fixture();
    const request = f.enqueue();
    const db = new DatabaseSync(f.statePath);
    try {
      db.prepare("update operator_comment_requests set claimed_by_pid = ?, claimed_at = ? where id = ?")
        .run(pid, new Date(Date.now() - age).toISOString(), request.id);
    } finally { db.close(); }
    expect(f.status(request.id)?.status).toBe("claimed");
    const marker = `<!-- neondiff-operator-comment:${request.id}:${request.bodySha256} -->`;
    f.rest.page = (page) => page === 1
      ? Array.from({ length: 100 }, (_, index) => ({ id: index + 1, body: marker, user: { login: "human", type: "User" } }))
      : [{ id: 900, body: marker, user, html_url: commentUrl }];
    await f.runCycle();
    expect(f.fetch.mock.calls.filter(([url]) => new URL(url).pathname.endsWith("/issues/7/comments"))).toHaveLength(2);
    expect(f.postCalls).toHaveLength(0);
    expect(f.status(request.id)).toMatchObject({ status: "posted", commentId: 900, commentUrl });
  });

  it("matches a customer-owned App ID without botLogin and ignores a different App with the default login", async () => {
    const f = await fixture({ botLogin: null });
    const request = f.enqueue();
    const marker = `<!-- neondiff-operator-comment:${request.id}:${request.bodySha256} -->`;
    f.rest.page = () => [
      { id: 899, body: marker, user, performed_via_github_app: { id: 456 } },
      { id: 900, body: marker, user: { login: "customer[bot]", type: "Bot" }, performed_via_github_app: { id: 123 }, html_url: commentUrl }
    ];
    await f.runCycle();
    expect(f.postCalls).toHaveLength(0);
    expect(f.status(request.id)).toMatchObject({ status: "posted", commentId: 900, commentUrl });
  });

  it("upgrades a queued request from the previous schema and reconciles its old marker", async () => {
    const f = await fixture();
    const request = f.enqueue();
    const db = new DatabaseSync(f.statePath);
    try {
      db.exec(`alter table operator_comment_requests drop column claimed_by_pid;
        alter table operator_comment_requests drop column claimed_at;
        alter table operator_comment_requests drop column next_attempt_at;`);
      db.prepare("update operator_comment_requests set error_class = ? where id = ?")
        .run(`worker:${process.pid}`, request.id);
    } finally {
      db.close();
    }
    expect(f.status(request.id)).toMatchObject({ status: "claimed", errorClass: null });
    f.rest.page = () => [{
      id: 900, body: `${body}\n\n<!-- neondiff-operator-comment:${request.id} -->`, user, html_url: commentUrl
    }];
    await f.runCycle();
    expect(f.postCalls).toHaveLength(0);
    expect(f.status(request.id)).toMatchObject({ status: "posted", commentId: 900, commentUrl });
  });

  it("rechecks queued content and refuses unsafe bodies without making a GitHub request", async () => {
    const f = await fixture();
    const unsafe = ["ghp", "x".repeat(36)].join("_");
    const request = f.enqueue(unsafe);
    await f.runCycle();
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.status(request.id)).toMatchObject({ status: "refused", errorClass: "unsafe_body" });
    expect(f.logs.filter((line) => line.includes("daemon_operator_comment_refused"))).toHaveLength(1);
    expect(f.logs.join("\n")).not.toContain(unsafe);
  });

  it.each(["<!-- evaos-command-status:fixture -->", "Follow-up\n @neondiff review \nThanks!"])(
    "refuses %s even if a request bypassed CLI validation", async (text) => {
      const f = await fixture();
      const request = f.enqueue(text);
      await f.runCycle();
      expect(f.fetch).not.toHaveBeenCalled();
      expect(f.status(request.id)).toMatchObject({ status: "refused", errorClass: "unsafe_body" });
    }
  );

  it("checks that the daemon admission covers the target repo before commenting", async () => {
    const f = await fixture();
    const request = f.enqueue();
    f.rest.visibility = "private";
    await f.runCycle();
    expect(f.postCalls).toHaveLength(0);
    expect(f.status(request.id)).toMatchObject({ status: "refused", errorClass: "repo_admission" });
  });

  it.each([403, 404, 410, 422])("marks GitHub %i terminal without retrying", async (status) => {
    const f = await fixture();
    const request = f.enqueue();
    f.rest.postStatus = status;
    await f.runCycle();
    await f.runCycle();
    expect(f.postCalls).toHaveLength(1);
    expect(f.status(request.id)).toMatchObject({ status: "failed", errorClass: `github_${status}`, attempts: 1 });
    expect(f.logs.filter((line) => line.includes("daemon_operator_comment_failed"))).toHaveLength(1);
  });

  it.each([
    [429, "/app/installations/123/access_tokens", {}, "Too many requests"],
    [403, "/repos/owner/repo", { "X-RateLimit-Remaining": "0" }, "Forbidden"],
    [403, "/repos/owner/repo/issues/7/comments", { "Retry-After": "60" }, "Forbidden"],
    [403, "/repos/owner/repo/issues/7/comments", {}, "You have exceeded a secondary rate limit."],
    [401, "/repos/owner/repo/issues/7/comments", {}, "Bad credentials"]
  ] as const)("backs off GitHub %i at %s", async (status, target, headers, message) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const f = await fixture();
    const request = f.enqueue();
    f.rest.respond = (path, init) => path === target && (status !== 401 || init?.method === "POST")
      ? Response.json({ message }, { status, headers: { ...headers } }) : undefined;
    for (const [index, minutes] of [1, 2, 4, 8, 16, 32, 60, 60].entries()) {
      await f.runCycle();
      const due = Date.now() + minutes * 60_000;
      expect(f.status(request.id)).toMatchObject({
        status: "pending", errorClass: `github_${status}`, attempts: index + 1, nextAttemptAt: new Date(due).toISOString()
      });
      const calls = f.fetch.mock.calls.length;
      vi.setSystemTime(due - 1);
      await f.runCycle();
      expect(f.fetch).toHaveBeenCalledTimes(calls);
      vi.setSystemTime(due);
    }
  });

  it("ends retries at 24 hours and reconciles an ambiguous failed post when the body is re-queued", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const f = await fixture();
    const first = f.enqueue();
    f.rest.postStatus = 503;
    await f.runCycle();
    expect(f.status(first.id)).toMatchObject({ status: "pending", errorClass: "github_503", attempts: 1 });
    vi.setSystemTime(Date.parse(first.requestedAt) + 86_400_000);
    await f.runCycle();
    expect(f.postCalls).toHaveLength(1);
    expect(f.status(first.id)).toMatchObject({ status: "failed", errorClass: "retry_exhausted" });
    expect(f.logs.filter((line) => line.includes("daemon_operator_comment_failed"))).toHaveLength(1);
    f.rest.page = () => [{ id: 900, body: f.postCalls[0]!.body, user, html_url: commentUrl }];
    const second = f.enqueue();
    expect(second.id).not.toBe(first.id);
    await f.runCycle();
    expect(f.postCalls).toHaveLength(1);
    expect(f.status(second.id)).toMatchObject({ status: "posted", commentId: 900, commentUrl });
    expect(f.enqueue().id).toBe(second.id);
  });

  it("uses the configured repo casing for token scope and every REST call", async () => {
    const f = await fixture({ repo: "Owner/Repo" });
    const request = f.enqueue();
    await f.runCycle();
    expect(f.status(request.id)?.status).toBe("posted");
    expect(f.fetch.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([
      "/repos/Owner/Repo/installation", "/app/installations/123/access_tokens",
      "/repos/Owner/Repo", "/repos/Owner/Repo/issues/7/comments", "/repos/Owner/Repo/issues/7/comments"
    ]);
    expect(JSON.parse(String(f.fetch.mock.calls[1]?.[1]?.body))).toEqual({ repositories: ["Repo"] });
  });

  it("logs the failure class and settles even when both loggers throw", async () => {
    const f = await fixture({ throwLoggers: true });
    const first = f.enqueue();
    await expect(f.runCycle()).resolves.toMatchObject({ ok: true });
    expect(f.status(first.id)?.status).toBe("posted");
    expect(f.logs.map((line) => JSON.parse(line))).toContainEqual(expect.objectContaining({
      event: "daemon_operator_comment_pass_failed", errorClass: "TypeError"
    }));
    const second = f.enqueue(body, 8);
    await expect(f.runCycle()).resolves.toMatchObject({ ok: true });
    expect(f.status(second.id)?.status).toBe("posted");
  });

  it("leaves dry-run requests pending and drains at most five oldest requests per live cycle", async () => {
    const f = await fixture();
    const requests = [1, 2, 3, 4, 5, 6].map((number) => f.enqueue(body, number));
    await f.runCycle(true);
    expect(f.fetch).not.toHaveBeenCalled();
    await f.runCycle();
    expect(f.postCalls.map((call) => Number(call.path.split("/")[5]))).toEqual([1, 2, 3, 4, 5]);
    expect(f.status(requests[5]!.id)?.status).toBe("pending");
    await f.runCycle();
    expect(f.status(requests[5]!.id)?.status).toBe("posted");
  });

  it("lets a later review cycle finish while an earlier comment is still posting", async () => {
    const f = await fixture();
    f.enqueue();
    let release!: () => void;
    f.rest.waitBeforePost = new Promise<void>((resolve) => { release = resolve; });
    try {
      await f.runCycle(false, false);
      await vi.waitFor(() => expect(f.postCalls).toHaveLength(1));
      expect(await f.runCycle(false, false)).toMatchObject({ ok: true, result: { reviewed: 1 } });
      expect(f.order).toEqual(["review", "cooldown", "post", "review", "cooldown"]);
    } finally { release(); }
    await waitForOperatorCommentPass();
    expect(f.postCalls).toHaveLength(1);
  });
});

function emptyCleanupSummary() {
  return { worktreesRoot: "/tmp/neondiff/runtime/worktrees", retentionMs: 7_200_000, checked: 0, deleted: 0, skipped: 0, errors: 0, outcomes: [] };
}

function successfulRunOnceResult() {
  return {
    reposScanned: 1,
    pullsSeen: 1,
    reviewed: 0,
    failed: 0,
    skippedDraft: 0,
    skippedCanary: 0,
    skippedPolicy: 0,
    skippedLicenseGate: 0,
    skippedCommandStop: 0,
    skippedCommandExplain: 0,
    skippedFinishingTouchDraft: 0,
    commandReviewRequested: 0,
    skippedProcessed: 1,
    skippedCapacity: 0,
    skippedContextBudget: 0,
    skippedProviderCooldown: 0,
    skippedStaleHead: 0,
    baselinedExisting: 0,
    policySkips: []
  };
}

function successfulRetryResult() {
  return {
    ok: true as const,
    checkedAt: "2026-07-01T00:00:00.000Z",
    dryRun: true,
    expiredOnly: true,
    limit: 1,
    candidates: 0,
    attempted: 0,
    results: [],
    summary: {
      reviewed: 0,
      dryRun: 0,
      remainedCooldown: 0,
      failed: 0,
      skippedStaleHead: 0,
      skippedProcessed: 0,
      skippedClosed: 0,
      skippedCapacity: 0,
      other: 0
    }
  };
}

function successfulIssueEnrichmentCycleResult(): IssueEnrichmentCycleResult {
  return {
    ok: true,
    checkedAt: "2026-07-03T04:00:00.000Z",
    dryRun: false,
    status: {
      ok: true,
      checkedAt: "2026-07-03T04:00:00.000Z",
      state: "dry_run_only",
      enabled: true,
      postIssueComment: false,
      separateAllowlist: true,
      allowlist: ["owner/repo"],
      liveThresholdsMissingRepos: [],
      throttleDefaults: {
        maxIssuesPerCycle: 5,
        maxCommentsPerCycle: 0,
        cooldownMs: 3_600_000,
        burstWindowMs: 3_600_000,
        maxIssuesPerBurst: 10,
        lookbackMs: 600_000,
        processExistingOpenIssuesOnActivation: false
      },
      globalLimits: {
        globalMaxIssuesPerCycle: 5,
        globalMaxCommentsPerCycle: 1,
        maxActiveRuns: 1,
        leaseTtlMs: 1_200_000
      },
      repoOverrides: [],
      blockers: ["issue_enrichment_live_posting_disabled"]
    },
    summary: {
      reposScanned: 1,
      reposSkipped: 0,
      readFailures: 0,
      issuesSeen: 1,
      eligible: 1,
      skipped: 0,
      wouldEnrich: 1,
      wouldComment: 0,
      deferred: 0,
      baselinedRepos: 0,
      truncatedRepos: 0,
      workerSkipped: 0,
      posted: 0,
      dryRunRecorded: 1,
      skippedRecorded: 0,
      deferredRecorded: 0,
      alreadyProcessed: 0,
      failed: 0
    },
    repos: [],
    items: [],
    recommendedActions: []
  };
}
