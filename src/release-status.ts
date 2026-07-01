import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { loadConfig } from "./config.js";
import { parseProviderCooldownError, PROVIDER_COOLDOWN_ERROR_PREFIX } from "./state.js";

export interface ReleaseRepoStatus {
  branch: string;
  head: string;
  dirtyFiles: string[];
}

export interface ReleaseLaunchdStatus {
  label: string;
  state: "running" | "not_running" | "unknown";
  pid?: number;
  configPath?: string;
  dryRun?: boolean;
}

export interface ReleaseDatabaseStatus {
  rowCount: number;
  errorCount: number;
  skippedCount?: number;
  providerCooldownCount?: number;
  activeProviderCooldownCount?: number;
  expiredProviderCooldownCount?: number;
}

export interface ReleaseHeartbeatStatus {
  status: "fresh" | "stale" | "missing";
  maxAgeMs: number;
  latestAt?: string;
  ageMs?: number;
  cycle?: number;
  event?: string;
  dryRun?: boolean;
}

export interface ReleaseStatusInput {
  repo: ReleaseRepoStatus;
  expectedHead?: string;
  configPath: string;
  launchd: ReleaseLaunchdStatus;
  database: ReleaseDatabaseStatus;
  heartbeat: ReleaseHeartbeatStatus;
  now?: Date;
}

export interface ReleaseStatus {
  ok: boolean;
  checkedAt: string;
  releaseUnit: {
    channel: "local-beta";
    sourceHead: string;
    branch: string;
    configPath: string;
  };
  repo: ReleaseRepoStatus;
  launchd: ReleaseLaunchdStatus;
  database: ReleaseDatabaseStatus;
  heartbeat: ReleaseHeartbeatStatus;
  recommendedActions: string[];
  gates: Array<{ name: string; ok: boolean; detail: string }>;
  rollback: {
    restartCommand: string;
    unloadCommand: string;
  };
}

export function buildReleaseStatus(input: ReleaseStatusInput): ReleaseStatus {
  const expectedHeadOk = !input.expectedHead || input.repo.head === input.expectedHead;
  const branchOk = input.repo.branch === "main";
  const cleanOk = input.repo.dirtyFiles.length === 0;
  const launchdRunningOk = input.launchd.state === "running";
  const launchdConfigOk = input.launchd.configPath === input.configPath;
  const dbOk = input.database.errorCount === 0;
  const expiredProviderCooldownOk = (input.database.expiredProviderCooldownCount ?? 0) === 0;
  const heartbeatOk = input.heartbeat.status === "fresh";
  const retryProviderCooldownCommand =
    `npx tsx src/cli.ts retry-provider-cooldowns --config ${input.configPath} ` +
    "--expired-only true --dry-run false --zcode true";
  const gates = [
    {
      name: "expected_head",
      ok: expectedHeadOk,
      detail: input.expectedHead ? `${input.repo.head} ${expectedHeadOk ? "==" : "!="} ${input.expectedHead}` : "not configured"
    },
    {
      name: "clean_checkout",
      ok: cleanOk,
      detail: cleanOk ? "clean" : `${input.repo.dirtyFiles.length} dirty file(s)`
    },
    {
      name: "release_branch",
      ok: branchOk,
      detail: input.repo.branch
    },
    {
      name: "launchd_running",
      ok: launchdRunningOk,
      detail: input.launchd.state
    },
    {
      name: "launchd_config",
      ok: launchdConfigOk,
      detail: input.launchd.configPath ?? "not detected"
    },
    {
      name: "live_db_no_errors",
      ok: dbOk,
      detail:
        `${input.database.errorCount} blocking error row(s)` +
        describeProviderCooldownCounts(input.database)
    },
    {
      name: "provider_cooldown_backlog",
      ok: expiredProviderCooldownOk,
      detail: expiredProviderCooldownOk
        ? describeProviderCooldownBacklog(input.database)
        : `${describeProviderCooldownBacklog(input.database)}; retry: ${retryProviderCooldownCommand}`
    },
    {
      name: "daemon_heartbeat_recent",
      ok: heartbeatOk,
      detail: describeHeartbeat(input.heartbeat)
    }
  ];

  return {
    ok: gates.every((gate) => gate.ok),
    checkedAt: (input.now ?? new Date()).toISOString(),
    releaseUnit: {
      channel: "local-beta",
      sourceHead: input.repo.head,
      branch: input.repo.branch,
      configPath: input.configPath
    },
    repo: input.repo,
    launchd: input.launchd,
    database: input.database,
    heartbeat: input.heartbeat,
    recommendedActions: expiredProviderCooldownOk
      ? []
      : [
          retryProviderCooldownCommand,
          `npx tsx src/cli.ts provider-cooldowns --config ${input.configPath} --expired-only true`
        ],
    gates,
    rollback: {
      restartCommand: `launchctl kickstart -k gui/$(id -u)/${input.launchd.label}`,
      unloadCommand: `launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/${input.launchd.label}.plist`
    }
  };
}

