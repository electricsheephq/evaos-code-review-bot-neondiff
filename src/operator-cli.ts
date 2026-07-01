import { spawnSync } from "node:child_process";
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
import { redactSecrets } from "./secrets.js";
import {
  parseProviderCooldownError,
  PROVIDER_COOLDOWN_ERROR_PREFIX,
  type ProviderCooldownReviewRecord,
  type ReviewQueueJobRecord,
  type ReviewQueueJobState,
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
    queuedJobs: number;
    runningJobs: number;
    providerDeferredJobs: number;
    failedQueueJobs: number;
  };
  gates: Array<{ name: string; ok: boolean; detail: string }>;
  recommendedActions: string[];
  release: ReleaseStatus;
  coverage?: OperatorQueueSnapshot;
  agents: OperatorAgentInventory;
  providerCooldowns: ProviderCooldownReviewRecord[];
  durableQueue?: OperatorDurableQueueSnapshot;
}

export interface RuntimeInventory {
  ok: boolean;
  checkedAt: string;
  runtimeState: RuntimeClassification;
  classification: RuntimeClassification;
  summary: {
    launchdState: ReleaseLaunchdStatus["state"];
    heartbeatStatus: ReleaseHeartbeatStatus["status"];
    activeLeases: number;
    staleLeases: number;
    activeQueueJobs: number;
    queuedJobs: number;
    runningJobs: number;
    providerDeferredJobs: number;
    failedQueueJobs: number;
    retryableProviderDeferredJobs: number;
    pendingHeads: number;
    coveredPendingHeads: number;
    uncoveredPendingHeads: number;
    providerDeferredHeads: number;
    staleHeads: number;
    readFailures: number;
    expiredProviderCooldowns: number;
    retryableExpiredProviderCooldowns: number;
    coveredExpiredProviderCooldowns: number;
    activeProviderCooldowns: number;
    repoCooldowns: number;
    activeRepoCooldowns: number;
    botProcesses: number;
  };
  gates: Array<{ name: string; ok: boolean; detail: string }>;
  recommendedActions: string[];
  activeWork: ReviewQueueJobRecord[];
  uncoveredPendingHeads: OperatorQueueEntry[];
  release: ReleaseStatus;
  agents: OperatorAgentInventory;
  processes?: RuntimeProcessInventory;
  durableQueue?: OperatorDurableQueueSnapshot;
  coverage?: OperatorQueueSnapshot;
  providerCooldowns: ProviderCooldownReviewRecord[];
  repoProviderCooldowns: RepoProviderCooldownRecord[];
}

export type RuntimeClassification = "healthy_idle" | "healthy_active" | "blocked";

export interface RuntimeProcessRow {
  pid: number;
  ppid: number;
  command: string;
}

export interface RuntimeProcessRecord extends RuntimeProcessRow {
  classification: "launchd_worker" | "repo_command" | "child_process";
  matchedBy: string[];
}

