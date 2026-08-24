import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { formatDaemonLog } from "./daemon-log.js";
import { loadConfig } from "./config.js";
import { GitHubApi } from "./github.js";
import { runIssueEnrichmentCycle, type IssueEnrichmentCycleResult } from "./issue-enrichment.js";
import { runScheduledCycle } from "./scheduler.js";
import {
  isAuthenticProductionLicenseAdmission,
  requireActiveDaemonCycleAdmissions,
  requireActiveProductionLicense,
  type DaemonCycleAdmissions,
  type ProductionLicenseAdmission
} from "./license-admission.js";
import { ReviewStateStore, type DaemonHeartbeatEvent } from "./state.js";
import { retryProviderCooldowns, runOnce, type RetryProviderCooldownsResult, type RunOnceResult } from "./worker.js";
import {
  cleanupStaleReviewWorktrees,
  probeOpenReviewWorktreePaths,
  removeRegisteredReviewWorktree,
  type ReviewWorktreeCleanupSummary
} from "./worktree-cleanup.js";

export type DaemonCycleResult =
  | { ok: true; result: RunOnceResult }
  | { ok: false; failureKind: "admission_denied" | "runtime_failure"; error: string };

export interface IssueEnrichmentLaneCounts {
  reposScanned: number;
  reposSkipped: number;
  readFailures: number;
  issuesSeen: number;
  eligible: number;
  skipped: number;
  wouldEnrich: number;
  wouldComment: number;
  deferred: number;
  baselinedRepos: number;
  truncatedRepos: number;
  workerSkipped: number;
  posted: number;
  dryRunRecorded: number;
  skippedRecorded: number;
  deferredRecorded: number;
  alreadyProcessed: number;
  failed: number;
}

export type IssueEnrichmentLaneCode = "completed" | "no_candidates" | "result_not_ok" | "cycle_failed" | "malformed_summary";

export interface IssueEnrichmentLaneReceipt {
  ok: boolean;
  stage: "issue_enrichment";
  code: IssueEnrichmentLaneCode;
  counts: IssueEnrichmentLaneCounts;
}

const ISSUE_ENRICHMENT_LANE_COUNT_KEYS = [
  "reposScanned", "reposSkipped", "readFailures", "issuesSeen", "eligible", "skipped",
  "wouldEnrich", "wouldComment", "deferred", "baselinedRepos", "truncatedRepos", "workerSkipped",
  "posted", "dryRunRecorded", "skippedRecorded", "deferredRecorded", "alreadyProcessed", "failed"
] as const satisfies ReadonlyArray<keyof IssueEnrichmentLaneCounts>;

function boundedLaneCount(value: unknown): number {
  const number = typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : 0;
  return Math.min(1_000_000, Math.max(0, number));
}

function hasValidIssueEnrichmentLaneSummary(summary: unknown): summary is Record<string, unknown> {
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) return false;
  return ISSUE_ENRICHMENT_LANE_COUNT_KEYS.every((key) => {
    const value = (summary as Record<string, unknown>)[key];
    return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0;
  });
}

export function buildIssueEnrichmentLaneReceipt(result?: IssueEnrichmentCycleResult): IssueEnrichmentLaneReceipt {
  const summary: unknown = result?.summary;
  const counts = {} as IssueEnrichmentLaneCounts;
  for (const key of ISSUE_ENRICHMENT_LANE_COUNT_KEYS) counts[key] = boundedLaneCount(
    hasValidIssueEnrichmentLaneSummary(summary) ? summary[key] : undefined
  );
  const malformed = result !== undefined && !hasValidIssueEnrichmentLaneSummary(summary);
  const ok = !malformed && result?.ok === true && counts.readFailures === 0 && counts.failed === 0;
  const noCandidates = ok && counts.eligible === 0 && counts.wouldEnrich === 0 && counts.wouldComment === 0 &&
    counts.posted === 0 && counts.dryRunRecorded === 0 && counts.skippedRecorded === 0 &&
    counts.deferredRecorded === 0 && counts.alreadyProcessed === 0;
  return {
    ok,
    stage: "issue_enrichment",
    code: result === undefined ? "cycle_failed" : malformed ? "malformed_summary" : !ok ? "result_not_ok" : noCandidates ? "no_candidates" : "completed",
    counts
  };
}

