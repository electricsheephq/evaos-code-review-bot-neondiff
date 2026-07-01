import { describe, expect, it } from "vitest";
import type { CoverageAuditReport } from "../src/coverage-audit.js";
import {
  buildOperatorQueue,
  buildOperatorStatus,
  explainPullStatus,
  summarizeAgentInventory,
  type OperatorAgentInventory
} from "../src/operator-cli.js";
import type { ReleaseStatus } from "../src/release-status.js";

describe("operator CLI summaries", () => {
  it("combines release health, coverage, agents, and cooldown backlog into one operator status", () => {
    const status = buildOperatorStatus({
      release: releaseStatus({ ok: false, recommendedActions: ["retry cooldowns"] }),
      coverage: coverageReport({
        unprocessed: [pullEntry(253, "head-pending")],
        providerDeferred: [providerDeferredEntry(497, "head-deferred")],
        readFailures: [{ repo: "owner/read-fail", error: "GitHub 404" }]
      }),
      agents: agentInventory({
        activeLeases: [lease("lease-active", "2026-07-01T00:00:00.000Z", "2026-07-01T00:10:00.000Z")],
        staleLeases: [lease("lease-stale", "2026-06-30T23:00:00.000Z", "2026-06-30T23:10:00.000Z")]
      }),
      providerCooldowns: [
        {
          ...processedRecord(253, "head-expired", "skipped"),
          cooldownUntil: "2026-07-01T00:05:00.000Z",
          reason: "provider_request_rate_limit",
          expired: true
        }
      ],
      checkedAt: "2026-07-01T00:30:00.000Z"
    });

    expect(status.ok).toBe(false);
    expect(status.summary).toMatchObject({
      launchdState: "running",
      heartbeatStatus: "fresh",
      activeLeases: 1,
      staleLeases: 1,
      pendingHeads: 1,
      providerDeferredHeads: 1,
      readFailures: 1,
      expiredProviderCooldowns: 1
    });
    expect(status.gates).toContainEqual({
      name: "queue_no_pending_heads",
      ok: false,
      detail: "1 pending head(s)"
    });
    expect(status.gates).toContainEqual({
      name: "agents_no_stale_leases",
      ok: false,
      detail: "1 stale lease(s)"
    });
    expect(status.recommendedActions).toContain("retry cooldowns");
    expect(JSON.stringify(status)).not.toMatch(/ghp_|BEGIN RSA|PRIVATE KEY/);
  });

  it("summarizes active and stale agent leases without mutating runtime state", () => {
    const inventory = summarizeAgentInventory({
      launchd: { label: "com.electricsheephq.evaos-code-review-bot", state: "running", pid: 1234, dryRun: false },
      heartbeat: {
        status: "fresh",
        maxAgeMs: 120_000,
        latestAt: "2026-07-01T00:00:10.000Z",
        ageMs: 5_000,
        cycle: 42,
        event: "daemon_cycle_complete",
        dryRun: false
      },
      leases: [
        lease("active", "2026-07-01T00:00:00.000Z", "2026-07-01T00:10:00.000Z", 1234, true),
        lease("expired", "2026-06-30T23:00:00.000Z", "2026-06-30T23:10:00.000Z", 1234, true),
        lease("dead-owner", "2026-07-01T00:00:00.000Z", "2026-07-01T00:10:00.000Z", 999999, false)
      ],
      now: new Date("2026-07-01T00:01:00.000Z")
    });

    expect(inventory.ok).toBe(false);
    expect(inventory.summary).toMatchObject({ totalLeases: 3, activeLeases: 1, staleLeases: 2 });
    expect(inventory.activeLeases.map((entry) => entry.leaseId)).toEqual(["active"]);
    expect(inventory.staleLeases).toEqual([
      expect.objectContaining({ leaseId: "expired", staleReason: "expired" }),
      expect.objectContaining({ leaseId: "dead-owner", staleReason: "owner_not_running" })
    ]);
  });

  it("builds queue buckets from coverage audit output", () => {
    const queue = buildOperatorQueue(coverageReport({
      processed: [processedEntry(1, "head-posted", "posted")],
      providerDeferred: [providerDeferredEntry(2, "head-provider")],
      unprocessed: [pullEntry(3, "head-pending")],
      skipped: [{ repo: "owner/repo", pullNumber: 4, headSha: "head-draft", reason: "draft" }],
      staleHeads: [{
        repo: "owner/repo",
        pullNumber: 5,
        expectedHeadSha: "old-head",
        liveHeadSha: "new-head",
        title: "stale",
        url: "https://github.com/owner/repo/pull/5"
      }]
    }));

    expect(queue.ok).toBe(false);
    expect(queue.summary).toMatchObject({
      processed: 1,
      providerDeferred: 1,
      pending: 1,
      skipped: 1,
      staleHeads: 1
    });
    expect(queue.pending[0]).toMatchObject({ pullNumber: 3, state: "pending_review" });
    expect(queue.providerDeferred[0]).toMatchObject({ pullNumber: 2, state: "provider_deferred" });
  });

  it("explains why a PR head is or is not reviewed", () => {
    const report = coverageReport({
      processed: [processedEntry(1, "head-posted", "posted")],
      providerDeferred: [providerDeferredEntry(2, "head-cooldown")],
      unprocessed: [pullEntry(3, "head-pending")],
      skipped: [{ repo: "owner/repo", pullNumber: 4, headSha: "head-draft", reason: "draft" }],
      readFailures: [{ repo: "owner/read-fail", error: "GitHub API failed" }]
    });

    expect(explainPullStatus(report, "owner/repo", 1)).toMatchObject({
      state: "processed",
      nextAction: "none"
    });
    expect(explainPullStatus(report, "owner/repo", 2)).toMatchObject({
      state: "provider_deferred",
      nextAction: "wait_or_retry_provider_cooldown"
    });
    expect(explainPullStatus(report, "owner/repo", 3)).toMatchObject({
      state: "pending_review",
      nextAction: "run_or_wait_for_daemon"
    });
    expect(explainPullStatus(report, "owner/repo", 4)).toMatchObject({
      state: "skipped",
      reason: "draft",
      nextAction: "none"
    });
    expect(explainPullStatus(report, "owner/missing", 9)).toMatchObject({
      state: "unknown",
      nextAction: "run_scoped_coverage_audit"
    });
  });
});