export interface RuntimeProcessInventory {
  ok: boolean;
  checkedAt: string;
  summary: {
    total: number;
    launchdPidMatched: number;
    repoPathMatched: number;
    launchdLabelMatched: number;
    childProcessMatched: number;
    errors: number;
  };
  processes: RuntimeProcessRecord[];
  errors: string[];
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

export interface OperatorDurableQueueSnapshot {
  ok: boolean;
  checkedAt: string;
  summary: {
    total: number;
    queued: number;
    leased: number;
    running: number;
    providerDeferred: number;
    retryableProviderDeferred: number;
    posted: number;
    failed: number;
    retired: number;
  };
  jobs: ReviewQueueJobRecord[];
  byRepo: Array<{
    repo: string;
    total: number;
    queued: number;
    leased: number;
    running: number;
    providerDeferred: number;
    retryableProviderDeferred: number;
    posted: number;
    failed: number;
    retired: number;
  }>;
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
  durableQueue?: OperatorDurableQueueSnapshot;
  checkedAt?: string;
}): OperatorStatus {
  const queue = input.coverage ? buildOperatorQueue(input.coverage) : undefined;
  const providerCooldowns = input.providerCooldowns ?? [];
  const expiredProviderCooldowns = providerCooldowns.filter((cooldown) => cooldown.expired).length;
  const activeProviderCooldowns = providerCooldowns.length - expiredProviderCooldowns;
  const durableQueue = input.durableQueue;
  const pendingHeads = queue?.summary.pending ?? 0;
  const providerDeferredHeads = queue?.summary.providerDeferred ?? 0;
  const readFailures = queue?.summary.readFailures ?? 0;
  const staleHeads = queue?.summary.staleHeads ?? 0;
  const failedRows = input.release.database.errorCount;
  const failedQueueJobs = durableQueue?.summary.failed ?? 0;
  const retryableProviderDeferredJobs = durableQueue?.summary.retryableProviderDeferred ?? 0;

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
    },
    {
      name: "durable_queue_no_failed_jobs",
      ok: failedQueueJobs === 0,
      detail: `${failedQueueJobs} failed durable queue job(s)`
    },
    {
      name: "durable_queue_no_retryable_provider_deferred_jobs",
      ok: retryableProviderDeferredJobs === 0,
      detail: `${retryableProviderDeferredJobs} retryable provider-deferred durable queue job(s)`
    }
  ];

  const recommendedActions = uniqueStrings([
    ...input.release.recommendedActions,
    ...(pendingHeads > 0 ? ["wait for daemon cycle or run scoped run-once"] : []),
    ...(readFailures > 0 ? ["run doctor and inspect GitHub App installation/read permissions"] : []),
    ...(staleHeads > 0 ? ["wait for next daemon cycle or run scoped coverage audit"] : []),
    ...(input.agents.summary.staleLeases > 0 ? ["inspect agents output before restarting or retiring stale work"] : []),
    ...(failedQueueJobs > 0 ? ["inspect operator queue failed jobs before promotion"] : []),
    ...(retryableProviderDeferredJobs > 0 ? ["retry or requeue provider-deferred jobs whose nextEligibleAt has expired"] : [])
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
      activeProviderCooldowns,
      queuedJobs: durableQueue?.summary.queued ?? 0,
      runningJobs: durableQueue?.summary.running ?? 0,
      providerDeferredJobs: durableQueue?.summary.providerDeferred ?? 0,
      failedQueueJobs
    },
    gates,
    recommendedActions,
    release: input.release,
    ...(queue ? { coverage: queue } : {}),
    agents: input.agents,
    providerCooldowns,
    ...(durableQueue ? { durableQueue } : {})
  };
}

