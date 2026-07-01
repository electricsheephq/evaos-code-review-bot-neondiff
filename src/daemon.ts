import { formatDaemonLog } from "./daemon-log.js";
import { loadConfig } from "./config.js";
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
  runOnceImpl?: (options: { configPath?: string; dryRun: boolean }) => Promise<RunOnceResult>;
  retryProviderCooldownsImpl?: (options: {
    configPath?: string;
    limit?: number;
    expiredOnly?: boolean;
    dryRun: boolean;
    useZCode?: boolean;
  }) => Promise<RetryProviderCooldownsResult>;
  recordHeartbeatImpl?: (event: DaemonHeartbeatEvent, error?: string) => void;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

export async function runDaemonCycle(input: RunDaemonCycleOptions): Promise<DaemonCycleResult> {
  const stdout = input.stdout ?? console.log;
  const stderr = input.stderr ?? console.error;
  const runOnceImpl = input.runOnceImpl ?? runOnce;
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
