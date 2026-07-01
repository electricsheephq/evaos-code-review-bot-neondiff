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
    `);
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
