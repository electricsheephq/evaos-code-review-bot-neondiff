import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { redactSecrets } from "./secrets.js";
import type { ReviewEvent } from "./types.js";

export type ProcessedStatus = "dry_run" | "posted" | "skipped" | "failed";
export type ProcessedCommandAction = "review" | "re-review" | "explain" | "stop";
export type ProcessedCommandStatus = "triggered" | "explained" | "stopped" | "ignored";

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
}

export interface RepoProviderCooldownRecord {
  repo: string;
  cooldownUntil: string;
  reason: string;
  updatedAt: string;
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
        expires_at text not null
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
    `);
    this.ensureDaemonHeartbeatColumns();
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

  tryAcquireReviewRunLease(maxActiveRuns: number, leaseTtlMs: number, now = new Date()): ReviewRunLease | undefined {
    if (!Number.isInteger(maxActiveRuns)) throw new Error("maxActiveRuns must be an integer");
    if (maxActiveRuns < 1) throw new Error("maxActiveRuns must be at least 1");
    if (!Number.isInteger(leaseTtlMs)) throw new Error("leaseTtlMs must be an integer");
    if (leaseTtlMs < 1) throw new Error("leaseTtlMs must be at least 1");

    const leaseId = randomUUID();
    const startedAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + leaseTtlMs).toISOString();
    this.db.exec("begin immediate");
    try {
      this.db.prepare("delete from review_run_leases where expires_at <= ?").run(startedAt);
      const row = this.db.prepare("select count(*) as count from review_run_leases").get() as { count: number };
      if (row.count >= maxActiveRuns) {
        this.db.exec("commit");
        return undefined;
      }
      this.db
        .prepare("insert into review_run_leases (lease_id, started_at, expires_at) values (?, ?, ?)")
        .run(leaseId, startedAt, expiresAt);
      this.db.exec("commit");
      return { leaseId, expiresAt };
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
  }

  releaseReviewRunLease(leaseId: string): void {
    this.db.prepare("delete from review_run_leases where lease_id = ?").run(leaseId);
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
