import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { CoverageAuditReport } from "../src/coverage-audit.js";
import {
  buildOperatorQueue,
  buildOperatorStatus,
  collectOperatorLeases,
  collectOperatorRepoProviderCooldowns,
  collectOperatorReviewQueue,
  explainPullStatus,
  summarizeAgentInventory,
  type OperatorAgentInventory
} from "../src/operator-cli.js";
import type { ReleaseStatus } from "../src/release-status.js";

describe("operator CLI summaries", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

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
      durableQueue: durableQueueSnapshot(),
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
      expiredProviderCooldowns: 1,
      queuedJobs: 1,
      runningJobs: 1,
      providerDeferredJobs: 1,
      failedQueueJobs: 1
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
    expect(status.gates).toContainEqual({
      name: "queue_no_stale_heads",
      ok: true,
      detail: "0 stale head(s)"
    });
    expect(status.recommendedActions).toContain("retry cooldowns");
    expect(status.recommendedActions).toContain("inspect operator queue failed jobs before promotion");
    expect(status.recommendedActions).toContain("retry or requeue provider-deferred jobs whose nextEligibleAt has expired");
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

  it("prefers dead-owner lease diagnostics over expiry when both are true", () => {
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
        lease("expired-dead-owner", "2026-06-30T23:00:00.000Z", "2026-06-30T23:10:00.000Z", 999999, false)
      ],
      now: new Date("2026-07-01T00:01:00.000Z")
    });

    expect(inventory.staleLeases).toEqual([
      expect.objectContaining({ leaseId: "expired-dead-owner", staleReason: "owner_not_running" })
    ]);
  });

  it("reads lease inventories from pre-owner-pid state databases", () => {
    const statePath = createTempDatabase(tempDirs);
    const db = new DatabaseSync(statePath);
    try {
      db.exec("create table review_run_leases (lease_id text primary key, started_at text not null, expires_at text not null)");
      db.prepare("insert into review_run_leases (lease_id, started_at, expires_at) values (?, ?, ?)")
        .run("legacy", "2026-07-01T00:00:00.000Z", "2026-07-01T00:10:00.000Z");
    } finally {
      db.close();
    }

    expect(collectOperatorLeases(statePath)).toEqual([
      {
        leaseId: "legacy",
        startedAt: "2026-07-01T00:00:00.000Z",
        expiresAt: "2026-07-01T00:10:00.000Z"
      }
    ]);
  });

  it("scopes repo provider cooldown inventory to the requested repo", () => {
    const statePath = createTempDatabase(tempDirs);
    const db = new DatabaseSync(statePath);
    try {
      db.exec("create table repo_provider_cooldowns (repo text primary key, cooldown_until text not null, reason text not null, updated_at text not null)");
      db.prepare("insert into repo_provider_cooldowns (repo, cooldown_until, reason, updated_at) values (?, ?, ?, ?)")
        .run("owner/repo", "2026-07-01T00:05:00.000Z", "provider_request_rate_limit", "2026-07-01T00:00:00.000Z");
      db.prepare("insert into repo_provider_cooldowns (repo, cooldown_until, reason, updated_at) values (?, ?, ?, ?)")
        .run("owner/other", "2026-07-01T00:06:00.000Z", "provider_request_rate_limit", "2026-07-01T00:00:00.000Z");
    } finally {
      db.close();
    }

    expect(collectOperatorRepoProviderCooldowns(statePath, { repo: "owner/repo" })).toEqual([
      {
        repo: "owner/repo",
        cooldownUntil: "2026-07-01T00:05:00.000Z",
        reason: "provider_request_rate_limit",
        updatedAt: "2026-07-01T00:00:00.000Z"
      }
    ]);
  });

  it("summarizes durable review queue rows from the live state database", () => {
    const statePath = createTempDatabase(tempDirs);
    const db = new DatabaseSync(statePath);
    try {
      db.exec("create table review_queue_jobs (job_id text primary key, attempt_id text not null unique, source text not null, lane text not null, repo text not null, org text not null, pull_number integer not null, head_sha text not null, base_sha text, provider_id text, priority integer not null, state text not null, next_eligible_at text, lease_id text, session_id text, comment_id integer, review_url text, last_error text, created_at text not null, updated_at text not null, started_at text, finished_at text)");
      insertQueueJob(db, "queued", "owner/repo", 1, "head-queued");
      insertQueueJob(db, "running", "owner/repo", 2, "head-running");
      insertQueueJob(db, "provider_deferred", "owner/repo", 3, "head-deferred", "2026-07-01T00:01:00.000Z");
      insertQueueJob(db, "provider_deferred", "owner/other", 4, "head-wait", "2026-07-01T00:10:00.000Z");
      insertQueueJob(db, "failed", "owner/other", 5, "head-failed");
    } finally {
      db.close();
    }

    const queue = collectOperatorReviewQueue(statePath, {
      now: new Date("2026-07-01T00:05:00.000Z")
    });

    expect(queue.ok).toBe(false);
    expect(queue.summary).toMatchObject({
      total: 5,
      queued: 1,
      running: 1,
      providerDeferred: 2,
      retryableProviderDeferred: 1,
      failed: 1
    });
    expect(queue.byRepo).toEqual([
      expect.objectContaining({ repo: "owner/other", total: 2, providerDeferred: 1, retryableProviderDeferred: 0, failed: 1 }),
      expect.objectContaining({ repo: "owner/repo", total: 3, queued: 1, running: 1, retryableProviderDeferred: 1 })
    ]);
    expect(collectOperatorReviewQueue(statePath, { repo: "owner/repo" }).jobs).toHaveLength(3);
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

  it("prioritizes provider-deferred and stale-head explanations over processed rows", () => {
    const report = coverageReport({
      processed: [processedEntry(2, "head-cooldown", "skipped"), processedEntry(5, "old-head", "posted")],
      providerDeferred: [providerDeferredEntry(2, "head-cooldown")],
      staleHeads: [{
        repo: "owner/repo",
        pullNumber: 5,
        expectedHeadSha: "old-head",
        liveHeadSha: "new-head",
        title: "stale",
        url: "https://github.com/owner/repo/pull/5"
      }]
    });

    expect(explainPullStatus(report, "owner/repo", 2)).toMatchObject({
      state: "provider_deferred",
      nextAction: "wait_or_retry_provider_cooldown"
    });
    expect(explainPullStatus(report, "owner/repo", 5)).toMatchObject({
      state: "stale_head",
      headSha: "new-head",
      nextAction: "run_or_wait_for_daemon"
    });
  });
});

