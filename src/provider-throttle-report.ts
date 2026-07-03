import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

export interface ProviderThrottleReportOptions {
  statePath: string;
  now?: Date;
  since?: string;
  timezone?: string;
  peakStartHour?: number;
  peakEndHour?: number;
}

export interface ProviderThrottleReport {
  ok: true;
  checkedAt: string;
  since: {
    raw: string;
    start: string;
    end: string;
  };
  timezone: string;
  peakWindow: {
    startHour: number;
    endHour: number;
  };
  recommendedPolicy: "measure_only";
  summary: ProviderThrottleSummary;
  retryOutcomes: ProviderThrottleRetryOutcomes;
  codes: Array<{ code: string; count: number }>;
  hourly: ProviderThrottleHourlyBucket[];
  repos: ProviderThrottleRepoBucket[];
  providers: ProviderThrottleProviderBucket[];
  knownLimitations: string[];
}

export interface ProviderThrottleSummary extends ProviderThrottleCounts {
  providerErrors: number;
  peakWindowErrors: number;
  offPeakErrors: number;
  droppedEvents: number;
  malformedTimestamps: number;
  worstLocalHour?: string;
}

export interface ProviderThrottleRetryOutcomes {
  retriedPosted: number;
  retriedProviderDeferred: number;
  retriedStaleHead: number;
  retriedClosed: number;
  skippedCapacity: number;
  gaveUpAfterBackoff: number;
}

export interface ProviderThrottleHourlyBucket extends ProviderThrottleCounts {
  localHour: string;
  total: number;
  peakWindow: boolean;
}

export interface ProviderThrottleRepoBucket extends ProviderThrottleCounts {
  repo: string;
  total: number;
}

export interface ProviderThrottleProviderBucket extends ProviderThrottleCounts {
  providerId: string;
  total: number;
}

interface ProviderThrottleCounts {
  requestRateLimit: number;
  overloaded: number;
  quotaExhausted: number;
  networkOrGithubDependency: number;
  unknownProviderError: number;
}

type ProviderThrottleCategory =
  | "requestRateLimit"
  | "overloaded"
  | "quotaExhausted"
  | "networkOrGithubDependency"
  | "unknownProviderError";

interface ProviderThrottleEvent {
  repo: string;
  pullNumber: number;
  headSha: string;
  status: string;
  error: string;
  timestamp: string;
  providerId: string;
  source: "processed_reviews" | "review_queue_jobs";
}

interface ProcessedReviewErrorRow {
  repo: string;
  pull_number: number;
  head_sha: string;
  status: string;
  error: string | null;
  created_at: string;
}

interface ReviewQueueErrorRow {
  repo: string;
  pull_number: number;
  head_sha: string;
  state: string;
  last_error: string | null;
  provider_id?: string | null;
  created_at: string;
  updated_at: string;
  started_at?: string | null;
  finished_at?: string | null;
}

