import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type {
  CoverageAuditReport,
  CoverageProcessedEntry,
  CoverageProviderDeferredEntry,
  CoverageSkippedEntry,
  CoverageStaleHead,
  CoverageUnprocessedEntry
} from "./coverage-audit.js";
import type { ReleaseHeartbeatStatus, ReleaseLaunchdStatus, ReleaseStatus } from "./release-status.js";
import {
  parseProviderCooldownError,
  PROVIDER_COOLDOWN_ERROR_PREFIX,
  type ProviderCooldownReviewRecord,
  type RepoProviderCooldownRecord
} from "./state.js";

export interface OperatorStatus {
  ok: boolean;
  checkedAt: string;
  summary: {
    launchdState: ReleaseLaunchdStatus["state"];
    heartbeatStatus: ReleaseHeartbeatStatus["status"];
    activeLeases: number;
    staleLeases: number;
    pendingHeads: number;
    providerDeferredHeads: number;
    skippedHeads: number;
    staleHeads: number;
    readFailures: number;
    failedRows: number;
    expiredProviderCooldowns: number;
    activeProviderCooldowns: number;
  };
  gates: Array<{ name: string; ok: boolean; detail: string }>;
  recommendedActions: string[];
  release: ReleaseStatus;
  coverage?: OperatorQueueSnapshot;
  agents: OperatorAgentInventory;
  providerCooldowns: ProviderCooldownReviewRecord[];
}

export interface OperatorLease {
  leaseId: string;
  startedAt: string;
  expiresAt: string;
  ownerPid?: number;
  ownerAlive?: boolean;
}

export interface OperatorLeaseWithState extends OperatorLease {
  staleReason?: "expired" | "owner_not_running";
}

export interface OperatorAgentInventory {
  ok: boolean;
  checkedAt: string;
  launchd: ReleaseLaunchdStatus;
  heartbeat: ReleaseHeartbeatStatus;
  summary: {
    totalLeases: number;
    activeLeases: number;
    staleLeases: number;
  };
  activeLeases: OperatorLeaseWithState[];
  staleLeases: OperatorLeaseWithState[];
}

export interface OperatorQueueEntry {
  state: "processed" | "provider_deferred" | "pending_review" | "skipped" | "stale_head";
  repo: string;
  pullNumber?: number;
  headSha?: string;
  title?: string;
  url?: string;
  status?: string;
  reason?: string;
  nextAction: string;
}

export interface OperatorQueueSnapshot {
  ok: boolean;
  checkedAt: string;
  summary: {
    processed: number;
    providerDeferred: number;
    pending: number;
    skipped: number;
    staleHeads: number;
    readFailures: number;
  };
  processed: OperatorQueueEntry[];
  providerDeferred: OperatorQueueEntry[];
  pending: OperatorQueueEntry[];
  skipped: OperatorQueueEntry[];
  staleHeads: OperatorQueueEntry[];
  readFailures: Array<{ repo: string; error: string; nextAction: string }>;
}

export interface PullStatusExplanation {
  repo: string;
  pullNumber: number;
  state: OperatorQueueEntry["state"] | "read_failure" | "unknown";
  headSha?: string;
  reason?: string;
  reviewUrl?: string;
  error?: string;
  nextAction: "none" | "wait_or_retry_provider_cooldown" | "run_or_wait_for_daemon" | "inspect_github_read_failure" | "run_scoped_coverage_audit";
}

