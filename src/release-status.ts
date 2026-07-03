import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { loadConfig } from "./config.js";
import { buildReviewBudgetStatus, type ReviewBudgetStatus } from "./review-budget.js";
import { parseProviderCooldownError, PROVIDER_COOLDOWN_ERROR_PREFIX } from "./state.js";
import type { BotConfig } from "./config.js";
import type { ReviewQueueJobRecord } from "./state.js";

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
  nodeOptions?: string;
  usesSystemCa?: boolean;
}

export interface ReleaseDatabaseStatus {
  rowCount: number;
  errorCount: number;
  skippedCount?: number;
  reviewerSessionCount?: number;
  activeReviewerSessionCount?: number;
  expiredReviewerSessionCount?: number;
  reviewerSessionsByRepo?: ReviewerSessionRepoStatus[];
  providerCooldownCount?: number;
  activeProviderCooldownCount?: number;
  expiredProviderCooldownCount?: number;
  activeGlobalProviderCooldownCount?: number;
  coveredExpiredProviderCooldownCount?: number;
  coveredByActiveQueueRetryProviderCooldownCount?: number;
  retryableExpiredProviderCooldownCount?: number;
  providerThrottleState?: "none" | "active" | "expired_retryable";
  reviewQueueJobCount?: number;
  queuedReviewQueueJobCount?: number;
  leasedReviewQueueJobCount?: number;
  runningReviewQueueJobCount?: number;
  providerDeferredReviewQueueJobCount?: number;
  retryableProviderDeferredReviewQueueJobCount?: number;
  failedReviewQueueJobCount?: number;
  reviewRunLeaseCount?: number;
  staleReviewRunLeaseCount?: number;
  staleActiveReviewQueueJobCount?: number;
  reviewQueueJobsByRepo?: ReviewQueueRepoStatus[];
}

export interface ReviewerSessionRepoStatus {
  repo: string;
  total: number;
  active: number;
  expired: number;
}

export interface ReviewQueueRepoStatus {
  repo: string;
  total: number;
  queued: number;
  leased: number;
  running: number;
  providerDeferred: number;
  retryableProviderDeferred: number;
  failed: number;
}

export interface ReleaseHeartbeatStatus {
  status: "fresh" | "active" | "stale" | "missing";
  maxAgeMs: number;
  activeMaxAgeMs?: number;
  latestAt?: string;
  ageMs?: number;
  cycle?: number;
  event?: string;
  dryRun?: boolean;
  activeCycle?: number;
  activeStartedAt?: string;
  activeAgeMs?: number;
}

export interface ReleaseStatusInput {
  repo: ReleaseRepoStatus;
  expectedHead?: string;
  configPath: string;
  launchd: ReleaseLaunchdStatus;
  database: ReleaseDatabaseStatus;
  heartbeat: ReleaseHeartbeatStatus;
  budget?: ReviewBudgetStatus;
  now?: Date;
}

