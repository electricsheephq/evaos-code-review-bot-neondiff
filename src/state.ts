import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { containsSecretLikeText, redactSecrets } from "./secrets.js";
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
export type ReviewQueueJobSource = "automatic" | "manual_command";
export type ReviewQueueJobLane = "background" | "manual";
export type ReviewQueueJobState =
  | "queued"
  | "leased"
  | "running"
  | "provider_deferred"
  | "stale_retired"
  | "closed_retired"
  | "command_recorded"
  | "posted"
  | "failed";
export type ReviewReadinessState =
  | "queued"
  | "reviewing"
  | "needs_fix"
  | "awaiting_re_review"
  | "blocked_on_checks"
  | "blocked_on_proof"
  | "ready_for_human"
  | "provider_deferred"
  | "stale"
  | "closed"
  | "command_recorded"
  | "skipped"
  | "failed";
export type RepoMemoryNoteKind =
  | "policy_note"
  | "machine_fact"
  | "false_positive"
  | "review_outcome"
  | "proof_preference";

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

export interface ReviewQueueJobRecord {
  jobId: string;
  attemptId: string;
  source: ReviewQueueJobSource;
  lane: ReviewQueueJobLane;
  repo: string;
  org: string;
  pullNumber: number;
  headSha: string;
  baseSha?: string;
  providerId?: string;
  priority: number;
  state: ReviewQueueJobState;
  nextEligibleAt?: string;
  leaseId?: string;
  leaseExpiresAt?: string;
  sessionId?: string;
  commentId?: number;
  reviewUrl?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface ReviewReadinessRecord {
  repo: string;
  pullNumber: number;
  headSha: string;
  state: ReviewReadinessState;
  reason?: string;
  event?: ReviewEvent;
  reviewUrl?: string;
  commandAction?: ProcessedCommandAction;
  commandCommentId?: number;
  createdAt: string;
  updatedAt: string;
}

export type ReviewQueueEnqueueResult =
  | { enqueued: true; job: ReviewQueueJobRecord }
  | { enqueued: false; reason: "already_queued"; job: ReviewQueueJobRecord };

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

export interface RepoMemoryNoteRecord {
  noteId: string;
  repo: string;
  kind: RepoMemoryNoteKind;
  title: string;
  body: string;
  source: string;
  confidence?: number;
  fingerprint?: string;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
}

export interface RecordRepoMemoryNoteInput {
  noteId: string;
  repo: string;
  kind: RepoMemoryNoteKind;
  title: string;
  body: string;
  source: string;
  confidence?: number;
  fingerprint?: string;
  expiresAt?: string;
  now?: Date;
}

export interface RepoMemoryPacketBuildRecord {
  packetSha: string;
  repo: string;
  packetVersion: string;
  generatedAt: string;
  byteEstimate: number;
  tokenEstimate: number;
  includedNoteIds: string[];
  redactionStatus: string;
  memoryRoot?: string;
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

      create table if not exists review_queue_jobs (
        job_id text primary key,
        attempt_id text not null unique,
        source text not null,
        lane text not null,
        repo text not null,
        org text not null,
        pull_number integer not null,
        head_sha text not null,
        base_sha text,
        provider_id text,
        priority integer not null,
        state text not null,
        next_eligible_at text,
        lease_id text,
        lease_expires_at text,
        session_id text,
        comment_id integer,
        review_url text,
        last_error text,
        created_at text not null,
        updated_at text not null,
        started_at text,
        finished_at text
      );

      create index if not exists idx_review_queue_jobs_state_priority
        on review_queue_jobs (state, priority, created_at);
      create index if not exists idx_review_queue_jobs_repo_state
        on review_queue_jobs (repo, state);
      create index if not exists idx_review_queue_jobs_repo_pull_state
        on review_queue_jobs (repo, pull_number, state);
      create index if not exists idx_review_queue_jobs_provider_state
        on review_queue_jobs (provider_id, state);

      create table if not exists review_readiness (
        repo text not null,
        pull_number integer not null,
        head_sha text not null,
        state text not null,
        reason text,
        event text,
        review_url text,
        command_action text,
        command_comment_id integer,
        created_at text not null,
        updated_at text not null,
        primary key (repo, pull_number, head_sha)
      );

      create index if not exists idx_review_readiness_state
        on review_readiness (state, updated_at);
      create index if not exists idx_review_readiness_repo_pull
        on review_readiness (repo, pull_number, updated_at);

      create table if not exists repo_memory_notes (
        note_id text not null,
        repo text not null,
        kind text not null,
        title text not null,
        body text not null,
        source text not null,
        confidence real,
        fingerprint text,
        created_at text not null,
        updated_at text not null,
        expires_at text,
        primary key (repo, note_id)
      );

      create index if not exists idx_repo_memory_notes_repo_updated
        on repo_memory_notes (repo, updated_at);
      create index if not exists idx_repo_memory_notes_repo_fingerprint
        on repo_memory_notes (repo, fingerprint);