export function buildOperatorStatus(input: {
  release: ReleaseStatus;
  coverage?: CoverageAuditReport;
  agents: OperatorAgentInventory;
  providerCooldowns?: ProviderCooldownReviewRecord[];
  checkedAt?: string;
}): OperatorStatus {
  const queue = input.coverage ? buildOperatorQueue(input.coverage) : undefined;
  const providerCooldowns = input.providerCooldowns ?? [];
  const expiredProviderCooldowns = providerCooldowns.filter((cooldown) => cooldown.expired).length;
  const activeProviderCooldowns = providerCooldowns.length - expiredProviderCooldowns;
  const pendingHeads = queue?.summary.pending ?? 0;
  const providerDeferredHeads = queue?.summary.providerDeferred ?? 0;
  const readFailures = queue?.summary.readFailures ?? 0;
  const staleHeads = queue?.summary.staleHeads ?? 0;
  const failedRows = input.release.database.errorCount;

  const gates = [
    ...input.release.gates,
    {
      name: "queue_no_pending_heads",
      ok: pendingHeads === 0,
      detail: pendingHeads === 0 ? "0 pending head(s)" : `${pendingHeads} pending head(s)`
    },
    {
      name: "queue_no_read_failures",
      ok: readFailures === 0,
      detail: readFailures === 0 ? "0 read failure(s)" : `${readFailures} read failure(s)`
    },
    {
      name: "queue_no_stale_heads",
      ok: staleHeads === 0,
      detail: staleHeads === 0 ? "0 stale head(s)" : `${staleHeads} stale head(s)`
    },
    {
      name: "agents_no_stale_leases",
      ok: input.agents.summary.staleLeases === 0,
      detail: input.agents.summary.staleLeases === 0
        ? "0 stale lease(s)"
        : `${input.agents.summary.staleLeases} stale lease(s)`
    }
  ];

  const recommendedActions = uniqueStrings([
    ...input.release.recommendedActions,
    ...(pendingHeads > 0 ? ["wait for daemon cycle or run scoped run-once"] : []),
    ...(readFailures > 0 ? ["run doctor and inspect GitHub App installation/read permissions"] : []),
    ...(staleHeads > 0 ? ["wait for next daemon cycle or run scoped coverage audit"] : []),
    ...(input.agents.summary.staleLeases > 0 ? ["inspect agents output before restarting or retiring stale work"] : [])
  ]);

  return {
    ok: gates.every((gate) => gate.ok),
    checkedAt: input.checkedAt ?? input.release.checkedAt,
    summary: {
      launchdState: input.release.launchd.state,
      heartbeatStatus: input.release.heartbeat.status,
      activeLeases: input.agents.summary.activeLeases,
      staleLeases: input.agents.summary.staleLeases,
      pendingHeads,
      providerDeferredHeads,
      skippedHeads: queue?.summary.skipped ?? 0,
      staleHeads,
      readFailures,
      failedRows,
      expiredProviderCooldowns,
      activeProviderCooldowns
    },
    gates,
    recommendedActions,
    release: input.release,
    ...(queue ? { coverage: queue } : {}),
    agents: input.agents,
    providerCooldowns
  };
}

export function summarizeAgentInventory(input: {
  launchd: ReleaseLaunchdStatus;
  heartbeat: ReleaseHeartbeatStatus;
  leases: OperatorLease[];
  now?: Date;
  checkedAt?: string;
}): OperatorAgentInventory {
  const now = input.now ?? new Date();
  const activeLeases: OperatorLeaseWithState[] = [];
  const staleLeases: OperatorLeaseWithState[] = [];
  for (const lease of input.leases) {
    if (lease.ownerAlive === false) {
      staleLeases.push({ ...lease, staleReason: "owner_not_running" });
      continue;
    }
    const expiresAtMs = Date.parse(lease.expiresAt);
    if (Number.isFinite(expiresAtMs) && expiresAtMs <= now.getTime()) {
      staleLeases.push({ ...lease, staleReason: "expired" });
      continue;
    }
    activeLeases.push(lease);
  }

  return {
    ok: input.launchd.state === "running" && input.heartbeat.status === "fresh" && staleLeases.length === 0,
    checkedAt: input.checkedAt ?? now.toISOString(),
    launchd: input.launchd,
    heartbeat: input.heartbeat,
    summary: {
      totalLeases: input.leases.length,
      activeLeases: activeLeases.length,
      staleLeases: staleLeases.length
    },
    activeLeases,
    staleLeases
  };
}