export function collectReleaseStatus(input: {
  cwd: string;
  configPath?: string;
  expectedHead?: string;
  launchdLabel?: string;
  statePath?: string;
}): ReleaseStatus {
  const config = loadConfig(input.configPath);
  const configPath = input.configPath ?? "(default config)";
  const now = new Date();
  return buildReleaseStatus({
    repo: readRepoStatus(input.cwd),
    expectedHead: input.expectedHead,
    configPath,
    launchd: readLaunchdStatus(input.launchdLabel ?? "com.electricsheephq.evaos-code-review-bot"),
    database: readDatabaseStatus(input.statePath ?? config.statePath, now),
    heartbeat: readHeartbeatStatus(input.statePath ?? config.statePath, config.pollIntervalMs * 2, now),
    now
  });
}

function readRepoStatus(cwd: string): ReleaseRepoStatus {
  return {
    branch: git(cwd, ["branch", "--show-current"]) || "(detached)",
    head: git(cwd, ["rev-parse", "HEAD"]),
    dirtyFiles: git(cwd, ["status", "--short"])
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
  };
}

function readLaunchdStatus(label: string): ReleaseLaunchdStatus {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const target = uid === undefined ? label : `gui/${uid}/${label}`;
  const result = spawnSync("launchctl", ["print", target], { encoding: "utf8" });
  if (result.status !== 0) return { label, state: "unknown" };
  const stdout = result.stdout;
  const state = stdout.match(/\bstate = (\w+)/)?.[1] === "running" ? "running" : "not_running";
  const pidText = stdout.match(/\bpid = (\d+)/)?.[1];
  const args = stdout.match(/arguments = \{([\s\S]*?)\n\t\}/)?.[1] ?? "";
  const configMatch = args.match(/--config\s*\n\s*([^\n]+)/);
  const dryRunMatch = args.match(/--dry-run\s*\n\s*([^\n]+)/);
  return {
    label,
    state,
    ...(pidText ? { pid: Number(pidText) } : {}),
    ...(configMatch?.[1] ? { configPath: configMatch[1].trim() } : {}),
    ...(dryRunMatch?.[1] ? { dryRun: dryRunMatch[1].trim() !== "false" } : {})
  };
}