      create table if not exists repo_memory_packet_builds (
        packet_sha text primary key,
        repo text not null,
        packet_version text not null,
        generated_at text not null,
        byte_estimate integer not null,
        token_estimate integer not null,
        included_note_ids text not null,
        redaction_status text not null,
        memory_root text
      );

      create index if not exists idx_repo_memory_packet_builds_repo_generated
        on repo_memory_packet_builds (repo, generated_at);
    `);
    this.ensureDaemonHeartbeatColumns();
    this.ensureReviewRunLeaseColumns();
    this.ensureReviewQueueJobColumns();
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

  getReviewReadiness(repo: string, pullNumber: number, headSha: string): ReviewReadinessRecord | undefined {
    const row = this.db
      .prepare(
        `select repo, pull_number, head_sha, state, reason, event, review_url,
                command_action, command_comment_id, created_at, updated_at
         from review_readiness
         where repo = ? and pull_number = ? and head_sha = ?
         limit 1`
      )
      .get(repo, pullNumber, headSha) as ReviewReadinessRow | undefined;
    return row ? mapReviewReadinessRow(row) : undefined;
  }

  recordReviewReadiness(input: {
    repo: string;
    pullNumber: number;
    headSha: string;
    state: ReviewReadinessState;
    reason?: string;
    event?: ReviewEvent;
    reviewUrl?: string;
    commandAction?: ProcessedCommandAction;
    commandCommentId?: number;
    clearCommandMetadata?: boolean;
    now?: Date;
  }): ReviewReadinessRecord {
    validateReviewQueueInput(input.repo, input.pullNumber, input.headSha, undefined, input.commandCommentId);
    this.db.exec("begin immediate");
    try {
      const existing = this.getReviewReadiness(input.repo, input.pullNumber, input.headSha);
      const reason = input.reason ? redactSecrets(input.reason).trim().slice(0, 500) : undefined;
      const event = input.event ?? existing?.event;
      const reviewUrl = input.reviewUrl ? redactSecrets(input.reviewUrl).trim().slice(0, 500) : existing?.reviewUrl;
      const commandAction = input.clearCommandMetadata ? undefined : input.commandAction ?? existing?.commandAction;
      const commandCommentId = input.clearCommandMetadata ? undefined : input.commandCommentId ?? existing?.commandCommentId;

      if (
        existing &&
        existing.state === input.state &&
        existing.reason === reason &&
        existing.event === event &&
        existing.reviewUrl === reviewUrl &&
        existing.commandAction === commandAction &&
        existing.commandCommentId === commandCommentId
      ) {
        this.db.exec("commit");
        return existing;
      }

      const nowIso = (input.now ?? new Date()).toISOString();
      this.db
        .prepare(
          `insert into review_readiness
            (repo, pull_number, head_sha, state, reason, event, review_url,
             command_action, command_comment_id, created_at, updated_at)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           on conflict(repo, pull_number, head_sha) do update set
             state = excluded.state,
             reason = excluded.reason,
             event = excluded.event,
             review_url = excluded.review_url,
             command_action = excluded.command_action,
             command_comment_id = excluded.command_comment_id,
             updated_at = excluded.updated_at`
        )
        .run(
          input.repo,
          input.pullNumber,
          input.headSha,
          input.state,
          reason ?? null,
          event ?? null,
          reviewUrl ?? null,
          commandAction ?? null,
          commandCommentId ?? null,
          existing?.createdAt ?? nowIso,
          nowIso
        );
      const readiness = this.getReviewReadiness(input.repo, input.pullNumber, input.headSha)!;
      this.db.exec("commit");
      return readiness;
    } catch (error) {
      try {
        this.db.exec("rollback");
      } catch {
        // Ignore rollback failures so the original SQLite error remains visible.
      }
      throw error;
    }
  }

  listReviewReadiness(input: {
    repo?: string;
    pullNumber?: number;
    state?: ReviewReadinessState;
    states?: ReviewReadinessState[];
    limit?: number;
  } = {}): ReviewReadinessRecord[] {
    if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1)) {
      throw new Error("limit must be a positive integer");
    }
    const states = input.states ?? (input.state ? [input.state] : undefined);
    const predicates: string[] = [];
    const params: Array<string | number> = [];
    if (input.repo) {
      predicates.push("repo = ?");
      params.push(input.repo);
    }
    if (input.pullNumber !== undefined) {
      if (!Number.isInteger(input.pullNumber) || input.pullNumber < 1) throw new Error("pullNumber must be a positive integer");
      predicates.push("pull_number = ?");
      params.push(input.pullNumber);
    }
    if (states?.length) {
      predicates.push(`state in (${states.map(() => "?").join(", ")})`);
      params.push(...states);
    }
    const where = predicates.length ? `where ${predicates.join(" and ")}` : "";
    const limit = input.limit ? " limit ?" : "";
    if (input.limit) params.push(input.limit);
    const rows = this.db
      .prepare(
        `select repo, pull_number, head_sha, state, reason, event, review_url,
                command_action, command_comment_id, created_at, updated_at
         from review_readiness
         ${where}
         order by datetime(updated_at) desc
         ${limit}`
      )
      .all(...params) as unknown as ReviewReadinessRow[];
    return rows.map(mapReviewReadinessRow);
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
    allowProcessed?: boolean;
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
      if (!input.allowProcessed && this.hasProcessed(input.repo, input.pullNumber, input.headSha)) {
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
      const nextState: ReviewerSessionState = nextHeadCount >= session.headCountLimit ? "draining" : "active";
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
    const updated = this.getReviewerSessionJob(input.repo, input.pullNumber, input.headSha)!;
    if (input.jobState === "completed" || input.jobState === "skipped" || input.jobState === "failed") {
      this.expireDrainedReviewerSessionIfComplete(existing.sessionId);
    }
    return updated;
  }

  enqueueReviewQueueJob(input: {
    repo: string;
    pullNumber: number;
    headSha: string;
    baseSha?: string;
    source?: ReviewQueueJobSource;
    lane?: ReviewQueueJobLane;
    providerId?: string;
    priority?: number;
    attemptId?: string;
    commentId?: number;
    sessionId?: string;
    now?: Date;
  }): ReviewQueueEnqueueResult {
    validateReviewQueueInput(input.repo, input.pullNumber, input.headSha, input.priority, input.commentId);
    const nowIso = (input.now ?? new Date()).toISOString();
    const source = input.source ?? "automatic";
    const lane = input.lane ?? (source === "manual_command" ? "manual" : "background");
    const priority = input.priority ?? (lane === "manual" ? 10 : 50);
    const attemptId = input.attemptId ?? buildReviewQueueAttemptId({
      source,
      repo: input.repo,
      pullNumber: input.pullNumber,
      headSha: input.headSha,
      baseSha: input.baseSha,
      commentId: input.commentId
    });
    const existing = this.getReviewQueueJobByAttemptId(attemptId);
    if (existing && !isTerminalQueueState(existing.state)) {
      return { enqueued: false, reason: "already_queued", job: existing };
    }
    const existingRetry = existing ? this.getActiveReviewQueueRetryJobByAttemptId(attemptId) : undefined;
    if (existingRetry) {
      return { enqueued: false, reason: "already_queued", job: existingRetry };
    }
    const queueAttemptId = existing ? `${attemptId}:after-terminal:${randomUUID()}` : attemptId;

    const jobId = randomUUID();
    this.db
      .prepare(
        `insert into review_queue_jobs
          (job_id, attempt_id, source, lane, repo, org, pull_number, head_sha, base_sha,
           provider_id, priority, state, session_id, comment_id, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)`
      )
      .run(
        jobId,
        queueAttemptId,
        source,
        lane,
        input.repo,
        repoOrg(input.repo),
        input.pullNumber,
        input.headSha,
        input.baseSha ?? null,
        input.providerId ?? null,
        priority,
        input.sessionId ?? null,
        input.commentId ?? null,
        nowIso,
        nowIso
      );
    return { enqueued: true, job: this.getReviewQueueJob(jobId)! };
  }

  leaseNextReviewQueueJobs(input: {
    maxProviderActive: number;
    maxOrgActive: number;
    maxRepoActive: number;
    manualCommandReserve?: number;
    limit?: number;
    leaseTtlMs?: number;
    now?: Date;
  }): ReviewQueueJobRecord[] {
    validatePositiveQueueLimit(input.maxProviderActive, "maxProviderActive");
    validatePositiveQueueLimit(input.maxOrgActive, "maxOrgActive");
    validatePositiveQueueLimit(input.maxRepoActive, "maxRepoActive");
    const manualCommandReserve = input.manualCommandReserve ?? 0;
    if (!Number.isInteger(manualCommandReserve) || manualCommandReserve < 0) {
      throw new Error("manualCommandReserve must be a non-negative integer");
    }
    if (manualCommandReserve > input.maxProviderActive) {
      throw new Error("manualCommandReserve must be <= maxProviderActive");
    }
    const limit = input.limit ?? input.maxProviderActive;
    validatePositiveQueueLimit(limit, "limit");
    const leaseTtlMs = input.leaseTtlMs ?? 15 * 60_000;
    validatePositiveQueueLimit(leaseTtlMs, "leaseTtlMs");
    const nowIso = (input.now ?? new Date()).toISOString();
    const legacyLeaseCutoffIso = new Date(Date.parse(nowIso) - leaseTtlMs).toISOString();
    const leaseExpiresAt = new Date(Date.parse(nowIso) + leaseTtlMs).toISOString();
    const leased: ReviewQueueJobRecord[] = [];

    this.db.exec("begin immediate");
    try {
      this.db
        .prepare(
          `update review_queue_jobs
           set state = 'queued',
               lease_id = null,
               lease_expires_at = null,
               last_error = 'queue_lease_expired_requeued',
               updated_at = ?
           where state in ('leased', 'running')
             and (
               (lease_expires_at is not null and datetime(lease_expires_at) <= datetime(?))
               or (lease_expires_at is null and datetime(updated_at) <= datetime(?))
             )`
        )
        .run(nowIso, nowIso, legacyLeaseCutoffIso);
      const jobs = this.listReviewQueueJobs();
      const eligible = jobs
        .filter((job) => isQueueJobEligible(job, nowIso))
        .sort(compareQueueJobsForLease);
      const active = jobs.filter((job) => job.state === "leased" || job.state === "running");
      const providerActive = countBy(active, (job) => job.providerId ?? "default");
      const orgActive = countBy(active, (job) => job.org);
      const repoActive = countBy(active, (job) => job.repo);
      const hasManualAfter = buildManualEligibilitySuffix(eligible);

      for (const [index, job] of eligible.entries()) {
        if (leased.length >= limit) break;
        const provider = job.providerId ?? "default";
        const providerCount = (providerActive.get(provider) ?? 0);
        if (providerCount >= input.maxProviderActive) continue;
        if ((orgActive.get(job.org) ?? 0) >= input.maxOrgActive) continue;
        if ((repoActive.get(job.repo) ?? 0) >= input.maxRepoActive) continue;
        if (
          job.lane === "background" &&
          hasManualAfter[index] &&
          manualCommandReserve > 0 &&
          providerCount >= input.maxProviderActive - manualCommandReserve
        ) {
          continue;
        }

        const leaseId = randomUUID();
        this.db
          .prepare(
            `update review_queue_jobs
             set state = 'leased', lease_id = ?, lease_expires_at = ?, updated_at = ?
             where job_id = ? and state in ('queued', 'provider_deferred')`
          )
          .run(leaseId, leaseExpiresAt, nowIso, job.jobId);
        providerActive.set(provider, providerCount + 1);
        orgActive.set(job.org, (orgActive.get(job.org) ?? 0) + 1);
        repoActive.set(job.repo, (repoActive.get(job.repo) ?? 0) + 1);
        leased.push(this.getReviewQueueJob(job.jobId)!);
      }
      this.db.exec("commit");
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }

    return leased;
  }

  updateReviewQueueJobState(input: {
    jobId: string;
    state: ReviewQueueJobState;
    nextEligibleAt?: string;
    leaseId?: string;
    leaseExpiresAt?: string;
    clearLease?: boolean;
    sessionId?: string;
    reviewUrl?: string;
    lastError?: string;
    now?: Date;
  }): ReviewQueueJobRecord {
    const existing = this.getReviewQueueJob(input.jobId);
    if (!existing) throw new Error(`No review queue job for jobId ${input.jobId}`);
    const nowIso = (input.now ?? new Date()).toISOString();
    const terminal = isTerminalQueueState(input.state);
    const clearLease = input.clearLease ?? (
      terminal ||
      input.state === "queued" ||
      input.state === "provider_deferred"
    );
    this.db
      .prepare(
        `update review_queue_jobs
         set state = ?,
             next_eligible_at = ?,
             lease_id = case when ? then null else coalesce(?, lease_id) end,
             lease_expires_at = case when ? then null else coalesce(?, lease_expires_at) end,
             session_id = coalesce(?, session_id),
             review_url = coalesce(?, review_url),
             last_error = coalesce(?, last_error),
             updated_at = ?,
             started_at = case when ? = 'running' and started_at is null then ? else started_at end,
             finished_at = case when ? then ? else finished_at end
         where job_id = ?`
      )
      .run(
        input.state,
        input.nextEligibleAt ?? null,
        clearLease ? 1 : 0,
        input.leaseId ?? null,
        clearLease ? 1 : 0,
        input.leaseExpiresAt ?? null,
        input.sessionId ?? null,
        input.reviewUrl ?? null,
        input.lastError ? redactSecrets(input.lastError) : null,
        nowIso,
        input.state,
        nowIso,
        terminal ? 1 : 0,
        nowIso,
        input.jobId
      );
    return this.getReviewQueueJob(input.jobId)!;
  }

  getReviewQueueJob(jobId: string): ReviewQueueJobRecord | undefined {
    const row = this.db
      .prepare(
        `select job_id, attempt_id, source, lane, repo, org, pull_number, head_sha, base_sha,
                provider_id, priority, state, next_eligible_at, lease_id, lease_expires_at, session_id,
                comment_id, review_url, last_error, created_at, updated_at, started_at, finished_at
         from review_queue_jobs
         where job_id = ?
         limit 1`
      )
      .get(jobId) as ReviewQueueJobRow | undefined;
    return row ? mapReviewQueueJobRow(row) : undefined;
  }

  getReviewQueueJobByAttemptId(attemptId: string): ReviewQueueJobRecord | undefined {
    const row = this.db
      .prepare(
        `select job_id, attempt_id, source, lane, repo, org, pull_number, head_sha, base_sha,
                provider_id, priority, state, next_eligible_at, lease_id, lease_expires_at, session_id,
                comment_id, review_url, last_error, created_at, updated_at, started_at, finished_at
         from review_queue_jobs
         where attempt_id = ?
         limit 1`
      )
      .get(attemptId) as ReviewQueueJobRow | undefined;
    return row ? mapReviewQueueJobRow(row) : undefined;
  }

  private getActiveReviewQueueRetryJobByAttemptId(attemptId: string): ReviewQueueJobRecord | undefined {
    const retryPrefix = `${attemptId}:after-terminal:`;
    const row = this.db
      .prepare(
        `select job_id, attempt_id, source, lane, repo, org, pull_number, head_sha, base_sha,
                provider_id, priority, state, next_eligible_at, lease_id, lease_expires_at, session_id,
                comment_id, review_url, last_error, created_at, updated_at, started_at, finished_at
         from review_queue_jobs
         where substr(attempt_id, 1, ?) = ?
           and state in ('queued', 'leased', 'running', 'provider_deferred')
         order by datetime(created_at) desc
         limit 1`
      )
      .get(retryPrefix.length, retryPrefix) as ReviewQueueJobRow | undefined;
    return row ? mapReviewQueueJobRow(row) : undefined;
  }

  listReviewQueueJobs(input: {
    repo?: string;
    state?: ReviewQueueJobState;
    states?: ReviewQueueJobState[];
    limit?: number;
  } = {}): ReviewQueueJobRecord[] {
    if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1)) {
      throw new Error("limit must be a positive integer");
    }
    const rows = (input.repo
      ? this.db
          .prepare(
            `select job_id, attempt_id, source, lane, repo, org, pull_number, head_sha, base_sha,
                    provider_id, priority, state, next_eligible_at, lease_id, lease_expires_at, session_id,
                    comment_id, review_url, last_error, created_at, updated_at, started_at, finished_at
             from review_queue_jobs
             where repo = ?
             order by priority asc, datetime(created_at) asc`
          )
          .all(input.repo)
      : this.db
          .prepare(
            `select job_id, attempt_id, source, lane, repo, org, pull_number, head_sha, base_sha,
                    provider_id, priority, state, next_eligible_at, lease_id, lease_expires_at, session_id,
                    comment_id, review_url, last_error, created_at, updated_at, started_at, finished_at
             from review_queue_jobs
             order by priority asc, datetime(created_at) asc`
          )
          .all()) as unknown as ReviewQueueJobRow[];
    const states = input.states ?? (input.state ? [input.state] : undefined);
    const jobs = rows
      .map(mapReviewQueueJobRow)
      .filter((job) => !states || states.includes(job.state));
    return input.limit ? jobs.slice(0, input.limit) : jobs;
  }

  listReviewQueueJobsForPull(input: {
    repo: string;
    pullNumber: number;
    state?: ReviewQueueJobState;
    states?: ReviewQueueJobState[];
    limit?: number;
  }): ReviewQueueJobRecord[] {
    if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1)) {
      throw new Error("limit must be a positive integer");
    }
    const states = input.states ?? (input.state ? [input.state] : undefined);
    const statePredicate = states?.length
      ? ` and state in (${states.map(() => "?").join(", ")})`
      : "";
    const limitPredicate = input.limit ? " limit ?" : "";
    const params = [
      input.repo,
      input.pullNumber,
      ...(states ?? []),
      ...(input.limit ? [input.limit] : [])
    ];
    const rows = this.db
      .prepare(
        `select job_id, attempt_id, source, lane, repo, org, pull_number, head_sha, base_sha,
                provider_id, priority, state, next_eligible_at, lease_id, lease_expires_at, session_id,
                comment_id, review_url, last_error, created_at, updated_at, started_at, finished_at
         from review_queue_jobs
         where repo = ?
           and pull_number = ?
           ${statePredicate}
         order by priority asc, datetime(created_at) asc
         ${limitPredicate}`
      )
      .all(...params) as unknown as ReviewQueueJobRow[];
    return rows.map(mapReviewQueueJobRow);
  }

  expireReviewerSessions(now = new Date(), repo?: string): number {
    const nowIso = now.toISOString();
    const result = repo
      ? this.db
          .prepare(
            `update reviewer_sessions
             set state = 'expired'
             where repo = ?
               and state in ('warming', 'active', 'draining')
               and (expires_at <= ? or (state in ('warming', 'active') and head_count_used >= head_count_limit))`
          )
          .run(repo, nowIso)
      : this.db
          .prepare(
            `update reviewer_sessions
             set state = 'expired'
             where state in ('warming', 'active', 'draining')
               and (expires_at <= ? or (state in ('warming', 'active') and head_count_used >= head_count_limit))`
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

  private expireDrainedReviewerSessionIfComplete(sessionId: string): void {
    const session = this.getReviewerSession(sessionId);
    if (session?.state !== "draining") return;
    const row = this.db
      .prepare(
        `select count(*) as activeJobCount
         from reviewer_session_jobs
         where session_id = ?
           and job_state not in ('completed', 'skipped', 'failed')`
      )
      .get(sessionId) as { activeJobCount?: number };
    if ((row.activeJobCount ?? 0) > 0) return;
    this.db.prepare("update reviewer_sessions set state = 'expired' where session_id = ?").run(sessionId);
  }

  private getReusableReviewerSession(repo: string, now = new Date()): ReviewerSessionRecord | undefined {
    const nowIso = now.toISOString();
    const rows = this.db
      .prepare(
        `select session_id, repo, repo_family, state, started_at, last_used_at, expires_at,
                head_count_used, head_count_limit, worker_pid, model, provider, zcode_cli_version,
                memory_packet_sha, gitnexus_packet_sha, last_error
         from reviewer_sessions
         where repo = ?
           and state in ('warming', 'active')
           and expires_at > ?
           and head_count_used < head_count_limit
         order by datetime(last_used_at) desc`
      )
      .all(repo, nowIso) as unknown as ReviewerSessionRow[];
    for (const row of rows) {
      const session = mapReviewerSessionRow(row);
      if (session.workerPid !== undefined && !isProcessAlive(session.workerPid)) {
        this.db
          .prepare("update reviewer_sessions set state = 'failed', last_error = ? where session_id = ?")
          .run(`owner_pid_not_alive:${session.workerPid}`, session.sessionId);
        continue;
      }
      return session;
    }
    return undefined;
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
         where repo = ? and pull_number = ? and comment_id = ?
         limit 1`
      )
      .get(repo, pullNumber, commentId);
    void headSha;
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