export interface ReleaseStatus {
  ok: boolean;
  checkedAt: string;
  summary: {
    blockingErrorRows: number;
    failedQueueJobs: number;
    staleReviewLeases: number;
    providerDeferredQueueJobs: number;
    retryableProviderDeferredQueueJobs: number;
    readyToRetryProviderDeferredJobs: number;
    expiredProviderCooldowns: number;
    retryableExpiredProviderCooldowns: number;
    activeProviderCooldowns: number;
  };
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
  budget?: ReviewBudgetStatus;
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
  const launchdSystemCaOk = input.launchd.usesSystemCa === true;
  const dbOk = input.database.errorCount === 0;
  const providerThrottleState = input.database.providerThrottleState ?? inferProviderThrottleState(input.database);
  const retryableExpiredProviderCooldownCount =
    input.database.retryableExpiredProviderCooldownCount ??
    Math.max(
      0,
      (input.database.expiredProviderCooldownCount ?? 0) - (input.database.coveredExpiredProviderCooldownCount ?? 0)
    );
  const expiredProviderCooldownOk = retryableExpiredProviderCooldownCount === 0;
  const failedQueueJobsOk = (input.database.failedReviewQueueJobCount ?? 0) === 0;
  const staleReviewLeaseCount = (input.database.staleReviewRunLeaseCount ?? 0) +
    (input.database.staleActiveReviewQueueJobCount ?? 0);
  const staleReviewLeasesOk = staleReviewLeaseCount === 0;
  const actionableProviderDeferredQueueJobs =
    input.budget?.providerDeferred.readyToRetry ??
    (input.database.retryableProviderDeferredReviewQueueJobCount ?? 0);
  const retryableDeferredQueueJobsOk = actionableProviderDeferredQueueJobs === 0;
  const heartbeatOk = input.heartbeat.status === "fresh" || input.heartbeat.status === "active";
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
      name: "launchd_node_system_ca",
      ok: launchdSystemCaOk,
      detail: input.launchd.usesSystemCa === undefined
        ? "NODE_OPTIONS not detected"
        : input.launchd.usesSystemCa
          ? "NODE_OPTIONS includes --use-system-ca"
          : "NODE_OPTIONS missing --use-system-ca"
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
        ? describeProviderCooldownBacklog(input.database, providerThrottleState)
        : `${describeProviderCooldownBacklog(input.database, providerThrottleState)}; retry: ${retryProviderCooldownCommand}`
    },
    {
      name: "queue_no_failed_jobs",
      ok: failedQueueJobsOk,
      detail: `${input.database.failedReviewQueueJobCount ?? 0} failed durable queue job(s)`
    },
    {
      name: "queue_no_stale_review_leases",
      ok: staleReviewLeasesOk,
      detail:
        `${input.database.staleReviewRunLeaseCount ?? 0} stale review run lease(s); ` +
        `${input.database.staleActiveReviewQueueJobCount ?? 0} stale active queue job(s)`
    },
    {
      name: "queue_no_retryable_provider_deferred_jobs",
      ok: retryableDeferredQueueJobsOk,
      detail: describeProviderDeferredQueueStatus(input.database, input.budget)
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
    summary: {
      blockingErrorRows: input.database.errorCount,
      failedQueueJobs: input.database.failedReviewQueueJobCount ?? 0,
      staleReviewLeases: staleReviewLeaseCount,
      providerDeferredQueueJobs: input.database.providerDeferredReviewQueueJobCount ?? 0,
      retryableProviderDeferredQueueJobs: input.database.retryableProviderDeferredReviewQueueJobCount ?? 0,
      readyToRetryProviderDeferredJobs: actionableProviderDeferredQueueJobs,
      expiredProviderCooldowns: input.database.expiredProviderCooldownCount ?? 0,
      retryableExpiredProviderCooldowns: retryableExpiredProviderCooldownCount,
      activeProviderCooldowns: input.database.activeProviderCooldownCount ?? 0
    },
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
    ...(input.budget ? { budget: input.budget } : {}),
    recommendedActions: [
      ...(expiredProviderCooldownOk
        ? retryableDeferredQueueJobsOk
          ? []
          : ["wait for the next scheduler cycle or inspect provider-deferred jobs marked ready_to_retry"]
        : [
            retryProviderCooldownCommand,
            `npx tsx src/cli.ts provider-cooldowns --config ${input.configPath} --expired-only true`
          ]),
      ...(!staleReviewLeasesOk
        ? [`npx tsx src/cli.ts clear-review-queue-leases --config ${input.configPath} --dry-run true --expired-only true`]
        : [])
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
  budgetDetails?: boolean;
  budgetDetailLimit?: number;
  budgetJobLimit?: number;
  now?: Date;
}): ReleaseStatus {
  const config = loadConfig(input.configPath);
  const configPath = input.configPath ?? "(default config)";
  const now = input.now ?? new Date();
  const statePath = input.statePath ?? config.statePath;
  return buildReleaseStatus({
    repo: readRepoStatus(input.cwd),
    expectedHead: input.expectedHead,
    configPath,
    launchd: readLaunchdStatus(input.launchdLabel ?? "com.electricsheephq.evaos-code-review-bot"),
    database: readDatabaseStatus(statePath, now, config.reviewConcurrency.leaseTtlMs),
    heartbeat: readHeartbeatStatus(
      statePath,
      config.pollIntervalMs * 2,
      Math.max(config.pollIntervalMs * 2, (config.zcode.timeoutMs * 2) + 60_000),
      now
    ),
    budget: readReviewBudgetStatus(statePath, config, now, {
      includeDetails: input.budgetDetails === true,
      detailLimit: input.budgetDetailLimit,
      jobLimit: input.budgetJobLimit ?? 1_000
    }),
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
  return parseLaunchdPrintStatus(label, result.stdout);
}

export function parseLaunchdPrintStatus(label: string, stdout: string): ReleaseLaunchdStatus {
  const state = stdout.match(/\bstate = (\w+)/)?.[1] === "running" ? "running" : "not_running";
  const pidText = stdout.match(/\bpid = (\d+)/)?.[1];
  const args = extractLaunchdSection(stdout, "arguments") ?? "";
  const configMatch = args.match(/--config\s*\n\s*([^\n]+)/);
  const dryRunMatch = args.match(/--dry-run\s*\n\s*([^\n]+)/);
  const environment = extractLaunchdSection(stdout, "environment");
  const nodeOptions = normalizeLaunchdValue(readLaunchdEnvironmentValue(environment, "NODE_OPTIONS"));
  const hasLaunchdEnvironment = environment !== undefined;
  return {
    label,
    state,
    ...(pidText ? { pid: Number(pidText) } : {}),
    ...(configMatch?.[1] ? { configPath: configMatch[1].trim() } : {}),
    ...(dryRunMatch?.[1] ? { dryRun: dryRunMatch[1].trim() !== "false" } : {}),
    ...(nodeOptions ? { nodeOptions } : {}),
    ...(hasLaunchdEnvironment ? { usesSystemCa: splitNodeOptions(nodeOptions).includes("--use-system-ca") } : {})
  };
}

function extractLaunchdSection(stdout: string, sectionName: string): string | undefined {
  const lines = stdout.split(/\r?\n/);
  const sectionStart = lines.findIndex((line) => line.trim() === `${sectionName} = {`);
  if (sectionStart === -1) return undefined;

  const sectionIndent = leadingWhitespace(lines[sectionStart]).length;
  const body: string[] = [];
  for (const line of lines.slice(sectionStart + 1)) {
    if (line.trim() === "}" && leadingWhitespace(line).length <= sectionIndent) {
      return body.join("\n");
    }
    body.push(line);
  }
  return body.join("\n");
}

function leadingWhitespace(value: string): string {
  return value.match(/^\s*/)?.[0] ?? "";
}

function readLaunchdEnvironmentValue(environment: string | undefined, key: string): string | undefined {
  if (!environment) return undefined;
  for (const line of environment.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=>\s*(.*?)\s*$/);
    if (match?.[1] === key) return match[2];
  }
  return undefined;
}

function normalizeLaunchdValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if ((first === "\"" && last === "\"") || (first === "'" && last === "'")) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function splitNodeOptions(nodeOptions: string | undefined): string[] {
  return (nodeOptions ?? "")
    .split(/\s+/)
    .map((option) => option.trim())
    .filter(Boolean);
}

function readReviewBudgetStatus(
  statePath: string,
  config: BotConfig,
  now: Date,
  options: {
    includeDetails: boolean;
    detailLimit?: number;
    jobLimit?: number;
  }
): ReviewBudgetStatus {
  if (!existsSync(statePath)) {
    return buildReviewBudgetStatus({
      config,
      jobs: [],
      now,
      includeDetails: options.includeDetails,
      ...(options.detailLimit !== undefined ? { detailLimit: options.detailLimit } : {}),
      ...(options.jobLimit !== undefined ? { inputJobLimit: options.jobLimit } : {}),
      inputJobsTruncated: false
    });
  }
  const db = new DatabaseSync(statePath, { readOnly: true });
  try {
    const queueJobs = readReviewQueueBudgetJobs(db, options.jobLimit);
    return buildReviewBudgetStatus({
      config,
      jobs: queueJobs.jobs,
      now,
      includeDetails: options.includeDetails,
      ...(options.detailLimit !== undefined ? { detailLimit: options.detailLimit } : {}),
      ...(options.jobLimit !== undefined ? { inputJobLimit: options.jobLimit } : {}),
      inputJobsTruncated: queueJobs.truncated
    });
  } finally {
    db.close();
  }
}

function readReviewQueueBudgetJobs(
  db: DatabaseSync,
  limit?: number
): { jobs: ReviewQueueJobRecord[]; truncated: boolean } {
  const hasTable = db
    .prepare("select 1 from sqlite_master where type = 'table' and name = 'review_queue_jobs' limit 1")
    .get();
  if (!hasTable) return { jobs: [], truncated: false };

  const columns = new Set(
    (db.prepare("pragma table_info(review_queue_jobs)").all() as unknown as Array<{ name: string }>)
      .map((column) => column.name)
  );
  const select = (column: string, fallback = "null") =>
    columns.has(column) ? column : `${fallback} as ${column}`;
  const selectRows = `select
         job_id, attempt_id, source, lane, repo, org, pull_number, head_sha,
         ${select("base_sha")},
         ${select("provider_id")},
         priority, state,
         ${select("next_eligible_at")},
         ${select("lease_id")},
         ${select("lease_expires_at")},
         ${select("session_id")},
         ${select("comment_id")},
         ${select("review_url")},
         ${select("last_error")},
         created_at, updated_at,
         ${select("started_at")},
         ${select("finished_at")}
       from review_queue_jobs`;
  const activeRows = db
    .prepare(
      `${selectRows}
       where state in ('leased', 'running')
       order by priority asc, datetime(created_at) asc`
    )
    .all() as unknown as ReviewBudgetQueueJobRow[];
  const limitClause = limit === undefined ? "" : " limit ?";
  const pendingQuery = db
    .prepare(
      `${selectRows}
       where state in ('queued', 'provider_deferred')
       order by priority asc, datetime(created_at) asc${limitClause}`
    );
  const pendingRows = (limit === undefined
    ? pendingQuery.all()
    : pendingQuery.all(limit + 1)) as unknown as ReviewBudgetQueueJobRow[];
  const truncated = limit !== undefined && pendingRows.length > limit;
  const visiblePendingRows = truncated ? pendingRows.slice(0, limit) : pendingRows;
  return {
    jobs: [...activeRows, ...visiblePendingRows].map(mapReviewBudgetQueueJobRow),
    truncated
  };
}

function readDatabaseStatus(statePath: string, now: Date, leaseTtlMs = 15 * 60_000): ReleaseDatabaseStatus {
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
        `select repo, pull_number, head_sha, error
         from processed_reviews
         where status = 'skipped' and error like ?`
      )
      .all(`${PROVIDER_COOLDOWN_ERROR_PREFIX}%`) as unknown as Array<{
        repo: string;
        pull_number: number;
        head_sha: string;
        error: string | null;
      }>;
    const providerCooldowns = providerCooldownRows
      .map((providerRow) => {
        const parsed = parseProviderCooldownError(providerRow.error ?? undefined);
        return parsed
          ? {
              repo: providerRow.repo,
              pullNumber: providerRow.pull_number,
              headSha: providerRow.head_sha,
              ...parsed
            }
          : undefined;
      })
      .filter((cooldown): cooldown is ProviderCooldownCandidate => Boolean(cooldown));
    const activeGlobalProviderCooldowns = readActiveGlobalProviderCooldowns(db, now);
    const expiredProviderCooldowns = providerCooldowns.filter((cooldown) => {
      const cooldownUntilMs = Date.parse(cooldown.cooldownUntil);
      return !Number.isFinite(cooldownUntilMs) || cooldownUntilMs <= now.getTime();
    });
    const expiredProviderCooldownCount = expiredProviderCooldowns.length;
    const activeProviderCooldownCount = providerCooldowns.length - expiredProviderCooldownCount;
    const coveredByActiveQueueRetryProviderCooldownCount = activeGlobalProviderCooldowns.length > 0
      ? 0
      : countExpiredProviderCooldownsCoveredByActiveQueueRetry(db, expiredProviderCooldowns, now, leaseTtlMs);
    const coveredExpiredProviderCooldownCount = activeGlobalProviderCooldowns.length > 0
      ? expiredProviderCooldownCount
      : coveredByActiveQueueRetryProviderCooldownCount;
    const retryableExpiredProviderCooldownCount = expiredProviderCooldownCount - coveredExpiredProviderCooldownCount;
    const providerThrottleState = activeGlobalProviderCooldowns.length > 0 || activeProviderCooldownCount > 0
      ? "active"
      : retryableExpiredProviderCooldownCount > 0
        ? "expired_retryable"
        : "none";
    const reviewerSessions = readReviewerSessionCounts(db, now);
    const reviewQueue = readReviewQueueCounts(db, now);
    const reviewRunLeases = readReviewRunLeaseCounts(db, now);
    const staleActiveReviewQueueJobCount = readStaleActiveReviewQueueJobCount(db, now, leaseTtlMs);
    return {
      rowCount: row.rowCount ?? 0,
      skippedCount: row.skippedCount ?? 0,
      reviewerSessionCount: reviewerSessions.total,
      activeReviewerSessionCount: reviewerSessions.active,
      expiredReviewerSessionCount: reviewerSessions.expired,
      reviewerSessionsByRepo: reviewerSessions.byRepo,
      providerCooldownCount: row.providerCooldownCount ?? 0,
      activeProviderCooldownCount,
      expiredProviderCooldownCount,
      activeGlobalProviderCooldownCount: activeGlobalProviderCooldowns.length,
      coveredExpiredProviderCooldownCount,
      coveredByActiveQueueRetryProviderCooldownCount,
      retryableExpiredProviderCooldownCount,
      providerThrottleState,
      reviewQueueJobCount: reviewQueue.total,
      queuedReviewQueueJobCount: reviewQueue.queued,
      leasedReviewQueueJobCount: reviewQueue.leased,
      runningReviewQueueJobCount: reviewQueue.running,
      providerDeferredReviewQueueJobCount: reviewQueue.providerDeferred,
      retryableProviderDeferredReviewQueueJobCount: reviewQueue.retryableProviderDeferred,
      failedReviewQueueJobCount: reviewQueue.failed,
      reviewRunLeaseCount: reviewRunLeases.total,
      staleReviewRunLeaseCount: reviewRunLeases.stale,
      staleActiveReviewQueueJobCount,
      reviewQueueJobsByRepo: reviewQueue.byRepo,
      errorCount: row.errorCount ?? 0
    };
  } finally {
    db.close();
  }
}