function readDatabaseStatus(statePath: string, now: Date): ReleaseDatabaseStatus {
  if (!existsSync(statePath)) return { rowCount: 0, errorCount: 0 };
  const db = new DatabaseSync(statePath, { readOnly: true });
  try {
    const row = db
      .prepare(
        `select count(*) as rowCount,
                sum(case when status = 'skipped' then 1 else 0 end) as skippedCount,
                sum(case
                  when status = 'skipped' and error like 'provider_rate_limit_cooldown_until=%' then 1
                  else 0
                end) as providerCooldownCount,
                sum(case
                  when status = 'failed' then 1
                  when status = 'skipped' and error like 'provider_rate_limit_cooldown_until=%' then 0
                  when status != 'skipped' and error is not null and error != '' then 1
                  else 0
                end) as errorCount
           from processed_reviews`
      )
      .get() as {
        rowCount?: number;
        skippedCount?: number | null;
        providerCooldownCount?: number | null;
        errorCount?: number | null;
      };
    const providerCooldownRows = db
      .prepare(
        `select error
         from processed_reviews
         where status = 'skipped' and error like ?`
      )
      .all(`${PROVIDER_COOLDOWN_ERROR_PREFIX}%`) as unknown as Array<{ error: string | null }>;
    const providerCooldowns = providerCooldownRows
      .map((providerRow) => parseProviderCooldownError(providerRow.error ?? undefined))
      .filter((cooldown): cooldown is NonNullable<typeof cooldown> => Boolean(cooldown));
    const expiredProviderCooldownCount = providerCooldowns.filter((cooldown) => {
      const cooldownUntilMs = Date.parse(cooldown.cooldownUntil);
      return !Number.isFinite(cooldownUntilMs) || cooldownUntilMs <= now.getTime();
    }).length;
    const activeProviderCooldownCount = providerCooldowns.length - expiredProviderCooldownCount;
    return {
      rowCount: row.rowCount ?? 0,
      skippedCount: row.skippedCount ?? 0,
      providerCooldownCount: row.providerCooldownCount ?? 0,
      activeProviderCooldownCount,
      expiredProviderCooldownCount,
      errorCount: row.errorCount ?? 0
    };
  } finally {
    db.close();
  }
}

function describeProviderCooldownCounts(database: ReleaseDatabaseStatus): string {
  const total = database.providerCooldownCount ?? 0;
  if (total === 0) return "";
  return (
    `; ${total} provider cooldown skip row(s)` +
    ` (${database.activeProviderCooldownCount ?? 0} active, ${database.expiredProviderCooldownCount ?? 0} expired)`
  );
}

function describeProviderCooldownBacklog(database: ReleaseDatabaseStatus): string {
  return `${database.expiredProviderCooldownCount ?? 0} expired provider cooldown row(s); ${database.activeProviderCooldownCount ?? 0} active provider cooldown row(s)`;
}

function readHeartbeatStatus(statePath: string, maxAgeMs: number, now: Date): ReleaseHeartbeatStatus {
  if (!existsSync(statePath)) return { status: "missing", maxAgeMs };
  const db = new DatabaseSync(statePath, { readOnly: true });
  try {
    const table = db
      .prepare("select 1 from sqlite_master where type = 'table' and name = 'daemon_heartbeat' limit 1")
      .get();
    if (!table) return { status: "missing", maxAgeMs };

    const row = db
      .prepare(
        `select cycle, event, dry_run, recorded_at
         from daemon_heartbeat
         where id = 1 and recorded_at is not null
         limit 1`
      )
      .get() as { cycle: number; event: string; dry_run: number; recorded_at: string } | undefined;
    if (!row) return { status: "missing", maxAgeMs };

    const latestTime = Date.parse(row.recorded_at);
    if (!Number.isFinite(latestTime)) {
      return {
        status: "stale",
        maxAgeMs,
        latestAt: row.recorded_at,
        cycle: row.cycle,
        event: row.event,
        dryRun: row.dry_run === 1
      };
    }
    const ageMs = Math.max(0, now.getTime() - latestTime);
    return {
      status: ageMs <= maxAgeMs ? "fresh" : "stale",
      maxAgeMs,
      latestAt: row.recorded_at,
      ageMs,
      cycle: row.cycle,
      event: row.event,
      dryRun: row.dry_run === 1
    };
  } finally {
    db.close();
  }
}

function describeHeartbeat(heartbeat: ReleaseHeartbeatStatus): string {
  if (heartbeat.status === "missing") return `missing heartbeat row; max age ${heartbeat.maxAgeMs}ms`;
  const age = heartbeat.ageMs === undefined ? "unknown" : `${heartbeat.ageMs}ms`;
  return `${heartbeat.status}; age ${age}; max ${heartbeat.maxAgeMs}ms; event ${heartbeat.event ?? "unknown"}; cycle ${heartbeat.cycle ?? "unknown"}`;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}
