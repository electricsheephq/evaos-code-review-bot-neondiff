import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  CoverageAuditReport,
  CoverageProcessedEntry,
  CoverageProviderDeferredEntry,
  CoverageQueuedEntry,
  CoverageSkippedEntry,
  CoverageStaleHead,
  CoverageUnprocessedEntry
} from "./coverage-audit.js";
import type { IssueEnrichmentStatus } from "./issue-enrichment.js";
import type { ReviewBudgetStatus } from "./review-budget.js";
import type { ReleaseHeartbeatStatus, ReleaseLaunchdStatus, ReleaseStatus } from "./release-status.js";
import { redactSecrets } from "./secrets.js";
import {
  parseProviderCooldownError,
  PROVIDER_COOLDOWN_ERROR_PREFIX,
  type IssueEnrichmentRecordStatus,
  type ProcessedCommandAction,
  type ProviderCooldownReviewRecord,
  type ReviewReadinessRecord,
  type ReviewReadinessState,
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
    budgetWouldLeaseJobs: number;
    budgetDelayedJobs: number;
    issueEnrichmentState?: IssueEnrichmentStatus["state"];
    issueEnrichmentRuntimeState?: OperatorIssueEnrichmentRuntimeState;
  };
  gates: Array<{ name: string; ok: boolean; detail: string }>;
  failedGates: Array<{ name: string; ok: boolean; detail: string }>;
  recommendedActions: string[];
  release: ReleaseStatus;
  budget?: ReviewBudgetStatus;
  coverage?: OperatorQueueSnapshot;
  agents: OperatorAgentInventory;
  providerCooldowns: ProviderCooldownReviewRecord[];
  durableQueue?: OperatorDurableQueueSnapshot;
  issueEnrichment?: IssueEnrichmentStatus;
  issueEnrichmentRuntime?: OperatorIssueEnrichmentRuntime;
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
    budgetWouldLeaseJobs: number;
    budgetDelayedJobs: number;
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
    issueEnrichmentState?: IssueEnrichmentStatus["state"];
    issueEnrichmentRuntimeState?: OperatorIssueEnrichmentRuntimeState;
  };
  gates: Array<{ name: string; ok: boolean; detail: string }>;
  failedGates: Array<{ name: string; ok: boolean; detail: string }>;
  recommendedActions: string[];
  activeWork: ReviewQueueJobRecord[];
  uncoveredPendingHeads: OperatorQueueEntry[];
  release: ReleaseStatus;
  budget?: ReviewBudgetStatus;
  agents: OperatorAgentInventory;
  processes?: RuntimeProcessInventory;
  durableQueue?: OperatorDurableQueueSnapshot;
  coverage?: OperatorQueueSnapshot;
  providerCooldowns: ProviderCooldownReviewRecord[];
  repoProviderCooldowns: RepoProviderCooldownRecord[];
  issueEnrichment?: IssueEnrichmentStatus;
  issueEnrichmentRuntime?: OperatorIssueEnrichmentRuntime;
}

export type RuntimeClassification = "healthy_idle" | "healthy_active" | "blocked";
export type OperatorIssueEnrichmentRuntimeState = "disabled" | "idle" | "deferred" | "error";

export interface OperatorIssueEnrichmentRuntimeRecord {
  repo: string;
  issueNumber: number;
  status: IssueEnrichmentRecordStatus;
  issueUpdatedAt?: string;
  reason?: string;
  commentUrl?: string;
  error?: string;
  nextEligibleAt?: string;
  createdAt: string;
  updatedAt: string;
  retryable: boolean;
}

export interface OperatorIssueEnrichmentRuntime {
  ok: boolean;
  checkedAt: string;
  state: OperatorIssueEnrichmentRuntimeState;
  summary: {
    total: number;
    dryRun: number;
    posted: number;
    skipped: number;
    deferred: number;
    retryableDeferred: number;
    failed: number;
  };
  records: OperatorIssueEnrichmentRuntimeRecord[];
}

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
    queued: number;
    pending: number;
    skipped: number;
    staleHeads: number;
    readFailures: number;
  };
  processed: OperatorQueueEntry[];
  providerDeferred: OperatorQueueEntry[];
  queued: OperatorQueueEntry[];
  pending: OperatorQueueEntry[];
  skipped: OperatorQueueEntry[];
  staleHeads: OperatorQueueEntry[];
  readFailures: Array<{ repo: string; error: string; nextAction: string }>;
}

export interface OperatorDashboardFilters {
  repo?: string;
  status?: string;
  priority?: number;
  staleHeadReason?: string;
  includeHistory?: boolean;
  limit?: number;
}

export interface OperatorDashboardItem {
  repo: string;
  pullNumber?: number;
  headSha?: string;
  title?: string;
  url?: string;
  status: string;
  coverageState?: OperatorQueueEntry["state"] | "read_failure";
  queueState?: ReviewQueueJobState;
  queueSource?: ReviewQueueJobRecord["source"];
  queueLane?: ReviewQueueJobRecord["lane"];
  readinessState?: ReviewReadinessState;
  priority?: number;
  latestVerdict?: string;
  lastCommand?: ProcessedCommandAction;
  commandCommentId?: number;
  proofStatus: string;
  checkStatus: string;
  staleHeadReason?: string;
  reviewUrl?: string;
  evidencePath?: string;
  reason?: string;
  lastError?: string;
  updatedAt?: string;
  nextAction: string;
}

export interface OperatorDashboard {
  ok: boolean;
  checkedAt: string;
  filters: OperatorDashboardFilters;
  summary: {
    totalItems: number;
    blockedItems: number;
    activeReviews: number;
    commandTriggered: number;
    staleHeads: number;
    proofGaps: number;
    checkBlocks: number;
    failed: number;
    providerDeferred: number;
    hiddenHistoricalStale: number;
  };
  items: OperatorDashboardItem[];
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
    commandRecorded: number;
    posted: number;
    failed: number;
    retired: number;
    oldestWaitingRepo?: string;
    oldestWaitingAt?: string;
    oldestWaitingAgeMs?: number;
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
    commandRecorded: number;
    posted: number;
    failed: number;
    retired: number;
    oldestWaitingAt?: string;
    oldestWaitingAgeMs?: number;
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
  nextEligibleAt?: string;
  nextAction:
    | "none"
    | "wait_or_retry_provider_cooldown"
    | "run_or_wait_for_daemon"
    | "wait_for_durable_queue_worker"
    | "inspect_github_read_failure"
    | "run_scoped_coverage_audit";
}