function readReviewQueueCounts(
  db: DatabaseSync,
  now: Date
): {
  total: number;
  queued: number;
  leased: number;
  running: number;
  providerDeferred: number;
  retryableProviderDeferred: number;
  failed: number;
  byRepo: ReviewQueueRepoStatus[];
} {
  const hasTable = db
    .prepare("select 1 from sqlite_master where type = 'table' and name = 'review_queue_jobs' limit 1")
    .get();
  if (!hasTable) {
    return { total: 0, queued: 0, leased: 0, running: 0, providerDeferred: 0, retryableProviderDeferred: 0, failed: 0, byRepo: [] };
  }
  const nowIso = now.toISOString();
  const row = db
    .prepare(
      `select
         count(*) as total,
         sum(case when state = 'queued' then 1 else 0 end) as queued,
         sum(case when state = 'leased' then 1 else 0 end) as leased,
         sum(case when state = 'running' then 1 else 0 end) as running,
         sum(case when state = 'provider_deferred' then 1 else 0 end) as providerDeferred,
         sum(case when state = 'provider_deferred' and (next_eligible_at is null or datetime(next_eligible_at) <= datetime(?)) then 1 else 0 end) as retryableProviderDeferred,
         sum(case when state = 'failed' then 1 else 0 end) as failed
       from review_queue_jobs`
    )
    .get(nowIso) as QueueCountRow;
  const byRepoRows = db
    .prepare(
      `select
         repo,
         count(*) as total,
         sum(case when state = 'queued' then 1 else 0 end) as queued,
         sum(case when state = 'leased' then 1 else 0 end) as leased,
         sum(case when state = 'running' then 1 else 0 end) as running,
         sum(case when state = 'provider_deferred' then 1 else 0 end) as providerDeferred,
         sum(case when state = 'provider_deferred' and (next_eligible_at is null or datetime(next_eligible_at) <= datetime(?)) then 1 else 0 end) as retryableProviderDeferred,
         sum(case when state = 'failed' then 1 else 0 end) as failed
       from review_queue_jobs
       group by repo
       order by repo`
    )
    .all(nowIso) as unknown as Array<QueueCountRow & { repo: string }>;
  return {
    total: row.total ?? 0,
    queued: row.queued ?? 0,
    leased: row.leased ?? 0,
    running: row.running ?? 0,
    providerDeferred: row.providerDeferred ?? 0,
    retryableProviderDeferred: row.retryableProviderDeferred ?? 0,
    failed: row.failed ?? 0,
    byRepo: byRepoRows.map((repoRow) => ({
      repo: repoRow.repo,
      total: repoRow.total ?? 0,
      queued: repoRow.queued ?? 0,
      leased: repoRow.leased ?? 0,
      running: repoRow.running ?? 0,
      providerDeferred: repoRow.providerDeferred ?? 0,
      retryableProviderDeferred: repoRow.retryableProviderDeferred ?? 0,
      failed: repoRow.failed ?? 0
    }))
  };
}

