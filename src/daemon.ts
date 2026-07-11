import { formatDaemonLog } from "./daemon-log.js";
import { loadConfig } from "./config.js";
import { GitHubApi } from "./github.js";
import { runIssueEnrichmentCycle, type IssueEnrichmentCycleResult } from "./issue-enrichment.js";
import { runScheduledCycle } from "./scheduler.js";
import { requireActiveProductionLicense } from "./license-admission.js";
import { ReviewStateStore, type DaemonHeartbeatEvent } from "./state.js";
import { retryProviderCooldowns, runOnce, type RetryProviderCooldownsResult, type RunOnceResult } from "./worker.js";

export type DaemonCycleResult =
  | { ok: true; result: RunOnceResult }
  | { ok: false; error: string };

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
  runOnceImpl?: (options: { configPath?: string; dryRun: boolean }) => Promise<RunOnceResult>;
  retryProviderCooldownsImpl?: (options: {
    configPath?: string;
    limit?: number;
    expiredOnly?: boolean;
    dryRun: boolean;
    useZCode?: boolean;
  }) => Promise<RetryProviderCooldownsResult>;
  issueEnrichmentCycleImpl?: (options: { configPath?: string; dryRun: boolean }) => Promise<IssueEnrichmentCycleResult>;
  recordHeartbeatImpl?: (event: DaemonHeartbeatEvent, error?: string) => void;
  admitDaemonCycleImpl?: (configPath?: string) => Promise<void>;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

export async function runDaemonCycle(input: RunDaemonCycleOptions): Promise<DaemonCycleResult> {
  const stdout = input.stdout ?? console.log;
  const stderr = input.stderr ?? console.error;
  try {
    await (input.admitDaemonCycleImpl ?? admitDaemonCycle)(input.configPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr(formatDaemonLog({
      event: "daemon_cycle_failed",
      level: "error",
      cycle: input.cycle,
      dryRun: input.dryRun,
      error: message
    }));
    return { ok: false, error: message };
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

  try {
    const result = await runOnceImpl({ configPath: input.configPath, dryRun: input.dryRun });
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
          useZCode: true
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
    if (input.issueEnrichmentEnabled === true) {
      const issueEnrichmentCycleImpl = input.issueEnrichmentCycleImpl ?? runIssueEnrichmentCycleFromConfig;
      try {
        const issueEnrichment = await issueEnrichmentCycleImpl({
          configPath: input.configPath,
          dryRun: input.dryRun
        });
        stdout(formatDaemonLog({
          event: "daemon_issue_enrichment",
          cycle: input.cycle,
          dryRun: input.dryRun,
          result: issueEnrichment
        }));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        stderr(formatDaemonLog({
          event: "daemon_issue_enrichment_failed",
          level: "error",
          cycle: input.cycle,
          dryRun: input.dryRun,
          error: message
        }));
      }
    }
    stdout(formatDaemonLog({
      event: "daemon_cycle_complete",
      cycle: input.cycle,
      dryRun: input.dryRun,
      result
    }));
    recordHeartbeat("daemon_cycle_complete");
    return { ok: true, result };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr(formatDaemonLog({
      event: "daemon_cycle_failed",
      level: "error",
      cycle: input.cycle,
      dryRun: input.dryRun,
      error: message
    }));
    recordHeartbeat("daemon_cycle_failed", message);
    return { ok: false, error: message };
  }
}

async function admitDaemonCycle(configPath?: string): Promise<void> {
  const config = loadConfig(configPath);
  const admission = await requireActiveProductionLicense({
    operation: "daemon_cycle",
    config: config.license!
  });
  if (!admission.ok) {
    throw new Error(`license ${admission.decision.status}: ${admission.decision.detail}`);
  }
}

async function runIssueEnrichmentCycleFromConfig(input: { configPath?: string; dryRun: boolean }): Promise<IssueEnrichmentCycleResult> {
  const config = loadConfig(input.configPath);
  const licenseAdmission = await requireActiveProductionLicense({
    operation: "issue_enrichment",
    config: config.license!
  });
  if (!licenseAdmission.ok) {
    throw new Error(`license ${licenseAdmission.decision.status}: ${licenseAdmission.decision.detail}`);
  }
  const state = new ReviewStateStore(config.statePath);
  try {
    return await runIssueEnrichmentCycle({
      config,
      state,
      github: new GitHubApi(config.github),
      dryRun: input.dryRun,
      licenseAdmission: licenseAdmission.admission
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