const EXPLICIT_PROVIDER_CODES = /(?:\bprovider_code=|\bprevious_provider_code=|\bproviderCode:\s*["']?)(\d{4})\b/g;
const PROVIDER_BUSINESS_ERROR_CODES = /\bproviderbusinesserror\b[^\[]*\[(\d{4})\]/gi;
const SQLITE_UTC_TEXT_TIMESTAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const ISO_TIMESTAMP_WITHOUT_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/;
const PROVIDER_ID_SECRET_LIKE =
  /(-----BEGIN\b|github_pat_|gh[opurs]_[A-Za-z0-9_]+|xox[abprs]-|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|\bBearer\s+\S+|\bsk-[A-Za-z0-9_-]{16,}|[A-Za-z0-9_-]{80,})/i;
const REVIEW_QUEUE_JOBS_TABLE = "review_queue_jobs";
const DEFAULT_SINCE = "24h";
const DEFAULT_TIMEZONE = "Asia/Singapore";
const DEFAULT_PEAK_START_HOUR = 14;
const DEFAULT_PEAK_END_HOUR = 18;

export function collectProviderThrottleReport(input: ProviderThrottleReportOptions): ProviderThrottleReport {
  const now = input.now ?? new Date();
  const timezone = input.timezone ?? DEFAULT_TIMEZONE;
  assertValidTimezone(timezone);
  const peakStartHour = input.peakStartHour ?? DEFAULT_PEAK_START_HOUR;
  const peakEndHour = input.peakEndHour ?? DEFAULT_PEAK_END_HOUR;
  assertValidHour("--peak-start-hour", peakStartHour);
  assertValidHour("--peak-end-hour", peakEndHour);
  const sinceRaw = input.since ?? DEFAULT_SINCE;
  const sinceStart = resolveSinceStart(sinceRaw, now);
  const report = emptyReport({
    now,
    sinceRaw,
    sinceStart,
    timezone,
    peakStartHour,
    peakEndHour
  });

  if (!existsSync(input.statePath)) return report;

  const db = new DatabaseSync(input.statePath, { readOnly: true });
  try {
    const events = collectProviderThrottleEvents(db, sinceStart, now);
    const hourFormatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "2-digit",
      hourCycle: "h23"
    });
    for (const event of events) {
      addEventToReport(report, event, hourFormatter, peakStartHour, peakEndHour);
    }
  } finally {
    db.close();
  }

  report.codes.sort((left, right) => right.count - left.count || left.code.localeCompare(right.code));
  report.hourly.sort((left, right) => left.localHour.localeCompare(right.localHour));
  report.repos.sort((left, right) => right.total - left.total || left.repo.localeCompare(right.repo));
  report.providers.sort((left, right) => right.total - left.total || left.providerId.localeCompare(right.providerId));
  report.summary.worstLocalHour = findWorstLocalHour(report.hourly);
  return report;
}

function emptyReport(input: {
  now: Date;
  sinceRaw: string;
  sinceStart: Date;
  timezone: string;
  peakStartHour: number;
  peakEndHour: number;
}): ProviderThrottleReport {
  return {
    ok: true,
    checkedAt: input.now.toISOString(),
    since: {
      raw: input.sinceRaw,
      start: input.sinceStart.toISOString(),
      end: input.now.toISOString()
    },
    timezone: input.timezone,
    peakWindow: {
      startHour: input.peakStartHour,
      endHour: input.peakEndHour
    },
    recommendedPolicy: "measure_only",
    summary: {
      providerErrors: 0,
      requestRateLimit: 0,
      overloaded: 0,
      quotaExhausted: 0,
      networkOrGithubDependency: 0,
      unknownProviderError: 0,
      peakWindowErrors: 0,
      offPeakErrors: 0,
      droppedEvents: 0,
      malformedTimestamps: 0
    },
    retryOutcomes: {
      retriedPosted: 0,
      retriedProviderDeferred: 0,
      retriedStaleHead: 0,
      retriedClosed: 0,
      skippedCapacity: 0,
      gaveUpAfterBackoff: 0
    },
    codes: [],
    hourly: [],
    repos: [],
    providers: [],
    knownLimitations: [
      "processed_reviews is a current-state table keyed by repo/pull/head; provider throttles that were overwritten before queue retry metadata was preserved may be undercounted.",
      "processed_reviews events are bucketed by created_at; review_queue_jobs events are bucketed by coalesce(finished_at, updated_at, started_at, created_at), so deduped queue incidents may reflect retry/update time instead of first-observed throttle time.",
      "processed_reviews does not store provider_id, so provider context for those rows is reported as unknown.",
      "retryOutcomes is sourced from review_queue_jobs current state only; processed_reviews-only incidents are excluded from retry outcomes, and still-deferred rows only count as retriedProviderDeferred when their error trail includes retry metadata.",
      "Each incident is assigned to the first matching category by precedence; mixed-cause provider errors are collapsed into one summary category while all extracted provider codes remain visible."
    ]
  };
}

function collectProviderThrottleEvents(db: DatabaseSync, sinceStart: Date, now: Date): ProviderThrottleEvent[] {
  const events: ProviderThrottleEvent[] = [];
  const start = sinceStart.toISOString();
  const end = now.toISOString();

  if (hasTable(db, "processed_reviews")) {
    const rows = db
      .prepare(
        `select repo, pull_number, head_sha, status, error, created_at
         from processed_reviews
         where error is not null
           and datetime(created_at) >= datetime(?)
           and datetime(created_at) <= datetime(?)`
      )
      .all(start, end) as unknown as ProcessedReviewErrorRow[];
    for (const row of rows) {
      if (!row.error || !classifyProviderThrottle(row.error)) continue;
      events.push({
        repo: row.repo,
        pullNumber: row.pull_number,
        headSha: row.head_sha,
        status: row.status,
        error: row.error,
        timestamp: row.created_at,
        providerId: "unknown",
        source: "processed_reviews"
      });
    }
  }

  if (hasTable(db, REVIEW_QUEUE_JOBS_TABLE)) {
    const timestampExpr = queueTimestampExpression(db);
    const hasProviderId = hasColumn(db, REVIEW_QUEUE_JOBS_TABLE, "provider_id");
    const hasStartedAt = hasColumn(db, REVIEW_QUEUE_JOBS_TABLE, "started_at");
    const hasFinishedAt = hasColumn(db, REVIEW_QUEUE_JOBS_TABLE, "finished_at");
    const rows = db
      .prepare(
        `select repo, pull_number, head_sha, state, last_error,
                ${hasProviderId ? "provider_id" : "null as provider_id"},
                created_at, updated_at,
                ${hasStartedAt ? "started_at" : "null as started_at"},
                ${hasFinishedAt ? "finished_at" : "null as finished_at"}
         from review_queue_jobs
         where last_error is not null
           and state not in ('queued', 'leased', 'running')
           and datetime(${timestampExpr}) >= datetime(?)
           and datetime(${timestampExpr}) <= datetime(?)
         order by datetime(${timestampExpr}) asc`
      )
      .all(start, end) as unknown as ReviewQueueErrorRow[];
    for (const row of rows) {
      if (!row.last_error || !classifyProviderThrottle(row.last_error)) continue;
      events.push({
        repo: row.repo,
        pullNumber: row.pull_number,
        headSha: row.head_sha,
        status: row.state,
        error: row.last_error,
        timestamp: row.finished_at ?? row.updated_at ?? row.started_at ?? row.created_at,
        providerId: normalizeProviderId(row.provider_id),
        source: "review_queue_jobs"
      });
    }
  }

  return dedupeProviderThrottleEvents(events);
}

function addEventToReport(
  report: ProviderThrottleReport,
  event: ProviderThrottleEvent,
  hourFormatter: Intl.DateTimeFormat,
  peakStartHour: number,
  peakEndHour: number
): void {
  const category = classifyProviderThrottle(event.error);
  if (!category) return;
  const hour = localHour(event.timestamp, hourFormatter);
  if (!hour) {
    report.summary.droppedEvents += 1;
    report.summary.malformedTimestamps += 1;
    return;
  }
  const peakWindow = isPeakHour(hour, peakStartHour, peakEndHour);
  const hourly = getHourlyBucket(report, hour, peakWindow);
  const repo = getRepoBucket(report, event.repo);
  const provider = getProviderBucket(report, event.providerId);

  report.summary.providerErrors += 1;
  report.summary[category] += 1;
  hourly.total += 1;
  hourly[category] += 1;
  repo.total += 1;
  repo[category] += 1;
  provider.total += 1;
  provider[category] += 1;
  if (peakWindow) report.summary.peakWindowErrors += 1;
  else report.summary.offPeakErrors += 1;

  for (const code of extractProviderCodes(event.error)) {
    const row = report.codes.find((candidate) => candidate.code === code);
    if (row) row.count += 1;
    else report.codes.push({ code, count: 1 });
  }

  addRetryOutcome(report, event);
}

function getHourlyBucket(report: ProviderThrottleReport, localHour: string, peakWindow: boolean): ProviderThrottleHourlyBucket {
  const existing = report.hourly.find((row) => row.localHour === localHour);
  if (existing) return existing;
  const created: ProviderThrottleHourlyBucket = {
    localHour,
    total: 0,
    peakWindow,
    ...emptyCounts()
  };
  report.hourly.push(created);
  return created;
}

function getRepoBucket(report: ProviderThrottleReport, repo: string): ProviderThrottleRepoBucket {
  const existing = report.repos.find((row) => row.repo === repo);
  if (existing) return existing;
  const created: ProviderThrottleRepoBucket = {
    repo,
    total: 0,
    ...emptyCounts()
  };
  report.repos.push(created);
  return created;
}

function getProviderBucket(report: ProviderThrottleReport, providerId: string): ProviderThrottleProviderBucket {
  const existing = report.providers.find((row) => row.providerId === providerId);
  if (existing) return existing;
  const created: ProviderThrottleProviderBucket = {
    providerId,
    total: 0,
    ...emptyCounts()
  };
  report.providers.push(created);
  return created;
}

function emptyCounts(): ProviderThrottleCounts {
  return {
    requestRateLimit: 0,
    overloaded: 0,
    quotaExhausted: 0,
    networkOrGithubDependency: 0,
    unknownProviderError: 0
  };
}

function classifyProviderThrottle(error: string): ProviderThrottleCategory | undefined {
  const normalized = error.toLowerCase();
  const codes = extractProviderCodes(error);

  if (
    normalized.includes("provider_overloaded") ||
    normalized.includes("temporarily overloaded") ||
    normalized.includes("overloaded") ||
    codes.includes("1305")
  ) {
    return "overloaded";
  }
  if (
    normalized.includes("provider_quota_exhausted") ||
    normalized.includes("usage limit reached") ||
    normalized.includes("weekly/monthly limit exhausted") ||
    normalized.includes("limit exhausted") ||
    normalized.includes("quota exhausted") ||
    normalized.includes("package has expired") ||
    codes.some((code) => ["1308", "1309", "1310", "1316", "1317"].includes(code))
  ) {
    return "quotaExhausted";
  }
  if (
    normalized.includes("reason=provider_request_rate_limit") ||
    normalized.includes("reason=provider_rate_limit") ||
    normalized.includes("previous_reason=provider_request_rate_limit") ||
    normalized.includes("previous_reason=provider_rate_limit") ||
    normalized.includes("provider_request_rate_limit") ||
    codes.includes("1302")
  ) {
    return "requestRateLimit";
  }
  if (isNetworkOrGithubDependencySignal(normalized)) {
    return "networkOrGithubDependency";
  }
  if (
    normalized.includes("providerbusinesserror") ||
    normalized.includes("provider throttle") ||
    normalized.includes("provider cooldown") ||
    normalized.includes("provider_throttle") ||
    normalized.includes("provider_cooldown") ||
    codes.length > 0
  ) {
    return "unknownProviderError";
  }
  return undefined;
}

function dedupeProviderThrottleEvents(events: ProviderThrottleEvent[]): ProviderThrottleEvent[] {
  const byIncident = new Map<string, ProviderThrottleEvent>();
  for (const event of events) {
    const category = classifyProviderThrottle(event.error);
    if (!category) continue;
    const key = [
      event.repo,
      event.pullNumber,
      event.headSha,
      category,
      extractProviderCodes(event.error).sort().join(",")
    ].join("\0");
    const existing = byIncident.get(key);
    if (!existing || shouldReplaceProviderThrottleIncident(existing, event)) {
      byIncident.set(key, event);
    }
  }
  return [...byIncident.values()];
}

function shouldReplaceProviderThrottleIncident(existing: ProviderThrottleEvent, candidate: ProviderThrottleEvent): boolean {
  if (existing.source === "processed_reviews" && candidate.source === "review_queue_jobs") return true;
  if (existing.source === "review_queue_jobs" && candidate.source === "processed_reviews") return false;
  return eventTimestampMs(candidate) >= eventTimestampMs(existing);
}

function eventTimestampMs(event: ProviderThrottleEvent): number {
  const date = parseSqliteUtcTimestamp(event.timestamp);
  return Number.isFinite(date.getTime()) ? date.getTime() : Number.NEGATIVE_INFINITY;
}

function addRetryOutcome(report: ProviderThrottleReport, event: ProviderThrottleEvent): void {
  if (event.source !== "review_queue_jobs") return;
  const status = event.status.toLowerCase();
  if (status === "posted" || status === "reviewed" || status === "reviewed_command") {
    report.retryOutcomes.retriedPosted += 1;
  } else if (status === "provider_deferred" && hasRetryAttemptTrail(event.error)) {
    report.retryOutcomes.retriedProviderDeferred += 1;
  } else if (status === "skipped_provider_cooldown") {
    report.retryOutcomes.retriedProviderDeferred += 1;
  } else if (status === "stale_retired" || status === "skipped_stale_head") {
    report.retryOutcomes.retriedStaleHead += 1;
  } else if (status === "closed_retired" || status === "skipped_closed") {
    report.retryOutcomes.retriedClosed += 1;
  } else if (status === "skipped_capacity") {
    report.retryOutcomes.skippedCapacity += 1;
  } else if (status === "failed") {
    report.retryOutcomes.gaveUpAfterBackoff += 1;
  }
}

function extractProviderCodes(error: string): string[] {
  const codes = new Set<string>();
  for (const match of error.matchAll(EXPLICIT_PROVIDER_CODES)) {
    if (match[1]) codes.add(match[1]);
  }
  for (const match of error.matchAll(PROVIDER_BUSINESS_ERROR_CODES)) {
    if (match[1]) codes.add(match[1]);
  }
  return [...codes];
}

function isNetworkOrGithubDependencySignal(normalizedError: string): boolean {
  return normalizedError.includes("github api fetch failed") ||
    normalizedError.includes("api.github.com") ||
    normalizedError.includes("enotfound") ||
    normalizedError.includes("econnreset") ||
    normalizedError.includes("eaddrnotavail") ||
    normalizedError.includes("nghttp2") ||
    normalizedError.includes("connect timeout") ||
    normalizedError.includes("unable to verify first certificate") ||
    (
      normalizedError.includes("fetch failed") &&
      (
        normalizedError.includes("github") ||
        normalizedError.includes("provider") ||
        normalizedError.includes("api.github.com")
      )
    );
}

function hasRetryAttemptTrail(error: string): boolean {
  return /\bretry_attempt=\d+\b/.test(error) ||
    /\bretry_after_ms=\d+\b/.test(error) ||
    error.includes("_after_provider_deferred") ||
    error.includes("previous_reason=");
}

function localHour(timestamp: string, hourFormatter: Intl.DateTimeFormat): string | undefined {
  const date = parseSqliteUtcTimestamp(timestamp);
  if (!Number.isFinite(date.getTime())) return undefined;
  const hour = hourFormatter.format(date);
  return `${hour}:00`;
}

function parseSqliteUtcTimestamp(timestamp: string): Date {
  const trimmed = timestamp.trim();
  if (SQLITE_UTC_TEXT_TIMESTAMP.test(trimmed)) {
    return new Date(`${trimmed.replace(" ", "T")}Z`);
  }
  if (ISO_TIMESTAMP_WITHOUT_OFFSET.test(trimmed)) {
    return new Date(`${trimmed}Z`);
  }
  return new Date(trimmed);
}

function assertValidTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date(0));
  } catch {
    throw new Error(`Invalid --timezone value: ${timezone}`);
  }
}