function readReviewRunLeaseCounts(db: DatabaseSync, now: Date): { total: number; stale: number } {
  const hasLeaseTable = db
    .prepare("select 1 from sqlite_master where type = 'table' and name = 'review_run_leases' limit 1")
    .get();
  if (!hasLeaseTable) return { total: 0, stale: 0 };
  const columns = new Set(
    (db.prepare("pragma table_info(review_run_leases)").all() as unknown as Array<{ name: string }>)
      .map((column) => column.name)
  );
  const ownerPidColumn = columns.has("owner_pid") ? "owner_pid" : "null as owner_pid";
  const rows = db
    .prepare(`select lease_id, expires_at, ${ownerPidColumn} from review_run_leases`)
    .all() as unknown as Array<{ lease_id: string; expires_at: string; owner_pid: number | null }>;
  return {
    total: rows.length,
    stale: rows.filter((row) => {
      const expiresAtMs = Date.parse(row.expires_at);
      if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now.getTime()) return true;
      return row.owner_pid === null || !isProcessAlive(row.owner_pid);
    }).length
  };
}

function readStaleActiveReviewQueueJobCount(db: DatabaseSync, now: Date, leaseTtlMs: number): number {
  const hasQueueTable = db
    .prepare("select 1 from sqlite_master where type = 'table' and name = 'review_queue_jobs' limit 1")
    .get();
  if (!hasQueueTable) return 0;
  const columns = new Set(
    (db.prepare("pragma table_info(review_queue_jobs)").all() as unknown as Array<{ name: string }>)
      .map((column) => column.name)
  );
  if (columns.has("lease_expires_at")) {
    const legacyLeaseCutoffIso = new Date(now.getTime() - leaseTtlMs).toISOString();
    const row = db
      .prepare(
        `select count(*) as count
         from review_queue_jobs
	         where state in ('leased', 'running')
	           and (
	             (lease_expires_at is not null and (datetime(lease_expires_at) is null or datetime(lease_expires_at) <= datetime(?)))
	             or (lease_expires_at is null and datetime(updated_at) <= datetime(?))
	           )`
      )
      .get(now.toISOString(), legacyLeaseCutoffIso) as { count?: number };
    return row.count ?? 0;
  }
  const legacyLeaseCutoffIso = new Date(now.getTime() - leaseTtlMs).toISOString();
  const row = db
    .prepare(
      `select count(*) as count
       from review_queue_jobs
       where state in ('leased', 'running')
         and datetime(updated_at) <= datetime(?)`
    )
    .get(legacyLeaseCutoffIso) as { count?: number };
  return row.count ?? 0;
}

