import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { isPreActivationExistingPull } from "./activation-policy.js";
import type { BotConfig } from "./config.js";
import { listReposToScan, resolveRepoProfile, type RepoProfileSkipReason } from "./repo-policy.js";
import {
  isActivationBaselineProcessedReview,
  parseProviderCooldownError,
  type RepoActivationRecord,
  type ReviewQueueJobState,
  type RepoProviderCooldownRecord,
  type StoredProcessedReviewRecord
} from "./state.js";
import { isCanaryAllowed } from "./worker.js";
import type { PullRequestSummary } from "./types.js";

export type CoverageSkipReason = RepoProfileSkipReason | "draft" | "closed" | "canary" | "activation_baseline_existing_pr";

export interface CoverageAuditSummary {
  reposScanned: number;
  pullsSeen: number;
  processed: number;
  providerDeferred: number;
  queued: number;
  unprocessed: number;
  skipped: number;
  staleHeads: number;
  readFailures: number;
}

export interface CoverageAuditPullEntry {
  repo: string;
  pullNumber: number;
  headSha: string;
  title: string;
  url: string;
  draft: boolean;
  state?: string;
}

export interface CoverageProcessedEntry extends CoverageAuditPullEntry {
  status: StoredProcessedReviewRecord["status"];
  event?: StoredProcessedReviewRecord["event"];
  reviewUrl?: string;
  error?: string;
  createdAt: string;
}

export interface CoverageUnprocessedEntry extends CoverageAuditPullEntry {
  previousProcessedHeads: string[];
}

export interface CoverageProviderDeferredEntry extends CoverageProcessedEntry {
  cooldownUntil: string;
  reason?: string;
  updatedAt: string;
}

export interface CoverageQueuedEntry extends CoverageAuditPullEntry {
  queueState: ReviewQueueJobState;
  source: string;
  lane: string;
  priority: number;
  createdAt: string;
  updatedAt: string;
  nextEligibleAt?: string;
}

export interface CoverageSkippedEntry {
  repo: string;
  reason: CoverageSkipReason;
  pullNumber?: number;
  headSha?: string;
  title?: string;
  url?: string;
}

export interface CoverageReadFailure {
  repo: string;
  error: string;
}

export interface CoverageStaleHead {
  repo: string;
  pullNumber: number;
  expectedHeadSha: string;
  liveHeadSha: string;
  expectedState?: string;
  liveState?: string;
  title: string;
  url: string;
}

export interface CoverageAuditReport {
  ok: boolean;
  checkedAt: string;
  scopedRepo?: string;
  scopedPullNumber?: number;
  summary: CoverageAuditSummary;
  processed: CoverageProcessedEntry[];
  providerDeferred: CoverageProviderDeferredEntry[];
  queued: CoverageQueuedEntry[];
  unprocessed: CoverageUnprocessedEntry[];
  skipped: CoverageSkippedEntry[];
  staleHeads: CoverageStaleHead[];
  readFailures: CoverageReadFailure[];
}

export interface CoverageGitHubApi {
  listOpenPulls(repo: string): Promise<PullRequestSummary[]>;
  getPull(repo: string, pullNumber: number): Promise<PullRequestSummary>;
}

export interface CoverageStateLookup {
  getProcessedReview(repo: string, pullNumber: number, headSha: string): StoredProcessedReviewRecord | undefined;
  listProcessedReviewsForPull(repo: string, pullNumber: number): StoredProcessedReviewRecord[];
  getRepoActivation?(repo: string): RepoActivationRecord | undefined;
  getActiveReviewQueueJob?(
    repo: string,
    pullNumber: number,
    headSha: string,
    baseSha: string,
    now: Date,
    leaseTtlMs: number
  ): CoverageQueueJobCoverage | undefined;
  getActiveRepoProviderCooldown?(repo: string, now?: Date): RepoProviderCooldownRecord | undefined;
  getActiveProviderCooldown?(now?: Date): RepoProviderCooldownRecord | undefined;
}

export class CoverageStateReader implements CoverageStateLookup {
  private constructor(private readonly db: DatabaseSync | undefined) {}

  static open(statePath: string): CoverageStateReader {
    if (!existsSync(statePath)) return new CoverageStateReader(undefined);
    return new CoverageStateReader(new DatabaseSync(statePath, { readOnly: true }));
  }

