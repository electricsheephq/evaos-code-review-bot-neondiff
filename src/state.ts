import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { redactSecrets } from "./secrets.js";
import type { ReviewEvent } from "./types.js";

export type ProcessedStatus = "dry_run" | "posted" | "skipped" | "failed";
export type ProcessedCommandAction = "review" | "re-review" | "explain" | "stop";
export type ProcessedCommandStatus = "triggered" | "explained" | "stopped" | "ignored";
export type ReviewerSessionState = "warming" | "active" | "draining" | "expired" | "failed";
export type ReviewerSessionJobState = "assigned" | "running" | "completed" | "skipped" | "failed";
export type ReviewerSessionAssignmentReason =
  | "same_repo_active_session"
  | "new_session"
  | "session_expired_new_session"
  | "manual_command_priority";

export interface ProcessedReviewRecord {
  repo: string;
  pullNumber: number;
  headSha: string;
  status: ProcessedStatus;
  event?: ReviewEvent;
  reviewUrl?: string;
  error?: string;
}

export interface StoredProcessedReviewRecord extends ProcessedReviewRecord {
  createdAt: string;
}

export interface RetireFailedReviewInput {
  repo: string;
  pullNumber: number;
  headSha: string;
  reason: string;
}

export interface ReviewRunLease {
  leaseId: string;
  expiresAt: string;
  ownerPid: number;
}

export interface ReviewerSessionRecord {
  sessionId: string;
  repo: string;
  repoFamily?: string;
  state: ReviewerSessionState;
  startedAt: string;
  lastUsedAt: string;
  expiresAt: string;
  headCountUsed: number;
  headCountLimit: number;
  workerPid?: number;
  model?: string;
  provider?: string;
  zcodeCliVersion?: string;
  memoryPacketSha?: string;
  gitnexusPacketSha?: string;
  lastError?: string;
}

export interface ReviewerSessionJobRecord {
  sessionId: string;
  repo: string;
  pullNumber: number;
  headSha: string;
  jobState: ReviewerSessionJobState;
  assignmentReason: ReviewerSessionAssignmentReason;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  processedReviewStatus?: ProcessedStatus;
}

export type ReviewerSessionAssignResult =
  | {
      assigned: true;
      session: ReviewerSessionRecord;
      job: ReviewerSessionJobRecord;
      assignmentReason: ReviewerSessionAssignmentReason;
    }
  | {
      assigned: false;
      reason: "already_processed" | "already_assigned";
      session?: ReviewerSessionRecord;
      job?: ReviewerSessionJobRecord;
    };

export interface RepoProviderCooldownRecord {
  repo: string;
  cooldownUntil: string;
  reason: string;
  updatedAt: string;
}

export const PROVIDER_COOLDOWN_ERROR_PREFIX = "provider_rate_limit_cooldown_until=";

export interface ParsedProviderCooldownError {
  cooldownUntil: string;
  reason?: string;
}

export interface ProviderCooldownReviewRecord extends StoredProcessedReviewRecord {
  cooldownUntil: string;
  reason?: string;
  expired: boolean;
}

export type DaemonHeartbeatEvent = "daemon_cycle_start" | "daemon_cycle_complete" | "daemon_cycle_failed";

export interface DaemonHeartbeatRecord {
  cycle: number;
  event: DaemonHeartbeatEvent;
  dryRun: boolean;
  recordedAt?: Date;
  error?: string;
}

export interface StoredDaemonHeartbeatRecord {
  cycle: number;
  event: DaemonHeartbeatEvent;
  dryRun: boolean;
  recordedAt: string;
  error?: string;
  startedCycle?: number;
  startedAt?: string;
}

export interface ProcessedCommandRecord {
  repo: string;
  pullNumber: number;
  headSha: string;
  commentId: number;
  action: ProcessedCommandAction;
  status: ProcessedCommandStatus;
  author?: string;
  url?: string;
}