export function buildRuntimeInventory(input: {
  release: ReleaseStatus;
  coverage?: CoverageAuditReport;
  agents: OperatorAgentInventory;
  processes?: RuntimeProcessInventory;
  providerCooldowns?: ProviderCooldownReviewRecord[];
  repoProviderCooldowns?: RepoProviderCooldownRecord[];
  durableQueue?: OperatorDurableQueueSnapshot;
  checkedAt?: string;
}): RuntimeInventory {
  const queue = input.coverage ? buildOperatorQueue(input.coverage) : undefined;
  const durableQueue = input.durableQueue;
  const providerCooldowns = input.providerCooldowns ?? [];
  const repoProviderCooldowns = input.repoProviderCooldowns ?? [];
  const activeWork = (durableQueue?.jobs ?? []).filter((job) =>
    job.state === "queued" || job.state === "leased" || job.state === "running"
  );
  const uncoveredPendingHeads = (queue?.pending ?? []).filter((pending) =>
    !activeWork.some((job) => sameHead(job, pending))
  );
  const coveredPendingHeads = (queue?.pending.length ?? 0) - uncoveredPendingHeads.length;
  const expiredProviderCooldowns = providerCooldowns.filter((cooldown) => cooldown.expired).length;
  const activeProviderCooldowns = providerCooldowns.length - expiredProviderCooldowns;
  const checkedAtMs = Date.parse(input.checkedAt ?? input.release.checkedAt);
  const nowMs = Number.isFinite(checkedAtMs) ? checkedAtMs : Date.now();
  const activeRepoCooldowns = repoProviderCooldowns.filter((cooldown) => {
    const cooldownUntilMs = Date.parse(cooldown.cooldownUntil);
    return Number.isFinite(cooldownUntilMs) && cooldownUntilMs > nowMs;
  }).length;
  const coveredExpiredProviderCooldowns =
    input.release.database.coveredExpiredProviderCooldownCount ??
    (activeRepoCooldowns > 0 || activeProviderCooldowns > 0 ? expiredProviderCooldowns : 0);
  const retryableExpiredProviderCooldowns =
    input.release.database.retryableExpiredProviderCooldownCount ??
    Math.max(0, expiredProviderCooldowns - coveredExpiredProviderCooldowns);
  const failedQueueJobs = durableQueue?.summary.failed ?? 0;
  const retryableProviderDeferredJobs = durableQueue?.summary.retryableProviderDeferred ?? 0;
  const providerDeferredJobs = durableQueue?.summary.providerDeferred ?? 0;
  const readFailures = queue?.summary.readFailures ?? 0;
  const staleHeads = queue?.summary.staleHeads ?? 0;
  const providerDeferredHeads = queue?.summary.providerDeferred ?? 0;

  const gates = [
    ...input.release.gates,
    {
      name: "runtime_no_stale_leases",
      ok: input.agents.summary.staleLeases === 0,
      detail: `${input.agents.summary.staleLeases} stale lease(s)`
    },
    {
      name: "runtime_no_failed_queue_jobs",
      ok: failedQueueJobs === 0,
      detail: `${failedQueueJobs} failed durable queue job(s)`
    },
    {
      name: "runtime_no_retryable_provider_deferred_jobs",
      ok: retryableProviderDeferredJobs === 0,
      detail: `${retryableProviderDeferredJobs} retryable provider-deferred durable queue job(s)`
    },
    {
      name: "runtime_pending_heads_covered",
      ok: uncoveredPendingHeads.length === 0,
      detail:
        uncoveredPendingHeads.length === 0
          ? `${coveredPendingHeads} pending head(s) covered by active durable queue work`
          : `${uncoveredPendingHeads.length} pending head(s) without active durable queue work`
    },
    {
      name: "runtime_no_read_failures",
      ok: readFailures === 0,
      detail: `${readFailures} read failure(s)`
    },
    {
      name: "runtime_no_stale_heads",
      ok: staleHeads === 0,
      detail: `${staleHeads} stale head(s)`
    },
    {
      name: "runtime_no_retryable_provider_cooldowns",
      ok: retryableExpiredProviderCooldowns === 0,
      detail:
        `${retryableExpiredProviderCooldowns} retryable expired provider cooldown row(s)` +
        (coveredExpiredProviderCooldowns > 0
          ? `; ${coveredExpiredProviderCooldowns} covered by active provider/repo cooldown`
          : "")
    },
    {
      name: "runtime_process_inventory_available",
      ok: input.processes?.ok ?? true,
      detail: input.processes
        ? `${input.processes.summary.total} bot-owned process(es), ${input.processes.summary.errors} process inventory error(s)`
        : "not collected"
    }
  ];

  const ok = gates.every((gate) => gate.ok);
  const runtimeState: RuntimeClassification = !ok
    ? "blocked"
    : activeWork.length > 0 || coveredPendingHeads > 0 || providerDeferredJobs > 0
      ? "healthy_active"
      : "healthy_idle";

  const recommendedActions = uniqueStrings([
    ...input.release.recommendedActions,
    ...(activeWork.length > 0 ? ["monitor active review work; avoid restarting a healthy in-flight run"] : []),
    ...(uncoveredPendingHeads.length > 0 ? ["wait for daemon cycle or run scoped run-once for uncovered pending heads"] : []),
    ...(readFailures > 0 ? ["run doctor and inspect GitHub App installation/read permissions"] : []),
    ...(input.agents.summary.staleLeases > 0 ? ["inspect stale leases before restarting launchd"] : []),
    ...(failedQueueJobs > 0 ? ["inspect operator queue failed jobs before promotion"] : []),
    ...(retryableProviderDeferredJobs > 0 ? ["retry or requeue provider-deferred jobs whose nextEligibleAt has expired"] : []),
    ...(retryableExpiredProviderCooldowns > 0 ? ["retry expired provider cooldowns or inspect provider health"] : [])
  ]);

  return {
    ok,
    checkedAt: input.checkedAt ?? input.release.checkedAt,
    runtimeState,
    classification: runtimeState,
    summary: {
      launchdState: input.release.launchd.state,
      heartbeatStatus: input.release.heartbeat.status,
      activeLeases: input.agents.summary.activeLeases,
      staleLeases: input.agents.summary.staleLeases,
      activeQueueJobs: activeWork.length,
      queuedJobs: durableQueue?.summary.queued ?? 0,
      runningJobs: durableQueue?.summary.running ?? 0,
      providerDeferredJobs,
      failedQueueJobs,
      retryableProviderDeferredJobs,
      pendingHeads: queue?.summary.pending ?? 0,
      coveredPendingHeads,
      uncoveredPendingHeads: uncoveredPendingHeads.length,
      providerDeferredHeads,
      staleHeads,
      readFailures,
      expiredProviderCooldowns,
      retryableExpiredProviderCooldowns,
      coveredExpiredProviderCooldowns,
      activeProviderCooldowns,
      repoCooldowns: repoProviderCooldowns.length,
      activeRepoCooldowns,
      botProcesses: input.processes?.summary.total ?? 0
    },
    gates,
    recommendedActions,
    activeWork,
    uncoveredPendingHeads,
    release: input.release,
    agents: input.agents,
    ...(input.processes ? { processes: input.processes } : {}),
    ...(durableQueue ? { durableQueue } : {}),
    ...(queue ? { coverage: queue } : {}),
    providerCooldowns,
    repoProviderCooldowns
  };
}