function readReviewerSessionCounts(
  db: DatabaseSync,
  now: Date
): { total: number; active: number; expired: number; byRepo: ReviewerSessionRepoStatus[] } {
  const hasTable = db
    .prepare("select 1 from sqlite_master where type = 'table' and name = 'reviewer_sessions' limit 1")
    .get();
  if (!hasTable) return { total: 0, active: 0, expired: 0, byRepo: [] };
  const rows = db
    .prepare(
      `select repo, state, expires_at, head_count_used, head_count_limit, worker_pid
       from reviewer_sessions`
    )
    .all() as unknown as ReviewerSessionCountRow[];
  const byRepo = new Map<string, ReviewerSessionRepoStatus>();
  for (const row of rows) {
    const repoStatus = byRepo.get(row.repo) ?? { repo: row.repo, total: 0, active: 0, expired: 0 };
    repoStatus.total += 1;
    if (isReviewerSessionActiveForStatus(row, now)) repoStatus.active += 1;
    if (isReviewerSessionExpiredForStatus(row, now)) repoStatus.expired += 1;
    byRepo.set(row.repo, repoStatus);
  }
  return {
    total: rows.length,
    active: rows.filter((row) => isReviewerSessionActiveForStatus(row, now)).length,
    expired: rows.filter((row) => isReviewerSessionExpiredForStatus(row, now)).length,
    byRepo: [...byRepo.values()].sort((left, right) => left.repo.localeCompare(right.repo))
  };
}