  getProcessedReview(repo: string, pullNumber: number, headSha: string): StoredProcessedReviewRecord | undefined {
    if (!this.db) return undefined;
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
    if (!this.db) return [];
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

  getRepoActivation(repo: string): RepoActivationRecord | undefined {
    if (!this.db) return undefined;
    if (!this.hasRepoActivationWatermarksTable()) return undefined;
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

  getActiveReviewQueueJob(
    repo: string,
    pullNumber: number,
    headSha: string,
    baseSha: string,
    now: Date,
    leaseTtlMs: number
  ): CoverageQueueJobCoverage | undefined {
    if (!this.db) return undefined;
    if (!this.hasReviewQueueJobsTable()) return undefined;
    const hasBaseSha = this.hasReviewQueueJobsColumn("base_sha");
    const hasLeaseExpiresAt = this.hasReviewQueueJobsColumn("lease_expires_at");
    const rows = this.db
      .prepare(
        `select repo, pull_number, head_sha, source, lane, priority, state, next_eligible_at, last_error,
                ${hasBaseSha ? "base_sha" : "null as base_sha"},
                ${hasLeaseExpiresAt ? "lease_expires_at" : "null as lease_expires_at"},
                created_at, updated_at
         from review_queue_jobs
         where repo = ?
           and pull_number = ?
           and head_sha = ?
           and state in ('queued', 'leased', 'running', 'provider_deferred')
         order by priority asc, datetime(created_at) asc`
      )
      .all(repo, pullNumber, headSha) as unknown as ReviewQueueJobCoverageRow[];
    const row = rows.find((candidate) => isCoverageQueueJobCurrent(candidate, baseSha, now, leaseTtlMs));
    return row ? mapReviewQueueJobCoverageRow(row) : undefined;
  }

  getActiveRepoProviderCooldown(repo: string, now = new Date()): RepoProviderCooldownRecord | undefined {
    if (!this.db) return undefined;
    if (!this.hasRepoProviderCooldownTable()) return undefined;
    const row = this.db
      .prepare(
        `select repo, cooldown_until, reason, updated_at
         from repo_provider_cooldowns
         where repo = ?
         limit 1`
      )
      .get(repo) as RepoProviderCooldownRow | undefined;
    if (!row) return undefined;
    const cooldown = mapRepoProviderCooldownRow(row);
    const cooldownUntilMs = Date.parse(cooldown.cooldownUntil);
    if (!Number.isFinite(cooldownUntilMs) || cooldownUntilMs <= now.getTime()) return undefined;
    return cooldown;
  }

  getActiveProviderCooldown(now = new Date()): RepoProviderCooldownRecord | undefined {
    if (!this.db) return undefined;
    if (!this.hasRepoProviderCooldownTable()) return undefined;
    const rows = this.db
      .prepare(
        `select repo, cooldown_until, reason, updated_at
         from repo_provider_cooldowns
         order by datetime(cooldown_until) desc`
      )
      .all() as unknown as RepoProviderCooldownRow[];
    return rows
      .map(mapRepoProviderCooldownRow)
      .find((cooldown) => {
        const cooldownUntilMs = Date.parse(cooldown.cooldownUntil);
        return Number.isFinite(cooldownUntilMs) && cooldownUntilMs > now.getTime();
      });
  }

  close(): void {
    this.db?.close();
  }

  private hasRepoProviderCooldownTable(): boolean {
    if (!this.db) return false;
    return Boolean(
      this.db
        .prepare("select 1 from sqlite_master where type = 'table' and name = 'repo_provider_cooldowns' limit 1")
        .get()
    );
  }

  private hasReviewQueueJobsTable(): boolean {
    if (!this.db) return false;
    return Boolean(
      this.db
        .prepare("select 1 from sqlite_master where type = 'table' and name = 'review_queue_jobs' limit 1")
        .get()
    );
  }

  private hasRepoActivationWatermarksTable(): boolean {
    if (!this.db) return false;
    return Boolean(
      this.db
        .prepare("select 1 from sqlite_master where type = 'table' and name = 'repo_activation_watermarks' limit 1")
        .get()
    );
  }

  private hasReviewQueueJobsColumn(name: string): boolean {
    if (!this.db) return false;
    const columns = this.db.prepare("pragma table_info(review_queue_jobs)").all() as unknown as Array<{ name: string }>;
    return columns.some((column) => column.name === name);
  }
}

export async function collectCoverageAudit(input: {
  config: BotConfig;
  github: CoverageGitHubApi;
  state: CoverageStateLookup;
  repo?: string;
  pullNumber?: number;
  verifyCurrentHeads?: boolean;
  now?: Date;
}): Promise<CoverageAuditReport> {
  const report: CoverageAuditReport = {
    ok: true,
    checkedAt: (input.now ?? new Date()).toISOString(),
    ...(input.repo ? { scopedRepo: input.repo } : {}),
    ...(input.pullNumber !== undefined ? { scopedPullNumber: input.pullNumber } : {}),
    summary: {
      reposScanned: 0,
      pullsSeen: 0,
      processed: 0,
      providerDeferred: 0,
      queued: 0,
      unprocessed: 0,
      skipped: 0,
      staleHeads: 0,
      readFailures: 0
    },
    processed: [],
    providerDeferred: [],
    queued: [],
    unprocessed: [],
    skipped: [],
    staleHeads: [],
    readFailures: []
  };

  const repos = input.repo ? [input.repo] : listReposToScan(input.config);
  for (const repo of repos) {
    report.summary.reposScanned += 1;
    const repoPolicy = resolveRepoProfile(input.config, repo);
    if (!repoPolicy.allowed) {
      report.skipped.push({ repo, reason: repoPolicy.reason });
      report.summary.skipped += 1;
      if (input.repo) {
        report.readFailures.push({
          repo,
          error: `Scoped repo is not eligible for coverage audit: ${repoPolicy.reason}`
        });
        report.summary.readFailures += 1;
      }
      continue;
    }

    let pulls: PullRequestSummary[];
    try {
      pulls = input.pullNumber !== undefined
        ? [await input.github.getPull(repo, input.pullNumber)]
        : await input.github.listOpenPulls(repo);
    } catch (error) {
      report.readFailures.push({ repo, error: error instanceof Error ? error.message : String(error) });
      report.summary.readFailures += 1;
      continue;
    }

    report.summary.pullsSeen += pulls.length;
    for (const pull of pulls) {
      const closed = pull.state !== undefined && pull.state !== "open";
      if (closed) {
        pushSkipped(report, repo, pull, "closed");
        continue;
      }
      if (input.config.skipDrafts && pull.draft) {
        pushSkipped(report, repo, pull, "draft");
        continue;
      }
      if (!isCanaryAllowed(input.config, repo, pull.number)) {
        pushSkipped(report, repo, pull, "canary");
        continue;
      }
      if (
        !input.state.getProcessedReview(repo, pull.number, pull.head.sha) &&
        isPreActivationExistingPull({ config: input.config, state: input.state, repo, pull })
      ) {
        pushSkipped(report, repo, pull, "activation_baseline_existing_pr");
        continue;
      }

      const now = input.now ?? new Date();
      if (
        input.verifyCurrentHeads &&
        input.pullNumber === undefined &&
        shouldVerifyCurrentHead({
          state: input.state,
          repo,
          pull
        })
      ) {
        let livePull: PullRequestSummary;
        try {
          livePull = await input.github.getPull(repo, pull.number);
        } catch (error) {
          report.readFailures.push({ repo, error: error instanceof Error ? error.message : String(error) });
          report.summary.readFailures += 1;
          continue;
        }
        if (isStaleCandidate(pull, livePull)) {
          report.staleHeads.push({
            repo,
            pullNumber: pull.number,
            expectedHeadSha: pull.head.sha,
            liveHeadSha: livePull.head.sha,
            ...(pull.state ? { expectedState: pull.state } : {}),
            ...(livePull.state ? { liveState: livePull.state } : {}),
            title: pull.title,
            url: pull.html_url
          });
          report.summary.staleHeads += 1;
          if (livePull.state !== undefined && livePull.state !== "open") {
            pushSkipped(report, repo, livePull, "closed");
            continue;
          }
          if (input.config.skipDrafts && livePull.draft) {
            pushSkipped(report, repo, livePull, "draft");
            continue;
          }
          pushProcessedOrUnprocessed(
            report,
            input.state,
            repo,
            livePull,
            now,
            input.config.reviewConcurrency.leaseTtlMs
          );
          continue;
        }
      }

      pushProcessedOrUnprocessed(
        report,
        input.state,
        repo,
        pull,
        now,
        input.config.reviewConcurrency.leaseTtlMs
      );
    }
  }

  report.ok = report.summary.unprocessed === 0 && report.summary.readFailures === 0;
  return report;
}

function shouldVerifyCurrentHead(input: {
  state: CoverageStateLookup;
  repo: string;
  pull: PullRequestSummary;
}): boolean {
  const { state, repo, pull } = input;
  if (isActivationBaselineProcessedReview(state.getProcessedReview(repo, pull.number, pull.head.sha))) return false;
  return true;
}

function pushProcessedOrUnprocessed(
  report: CoverageAuditReport,
  state: CoverageStateLookup,
  repo: string,
  pull: PullRequestSummary,
  now: Date,
  leaseTtlMs: number
): void {
  const processed = state.getProcessedReview(repo, pull.number, pull.head.sha);
  const queued = state.getActiveReviewQueueJob?.(repo, pull.number, pull.head.sha, pull.base.sha, now, leaseTtlMs);
  if (processed) {
    if (queued && isProcessedProviderCooldownSkip(processed)) {
      pushQueuedCoverage(report, repo, pull, queued);
      return;
    }

    const entry: CoverageProcessedEntry = {
      ...pullEntry(repo, pull),
      status: processed.status,
      ...(processed.event ? { event: processed.event } : {}),
      ...(processed.reviewUrl ? { reviewUrl: processed.reviewUrl } : {}),
      ...(processed.error ? { error: processed.error } : {}),
      createdAt: processed.createdAt
    };
    report.processed.push(entry);
    report.summary.processed += 1;
    const providerCooldown = activeProviderCooldown(processed, now);
    if (providerCooldown) {
      report.providerDeferred.push({
        ...entry,
        cooldownUntil: providerCooldown.cooldownUntil,
        ...(providerCooldown.reason ? { reason: providerCooldown.reason } : {}),
        updatedAt: processed.createdAt
      });
      report.summary.providerDeferred += 1;
    }
    return;
  }

  if (queued) {
    pushQueuedCoverage(report, repo, pull, queued);
    return;
  }

  const repoCooldown = state.getActiveRepoProviderCooldown?.(repo, now);
  if (repoCooldown) {
    report.providerDeferred.push({
      ...pullEntry(repo, pull),
      status: "skipped",
      error: `repo_provider_cooldown_until=${repoCooldown.cooldownUntil}; reason=${repoCooldown.reason}`,
      createdAt: repoCooldown.updatedAt,
      updatedAt: repoCooldown.updatedAt,
      cooldownUntil: repoCooldown.cooldownUntil,
      reason: repoCooldown.reason
    });
    report.summary.providerDeferred += 1;
    return;
  }

  const providerCooldown = state.getActiveProviderCooldown?.(now);
  if (providerCooldown) {
    report.providerDeferred.push({
      ...pullEntry(repo, pull),
      status: "skipped",
      error: `provider_cooldown_until=${providerCooldown.cooldownUntil}; reason=${providerCooldown.reason}`,
      createdAt: providerCooldown.updatedAt,
      updatedAt: providerCooldown.updatedAt,
      cooldownUntil: providerCooldown.cooldownUntil,
      reason: providerCooldown.reason
    });
    report.summary.providerDeferred += 1;
    return;
  }

  report.unprocessed.push({
    ...pullEntry(repo, pull),
    previousProcessedHeads: state
      .listProcessedReviewsForPull(repo, pull.number)
      .filter((record) => record.headSha !== pull.head.sha)
      .map((record) => record.headSha)
  });
  report.summary.unprocessed += 1;
}

function pushQueuedCoverage(
  report: CoverageAuditReport,
  repo: string,
  pull: PullRequestSummary,
  queued: CoverageQueueJobCoverage
): void {
  if (queued.queueState === "provider_deferred") {
    report.providerDeferred.push({
      ...pullEntry(repo, pull),
      status: "skipped",
      ...(queued.lastError ? { error: queued.lastError } : {}),
      createdAt: queued.createdAt,
      updatedAt: queued.updatedAt,
      cooldownUntil: queued.nextEligibleAt ?? queued.updatedAt,
      ...(queued.lastError ? extractProviderDeferredReason(queued.lastError) : {})
    });
    report.summary.providerDeferred += 1;
    return;
  }

  report.queued.push({
    ...pullEntry(repo, pull),
    queueState: queued.queueState,
    source: queued.source,
    lane: queued.lane,
    priority: queued.priority,
    createdAt: queued.createdAt,
    updatedAt: queued.updatedAt,
    ...(queued.nextEligibleAt ? { nextEligibleAt: queued.nextEligibleAt } : {})
  });
  report.summary.queued += 1;
}

function activeProviderCooldown(
  processed: StoredProcessedReviewRecord,
  now: Date
): { cooldownUntil: string; reason?: string } | undefined {
  if (processed.status !== "skipped" || !processed.error) return undefined;
  const parsed = parseProviderCooldownError(processed.error);
  if (!parsed) return undefined;
  const cooldownUntilMs = Date.parse(parsed.cooldownUntil);
  if (!Number.isFinite(cooldownUntilMs) || cooldownUntilMs <= now.getTime()) return undefined;
  return {
    cooldownUntil: parsed.cooldownUntil,
    ...(parsed.reason ? { reason: parsed.reason } : {})
  };
}

function isProcessedProviderCooldownSkip(processed: StoredProcessedReviewRecord): boolean {
  return processed.status === "skipped" && Boolean(processed.error && parseProviderCooldownError(processed.error));
}

function pushSkipped(
  report: CoverageAuditReport,
  repo: string,
  pull: PullRequestSummary,
  reason: CoverageSkipReason
): void {
  report.skipped.push({
    repo,
    reason,
    pullNumber: pull.number,
    headSha: pull.head.sha,
    title: pull.title,
    url: pull.html_url
  });
  report.summary.skipped += 1;
}

function pullEntry(repo: string, pull: PullRequestSummary): CoverageAuditPullEntry {
  return {
    repo,
    pullNumber: pull.number,
    headSha: pull.head.sha,
    title: pull.title,
    url: pull.html_url,
    draft: pull.draft,
    ...(pull.state ? { state: pull.state } : {})
  };
}

function isStaleCandidate(expected: PullRequestSummary, live: PullRequestSummary): boolean {
  return expected.head.sha !== live.head.sha || expected.base.sha !== live.base.sha || expected.state !== live.state;
}

interface ProcessedReviewRow {
  repo: string;
  pull_number: number;
  head_sha: string;
  status: StoredProcessedReviewRecord["status"];
  event: StoredProcessedReviewRecord["event"] | null;
  review_url: string | null;
  error: string | null;
  created_at: string;
}

interface RepoProviderCooldownRow {
  repo: string;
  cooldown_until: string;
  reason: string;
  updated_at: string;
}

interface RepoActivationRow {
  repo: string;
  activated_at: string;
  created_at: string;
}

interface ReviewQueueJobCoverageRow {
  repo: string;
  pull_number: number;
  head_sha: string;
  source: string;
  lane: string;
  priority: number;
  state: ReviewQueueJobState;
  next_eligible_at: string | null;
  last_error: string | null;
  base_sha: string | null;
  lease_expires_at: string | null;
  created_at: string;
  updated_at: string;
}

interface CoverageQueueJobCoverage {
  queueState: ReviewQueueJobState;
  source: string;
  lane: string;
  priority: number;
  createdAt: string;
  updatedAt: string;
  nextEligibleAt?: string;
  lastError?: string;
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

function mapRepoActivationRow(row: RepoActivationRow): RepoActivationRecord {
  return {
    repo: row.repo,
    activatedAt: row.activated_at,
    createdAt: row.created_at
  };
}

function mapReviewQueueJobCoverageRow(row: ReviewQueueJobCoverageRow): CoverageQueueJobCoverage {
  return {
    queueState: row.state,
    source: row.source,
    lane: row.lane,
    priority: row.priority,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.next_eligible_at ? { nextEligibleAt: row.next_eligible_at } : {}),
    ...(row.last_error ? { lastError: row.last_error } : {})
  };
}

function isCoverageQueueJobCurrent(
  row: ReviewQueueJobCoverageRow,
  baseSha: string,
  now: Date,
  leaseTtlMs: number
): boolean {
  if (row.source === "automatic" && row.base_sha !== null && row.base_sha !== baseSha) return false;
  if (row.state !== "leased" && row.state !== "running") return true;

  if (row.lease_expires_at) {
    const leaseExpiresAtMs = Date.parse(row.lease_expires_at);
    return Number.isFinite(leaseExpiresAtMs) && leaseExpiresAtMs > now.getTime();
  }

  const updatedAtMs = Date.parse(row.updated_at);
  return Number.isFinite(updatedAtMs) && updatedAtMs > now.getTime() - leaseTtlMs;
}

function extractProviderDeferredReason(error: string): { reason?: string } {
  const reason = error
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("reason="))
    ?.slice("reason=".length)
    .trim();
  return { reason: reason || "provider_error" };
}

function mapRepoProviderCooldownRow(row: RepoProviderCooldownRow): RepoProviderCooldownRecord {
  return {
    repo: row.repo,
    cooldownUntil: row.cooldown_until,
    reason: row.reason,
    updatedAt: row.updated_at
  };
}