function assertValidHour(name: string, hour: number): void {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new Error(`Invalid ${name} value: ${hour}; expected an integer from 0 to 23`);
  }
}

function normalizeProviderId(value?: string | null): string {
  const trimmed = value?.trim();
  if (!trimmed) return "unknown";
  if (PROVIDER_ID_SECRET_LIKE.test(trimmed)) return "[redacted-provider-id]";
  const singleLine = trimmed.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (!singleLine) return "unknown";
  return singleLine.length > 96 ? `${singleLine.slice(0, 93)}...` : singleLine;
}

function isPeakHour(localHour: string, peakStartHour: number, peakEndHour: number): boolean {
  const hour = Number(localHour.slice(0, 2));
  if (!Number.isFinite(hour)) return false;
  if (peakStartHour <= peakEndHour) return hour >= peakStartHour && hour <= peakEndHour;
  return hour >= peakStartHour || hour <= peakEndHour;
}

function findWorstLocalHour(rows: ProviderThrottleHourlyBucket[]): string | undefined {
  const [worst] = [...rows].sort((left, right) => {
    return (
      right.total - left.total ||
      right.requestRateLimit - left.requestRateLimit ||
      right.overloaded - left.overloaded ||
      right.quotaExhausted - left.quotaExhausted ||
      right.networkOrGithubDependency - left.networkOrGithubDependency ||
      left.localHour.localeCompare(right.localHour)
    );
  });
  return worst?.localHour;
}