interface ReviewerSessionCountRow {
  repo: string;
  state: string;
  expires_at: string | null;
  head_count_used: number;
  head_count_limit: number;
  worker_pid: number | null;
}

function isReviewerSessionActiveForStatus(row: ReviewerSessionCountRow, now: Date): boolean {
  if (row.state !== "active" && row.state !== "warming") return false;
  if (row.worker_pid !== null && !isProcessAlive(row.worker_pid)) return false;
  const expiresAtMs = row.expires_at ? Date.parse(row.expires_at) : Number.NaN;
  return Number.isFinite(expiresAtMs) && expiresAtMs > now.getTime() && row.head_count_used < row.head_count_limit;
}

function isReviewerSessionExpiredForStatus(row: ReviewerSessionCountRow, now: Date): boolean {
  const expiresAtMs = row.expires_at ? Date.parse(row.expires_at) : Number.NaN;
  return row.state === "expired" || !Number.isFinite(expiresAtMs) || expiresAtMs <= now.getTime() || row.head_count_used >= row.head_count_limit;
}

interface ProviderCooldownCandidate {
  repo: string;
  pullNumber: number;
  headSha: string;
  cooldownUntil: string;
  reason?: string;
}

function countExpiredProviderCooldownsCoveredByActiveQueueRetry(
  db: DatabaseSync,
  cooldowns: ProviderCooldownCandidate[],
  now: Date,
  leaseTtlMs: number
): number {
  if (cooldowns.length === 0) return 0;
  const hasTable = db
    .prepare("select 1 from sqlite_master where type = 'table' and name = 'review_queue_jobs' limit 1")
    .get();
  if (!hasTable) return 0;
  const columns = new Set(
    (db.prepare("pragma table_info(review_queue_jobs)").all() as unknown as Array<{ name: string }>)
      .map((column) => column.name)
  );
  if (
    !columns.has("repo") ||
    !columns.has("pull_number") ||
    !columns.has("head_sha") ||
    !columns.has("state") ||
    !columns.has("updated_at")
  ) {
    return 0;
  }
  const hasLeaseExpiresAt = columns.has("lease_expires_at");
  const leaseClause = hasLeaseExpiresAt
    ? `and (
         (lease_expires_at is not null and datetime(lease_expires_at) > datetime(?))
         or (lease_expires_at is null and datetime(updated_at) > datetime(?))
       )`
    : "and datetime(updated_at) > datetime(?)";
  const query = db.prepare(
    `select 1
     from review_queue_jobs
     where repo = ?
       and pull_number = ?
       and head_sha = ?
       and state in ('leased', 'running')
       ${leaseClause}
     limit 1`
  );
  const nowIso = now.toISOString();
  const legacyLeaseCutoffIso = new Date(now.getTime() - leaseTtlMs).toISOString();
  return cooldowns.filter((cooldown) => {
    const cooldownUntilMs = Date.parse(cooldown.cooldownUntil);
    if (!Number.isFinite(cooldownUntilMs) || cooldownUntilMs > now.getTime()) return false;
    const row = hasLeaseExpiresAt
      ? query.get(cooldown.repo, cooldown.pullNumber, cooldown.headSha, nowIso, legacyLeaseCutoffIso)
      : query.get(cooldown.repo, cooldown.pullNumber, cooldown.headSha, legacyLeaseCutoffIso);
    return Boolean(row);
  }).length;
}

function readActiveGlobalProviderCooldowns(db: DatabaseSync, now: Date): Array<{ repo: string; cooldownUntil: string }> {
  const hasTable = db
    .prepare("select 1 from sqlite_master where type = 'table' and name = 'repo_provider_cooldowns' limit 1")
    .get();
  if (!hasTable) return [];
  const rows = db
    .prepare("select repo, cooldown_until from repo_provider_cooldowns")
    .all() as unknown as Array<{ repo: string; cooldown_until: string }>;
  return rows
    .map((row) => ({ repo: row.repo, cooldownUntil: row.cooldown_until }))
    .filter((row) => {
      const cooldownUntilMs = Date.parse(row.cooldownUntil);
      return Number.isFinite(cooldownUntilMs) && cooldownUntilMs > now.getTime();
    });
}

