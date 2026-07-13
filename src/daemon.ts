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

export type DaemonCycleResult =
  | { ok: true; result: RunOnceResult }
  | { ok: false; failureKind: "admission_denied" | "runtime_failure"; error: string };

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
  recordHeartbeatImpl?: (event: DaemonHeartbeatEvent, error?: string) => void;
  admitDaemonCycleImpl?: (configPath?: string) => Promise<DaemonCycleAdmissions | void>;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
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
  const runOnceImpl = input.runOnceImpl ?? (schedulerEnabled ? runScheduledCycle : runOnce);
  const retryProviderCooldownsImpl = input.retryProviderCooldownsImpl ?? retryProviderCooldowns;
  const recordHeartbeat = input.recordHeartbeatImpl ?? ((event: DaemonHeartbeatEvent, error?: string) => {
    recordDaemonHeartbeatFromConfig({
      configPath: input.configPath,
      cycle: input.cycle,
      dryRun: input.dryRun,
      event,
      error,
      stderr
    });
  });

  recordHeartbeat("daemon_cycle_start");
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
    recordHeartbeat("daemon_cycle_complete");
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
    recordHeartbeat("daemon_cycle_failed", message);
    return { ok: false, failureKind: "runtime_failure", error: message };
  }
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
    input.stdout(formatDaemonLog({
      event: "daemon_issue_enrichment",
      phase: "complete",
      cycle: input.input.cycle,
      dryRun: input.input.dryRun,
      result: issueEnrichment
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    input.stderr(formatDaemonLog({
      event: "daemon_issue_enrichment_failed",
      level: "error",
      cycle: input.input.cycle,
      dryRun: input.input.dryRun,
      error: message
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