export class ReviewStateStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("pragma foreign_keys = on");
    this.db.exec(`
      create table if not exists processed_reviews (
        repo text not null,
        pull_number integer not null,
        head_sha text not null,
        status text not null,
        event text,
        review_url text,
        error text,
        created_at text not null default (datetime('now')),
        primary key (repo, pull_number, head_sha)
      );

      create table if not exists repo_activation_watermarks (
        repo text primary key,
        activated_at text not null,
        created_at text not null default (datetime('now'))
      );

      create table if not exists review_run_leases (
        lease_id text primary key,
        started_at text not null,
        expires_at text not null,
        owner_pid integer
      );

      create table if not exists repo_provider_cooldowns (
        repo text primary key,
        cooldown_until text not null,
        reason text not null,
        updated_at text not null default (datetime('now'))
      );

      create table if not exists daemon_heartbeat (
        id integer primary key check (id = 1),
        cycle integer,
        event text,
        dry_run integer,
        recorded_at text,
        error text
      );

      create table if not exists reviewer_sessions (
        session_id text primary key,
        repo text not null,
        repo_family text,
        state text not null,
        started_at text not null,
        last_used_at text not null,
        expires_at text not null,
        head_count_used integer not null,
        head_count_limit integer not null,
        worker_pid integer,
        model text,
        provider text,
        zcode_cli_version text,
        memory_packet_sha text,
        gitnexus_packet_sha text,
        last_error text
      );

      create table if not exists reviewer_session_jobs (
        session_id text not null,
        repo text not null,
        pull_number integer not null,
        head_sha text not null,
        job_state text not null,
        assignment_reason text not null,
        created_at text not null,
        started_at text,
        finished_at text,
        processed_review_status text,
        primary key (repo, pull_number, head_sha),
        foreign key (session_id) references reviewer_sessions(session_id)
      );
    `);
    this.ensureDaemonHeartbeatColumns();
    this.ensureReviewRunLeaseColumns();
    this.db.exec(`
      create table if not exists processed_commands (
        repo text not null,
        pull_number integer not null,
        head_sha text not null,
        comment_id integer not null,
        action text not null,
        status text not null,
        author text,
        url text,
        created_at text not null default (datetime('now')),
        primary key (repo, pull_number, head_sha, comment_id)
      );
    `);
  }

  hasProcessed(repo: string, pullNumber: number, headSha: string): boolean {
    const row = this.db
      .prepare("select 1 from processed_reviews where repo = ? and pull_number = ? and head_sha = ? limit 1")
      .get(repo, pullNumber, headSha);
    return Boolean(row);
  }

  getProcessedReview(repo: string, pullNumber: number, headSha: string): StoredProcessedReviewRecord | undefined {
    const row = this.db
      .prepare(
        `select repo, pull_number, head_sha, status, event, review_url, error, created_at
         from processed_reviews
         where repo = ? and pull_number = ? and head_sha = ?
         limit 1`
      )
      .get(repo, pullNumber, headSha) as ProcessedReviewRow | undefined;
    return row ? mapProcessedReviewRow(row) : undefined;
  }

  listProcessedReviewsForPull(repo: string, pullNumber: number): StoredProcessedReviewRecord[] {
    const rows = this.db
      .prepare(
        `select repo, pull_number, head_sha, status, event, review_url, error, created_at
         from processed_reviews
         where repo = ? and pull_number = ?
         order by datetime(created_at) desc`
      )
      .all(repo, pullNumber) as unknown as ProcessedReviewRow[];
    return rows.map(mapProcessedReviewRow);
  }

  recordProcessed(record: ProcessedReviewRecord): void {
    this.db
      .prepare(
        `insert or replace into processed_reviews
          (repo, pull_number, head_sha, status, event, review_url, error, created_at)
         values (?, ?, ?, ?, ?, ?, ?, datetime('now'))`
      )
      .run(
        record.repo,
        record.pullNumber,
        record.headSha,
        record.status,
        record.event ?? null,
        record.reviewUrl ?? null,
        record.error ?? null
      );
  }

  retireFailedReview(input: RetireFailedReviewInput): StoredProcessedReviewRecord {
    const existing = this.getProcessedReview(input.repo, input.pullNumber, input.headSha);
    if (!existing) {
      throw new Error(`Refusing to retire missing review row for ${input.repo}#${input.pullNumber}@${input.headSha}`);
    }
    if (existing.status !== "failed") {
      throw new Error(
        `Refusing to retire ${input.repo}#${input.pullNumber}@${input.headSha}: status is ${existing.status}, not failed`
      );
    }

    const reason = normalizeRetirementReason(input.reason);
    const previousError = existing.error ? `; previous_error=${redactSecrets(existing.error)}` : "";
    this.recordProcessed({
      repo: input.repo,
      pullNumber: input.pullNumber,
      headSha: input.headSha,
      status: "skipped",
      error: `retired_failed_head:${reason}${previousError}`
    });
    return this.getProcessedReview(input.repo, input.pullNumber, input.headSha)!;
  }

  hasRepoActivation(repo: string): boolean {
    const row = this.db.prepare("select 1 from repo_activation_watermarks where repo = ? limit 1").get(repo);
    return Boolean(row);
  }

  recordRepoActivation(repo: string, activatedAt = new Date().toISOString()): void {
    this.db
      .prepare(
        `insert or ignore into repo_activation_watermarks
          (repo, activated_at, created_at)
         values (?, ?, datetime('now'))`
      )
      .run(repo, activatedAt);
  }

  tryAcquireReviewRunLease(
    maxActiveRuns: number,
    leaseTtlMs: number,
    now = new Date(),
    ownerPid = process.pid
  ): ReviewRunLease | undefined {
    if (!Number.isInteger(maxActiveRuns)) throw new Error("maxActiveRuns must be an integer");
    if (maxActiveRuns < 1) throw new Error("maxActiveRuns must be at least 1");
    if (!Number.isInteger(leaseTtlMs)) throw new Error("leaseTtlMs must be an integer");
    if (leaseTtlMs < 1) throw new Error("leaseTtlMs must be at least 1");
    if (!Number.isInteger(ownerPid) || ownerPid < 1) throw new Error("ownerPid must be a positive integer");

    const leaseId = randomUUID();
    const startedAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + leaseTtlMs).toISOString();
    this.db.exec("begin immediate");
    try {
      this.db.prepare("delete from review_run_leases where expires_at <= ?").run(startedAt);
      this.pruneInactiveReviewRunLeases();
      const row = this.db.prepare("select count(*) as count from review_run_leases").get() as { count: number };
      if (row.count >= maxActiveRuns) {
        this.db.exec("commit");
        return undefined;
      }
      this.db
        .prepare("insert into review_run_leases (lease_id, started_at, expires_at, owner_pid) values (?, ?, ?, ?)")
        .run(leaseId, startedAt, expiresAt, ownerPid);
      this.db.exec("commit");
      return { leaseId, expiresAt, ownerPid };
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
  }

  releaseReviewRunLease(leaseId: string): void {
    this.db.prepare("delete from review_run_leases where lease_id = ?").run(leaseId);
  }

  assignReviewerSessionJob(input: {
    repo: string;
    pullNumber: number;
    headSha: string;
    ttlMs: number;
    headCountLimit: number;
    now?: Date;
    workerPid?: number;
    model?: string;
    provider?: string;
    zcodeCliVersion?: string;
    repoFamily?: string;
    assignmentReason?: ReviewerSessionAssignmentReason;
  }): ReviewerSessionAssignResult {
    validateReviewerSessionInput(input.ttlMs, input.headCountLimit, input.workerPid);

    const now = input.now ?? new Date();
    const nowIso = now.toISOString();
    const expiresAt = new Date(now.getTime() + input.ttlMs).toISOString();
    const workerPid = input.workerPid ?? process.pid;
    let assignmentReason = input.assignmentReason;
    let session: ReviewerSessionRecord | undefined;
    let assignedJob: ReviewerSessionJobRecord | undefined;

    this.db.exec("begin immediate");
    try {
      if (this.hasProcessed(input.repo, input.pullNumber, input.headSha)) {
        this.db.exec("commit");
        return { assigned: false, reason: "already_processed" };
      }

      const existingJob = this.getReviewerSessionJob(input.repo, input.pullNumber, input.headSha);
      if (existingJob) {
        const result: ReviewerSessionAssignResult = {
          assigned: false,
          reason: "already_assigned",
          session: this.getReviewerSession(existingJob.sessionId),
          job: existingJob
        };
        this.db.exec("commit");
        return result;
      }

      const hadPreviousRepoSession = this.hasReviewerSessionForRepo(input.repo);
      const expiredRepoSessions = this.expireReviewerSessions(now, input.repo);
      session = this.getReusableReviewerSession(input.repo, now);
      if (!session) {
        session = this.createReviewerSession({
          repo: input.repo,
          repoFamily: input.repoFamily,
          state: "active",
          startedAt: nowIso,
          lastUsedAt: nowIso,
          expiresAt,
          headCountUsed: 0,
          headCountLimit: input.headCountLimit,
          workerPid,
          model: input.model,
          provider: input.provider,
          zcodeCliVersion: input.zcodeCliVersion
        });
        assignmentReason =
          assignmentReason ?? (hadPreviousRepoSession || expiredRepoSessions > 0 ? "session_expired_new_session" : "new_session");
      } else {
        assignmentReason = assignmentReason ?? "same_repo_active_session";
      }

      this.db
        .prepare(
          `insert into reviewer_session_jobs
            (session_id, repo, pull_number, head_sha, job_state, assignment_reason, created_at)
           values (?, ?, ?, ?, 'assigned', ?, ?)`
        )
        .run(session.sessionId, input.repo, input.pullNumber, input.headSha, assignmentReason, nowIso);

      const nextHeadCount = session.headCountUsed + 1;
      const nextState: ReviewerSessionState = nextHeadCount >= session.headCountLimit ? "expired" : "active";
      this.db
        .prepare(
          `update reviewer_sessions
           set head_count_used = ?, last_used_at = ?, state = ?
           where session_id = ?`
        )
        .run(nextHeadCount, nowIso, nextState, session.sessionId);
      assignedJob = this.getReviewerSessionJob(input.repo, input.pullNumber, input.headSha)!;
      this.db.exec("commit");
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }

    return {
      assigned: true,
      session: this.getReviewerSession(assignedJob!.sessionId)!,
      job: assignedJob!,
      assignmentReason: assignedJob!.assignmentReason
    };
  }

  getReviewerSession(sessionId: string): ReviewerSessionRecord | undefined {
    const row = this.db
      .prepare(
        `select session_id, repo, repo_family, state, started_at, last_used_at, expires_at,
                head_count_used, head_count_limit, worker_pid, model, provider, zcode_cli_version,
                memory_packet_sha, gitnexus_packet_sha, last_error
         from reviewer_sessions
         where session_id = ?
         limit 1`
      )
      .get(sessionId) as ReviewerSessionRow | undefined;
    return row ? mapReviewerSessionRow(row) : undefined;
  }

  getReviewerSessionJob(repo: string, pullNumber: number, headSha: string): ReviewerSessionJobRecord | undefined {
    const row = this.db
      .prepare(
        `select session_id, repo, pull_number, head_sha, job_state, assignment_reason,
                created_at, started_at, finished_at, processed_review_status
         from reviewer_session_jobs
         where repo = ? and pull_number = ? and head_sha = ?
         limit 1`
      )
      .get(repo, pullNumber, headSha) as ReviewerSessionJobRow | undefined;
    return row ? mapReviewerSessionJobRow(row) : undefined;
  }

  listReviewerSessions(input: {
    repo?: string;
    state?: ReviewerSessionState;
    activeOnly?: boolean;
    now?: Date;
  } = {}): ReviewerSessionRecord[] {
    const nowMs = (input.now ?? new Date()).getTime();
    const rows = (input.repo
      ? this.db
          .prepare(
            `select session_id, repo, repo_family, state, started_at, last_used_at, expires_at,
                    head_count_used, head_count_limit, worker_pid, model, provider, zcode_cli_version,
                    memory_packet_sha, gitnexus_packet_sha, last_error
             from reviewer_sessions
             where repo = ?
             order by datetime(last_used_at) desc`
          )
          .all(input.repo)
      : this.db
          .prepare(
            `select session_id, repo, repo_family, state, started_at, last_used_at, expires_at,
                    head_count_used, head_count_limit, worker_pid, model, provider, zcode_cli_version,
                    memory_packet_sha, gitnexus_packet_sha, last_error
             from reviewer_sessions
             order by datetime(last_used_at) desc`
          )
          .all()) as unknown as ReviewerSessionRow[];
    return rows
      .map(mapReviewerSessionRow)
      .filter((session) => !input.state || session.state === input.state)
      .filter((session) => {
        if (!input.activeOnly) return true;
        const expiresAtMs = Date.parse(session.expiresAt);
        return (
          (session.state === "active" || session.state === "warming") &&
          Number.isFinite(expiresAtMs) &&
          expiresAtMs > nowMs &&
          session.headCountUsed < session.headCountLimit
        );
      });
  }

  updateReviewerSessionJobState(input: {
    repo: string;
    pullNumber: number;
    headSha: string;
    jobState: ReviewerSessionJobState;
    processedReviewStatus?: ProcessedStatus;
    now?: Date;
  }): ReviewerSessionJobRecord {
    const existing = this.getReviewerSessionJob(input.repo, input.pullNumber, input.headSha);
    if (!existing) {
      throw new Error(`No reviewer session job for ${input.repo}#${input.pullNumber}@${input.headSha}`);
    }
    const timestamp = (input.now ?? new Date()).toISOString();
    this.db
      .prepare(
        `update reviewer_session_jobs
         set job_state = ?,
             started_at = case when ? = 'running' and started_at is null then ? else started_at end,
             finished_at = case when ? in ('completed', 'skipped', 'failed') then ? else finished_at end,
             processed_review_status = coalesce(?, processed_review_status)
         where repo = ? and pull_number = ? and head_sha = ?`
      )
      .run(
        input.jobState,
        input.jobState,
        timestamp,
        input.jobState,
        timestamp,
        input.processedReviewStatus ?? null,
        input.repo,
        input.pullNumber,
        input.headSha
      );
    return this.getReviewerSessionJob(input.repo, input.pullNumber, input.headSha)!;
  }

  expireReviewerSessions(now = new Date(), repo?: string): number {
    const nowIso = now.toISOString();
    const result = repo
      ? this.db
          .prepare(
            `update reviewer_sessions
             set state = 'expired'
             where repo = ?
               and state in ('warming', 'active')
               and (expires_at <= ? or head_count_used >= head_count_limit)`
          )
          .run(repo, nowIso)
      : this.db
          .prepare(
            `update reviewer_sessions
             set state = 'expired'
             where state in ('warming', 'active')
               and (expires_at <= ? or head_count_used >= head_count_limit)`
          )
          .run(nowIso);
    return Number(result.changes);
  }

  private pruneInactiveReviewRunLeases(): void {
    const rows = this.db
      .prepare("select lease_id, owner_pid from review_run_leases")
      .all() as unknown as Array<{ lease_id: string; owner_pid: number | null }>;
    for (const row of rows) {
      if (row.owner_pid === null || !isProcessAlive(row.owner_pid)) {
        this.db.prepare("delete from review_run_leases where lease_id = ?").run(row.lease_id);
      }
    }
  }

  private createReviewerSession(input: {
    repo: string;
    repoFamily?: string;
    state: ReviewerSessionState;
    startedAt: string;
    lastUsedAt: string;
    expiresAt: string;
    headCountUsed: number;
    headCountLimit: number;
    workerPid?: number;
    model?: string;
    provider?: string;
    zcodeCliVersion?: string;
  }): ReviewerSessionRecord {
    const sessionId = randomUUID();
    this.db
      .prepare(
        `insert into reviewer_sessions
          (session_id, repo, repo_family, state, started_at, last_used_at, expires_at,
           head_count_used, head_count_limit, worker_pid, model, provider, zcode_cli_version)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        sessionId,
        input.repo,
        input.repoFamily ?? null,
        input.state,
        input.startedAt,
        input.lastUsedAt,
        input.expiresAt,
        input.headCountUsed,
        input.headCountLimit,
        input.workerPid ?? null,
        input.model ?? null,
        input.provider ?? null,
        input.zcodeCliVersion ?? null
      );
    return this.getReviewerSession(sessionId)!;
  }

  private getReusableReviewerSession(repo: string, now = new Date()): ReviewerSessionRecord | undefined {
    const nowIso = now.toISOString();
    const row = this.db
      .prepare(
        `select session_id, repo, repo_family, state, started_at, last_used_at, expires_at,
                head_count_used, head_count_limit, worker_pid, model, provider, zcode_cli_version,
                memory_packet_sha, gitnexus_packet_sha, last_error
         from reviewer_sessions
         where repo = ?
           and state in ('warming', 'active')
           and expires_at > ?
           and head_count_used < head_count_limit
         order by datetime(last_used_at) desc
         limit 1`
      )
      .get(repo, nowIso) as ReviewerSessionRow | undefined;
    return row ? mapReviewerSessionRow(row) : undefined;
  }

  private hasReviewerSessionForRepo(repo: string): boolean {
    const row = this.db.prepare("select 1 from reviewer_sessions where repo = ? limit 1").get(repo);
    return Boolean(row);
  }

  recordRepoProviderCooldown(input: { repo: string; cooldownUntil: Date; reason: string }): RepoProviderCooldownRecord {
    this.db
      .prepare(
        `insert into repo_provider_cooldowns (repo, cooldown_until, reason, updated_at)
         values (?, ?, ?, datetime('now'))
         on conflict(repo) do update set
           cooldown_until = excluded.cooldown_until,
           reason = excluded.reason,
           updated_at = datetime('now')`
      )
      .run(input.repo, input.cooldownUntil.toISOString(), redactSecrets(input.reason));
    return this.getRepoProviderCooldown(input.repo)!;
  }

  getRepoProviderCooldown(repo: string): RepoProviderCooldownRecord | undefined {
    const row = this.db
      .prepare(
        `select repo, cooldown_until, reason, updated_at
         from repo_provider_cooldowns
         where repo = ?
         limit 1`
      )
      .get(repo) as RepoProviderCooldownRow | undefined;
    return row ? mapRepoProviderCooldownRow(row) : undefined;
  }

  getActiveRepoProviderCooldown(repo: string, now = new Date()): RepoProviderCooldownRecord | undefined {
    const cooldown = this.getRepoProviderCooldown(repo);
    if (!cooldown) return undefined;
    const cooldownUntil = Date.parse(cooldown.cooldownUntil);
    if (!Number.isFinite(cooldownUntil) || cooldownUntil <= now.getTime()) return undefined;
    return cooldown;
  }

  getActiveProviderCooldown(now = new Date()): RepoProviderCooldownRecord | undefined {
    return this.listRepoProviderCooldowns({ activeOnly: true, now })[0];
  }

  listRepoProviderCooldowns(input: { activeOnly?: boolean; now?: Date } = {}): RepoProviderCooldownRecord[] {
    const now = input.now ?? new Date();
    const rows = this.db
      .prepare(
        `select repo, cooldown_until, reason, updated_at
         from repo_provider_cooldowns
         order by datetime(cooldown_until) desc`
      )
      .all() as unknown as RepoProviderCooldownRow[];
    const cooldowns = rows.map(mapRepoProviderCooldownRow);
    if (!input.activeOnly) return cooldowns;
    return cooldowns.filter((cooldown) => {
      const cooldownUntilMs = Date.parse(cooldown.cooldownUntil);
      return Number.isFinite(cooldownUntilMs) && cooldownUntilMs > now.getTime();
    });
  }

  listProviderCooldownReviews(input: {
    repo?: string;
    now?: Date;
    expiredOnly?: boolean;
    limit?: number;
  } = {}): ProviderCooldownReviewRecord[] {
    if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1)) {
      throw new Error("limit must be a positive integer");
    }

    const now = input.now ?? new Date();
    const rows = (input.repo
      ? this.db
          .prepare(
            `select repo, pull_number, head_sha, status, event, review_url, error, created_at
             from processed_reviews
             where repo = ? and status = 'skipped' and error like ?
             order by datetime(created_at) asc`
          )
          .all(input.repo, `${PROVIDER_COOLDOWN_ERROR_PREFIX}%`)
      : this.db
          .prepare(
            `select repo, pull_number, head_sha, status, event, review_url, error, created_at
             from processed_reviews
             where status = 'skipped' and error like ?
             order by datetime(created_at) asc`
          )
          .all(`${PROVIDER_COOLDOWN_ERROR_PREFIX}%`)) as unknown as ProcessedReviewRow[];

    const mapped = rows
      .map((row) => {
        const record = mapProcessedReviewRow(row);
        const parsed = parseProviderCooldownError(record.error);
        if (!parsed) return undefined;
        const cooldownUntilMs = Date.parse(parsed.cooldownUntil);
        const expired = !Number.isFinite(cooldownUntilMs) || cooldownUntilMs <= now.getTime();
        return {
          ...record,
          cooldownUntil: parsed.cooldownUntil,
          ...(parsed.reason ? { reason: parsed.reason } : {}),
          expired
        };
      })
      .filter((record): record is ProviderCooldownReviewRecord => Boolean(record))
      .filter((record) => !input.expiredOnly || record.expired);

    return input.limit ? mapped.slice(0, input.limit) : mapped;
  }

  recordDaemonHeartbeat(record: DaemonHeartbeatRecord): void {
    if (record.event === "daemon_cycle_start") {
      this.db
        .prepare(
          `insert into daemon_heartbeat
            (id, started_cycle, started_at)
           values (1, ?, ?)
           on conflict(id) do update set
             started_cycle = excluded.started_cycle,
             started_at = excluded.started_at`
        )
        .run(record.cycle, (record.recordedAt ?? new Date()).toISOString());
      return;
    }

    this.db
      .prepare(
        `insert or replace into daemon_heartbeat
          (id, cycle, event, dry_run, recorded_at, error, started_cycle, started_at)
         values (
           1, ?, ?, ?, ?, ?,
           coalesce((select started_cycle from daemon_heartbeat where id = 1), ?),
           coalesce((select started_at from daemon_heartbeat where id = 1), ?)
         )`
      )
      .run(
        record.cycle,
        record.event,
        record.dryRun ? 1 : 0,
        (record.recordedAt ?? new Date()).toISOString(),
        record.error ? redactSecrets(record.error) : null,
        record.cycle,
        (record.recordedAt ?? new Date()).toISOString()
      );
  }

  getDaemonHeartbeat(): StoredDaemonHeartbeatRecord | undefined {
    const row = this.db
      .prepare(
        `select cycle, event, dry_run, recorded_at, error, started_cycle, started_at
         from daemon_heartbeat
         where id = 1 and recorded_at is not null
         limit 1`
      )
      .get() as DaemonHeartbeatRow | undefined;
    return row ? mapDaemonHeartbeatRow(row) : undefined;
  }

  hasProcessedCommand(repo: string, pullNumber: number, headSha: string, commentId: number): boolean {
    const row = this.db
      .prepare(
        `select 1 from processed_commands
         where repo = ? and pull_number = ? and head_sha = ? and comment_id = ?
         limit 1`
      )
      .get(repo, pullNumber, headSha, commentId);
    return Boolean(row);
  }

  recordProcessedCommand(record: ProcessedCommandRecord): void {
    this.db
      .prepare(
        `insert or replace into processed_commands
          (repo, pull_number, head_sha, comment_id, action, status, author, url, created_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
      )
      .run(
        record.repo,
        record.pullNumber,
        record.headSha,
        record.commentId,
        record.action,
        record.status,
        record.author ?? null,
        record.url ?? null
      );
  }

  close(): void {
    this.db.close();
  }

  private ensureDaemonHeartbeatColumns(): void {
    const columns = this.db
      .prepare("pragma table_info(daemon_heartbeat)")
      .all() as unknown as Array<{ name: string }>;
    const names = new Set(columns.map((column) => column.name));
    if (!names.has("started_cycle")) {
      this.db.exec("alter table daemon_heartbeat add column started_cycle integer");
    }
    if (!names.has("started_at")) {
      this.db.exec("alter table daemon_heartbeat add column started_at text");
    }
  }

  private ensureReviewRunLeaseColumns(): void {
    const columns = this.db.prepare("pragma table_info(review_run_leases)").all() as unknown as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "owner_pid")) {
      this.db.exec("alter table review_run_leases add column owner_pid integer");
    }
  }
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