export function collectOperatorLeases(statePath: string): OperatorLease[] {
  if (!existsSync(statePath)) return [];
  const db = new DatabaseSync(statePath, { readOnly: true });
  try {
    const table = db
      .prepare("select 1 from sqlite_master where type = 'table' and name = 'review_run_leases' limit 1")
      .get();
    if (!table) return [];
    const columns = db.prepare("pragma table_info(review_run_leases)").all() as unknown as Array<{ name: string }>;
    const hasOwnerPid = columns.some((column) => column.name === "owner_pid");
    const rows = db
      .prepare(
        hasOwnerPid
          ? "select lease_id, started_at, expires_at, owner_pid from review_run_leases order by datetime(started_at) asc"
          : "select lease_id, started_at, expires_at, null as owner_pid from review_run_leases order by datetime(started_at) asc"
      )
      .all() as unknown as Array<{
        lease_id: string;
        started_at: string;
        expires_at: string;
        owner_pid: number | null;
      }>;
    return rows.map((row) => ({
      leaseId: row.lease_id,
      startedAt: row.started_at,
      expiresAt: row.expires_at,
      ...(row.owner_pid ? { ownerPid: row.owner_pid, ownerAlive: isProcessAlive(row.owner_pid) } : {})
    }));
  } finally {
    db.close();
  }
}

export function collectOperatorProviderCooldowns(
  statePath: string,
  input: { repo?: string; now?: Date; expiredOnly?: boolean; limit?: number } = {}
): ProviderCooldownReviewRecord[] {
  if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1)) {
    throw new Error("limit must be a positive integer");
  }
  if (!existsSync(statePath)) return [];
  const db = new DatabaseSync(statePath, { readOnly: true });
  try {
    if (!hasTable(db, "processed_reviews")) return [];
    const rows = (input.repo
      ? db
          .prepare(
            `select repo, pull_number, head_sha, status, event, review_url, error, created_at
             from processed_reviews
             where repo = ? and status = 'skipped' and error like ?
             order by datetime(created_at) asc`
          )
          .all(input.repo, `${PROVIDER_COOLDOWN_ERROR_PREFIX}%`)
      : db
          .prepare(
            `select repo, pull_number, head_sha, status, event, review_url, error, created_at
             from processed_reviews
             where status = 'skipped' and error like ?
             order by datetime(created_at) asc`
          )
          .all(`${PROVIDER_COOLDOWN_ERROR_PREFIX}%`)) as unknown as ProcessedReviewRow[];
    const now = input.now ?? new Date();
    const mapped: ProviderCooldownReviewRecord[] = [];
    for (const row of rows) {
      const parsed = parseProviderCooldownError(row.error ?? undefined);
      if (!parsed) continue;
        const cooldownUntilMs = Date.parse(parsed.cooldownUntil);
        const expired = !Number.isFinite(cooldownUntilMs) || cooldownUntilMs <= now.getTime();
      const record: ProviderCooldownReviewRecord = {
          repo: row.repo,
          pullNumber: row.pull_number,
          headSha: row.head_sha,
        status: row.status as ProviderCooldownReviewRecord["status"],
          ...(row.event ? { event: row.event } : {}),
          ...(row.review_url ? { reviewUrl: row.review_url } : {}),
          ...(row.error ? { error: row.error } : {}),
          createdAt: row.created_at,
          cooldownUntil: parsed.cooldownUntil,
          ...(parsed.reason ? { reason: parsed.reason } : {}),
          expired
        };
      if (!input.expiredOnly || record.expired) mapped.push(record);
    }
    return input.limit ? mapped.slice(0, input.limit) : mapped;
  } finally {
    db.close();
  }
}