export function buildOperatorStatus(input: {
  release: ReleaseStatus;
  coverage?: CoverageAuditReport;
  agents: OperatorAgentInventory;
  providerCooldowns?: ProviderCooldownReviewRecord[];
  durableQueue?: OperatorDurableQueueSnapshot;
  issueEnrichment?: IssueEnrichmentStatus;
  issueEnrichmentRuntime?: OperatorIssueEnrichmentRuntime;
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
  const budget = input.release.budget;
  const retryableProviderDeferredJobs = actionableProviderDeferredJobs(
    budget,
    durableQueue?.summary.retryableProviderDeferred ?? 0
  );
  const issueEnrichment = input.issueEnrichment;
  const issueEnrichmentRuntime = input.issueEnrichmentRuntime;
  const issueEnrichmentRuntimeState = displayIssueEnrichmentRuntimeState(issueEnrichment, issueEnrichmentRuntime);
  const issueEnrichmentRuntimeFailed = issueEnrichmentRuntime?.summary.failed ?? 0;
  const issueEnrichmentRuntimeRetryableDeferred = issueEnrichmentRuntime?.summary.retryableDeferred ?? 0;

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
      detail: describeActionableProviderDeferredJobs(budget, retryableProviderDeferredJobs)
    },
    ...(issueEnrichment
      ? [{
          name: "issue_enrichment_ready",
          ok: issueEnrichment.ok,
          detail: issueEnrichment.ok
            ? `${issueEnrichment.state}; allowlist=${issueEnrichment.allowlist.length}; liveComments=${issueEnrichment.postIssueComment}`
            : `${issueEnrichment.state}: ${issueEnrichment.blockers.join(", ")}`
        }]
      : []),
    ...(issueEnrichmentRuntime
      ? [
          {
            name: "issue_enrichment_runtime_no_failed_records",
            ok: issueEnrichmentRuntimeFailed === 0,
            detail: `${issueEnrichmentRuntimeFailed} failed issue-enrichment record(s)`
          },
          {
            name: "issue_enrichment_runtime_no_retryable_deferred_records",
            ok: issueEnrichmentRuntimeRetryableDeferred === 0,
            detail: `${issueEnrichmentRuntimeRetryableDeferred} retryable deferred issue-enrichment record(s)`
          }
        ]
      : [])
  ];

  const recommendedActions = uniqueStrings([
    ...input.release.recommendedActions,
    ...(pendingHeads > 0 ? ["wait for daemon cycle or run scoped run-once"] : []),
    ...(readFailures > 0 ? ["run doctor and inspect GitHub App installation/read permissions"] : []),
    ...(staleHeads > 0 ? ["wait for next daemon cycle or run scoped coverage audit"] : []),
    ...(input.agents.summary.staleLeases > 0 ? ["inspect agents output before restarting or retiring stale work"] : []),
    ...(failedQueueJobs > 0 ? ["inspect operator queue failed jobs before promotion"] : []),
    ...(retryableProviderDeferredJobs > 0 ? ["retry or requeue provider-deferred jobs whose nextEligibleAt has expired"] : []),
    ...(issueEnrichment && !issueEnrichment.ok ? ["resolve issue-enrichment blockers before enabling live issue comments"] : []),
    ...(issueEnrichmentRuntimeFailed > 0 ? ["inspect failed issue-enrichment records before promotion"] : []),
    ...(issueEnrichmentRuntimeRetryableDeferred > 0 ? ["retry or inspect deferred issue-enrichment records"] : [])
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
      failedQueueJobs,
      budgetWouldLeaseJobs: budget?.wouldLeaseCount ?? 0,
      budgetDelayedJobs: budget?.delayedCount ?? 0,
      ...(issueEnrichment ? { issueEnrichmentState: issueEnrichment.state } : {}),
      ...(issueEnrichmentRuntimeState ? { issueEnrichmentRuntimeState } : {})
    },
    gates,
    failedGates: gates.filter((gate) => !gate.ok),
    recommendedActions,
    release: input.release,
    ...(budget ? { budget } : {}),
    ...(queue ? { coverage: queue } : {}),
    agents: input.agents,
    providerCooldowns,
    ...(durableQueue ? { durableQueue } : {}),
    ...(issueEnrichment ? { issueEnrichment } : {}),
    ...(issueEnrichmentRuntime ? { issueEnrichmentRuntime } : {})
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
  issueEnrichment?: IssueEnrichmentStatus;
  issueEnrichmentRuntime?: OperatorIssueEnrichmentRuntime;
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
  const providerDeferredJobs = durableQueue?.summary.providerDeferred ?? 0;
  const readFailures = queue?.summary.readFailures ?? 0;
  const staleHeads = queue?.summary.staleHeads ?? 0;
  const providerDeferredHeads = queue?.summary.providerDeferred ?? 0;
  const budget = input.release.budget;
  const retryableProviderDeferredJobs = actionableProviderDeferredJobs(
    budget,
    durableQueue?.summary.retryableProviderDeferred ?? 0
  );
  const issueEnrichment = input.issueEnrichment;
  const issueEnrichmentRuntime = input.issueEnrichmentRuntime;
  const issueEnrichmentRuntimeState = displayIssueEnrichmentRuntimeState(issueEnrichment, issueEnrichmentRuntime);
  const issueEnrichmentRuntimeFailed = issueEnrichmentRuntime?.summary.failed ?? 0;
  const issueEnrichmentRuntimeRetryableDeferred = issueEnrichmentRuntime?.summary.retryableDeferred ?? 0;

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
      detail: describeActionableProviderDeferredJobs(budget, retryableProviderDeferredJobs)
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
    },
    ...(issueEnrichment
      ? [{
          name: "runtime_issue_enrichment_ready",
          ok: issueEnrichment.ok,
          detail: issueEnrichment.ok
            ? `${issueEnrichment.state}; allowlist=${issueEnrichment.allowlist.length}; liveComments=${issueEnrichment.postIssueComment}`
            : `${issueEnrichment.state}: ${issueEnrichment.blockers.join(", ")}`
        }]
      : []),
    ...(issueEnrichmentRuntime
      ? [
          {
            name: "runtime_issue_enrichment_no_failed_records",
            ok: issueEnrichmentRuntimeFailed === 0,
            detail: `${issueEnrichmentRuntimeFailed} failed issue-enrichment record(s)`
          },
          {
            name: "runtime_issue_enrichment_no_retryable_deferred_records",
            ok: issueEnrichmentRuntimeRetryableDeferred === 0,
            detail: `${issueEnrichmentRuntimeRetryableDeferred} retryable deferred issue-enrichment record(s)`
          }
        ]
      : [])
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
    ...(retryableExpiredProviderCooldowns > 0 ? ["retry expired provider cooldowns or inspect provider health"] : []),
    ...(issueEnrichment && !issueEnrichment.ok ? ["resolve issue-enrichment blockers before enabling live issue comments"] : []),
    ...(issueEnrichmentRuntimeFailed > 0 ? ["inspect failed issue-enrichment records before promotion"] : []),
    ...(issueEnrichmentRuntimeRetryableDeferred > 0 ? ["retry or inspect deferred issue-enrichment records"] : [])
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
      budgetWouldLeaseJobs: budget?.wouldLeaseCount ?? 0,
      budgetDelayedJobs: budget?.delayedCount ?? 0,
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
      botProcesses: input.processes?.summary.total ?? 0,
      ...(issueEnrichment ? { issueEnrichmentState: issueEnrichment.state } : {}),
      ...(issueEnrichmentRuntimeState ? { issueEnrichmentRuntimeState } : {})
    },
    gates,
    failedGates: gates.filter((gate) => !gate.ok),
    recommendedActions,
    activeWork,
    uncoveredPendingHeads,
    release: input.release,
    ...(budget ? { budget } : {}),
    agents: input.agents,
    ...(input.processes ? { processes: input.processes } : {}),
    ...(durableQueue ? { durableQueue } : {}),
    ...(queue ? { coverage: queue } : {}),
    providerCooldowns,
    repoProviderCooldowns,
    ...(issueEnrichment ? { issueEnrichment } : {}),
    ...(issueEnrichmentRuntime ? { issueEnrichmentRuntime } : {})
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
    `budget: wouldLease=${inventory.summary.budgetWouldLeaseJobs}` +
      ` delayed=${inventory.summary.budgetDelayedJobs}` +
      ` delayedByReason=${JSON.stringify(inventory.budget?.delayedByReason ?? {})}`,
    `pending: total=${inventory.summary.pendingHeads} covered=${inventory.summary.coveredPendingHeads}` +
      ` uncovered=${inventory.summary.uncoveredPendingHeads}`,
    `cooldowns: expired=${inventory.summary.expiredProviderCooldowns}` +
      ` retryable=${inventory.summary.retryableExpiredProviderCooldowns}` +
      ` covered=${inventory.summary.coveredExpiredProviderCooldowns}` +
      ` activeRepo=${inventory.summary.activeRepoCooldowns}`,
    `issueEnrichment: config=${inventory.summary.issueEnrichmentState ?? "unknown"}` +
      ` runtime=${inventory.summary.issueEnrichmentRuntimeState ?? "unknown"}` +
      ` failed=${inventory.issueEnrichmentRuntime?.summary.failed ?? 0}` +
      ` deferred=${inventory.issueEnrichmentRuntime?.summary.deferred ?? 0}`,
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
    ok: input.launchd.state === "running" && isHealthyAgentHeartbeat(input.heartbeat) && staleLeases.length === 0,
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

