import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  cleanupReviewWorktreesFromConfig,
  runDaemonCycle as runDaemonCycleImpl,
  shouldExitDaemonAfterFailedCycle,
  waitForIssueEnrichmentPass,
  type RunDaemonCycleOptions
} from "../src/daemon.js";
import type { BotConfig } from "../src/config.js";
import type { IssueEnrichmentCycleResult } from "../src/issue-enrichment.js";
import { requireActiveDaemonCycleAdmissions, type ProductionLicenseAdmission } from "../src/license-admission.js";
import { ReviewStateStore } from "../src/state.js";

// Cycles no longer await issue enrichment; settle the detached pass so each test sees its own lane output.
const runDaemonCycle = async (input: RunDaemonCycleOptions) => {
  const result = await runDaemonCycleImpl({
    ...input,
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
    const result = await runDaemonCycleImpl({
      cycle: 1,
      dryRun: false,
      pilotRepos: ["electricsheephq/WorldOS"],
      monitoredRepos: ["electricsheephq/WorldOS"],
      canaryPulls: [],
      commandsEnabled: false,
      issueEnrichmentEnabled: true,
      admitDaemonCycleImpl: async () => { throw new Error("license missing: no license key is stored"); },
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
      stdout: () => undefined,
      stderr: () => undefined
    });

    expect(result.ok).toBe(true);
    expect(heartbeats.map(({ event }) => event)).toEqual(["daemon_cycle_start", "daemon_cycle_progress", "daemon_cycle_complete"]);
    expect(new Set(heartbeats.map(({ runId }) => runId)).size).toBe(1);
    expect(new Set(heartbeats.map(({ reviewLane }) => reviewLane))).toEqual(new Set(["active"]));
    expect(heartbeats[0]?.runId).toMatch(/^[0-9a-f-]{36}$/);
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
      stdout: () => undefined,
      stderr: () => undefined
    });

    expect(result).toMatchObject({ ok: false, failureKind: "runtime_failure", error: "review batch failed" });
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