export function collectOperatorRepoProviderCooldowns(
  statePath: string,
  input: { repo?: string; activeOnly?: boolean; now?: Date } = {}
): RepoProviderCooldownRecord[] {
  if (!existsSync(statePath)) return [];
  const db = new DatabaseSync(statePath, { readOnly: true });
  try {
    if (!hasTable(db, "repo_provider_cooldowns")) return [];
    const rows = (input.repo
      ? db
          .prepare(
            `select repo, cooldown_until, reason, updated_at
             from repo_provider_cooldowns
             where repo = ?
             order by datetime(cooldown_until) desc`
          )
          .all(input.repo)
      : db
          .prepare(
            `select repo, cooldown_until, reason, updated_at
             from repo_provider_cooldowns
             order by datetime(cooldown_until) desc`
          )
          .all()) as unknown as RepoProviderCooldownRow[];
    const cooldowns = rows.map((row) => ({
      repo: row.repo,
      cooldownUntil: row.cooldown_until,
      reason: row.reason,
      updatedAt: row.updated_at
    }));
    if (!input.activeOnly) return cooldowns;
    const now = input.now ?? new Date();
    return cooldowns.filter((cooldown) => {
      const cooldownUntilMs = Date.parse(cooldown.cooldownUntil);
      return Number.isFinite(cooldownUntilMs) && cooldownUntilMs > now.getTime();
    });
  } finally {
    db.close();
  }
}

export function buildOperatorQueue(report: CoverageAuditReport): OperatorQueueSnapshot {
  return {
    ok: report.summary.unprocessed === 0 && report.summary.readFailures === 0 && report.summary.staleHeads === 0,
    checkedAt: report.checkedAt,
    summary: {
      processed: report.processed.length,
      providerDeferred: report.providerDeferred.length,
      pending: report.unprocessed.length,
      skipped: report.skipped.length,
      staleHeads: report.staleHeads.length,
      readFailures: report.readFailures.length
    },
    processed: report.processed.map(processedQueueEntry),
    providerDeferred: report.providerDeferred.map(providerDeferredQueueEntry),
    pending: report.unprocessed.map(pendingQueueEntry),
    skipped: report.skipped.map(skippedQueueEntry),
    staleHeads: report.staleHeads.map(staleHeadQueueEntry),
    readFailures: report.readFailures.map((failure) => ({
      ...failure,
      nextAction: "inspect GitHub App installation/read permissions or network failure"
    }))
  };
}

export function explainPullStatus(
  report: CoverageAuditReport,
  repo: string,
  pullNumber: number
): PullStatusExplanation {
  const providerDeferred = report.providerDeferred.find((entry) => entry.repo === repo && entry.pullNumber === pullNumber);
  if (providerDeferred) {
    return {
      repo,
      pullNumber,
      state: "provider_deferred",
      headSha: providerDeferred.headSha,
      ...(providerDeferred.reason ? { reason: providerDeferred.reason } : {}),
      ...(providerDeferred.error ? { error: providerDeferred.error } : {}),
      nextAction: "wait_or_retry_provider_cooldown"
    };
  }

  const staleHead = report.staleHeads.find((entry) => entry.repo === repo && entry.pullNumber === pullNumber);
  if (staleHead) {
    return {
      repo,
      pullNumber,
      state: "stale_head",
      headSha: staleHead.liveHeadSha,
      reason: `expected ${staleHead.expectedHeadSha}, live ${staleHead.liveHeadSha}`,
      nextAction: "run_or_wait_for_daemon"
    };
  }

  const processed = report.processed.find((entry) => entry.repo === repo && entry.pullNumber === pullNumber);
  if (processed) {
    return {
      repo,
      pullNumber,
      state: "processed",
      headSha: processed.headSha,
      ...(processed.reviewUrl ? { reviewUrl: processed.reviewUrl } : {}),
      ...(processed.error ? { error: processed.error } : {}),
      nextAction: "none"
    };
  }

  const pending = report.unprocessed.find((entry) => entry.repo === repo && entry.pullNumber === pullNumber);
  if (pending) {
    return {
      repo,
      pullNumber,
      state: "pending_review",
      headSha: pending.headSha,
      nextAction: "run_or_wait_for_daemon"
    };
  }

  const skipped = report.skipped.find((entry) => entry.repo === repo && entry.pullNumber === pullNumber);
  if (skipped) {
    return {
      repo,
      pullNumber,
      state: "skipped",
      ...(skipped.headSha ? { headSha: skipped.headSha } : {}),
      reason: skipped.reason,
      nextAction: "none"
    };
  }

  const readFailure = report.readFailures.find((entry) => entry.repo === repo);
  if (readFailure) {
    return {
      repo,
      pullNumber,
      state: "read_failure",
      error: readFailure.error,
      nextAction: "inspect_github_read_failure"
    };
  }

  return {
    repo,
    pullNumber,
    state: "unknown",
    nextAction: "run_scoped_coverage_audit"
  };
}