  recordRepoMemoryNote(input: RecordRepoMemoryNoteInput): RepoMemoryNoteRecord {
    validateRepoMemoryNoteInput(input);
    const rawText = [input.noteId, input.title, input.body, input.source, input.fingerprint ?? ""].join("\n");
    if (containsSecretLikeText(rawText)) {
      throw new Error(`Refusing to store repo memory note ${redactSecrets(input.noteId)}: secret-like text detected`);
    }
    const existing = this.getRepoMemoryNote(input.repo, input.noteId);
    const nowIso = (input.now ?? new Date()).toISOString();
    this.db
      .prepare(
        `insert into repo_memory_notes
          (note_id, repo, kind, title, body, source, confidence, fingerprint, created_at, updated_at, expires_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         on conflict(repo, note_id) do update set
           kind = excluded.kind,
           title = excluded.title,
           body = excluded.body,
           source = excluded.source,
           confidence = excluded.confidence,
           fingerprint = excluded.fingerprint,
           updated_at = excluded.updated_at,
           expires_at = excluded.expires_at`
      )
      .run(
        input.noteId,
        input.repo,
        input.kind,
        redactSecrets(input.title).trim(),
        redactSecrets(input.body).trim(),
        redactSecrets(input.source).trim(),
        input.confidence ?? null,
        input.fingerprint ? redactSecrets(input.fingerprint).trim() : null,
        existing?.createdAt ?? nowIso,
        nowIso,
        input.expiresAt ?? null
      );
    return this.getRepoMemoryNote(input.repo, input.noteId)!;
  }