function normalizeRetirementReason(reason: string): string {
  const normalized = reason
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9._-]+/g, "_")
    .replaceAll(/^_+|_+$/g, "")
    .slice(0, 80);
  return normalized || "operator_acknowledged";
}

function validateReviewerSessionInput(ttlMs: number, headCountLimit: number, workerPid?: number): void {
  if (!Number.isInteger(ttlMs)) throw new Error("ttlMs must be an integer");
  if (ttlMs < 1) throw new Error("ttlMs must be at least 1");
  if (!Number.isInteger(headCountLimit)) throw new Error("headCountLimit must be an integer");
  if (headCountLimit < 1) throw new Error("headCountLimit must be at least 1");
  if (workerPid !== undefined && (!Number.isInteger(workerPid) || workerPid < 1)) {
    throw new Error("workerPid must be a positive integer");
  }
}

export function parseProviderCooldownError(error?: string): ParsedProviderCooldownError | undefined {
  if (!error?.startsWith(PROVIDER_COOLDOWN_ERROR_PREFIX)) return undefined;
  const [cooldownPart, ...rest] = error.split(";");
  const cooldownUntil = cooldownPart?.slice(PROVIDER_COOLDOWN_ERROR_PREFIX.length).trim();
  if (!cooldownUntil) return undefined;
  const reasonPart = rest.map((part) => part.trim()).find((part) => part.startsWith("reason="));
  const reason = reasonPart?.slice("reason=".length).trim();
  return {
    cooldownUntil,
    ...(reason ? { reason } : {})
  };
}