export function collectBotProcessInventory(input: {
  repoPath: string;
  launchdLabel: string;
  launchdPid?: number;
  now?: Date;
}): RuntimeProcessInventory {
  const now = input.now ?? new Date();
  const result = spawnSync("ps", ["-axo", "pid=,ppid=,command="], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024
  });
  if (result.status !== 0) {
    const error = redactSecrets(result.stderr.trim() || `ps exited with status ${result.status ?? "unknown"}`);
    return emptyProcessInventory(now, [error]);
  }
  const rows = parseProcessRows(result.stdout);
  return buildProcessInventory(filterBotProcessRows(rows, input), now);
}

export function filterBotProcessRows(
  rows: RuntimeProcessRow[],
  input: { repoPath: string; launchdLabel: string; launchdPid?: number }
): RuntimeProcessRecord[] {
  const repoPath = input.repoPath.trim();
  const launchdLabel = input.launchdLabel.trim();
  const included = new Map<number, RuntimeProcessRecord>();

  for (const row of rows) {
    const matchedBy: string[] = [];
    if (input.launchdPid !== undefined && row.pid === input.launchdPid) matchedBy.push("launchd_pid");
    if (repoPath && row.command.includes(repoPath)) matchedBy.push("repo_path");
    if (launchdLabel && row.command.includes(launchdLabel)) matchedBy.push("launchd_label");
    if (matchedBy.length > 0) {
      included.set(row.pid, runtimeProcessRecord(row, matchedBy));
    }
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (included.has(row.pid)) continue;
      if (!included.has(row.ppid)) continue;
      if (!looksLikeBotRuntimeChild(row.command)) continue;
      included.set(row.pid, runtimeProcessRecord(row, ["child_of_bot_process"]));
      changed = true;
    }
  }

  return [...included.values()].sort((left, right) => left.pid - right.pid);
}

