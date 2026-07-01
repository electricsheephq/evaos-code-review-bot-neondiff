import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { BotConfig } from "./config.js";
import { listReposToScan, resolveRepoProfile, type RepoProfileSkipReason } from "./repo-policy.js";
import {
  parseProviderCooldownError,
  type RepoProviderCooldownRecord,
  type StoredProcessedReviewRecord
} from "./state.js";
import { isCanaryAllowed } from "./worker.js";
import type { PullRequestSummary } from "./types.js";

export type CoverageSkipReason = RepoProfileSkipReason | "draft" | "closed" | "canary";

export interface CoverageAuditSummary {
  reposScanned: number;
  pullsSeen: number;
  processed: number;
  providerDeferred: number;
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
  getActiveRepoProviderCooldown?(repo: string, now?: Date): RepoProviderCooldownRecord | undefined;
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

  getActiveRepoProviderCooldown(repo: string, now = new Date()): RepoProviderCooldownRecord | undefined {
    if (!this.db) return undefined;
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

  close(): void {
    this.db?.close();
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
      unprocessed: 0,
      skipped: 0,
      staleHeads: 0,
      readFailures: 0
    },
    processed: [],
    providerDeferred: [],
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

      if (input.verifyCurrentHeads && input.pullNumber === undefined) {
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
          pushProcessedOrUnprocessed(report, input.state, repo, livePull, input.now ?? new Date());
          continue;
        }
      }

      pushProcessedOrUnprocessed(report, input.state, repo, pull, input.now ?? new Date());
    }
  }

  report.ok = report.summary.unprocessed === 0 && report.summary.readFailures === 0;
  return report;
}

function pushProcessedOrUnprocessed(
  report: CoverageAuditReport,
  state: CoverageStateLookup,
  repo: string,
  pull: PullRequestSummary,
  now: Date
): void {
  const processed = state.getProcessedReview(repo, pull.number, pull.head.sha);
  if (processed) {
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
        ...(providerCooldown.reason ? { reason: providerCooldown.reason } : {})
      });
      report.summary.providerDeferred += 1;
    }
    return;
  }

  const repoCooldown = state.getActiveRepoProviderCooldown?.(repo, now);
  if (repoCooldown) {
    report.providerDeferred.push({
      ...pullEntry(repo, pull),
      status: "skipped",
      error: `repo_provider_cooldown_until=${repoCooldown.cooldownUntil}; reason=${repoCooldown.reason}`,
      createdAt: repoCooldown.updatedAt,
      cooldownUntil: repoCooldown.cooldownUntil,
      reason: repoCooldown.reason
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