function describeProviderCooldownCounts(database: ReleaseDatabaseStatus): string {
  const total = database.providerCooldownCount ?? 0;
  if (total === 0) return "";
  const covered = database.coveredExpiredProviderCooldownCount ?? 0;
  return (
    `; ${total} provider cooldown skip row(s)` +
    ` (${database.activeProviderCooldownCount ?? 0} active, ${database.expiredProviderCooldownCount ?? 0} expired` +
    `${covered > 0 ? `, ${covered} covered` : ""})`
  );
}

function describeProviderCooldownBacklog(
  database: ReleaseDatabaseStatus,
  providerThrottleState = inferProviderThrottleState(database)
): string {
  const queueCovered = database.coveredByActiveQueueRetryProviderCooldownCount ?? 0;
  const globallyCovered = Math.max(0, (database.coveredExpiredProviderCooldownCount ?? 0) - queueCovered);
  if (providerThrottleState === "active" && globallyCovered > 0) {
    return (
      `provider throttle active; ${globallyCovered} expired provider cooldown row(s) ` +
      "deferred by active provider cooldown"
    );
  }
  if (queueCovered > 0) {
    const retryable = database.retryableExpiredProviderCooldownCount ?? 0;
    return (
      `${queueCovered} expired provider cooldown row(s) covered by active queue retry; ` +
      `${retryable} retryable expired provider cooldown row(s); ` +
      `${database.activeProviderCooldownCount ?? 0} active provider cooldown row(s)`
    );
  }
  return `${database.expiredProviderCooldownCount ?? 0} expired provider cooldown row(s); ${database.activeProviderCooldownCount ?? 0} active provider cooldown row(s)`;
}

function describeReviewQueueCounts(database: ReleaseDatabaseStatus): string {
  const total = database.reviewQueueJobCount ?? 0;
  if (total === 0) return "";
  return (
    `; queue total=${total}` +
    ` queued=${database.queuedReviewQueueJobCount ?? 0}` +
    ` leased=${database.leasedReviewQueueJobCount ?? 0}` +
    ` running=${database.runningReviewQueueJobCount ?? 0}` +
    ` provider_deferred=${database.providerDeferredReviewQueueJobCount ?? 0}` +
    ` failed=${database.failedReviewQueueJobCount ?? 0}`
  );
}

function describeProviderDeferredQueueStatus(
  database: ReleaseDatabaseStatus,
  budget?: ReviewBudgetStatus
): string {
  if (!budget) {
    return (
      `${database.retryableProviderDeferredReviewQueueJobCount ?? 0} retryable provider-deferred queue job(s)` +
      describeReviewQueueCounts(database)
    );
  }
  const waitingCapacity =
    budget.providerDeferred.waitingProviderCapacity +
    budget.providerDeferred.waitingOrgCapacity +
    budget.providerDeferred.waitingRepoCapacity +
    budget.providerDeferred.waitingManualReserve +
    budget.providerDeferred.waitingLeaseLimit;
  return (
    `${budget.providerDeferred.readyToRetry} ready-to-retry provider-deferred queue job(s)` +
    `; provider_deferred total=${budget.providerDeferred.total}` +
    ` retryable=${budget.providerDeferred.retryable}` +
    ` waiting_cooldown=${budget.providerDeferred.waitingCooldown}` +
    ` waiting_capacity=${waitingCapacity}` +
    describeReviewQueueCounts(database)
  );
}

function inferProviderThrottleState(database: ReleaseDatabaseStatus): "none" | "active" | "expired_retryable" {
  if ((database.activeGlobalProviderCooldownCount ?? 0) > 0 || (database.activeProviderCooldownCount ?? 0) > 0) {
    return "active";
  }
  if ((database.expiredProviderCooldownCount ?? 0) > 0) return "expired_retryable";
  return "none";
}