function releaseStatus(input: { ok: boolean; recommendedActions?: string[] }): ReleaseStatus {
  return {
    ok: input.ok,
    checkedAt: "2026-07-01T00:30:00.000Z",
    releaseUnit: {
      channel: "local-beta",
      sourceHead: "head",
      branch: "main",
      configPath: "/config/live.json"
    },
    repo: { branch: "main", head: "head", dirtyFiles: [] },
    launchd: { label: "com.electricsheephq.evaos-code-review-bot", state: "running", pid: 1234, dryRun: false },
    database: {
      rowCount: 10,
      errorCount: 0,
      providerCooldownCount: 1,
      expiredProviderCooldownCount: 1,
      activeProviderCooldownCount: 0
    },
    heartbeat: {
      status: "fresh",
      maxAgeMs: 120_000,
      latestAt: "2026-07-01T00:29:55.000Z",
      ageMs: 5_000,
      cycle: 12,
      event: "daemon_cycle_complete",
      dryRun: false
    },
    recommendedActions: input.recommendedActions ?? [],
    gates: [{ name: "provider_cooldown_backlog", ok: false, detail: "1 expired provider cooldown row(s)" }],
    rollback: {
      restartCommand: "launchctl kickstart -k gui/501/com.electricsheephq.evaos-code-review-bot",
      unloadCommand: "launchctl bootout gui/501 ~/Library/LaunchAgents/com.electricsheephq.evaos-code-review-bot.plist"
    }
  };
}

function coverageReport(input: Partial<CoverageAuditReport>): CoverageAuditReport {
  const report: CoverageAuditReport = {
    ok: input.ok ?? false,
    checkedAt: "2026-07-01T00:30:00.000Z",
    summary: {
      reposScanned: 1,
      pullsSeen: 0,
      processed: input.processed?.length ?? 0,
      providerDeferred: input.providerDeferred?.length ?? 0,
      unprocessed: input.unprocessed?.length ?? 0,
      skipped: input.skipped?.length ?? 0,
      staleHeads: input.staleHeads?.length ?? 0,
      readFailures: input.readFailures?.length ?? 0
    },
    processed: input.processed ?? [],
    providerDeferred: input.providerDeferred ?? [],
    unprocessed: input.unprocessed ?? [],
    skipped: input.skipped ?? [],
    staleHeads: input.staleHeads ?? [],
    readFailures: input.readFailures ?? []
  };
  report.summary.pullsSeen =
    report.summary.processed +
    report.summary.providerDeferred +
    report.summary.unprocessed +
    report.summary.skipped +
    report.summary.staleHeads;
  return report;
}

function pullEntry(pullNumber: number, headSha: string) {
  return {
    repo: "owner/repo",
    pullNumber,
    headSha,
    title: `PR ${pullNumber}`,
    url: `https://github.com/owner/repo/pull/${pullNumber}`,
    draft: false,
    state: "open",
    previousProcessedHeads: []
  };
}

function processedEntry(pullNumber: number, headSha: string, status: "posted" | "skipped") {
  return {
    ...pullEntry(pullNumber, headSha),
    status,
    event: status === "posted" ? "COMMENT" as const : undefined,
    createdAt: "2026-07-01 00:00:00"
  };
}

function providerDeferredEntry(pullNumber: number, headSha: string) {
  return {
    ...processedEntry(pullNumber, headSha, "skipped"),
    cooldownUntil: "2026-07-01T00:05:00.000Z",
    reason: "provider_request_rate_limit"
  };
}

function processedRecord(pullNumber: number, headSha: string, status: "posted" | "skipped") {
  return {
    repo: "owner/repo",
    pullNumber,
    headSha,
    status,
    createdAt: "2026-07-01 00:00:00"
  };
}

function lease(
  leaseId: string,
  startedAt: string,
  expiresAt: string,
  ownerPid = 1234,
  ownerAlive = true
) {
  return { leaseId, startedAt, expiresAt, ownerPid, ownerAlive };
}

function agentInventory(input: Partial<OperatorAgentInventory>): OperatorAgentInventory {
  return {
    ok: input.ok ?? false,
    checkedAt: "2026-07-01T00:30:00.000Z",
    launchd: { label: "com.electricsheephq.evaos-code-review-bot", state: "running", pid: 1234, dryRun: false },
    heartbeat: {
      status: "fresh",
      maxAgeMs: 120_000,
      latestAt: "2026-07-01T00:29:55.000Z",
      ageMs: 5_000,
      cycle: 12,
      event: "daemon_cycle_complete",
      dryRun: false
    },
    summary: {
      totalLeases: (input.activeLeases?.length ?? 0) + (input.staleLeases?.length ?? 0),
      activeLeases: input.activeLeases?.length ?? 0,
      staleLeases: input.staleLeases?.length ?? 0
    },
    activeLeases: input.activeLeases ?? [],
    staleLeases: input.staleLeases ?? []
  };
}