export function collectOperatorIssueEnrichmentRuntime(
  statePath: string,
  input: { repo?: string; now?: Date; limit?: number } = {}
): OperatorIssueEnrichmentRuntime {
  const checkedAt = (input.now ?? new Date()).toISOString();
  if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1)) {
    throw new Error("limit must be a positive integer");
  }
  if (!existsSync(statePath)) return emptyIssueEnrichmentRuntime(checkedAt);
  const db = new DatabaseSync(statePath, { readOnly: true });
  try {
    if (!hasTable(db, "issue_enrichment_records")) return emptyIssueEnrichmentRuntime(checkedAt);
    const rows = (input.repo
      ? db
          .prepare(
            `select repo, issue_number, issue_updated_at, status, reason, comment_url, error,
                    next_eligible_at, created_at, updated_at
             from issue_enrichment_records
             where repo = ?
             order by datetime(updated_at) desc`
          )
          .all(input.repo)
      : db
          .prepare(
            `select repo, issue_number, issue_updated_at, status, reason, comment_url, error,
                    next_eligible_at, created_at, updated_at
             from issue_enrichment_records
             order by datetime(updated_at) desc`
          )
          .all()) as unknown as IssueEnrichmentRecordRow[];
    const allRecords = rows.map((row) => mapIssueEnrichmentRuntimeRow(row, checkedAt));
    const records = input.limit ? allRecords.slice(0, input.limit) : allRecords;
    const summary = {
      total: allRecords.length,
      dryRun: allRecords.filter((record) => record.status === "dry_run").length,
      posted: allRecords.filter((record) => record.status === "posted").length,
      skipped: allRecords.filter((record) => record.status === "skipped").length,
      deferred: allRecords.filter((record) => record.status === "deferred").length,
      retryableDeferred: allRecords.filter((record) => record.status === "deferred" && record.retryable).length,
      failed: allRecords.filter((record) => record.status === "failed").length
    };
    const state: OperatorIssueEnrichmentRuntimeState = summary.failed > 0
      ? "error"
      : summary.deferred > 0
        ? "deferred"
        : "idle";
    return {
      ok: summary.failed === 0 && summary.retryableDeferred === 0,
      checkedAt,
      state,
      summary,
      records
    };
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
      queued: report.queued.length,
      pending: report.unprocessed.length,
      skipped: report.skipped.length,
      staleHeads: report.staleHeads.length,
      readFailures: report.readFailures.length
    },
    processed: report.processed.map(processedQueueEntry),
    providerDeferred: report.providerDeferred.map(providerDeferredQueueEntry),
    queued: report.queued.map(queuedQueueEntry),
    pending: report.unprocessed.map(pendingQueueEntry),
    skipped: report.skipped.map(skippedQueueEntry),
    staleHeads: report.staleHeads.map(staleHeadQueueEntry),
    readFailures: report.readFailures.map((failure) => ({
      ...failure,
      nextAction: "inspect GitHub App installation/read permissions or network failure"
    }))
  };
}