function processedQueueEntry(entry: CoverageProcessedEntry): OperatorQueueEntry {
  return {
    state: "processed",
    repo: entry.repo,
    pullNumber: entry.pullNumber,
    headSha: entry.headSha,
    title: entry.title,
    url: entry.url,
    status: entry.status,
    ...(entry.error ? { reason: entry.error } : {}),
    nextAction: "none"
  };
}

function providerDeferredQueueEntry(entry: CoverageProviderDeferredEntry): OperatorQueueEntry {
  return {
    state: "provider_deferred",
    repo: entry.repo,
    pullNumber: entry.pullNumber,
    headSha: entry.headSha,
    title: entry.title,
    url: entry.url,
    status: entry.status,
    reason: entry.reason ?? entry.error ?? "provider cooldown",
    nextAction: "wait for cooldown expiry or run retry-provider-cooldowns when expired"
  };
}

function pendingQueueEntry(entry: CoverageUnprocessedEntry): OperatorQueueEntry {
  return {
    state: "pending_review",
    repo: entry.repo,
    pullNumber: entry.pullNumber,
    headSha: entry.headSha,
    title: entry.title,
    url: entry.url,
    nextAction: "wait for daemon cycle or run scoped run-once"
  };
}

function skippedQueueEntry(entry: CoverageSkippedEntry): OperatorQueueEntry {
  return {
    state: "skipped",
    repo: entry.repo,
    ...(entry.pullNumber !== undefined ? { pullNumber: entry.pullNumber } : {}),
    ...(entry.headSha ? { headSha: entry.headSha } : {}),
    ...(entry.title ? { title: entry.title } : {}),
    ...(entry.url ? { url: entry.url } : {}),
    reason: entry.reason,
    nextAction: "none"
  };
}

function staleHeadQueueEntry(entry: CoverageStaleHead): OperatorQueueEntry {
  return {
    state: "stale_head",
    repo: entry.repo,
    pullNumber: entry.pullNumber,
    headSha: entry.liveHeadSha,
    title: entry.title,
    url: entry.url,
    reason: `expected ${entry.expectedHeadSha}, live ${entry.liveHeadSha}`,
    nextAction: "wait for next daemon cycle or run scoped coverage audit"
  };
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EPERM") return true;
    return false;
  }
}

function hasTable(db: DatabaseSync, tableName: string): boolean {
  return Boolean(
    db
      .prepare("select 1 from sqlite_master where type = 'table' and name = ? limit 1")
      .get(tableName)
  );
}

interface ProcessedReviewRow {
  repo: string;
  pull_number: number;
  head_sha: string;
  status: string;
  event: "COMMENT" | "REQUEST_CHANGES" | null;
  review_url: string | null;
  error: string | null;
  created_at: string;
}

interface RepoProviderCooldownRow {
  repo: string;
  cooldown_until: string;
  reason: string;
  updated_at: string;
}