function queueTimestampExpression(db: DatabaseSync): string {
  const columns = [
    hasColumn(db, REVIEW_QUEUE_JOBS_TABLE, "finished_at") ? "finished_at" : undefined,
    hasColumn(db, REVIEW_QUEUE_JOBS_TABLE, "updated_at") ? "updated_at" : undefined,
    hasColumn(db, REVIEW_QUEUE_JOBS_TABLE, "started_at") ? "started_at" : undefined,
    "created_at"
  ].filter(Boolean);
  return `coalesce(${columns.join(", ")})`;
}

function resolveSinceStart(raw: string, now: Date): Date {
  const trimmed = raw.trim();
  const relative = /^(\d+)([hd])$/i.exec(trimmed);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2].toLowerCase();
    const milliseconds = unit === "h" ? amount * 60 * 60 * 1000 : amount * 24 * 60 * 60 * 1000;
    return new Date(now.getTime() - milliseconds);
  }
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) throw new Error(`Invalid --since value: ${raw}`);
  return new Date(parsed);
}

function hasTable(db: DatabaseSync, tableName: string): boolean {
  const row = db
    .prepare("select 1 as ok from sqlite_master where type = 'table' and name = ? limit 1")
    .get(tableName) as { ok: number } | undefined;
  return Boolean(row);
}

function hasColumn(db: DatabaseSync, tableName: string, columnName: string): boolean {
  if (tableName !== REVIEW_QUEUE_JOBS_TABLE) {
    throw new Error(`Unsupported table for column introspection: ${tableName}`);
  }
  const rows = db.prepare("pragma table_info(review_queue_jobs)").all() as unknown as Array<{ name: string }>;
  return rows.some((row) => row.name === columnName);
}
