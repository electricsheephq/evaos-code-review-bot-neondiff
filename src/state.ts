import { existsSync, mkdirSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { containsSecretLikeText, redactSecrets } from "./secrets.js";
import type { FinishingTouchAction } from "./finishing-touches.js";
import type { ReviewEvent } from "./types.js";

export type ProcessedStatus = "dry_run" | "posted" | "skipped" | "failed";
export type ProcessedCommandAction = "review" | "re-review" | "explain" | "stop" | FinishingTouchAction;
export type ProcessedCommandStatus = "triggered" | "explained" | "stopped" | "ignored";
export type FinishingTouchDraftStatus = "drafted" | "rejected";
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
  | "blocked_on_proof"
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
export type IssueEnrichmentRecordStatus = "dry_run" | "posted" | "skipped" | "deferred" | "failed";
const REPO_MEMORY_NOTE_KINDS: RepoMemoryNoteKind[] = ["policy_note", "machine_fact", "false_positive", "review_outcome", "proof_preference"];

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

export type FindingOutcomeLabelSource =
  | "merged_fix"
  | "revert"
  | "hotfix"
  | "human_thread"
  | "ci_failure"
  | "none_observed"
  // Explicit, operator-declared negative control (#286 PR C): recorded ONLY for a run that posted
  // zero findings (verifiably clean) AND was flagged by the operator — mirrors the #296 semantics
  // that an empty label set is never a negative control by itself.
  | "explicit_control";

export type FindingOutcomeVerdict = "true_positive" | "false_positive" | "unvalidated";

export interface FindingOutcomeLabelRecord {
  fingerprint: string;
  repo: string;
  pullNumber: number;
  headSha: string;
  severity: string;
  category: string;
  confidence: number;
  labelSource: FindingOutcomeLabelSource;
  verdict: FindingOutcomeVerdict;
  observedAt: string;
  evidenceRef?: string;
}

/** Public-safe posted-finding coordinates (#357) — reconstructable into an ObservedFinding. */
export interface ReviewFindingRecord {
  fingerprint: string;
  repo: string;
  pullNumber: number;
  headSha: string;
  path: string;
  line: number;
  severity: string;
  category: string;
  confidence: number;
  recordedAt: string;
}

export interface RepoActivationRecord {
  repo: string;
  activatedAt: string;
  createdAt: string;
}

export const ACTIVATION_BASELINE_EXISTING_HEAD_ERROR = "activation_baseline_existing_head";

export function isActivationBaselineProcessedReview(
  processed: Pick<StoredProcessedReviewRecord, "status" | "error"> | undefined
): boolean {
  return processed?.status === "skipped" && processed.error === ACTIVATION_BASELINE_EXISTING_HEAD_ERROR;
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

export interface ReviewHeadClaim {
  claimId: string;
  expiresAt: string;
  ownerPid: number;
}

export interface IssueEnrichmentRunLease {
  leaseId: string;
  expiresAt: string;
  ownerPid: number;
}

export interface IssueEnrichmentRunLeaseClearCandidate extends IssueEnrichmentRunLease {
  expired: boolean;
}

export interface ClearIssueEnrichmentRunLeasesResult {
  checkedAt: string;
  expiredOnly: boolean;
  dryRun: boolean;
  matched: number;
  expiredMatched: number;
  activeMatched: number;
  deleted: number;
  leases: IssueEnrichmentRunLeaseClearCandidate[];
}

export interface ReviewRunLeaseClearCandidate extends ReviewRunLease {
  expired: boolean;
  ownerAlive: boolean;
  staleReason?: "expired" | "owner_not_running";
}

export interface ReviewQueueLeaseClearCandidate extends ReviewQueueJobRecord {
  expired: boolean;
  active: boolean;
  staleReason?: "expired" | "missing_lease_expiry" | "forced_active";
}

export interface ClearReviewQueueLeasesResult {
  checkedAt: string;
  expiredOnly: boolean;
  dryRun: boolean;
  filters: {
    repo?: string;
    pullNumber?: number;
    jobId?: string;
  };
  matched: number;
  expiredMatched: number;
  activeMatched: number;
  requeued: number;
  deletedRunLeases: number;
  jobs: ReviewQueueLeaseClearCandidate[];
  runLeases: ReviewRunLeaseClearCandidate[];
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
  retryAttempt?: number;
  providerCode?: string;
  retryAfterMs?: number;
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

export interface ReviewEventAuthorizationConsumptionInput {
  repo: string;
  pullNumber: number;
  headSha: string;
  commentId: number;
  author: string;
  now?: Date;
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
  coarsePath?: string;
  coarseCategory?: string;
  coarseLine?: number;
  coarseTitle?: string;
  confirmedByHuman?: boolean;
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
  // Coarse false-positive-match fields (#302, additive). confirmedByHuman gates P0/P1 suppression.
  coarsePath?: string;
  coarseCategory?: string;
  coarseLine?: number;
  coarseTitle?: string;
  confirmedByHuman?: boolean;
  expiresAt?: string;
  now?: Date;
}

export interface IssueEnrichmentRecord {
  repo: string;
  issueNumber: number;
  issueUpdatedAt?: string;
  bodyHash?: string;
  status: IssueEnrichmentRecordStatus;
  reason?: string;
  commentUrl?: string;
  error?: string;
  nextEligibleAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface IssueEnrichmentRepoWatermark {
  repo: string;
  activatedAt: string;
  lastCheckedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface RecordIssueEnrichmentInput {
  repo: string;
  issueNumber: number;
  issueUpdatedAt?: string;
  bodyHash?: string;
  status: IssueEnrichmentRecordStatus;
  reason?: string;
  commentUrl?: string;
  error?: string;
  nextEligibleAt?: string;
  now?: Date;
}

export interface RecordIssueEnrichmentRepoWatermarkInput {
  repo: string;
  activatedAt: string;
  lastCheckedAt: string;
  now?: Date;
}

export interface ListRepoMemoryNotesInput {
  repo: string;
  includeExpired?: boolean;
  now?: Date;
  limit?: number;
  kind?: RepoMemoryNoteKind;
  excludeKind?: RepoMemoryNoteKind;
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

export interface RecordFinishingTouchDraftInput {
  repo: string;
  pullNumber: number;
  headSha: string;
  commandCommentId: number;
  action: FinishingTouchAction;
  author: string;
  trigger: string;
  status: FinishingTouchDraftStatus;
  proposedOutput: unknown;
  now?: Date;
}

export interface GetFinishingTouchDraftInput {
  repo: string;
  pullNumber: number;
  headSha: string;
  commandCommentId: number;
}

export interface FinishingTouchDraftRecord {
  repo: string;
  pullNumber: number;
  headSha: string;
  commandCommentId: number;
  action: FinishingTouchAction;
  author: string;
  trigger: string;
  status: FinishingTouchDraftStatus;
  proposedOutput: unknown;
  outputSha: string;
  createdAt: string;
  updatedAt: string;
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

      create table if not exists finding_outcome_labels (
        fingerprint text not null,
        repo text not null,
        pull_number integer not null,
        head_sha text not null,
        severity text not null,
        category text not null,
        confidence real not null,
        label_source text not null,
        verdict text not null,
        observed_at text not null,
        evidence_ref text,
        primary key (fingerprint, repo, pull_number, head_sha)
      );

      -- Public-safe findings ledger (#357): records the coordinates the bot ALREADY posted publicly
      -- (fingerprint/path/line/severity/category/confidence — deliberately NO title/body), so the
      -- daemon observe pass can reconstruct ObservedFinding and re-derive outcome labels later.
      create table if not exists review_findings (
        fingerprint text not null,
        repo text not null,
        pull_number integer not null,
        head_sha text not null,
        path text not null,
        line integer not null,
        severity text not null,
        category text not null,
        confidence real not null,
        recorded_at text not null,
        primary key (fingerprint, repo, pull_number, head_sha)
      );

      -- Calibration observe-pass schedule state (#357): one global row (scope='__global__') tracks
      -- lastObserveAt for the interval gate; per-repo rows (scope=repo) track per-repo cooldown.
      create table if not exists calibration_observe_runs (
        scope text primary key,
        observed_at text not null
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

      create table if not exists review_head_claims (
        repo text not null,
        pull_number integer not null,
        head_sha text not null,
        claim_id text not null,
        owner_pid integer,
        claimed_at text not null,
        expires_at text not null,
        primary key (repo, pull_number, head_sha)
      );

      create table if not exists public_command_invocations (
        repo text not null,
        pull_number integer not null,
        head_sha text not null,
        author text not null,
        action text not null,
        invoked_at text not null,
        primary key (repo, pull_number, head_sha, author, action)
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
        coarse_path text,
        coarse_category text,
        coarse_line integer,
        coarse_title text,
        confirmed_by_human integer,
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

      create table if not exists issue_enrichment_records (
        repo text not null,
        issue_number integer not null,
        issue_updated_at text,
        body_hash text,
        status text not null,
        reason text,
        comment_url text,
        error text,
        next_eligible_at text,
        created_at text not null,
        updated_at text not null,
        primary key (repo, issue_number)
      );

      create index if not exists idx_issue_enrichment_records_status
        on issue_enrichment_records (status, updated_at);
      create index if not exists idx_issue_enrichment_records_repo_status
        on issue_enrichment_records (repo, status);

      create table if not exists issue_enrichment_repo_watermarks (
        repo text primary key,
        activated_at text not null,
        last_checked_at text not null,
        created_at text not null,
        updated_at text not null
      );

      create table if not exists issue_enrichment_run_leases (
        lease_id text primary key,
        started_at text not null,
        expires_at text not null,
        owner_pid integer
      );
    `);
    this.ensureIssueEnrichmentBodyHashColumn();
    this.ensureDaemonHeartbeatColumns();
    this.ensureReviewRunLeaseColumns();
    this.ensureReviewQueueJobColumns();
    this.ensureRepoMemoryNoteCoarseColumns();
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

      create table if not exists review_event_authorization_consumptions (
        repo text not null,
        pull_number integer not null,
        head_sha text not null,
        comment_id integer not null,
        author text not null,
        consumed_at text not null,
        primary key (repo, pull_number, head_sha)
      );

      create table if not exists finishing_touch_drafts (
        repo text not null,
        pull_number integer not null,
        head_sha text not null,
        command_comment_id integer not null,
        action text not null,
        author text not null,
        trigger text not null,
        status text not null,
        proposed_output_json text not null,
        output_sha text not null,
        created_at text not null,
        updated_at text not null,
        primary key (repo, pull_number, head_sha, command_comment_id)
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
    // A recorded outcome for this head supersedes any in-flight per-head claim (#295): retire it so
    // no stale claim row lingers to its TTL after the review is durable.
    this.db
      .prepare("delete from review_head_claims where repo = ? and pull_number = ? and head_sha = ?")
      .run(record.repo, record.pullNumber, record.headSha);
  }

  recordFindingOutcomeLabel(record: FindingOutcomeLabelRecord): void {
    this.writeFindingOutcomeLabel(record);
  }

  /**
   * Atomic batch write (#286 PR C): all records land or none do. The inserts execute inside a single
   * BEGIN IMMEDIATE transaction (mirroring the review_run_leases idiom), so a mid-batch validation or
   * write failure rolls back to zero rows rather than leaving a partial write.
   */
  recordFindingOutcomeLabels(records: FindingOutcomeLabelRecord[]): void {
    if (records.length === 0) return;
    this.db.exec("begin immediate");
    try {
      for (const record of records) this.writeFindingOutcomeLabel(record);
      this.db.exec("commit");
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
  }

  private writeFindingOutcomeLabel(record: FindingOutcomeLabelRecord): void {
    validateRepoName(record.repo, "repo");
    if (!/^finding:[a-f0-9]{64}$/.test(record.fingerprint)) {
      throw new Error("finding outcome label fingerprint must match finding:<64-hex>");
    }
    if (!Number.isInteger(record.pullNumber) || record.pullNumber < 1) throw new Error("pullNumber must be a positive integer");
    if (!Number.isFinite(record.confidence) || record.confidence < 0 || record.confidence > 1) {
      throw new Error("confidence must be a number from 0 to 1");
    }
    // Idempotent (#286 PR A): re-observing the same finding on the same head UPSERTs, so a re-run
    // never accumulates duplicate labels. evidence_ref is redacted before it can reach evidence.
    this.db
      .prepare(
        `insert or replace into finding_outcome_labels
          (fingerprint, repo, pull_number, head_sha, severity, category, confidence,
           label_source, verdict, observed_at, evidence_ref)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.fingerprint,
        record.repo,
        record.pullNumber,
        record.headSha,
        record.severity,
        record.category,
        record.confidence,
        record.labelSource,
        record.verdict,
        record.observedAt,
        record.evidenceRef ? redactSecrets(record.evidenceRef).trim() : null
      );
  }

  hasFindingOutcomeLabel(fingerprint: string, repo: string, pullNumber: number, headSha: string): boolean {
    const row = this.db
      .prepare("select 1 from finding_outcome_labels where fingerprint = ? and repo = ? and pull_number = ? and head_sha = ? limit 1")
      .get(fingerprint, repo, pullNumber, headSha);
    return Boolean(row);
  }

  listFindingOutcomeLabels(input: { repo?: string } = {}): FindingOutcomeLabelRecord[] {
    const rows = (input.repo
      ? this.db
          .prepare(
            `select fingerprint, repo, pull_number, head_sha, severity, category, confidence,
                    label_source, verdict, observed_at, evidence_ref
             from finding_outcome_labels where repo = ? order by datetime(observed_at) desc`
          )
          .all(input.repo)
      : this.db
          .prepare(
            `select fingerprint, repo, pull_number, head_sha, severity, category, confidence,
                    label_source, verdict, observed_at, evidence_ref
             from finding_outcome_labels order by datetime(observed_at) desc`
          )
          .all()) as unknown as FindingOutcomeLabelRow[];
    return rows.map(mapFindingOutcomeLabelRow);
  }

  /**
   * Best-effort atomic write of posted-finding coordinates (#357). All rows land or none do (one
   * BEGIN IMMEDIATE txn). Callers at the review-post seam MUST wrap this so a throw never blocks the
   * review — this is benign posting bookkeeping, never a gate on posting.
   */
  recordReviewFindings(records: ReviewFindingRecord[]): void {
    if (records.length === 0) return;
    this.db.exec("begin immediate");
    try {
      for (const record of records) this.writeReviewFinding(record);
      this.db.exec("commit");
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
  }

  private writeReviewFinding(record: ReviewFindingRecord): void {
    validateRepoName(record.repo, "repo");
    if (!/^finding:[a-f0-9]{64}$/.test(record.fingerprint)) {
      throw new Error("review finding fingerprint must match finding:<64-hex>");
    }
    if (!Number.isInteger(record.pullNumber) || record.pullNumber < 1) throw new Error("pullNumber must be a positive integer");
    if (!Number.isInteger(record.line) || record.line < 1) throw new Error("line must be a positive integer");
    if (!Number.isFinite(record.confidence) || record.confidence < 0 || record.confidence > 1) {
      throw new Error("confidence must be a number from 0 to 1");
    }
    // Idempotent: re-posting the same head UPSERTs. path is public (already posted); redact defensively.
    this.db
      .prepare(
        `insert or replace into review_findings
          (fingerprint, repo, pull_number, head_sha, path, line, severity, category, confidence, recorded_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.fingerprint,
        record.repo,
        record.pullNumber,
        record.headSha,
        redactSecrets(record.path).trim(),
        record.line,
        record.severity,
        record.category,
        record.confidence,
        record.recordedAt
      );
  }

  /**
   * List recorded review findings (#357), newest first, optionally scoped by repo and to those
   * recorded on/after `since` (the lookback window). Used by the daemon observe pass to reconstruct
   * ObservedFinding candidates.
   */
  listReviewFindings(input: { repo?: string; since?: string } = {}): ReviewFindingRecord[] {
    const predicates: string[] = [];
    const params: Array<string> = [];
    if (input.repo) { predicates.push("repo = ?"); params.push(input.repo); }
    if (input.since) { predicates.push("datetime(recorded_at) >= datetime(?)"); params.push(input.since); }
    const where = predicates.length ? `where ${predicates.join(" and ")}` : "";
    const rows = this.db
      .prepare(
        `select fingerprint, repo, pull_number, head_sha, path, line, severity, category, confidence, recorded_at
         from review_findings ${where} order by datetime(recorded_at) desc`
      )
      .all(...params) as unknown as ReviewFindingRow[];
    return rows.map(mapReviewFindingRow);
  }

  /** Last calibration observe-pass timestamp for a scope (#357): "__global__" for the interval gate,
   * a repo slug for per-repo cooldown. Undefined ⇒ never observed. */
  getCalibrationObserveAt(scope: string): string | undefined {
    const row = this.db
      .prepare("select observed_at from calibration_observe_runs where scope = ? limit 1")
      .get(scope) as { observed_at: string } | undefined;
    return row?.observed_at;
  }

  recordCalibrationObserveAt(scope: string, observedAt: string): void {
    this.db
      .prepare("insert or replace into calibration_observe_runs (scope, observed_at) values (?, ?)")
      .run(scope, observedAt);
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

  recordIssueEnrichment(input: RecordIssueEnrichmentInput): IssueEnrichmentRecord {
    validateIssueEnrichmentInput(input);
    const existing = this.getIssueEnrichmentRecord(input.repo, input.issueNumber);
    const nowIso = (input.now ?? new Date()).toISOString();
    const reason = input.reason ? redactSecrets(input.reason).trim().slice(0, 500) : undefined;
    const bodyHash = input.bodyHash ? input.bodyHash.trim().toLowerCase() : undefined;
    const commentUrl = input.commentUrl ? redactSecrets(input.commentUrl).trim().slice(0, 500) : undefined;
    const error = input.error ? redactSecrets(input.error).trim().slice(0, 1_000) : undefined;
    const nextEligibleAt = input.nextEligibleAt ? new Date(Date.parse(input.nextEligibleAt)).toISOString() : undefined;
    this.db
      .prepare(
        `insert into issue_enrichment_records
          (repo, issue_number, issue_updated_at, body_hash, status, reason, comment_url, error,
           next_eligible_at, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         on conflict(repo, issue_number) do update set
           issue_updated_at = excluded.issue_updated_at,
           body_hash = excluded.body_hash,
           status = excluded.status,
           reason = excluded.reason,
           comment_url = excluded.comment_url,
           error = excluded.error,
           next_eligible_at = excluded.next_eligible_at,
           updated_at = excluded.updated_at`
      )
      .run(
        input.repo,
        input.issueNumber,
        input.issueUpdatedAt ?? null,
        bodyHash ?? null,
        input.status,
        reason ?? null,
        commentUrl ?? null,
        error ?? null,
        nextEligibleAt ?? null,
        existing?.createdAt ?? nowIso,
        nowIso
      );
    return this.getIssueEnrichmentRecord(input.repo, input.issueNumber)!;
  }

  getIssueEnrichmentRecord(repo: string, issueNumber: number): IssueEnrichmentRecord | undefined {
    validateRepoIssue(repo, issueNumber);
    const row = this.db
      .prepare(
        `select repo, issue_number, issue_updated_at, body_hash, status, reason, comment_url, error,
                next_eligible_at, created_at, updated_at
         from issue_enrichment_records
         where repo = ? and issue_number = ?
         limit 1`
      )
      .get(repo, issueNumber) as IssueEnrichmentRecordRow | undefined;
    return row ? mapIssueEnrichmentRecordRow(row) : undefined;
  }

  listIssueEnrichmentRecords(input: {
    repo?: string;
    status?: IssueEnrichmentRecordStatus;
    statuses?: IssueEnrichmentRecordStatus[];
    limit?: number;
  } = {}): IssueEnrichmentRecord[] {
    if (input.repo) validateRepoName(input.repo, "repo");
    if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1)) {
      throw new Error("limit must be a positive integer");
    }
    const statuses = input.statuses ?? (input.status ? [input.status] : undefined);
    if (statuses?.length) statuses.forEach((status) => validateIssueEnrichmentStatus(status));
    const predicates: string[] = [];
    const params: Array<string | number> = [];
    if (input.repo) {
      predicates.push("repo = ?");
      params.push(input.repo);
    }
    if (statuses?.length) {
      predicates.push(`status in (${statuses.map(() => "?").join(", ")})`);
      params.push(...statuses);
    }
    const where = predicates.length ? `where ${predicates.join(" and ")}` : "";
    const limit = input.limit ? " limit ?" : "";
    if (input.limit) params.push(input.limit);
    const rows = this.db
      .prepare(
        `select repo, issue_number, issue_updated_at, body_hash, status, reason, comment_url, error,
                next_eligible_at, created_at, updated_at
         from issue_enrichment_records
         ${where}
         order by datetime(updated_at) desc
         ${limit}`
      )
      .all(...params) as unknown as IssueEnrichmentRecordRow[];
    return rows.map(mapIssueEnrichmentRecordRow);
  }

  recordIssueEnrichmentRepoWatermark(input: RecordIssueEnrichmentRepoWatermarkInput): IssueEnrichmentRepoWatermark {
    validateIssueEnrichmentRepoWatermarkInput(input);
    const existing = this.getIssueEnrichmentRepoWatermark(input.repo);
    const nowIso = (input.now ?? new Date()).toISOString();
    this.db
      .prepare(
        `insert into issue_enrichment_repo_watermarks
          (repo, activated_at, last_checked_at, created_at, updated_at)
         values (?, ?, ?, ?, ?)
         on conflict(repo) do update set
           last_checked_at = excluded.last_checked_at,
           updated_at = excluded.updated_at`
      )
      .run(
        input.repo,
        existing?.activatedAt ?? input.activatedAt,
        input.lastCheckedAt,
        existing?.createdAt ?? nowIso,
        nowIso
      );
    return this.getIssueEnrichmentRepoWatermark(input.repo)!;
  }

  getIssueEnrichmentRepoWatermark(repo: string): IssueEnrichmentRepoWatermark | undefined {
    validateRepoName(repo, "repo");
    const row = this.db
      .prepare(
        `select repo, activated_at, last_checked_at, created_at, updated_at
         from issue_enrichment_repo_watermarks
         where repo = ?
         limit 1`
      )
      .get(repo) as IssueEnrichmentRepoWatermarkRow | undefined;
    return row ? mapIssueEnrichmentRepoWatermarkRow(row) : undefined;
  }

  retireFailedReview(input: RetireFailedReviewInput): StoredProcessedReviewRecord {
    const existing = this.getProcessedReview(input.repo, input.pullNumber, input.headSha);
    if (!existing) {
      throw new Error(`Refusing to retire missing review row for ${input.repo}#${input.pullNumber}@${input.headSha}`);
    }
    if (existing.status !== "failed") {
      if (existing.status === "skipped" && existing.error?.startsWith("retired_failed_head:")) {
        this.retireFailedReviewQueueJobs({
          repo: input.repo,
          pullNumber: input.pullNumber,
          headSha: input.headSha,
          retiredError: existing.error
        });
        return existing;
      }
      throw new Error(
        `Refusing to retire ${input.repo}#${input.pullNumber}@${input.headSha}: status is ${existing.status}, not failed`
      );
    }

    const reason = normalizeRetirementReason(input.reason);
    const retiredError = buildRetiredFailedHeadError({ reason, previousError: existing.error });
    this.recordProcessed({
      repo: input.repo,
      pullNumber: input.pullNumber,
      headSha: input.headSha,
      status: "skipped",
      error: retiredError
    });
    this.retireFailedReviewQueueJobs({
      repo: input.repo,
      pullNumber: input.pullNumber,
      headSha: input.headSha,
      retiredError
    });
    return this.getProcessedReview(input.repo, input.pullNumber, input.headSha)!;
  }

  private retireFailedReviewQueueJobs(input: {
    repo: string;
    pullNumber: number;
    headSha: string;
    retiredError: string;
  }): void {
    const nowIso = new Date().toISOString();
    this.db
      .prepare(
        `update review_queue_jobs
         set state = 'stale_retired',
             lease_id = null,
             lease_expires_at = null,
             last_error = ?,
             updated_at = ?,
             finished_at = coalesce(finished_at, ?)
         where repo = ?
           and pull_number = ?
           and head_sha = ?
           and state = 'failed'`
      )
      .run(input.retiredError, nowIso, nowIso, input.repo, input.pullNumber, input.headSha);
  }

  hasRepoActivation(repo: string): boolean {
    return Boolean(this.getRepoActivation(repo));
  }

  getRepoActivation(repo: string): RepoActivationRecord | undefined {
    const row = this.db
      .prepare(
        `select repo, activated_at, created_at
         from repo_activation_watermarks
         where repo = ?
         limit 1`
      )
      .get(repo) as RepoActivationRow | undefined;
    return row ? mapRepoActivationRow(row) : undefined;
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

  /**
   * Atomic per-head review claim (#295): defends the at-most-one-review-per-{repo,pr,head_sha}
   * invariant against the manual-review-pr vs daemon race (both passed the getProcessedReview read
   * window before either recordProcessed'd). The {repo, pull_number, head_sha} PRIMARY KEY makes the
   * INSERT a compare-and-set — exactly one concurrent caller wins; the loser gets undefined. Claims
   * are crash-safe two ways: a completed review retires the claim in recordProcessed (release-on-
   * success), reviewPull releases it in a finally (release-on-failure), and a TTL backstop sweeps
   * claims whose holder died mid-review — mirroring the review_run_leases TTL idiom.
   */
  tryClaimReviewHead(input: {
    repo: string;
    pullNumber: number;
    headSha: string;
    claimTtlMs: number;
    now?: Date;
    ownerPid?: number;
  }): ReviewHeadClaim | undefined {
    if (!Number.isInteger(input.claimTtlMs)) throw new Error("claimTtlMs must be an integer");
    if (input.claimTtlMs < 1) throw new Error("claimTtlMs must be at least 1");
    const ownerPid = input.ownerPid ?? process.pid;
    if (!Number.isInteger(ownerPid) || ownerPid < 1) throw new Error("ownerPid must be a positive integer");

    const now = input.now ?? new Date();
    const claimId = randomUUID();
    const claimedAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + input.claimTtlMs).toISOString();
    this.db.exec("begin immediate");
    try {
      // TTL backstop: sweep this head's claim if a prior holder died mid-review without releasing.
      this.db
        .prepare("delete from review_head_claims where repo = ? and pull_number = ? and head_sha = ? and expires_at <= ?")
        .run(input.repo, input.pullNumber, input.headSha, claimedAt);
      const existing = this.db
        .prepare("select claim_id from review_head_claims where repo = ? and pull_number = ? and head_sha = ? limit 1")
        .get(input.repo, input.pullNumber, input.headSha) as { claim_id: string } | undefined;
      if (existing) {
        this.db.exec("commit");
        return undefined;
      }
      this.db
        .prepare(
          "insert into review_head_claims (repo, pull_number, head_sha, claim_id, owner_pid, claimed_at, expires_at) values (?, ?, ?, ?, ?, ?, ?)"
        )
        .run(input.repo, input.pullNumber, input.headSha, claimId, ownerPid, claimedAt, expiresAt);
      this.db.exec("commit");
      return { claimId, expiresAt, ownerPid };
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
  }

  releaseReviewHeadClaim(claimId: string): void {
    this.db.prepare("delete from review_head_claims where claim_id = ?").run(claimId);
  }

  /**
   * Atomic public-command rate limit (#345), keyed per {repo, pr, head_sha, author, action}. Returns
   * true (allowed) and records the invocation when no prior invocation for the tuple falls within the
   * cooldown window; returns false (cooled-down) without recording otherwise. Consult-and-record run
   * inside one BEGIN IMMEDIATE transaction (the #295 CAS idiom) so two concurrent public commands on
   * the same tuple can never both pass. The window is per exact head SHA, so a genuinely new push is
   * never blocked by a prior head's invocation.
   */
  tryRecordPublicCommandInvocation(input: {
    repo: string;
    pullNumber: number;
    headSha: string;
    author: string;
    action: string;
    cooldownMs: number;
    now?: Date;
  }): boolean {
    if (!Number.isInteger(input.cooldownMs) || input.cooldownMs < 1) throw new Error("cooldownMs must be a positive integer");
    const now = input.now ?? new Date();
    const invokedAt = now.toISOString();
    const windowStart = new Date(now.getTime() - input.cooldownMs).toISOString();
    this.db.exec("begin immediate");
    try {
      const existing = this.db
        .prepare(
          `select invoked_at from public_command_invocations
           where repo = ? and pull_number = ? and head_sha = ? and author = ? and action = ?
             and datetime(invoked_at) > datetime(?)
           limit 1`
        )
        .get(input.repo, input.pullNumber, input.headSha, input.author, input.action, windowStart);
      if (existing) {
        this.db.exec("commit");
        return false;
      }
      this.db
        .prepare(
          `insert or replace into public_command_invocations
            (repo, pull_number, head_sha, author, action, invoked_at)
           values (?, ?, ?, ?, ?, ?)`
        )
        .run(input.repo, input.pullNumber, input.headSha, input.author, input.action, invokedAt);
      this.db.exec("commit");
      return true;
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
  }

  /** Atomically consumes one explicit trusted-owner authorization for an exact review head. */
  tryConsumeReviewEventAuthorization(input: ReviewEventAuthorizationConsumptionInput): boolean {
    validateReviewEventAuthorizationConsumption(input);
    const result = this.db
      .prepare(
        `insert into review_event_authorization_consumptions
          (repo, pull_number, head_sha, comment_id, author, consumed_at)
         values (?, ?, ?, ?, ?, ?)
         on conflict(repo, pull_number, head_sha) do nothing`
      )
      .run(
        input.repo,
        input.pullNumber,
        input.headSha.toLowerCase(),
        input.commentId,
        input.author,
        (input.now ?? new Date()).toISOString()
      );
    return Number(result.changes) === 1;
  }

  tryAcquireIssueEnrichmentRunLease(
    maxActiveRuns: number,
    leaseTtlMs: number,
    now = new Date(),
    ownerPid = process.pid
  ): IssueEnrichmentRunLease | undefined {
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
      // Issue-enrichment leases intentionally use TTL-only lazy cleanup: expired rows are swept on the next acquire
      // or by the confirm-gated clear-issue-enrichment-leases operator command.
      this.db.prepare("delete from issue_enrichment_run_leases where expires_at <= ?").run(startedAt);
      const row = this.db.prepare("select count(*) as count from issue_enrichment_run_leases").get() as { count: number };
      if (row.count >= maxActiveRuns) {
        this.db.exec("commit");
        return undefined;
      }
      this.db
        .prepare("insert into issue_enrichment_run_leases (lease_id, started_at, expires_at, owner_pid) values (?, ?, ?, ?)")
        .run(leaseId, startedAt, expiresAt, ownerPid);
      this.db.exec("commit");
      return { leaseId, expiresAt, ownerPid };
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
  }

  releaseIssueEnrichmentRunLease(leaseId: string): void {
    this.db.prepare("delete from issue_enrichment_run_leases where lease_id = ?").run(leaseId);
  }

  clearIssueEnrichmentRunLeases(input: { now?: Date; expiredOnly?: boolean; dryRun?: boolean } = {}): ClearIssueEnrichmentRunLeasesResult {
    const checkedAt = (input.now ?? new Date()).toISOString();
    const expiredOnly = input.expiredOnly ?? false;
    const dryRun = input.dryRun ?? true;
    const params: [string] | [] = expiredOnly ? [checkedAt] : [];
    const whereClause = expiredOnly ? " where expires_at <= ?" : "";
    this.db.exec("begin immediate");
    try {
      const rows = this.db
        .prepare(`select lease_id as leaseId, expires_at as expiresAt, owner_pid as ownerPid from issue_enrichment_run_leases${whereClause} order by expires_at asc`)
        .all(...params) as unknown as IssueEnrichmentRunLease[];
      const leases = rows.map((lease) => ({
        ...lease,
        expired: lease.expiresAt <= checkedAt
      }));
      const matched = leases.length;
      const expiredMatched = leases.filter((lease) => lease.expired).length;
      const activeMatched = matched - expiredMatched;
      const deleted = dryRun
        ? 0
        : Number(this.db.prepare(`delete from issue_enrichment_run_leases${whereClause}`).run(...params).changes);
      this.db.exec("commit");
      return { checkedAt, expiredOnly, dryRun, matched, expiredMatched, activeMatched, deleted, leases };
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
  }

  clearReviewQueueLeases(input: {
    now?: Date;
    leaseTtlMs?: number;
    expiredOnly?: boolean;
    dryRun?: boolean;
    repo?: string;
    pullNumber?: number;
    jobId?: string;
    forceActive?: boolean;
  } = {}): ClearReviewQueueLeasesResult {
    const checkedAt = (input.now ?? new Date()).toISOString();
    const expiredOnly = input.expiredOnly ?? true;
    const dryRun = input.dryRun ?? true;
    const forceActive = input.forceActive ?? false;
    const leaseTtlMs = input.leaseTtlMs ?? 15 * 60_000;
    validatePositiveQueueLimit(leaseTtlMs, "leaseTtlMs");
    const checkedAtMs = Date.parse(checkedAt);

    this.db.exec("begin immediate");
    try {
	      const staleRunLeases = this.listReviewRunLeaseClearCandidates(checkedAt)
	        .filter((lease) => lease.staleReason);
	      const staleRunLeaseIds = new Set(staleRunLeases.map((lease) => lease.leaseId));
	      const jobs = this.listReviewQueueLeaseClearCandidates({
	        checkedAt,
	        checkedAtMs,
        leaseTtlMs,
        expiredOnly,
        forceActive,
        staleRunLeaseIds,
        repo: input.repo,
	        pullNumber: input.pullNumber,
	        jobId: input.jobId
	      });
	      const hasQueueFilters = Boolean(input.repo || input.pullNumber !== undefined || input.jobId);
	      const scopedJobLeaseIds = new Set(jobs.map((job) => job.leaseId).filter((leaseId): leaseId is string => Boolean(leaseId)));
	      const runLeases = hasQueueFilters
	        ? staleRunLeases.filter((lease) => scopedJobLeaseIds.has(lease.leaseId))
	        : staleRunLeases;
	      const matched = jobs.length + runLeases.length;
	      const expiredMatched =
	        jobs.filter((job) => job.expired).length +
	        runLeases.length;
      const activeMatched = matched - expiredMatched;
      let requeued = 0;
      let deletedRunLeases = 0;

      if (!dryRun) {
        for (const job of jobs) {
          const result = this.db
            .prepare(
              `update review_queue_jobs
               set state = 'queued',
                   lease_id = null,
                   lease_expires_at = null,
                   last_error = ?,
                   updated_at = ?
               where job_id = ?
                 and state in ('leased', 'running')`
            )
            .run(
              `queue_lease_operator_requeued:${job.staleReason ?? "matched"}`,
              checkedAt,
              job.jobId
            );
          requeued += Number(result.changes);
        }
        for (const lease of runLeases) {
          deletedRunLeases += Number(
            this.db.prepare("delete from review_run_leases where lease_id = ?").run(lease.leaseId).changes
          );
        }
      }

      this.db.exec("commit");
      return {
        checkedAt,
        expiredOnly,
        dryRun,
        filters: {
          ...(input.repo ? { repo: input.repo } : {}),
          ...(input.pullNumber !== undefined ? { pullNumber: input.pullNumber } : {}),
          ...(input.jobId ? { jobId: input.jobId } : {})
        },
        matched,
        expiredMatched,
        activeMatched,
        requeued,
        deletedRunLeases,
        jobs,
        runLeases
      };
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
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
    maxRepoActiveByRepo?: Record<string, number>;
    manualCommandReserve?: number;
    excludeJobIds?: Iterable<string>;
    reservedActiveJobs?: Iterable<Pick<ReviewQueueJobRecord, "jobId" | "providerId" | "org" | "repo">>;
    limit?: number;
    leaseTtlMs?: number;
    aging?: { enabled: boolean; maxWaitMinutes: number };
    now?: Date;
  }): ReviewQueueJobRecord[] {
    validatePositiveQueueLimit(input.maxProviderActive, "maxProviderActive");
    validatePositiveQueueLimit(input.maxOrgActive, "maxOrgActive");
    validatePositiveQueueLimit(input.maxRepoActive, "maxRepoActive");
    const maxRepoActiveByRepo = normalizeRepoActiveLimitOverrides(input.maxRepoActiveByRepo);
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
    const excludeJobIds = new Set(input.excludeJobIds ?? []);
    const reservedActiveJobs = Array.from(input.reservedActiveJobs ?? []);
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
        .filter((job) => !excludeJobIds.has(job.jobId) && isQueueJobEligible(job, nowIso))
        .sort(buildLeaseComparator(input.aging, nowIso));
      const reservedJobIds = new Set(reservedActiveJobs.map((job) => job.jobId));
      const active = [
        ...jobs.filter((job) => (job.state === "leased" || job.state === "running") && !reservedJobIds.has(job.jobId)),
        ...reservedActiveJobs
      ];
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
        const repoActiveLimit = maxRepoActiveByRepo.get(job.repo.toLowerCase()) ?? input.maxRepoActive;
        if ((repoActive.get(job.repo) ?? 0) >= repoActiveLimit) continue;
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
             set state = 'leased',
                 lease_id = ?,
                 lease_expires_at = ?,
                 last_error = case
                   when state = 'blocked_on_proof' and (last_error is null or last_error not like '%blocked_on_proof%')
                     then 'blocked_on_proof; ' || coalesce(last_error, '')
                   else last_error
                 end,
                 updated_at = ?
             where job_id = ? and state in ('queued', 'provider_deferred', 'blocked_on_proof')`
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
      input.state === "provider_deferred" ||
      input.state === "blocked_on_proof"
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

  updateReviewQueueJobPriority(input: {
    jobId: string;
    priority: number;
    now?: Date;
  }): ReviewQueueJobRecord {
    const existing = this.getReviewQueueJob(input.jobId);
    if (!existing) throw new Error(`No review queue job for jobId ${input.jobId}`);
    validateReviewQueueInput(existing.repo, existing.pullNumber, existing.headSha, input.priority, existing.commentId);
    const nowIso = (input.now ?? new Date()).toISOString();
    this.db
      .prepare(
        `update review_queue_jobs
         set priority = ?,
             updated_at = ?
         where job_id = ?`
      )
      .run(input.priority, nowIso, input.jobId);
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
           and state in ('queued', 'leased', 'running', 'provider_deferred', 'blocked_on_proof')
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

  reconcileReviewerSessions(now = new Date(), repo?: string): { expired: number; failedDeadWorkers: number } {
    const expired = this.expireReviewerSessions(now, repo);
    const rows = (repo
      ? this.db
          .prepare(
            `select session_id, worker_pid
             from reviewer_sessions
             where repo = ?
               and state in ('warming', 'active', 'draining')
               and worker_pid is not null`
          )
          .all(repo)
      : this.db
          .prepare(
            `select session_id, worker_pid
             from reviewer_sessions
             where state in ('warming', 'active', 'draining')
               and worker_pid is not null`
          )
          .all()) as unknown as Array<{ session_id: string; worker_pid: number | null }>;

    let failedDeadWorkers = 0;
    for (const row of rows) {
      if (row.worker_pid === null || isProcessAlive(row.worker_pid)) continue;
      const result = this.db
        .prepare("update reviewer_sessions set state = 'failed', last_error = ? where session_id = ?")
        .run(`owner_pid_not_alive:${row.worker_pid}`, row.session_id);
      failedDeadWorkers += Number(result.changes);
    }
    return { expired, failedDeadWorkers };
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

  private listReviewRunLeaseClearCandidates(checkedAt: string): ReviewRunLeaseClearCandidate[] {
    const rows = this.db
      .prepare("select lease_id, started_at, expires_at, owner_pid from review_run_leases order by datetime(expires_at) asc")
      .all() as unknown as Array<{
        lease_id: string;
        expires_at: string;
        owner_pid: number | null;
      }>;
    const checkedAtMs = Date.parse(checkedAt);
    return rows.map((row) => {
      const expiresAtMs = Date.parse(row.expires_at);
      const expired = !Number.isFinite(expiresAtMs) || (Number.isFinite(checkedAtMs) && expiresAtMs <= checkedAtMs);
      const ownerAlive = row.owner_pid === null ? false : isProcessAlive(row.owner_pid);
      const staleReason = ownerAlive === false
        ? "owner_not_running"
        : expired
          ? "expired"
          : undefined;
      return {
        leaseId: row.lease_id,
        expiresAt: row.expires_at,
        ownerPid: row.owner_pid ?? 0,
        expired,
        ownerAlive,
        ...(staleReason ? { staleReason } : {})
      };
    });
  }

  private listReviewQueueLeaseClearCandidates(input: {
    checkedAt: string;
    checkedAtMs: number;
    leaseTtlMs: number;
    expiredOnly: boolean;
    forceActive: boolean;
    staleRunLeaseIds: Set<string>;
    repo?: string;
    pullNumber?: number;
    jobId?: string;
  }): ReviewQueueLeaseClearCandidate[] {
    return this.listReviewQueueJobs({ states: ["leased", "running"] })
      .filter((job) => !input.repo || job.repo === input.repo)
      .filter((job) => input.pullNumber === undefined || job.pullNumber === input.pullNumber)
      .filter((job) => !input.jobId || job.jobId === input.jobId)
      .map((job) => {
        const leaseExpiresAtMs = job.leaseExpiresAt ? Date.parse(job.leaseExpiresAt) : Number.NaN;
        const updatedAtMs = Date.parse(job.updatedAt);
        const legacyLeaseCutoffMs = input.checkedAtMs - input.leaseTtlMs;
        const expiredByLeaseExpiry = job.leaseExpiresAt
          ? !Number.isFinite(leaseExpiresAtMs) ||
            (Number.isFinite(input.checkedAtMs) && leaseExpiresAtMs <= input.checkedAtMs)
          : !Number.isFinite(updatedAtMs) ||
            (Number.isFinite(input.checkedAtMs) && updatedAtMs <= legacyLeaseCutoffMs);
        const expiredByStaleRunLease = Boolean(job.leaseId && input.staleRunLeaseIds.has(job.leaseId));
        const expired =
          expiredByLeaseExpiry ||
          expiredByStaleRunLease;
        const staleReason: ReviewQueueLeaseClearCandidate["staleReason"] = !job.leaseExpiresAt && expiredByLeaseExpiry
          ? "missing_lease_expiry"
          : expired
            ? "expired"
            : input.forceActive && !input.expiredOnly
              ? "forced_active"
              : undefined;
        return {
          ...job,
          expired,
          active: !expired,
          ...(staleReason ? { staleReason } : {})
        };
      })
      .filter((job) => job.expired || (!input.expiredOnly && input.forceActive));
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

  recordFinishingTouchDraft(input: RecordFinishingTouchDraftInput): FinishingTouchDraftRecord {
    validateRepoName(input.repo, "repo");
    validatePullAndCommand(input.pullNumber, input.commandCommentId);
    const trigger = redactSecrets(input.trigger).trim().slice(0, 2_000);
    const author = redactSecrets(input.author).trim().slice(0, 100);
    if (!trigger) throw new Error("trigger must be a non-empty string");
    if (!author) throw new Error("author must be a non-empty string");
    const proposedOutputJson = JSON.stringify(input.proposedOutput);
    if (!proposedOutputJson) throw new Error("proposedOutput must be JSON-serializable");
    if (containsSecretLikeText([input.repo, input.headSha, input.action, author, trigger, proposedOutputJson].join("\n"))) {
      throw new Error("Refusing to store finishing-touch draft: secret-like text detected");
    }
    const nowIso = (input.now ?? new Date()).toISOString();
    const outputSha = createHash("sha256").update(proposedOutputJson).digest("hex");
    const existing = this.getFinishingTouchDraft({
      repo: input.repo,
      pullNumber: input.pullNumber,
      headSha: input.headSha,
      commandCommentId: input.commandCommentId
    });
    this.db
      .prepare(
        `insert or replace into finishing_touch_drafts
          (repo, pull_number, head_sha, command_comment_id, action, author, trigger, status,
           proposed_output_json, output_sha, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.repo,
        input.pullNumber,
        input.headSha,
        input.commandCommentId,
        input.action,
        author,
        trigger,
        input.status,
        proposedOutputJson,
        outputSha,
        existing?.createdAt ?? nowIso,
        nowIso
      );
    return this.getFinishingTouchDraft({
      repo: input.repo,
      pullNumber: input.pullNumber,
      headSha: input.headSha,
      commandCommentId: input.commandCommentId
    })!;
  }

  getFinishingTouchDraft(input: GetFinishingTouchDraftInput): FinishingTouchDraftRecord | undefined {
    validateRepoName(input.repo, "repo");
    validatePullAndCommand(input.pullNumber, input.commandCommentId);
    const row = this.db
      .prepare(
        `select repo, pull_number, head_sha, command_comment_id, action, author, trigger, status,
                proposed_output_json, output_sha, created_at, updated_at
         from finishing_touch_drafts
         where repo = ?
           and pull_number = ?
           and head_sha = ?
           and command_comment_id = ?
         limit 1`
      )
      .get(input.repo, input.pullNumber, input.headSha, input.commandCommentId) as
        | FinishingTouchDraftRow
        | undefined;
    return row ? mapFinishingTouchDraftRow(row) : undefined;
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
          (note_id, repo, kind, title, body, source, confidence, fingerprint,
           coarse_path, coarse_category, coarse_line, coarse_title, confirmed_by_human,
           created_at, updated_at, expires_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         on conflict(repo, note_id) do update set
           kind = excluded.kind,
           title = excluded.title,
           body = excluded.body,
           source = excluded.source,
           confidence = excluded.confidence,
           fingerprint = excluded.fingerprint,
           coarse_path = excluded.coarse_path,
           coarse_category = excluded.coarse_category,
           coarse_line = excluded.coarse_line,
           coarse_title = excluded.coarse_title,
           confirmed_by_human = excluded.confirmed_by_human,
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
        input.coarsePath ? redactSecrets(input.coarsePath).trim() : null,
        input.coarseCategory ?? null,
        input.coarseLine ?? null,
        input.coarseTitle ? redactSecrets(input.coarseTitle).trim() : null,
        input.confirmedByHuman === undefined ? null : input.confirmedByHuman ? 1 : 0,
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
        `select note_id, repo, kind, title, body, source, confidence, fingerprint,
                coarse_path, coarse_category, coarse_line, coarse_title, confirmed_by_human,
                created_at, updated_at, expires_at
         from repo_memory_notes
         where repo = ? and note_id = ?
         limit 1`
      )
      .get(repo, noteId) as RepoMemoryNoteRow | undefined;
    return row ? mapRepoMemoryNoteRow(row) : undefined;
  }

  listRepoMemoryNotes(input: ListRepoMemoryNotesInput): RepoMemoryNoteRecord[] {
    return listRepoMemoryNotesFromDb(this.db, input);
  }

  recordRepoMemoryPacketBuild(record: RepoMemoryPacketBuildRecord): void {
    validateRepoName(record.repo, "repo");
    if (!/^[a-f0-9]{64}$/.test(record.packetSha)) throw new Error("packetSha must be a SHA-256 hex digest");
    if (!record.packetVersion.trim()) throw new Error("packetVersion must be non-empty");
    if (!isCanonicalIsoTimestamp(record.generatedAt)) throw new Error("generatedAt must be a canonical ISO timestamp");
    if (!Number.isInteger(record.byteEstimate) || record.byteEstimate < 1) throw new Error("byteEstimate must be a positive integer");
    if (!Number.isInteger(record.tokenEstimate) || record.tokenEstimate < 1) throw new Error("tokenEstimate must be a positive integer");
    if (!Array.isArray(record.includedNoteIds)) throw new Error("includedNoteIds must be an array");
    for (const noteId of record.includedNoteIds) {
      if (typeof noteId !== "string" || !noteId.trim()) throw new Error("includedNoteIds must contain non-empty strings");
      if (/[\r\n]/.test(noteId)) throw new Error("includedNoteIds must not contain newlines");
    }
    if (record.redactionStatus !== "passed" && record.redactionStatus !== "failed") {
      throw new Error("redactionStatus must be passed or failed");
    }
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

  private ensureIssueEnrichmentBodyHashColumn(): void {
    const columns = this.db.prepare("pragma table_info(issue_enrichment_records)").all() as unknown as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "body_hash")) {
      this.db.exec("alter table issue_enrichment_records add column body_hash text");
    }
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

  private ensureRepoMemoryNoteCoarseColumns(): void {
    // Additive migration (#302): older DBs gain the coarse false-positive-match columns; existing
    // rows keep NULLs and fall back to exact-only matching.
    const columns = this.db.prepare("pragma table_info(repo_memory_notes)").all() as unknown as Array<{ name: string }>;
    const names = new Set(columns.map((column) => column.name));
    if (!names.has("coarse_path")) this.db.exec("alter table repo_memory_notes add column coarse_path text");
    if (!names.has("coarse_category")) this.db.exec("alter table repo_memory_notes add column coarse_category text");
    if (!names.has("coarse_line")) this.db.exec("alter table repo_memory_notes add column coarse_line integer");
    if (!names.has("coarse_title")) this.db.exec("alter table repo_memory_notes add column coarse_title text");
    if (!names.has("confirmed_by_human")) this.db.exec("alter table repo_memory_notes add column confirmed_by_human integer");
  }
}

export function listRepoMemoryNotesReadOnly(dbPath: string, input: ListRepoMemoryNotesInput): RepoMemoryNoteRecord[] {
  if (!existsSync(dbPath)) return [];
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const table = db
      .prepare("select name from sqlite_master where type = 'table' and name = 'repo_memory_notes'")
      .get() as { name: string } | undefined;
    return table ? listRepoMemoryNotesFromDb(db, input) : [];
  } finally {
    db.close();
  }
}

function listRepoMemoryNotesFromDb(db: DatabaseSync, input: ListRepoMemoryNotesInput): RepoMemoryNoteRecord[] {
  validateRepoName(input.repo, "repo");
  if (input.limit !== undefined) validatePositiveQueueLimit(input.limit, "limit");
  if (input.kind && input.excludeKind) throw new Error("kind and excludeKind cannot both be set");
  if (input.kind) validateRepoMemoryNoteKind(input.kind, "kind");
  if (input.excludeKind) validateRepoMemoryNoteKind(input.excludeKind, "excludeKind");
  const params: Array<string | number> = [input.repo];
  const predicates = ["repo = ?"];
  if (input.kind) {
    predicates.push("kind = ?");
    params.push(input.kind);
  }
  if (input.excludeKind) {
    predicates.push("kind != ?");
    params.push(input.excludeKind);
  }
  if (input.includeExpired !== true) {
    predicates.push("(expires_at is null or datetime(expires_at) > datetime(?))");
    params.push((input.now ?? new Date()).toISOString());
  }
  const limit = input.limit ? " limit ?" : "";
  if (input.limit) params.push(input.limit);
  const rows = db
    .prepare(
      `select note_id, repo, kind, title, body, source, confidence, fingerprint,
              coarse_path, coarse_category, coarse_line, coarse_title, confirmed_by_human,
              created_at, updated_at, expires_at
       from repo_memory_notes
       where ${predicates.join(" and ")}
       order by datetime(updated_at) desc, note_id asc
       ${limit}`
    )
    .all(...params) as unknown as RepoMemoryNoteRow[];
  return rows.map(mapRepoMemoryNoteRow);
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

export function normalizeRetirementReason(reason: string): string {
  const normalized = reason
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9._-]+/g, "_")
    .replaceAll(/^_+|_+$/g, "")
    .slice(0, 80);
  return normalized || "operator_acknowledged";
}

export function buildRetiredFailedHeadError(input: { reason: string; previousError?: string }): string {
  const reason = normalizeRetirementReason(input.reason);
  const previousError = input.previousError ? `; previous_error=${redactSecrets(input.previousError)}` : "";
  return `retired_failed_head:${reason}${previousError}`;
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

function validatePullAndCommand(pullNumber: number, commandCommentId: number): void {
  if (!Number.isInteger(pullNumber) || pullNumber < 1) throw new Error("pullNumber must be a positive integer");
  if (!Number.isInteger(commandCommentId) || commandCommentId < 1) {
    throw new Error("commandCommentId must be a positive integer");
  }
}

function validateReviewEventAuthorizationConsumption(input: ReviewEventAuthorizationConsumptionInput): void {
  validateRepoName(input.repo, "repo");
  if (!/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(input.repo)) {
    throw new Error("repo must be an owner/repo name");
  }
  if (!Number.isInteger(input.pullNumber) || input.pullNumber < 1) throw new Error("pullNumber must be a positive integer");
  if (!Number.isInteger(input.commentId) || input.commentId < 1) throw new Error("commentId must be a positive integer");
  if (!/^[0-9a-f]{40}$/i.test(input.headSha)) {
    throw new Error("headSha must be a 40-character hexadecimal SHA");
  }
  if (!/^[A-Za-z0-9-]{1,39}$/.test(input.author)) {
    throw new Error("author must be a non-empty string");
  }
}

function validateIssueEnrichmentInput(input: RecordIssueEnrichmentInput): void {
  validateRepoIssue(input.repo, input.issueNumber);
  validateIssueEnrichmentStatus(input.status);
  if (input.issueUpdatedAt !== undefined && !isCanonicalIsoTimestamp(input.issueUpdatedAt)) {
    throw new Error("issueUpdatedAt must be a canonical ISO timestamp");
  }
  if (input.bodyHash !== undefined && !/^[0-9a-f]{64}$/i.test(input.bodyHash)) {
    throw new Error("bodyHash must be a 64-character hex digest");
  }
  if (input.nextEligibleAt !== undefined && !Number.isFinite(Date.parse(input.nextEligibleAt))) {
    throw new Error("nextEligibleAt must be an ISO timestamp");
  }
  if (input.now !== undefined && !Number.isFinite(input.now.getTime())) {
    throw new Error("now must be a valid Date");
  }
  const metadataText = [
    input.repo,
    String(input.issueNumber),
    input.issueUpdatedAt ?? "",
    input.bodyHash ?? "",
    input.reason ?? "",
    input.commentUrl ?? "",
    input.error ?? "",
    input.nextEligibleAt ?? ""
  ].join("\n");
  if (containsSecretLikeText(metadataText)) {
    throw new Error(`Refusing to store issue enrichment metadata for ${input.repo}#${input.issueNumber}: secret-like metadata detected`);
  }
}

function validateIssueEnrichmentRepoWatermarkInput(input: RecordIssueEnrichmentRepoWatermarkInput): void {
  validateRepoName(input.repo, "repo");
  if (!isCanonicalIsoTimestamp(input.activatedAt)) {
    throw new Error("activatedAt must be a canonical ISO timestamp");
  }
  if (!isCanonicalIsoTimestamp(input.lastCheckedAt)) {
    throw new Error("lastCheckedAt must be a canonical ISO timestamp");
  }
  if (input.now !== undefined && !Number.isFinite(input.now.getTime())) {
    throw new Error("now must be a valid Date");
  }
}

function validateIssueEnrichmentStatus(status: IssueEnrichmentRecordStatus): void {
  if (!["dry_run", "posted", "skipped", "deferred", "failed"].includes(status)) {
    throw new Error("status must be a valid issue enrichment status");
  }
}

function validateRepoIssue(repo: string, issueNumber: number): void {
  validateRepoName(repo, "repo");
  if (!Number.isInteger(issueNumber) || issueNumber < 1) throw new Error("issueNumber must be a positive integer");
}

function validateRepoMemoryNoteInput(input: RecordRepoMemoryNoteInput): void {
  if (!input.noteId.trim()) throw new Error("noteId must be non-empty");
  validateRepoName(input.repo, "repo");
  validateRepoMemoryNoteKind(input.kind, "kind");
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

function validateRepoMemoryNoteKind(kind: RepoMemoryNoteKind, label: string): void {
  if (!REPO_MEMORY_NOTE_KINDS.includes(kind)) {
    throw new Error(`${label} must be a valid repo memory note kind`);
  }
}

function isCanonicalIsoTimestamp(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
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

function normalizeRepoActiveLimitOverrides(value: Record<string, number> | undefined): Map<string, number> {
  const result = new Map<string, number>();
  if (!value) return result;
  for (const [repo, limit] of Object.entries(value)) {
    validateRepoName(repo, "maxRepoActiveByRepo");
    validatePositiveQueueLimit(limit, `maxRepoActiveByRepo.${repo}`);
    result.set(repo.toLowerCase(), limit);
  }
  return result;
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
  if (job.state !== "provider_deferred" && job.state !== "blocked_on_proof") return false;
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

/**
 * Lease-time aging via a two-tier RESCUE ordering (#346, amended). A queued job whose wait
 * (now − createdAt) exceeds maxWaitMinutes enters the RESCUE tier and leases AHEAD of every
 * non-rescued job regardless of priority class, FIFO among rescued jobs by createdAt (oldest first).
 * Non-rescued (fresh, sub-maxWait) jobs keep strict priority ordering exactly as today, so elevated
 * always wins among non-starved work. The ONLY thing that overtakes elevated is a job that already
 * waited the full maxWaitMinutes — the bounded anti-starvation backstop. Computed at lease time,
 * never stored, idempotent, no migration. Unset/disabled aging ⇒ the original comparator, byte-
 * identical to today.
 */
function isRescued(job: ReviewQueueJobRecord, aging: { enabled: boolean; maxWaitMinutes: number }, nowMs: number): boolean {
  return nowMs - Date.parse(job.createdAt) > aging.maxWaitMinutes * 60_000;
}

function buildLeaseComparator(
  aging: { enabled: boolean; maxWaitMinutes: number } | undefined,
  nowIso: string
): (left: ReviewQueueJobRecord, right: ReviewQueueJobRecord) => number {
  if (!aging?.enabled) return compareQueueJobsForLease;
  const nowMs = Date.parse(nowIso);
  return (left, right) => {
    const leftRescued = isRescued(left, aging, nowMs);
    const rightRescued = isRescued(right, aging, nowMs);
    // Rescued tier first; among rescued, oldest-enqueued leases first (FIFO).
    if (leftRescued !== rightRescued) return leftRescued ? -1 : 1;
    if (leftRescued) return Date.parse(left.createdAt) - Date.parse(right.createdAt);
    // Non-rescued: strict priority then FIFO within class — unchanged from today.
    return compareQueueJobsForLease(left, right);
  };
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
  const retryAttemptPart = rest.map((part) => part.trim()).find((part) => part.startsWith("retry_attempt="));
  const retryAttempt = parsePositiveInt(retryAttemptPart?.slice("retry_attempt=".length));
  const providerCodePart = rest.map((part) => part.trim()).find((part) => part.startsWith("provider_code="));
  const providerCode = providerCodePart?.slice("provider_code=".length).trim();
  const retryAfterPart = rest.map((part) => part.trim()).find((part) => part.startsWith("retry_after_ms="));
  const retryAfterMs = parsePositiveInt(retryAfterPart?.slice("retry_after_ms=".length));
  return {
    cooldownUntil,
    ...(reason ? { reason } : {}),
    ...(retryAttempt ? { retryAttempt } : {}),
    ...(providerCode ? { providerCode } : {}),
    ...(retryAfterMs ? { retryAfterMs } : {})
  };
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
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

interface FindingOutcomeLabelRow {
  fingerprint: string;
  repo: string;
  pull_number: number;
  head_sha: string;
  severity: string;
  category: string;
  confidence: number;
  label_source: FindingOutcomeLabelSource;
  verdict: FindingOutcomeVerdict;
  observed_at: string;
  evidence_ref: string | null;
}

interface ReviewFindingRow {
  fingerprint: string;
  repo: string;
  pull_number: number;
  head_sha: string;
  path: string;
  line: number;
  severity: string;
  category: string;
  confidence: number;
  recorded_at: string;
}

interface RepoActivationRow {
  repo: string;
  activated_at: string;
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
  coarse_path: string | null;
  coarse_category: string | null;
  coarse_line: number | null;
  coarse_title: string | null;
  confirmed_by_human: number | null;
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

interface IssueEnrichmentRecordRow {
  repo: string;
  issue_number: number;
  issue_updated_at: string | null;
  body_hash: string | null;
  status: IssueEnrichmentRecordStatus;
  reason: string | null;
  comment_url: string | null;
  error: string | null;
  next_eligible_at: string | null;
  created_at: string;
  updated_at: string;
}

interface IssueEnrichmentRepoWatermarkRow {
  repo: string;
  activated_at: string;
  last_checked_at: string;
  created_at: string;
  updated_at: string;
}

interface FinishingTouchDraftRow {
  repo: string;
  pull_number: number;
  head_sha: string;
  command_comment_id: number;
  action: FinishingTouchAction;
  author: string;
  trigger: string;
  status: FinishingTouchDraftStatus;
  proposed_output_json: string;
  output_sha: string;
  created_at: string;
  updated_at: string;
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

function mapFindingOutcomeLabelRow(row: FindingOutcomeLabelRow): FindingOutcomeLabelRecord {
  return {
    fingerprint: row.fingerprint,
    repo: row.repo,
    pullNumber: row.pull_number,
    headSha: row.head_sha,
    severity: row.severity,
    category: row.category,
    confidence: row.confidence,
    labelSource: row.label_source,
    verdict: row.verdict,
    observedAt: row.observed_at,
    ...(row.evidence_ref ? { evidenceRef: row.evidence_ref } : {})
  };
}

function mapReviewFindingRow(row: ReviewFindingRow): ReviewFindingRecord {
  return {
    fingerprint: row.fingerprint,
    repo: row.repo,
    pullNumber: row.pull_number,
    headSha: row.head_sha,
    path: row.path,
    line: row.line,
    severity: row.severity,
    category: row.category,
    confidence: row.confidence,
    recordedAt: row.recorded_at
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

function mapIssueEnrichmentRecordRow(row: IssueEnrichmentRecordRow): IssueEnrichmentRecord {
  return {
    repo: row.repo,
    issueNumber: row.issue_number,
    ...(row.issue_updated_at ? { issueUpdatedAt: row.issue_updated_at } : {}),
    ...(row.body_hash ? { bodyHash: row.body_hash } : {}),
    status: row.status,
    ...(row.reason ? { reason: row.reason } : {}),
    ...(row.comment_url ? { commentUrl: row.comment_url } : {}),
    ...(row.error ? { error: row.error } : {}),
    ...(row.next_eligible_at ? { nextEligibleAt: row.next_eligible_at } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapIssueEnrichmentRepoWatermarkRow(row: IssueEnrichmentRepoWatermarkRow): IssueEnrichmentRepoWatermark {
  return {
    repo: row.repo,
    activatedAt: row.activated_at,
    lastCheckedAt: row.last_checked_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapFinishingTouchDraftRow(row: FinishingTouchDraftRow): FinishingTouchDraftRecord {
  return {
    repo: row.repo,
    pullNumber: row.pull_number,
    headSha: row.head_sha,
    commandCommentId: row.command_comment_id,
    action: row.action,
    author: row.author,
    trigger: row.trigger,
    status: row.status,
    proposedOutput: parseStoredJson(row.proposed_output_json),
    outputSha: row.output_sha,
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

function mapRepoActivationRow(row: RepoActivationRow): RepoActivationRecord {
  return {
    repo: row.repo,
    activatedAt: row.activated_at,
    createdAt: row.created_at
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
    ...(row.coarse_path ? { coarsePath: row.coarse_path } : {}),
    ...(row.coarse_category ? { coarseCategory: row.coarse_category } : {}),
    ...(row.coarse_line !== null ? { coarseLine: row.coarse_line } : {}),
    ...(row.coarse_title ? { coarseTitle: row.coarse_title } : {}),
    ...(row.confirmed_by_human !== null ? { confirmedByHuman: row.confirmed_by_human === 1 } : {}),
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

function parseStoredJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
