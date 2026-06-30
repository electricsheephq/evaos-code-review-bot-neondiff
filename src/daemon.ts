import { formatDaemonLog } from "./daemon-log.js";
import { runOnce, type RunOnceResult } from "./worker.js";

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
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

export async function runDaemonCycle(input: RunDaemonCycleOptions): Promise<DaemonCycleResult> {
  const stdout = input.stdout ?? console.log;
  const stderr = input.stderr ?? console.error;
  const runOnceImpl = input.runOnceImpl ?? runOnce;

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
    stdout(formatDaemonLog({
      event: "daemon_cycle_complete",
      cycle: input.cycle,
      dryRun: input.dryRun,
      result
    }));
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
    return { ok: false, error: message };
  }
}