function createTempDatabase(tempDirs: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "evaos-operator-cli-"));
  tempDirs.push(dir);
  return join(dir, "state.sqlite");
}

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

function durableQueueSnapshot() {
  return {
    ok: false,
    checkedAt: "2026-07-01T00:30:00.000Z",
    summary: {
      total: 4,
      queued: 1,
      leased: 0,
      running: 1,
      providerDeferred: 1,
      retryableProviderDeferred: 1,
      posted: 0,
      failed: 1,
      retired: 0
    },
    jobs: [],
    byRepo: []
  };
}

function insertQueueJob(
  db: DatabaseSync,
  state: string,
  repo: string,
  pullNumber: number,
  headSha: string,
  nextEligibleAt?: string
): void {
  db.prepare(
    `insert into review_queue_jobs
      (job_id, attempt_id, source, lane, repo, org, pull_number, head_sha,
       priority, state, next_eligible_at, created_at, updated_at)
     values (?, ?, 'automatic', 'background', ?, ?, ?, ?, 50, ?, ?, ?, ?)`
  ).run(
    `${state}-${headSha}`,
    `automatic:${repo}#${pullNumber}@${headSha}`,
    repo,
    repo.split("/")[0],
    pullNumber,
    headSha,
    state,
    nextEligibleAt ?? null,
    "2026-07-01T00:00:00.000Z",
    "2026-07-01T00:00:00.000Z"
  );
}
