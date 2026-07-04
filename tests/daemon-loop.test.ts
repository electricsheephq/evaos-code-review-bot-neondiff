import { describe, expect, it } from "vitest";
import { runDaemonCycle } from "../src/daemon.js";
import type { IssueEnrichmentCycleResult } from "../src/issue-enrichment.js";

describe("daemon cycle resilience", () => {
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
        throw new Error("ZCode failed before completion: spawnSync node ETIMEDOUT with ghp_1234567890abcdefghijklmnopqrstuvwx");
      },
      recordHeartbeatImpl: () => undefined,
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    });

    expect(result.ok).toBe(false);
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
    expect(failure.error).not.toContain("ghp_1234567890abcdefghijklmnopqrstuvwx");
  });

  it("records start and completion heartbeat events for successful cycles", async () => {
    const heartbeats: string[] = [];

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
      recordHeartbeatImpl: (event) => heartbeats.push(event),
      stdout: () => undefined,
      stderr: () => undefined
    });

    expect(result.ok).toBe(true);
    expect(heartbeats).toEqual(["daemon_cycle_start", "daemon_cycle_complete"]);
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
      recordHeartbeatImpl: (event, error) => heartbeats.push({ event, ...(error ? { error } : {}) }),
      stdout: () => undefined,
      stderr: () => undefined
    });

    expect(result.ok).toBe(false);
    expect(heartbeats).toEqual([
      { event: "daemon_cycle_start" },
      { event: "daemon_cycle_failed", error: "second timeout" }
    ]);
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
        cycle: 9,
        result: expect.objectContaining({
          summary: expect.objectContaining({
            reposScanned: 1,
            dryRunRecorded: 1
          })
        })
      })
    ]));
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
        throw new Error("issue enrichment failed with ghp_1234567890abcdefghijklmnopqrstuvwx");
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
      cycle: 10
    });
    expect(failure.error).toContain("issue enrichment failed");
    expect(failure.error).not.toContain("ghp_1234567890abcdefghijklmnopqrstuvwx");
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
    skippedProviderCooldown: 0,
    skippedStaleHead: 0,
    baselinedExisting: 0,
    policySkips: []
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