interface ProcessedReviewRow {
  repo: string;
  pull_number: number;
  head_sha: string;
  status: ProcessedStatus;
  event: ReviewEvent | null;
  review_url: string | null;
  error: string | null;
  created_at: string;
}

interface DaemonHeartbeatRow {
  cycle: number | null;
  event: DaemonHeartbeatEvent | null;
  dry_run: number | null;
  recorded_at: string | null;
  error: string | null;
  started_cycle: number | null;
  started_at: string | null;
}

interface RepoProviderCooldownRow {
  repo: string;
  cooldown_until: string;
  reason: string;
  updated_at: string;
}

interface ReviewerSessionRow {
  session_id: string;
  repo: string;
  repo_family: string | null;
  state: ReviewerSessionState;
  started_at: string;
  last_used_at: string;
  expires_at: string;
  head_count_used: number;
  head_count_limit: number;
  worker_pid: number | null;
  model: string | null;
  provider: string | null;
  zcode_cli_version: string | null;
  memory_packet_sha: string | null;
  gitnexus_packet_sha: string | null;
  last_error: string | null;
}

interface ReviewerSessionJobRow {
  session_id: string;
  repo: string;
  pull_number: number;
  head_sha: string;
  job_state: ReviewerSessionJobState;
  assignment_reason: ReviewerSessionAssignmentReason;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  processed_review_status: ProcessedStatus | null;
}