function readHeartbeatStatus(
  statePath: string,
  maxAgeMs: number,
  activeMaxAgeMs: number,
  now: Date
): ReleaseHeartbeatStatus {
  if (!existsSync(statePath)) return { status: "missing", maxAgeMs };
  const db = new DatabaseSync(statePath, { readOnly: true });
  try {
    const table = db
      .prepare("select 1 from sqlite_master where type = 'table' and name = 'daemon_heartbeat' limit 1")
      .get();
    if (!table) return { status: "missing", maxAgeMs };

    const columns = new Set(
      (db.prepare("pragma table_info(daemon_heartbeat)").all() as unknown as Array<{ name: string }>)
        .map((column) => column.name)
    );
    const startedCycleSelect = columns.has("started_cycle") ? "started_cycle" : "null as started_cycle";
    const startedAtSelect = columns.has("started_at") ? "started_at" : "null as started_at";
    const row = db
      .prepare(
        `select cycle, event, dry_run, recorded_at, ${startedCycleSelect}, ${startedAtSelect}
         from daemon_heartbeat
         where id = 1
         limit 1`
      )
      .get() as {
        cycle: number | null;
        event: string | null;
        dry_run: number | null;
        recorded_at: string | null;
        started_cycle: number | null;
        started_at: string | null;
      } | undefined;
    if (!row) return { status: "missing", maxAgeMs };

    const latestTime = row.recorded_at ? Date.parse(row.recorded_at) : NaN;
    const activeStartedTime = row.started_at ? Date.parse(row.started_at) : NaN;
    const hasActiveCycle =
      Number.isFinite(activeStartedTime) &&
      (!Number.isFinite(latestTime) || activeStartedTime > latestTime);
    if (hasActiveCycle) {
      const activeAgeMs = Math.max(0, now.getTime() - activeStartedTime);
      return {
        status: activeAgeMs <= activeMaxAgeMs ? "active" : "stale",
        maxAgeMs,
        activeMaxAgeMs,
        ...(row.recorded_at ? { latestAt: row.recorded_at } : {}),
        ...(Number.isFinite(latestTime) ? { ageMs: Math.max(0, now.getTime() - latestTime) } : {}),
        ...(row.cycle !== null ? { cycle: row.cycle } : {}),
        ...(row.event ? { event: row.event } : {}),
        dryRun: row.dry_run === 1,
        ...(row.started_cycle !== null ? { activeCycle: row.started_cycle } : {}),
        ...(row.started_at ? { activeStartedAt: row.started_at } : {}),
        activeAgeMs
      };
    }

    if (!Number.isFinite(latestTime)) {
      return {
        status: "stale",
        maxAgeMs,
        ...(row.recorded_at ? { latestAt: row.recorded_at } : {}),
        ...(row.cycle !== null ? { cycle: row.cycle } : {}),
        ...(row.event ? { event: row.event } : {}),
        dryRun: row.dry_run === 1
      };
    }
    const ageMs = Math.max(0, now.getTime() - latestTime);
    return {
      status: ageMs <= maxAgeMs ? "fresh" : "stale",
      maxAgeMs,
      ...(row.recorded_at ? { latestAt: row.recorded_at } : {}),
      ageMs,
      ...(row.cycle !== null ? { cycle: row.cycle } : {}),
      ...(row.event ? { event: row.event } : {}),
      dryRun: row.dry_run === 1
    };
  } finally {
    db.close();
  }
}

function describeHeartbeat(heartbeat: ReleaseHeartbeatStatus): string {
  if (heartbeat.status === "missing") return `missing heartbeat row; max age ${heartbeat.maxAgeMs}ms`;
  if (heartbeat.status === "active") {
    const activeAge = heartbeat.activeAgeMs === undefined ? "unknown" : `${heartbeat.activeAgeMs}ms`;
    return (
      `active; active age ${activeAge}; max ${heartbeat.activeMaxAgeMs ?? heartbeat.maxAgeMs}ms; ` +
      `started cycle ${heartbeat.activeCycle ?? "unknown"}; last event ${heartbeat.event ?? "unknown"}; ` +
      `last cycle ${heartbeat.cycle ?? "unknown"}`
    );
  }
  const age = heartbeat.ageMs === undefined ? "unknown" : `${heartbeat.ageMs}ms`;
  const activeSuffix = heartbeat.activeAgeMs === undefined
    ? ""
    : `; active age ${heartbeat.activeAgeMs}ms; active max ${heartbeat.activeMaxAgeMs ?? heartbeat.maxAgeMs}ms; active cycle ${heartbeat.activeCycle ?? "unknown"}`;
  return `${heartbeat.status}; age ${age}; max ${heartbeat.maxAgeMs}ms; event ${heartbeat.event ?? "unknown"}; cycle ${heartbeat.cycle ?? "unknown"}${activeSuffix}`;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
    return code === "EPERM";
  }
}

interface QueueCountRow {
  total?: number;
  queued?: number | null;
  leased?: number | null;
  running?: number | null;
  providerDeferred?: number | null;
  retryableProviderDeferred?: number | null;
  failed?: number | null;
}

interface ReviewBudgetQueueJobRow {
  job_id: string;
  attempt_id: string;
  source: ReviewQueueJobRecord["source"];
  lane: ReviewQueueJobRecord["lane"];
  repo: string;
  org: string;
  pull_number: number;
  head_sha: string;
  base_sha?: string | null;
  provider_id?: string | null;
  priority: number;
  state: ReviewQueueJobRecord["state"];
  next_eligible_at?: string | null;
  lease_id?: string | null;
  lease_expires_at?: string | null;
  session_id?: string | null;
  comment_id?: number | null;
  review_url?: string | null;
  last_error?: string | null;
  created_at: string;
  updated_at: string;
  started_at?: string | null;
  finished_at?: string | null;
}

function mapReviewBudgetQueueJobRow(row: ReviewBudgetQueueJobRow): ReviewQueueJobRecord {
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
    ...(row.comment_id !== null && row.comment_id !== undefined ? { commentId: row.comment_id } : {}),
    ...(row.review_url ? { reviewUrl: row.review_url } : {}),
    ...(row.last_error ? { lastError: row.last_error } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.started_at ? { startedAt: row.started_at } : {}),
    ...(row.finished_at ? { finishedAt: row.finished_at } : {})
  };
}