  getRepoMemoryNote(repo: string, noteId: string): RepoMemoryNoteRecord | undefined {
    validateRepoName(repo, "repo");
    if (!noteId.trim()) throw new Error("noteId must be non-empty");
    const row = this.db
      .prepare(
        `select note_id, repo, kind, title, body, source, confidence, fingerprint, created_at, updated_at, expires_at
         from repo_memory_notes
         where repo = ? and note_id = ?
         limit 1`
      )
      .get(repo, noteId) as RepoMemoryNoteRow | undefined;
    return row ? mapRepoMemoryNoteRow(row) : undefined;
  }

  listRepoMemoryNotes(input: {
    repo: string;
    includeExpired?: boolean;
    now?: Date;
    limit?: number;
  }): RepoMemoryNoteRecord[] {
    validateRepoName(input.repo, "repo");
    if (input.limit !== undefined) validatePositiveQueueLimit(input.limit, "limit");
    const params: Array<string | number> = [input.repo];
    const predicates = ["repo = ?"];
    if (input.includeExpired !== true) {
      predicates.push("(expires_at is null or datetime(expires_at) > datetime(?))");
      params.push((input.now ?? new Date()).toISOString());
    }
    const limit = input.limit ? " limit ?" : "";
    if (input.limit) params.push(input.limit);
    const rows = this.db
      .prepare(
        `select note_id, repo, kind, title, body, source, confidence, fingerprint, created_at, updated_at, expires_at
         from repo_memory_notes
         where ${predicates.join(" and ")}
         order by datetime(updated_at) desc, note_id asc
         ${limit}`
      )
      .all(...params) as unknown as RepoMemoryNoteRow[];
    return rows.map(mapRepoMemoryNoteRow);
  }

