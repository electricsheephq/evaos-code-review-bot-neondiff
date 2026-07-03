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
}

export interface ProviderThrottleSummary extends ProviderThrottleCounts {
  providerErrors: number;
  peakWindowErrors: number;
  offPeakErrors: number;
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
  status: string;
  error: string;
  timestamp: string;
}

interface ProcessedReviewErrorRow {
  repo: string;
  status: string;
  error: string | null;
  created_at: string;
}

interface ReviewQueueErrorRow {
  repo: string;
  state: string;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  started_at?: string | null;
  finished_at?: string | null;
}

const PROVIDER_CODES = /(?:\bprovider_code=|\bproviderCode:\s*["']?|\[)(\d{4})\b/g;
const DEFAULT_SINCE = "24h";
const DEFAULT_TIMEZONE = "Asia/Singapore";
const DEFAULT_PEAK_START_HOUR = 14;
const DEFAULT_PEAK_END_HOUR = 18;

export function collectProviderThrottleReport(input: ProviderThrottleReportOptions): ProviderThrottleReport {
  const now = input.now ?? new Date();
  const timezone = input.timezone ?? DEFAULT_TIMEZONE;
  const peakStartHour = input.peakStartHour ?? DEFAULT_PEAK_START_HOUR;
  const peakEndHour = input.peakEndHour ?? DEFAULT_PEAK_END_HOUR;
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
    for (const event of events) {
      addEventToReport(report, event, timezone, peakStartHour, peakEndHour);
    }
  } finally {
    db.close();
  }

  report.codes.sort((left, right) => right.count - left.count || left.code.localeCompare(right.code));
  report.hourly.sort((left, right) => left.localHour.localeCompare(right.localHour));
  report.repos.sort((left, right) => right.total - left.total || left.repo.localeCompare(right.repo));
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
      offPeakErrors: 0
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
    repos: []
  };
}

function collectProviderThrottleEvents(db: DatabaseSync, sinceStart: Date, now: Date): ProviderThrottleEvent[] {
  const events: ProviderThrottleEvent[] = [];
  const start = sinceStart.toISOString();
  const end = now.toISOString();

  if (hasTable(db, "processed_reviews")) {
    const rows = db
      .prepare(
        `select repo, status, error, created_at
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
        status: row.status,
        error: row.error,
        timestamp: row.created_at
      });
    }
  }

  if (hasTable(db, "review_queue_jobs")) {
    const timestampExpr = queueTimestampExpression(db);
    const rows = db
      .prepare(
        `select repo, state, last_error, created_at, updated_at,
                ${hasColumn(db, "review_queue_jobs", "started_at") ? "started_at" : "null as started_at"},
                ${hasColumn(db, "review_queue_jobs", "finished_at") ? "finished_at" : "null as finished_at"}
         from review_queue_jobs
         where last_error is not null
           and datetime(${timestampExpr}) >= datetime(?)
           and datetime(${timestampExpr}) <= datetime(?)`
      )
      .all(start, end) as unknown as ReviewQueueErrorRow[];
    for (const row of rows) {
      if (!row.last_error || !classifyProviderThrottle(row.last_error)) continue;
      events.push({
        repo: row.repo,
        status: row.state,
        error: row.last_error,
        timestamp: row.finished_at ?? row.updated_at ?? row.started_at ?? row.created_at
      });
    }
  }

  return events;
}

function addEventToReport(
  report: ProviderThrottleReport,
  event: ProviderThrottleEvent,
  timezone: string,
  peakStartHour: number,
  peakEndHour: number
): void {
  const category = classifyProviderThrottle(event.error);
  if (!category) return;
  const hour = localHour(event.timestamp, timezone);
  const peakWindow = isPeakHour(hour, peakStartHour, peakEndHour);
  const hourly = getHourlyBucket(report, hour, peakWindow);
  const repo = getRepoBucket(report, event.repo);

  report.summary.providerErrors += 1;
  report.summary[category] += 1;
  hourly.total += 1;
  hourly[category] += 1;
  repo.total += 1;
  repo[category] += 1;
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
    normalized.includes("weekly/monthly limit exhausted") ||
    normalized.includes("limit exhausted") ||
    normalized.includes("quota exhausted") ||
    codes.some((code) => ["1308", "1309", "1310", "1316", "1317"].includes(code))
  ) {
    return "quotaExhausted";
  }
  if (
    normalized.includes("reason=provider_request_rate_limit") ||
    normalized.includes("reason=provider_rate_limit") ||
    normalized.includes("provider_request_rate_limit") ||
    codes.includes("1302")
  ) {
    return "requestRateLimit";
  }
  if (
    normalized.includes("github api fetch failed") ||
    normalized.includes("enotfound") ||
    normalized.includes("econnreset") ||
    normalized.includes("eaddrnotavail") ||
    normalized.includes("nghttp2") ||
    normalized.includes("connect timeout") ||
    normalized.includes("unable to verify first certificate") ||
    normalized.includes("fetch failed")
  ) {
    return "networkOrGithubDependency";
  }
  if (normalized.includes("provider") || codes.length > 0) return "unknownProviderError";
  return undefined;
}

function addRetryOutcome(report: ProviderThrottleReport, event: ProviderThrottleEvent): void {
  const status = event.status.toLowerCase();
  if (status === "posted" || status === "reviewed" || status === "reviewed_command") {
    report.retryOutcomes.retriedPosted += 1;
  } else if (status === "provider_deferred" || status === "skipped_provider_cooldown") {
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
  for (const match of error.matchAll(PROVIDER_CODES)) {
    if (match[1]) codes.add(match[1]);
  }
  return [...codes];
}

function localHour(timestamp: string, timezone: string): string {
  const date = new Date(timestamp);
  const hour = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "2-digit",
    hourCycle: "h23"
  }).format(date);
  return `${hour}:00`;
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
    hasColumn(db, "review_queue_jobs", "finished_at") ? "finished_at" : undefined,
    hasColumn(db, "review_queue_jobs", "updated_at") ? "updated_at" : undefined,
    hasColumn(db, "review_queue_jobs", "started_at") ? "started_at" : undefined,
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
  const rows = db.prepare(`pragma table_info(${tableName})`).all() as unknown as Array<{ name: string }>;
  return rows.some((row) => row.name === columnName);
}