function mapProcessedReviewRow(row: ProcessedReviewRow): StoredProcessedReviewRecord {
  return {
    repo: row.repo,
    pullNumber: row.pull_number,
    headSha: row.head_sha,
    status: row.status,
    ...(row.event ? { event: row.event } : {}),
    ...(row.review_url ? { reviewUrl: row.review_url } : {}),
    ...(row.error ? { error: row.error } : {}),
    createdAt: row.created_at
  };
}

function mapRepoProviderCooldownRow(row: RepoProviderCooldownRow): RepoProviderCooldownRecord {
  return {
    repo: row.repo,
    cooldownUntil: row.cooldown_until,
    reason: row.reason,
    updatedAt: row.updated_at
  };
}

function mapReviewerSessionRow(row: ReviewerSessionRow): ReviewerSessionRecord {
  return {
    sessionId: row.session_id,
    repo: row.repo,
    ...(row.repo_family ? { repoFamily: row.repo_family } : {}),
    state: row.state,
    startedAt: row.started_at,
    lastUsedAt: row.last_used_at,
    expiresAt: row.expires_at,
    headCountUsed: row.head_count_used,
    headCountLimit: row.head_count_limit,
    ...(row.worker_pid ? { workerPid: row.worker_pid } : {}),
    ...(row.model ? { model: row.model } : {}),
    ...(row.provider ? { provider: row.provider } : {}),
    ...(row.zcode_cli_version ? { zcodeCliVersion: row.zcode_cli_version } : {}),
    ...(row.memory_packet_sha ? { memoryPacketSha: row.memory_packet_sha } : {}),
    ...(row.gitnexus_packet_sha ? { gitnexusPacketSha: row.gitnexus_packet_sha } : {}),
    ...(row.last_error ? { lastError: row.last_error } : {})
  };
}

function mapReviewerSessionJobRow(row: ReviewerSessionJobRow): ReviewerSessionJobRecord {
  return {
    sessionId: row.session_id,
    repo: row.repo,
    pullNumber: row.pull_number,
    headSha: row.head_sha,
    jobState: row.job_state,
    assignmentReason: row.assignment_reason,
    createdAt: row.created_at,
    ...(row.started_at ? { startedAt: row.started_at } : {}),
    ...(row.finished_at ? { finishedAt: row.finished_at } : {}),
    ...(row.processed_review_status ? { processedReviewStatus: row.processed_review_status } : {})
  };
}

function mapDaemonHeartbeatRow(row: DaemonHeartbeatRow): StoredDaemonHeartbeatRecord {
  return {
    cycle: row.cycle!,
    event: row.event!,
    dryRun: row.dry_run === 1,
    recordedAt: row.recorded_at!,
    ...(row.error ? { error: row.error } : {}),
    ...(row.started_cycle !== null ? { startedCycle: row.started_cycle } : {}),
    ...(row.started_at ? { startedAt: row.started_at } : {})
  };
}