  recordRepoMemoryPacketBuild(record: RepoMemoryPacketBuildRecord): void {
    validateRepoName(record.repo, "repo");
    if (!/^[a-f0-9]{64}$/.test(record.packetSha)) throw new Error("packetSha must be a SHA-256 hex digest");
    if (!record.packetVersion.trim()) throw new Error("packetVersion must be non-empty");
    if (!Number.isInteger(record.byteEstimate) || record.byteEstimate < 1) throw new Error("byteEstimate must be a positive integer");
    if (!Number.isInteger(record.tokenEstimate) || record.tokenEstimate < 1) throw new Error("tokenEstimate must be a positive integer");
    const metadataText = [
      record.packetSha,
      record.repo,
      record.packetVersion,
      record.redactionStatus,
      record.memoryRoot ?? "",
      ...record.includedNoteIds
    ].join("\n");
    if (containsSecretLikeText(metadataText)) {
      throw new Error(`Refusing to store repo memory packet ${record.packetSha}: secret-like metadata detected`);
    }
    this.db
      .prepare(
        `insert or ignore into repo_memory_packet_builds
          (packet_sha, repo, packet_version, generated_at, byte_estimate, token_estimate,
           included_note_ids, redaction_status, memory_root)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.packetSha,
        record.repo,
        record.packetVersion,
        record.generatedAt,
        record.byteEstimate,
        record.tokenEstimate,
        JSON.stringify(record.includedNoteIds),
        record.redactionStatus,
        record.memoryRoot ? redactSecrets(record.memoryRoot) : null
      );
  }

  getRepoMemoryPacketBuild(packetSha: string): RepoMemoryPacketBuildRecord | undefined {
    if (!/^[a-f0-9]{64}$/.test(packetSha)) throw new Error("packetSha must be a SHA-256 hex digest");
    const row = this.db
      .prepare(
        `select packet_sha, repo, packet_version, generated_at, byte_estimate, token_estimate,
                included_note_ids, redaction_status, memory_root
         from repo_memory_packet_builds
         where packet_sha = ?
         limit 1`
      )
      .get(packetSha) as RepoMemoryPacketBuildRow | undefined;
    return row ? mapRepoMemoryPacketBuildRow(row) : undefined;
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

  private ensureReviewQueueJobColumns(): void {
    const columns = this.db.prepare("pragma table_info(review_queue_jobs)").all() as unknown as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "lease_expires_at")) {
      this.db.exec("alter table review_queue_jobs add column lease_expires_at text");
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

function validateReviewQueueInput(
  repo: string,
  pullNumber: number,
  headSha: string,
  priority?: number,
  commentId?: number
): void {
  if (!repoOrg(repo)) throw new Error("repo must be an owner/repo name");
  if (!Number.isInteger(pullNumber) || pullNumber < 1) throw new Error("pullNumber must be a positive integer");
  if (!headSha.trim()) throw new Error("headSha must be non-empty");
  if (priority !== undefined && (!Number.isInteger(priority) || priority < 0)) {
    throw new Error("priority must be a non-negative integer");
  }
  if (commentId !== undefined && (!Number.isInteger(commentId) || commentId < 1)) {
    throw new Error("commentId must be a positive integer");
  }
}

function validateRepoMemoryNoteInput(input: RecordRepoMemoryNoteInput): void {
  if (!input.noteId.trim()) throw new Error("noteId must be non-empty");
  validateRepoName(input.repo, "repo");
  if (!["policy_note", "machine_fact", "false_positive", "review_outcome", "proof_preference"].includes(input.kind)) {
    throw new Error("kind must be a valid repo memory note kind");
  }
  if (!input.title.trim()) throw new Error("title must be non-empty");
  if (!input.body.trim()) throw new Error("body must be non-empty");
  if (!input.source.trim()) throw new Error("source must be non-empty");
  if (input.confidence !== undefined && (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1)) {
    throw new Error("confidence must be a number from 0 to 1");
  }
  if (input.kind === "false_positive" && !input.fingerprint?.trim()) {
    throw new Error("false_positive repo memory notes require a fingerprint");
  }
  if (input.fingerprint !== undefined && !/^finding:[a-f0-9]{64}$/.test(input.fingerprint.trim())) {
    throw new Error("repo memory note fingerprint must match finding:<64-hex>");
  }
  if (input.now !== undefined && !Number.isFinite(input.now.getTime())) {
    throw new Error("now must be a valid Date");
  }
  const nowMs = input.now?.getTime() ?? Date.now();
  const expiresAtMs = input.expiresAt === undefined ? undefined : Date.parse(input.expiresAt);
  if (input.expiresAt !== undefined && !Number.isFinite(expiresAtMs)) {
    throw new Error("expiresAt must be an ISO timestamp");
  }
  if (input.kind === "false_positive") {
    if (expiresAtMs === undefined) throw new Error("false_positive repo memory notes require expiresAt");
    if (expiresAtMs <= nowMs) throw new Error("false_positive repo memory notes require a future expiresAt");
    if (expiresAtMs - nowMs > 90 * 24 * 60 * 60_000) {
      throw new Error("false_positive repo memory notes must expire within 90 days");
    }
  }
}

function validateRepoName(repo: string, label: string): void {
  const [owner, name, extra] = repo.split("/");
  if (extra !== undefined || !owner || !name) throw new Error(`${label} must be an owner/repo name`);
  if (
    owner === "." ||
    owner === ".." ||
    name === "." ||
    name === ".." ||
    !/^[A-Za-z0-9_.-]+$/.test(owner) ||
    !/^[A-Za-z0-9_.-]+$/.test(name)
  ) {
    throw new Error(`${label} must be an owner/repo name`);
  }
}

function validatePositiveQueueLimit(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
}

function buildReviewQueueAttemptId(input: {
  source: ReviewQueueJobSource;
  repo: string;
  pullNumber: number;
  headSha: string;
  baseSha?: string;
  commentId?: number;
}): string {
  if (input.source === "manual_command") {
    return `manual:${input.repo}#${input.pullNumber}@${input.headSha}:${input.commentId ?? randomUUID()}`;
  }
  return `automatic:${input.repo}#${input.pullNumber}@${input.headSha}:base=${input.baseSha ?? "unknown"}`;
}

function repoOrg(repo: string): string {
  return repo.split("/")[0] ?? "";
}

function isQueueJobEligible(job: ReviewQueueJobRecord, nowIso: string): boolean {
  if (job.state === "queued") return true;
  if (job.state !== "provider_deferred") return false;
  if (!job.nextEligibleAt) return true;
  const nextEligibleAtMs = Date.parse(job.nextEligibleAt);
  if (!Number.isFinite(nextEligibleAtMs)) return true;
  return nextEligibleAtMs <= Date.parse(nowIso);
}

function compareQueueJobsForLease(left: ReviewQueueJobRecord, right: ReviewQueueJobRecord): number {
  if (left.priority !== right.priority) return left.priority - right.priority;
  const leftCreated = Date.parse(left.createdAt);
  const rightCreated = Date.parse(right.createdAt);
  return leftCreated - rightCreated;
}

function buildManualEligibilitySuffix(jobs: ReviewQueueJobRecord[]): boolean[] {
  const hasManualAfter = new Array<boolean>(jobs.length).fill(false);
  let seenManual = false;
  for (let index = jobs.length - 1; index >= 0; index -= 1) {
    hasManualAfter[index] = seenManual;
    if (jobs[index]?.lane === "manual") seenManual = true;
  }
  return hasManualAfter;
}

function countBy<T>(items: T[], key: (item: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const value = key(item);
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

function isTerminalQueueState(state: ReviewQueueJobState): boolean {
  return state === "posted" ||
    state === "failed" ||
    state === "stale_retired" ||
    state === "closed_retired" ||
    state === "command_recorded";
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

interface ReviewQueueJobRow {
  job_id: string;
  attempt_id: string;
  source: ReviewQueueJobSource;
  lane: ReviewQueueJobLane;
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
  event: ReviewEvent | null;
  review_url: string | null;
  command_action: ProcessedCommandAction | null;
  command_comment_id: number | null;
  created_at: string;
  updated_at: string;
}

interface RepoMemoryNoteRow {
  note_id: string;
  repo: string;
  kind: RepoMemoryNoteKind;
  title: string;
  body: string;
  source: string;
  confidence: number | null;
  fingerprint: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
}

interface RepoMemoryPacketBuildRow {
  packet_sha: string;
  repo: string;
  packet_version: string;
  generated_at: string;
  byte_estimate: number;
  token_estimate: number;
  included_note_ids: string;
  redaction_status: string;
  memory_root: string | null;
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

function mapReviewReadinessRow(row: ReviewReadinessRow): ReviewReadinessRecord {
  return {
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

function mapRepoMemoryNoteRow(row: RepoMemoryNoteRow): RepoMemoryNoteRecord {
  return {
    noteId: row.note_id,
    repo: row.repo,
    kind: row.kind,
    title: row.title,
    body: row.body,
    source: row.source,
    ...(row.confidence !== null ? { confidence: row.confidence } : {}),
    ...(row.fingerprint ? { fingerprint: row.fingerprint } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.expires_at ? { expiresAt: row.expires_at } : {})
  };
}

function mapRepoMemoryPacketBuildRow(row: RepoMemoryPacketBuildRow): RepoMemoryPacketBuildRecord {
  return {
    packetSha: row.packet_sha,
    repo: row.repo,
    packetVersion: row.packet_version,
    generatedAt: row.generated_at,
    byteEstimate: row.byte_estimate,
    tokenEstimate: row.token_estimate,
    includedNoteIds: parseIncludedNoteIds(row.included_note_ids),
    redactionStatus: row.redaction_status,
    ...(row.memory_root ? { memoryRoot: row.memory_root } : {})
  };
}

function parseIncludedNoteIds(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}