export function collectOperatorReviewReadiness(
  statePath: string,
  input: { repo?: string; state?: ReviewReadinessState; limit?: number } = {}
): ReviewReadinessRecord[] {
  if (!existsSync(statePath)) return [];
  const db = new DatabaseSync(statePath, { readOnly: true });
  try {
    if (!hasTable(db, "review_readiness")) return [];
    const predicates: string[] = [];
    const params: Array<string | number> = [];
    if (input.repo) {
      predicates.push("repo = ?");
      params.push(input.repo);
    }
    if (input.state) {
      predicates.push("state = ?");
      params.push(input.state);
    }
    const where = predicates.length ? `where ${predicates.join(" and ")}` : "";
    const limit = input.limit ? " limit ?" : "";
    if (input.limit) params.push(input.limit);
    const rows = db
      .prepare(
        `select repo, pull_number, head_sha, state, reason, event, review_url,
                command_action, command_comment_id, created_at, updated_at
         from review_readiness
         ${where}
         order by datetime(updated_at) desc
         ${limit}`
      )
      .all(...params) as unknown as ReviewReadinessRow[];
    return rows.map((row) => ({
      repo: row.repo,
      pullNumber: row.pull_number,
      headSha: row.head_sha,
      state: row.state,
      ...(row.reason ? { reason: row.reason } : {}),
      ...(row.event ? { event: row.event } : {}),
      ...(row.review_url ? { reviewUrl: row.review_url } : {}),
      ...(row.command_action ? { commandAction: row.command_action } : {}),
      ...(row.command_comment_id ? { commandCommentId: row.command_comment_id } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));
  } finally {
    db.close();
  }
}

export function buildOperatorDashboard(input: {
  coverage: CoverageAuditReport;
  durableQueue?: OperatorDurableQueueSnapshot;
  readiness?: ReviewReadinessRecord[];
  evidenceDir?: string;
  filters?: OperatorDashboardFilters;
  checkedAt?: string;
}): OperatorDashboard {
  const checkedAt = input.checkedAt ?? input.coverage.checkedAt;
  const filters = compactDashboardFilters(input.filters ?? {});
  const items = new Map<string, OperatorDashboardItem>();

  for (const entry of input.coverage.processed) {
    const processedFailed = entry.status === "failed";
    const processedError = entry.error ? redactSecrets(entry.error) : undefined;
    upsertDashboardItem(items, dashboardKey(entry.repo, entry.pullNumber, entry.headSha), {
      repo: entry.repo,
      pullNumber: entry.pullNumber,
      headSha: entry.headSha,
      title: entry.title,
      url: entry.url,
      status: processedFailed ? "failed" : "processed",
      coverageState: "processed",
      latestVerdict: entry.event ?? entry.status,
      proofStatus: processedFailed ? "failed" : entry.reviewUrl ? "covered_by_review" : "processed_without_review_url",
      checkStatus: "not_collected",
      ...(entry.reviewUrl ? { reviewUrl: entry.reviewUrl } : {}),
      ...(processedError ? { reason: processedError, lastError: processedError } : {}),
      updatedAt: entry.createdAt,
      nextAction: processedFailed ? "inspect failure evidence and retry or retire the head" : "none"
    });
  }

  for (const entry of input.coverage.providerDeferred) {
    upsertDashboardItem(items, dashboardKey(entry.repo, entry.pullNumber, entry.headSha), {
      repo: entry.repo,
      pullNumber: entry.pullNumber,
      headSha: entry.headSha,
      title: entry.title,
      url: entry.url,
      status: "provider_deferred",
      coverageState: "provider_deferred",
      latestVerdict: "provider_deferred",
      proofStatus: "pending_review",
      checkStatus: "not_collected",
      reason: redactSecrets(entry.reason ?? entry.error ?? "provider cooldown"),
      updatedAt: entry.updatedAt,
      nextAction: "wait for cooldown expiry or run retry-provider-cooldowns when expired"
    });
  }

  for (const entry of input.coverage.queued) {
    upsertDashboardItem(items, dashboardKey(entry.repo, entry.pullNumber, entry.headSha), {
      repo: entry.repo,
      pullNumber: entry.pullNumber,
      headSha: entry.headSha,
      title: entry.title,
      url: entry.url,
      status: "pending_review",
      coverageState: "pending_review",
      queueState: entry.queueState,
      queueSource: entry.source as ReviewQueueJobRecord["source"],
      queueLane: entry.lane as ReviewQueueJobRecord["lane"],
      priority: entry.priority,
      latestVerdict: entry.queueState,
      proofStatus: "pending_review",
      checkStatus: "not_collected",
      ...(entry.nextEligibleAt ? { reason: `next eligible at ${entry.nextEligibleAt}` } : {}),
      updatedAt: entry.updatedAt,
      nextAction: "wait for durable queue worker to review this head"
    });
  }

  for (const entry of input.coverage.unprocessed) {
    upsertDashboardItem(items, dashboardKey(entry.repo, entry.pullNumber, entry.headSha), {
      repo: entry.repo,
      pullNumber: entry.pullNumber,
      headSha: entry.headSha,
      title: entry.title,
      url: entry.url,
      status: "pending_review",
      coverageState: "pending_review",
      latestVerdict: "pending_review",
      proofStatus: "pending_review",
      checkStatus: "not_collected",
      nextAction: "wait for daemon cycle or run scoped run-once"
    });
  }

  for (const entry of input.coverage.skipped) {
    upsertDashboardItem(items, dashboardKey(entry.repo, entry.pullNumber, entry.headSha), {
      repo: entry.repo,
      ...(entry.pullNumber !== undefined ? { pullNumber: entry.pullNumber } : {}),
      ...(entry.headSha ? { headSha: entry.headSha } : {}),
      ...(entry.title ? { title: entry.title } : {}),
      ...(entry.url ? { url: entry.url } : {}),
      status: "skipped",
      coverageState: "skipped",
      latestVerdict: "skipped",
      proofStatus: "skipped",
      checkStatus: "not_collected",
      reason: redactSecrets(entry.reason),
      nextAction: "none"
    });
  }

  for (const entry of input.coverage.staleHeads) {
    const reason = `expected ${entry.expectedHeadSha}, live ${entry.liveHeadSha}`;
    upsertDashboardItem(items, dashboardKey(entry.repo, entry.pullNumber, entry.liveHeadSha), {
      repo: entry.repo,
      pullNumber: entry.pullNumber,
      headSha: entry.liveHeadSha,
      title: entry.title,
      url: entry.url,
      status: "stale_head",
      coverageState: "stale_head",
      latestVerdict: "stale_head",
      proofStatus: "stale_head",
      checkStatus: "not_collected",
      staleHeadReason: reason,
      reason,
      nextAction: "wait for next daemon cycle or run scoped coverage audit"
    });
  }

  for (const failure of input.coverage.readFailures) {
    upsertDashboardItem(items, dashboardKey(failure.repo), {
      repo: failure.repo,
      status: "read_failure",
      coverageState: "read_failure",
      latestVerdict: "read_failure",
      proofStatus: "unknown",
      checkStatus: "unknown",
      reason: redactSecrets(failure.error),
      nextAction: "inspect GitHub App installation/read permissions or network failure"
    });
  }

  for (const job of input.durableQueue?.jobs ?? []) {
    upsertDashboardItem(items, dashboardKey(job.repo, job.pullNumber, job.headSha), {
      repo: job.repo,
      pullNumber: job.pullNumber,
      headSha: job.headSha,
      url: githubPullUrl(job.repo, job.pullNumber),
      status: queueStatus(job),
      queueState: job.state,
      queueSource: job.source,
      queueLane: job.lane,
      priority: job.priority,
      latestVerdict: job.state,
      proofStatus: proofStatusForQueue(job),
      checkStatus: "not_collected",
      ...(job.reviewUrl ? { reviewUrl: job.reviewUrl } : {}),
      ...(job.lastError ? { lastError: redactSecrets(job.lastError) } : {}),
      updatedAt: job.updatedAt,
      nextAction: nextActionForQueue(job)
    });
  }

  for (const readiness of input.readiness ?? []) {
    upsertDashboardItem(items, dashboardKey(readiness.repo, readiness.pullNumber, readiness.headSha), {
      repo: readiness.repo,
      pullNumber: readiness.pullNumber,
      headSha: readiness.headSha,
      url: githubPullUrl(readiness.repo, readiness.pullNumber),
      status: readiness.state,
      readinessState: readiness.state,
      latestVerdict: readiness.event ?? readiness.state,
      proofStatus: proofStatusForReadiness(readiness),
      checkStatus: checkStatusForReadiness(readiness),
      ...(readiness.reason ? { reason: redactSecrets(readiness.reason) } : {}),
      ...(readiness.reviewUrl ? { reviewUrl: readiness.reviewUrl } : {}),
      ...(readiness.commandAction ? { lastCommand: readiness.commandAction } : {}),
      ...(readiness.commandCommentId ? { commandCommentId: readiness.commandCommentId } : {}),
      updatedAt: readiness.updatedAt,
      nextAction: nextActionForReadiness(readiness)
    });
  }

  const withEvidence = [...items.values()].map((item) => ({
    ...item,
    ...(input.evidenceDir ? { evidencePath: evidencePathForItem(input.evidenceDir, checkedAt, item) } : {})
  }));
  const filtered = withEvidence
    .filter((item) => dashboardItemMatches(item, filters))
    .sort(compareDashboardItems);
  const includeHistory = filters.includeHistory === true || Boolean(filters.status || filters.staleHeadReason);
  const hiddenHistoricalStale = includeHistory ? 0 : filtered.filter(isHistoricalStaleDashboardItem).length;
  const currentItems = includeHistory ? filtered : filtered.filter((item) => !isHistoricalStaleDashboardItem(item));
  const visible = filters.limit ? currentItems.slice(0, filters.limit) : currentItems;

  return {
    ok: visible.every((item) => !isDashboardItemBlocked(item)),
    checkedAt,
    filters,
    summary: {
      ...summarizeDashboardItems(visible),
      hiddenHistoricalStale
    },
    items: visible
  };
}

export function formatOperatorDashboardHuman(dashboard: OperatorDashboard): string {
  const lines = [
    `dashboard: ${dashboard.ok ? "ok" : "blocked"} total=${dashboard.summary.totalItems} active=${dashboard.summary.activeReviews} blocked=${dashboard.summary.blockedItems} stale=${dashboard.summary.staleHeads} proofGaps=${dashboard.summary.proofGaps} providerDeferred=${dashboard.summary.providerDeferred} failed=${dashboard.summary.failed}`
  ];
  for (const item of dashboard.items) {
    const pull = item.pullNumber ? `#${item.pullNumber}` : "";
    const priority = item.priority !== undefined ? ` p=${item.priority}` : "";
    const command = item.lastCommand ? ` command=${item.lastCommand}` : "";
    const reason = item.reason ? ` reason=${item.reason}` : "";
    lines.push(`${item.status}: ${item.repo}${pull}${priority}${command} next=${item.nextAction}${reason}`);
    if (item.url) lines.push(`  pr: ${item.url}`);
    if (item.evidencePath) lines.push(`  evidence: ${item.evidencePath}`);
  }
  return redactSecrets(lines.join("\n"));
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

  const queued = report.queued.find((entry) => entry.repo === repo && entry.pullNumber === pullNumber);
  if (queued) {
    return {
      repo,
      pullNumber,
      state: "pending_review",
      headSha: queued.headSha,
      reason: `durable queue state ${queued.queueState}`,
      ...(queued.nextEligibleAt ? { nextEligibleAt: queued.nextEligibleAt } : {}),
      nextAction: "wait_for_durable_queue_worker"
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

function queuedQueueEntry(entry: CoverageQueuedEntry): OperatorQueueEntry {
  return {
    state: "pending_review",
    repo: entry.repo,
    pullNumber: entry.pullNumber,
    headSha: entry.headSha,
    title: entry.title,
    url: entry.url,
    status: entry.queueState,
    ...(entry.nextEligibleAt ? { reason: `next eligible at ${entry.nextEligibleAt}` } : {}),
    nextAction: "wait for durable queue worker to review this head"
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
  const oldestWaiting = oldestWaitingQueueJob(jobs);
  const oldestWaitingAgeMs = oldestWaiting ? waitingAgeMs(oldestWaiting.createdAt, now) : undefined;
  return {
    total: jobs.length,
    queued: jobs.filter((job) => job.state === "queued").length,
    leased: jobs.filter((job) => job.state === "leased").length,
    running: jobs.filter((job) => job.state === "running").length,
    providerDeferred: jobs.filter((job) => job.state === "provider_deferred").length,
    retryableProviderDeferred: jobs.filter((job) => job.state === "provider_deferred" && isRetryableQueueJob(job, now)).length,
    commandRecorded: jobs.filter((job) => job.state === "command_recorded").length,
    posted: jobs.filter((job) => job.state === "posted").length,
    failed: jobs.filter((job) => job.state === "failed").length,
    retired: jobs.filter((job) => job.state === "stale_retired" || job.state === "closed_retired").length,
    ...(oldestWaiting
      ? {
          oldestWaitingRepo: oldestWaiting.repo,
          oldestWaitingAt: oldestWaiting.createdAt,
          ...(oldestWaitingAgeMs !== undefined ? { oldestWaitingAgeMs } : {})
        }
      : {})
  };
}

function oldestWaitingQueueJob(jobs: ReviewQueueJobRecord[]): ReviewQueueJobRecord | undefined {
  return jobs
    .filter((job) =>
      job.state === "queued" ||
      job.state === "provider_deferred" ||
      job.state === "blocked_on_proof"
    )
    .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))[0];
}

function waitingAgeMs(createdAt: string, now: Date): number | undefined {
  const createdAtMs = Date.parse(createdAt);
  if (!Number.isFinite(createdAtMs)) return undefined;
  return Math.max(0, now.getTime() - createdAtMs);
}

function isRetryableQueueJob(job: ReviewQueueJobRecord, now: Date): boolean {
  if (!job.nextEligibleAt) return true;
  const nextEligibleAtMs = Date.parse(job.nextEligibleAt);
  return !Number.isFinite(nextEligibleAtMs) || nextEligibleAtMs <= now.getTime();
}

function actionableProviderDeferredJobs(
  budget: ReviewBudgetStatus | undefined,
  fallbackRetryableProviderDeferred: number
): number {
  return budget?.providerDeferred.readyToRetry ?? fallbackRetryableProviderDeferred;
}

function describeActionableProviderDeferredJobs(
  budget: ReviewBudgetStatus | undefined,
  actionableCount: number
): string {
  if (!budget) return `${actionableCount} retryable provider-deferred durable queue job(s)`;
  const waitingCapacity =
    budget.providerDeferred.waitingProviderCapacity +
    budget.providerDeferred.waitingOrgCapacity +
    budget.providerDeferred.waitingRepoCapacity +
    budget.providerDeferred.waitingManualReserve +
    budget.providerDeferred.waitingLeaseLimit;
  return (
    `${actionableCount} ready-to-retry provider-deferred durable queue job(s)` +
    `; provider_deferred total=${budget.providerDeferred.total}` +
    ` retryable=${budget.providerDeferred.retryable}` +
    ` waiting_cooldown=${budget.providerDeferred.waitingCooldown}` +
    ` waiting_capacity=${waitingCapacity}`
  );
}

function emptyIssueEnrichmentRuntime(checkedAt: string): OperatorIssueEnrichmentRuntime {
  return {
    ok: true,
    checkedAt,
    state: "idle",
    summary: {
      total: 0,
      dryRun: 0,
      posted: 0,
      skipped: 0,
      deferred: 0,
      retryableDeferred: 0,
      failed: 0
    },
    records: []
  };
}

function displayIssueEnrichmentRuntimeState(
  issueEnrichment: IssueEnrichmentStatus | undefined,
  runtime: OperatorIssueEnrichmentRuntime | undefined
): OperatorIssueEnrichmentRuntimeState | undefined {
  if (!runtime) return issueEnrichment?.enabled === false ? "disabled" : undefined;
  if (issueEnrichment?.enabled === false && runtime.summary.total === 0) return "disabled";
  return runtime.state;
}

function mapIssueEnrichmentRuntimeRow(
  row: IssueEnrichmentRecordRow,
  checkedAt: string
): OperatorIssueEnrichmentRuntimeRecord {
  const nextEligibleAtMs = row.next_eligible_at ? Date.parse(row.next_eligible_at) : Number.NaN;
  const checkedAtMs = Date.parse(checkedAt);
  const retryable =
    row.status === "deferred" &&
    (!row.next_eligible_at ||
      !Number.isFinite(nextEligibleAtMs) ||
      (Number.isFinite(checkedAtMs) && nextEligibleAtMs <= checkedAtMs));
  return {
    repo: row.repo,
    issueNumber: row.issue_number,
    status: row.status,
    ...(row.issue_updated_at ? { issueUpdatedAt: row.issue_updated_at } : {}),
    ...(row.reason ? { reason: redactSecrets(row.reason) } : {}),
    ...(row.comment_url ? { commentUrl: redactSecrets(row.comment_url) } : {}),
    ...(row.error ? { error: redactSecrets(row.error) } : {}),
    ...(row.next_eligible_at ? { nextEligibleAt: row.next_eligible_at } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    retryable
  };
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

function upsertDashboardItem(
  items: Map<string, OperatorDashboardItem>,
  key: string,
  patch: OperatorDashboardItem
): void {
  const existing = items.get(key);
  if (!existing) {
    items.set(key, patch);
    return;
  }
  const dominant = dashboardSeverityRank(patch) <= dashboardSeverityRank(existing) ? patch : existing;
  items.set(key, {
    ...existing,
    ...patch,
    status: dominant.status,
    title: patch.title ?? existing.title,
    url: patch.url ?? existing.url,
    coverageState: patch.coverageState ?? existing.coverageState,
    queueState: patch.queueState ?? existing.queueState,
    queueSource: patch.queueSource ?? existing.queueSource,
    queueLane: patch.queueLane ?? existing.queueLane,
    readinessState: patch.readinessState ?? existing.readinessState,
    priority: patch.priority ?? existing.priority,
    latestVerdict: dominant.latestVerdict ?? patch.latestVerdict ?? existing.latestVerdict,
    lastCommand: patch.lastCommand ?? existing.lastCommand,
    commandCommentId: patch.commandCommentId ?? existing.commandCommentId,
    staleHeadReason: patch.staleHeadReason ?? existing.staleHeadReason,
    reviewUrl: patch.reviewUrl ?? existing.reviewUrl,
    evidencePath: patch.evidencePath ?? existing.evidencePath,
    proofStatus: dominant.proofStatus,
    checkStatus: dominant.checkStatus,
    reason: dominant.reason ?? patch.reason ?? existing.reason,
    lastError: patch.lastError ?? existing.lastError,
    updatedAt: latestTimestamp(existing.updatedAt, patch.updatedAt),
    nextAction: dominant.nextAction
  });
}

function dashboardKey(repo: string, pullNumber?: number, headSha?: string): string {
  return `${repo}#${pullNumber ?? "repo"}@${headSha ?? "repo"}`;
}

function compactDashboardFilters(filters: OperatorDashboardFilters): OperatorDashboardFilters {
  return {
    ...(filters.repo ? { repo: filters.repo } : {}),
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.priority !== undefined ? { priority: filters.priority } : {}),
    ...(filters.staleHeadReason ? { staleHeadReason: filters.staleHeadReason } : {}),
    ...(filters.includeHistory === true ? { includeHistory: true } : {}),
    ...(filters.limit !== undefined ? { limit: filters.limit } : {})
  };
}

function dashboardItemMatches(item: OperatorDashboardItem, filters: OperatorDashboardFilters): boolean {
  if (filters.repo && item.repo !== filters.repo) return false;
  if (filters.status) {
    const statuses = [item.status, item.coverageState, item.queueState, item.readinessState].filter(Boolean);
    if (!statuses.includes(filters.status)) return false;
  }
  if (filters.priority !== undefined && item.priority !== filters.priority) return false;
  if (filters.staleHeadReason && !item.staleHeadReason?.includes(filters.staleHeadReason)) return false;
  return true;
}

function compareDashboardItems(left: OperatorDashboardItem, right: OperatorDashboardItem): number {
  const leftPriority = left.priority ?? Number.POSITIVE_INFINITY;
  const rightPriority = right.priority ?? Number.POSITIVE_INFINITY;
  const priority = leftPriority === rightPriority ? 0 : leftPriority - rightPriority;
  if (priority !== 0) return priority;
  const severity = dashboardSeverityRank(left) - dashboardSeverityRank(right);
  if (severity !== 0) return severity;
  const repo = left.repo.localeCompare(right.repo);
  if (repo !== 0) return repo;
  return (left.pullNumber ?? 0) - (right.pullNumber ?? 0);
}

function dashboardSeverityRank(item: OperatorDashboardItem): number {
  if (item.status === "failed") return 0;
  if (item.status === "needs_fix" || item.status === "awaiting_re_review") return 1;
  if (item.status === "blocked_on_proof" || item.status === "blocked_on_checks") return 1;
  if (item.status === "provider_deferred") return 2;
  if (item.status === "stale_head" || item.status === "stale") return 3;
  if (isActiveDashboardStatus(item.status)) return 4;
  if (item.status === "processed" || item.status === "ready_for_human") return 9;
  return 5;
}

function summarizeDashboardItems(items: OperatorDashboardItem[]): OperatorDashboard["summary"] {
  return {
    totalItems: items.length,
    blockedItems: items.filter(isDashboardItemBlocked).length,
    activeReviews: items.filter((item) => dashboardStatuses(item).some(isActiveDashboardStatus)).length,
    commandTriggered: items.filter((item) => item.lastCommand || item.queueSource === "manual_command").length,
    staleHeads: items.filter((item) => dashboardStatuses(item).some((status) => status === "stale_head" || status === "stale")).length,
    proofGaps: items.filter((item) => item.proofStatus === "blocked_on_proof").length,
    checkBlocks: items.filter((item) => item.checkStatus === "blocked_on_checks").length,
    failed: items.filter((item) => dashboardStatuses(item).includes("failed")).length,
    providerDeferred: items.filter((item) => dashboardStatuses(item).includes("provider_deferred")).length,
    hiddenHistoricalStale: 0
  };
}

function isHistoricalStaleDashboardItem(item: OperatorDashboardItem): boolean {
  if (item.coverageState === "stale_head") return false;
  if (item.queueState === "closed_retired" || item.queueState === "stale_retired") return true;
  const statuses = dashboardStatuses(item).filter((status) => status !== "posted");
  return statuses.length > 0 && statuses.every(isHistoricalStaleStatus);
}

function isHistoricalStaleStatus(status: string): boolean {
  return status === "stale" || status === "stale_head" || status === "stale_retired";
}

function isDashboardItemBlocked(item: OperatorDashboardItem): boolean {
  return dashboardStatuses(item).some((status) =>
    status === "failed" ||
    status === "provider_deferred" ||
    status === "stale_head" ||
    status === "stale" ||
    status === "read_failure" ||
    status === "blocked_on_checks" ||
    status === "blocked_on_proof" ||
    status === "needs_fix" ||
    status === "awaiting_re_review"
  );
}

function dashboardStatuses(item: OperatorDashboardItem): string[] {
  return [item.status, item.coverageState, item.queueState, item.readinessState]
    .filter((status): status is string => Boolean(status));
}

function isHealthyAgentHeartbeat(heartbeat: ReleaseHeartbeatStatus): boolean {
  return heartbeat.status === "fresh" || heartbeat.status === "active";
}

function isActiveDashboardStatus(status: string): boolean {
  return status === "pending_review" ||
    status === "queued" ||
    status === "leased" ||
    status === "running" ||
    status === "reviewing" ||
    status === "command_recorded";
}

function queueStatus(job: ReviewQueueJobRecord): string {
  if (job.state === "posted") return "processed";
  if (job.state === "closed_retired" || job.state === "stale_retired") return "skipped";
  return job.state;
}

function proofStatusForQueue(job: ReviewQueueJobRecord): string {
  if (job.state === "posted") return job.reviewUrl ? "covered_by_review" : "processed_without_review_url";
  if (job.state === "failed") return "failed";
  if (job.state === "stale_retired") return "stale_head";
  if (job.state === "closed_retired") return "skipped";
  return "pending_review";
}

function proofStatusForReadiness(readiness: ReviewReadinessRecord): string {
  if (readiness.state === "blocked_on_proof") return "blocked_on_proof";
  if (readiness.state === "blocked_on_checks") return "pending_check";
  if (readiness.state === "ready_for_human" || readiness.state === "needs_fix") {
    return readiness.reviewUrl ? "covered_by_review" : "review_ready";
  }
  if (readiness.state === "failed") return "failed";
  if (readiness.state === "skipped" || readiness.state === "closed") return "skipped";
  if (readiness.state === "stale") return "stale_head";
  return "pending_review";
}

function checkStatusForReadiness(readiness: ReviewReadinessRecord): string {
  if (readiness.state === "blocked_on_checks") return "blocked_on_checks";
  return "not_collected";
}

function nextActionForQueue(job: ReviewQueueJobRecord): string {
  if (job.state === "queued" || job.state === "leased" || job.state === "running") return "wait for daemon cycle";
  if (job.state === "provider_deferred") return "wait for cooldown expiry or retry provider-deferred queue job";
  if (job.state === "failed") return "inspect failure evidence and retry or retire the head";
  if (job.state === "command_recorded") return "wait for daemon cycle or inspect command-triggered run";
  return "none";
}

function nextActionForReadiness(readiness: ReviewReadinessRecord): string {
  if (readiness.state === "command_recorded") return "wait for daemon cycle or inspect command-triggered run";
  if (readiness.state === "queued" || readiness.state === "reviewing") return "wait for daemon cycle";
  if (readiness.state === "awaiting_re_review") return "wait for trusted re-review command or new head";
  if (readiness.state === "provider_deferred") return "wait for cooldown expiry or retry provider-deferred queue job";
  if (readiness.state === "blocked_on_proof") return "collect required proof before merge-ready claim";
  if (readiness.state === "blocked_on_checks") return "wait for or inspect required checks";
  if (readiness.state === "needs_fix") return "wait for author fixes or review the requested changes";
  if (readiness.state === "failed") return "inspect failure evidence and retry or retire the head";
  if (readiness.state === "stale") return "wait for next daemon cycle or run scoped coverage audit";
  return "none";
}

function evidencePathForItem(evidenceDir: string, checkedAt: string, item: OperatorDashboardItem): string | undefined {
  if (!item.pullNumber || !item.headSha) return undefined;
  const repoKey = item.repo.replace("/", "__");
  const pullKey = `pr-${item.pullNumber}`;
  const matchingPath = findExistingEvidencePath(evidenceDir, repoKey, pullKey, item.headSha);
  if (matchingPath) return matchingPath;
  const date = checkedAt.slice(0, 10);
  return join(evidenceDir, date, repoKey, pullKey, item.headSha);
}

function findExistingEvidencePath(
  evidenceDir: string,
  repoKey: string,
  pullKey: string,
  headSha: string
): string | undefined {
  try {
    if (!existsSync(evidenceDir)) return undefined;
    const dateDirs = readdirSync(evidenceDir)
      .map((entry) => join(evidenceDir, entry))
      .filter((path) => {
        try {
          return statSync(path).isDirectory();
        } catch {
          return false;
        }
      })
      .sort()
      .reverse();
    for (const dateDir of dateDirs) {
      const candidate = join(dateDir, repoKey, pullKey, headSha);
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function githubPullUrl(repo: string, pullNumber: number): string {
  return `https://github.com/${repo}/pull/${pullNumber}`;
}

function latestTimestamp(left?: string, right?: string): string | undefined {
  if (!left) return right;
  if (!right) return left;
  return Date.parse(right) > Date.parse(left) ? right : left;
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

interface IssueEnrichmentRecordRow {
  repo: string;
  issue_number: number;
  issue_updated_at: string | null;
  status: IssueEnrichmentRecordStatus;
  reason: string | null;
  comment_url: string | null;
  error: string | null;
  next_eligible_at: string | null;
  created_at: string;
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

interface ReviewReadinessRow {
  repo: string;
  pull_number: number;
  head_sha: string;
  state: ReviewReadinessState;
  reason: string | null;
  event: "COMMENT" | "REQUEST_CHANGES" | null;
  review_url: string | null;
  command_action: ProcessedCommandAction | null;
  command_comment_id: number | null;
  created_at: string;
  updated_at: string;
}
