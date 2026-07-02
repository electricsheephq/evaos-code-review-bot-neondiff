import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { CoverageAuditReport, CoverageQueuedEntry } from "../src/coverage-audit.js";
import {
  buildOperatorDashboard,
  buildRuntimeInventory,
  buildOperatorQueue,
  buildOperatorStatus,
  collectOperatorLeases,
  collectOperatorRepoProviderCooldowns,
  collectOperatorReviewReadiness,
  collectOperatorReviewQueue,
  explainPullStatus,
  filterBotProcessRows,
  formatOperatorDashboardHuman,
  formatRuntimeInventoryHuman,
  summarizeAgentInventory,
  type OperatorAgentInventory,
  type OperatorDurableQueueSnapshot
} from "../src/operator-cli.js";
import type { IssueEnrichmentStatus } from "../src/issue-enrichment.js";
import { buildIssueEnrichmentStatus } from "../src/issue-enrichment.js";
import type { ReviewBudgetStatus } from "../src/review-budget.js";
import type { ReleaseStatus } from "../src/release-status.js";
import type { RepoProviderCooldownRecord } from "../src/state.js";
import { loadConfig } from "../src/config.js";

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

  it("surfaces issue enrichment live-post blockers in operator status", () => {
    const issueEnrichment: IssueEnrichmentStatus = {
      ok: false,
      checkedAt: "2026-07-03T00:00:00.000Z",
      state: "blocked",
      enabled: true,
      postIssueComment: true,
      separateAllowlist: true,
      allowlist: ["owner/issue-repo"],
      throttleDefaults: {
        maxIssuesPerCycle: 5,
        maxCommentsPerCycle: 2,
        cooldownMs: 3_600_000,
        burstWindowMs: 3_600_000,
        maxIssuesPerBurst: 10,
        lookbackMs: 600_000,
        processExistingOpenIssuesOnActivation: false
      },
      repoOverrides: [],
      blockers: ["github_app_credentials_required_for_live_issue_comments"]
    };

    const status = buildOperatorStatus({
      release: releaseStatus({ ok: true }),
      coverage: coverageReport({ ok: true }),
      agents: agentInventory({ ok: true }),
      providerCooldowns: [],
      durableQueue: durableQueueSnapshot({ ok: true, summary: cleanDurableQueueSummary() }),
      issueEnrichment,
      checkedAt: "2026-07-03T00:00:00.000Z"
    });

    expect(status.ok).toBe(false);
    expect(status.summary.issueEnrichmentState).toBe("blocked");
    expect(status.gates).toContainEqual({
      name: "issue_enrichment_ready",
      ok: false,
      detail: "blocked: github_app_credentials_required_for_live_issue_comments"
    });
    expect(status.recommendedActions).toContain("resolve issue-enrichment blockers before enabling live issue comments");
  });

  it("surfaces issue enrichment blockers from a real config and App credential state", () => {
    const root = mkdtempSync(join(tmpdir(), "issue-enrichment-status-config-"));
    tempDirs.push(root);
    const configPath = join(root, "config.json");
    writeFileSync(configPath, `${JSON.stringify({
      issueEnrichment: {
        enabled: true,
        postIssueComment: true,
        allowlist: ["owner/issue-repo"]
      }
    })}\n`);

    const status = buildOperatorStatus({
      release: releaseStatus({ ok: true }),
      coverage: coverageReport({ ok: true }),
      agents: agentInventory({ ok: true }),
      providerCooldowns: [],
      durableQueue: durableQueueSnapshot({ ok: true, summary: cleanDurableQueueSummary() }),
      issueEnrichment: buildIssueEnrichmentStatus({
        config: loadConfig(configPath),
        canPostAsApp: false,
        checkedAt: "2026-07-03T00:00:00.000Z"
      }),
      checkedAt: "2026-07-03T00:00:00.000Z"
    });

    expect(status.ok).toBe(false);
    expect(status.summary.issueEnrichmentState).toBe("blocked");
    expect(status.gates).toContainEqual({
      name: "issue_enrichment_ready",
      ok: false,
      detail: "blocked: github_app_credentials_required_for_live_issue_comments"
    });
  });

  it("treats pending heads covered by durable queue work as healthy active runtime", () => {
    const statePath = createTempDatabase(tempDirs);
    const db = new DatabaseSync(statePath);
    try {
      db.exec("create table review_queue_jobs (job_id text primary key, attempt_id text not null unique, source text not null, lane text not null, repo text not null, org text not null, pull_number integer not null, head_sha text not null, base_sha text, provider_id text, priority integer not null, state text not null, next_eligible_at text, lease_id text, lease_expires_at text, session_id text, comment_id integer, review_url text, last_error text, created_at text not null, updated_at text not null, started_at text, finished_at text)");
      insertQueueJob(db, "running", "owner/repo", 3, "head-pending");
      db.prepare("update review_queue_jobs set lease_id = ?, lease_expires_at = ? where job_id = ?")
        .run("lease-active", "2026-07-01T00:10:00.000Z", "running-head-pending");
    } finally {
      db.close();
    }

    const inventory = buildRuntimeInventory({
      release: releaseStatus({ ok: true }),
      coverage: coverageReport({ unprocessed: [pullEntry(3, "head-pending")] }),
      agents: agentInventory({
        ok: true,
        activeLeases: [lease("lease-active", "2026-07-01T00:00:00.000Z", "2026-07-01T00:10:00.000Z")]
      }),
      durableQueue: collectOperatorReviewQueue(statePath, { now: new Date("2026-07-01T00:05:00.000Z") }),
      providerCooldowns: [],
      repoProviderCooldowns: [],
      checkedAt: "2026-07-01T00:05:00.000Z"
    });

    expect(inventory.ok).toBe(true);
    expect(inventory.runtimeState).toBe("healthy_active");
    expect(inventory.classification).toBe("healthy_active");
    expect(inventory.summary).toMatchObject({
      pendingHeads: 1,
      coveredPendingHeads: 1,
      uncoveredPendingHeads: 0,
      activeQueueJobs: 1,
      runningJobs: 1
    });
    expect(inventory.activeWork[0]).toMatchObject({
      repo: "owner/repo",
      pullNumber: 3,
      headSha: "head-pending",
      leaseExpiresAt: "2026-07-01T00:10:00.000Z"
    });
    expect(inventory.gates).toContainEqual({
      name: "runtime_pending_heads_covered",
      ok: true,
      detail: "1 pending head(s) covered by active durable queue work"
    });
    expect(JSON.stringify(inventory)).not.toMatch(/ghp_|BEGIN RSA|PRIVATE KEY/);
  });

  it("flags uncovered pending heads as blocked runtime inventory", () => {
    const inventory = buildRuntimeInventory({
      release: releaseStatus({ ok: true }),
      coverage: coverageReport({ unprocessed: [pullEntry(3, "head-pending")] }),
      agents: agentInventory({ ok: true }),
      durableQueue: durableQueueSnapshot({ ok: true, summary: { total: 0, queued: 0, running: 0, providerDeferred: 0, retryableProviderDeferred: 0, failed: 0 } }),
      providerCooldowns: [],
      repoProviderCooldowns: [],
      checkedAt: "2026-07-01T00:05:00.000Z"
    });

    expect(inventory.ok).toBe(false);
    expect(inventory.runtimeState).toBe("blocked");
    expect(inventory.classification).toBe("blocked");
    expect(inventory.summary.uncoveredPendingHeads).toBe(1);
    expect(inventory.uncoveredPendingHeads[0]).toMatchObject({
      repo: "owner/repo",
      pullNumber: 3,
      headSha: "head-pending"
    });
    expect(inventory.gates).toContainEqual({
      name: "runtime_pending_heads_covered",
      ok: false,
      detail: "1 pending head(s) without active durable queue work"
    });
  });

  it("keeps covered expired provider cooldown rows from blocking runtime inventory", () => {
    const inventory = buildRuntimeInventory({
      release: releaseStatus({
        ok: true,
        database: {
          providerCooldownCount: 1,
          expiredProviderCooldownCount: 1,
          activeGlobalProviderCooldownCount: 1,
          coveredExpiredProviderCooldownCount: 1,
          retryableExpiredProviderCooldownCount: 0,
          providerThrottleState: "active"
        }
      }),
      coverage: coverageReport({ ok: true }),
      agents: agentInventory({ ok: true }),
      durableQueue: durableQueueSnapshot({ ok: true, summary: cleanDurableQueueSummary() }),
      providerCooldowns: [
        {
          ...processedRecord(3, "head-cooldown", "skipped"),
          cooldownUntil: "2026-07-01T00:01:00.000Z",
          reason: "provider_request_rate_limit",
          expired: true
        }
      ],
      repoProviderCooldowns: [repoProviderCooldown("owner/repo", "2026-07-01T00:10:00.000Z")],
      checkedAt: "2026-07-01T00:05:00.000Z"
    });

    expect(inventory.ok).toBe(true);
    expect(inventory.summary).toMatchObject({
      expiredProviderCooldowns: 1,
      retryableExpiredProviderCooldowns: 0,
      coveredExpiredProviderCooldowns: 1,
      activeRepoCooldowns: 1
    });
    expect(inventory.gates).toContainEqual({
      name: "runtime_no_retryable_provider_cooldowns",
      ok: true,
      detail: "0 retryable expired provider cooldown row(s); 1 covered by active provider/repo cooldown"
    });
    expect(inventory.recommendedActions).not.toContain("retry expired provider cooldowns or inspect provider health");
  });

  it("formats a concise human runtime inventory without leaking secrets", () => {
    const inventory = buildRuntimeInventory({
      release: releaseStatus({ ok: true, budget: reviewBudgetStatus() }),
      coverage: coverageReport({ ok: true }),
      agents: agentInventory({ ok: true }),
      durableQueue: durableQueueSnapshot({ ok: true, summary: cleanDurableQueueSummary() }),
      providerCooldowns: [],
      repoProviderCooldowns: [],
      checkedAt: "2026-07-01T00:05:00.000Z"
    });

    const output = formatRuntimeInventoryHuman(inventory);

    expect(output).toContain("runtime: healthy_idle (ok)");
    expect(output).toContain("queue: active=0 queued=0 running=0 providerDeferred=0 failed=0");
    expect(output).toContain("budget: wouldLease=1 delayed=1 delayedByReason={\"manual_reserve\":1}");
    expect(output).not.toMatch(/ghp_|BEGIN RSA|PRIVATE KEY/);
  });

  it("builds a read-only dashboard over coverage, durable queue, readiness, and evidence links", () => {
    const dashboard = buildOperatorDashboard({
      coverage: coverageReport({
        ok: false,
        processed: [processedEntry(1, "head-posted", "posted")],
        unprocessed: [pullEntry(2, "head-pending")],
        staleHeads: [{
          repo: "owner/repo",
          pullNumber: 3,
          expectedHeadSha: "old-head",
          liveHeadSha: "new-head",
          title: "stale",
          url: "https://github.com/owner/repo/pull/3"
        }]
      }),
      durableQueue: durableQueueSnapshot({
        jobs: [
          durableJob({ repo: "owner/repo", pullNumber: 2, headSha: "head-pending", state: "queued", priority: 5, source: "manual_command", lane: "manual" }),
          durableJob({ repo: "owner/other", pullNumber: 4, headSha: "head-failed", state: "failed", priority: 10, lastError: "ZCode failed ghp_123456789012345678901234" })
        ],
        summary: { total: 2, queued: 1, failed: 1, running: 0, providerDeferred: 0, retryableProviderDeferred: 0 }
      }),
      readiness: [{
        repo: "owner/repo",
        pullNumber: 2,
        headSha: "head-pending",
        state: "command_recorded",
        reason: "trusted command requested re-review",
        commandAction: "re-review",
        commandCommentId: 12345,
        createdAt: "2026-07-01T00:00:00.000Z",
        updatedAt: "2026-07-01T00:01:00.000Z"
      }, {
        repo: "owner/other",
        pullNumber: 5,
        headSha: "head-proof",
        state: "blocked_on_proof",
        reason: "missing proof artifact",
        createdAt: "2026-07-01T00:00:00.000Z",
        updatedAt: "2026-07-01T00:02:00.000Z"
      }],
      evidenceDir: "/Volumes/LEXAR/Codex/evaos-code-review-bot/evidence",
      checkedAt: "2026-07-02T00:00:00.000Z"
    });

    expect(dashboard.ok).toBe(false);
    expect(dashboard.summary).toMatchObject({
      totalItems: 5,
      blockedItems: 3,
      activeReviews: 1,
      commandTriggered: 1,
      staleHeads: 1,
      proofGaps: 1
    });
    expect(dashboard.items.map((item) => `${item.repo}#${item.pullNumber}:${item.status}`)).toEqual([
      "owner/repo#2:command_recorded",
      "owner/other#4:failed",
      "owner/other#5:blocked_on_proof",
      "owner/repo#3:stale_head",
      "owner/repo#1:processed"
    ]);
    expect(dashboard.items[0]).toMatchObject({
      repo: "owner/repo",
      pullNumber: 2,
      headSha: "head-pending",
      priority: 5,
      queueState: "queued",
      queueSource: "manual_command",
      readinessState: "command_recorded",
      lastCommand: "re-review",
      proofStatus: "pending_review",
      nextAction: "wait for daemon cycle or inspect command-triggered run"
    });
    expect(dashboard.items[0].url).toBe("https://github.com/owner/repo/pull/2");
    expect(dashboard.items[0].evidencePath).toBe(
      "/Volumes/LEXAR/Codex/evaos-code-review-bot/evidence/2026-07-02/owner__repo/pr-2/head-pending"
    );
    expect(dashboard.items[1].lastError).toBe("ZCode failed [redacted-secret]");
    expect(formatOperatorDashboardHuman(dashboard)).toContain("dashboard: blocked total=5");
    expect(JSON.stringify(dashboard)).not.toMatch(/ghp_123456789012345678901234/);
  });

  it("hides historical stale-only dashboard rows by default while preserving explicit history filters", () => {
    const input = {
      coverage: coverageReport({
        ok: true,
        processed: [processedEntry(1, "head-current", "posted")]
      }),
      durableQueue: durableQueueSnapshot({
        jobs: [
          durableJob({
            repo: "owner/repo",
            pullNumber: 2,
            headSha: "old-head",
            state: "stale_retired",
            lastError: "superseded_by_head=new-head"
          }),
          durableJob({
            repo: "owner/repo",
            pullNumber: 3,
            headSha: "posted-old-head",
            state: "posted",
            lastError: "reviewed"
          })
        ],
        summary: { total: 2, queued: 0, failed: 0, running: 0, providerDeferred: 0, retryableProviderDeferred: 0 }
      }),
      readiness: [
        {
          repo: "owner/repo",
          pullNumber: 2,
          headSha: "old-head",
          state: "stale" as const,
          reason: "superseded_by_head=new-head",
          createdAt: "2026-07-01T00:00:00.000Z",
          updatedAt: "2026-07-01T00:01:00.000Z"
        },
        {
          repo: "owner/repo",
          pullNumber: 3,
          headSha: "posted-old-head",
          state: "stale" as const,
          reason: "superseded_by_head=posted-new-head",
          event: "COMMENT" as const,
          reviewUrl: "https://github.com/owner/repo/pull/3#pullrequestreview-1",
          createdAt: "2026-07-01T00:00:00.000Z",
          updatedAt: "2026-07-01T00:02:00.000Z"
        }
      ],
      checkedAt: "2026-07-02T00:00:00.000Z"
    };

    const currentDashboard = buildOperatorDashboard(input);
    expect(currentDashboard.ok).toBe(true);
    expect(currentDashboard.summary).toMatchObject({
      totalItems: 1,
      blockedItems: 0,
      staleHeads: 0,
      hiddenHistoricalStale: 2
    });
    expect(currentDashboard.items.map((item) => `${item.repo}#${item.pullNumber}:${item.status}`)).toEqual([
      "owner/repo#1:processed"
    ]);

    const historicalDashboard = buildOperatorDashboard({
      ...input,
      filters: { includeHistory: true, status: "stale" }
    });
    expect(historicalDashboard.ok).toBe(false);
    expect(historicalDashboard.summary).toMatchObject({
      totalItems: 2,
      blockedItems: 2,
      staleHeads: 2,
      hiddenHistoricalStale: 0
    });
    expect(historicalDashboard.items.map((item) => `${item.repo}#${item.pullNumber}:${item.headSha}:${item.status}`)).toEqual([
      "owner/repo#2:old-head:stale",
      "owner/repo#3:posted-old-head:stale"
    ]);
  });

  it("hides terminal retired dashboard rows by default while preserving explicit history filters", () => {
    const input = {
      coverage: coverageReport({
        ok: true,
        processed: [processedEntry(1, "head-current", "posted")]
      }),
      durableQueue: durableQueueSnapshot({
        jobs: [
          durableJob({
            repo: "owner/repo",
            pullNumber: 4,
            headSha: "closed-provider-head",
            state: "closed_retired",
            lastError: "operator_retired_closed_pr_after_release_gate; previous_error=repo_provider_cooldown_until=2026-07-02T09:33:32.245Z"
          })
        ],
        summary: { total: 1, queued: 0, failed: 0, running: 0, providerDeferred: 0, retryableProviderDeferred: 0 }
      }),
      readiness: [
        {
          repo: "owner/repo",
          pullNumber: 4,
          headSha: "closed-provider-head",
          state: "provider_deferred" as const,
          reason: "active_queue_job_provider_deferred: repo_provider_cooldown_until=2026-07-02T09:33:32.245Z",
          createdAt: "2026-07-01T00:00:00.000Z",
          updatedAt: "2026-07-01T00:02:00.000Z"
        }
      ],
      checkedAt: "2026-07-02T00:00:00.000Z"
    };

    const currentDashboard = buildOperatorDashboard(input);
    expect(currentDashboard.ok).toBe(true);
    expect(currentDashboard.summary).toMatchObject({
      totalItems: 1,
      blockedItems: 0,
      providerDeferred: 0,
      hiddenHistoricalStale: 1
    });
    expect(currentDashboard.items.map((item) => `${item.repo}#${item.pullNumber}:${item.status}`)).toEqual([
      "owner/repo#1:processed"
    ]);

    const historicalDashboard = buildOperatorDashboard({
      ...input,
      filters: { includeHistory: true, status: "provider_deferred" }
    });
    expect(historicalDashboard.ok).toBe(false);
    expect(historicalDashboard.summary).toMatchObject({
      totalItems: 1,
      blockedItems: 1,
      providerDeferred: 1,
      hiddenHistoricalStale: 0
    });
    expect(historicalDashboard.items[0]).toMatchObject({
      repo: "owner/repo",
      pullNumber: 4,
      headSha: "closed-provider-head",
      status: "provider_deferred",
      queueState: "closed_retired"
    });
  });

  it("filters dashboard rows by repo, status, priority, and stale-head reason", () => {
    const input = {
      coverage: coverageReport({
        ok: false,
        processed: [processedEntry(1, "head-posted", "posted")],
        unprocessed: [pullEntry(2, "head-pending")],
        staleHeads: [{
          repo: "owner/repo",
          pullNumber: 3,
          expectedHeadSha: "old-head",
          liveHeadSha: "new-head",
          title: "stale",
          url: "https://github.com/owner/repo/pull/3"
        }]
      }),
      durableQueue: durableQueueSnapshot({
        jobs: [
          durableJob({ repo: "owner/repo", pullNumber: 2, headSha: "head-pending", state: "queued", priority: 5 }),
          durableJob({ repo: "owner/other", pullNumber: 4, headSha: "head-failed", state: "failed", priority: 10 }),
          durableJob({ repo: "owner/repo", pullNumber: 6, headSha: "head-zero", state: "queued", priority: 0 })
        ],
        summary: { total: 3, queued: 2, failed: 1, running: 0, providerDeferred: 0, retryableProviderDeferred: 0 }
      }),
      checkedAt: "2026-07-02T00:00:00.000Z"
    };
    const staleDashboard = buildOperatorDashboard({
      ...input,
      filters: {
        repo: "owner/repo",
        status: "stale_head",
        staleHeadReason: "live new-head"
      }
    });

    expect(staleDashboard.items).toEqual([
      expect.objectContaining({
        repo: "owner/repo",
        pullNumber: 3,
        status: "stale_head",
        staleHeadReason: "expected old-head, live new-head"
      })
    ]);
    expect(staleDashboard.filters).toEqual({
      repo: "owner/repo",
      status: "stale_head",
      staleHeadReason: "live new-head"
    });

    const priorityDashboard = buildOperatorDashboard({
      ...input,
      filters: { priority: 0 }
    });
    expect(priorityDashboard.items).toEqual([
      expect.objectContaining({
        repo: "owner/repo",
        pullNumber: 6,
        priority: 0
      })
    ]);
  });

  it("keeps healthy active dashboard rows visible without failing the gate", () => {
    const dashboard = buildOperatorDashboard({
      coverage: coverageReport({ ok: false, unprocessed: [pullEntry(2, "head-pending")] }),
      durableQueue: durableQueueSnapshot({
        jobs: [durableJob({ repo: "owner/repo", pullNumber: 2, headSha: "head-pending", state: "queued", priority: 5 })],
        summary: { total: 1, queued: 1, failed: 0, running: 0, providerDeferred: 0, retryableProviderDeferred: 0 }
      }),
      checkedAt: "2026-07-02T00:00:00.000Z"
    });

    expect(dashboard.ok).toBe(true);
    expect(dashboard.summary).toMatchObject({
      totalItems: 1,
      activeReviews: 1,
      blockedItems: 0
    });
    expect(dashboard.items[0]).toMatchObject({
      status: "queued",
      nextAction: "wait for daemon cycle"
    });
  });

  it("maps coverage queued rows into dashboard metadata without losing cooldown timing", () => {
    const dashboard = buildOperatorDashboard({
      coverage: coverageReport({
        ok: true,
        queued: [
          queuedEntry(6, "head-queued", {
            queueState: "running",
            source: "manual_command",
            lane: "manual",
            priority: 7,
            nextEligibleAt: "2026-07-01T00:05:00.000Z",
            updatedAt: "2026-07-01T00:02:00.000Z"
          })
        ]
      }),
      checkedAt: "2026-07-02T00:00:00.000Z"
    });

    expect(dashboard.ok).toBe(true);
    expect(dashboard.items).toEqual([
      expect.objectContaining({
        repo: "owner/repo",
        pullNumber: 6,
        headSha: "head-queued",
        status: "pending_review",
        coverageState: "pending_review",
        queueState: "running",
        queueSource: "manual_command",
        queueLane: "manual",
        priority: 7,
        latestVerdict: "running",
        proofStatus: "pending_review",
        reason: "next eligible at 2026-07-01T00:05:00.000Z",
        updatedAt: "2026-07-01T00:02:00.000Z",
        nextAction: "wait for durable queue worker to review this head"
      })
    ]);
  });

  it("uses provider-deferred coverage updatedAt for dashboard freshness", () => {
    const dashboard = buildOperatorDashboard({
      coverage: coverageReport({
        ok: true,
        providerDeferred: [
          providerDeferredEntry(7, "head-provider", {
            createdAt: "2026-07-01T00:01:00.000Z",
            updatedAt: "2026-07-01T00:02:00.000Z"
          })
        ]
      }),
      checkedAt: "2026-07-02T00:00:00.000Z"
    });

    expect(dashboard.items).toEqual([
      expect.objectContaining({
        repo: "owner/repo",
        pullNumber: 7,
        status: "provider_deferred",
        reason: "provider_request_rate_limit",
        updatedAt: "2026-07-01T00:02:00.000Z"
      })
    ]);
  });

  it("preserves the strongest blocked dashboard source when later sources are benign", () => {
    const dashboard = buildOperatorDashboard({
      coverage: coverageReport({ ok: true, processed: [processedEntry(7, "head-failed", "posted")] }),
      durableQueue: durableQueueSnapshot({
        jobs: [durableJob({ repo: "owner/repo", pullNumber: 7, headSha: "head-failed", state: "failed", priority: 10 })],
        summary: { total: 1, queued: 0, failed: 1, running: 0, providerDeferred: 0, retryableProviderDeferred: 0 }
      }),
      readiness: [{
        repo: "owner/repo",
        pullNumber: 7,
        headSha: "head-failed",
        state: "ready_for_human",
        reason: "review posted",
        createdAt: "2026-07-01T00:00:00.000Z",
        updatedAt: "2026-07-01T00:05:00.000Z"
      }, {
        repo: "owner/repo",
        pullNumber: 8,
        headSha: "head-proof",
        state: "blocked_on_proof",
        reason: "missing proof",
        createdAt: "2026-07-01T00:00:00.000Z",
        updatedAt: "2026-07-01T00:06:00.000Z"
      }],
      checkedAt: "2026-07-02T00:00:00.000Z"
    });

    expect(dashboard.ok).toBe(false);
    expect(dashboard.items).toEqual([
      expect.objectContaining({
        repo: "owner/repo",
        pullNumber: 7,
        status: "failed",
        queueState: "failed",
        readinessState: "ready_for_human",
        nextAction: "inspect failure evidence and retry or retire the head"
      }),
      expect.objectContaining({
        repo: "owner/repo",
        pullNumber: 8,
        status: "blocked_on_proof"
      })
    ]);
  });

  it("keeps blocked-on-proof readiness above processed coverage for the same head", () => {
    const dashboard = buildOperatorDashboard({
      coverage: coverageReport({ ok: true, processed: [processedEntry(8, "head-proof", "posted")] }),
      readiness: [{
        repo: "owner/repo",
        pullNumber: 8,
        headSha: "head-proof",
        state: "blocked_on_proof",
        reason: "missing proof",
        createdAt: "2026-07-01T00:00:00.000Z",
        updatedAt: "2026-07-01T00:06:00.000Z"
      }],
      checkedAt: "2026-07-02T00:00:00.000Z"
    });

    expect(dashboard.ok).toBe(false);
    expect(dashboard.items).toEqual([
      expect.objectContaining({
        repo: "owner/repo",
        pullNumber: 8,
        status: "blocked_on_proof",
        coverageState: "processed",
        readinessState: "blocked_on_proof",
        proofStatus: "blocked_on_proof",
        nextAction: "collect required proof before merge-ready claim"
      })
    ]);
  });

  it("surfaces failed processed coverage rows as blocked dashboard failures", () => {
    const dashboard = buildOperatorDashboard({
      coverage: coverageReport({
        ok: true,
        processed: [{
          ...processedEntry(10, "head-failed", "failed"),
          error: "ZCode failed ghp_123456789012345678901234"
        }]
      }),
      checkedAt: "2026-07-02T00:00:00.000Z"
    });

    expect(dashboard.ok).toBe(false);
    expect(dashboard.summary).toMatchObject({
      totalItems: 1,
      blockedItems: 1,
      failed: 1
    });
    expect(dashboard.items).toEqual([
      expect.objectContaining({
        repo: "owner/repo",
        pullNumber: 10,
        status: "failed",
        coverageState: "processed",
        proofStatus: "failed",
        lastError: "ZCode failed [redacted-secret]",
        nextAction: "inspect failure evidence and retry or retire the head"
      })
    ]);
    expect(JSON.stringify(dashboard)).not.toMatch(/ghp_123456789012345678901234/);
  });

  it("renders every dashboard row in the human formatter", () => {
    const dashboard = buildOperatorDashboard({
      coverage: coverageReport({
        ok: true,
        processed: Array.from({ length: 21 }, (_, index) => processedEntry(index + 1, `head-${index + 1}`, "posted"))
      }),
      checkedAt: "2026-07-02T00:00:00.000Z"
    });

    const output = formatOperatorDashboardHuman(dashboard);

    expect(output).toContain("owner/repo#21");
  });

  it("gives needs-fix dashboard rows a concrete next action", () => {
    const dashboard = buildOperatorDashboard({
      coverage: coverageReport({ ok: true }),
      readiness: [{
        repo: "owner/repo",
        pullNumber: 9,
        headSha: "head-needs-fix",
        state: "needs_fix",
        reason: "REQUEST_CHANGES review posted",
        event: "REQUEST_CHANGES",
        reviewUrl: "https://github.com/owner/repo/pull/9#pullrequestreview-2",
        createdAt: "2026-07-01T00:00:00.000Z",
        updatedAt: "2026-07-01T00:06:00.000Z"
      }],
      checkedAt: "2026-07-02T00:00:00.000Z"
    });

    expect(dashboard.ok).toBe(false);
    expect(dashboard.items[0]).toMatchObject({
      status: "needs_fix",
      latestVerdict: "REQUEST_CHANGES",
      nextAction: "wait for author fixes or review the requested changes"
    });
  });

  it("filters runtime processes to bot-owned rows and redacts command text", () => {
    const rows = [
      { pid: 10, ppid: 1, command: "node /Volumes/LEXAR/repos/evaos-code-review-bot/dist/cli.js daemon --config live.json --token=ghp_123456789012345678901234" },
      { pid: 11, ppid: 10, command: "node /Applications/ZCode.app/Contents/Resources/glm/zcode.cjs --cwd /Volumes/LEXAR/repos/some-worktree" },
      { pid: 12, ppid: 1, command: "node /Applications/ZCode.app/Contents/Resources/glm/zcode.cjs --cwd /Users/lume/other" },
      { pid: 13, ppid: 1, command: "node /tmp/not-the-bot.js" },
      { pid: 14, ppid: 13, command: "node child-of-non-bot.js" },
      { pid: 15, ppid: 1, command: "tsx src/cli.ts daemon --launchd-label com.electricsheephq.evaos-code-review-bot" }
    ];

    const processes = filterBotProcessRows(rows, {
      repoPath: "/Volumes/LEXAR/repos/evaos-code-review-bot",
      launchdLabel: "com.electricsheephq.evaos-code-review-bot",
      launchdPid: 10
    });

    expect(processes.map((processRow) => processRow.pid)).toEqual([10, 11, 15]);
    expect(processes[0]).toMatchObject({
      classification: "launchd_worker",
      matchedBy: ["launchd_pid", "repo_path"]
    });
    expect(processes[1]).toMatchObject({
      classification: "child_process",
      matchedBy: ["child_of_bot_process"]
    });
    expect(JSON.stringify(processes)).not.toMatch(/ghp_123456789012345678901234/);
    expect(JSON.stringify(processes)).toContain("[redacted-secret]");
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

  it("treats a bounded active heartbeat as healthy for live agent inventory", () => {
    const inventory = summarizeAgentInventory({
      launchd: { label: "com.electricsheephq.evaos-code-review-bot", state: "running", pid: 1234, dryRun: false },
      heartbeat: {
        status: "active",
        maxAgeMs: 120_000,
        activeMaxAgeMs: 660_000,
        latestAt: "2026-07-01T00:00:10.000Z",
        ageMs: 180_000,
        cycle: 42,
        event: "daemon_cycle_complete",
        dryRun: false,
        activeCycle: 43,
        activeStartedAt: "2026-07-01T00:02:00.000Z",
        activeAgeMs: 60_000
      },
      leases: [
        lease("active", "2026-07-01T00:02:00.000Z", "2026-07-01T00:17:00.000Z", 1234, true)
      ],
      now: new Date("2026-07-01T00:03:00.000Z")
    });

    expect(inventory.ok).toBe(true);
    expect(inventory.summary).toMatchObject({ activeLeases: 1, staleLeases: 0 });
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

    const limited = collectOperatorReviewQueue(statePath, {
      now: new Date("2026-07-01T00:05:00.000Z"),
      limit: 2
    });
    expect(limited.jobs).toHaveLength(2);
    expect(limited.summary.total).toBe(5);
    expect(limited.byRepo).toEqual([
      expect.objectContaining({ repo: "owner/other", total: 2, failed: 1 }),
      expect.objectContaining({ repo: "owner/repo", total: 3, queued: 1 })
    ]);
  });

  it("builds queue buckets from coverage audit output", () => {
    const queue = buildOperatorQueue(coverageReport({
      processed: [processedEntry(1, "head-posted", "posted")],
      providerDeferred: [providerDeferredEntry(2, "head-provider")],
      queued: [queuedEntry(6, "head-queued")],
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
      queued: 1,
      pending: 1,
      skipped: 1,
      staleHeads: 1
    });
    expect(queue.pending[0]).toMatchObject({ pullNumber: 3, state: "pending_review" });
    expect(queue.providerDeferred[0]).toMatchObject({ pullNumber: 2, state: "provider_deferred" });
    expect(queue.queued[0]).toMatchObject({ pullNumber: 6, state: "pending_review", status: "queued" });
  });

  it("reads review readiness rows from SQLite without creating or mutating state", () => {
    const statePath = createTempDatabase(tempDirs);
    const db = new DatabaseSync(statePath);
    try {
      db.exec("create table review_readiness (repo text not null, pull_number integer not null, head_sha text not null, state text not null, reason text, event text, review_url text, command_action text, command_comment_id integer, created_at text not null, updated_at text not null, primary key (repo, pull_number, head_sha))");
      db.prepare("insert into review_readiness (repo, pull_number, head_sha, state, reason, event, review_url, command_action, command_comment_id, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run("owner/repo", 7, "head-ready", "ready_for_human", "review posted", "COMMENT", "https://github.com/owner/repo/pull/7#pullrequestreview-1", null, null, "2026-07-01T00:00:00.000Z", "2026-07-01T00:05:00.000Z");
      db.prepare("insert into review_readiness (repo, pull_number, head_sha, state, reason, event, review_url, command_action, command_comment_id, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run("owner/other", 8, "head-command", "command_recorded", "manual review requested", null, null, "review", 999, "2026-07-01T00:00:00.000Z", "2026-07-01T00:04:00.000Z");
    } finally {
      db.close();
    }

    expect(collectOperatorReviewReadiness(statePath, { repo: "owner/repo" })).toEqual([
      {
        repo: "owner/repo",
        pullNumber: 7,
        headSha: "head-ready",
        state: "ready_for_human",
        reason: "review posted",
        event: "COMMENT",
        reviewUrl: "https://github.com/owner/repo/pull/7#pullrequestreview-1",
        createdAt: "2026-07-01T00:00:00.000Z",
        updatedAt: "2026-07-01T00:05:00.000Z"
      }
    ]);
    expect(collectOperatorReviewReadiness(join(tmpdir(), "missing-evaos-state.sqlite"))).toEqual([]);
  });

  it("explains why a PR head is or is not reviewed", () => {
    const report = coverageReport({
      processed: [processedEntry(1, "head-posted", "posted")],
      providerDeferred: [providerDeferredEntry(2, "head-cooldown")],
      queued: [
        queuedEntry(6, "head-queued", {
          queueState: "running",
          nextEligibleAt: "2026-07-01T00:05:00.000Z"
        })
      ],
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
    expect(explainPullStatus(report, "owner/repo", 6)).toMatchObject({
      state: "pending_review",
      reason: "durable queue state running",
      nextEligibleAt: "2026-07-01T00:05:00.000Z",
      nextAction: "wait_for_durable_queue_worker"
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

function releaseStatus(input: {
  ok: boolean;
  recommendedActions?: string[];
  database?: Partial<ReleaseStatus["database"]>;
  budget?: ReviewBudgetStatus;
}): ReleaseStatus {
  const providerCooldownCount = input.database?.providerCooldownCount ?? (input.ok ? 0 : 1);
  const expiredProviderCooldownCount = input.database?.expiredProviderCooldownCount ?? providerCooldownCount;
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
      providerCooldownCount,
      expiredProviderCooldownCount,
      activeProviderCooldownCount: 0,
      ...input.database
    },
    ...(input.budget ? { budget: input.budget } : {}),
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
    gates: [
      {
        name: "provider_cooldown_backlog",
        ok: input.ok,
        detail: input.ok
          ? `${input.database?.retryableExpiredProviderCooldownCount ?? expiredProviderCooldownCount} expired provider cooldown row(s)`
          : "1 expired provider cooldown row(s)"
      }
    ],
    rollback: {
      restartCommand: "launchctl kickstart -k gui/501/com.electricsheephq.evaos-code-review-bot",
      unloadCommand: "launchctl bootout gui/501 ~/Library/LaunchAgents/com.electricsheephq.evaos-code-review-bot.plist"
    }
  };
}

function reviewBudgetStatus(): ReviewBudgetStatus {
  return {
    enabled: true,
    checkedAt: "2026-07-01T00:30:00.000Z",
    config: {
      reviewConcurrency: {
        maxActiveRuns: 1,
        leaseTtlMs: 60_000
      },
      scheduler: {
        enabled: true,
        maxProviderActive: 1,
        maxOrgActive: 1,
        maxRepoActive: 1,
        maxQueuedPerRepo: 10,
        manualCommandReserve: 1,
        backgroundPriority: 50
      }
    },
    active: {
      total: 0,
      leased: 0,
      running: 0,
      manual: 0,
      background: 0,
      byProvider: [],
      byOrg: [],
      byRepo: []
    },
    queued: {
      total: 2,
      manual: 1,
      background: 1,
      providerDeferred: 0,
      retryableProviderDeferred: 0
    },
    manualReserve: {
      configured: 1,
      activeManual: 0,
      queuedManual: 1,
      reservedSlotsOpen: 1,
      backgroundSlotsAvailableBeforeReserve: 0
    },
    wouldLeaseCount: 1,
    delayedCount: 1,
    details: {
      included: true,
      detailLimit: 50,
      wouldLeaseReturned: 1,
      delayedReturned: 1,
      detailsTruncated: false,
      inputJobs: 2,
      inputJobLimit: 1_000,
      inputJobsTruncated: false
    },
    wouldLease: [{
      jobId: "manual-job",
      source: "manual_command",
      lane: "manual",
      repo: "owner/repo",
      org: "owner",
      pullNumber: 7,
      headSha: "head-manual",
      providerId: "zai",
      priority: 40
    }],
    delayed: [{
      reason: "manual_reserve",
      jobId: "background-job",
      source: "automatic",
      lane: "background",
      repo: "owner/repo",
      org: "owner",
      pullNumber: 8,
      headSha: "head-background",
      providerId: "zai",
      priority: 30,
      state: "queued"
    }],
    delayedByReason: {
      manual_reserve: 1
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
      queued: input.queued?.length ?? 0,
      unprocessed: input.unprocessed?.length ?? 0,
      skipped: input.skipped?.length ?? 0,
      staleHeads: input.staleHeads?.length ?? 0,
      readFailures: input.readFailures?.length ?? 0
    },
    processed: input.processed ?? [],
    providerDeferred: input.providerDeferred ?? [],
    queued: input.queued ?? [],
    unprocessed: input.unprocessed ?? [],
    skipped: input.skipped ?? [],
    staleHeads: input.staleHeads ?? [],
    readFailures: input.readFailures ?? []
  };
  report.summary.pullsSeen =
    report.summary.processed +
    report.summary.providerDeferred +
    report.summary.queued +
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

function processedEntry(pullNumber: number, headSha: string, status: "posted" | "skipped" | "failed") {
  return {
    ...pullEntry(pullNumber, headSha),
    status,
    event: status === "posted" ? "COMMENT" as const : undefined,
    createdAt: "2026-07-01 00:00:00"
  };
}

function providerDeferredEntry(
  pullNumber: number,
  headSha: string,
  overrides: Partial<CoverageAuditReport["providerDeferred"][number]> = {}
) {
  return {
    ...processedEntry(pullNumber, headSha, "skipped"),
    cooldownUntil: "2026-07-01T00:05:00.000Z",
    reason: "provider_request_rate_limit",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides
  };
}

function queuedEntry(
  pullNumber: number,
  headSha: string,
  overrides: Partial<CoverageQueuedEntry> = {}
): CoverageQueuedEntry {
  return {
    ...pullEntry(pullNumber, headSha),
    queueState: "queued" as const,
    source: "automatic",
    lane: "background",
    priority: 50,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides
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

function repoProviderCooldown(repo: string, cooldownUntil: string): RepoProviderCooldownRecord {
  return {
    repo,
    cooldownUntil,
    reason: "provider_request_rate_limit",
    updatedAt: "2026-07-01T00:00:00.000Z"
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

function durableQueueSnapshot(input: {
  ok?: boolean;
  summary?: Partial<OperatorDurableQueueSnapshot["summary"]>;
  jobs?: OperatorDurableQueueSnapshot["jobs"];
  byRepo?: OperatorDurableQueueSnapshot["byRepo"];
} = {}): OperatorDurableQueueSnapshot {
  return {
    ok: input.ok ?? false,
    checkedAt: "2026-07-01T00:30:00.000Z",
    summary: {
      total: input.summary?.total ?? 4,
      queued: input.summary?.queued ?? 1,
      leased: input.summary?.leased ?? 0,
      running: input.summary?.running ?? 1,
      providerDeferred: input.summary?.providerDeferred ?? 1,
      retryableProviderDeferred: input.summary?.retryableProviderDeferred ?? 1,
      commandRecorded: input.summary?.commandRecorded ?? 0,
      posted: input.summary?.posted ?? 0,
      failed: input.summary?.failed ?? 1,
      retired: input.summary?.retired ?? 0
    },
    jobs: input.jobs ?? [],
    byRepo: input.byRepo ?? []
  };
}

function cleanDurableQueueSummary(): Partial<OperatorDurableQueueSnapshot["summary"]> {
  return {
    total: 0,
    queued: 0,
    leased: 0,
    running: 0,
    providerDeferred: 0,
    retryableProviderDeferred: 0,
    commandRecorded: 0,
    posted: 0,
    failed: 0,
    retired: 0
  };
}

function durableJob(input: Partial<OperatorDurableQueueSnapshot["jobs"][number]> & {
  repo: string;
  pullNumber: number;
  headSha: string;
  state: OperatorDurableQueueSnapshot["jobs"][number]["state"];
}): OperatorDurableQueueSnapshot["jobs"][number] {
  return {
    jobId: `${input.state}-${input.headSha}`,
    attemptId: `${input.state}:${input.repo}#${input.pullNumber}@${input.headSha}`,
    source: input.source ?? "automatic",
    lane: input.lane ?? "background",
    repo: input.repo,
    org: input.repo.split("/")[0]!,
    pullNumber: input.pullNumber,
    headSha: input.headSha,
    providerId: input.providerId ?? "zai",
    priority: input.priority ?? 50,
    state: input.state,
    ...(input.nextEligibleAt ? { nextEligibleAt: input.nextEligibleAt } : {}),
    ...(input.reviewUrl ? { reviewUrl: input.reviewUrl } : {}),
    ...(input.lastError ? { lastError: input.lastError } : {}),
    createdAt: input.createdAt ?? "2026-07-01T00:00:00.000Z",
    updatedAt: input.updatedAt ?? "2026-07-01T00:00:00.000Z"
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