export function shouldExitDaemonAfterFailedCycle(result: DaemonCycleResult, runOnce: boolean): boolean {
  return !result.ok && (runOnce || result.failureKind === "admission_denied");
}

export interface RunDaemonCycleOptions {
  cycle: number;
  dryRun: boolean;
  configPath?: string;
  pilotRepos: string[];
  monitoredRepos: string[];
  canaryPulls: string[];
  commandsEnabled: boolean;
  reviewSchedulerEnabled?: boolean;
  issueEnrichmentEnabled?: boolean;
  worktreeCleanupDue?: boolean;
  runOnceImpl?: (options: { configPath?: string; dryRun: boolean; licenseAdmission?: ProductionLicenseAdmission }) => Promise<RunOnceResult>;
  retryProviderCooldownsImpl?: (options: {
    configPath?: string;
    limit?: number;
    expiredOnly?: boolean;
    dryRun: boolean;
    useZCode?: boolean;
    licenseAdmission?: ProductionLicenseAdmission;
  }) => Promise<RetryProviderCooldownsResult>;
  issueEnrichmentCycleImpl?: (options: {
    configPath?: string;
    dryRun: boolean;
    licenseAdmission?: ProductionLicenseAdmission;
  }) => Promise<IssueEnrichmentCycleResult>;
  cleanupReviewWorktreesImpl?: (options: { configPath?: string; dryRun: boolean }) => ReviewWorktreeCleanupSummary;
  recordHeartbeatImpl?: (event: DaemonHeartbeatEvent, error?: string, runId?: string) => void;
  admitDaemonCycleImpl?: (configPath?: string) => Promise<DaemonCycleAdmissions | void>;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

export interface CleanupReviewWorktreesDeps {
  loadConfigImpl?: typeof loadConfig;
  probeOpenReviewWorktreePathsImpl?: typeof probeOpenReviewWorktreePaths;
}

export async function runDaemonCycle(input: RunDaemonCycleOptions): Promise<DaemonCycleResult> {
  const stdout = input.stdout ?? console.log;
  const stderr = input.stderr ?? console.error;
  let admissions: DaemonCycleAdmissions | void;
  try {
    admissions = await (input.admitDaemonCycleImpl ?? admitDaemonCycle)(input.configPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr(formatDaemonLog({
      event: "daemon_cycle_failed",
      level: "error",
      cycle: input.cycle,
      dryRun: input.dryRun,
      error: message
    }));
    return { ok: false, failureKind: "admission_denied", error: message };
  }
  const schedulerEnabled = input.reviewSchedulerEnabled === true;
  const heartbeatRunId = randomUUID();
  const runOnceImpl = input.runOnceImpl ?? (schedulerEnabled ? runScheduledCycle : runOnce);
  const retryProviderCooldownsImpl = input.retryProviderCooldownsImpl ?? retryProviderCooldowns;
  const recordHeartbeat = input.recordHeartbeatImpl ?? ((event: DaemonHeartbeatEvent, error?: string, runId?: string) => {
    recordDaemonHeartbeatFromConfig({
      configPath: input.configPath,
      cycle: input.cycle,
      dryRun: input.dryRun,
      event,
      error,
      runId,
      stderr
    });
  });

  if (input.worktreeCleanupDue === true) {
    try {
      const cleanup = (input.cleanupReviewWorktreesImpl ?? cleanupReviewWorktreesFromConfig)({
        configPath: input.configPath,
        dryRun: input.dryRun
      });
      stdout(formatDaemonLog({
        event: "daemon_worktree_cleanup",
        cycle: input.cycle,
        dryRun: input.dryRun,
        result: summarizeWorktreeCleanup(cleanup)
      }));
    } catch (error) {
      stderr(formatDaemonLog({
        event: "daemon_worktree_cleanup_failed",
        level: "error",
        cycle: input.cycle,
        dryRun: input.dryRun,
        error: error instanceof Error ? error.message : String(error)
      }));
    }
  }

  recordHeartbeat("daemon_cycle_start", undefined, heartbeatRunId);
  stdout(formatDaemonLog({
    event: "daemon_cycle_start",
    cycle: input.cycle,
    dryRun: input.dryRun,
    pilotRepos: input.pilotRepos,
    monitoredRepos: input.monitoredRepos,
    canaryPulls: input.canaryPulls,
    commandsEnabled: input.commandsEnabled
  }));

  const issueEnrichmentPromise = input.issueEnrichmentEnabled === true
    ? runIssueEnrichmentLane({ input, admissions, stdout, stderr })
    : Promise.resolve();

  try {
    const result = await runOnceImpl({
      configPath: input.configPath,
      dryRun: input.dryRun,
      ...(admissions ? { licenseAdmission: admissions.reviewDiscovery } : {})
    });
    try {
      if (schedulerEnabled) {
        stdout(formatDaemonLog({
          event: "daemon_provider_cooldown_retry_skipped",
          cycle: input.cycle,
          dryRun: input.dryRun,
          reason: "review_scheduler_enabled"
        }));
      } else {
        const providerCooldownRetry = await retryProviderCooldownsImpl({
          configPath: input.configPath,
          dryRun: input.dryRun,
          expiredOnly: true,
          limit: 1,
          useZCode: true,
          ...(admissions ? { licenseAdmission: admissions.reviewDiscovery } : {})
        });
        stdout(formatDaemonLog({
          event: "daemon_provider_cooldown_retry",
          cycle: input.cycle,
          dryRun: input.dryRun,
          result: providerCooldownRetry
        }));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      stderr(formatDaemonLog({
        event: "daemon_provider_cooldown_retry_failed",
        level: "error",
        cycle: input.cycle,
        dryRun: input.dryRun,
        error: message
      }));
    }
    await issueEnrichmentPromise;
    stdout(formatDaemonLog({
      event: "daemon_cycle_complete",
      cycle: input.cycle,
      dryRun: input.dryRun,
      result
    }));
    recordHeartbeat("daemon_cycle_complete", undefined, heartbeatRunId);
    return { ok: true, result };
  } catch (error) {
    await issueEnrichmentPromise;
    const message = error instanceof Error ? error.message : String(error);
    stderr(formatDaemonLog({
      event: "daemon_cycle_failed",
      level: "error",
      cycle: input.cycle,
      dryRun: input.dryRun,
      error: message
    }));
    recordHeartbeat("daemon_cycle_failed", message, heartbeatRunId);
    return { ok: false, failureKind: "runtime_failure", error: message };
  }
}

export function cleanupReviewWorktreesFromConfig(input: {
  configPath?: string;
  dryRun: boolean;
}, deps: CleanupReviewWorktreesDeps = {}): ReviewWorktreeCleanupSummary {
  const config = (deps.loadConfigImpl ?? loadConfig)(input.configPath);
  if (config.worktreeCleanup?.enabled !== true) {
    return {
      worktreesRoot: resolve(config.workRoot, "worktrees"),
      retentionMs: config.worktreeCleanup?.retentionMs ?? 0,
      checked: 0,
      deleted: 0,
      skipped: 0,
      errors: 0,
      outcomes: []
    };
  }
  const state = new ReviewStateStore(config.statePath);
  try {
    const activeReviewRun = state.hasActiveReviewRunLease();
    const activeReviewHeads = state
      .listReviewQueueJobs({ states: ["queued", "leased", "running", "provider_deferred", "blocked_on_proof"] })
      .map((job) => ({ repo: job.repo, pullNumber: job.pullNumber, headSha: job.headSha }));
    const openPaths = (deps.probeOpenReviewWorktreePathsImpl ?? probeOpenReviewWorktreePaths)(config.workRoot);
    if (!openPaths.ok) {
      throw new Error(`worktree cleanup open-handle probe failed: ${openPaths.error ?? "unknown error"}`);
    }
    return cleanupStaleReviewWorktrees({
      workRoot: config.workRoot,
      retentionMs: config.worktreeCleanup!.retentionMs,
      leaseTtlMs: config.reviewConcurrency.leaseTtlMs,
      activeReviewRun,
      activeReviewHeads,
      openWorktreePaths: openPaths.paths,
      dryRun: input.dryRun,
      ops: {
        removeWorktree: (mirrorPath, worktreePath) => {
          const guarded = state.runWithExclusiveReviewIdleGuard(
            () => removeRegisteredReviewWorktree(mirrorPath, worktreePath)
          );
          return guarded.ran ? guarded.value : { ok: false, reason: "active_review_run" };
        }
      }
    });
  } finally {
    state.close();
  }
}

function summarizeWorktreeCleanup(cleanup: ReviewWorktreeCleanupSummary): Record<string, unknown> {
  const outcomeCounts: Record<string, number> = {};
  for (const outcome of cleanup.outcomes) {
    const key = `${outcome.status}:${outcome.reason}`;
    outcomeCounts[key] = (outcomeCounts[key] ?? 0) + 1;
  }
  return {
    worktreesRoot: cleanup.worktreesRoot,
    retentionMs: cleanup.retentionMs,
    checked: cleanup.checked,
    deleted: cleanup.deleted,
    skipped: cleanup.skipped,
    errors: cleanup.errors,
    outcomeCounts
  };
}

async function runIssueEnrichmentLane(input: {
  input: RunDaemonCycleOptions;
  admissions: DaemonCycleAdmissions | void;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}): Promise<void> {
  const issueEnrichmentCycleImpl = input.input.issueEnrichmentCycleImpl ?? runIssueEnrichmentCycleFromConfig;
  input.stdout(formatDaemonLog({
    event: "daemon_issue_enrichment_start",
    cycle: input.input.cycle,
    dryRun: input.input.dryRun
  }));
  try {
    const issueEnrichment = await issueEnrichmentCycleImpl({
      configPath: input.input.configPath,
      dryRun: input.input.dryRun,
      ...(input.admissions ? { licenseAdmission: input.admissions.issueEnrichment } : {})
    });
    const receipt = buildIssueEnrichmentLaneReceipt(issueEnrichment);
    input.stdout(formatDaemonLog({
      event: "daemon_issue_enrichment",
      phase: receipt.ok ? "complete" : "result",
      cycle: input.input.cycle,
      dryRun: input.input.dryRun,
      receipt
    }));
  } catch (error) {
    const receipt = buildIssueEnrichmentLaneReceipt();
    input.stderr(formatDaemonLog({
      event: "daemon_issue_enrichment_failed",
      level: "error",
      phase: "failed",
      cycle: input.input.cycle,
      dryRun: input.input.dryRun,
      receipt
    }));
  }
}

async function admitDaemonCycle(configPath?: string): Promise<DaemonCycleAdmissions> {
  const config = loadConfig(configPath);
  const admission = await requireActiveDaemonCycleAdmissions({
    config: config.license!
  });
  if (!admission.ok) {
    throw new Error(`license ${admission.decision.status}: ${admission.decision.detail}`);
  }
  return admission.admissions;
}

async function runIssueEnrichmentCycleFromConfig(input: {
  configPath?: string;
  dryRun: boolean;
  licenseAdmission?: ProductionLicenseAdmission;
}): Promise<IssueEnrichmentCycleResult> {
  const config = loadConfig(input.configPath);
  let licenseAdmission = input.licenseAdmission;
  if (licenseAdmission && !isAuthenticProductionLicenseAdmission(licenseAdmission, "issue_enrichment")) {
    throw new Error("production issue-enrichment admission is required");
  }
  if (!licenseAdmission) {
    const result = await requireActiveProductionLicense({
      operation: "issue_enrichment",
      config: config.license!
    });
    if (!result.ok) throw new Error(`license ${result.decision.status}: ${result.decision.detail}`);
    licenseAdmission = result.admission;
  }
  const state = new ReviewStateStore(config.statePath);
  try {
    return await runIssueEnrichmentCycle({
      config,
      state,
      github: new GitHubApi(config.github),
      dryRun: input.dryRun,
      licenseAdmission
    });
  } finally {
    state.close();
  }
}

function recordDaemonHeartbeatFromConfig(input: {
  configPath?: string;
  cycle: number;
  dryRun: boolean;
  event: DaemonHeartbeatEvent;
  error?: string;
  runId?: string;
  stderr: (line: string) => void;
}): void {
  try {
    const config = loadConfig(input.configPath);
    const state = new ReviewStateStore(config.statePath);
    try {
      state.recordDaemonHeartbeat({
        cycle: input.cycle,
        dryRun: input.dryRun,
        event: input.event,
        ...(input.runId ? { runId: input.runId } : {}),
        ...(input.error ? { error: input.error } : {})
      });
    } finally {
      state.close();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    input.stderr(formatDaemonLog({
      event: "daemon_heartbeat_failed",
      level: "error",
      cycle: input.cycle,
      dryRun: input.dryRun,
      error: message
    }));
  }
}
