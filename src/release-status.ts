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
  const retryableDeferredQueueJobsOk = (input.database.retryableProviderDeferredReviewQueueJobCount ?? 0) === 0;
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
      name: "queue_no_retryable_provider_deferred_jobs",
      ok: retryableDeferredQueueJobsOk,
      detail:
        `${input.database.retryableProviderDeferredReviewQueueJobCount ?? 0} retryable provider-deferred queue job(s)` +
        describeReviewQueueCounts(input.database)
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
    ...(input.budget ? { budget: input.budget } : {}),
    recommendedActions: expiredProviderCooldownOk
      ? retryableDeferredQueueJobsOk
        ? []
        : ["inspect operator queue and retry provider-deferred jobs whose nextEligibleAt has expired"]
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
    database: readDatabaseStatus(statePath, now),
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
      : countExpiredProviderCooldownsCoveredByActiveQueueRetry(db, expiredProviderCooldowns, now);
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

function readReviewerSessionCounts(
  db: DatabaseSync,
  now: Date
): { total: number; active: number; expired: number; byRepo: ReviewerSessionRepoStatus[] } {
  const hasTable = db
    .prepare("select 1 from sqlite_master where type = 'table' and name = 'reviewer_sessions' limit 1")
    .get();
  if (!hasTable) return { total: 0, active: 0, expired: 0, byRepo: [] };
  const activeSql = `
    state in ('active', 'warming')
    and datetime(expires_at) > datetime(?)
    and head_count_used < head_count_limit
  `;
  const expiredSql = `
    state = 'expired'
    or datetime(expires_at) is null
    or datetime(expires_at) <= datetime(?)
    or head_count_used >= head_count_limit
  `;
  const row = db
    .prepare(
      `select
         count(*) as total,
         sum(case when ${activeSql} then 1 else 0 end) as active,
         sum(case when ${expiredSql} then 1 else 0 end) as expired
       from reviewer_sessions`
    )
    .get(now.toISOString(), now.toISOString()) as { total?: number; active?: number | null; expired?: number | null };
  const byRepoRows = db
    .prepare(
      `select
         repo,
         count(*) as total,
         sum(case when ${activeSql} then 1 else 0 end) as active,
         sum(case when ${expiredSql} then 1 else 0 end) as expired
       from reviewer_sessions
       group by repo
       order by repo`
    )
    .all(now.toISOString(), now.toISOString()) as unknown as Array<{
      repo: string;
      total?: number;
      active?: number | null;
      expired?: number | null;
    }>;
  return {
    total: row.total ?? 0,
    active: row.active ?? 0,
    expired: row.expired ?? 0,
    byRepo: byRepoRows.map((repoRow) => ({
      repo: repoRow.repo,
      total: repoRow.total ?? 0,
      active: repoRow.active ?? 0,
      expired: repoRow.expired ?? 0
    }))
  };
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
  now: Date
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
  if (!columns.has("repo") || !columns.has("pull_number") || !columns.has("head_sha") || !columns.has("state")) {
    return 0;
  }
  const hasLeaseExpiresAt = columns.has("lease_expires_at");
  const leaseClause = hasLeaseExpiresAt
    ? "and (lease_expires_at is null or datetime(lease_expires_at) > datetime(?))"
    : "";
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
  return cooldowns.filter((cooldown) => {
    const cooldownUntilMs = Date.parse(cooldown.cooldownUntil);
    if (!Number.isFinite(cooldownUntilMs) || cooldownUntilMs > now.getTime()) return false;
    const row = hasLeaseExpiresAt
      ? query.get(cooldown.repo, cooldown.pullNumber, cooldown.headSha, nowIso)
      : query.get(cooldown.repo, cooldown.pullNumber, cooldown.headSha);
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