export function formatRuntimeInventoryHuman(inventory: RuntimeInventory): string {
  const lines = [
    `runtime: ${inventory.classification} (${inventory.ok ? "ok" : "blocked"})`,
    `checkedAt: ${inventory.checkedAt}`,
    `launchd: ${inventory.summary.launchdState}` +
      (inventory.release.launchd.pid ? ` pid=${inventory.release.launchd.pid}` : "") +
      (inventory.release.launchd.configPath ? ` config=${inventory.release.launchd.configPath}` : ""),
    `heartbeat: ${inventory.summary.heartbeatStatus}` +
      (inventory.release.heartbeat.cycle !== undefined ? ` cycle=${inventory.release.heartbeat.cycle}` : "") +
      (inventory.release.heartbeat.ageMs !== undefined ? ` ageMs=${inventory.release.heartbeat.ageMs}` : ""),
    `repo: ${inventory.release.repo.branch}@${inventory.release.repo.head}` +
      (inventory.release.repo.dirtyFiles.length > 0 ? ` dirty=${inventory.release.repo.dirtyFiles.length}` : " clean"),
    `queue: active=${inventory.summary.activeQueueJobs} queued=${inventory.summary.queuedJobs}` +
      ` running=${inventory.summary.runningJobs} providerDeferred=${inventory.summary.providerDeferredJobs}` +
      ` failed=${inventory.summary.failedQueueJobs}`,
    `pending: total=${inventory.summary.pendingHeads} covered=${inventory.summary.coveredPendingHeads}` +
      ` uncovered=${inventory.summary.uncoveredPendingHeads}`,
    `cooldowns: expired=${inventory.summary.expiredProviderCooldowns}` +
      ` retryable=${inventory.summary.retryableExpiredProviderCooldowns}` +
      ` covered=${inventory.summary.coveredExpiredProviderCooldowns}` +
      ` activeRepo=${inventory.summary.activeRepoCooldowns}`,
    `processes: botOwned=${inventory.summary.botProcesses}`,
    `leases: active=${inventory.summary.activeLeases} stale=${inventory.summary.staleLeases}`
  ];

  const failingGates = inventory.gates.filter((gate) => !gate.ok);
  if (failingGates.length > 0) {
    lines.push("failingGates:");
    for (const gate of failingGates) lines.push(`- ${gate.name}: ${gate.detail}`);
  }
  if (inventory.recommendedActions.length > 0) {
    lines.push("recommendedActions:");
    for (const action of inventory.recommendedActions) lines.push(`- ${action}`);
  }
  return lines.join("\n");
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

export function collectOperatorReviewQueue(
  statePath: string,
  input: { repo?: string; state?: ReviewQueueJobState; now?: Date; limit?: number } = {}
): OperatorDurableQueueSnapshot {
  const now = input.now ?? new Date();
  if (!existsSync(statePath)) return emptyDurableQueue(now);
  const db = new DatabaseSync(statePath, { readOnly: true });
  try {
    if (!hasTable(db, "review_queue_jobs")) return emptyDurableQueue(now);
    const selectColumns = reviewQueueSelectColumns(db);
    const rows = (input.repo
      ? db
          .prepare(
            `${selectColumns}
             from review_queue_jobs
             where repo = ?
             order by priority asc, datetime(created_at) asc`
          )
          .all(input.repo)
      : db
          .prepare(
            `${selectColumns}
             from review_queue_jobs
             order by priority asc, datetime(created_at) asc`
          )
          .all()) as unknown as ReviewQueueJobRow[];
    const jobs = rows
      .map(mapReviewQueueJobRow)
      .filter((job) => !input.state || job.state === input.state);
    return buildDurableQueueSnapshot(jobs, now, input.limit ? jobs.slice(0, input.limit) : jobs);
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

function emptyDurableQueue(now: Date): OperatorDurableQueueSnapshot {
  return buildDurableQueueSnapshot([], now);
}

function buildDurableQueueSnapshot(
  jobs: ReviewQueueJobRecord[],
  now: Date,
  visibleJobs: ReviewQueueJobRecord[] = jobs
): OperatorDurableQueueSnapshot {
  const summary = summarizeDurableQueueJobs(jobs, now);
  const repos = [...new Set(jobs.map((job) => job.repo))].sort();
  return {
    ok: summary.failed === 0 && summary.retryableProviderDeferred === 0,
    checkedAt: now.toISOString(),
    summary,
    jobs: visibleJobs,
    byRepo: repos.map((repo) => ({
      repo,
      ...summarizeDurableQueueJobs(jobs.filter((job) => job.repo === repo), now)
    }))
  };
}

function summarizeDurableQueueJobs(jobs: ReviewQueueJobRecord[], now: Date): OperatorDurableQueueSnapshot["summary"] {
  return {
    total: jobs.length,
    queued: jobs.filter((job) => job.state === "queued").length,
    leased: jobs.filter((job) => job.state === "leased").length,
    running: jobs.filter((job) => job.state === "running").length,
    providerDeferred: jobs.filter((job) => job.state === "provider_deferred").length,
    retryableProviderDeferred: jobs.filter((job) => job.state === "provider_deferred" && isRetryableQueueJob(job, now)).length,
    posted: jobs.filter((job) => job.state === "posted").length,
    failed: jobs.filter((job) => job.state === "failed").length,
    retired: jobs.filter((job) => job.state === "stale_retired" || job.state === "closed_retired").length
  };
}

function isRetryableQueueJob(job: ReviewQueueJobRecord, now: Date): boolean {
  if (!job.nextEligibleAt) return true;
  const nextEligibleAtMs = Date.parse(job.nextEligibleAt);
  return !Number.isFinite(nextEligibleAtMs) || nextEligibleAtMs <= now.getTime();
}

function sameHead(job: ReviewQueueJobRecord, pending: OperatorQueueEntry): boolean {
  return job.repo === pending.repo && job.pullNumber === pending.pullNumber && job.headSha === pending.headSha;
}

function mapReviewQueueJobRow(row: ReviewQueueJobRow): ReviewQueueJobRecord {
  return {
    jobId: row.job_id,
    attemptId: row.attempt_id,
    source: row.source,
    lane: row.lane,
    repo: row.repo,
    org: row.org,
    pullNumber: row.pull_number,
    headSha: row.head_sha,
    ...(row.base_sha ? { baseSha: row.base_sha } : {}),
    ...(row.provider_id ? { providerId: row.provider_id } : {}),
    priority: row.priority,
    state: row.state,
    ...(row.next_eligible_at ? { nextEligibleAt: row.next_eligible_at } : {}),
    ...(row.lease_id ? { leaseId: row.lease_id } : {}),
    ...(row.lease_expires_at ? { leaseExpiresAt: row.lease_expires_at } : {}),
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    ...(row.comment_id ? { commentId: row.comment_id } : {}),
    ...(row.review_url ? { reviewUrl: row.review_url } : {}),
    ...(row.last_error ? { lastError: row.last_error } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.started_at ? { startedAt: row.started_at } : {}),
    ...(row.finished_at ? { finishedAt: row.finished_at } : {})
  };
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

function hasColumn(db: DatabaseSync, tableName: string, columnName: string): boolean {
  const columns = db.prepare(`pragma table_info(${tableName})`).all() as unknown as Array<{ name: string }>;
  return columns.some((column) => column.name === columnName);
}

function reviewQueueSelectColumns(db: DatabaseSync): string {
  const leaseExpiresAtColumn = hasColumn(db, "review_queue_jobs", "lease_expires_at")
    ? "lease_expires_at"
    : "null as lease_expires_at";
  return `select job_id, attempt_id, source, lane, repo, org, pull_number, head_sha, base_sha,
                 provider_id, priority, state, next_eligible_at, lease_id, ${leaseExpiresAtColumn}, session_id,
                 comment_id, review_url, last_error, created_at, updated_at, started_at, finished_at`;
}

function emptyProcessInventory(now: Date, errors: string[] = []): RuntimeProcessInventory {
  return {
    ok: errors.length === 0,
    checkedAt: now.toISOString(),
    summary: {
      total: 0,
      launchdPidMatched: 0,
      repoPathMatched: 0,
      launchdLabelMatched: 0,
      childProcessMatched: 0,
      errors: errors.length
    },
    processes: [],
    errors
  };
}

function buildProcessInventory(processes: RuntimeProcessRecord[], now: Date): RuntimeProcessInventory {
  return {
    ok: true,
    checkedAt: now.toISOString(),
    summary: {
      total: processes.length,
      launchdPidMatched: processes.filter((processRow) => processRow.matchedBy.includes("launchd_pid")).length,
      repoPathMatched: processes.filter((processRow) => processRow.matchedBy.includes("repo_path")).length,
      launchdLabelMatched: processes.filter((processRow) => processRow.matchedBy.includes("launchd_label")).length,
      childProcessMatched: processes.filter((processRow) => processRow.matchedBy.includes("child_of_bot_process")).length,
      errors: 0
    },
    processes,
    errors: []
  };
}

function parseProcessRows(stdout: string): RuntimeProcessRow[] {
  return stdout
    .split("\n")
    .map((line) => {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/);
      if (!match) return undefined;
      return {
        pid: Number(match[1]),
        ppid: Number(match[2]),
        command: match[3] ?? ""
      };
    })
    .filter((row): row is RuntimeProcessRow =>
      row !== undefined && Number.isInteger(row.pid) && Number.isInteger(row.ppid)
    );
}

function runtimeProcessRecord(row: RuntimeProcessRow, matchedBy: string[]): RuntimeProcessRecord {
  const classification: RuntimeProcessRecord["classification"] = matchedBy.includes("launchd_pid")
    ? "launchd_worker"
    : matchedBy.includes("child_of_bot_process")
      ? "child_process"
      : "repo_command";
  return {
    pid: row.pid,
    ppid: row.ppid,
    classification,
    matchedBy,
    command: truncateCommand(redactSecrets(row.command))
  };
}

function looksLikeBotRuntimeChild(command: string): boolean {
  return /\b(node|tsx|npm|zcode|evaos-review-bot)\b/i.test(command) || command.includes("zcode.cjs");
}

function truncateCommand(command: string): string {
  return command.length > 240 ? `${command.slice(0, 237)}...` : command;
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

interface ReviewQueueJobRow {
  job_id: string;
  attempt_id: string;
  source: ReviewQueueJobRecord["source"];
  lane: ReviewQueueJobRecord["lane"];
  repo: string;
  org: string;
  pull_number: number;
  head_sha: string;
  base_sha: string | null;
  provider_id: string | null;
  priority: number;
  state: ReviewQueueJobState;
  next_eligible_at: string | null;
  lease_id: string | null;
  lease_expires_at: string | null;
  session_id: string | null;
  comment_id: number | null;
  review_url: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
}
