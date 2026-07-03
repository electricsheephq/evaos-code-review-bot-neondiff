import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { collectProviderThrottleReport } from "../src/provider-throttle-report.js";
import { ReviewStateStore } from "../src/state.js";

describe("provider throttle report", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("classifies provider throttle categories, retry outcomes, and local-hour buckets without raw payloads", () => {
    const root = mkdtempSync(join(tmpdir(), "provider-throttle-report-"));
    roots.push(root);
    const statePath = join(root, "state.sqlite");
    new ReviewStateStore(statePath).close();
    const db = new DatabaseSync(statePath);
    try {
      insertProcessed(db, {
        repo: "owner/repo",
        pullNumber: 1,
        headSha: "rate-head",
        status: "skipped",
        error: "provider_rate_limit_cooldown_until=2026-07-01T08:05:00.000Z; reason=provider_request_rate_limit; provider_code=1302; providerRequestId: 'secret-request-id'",
        createdAt: "2026-07-01 08:00:00"
      });
      insertProcessed(db, {
        repo: "owner/repo",
        pullNumber: 2,
        headSha: "overload-head",
        status: "skipped",
        error: "provider_rate_limit_cooldown_until=2026-07-01T09:05:00.000Z; reason=provider_overloaded; retry_attempt=2; provider_code=1305",
        createdAt: "2026-07-01 09:00:00"
      });
      insertProcessed(db, {
        repo: "owner/other",
        pullNumber: 3,
        headSha: "quota-head",
        status: "failed",
        error: "ProviderBusinessError: [1310][Weekly/Monthly Limit Exhausted]",
        createdAt: "2026-07-01 20:00:00"
      });
      insertQueueJob(db, {
        repo: "owner/repo",
        pullNumber: 4,
        headSha: "queue-deferred",
        state: "provider_deferred",
        lastError: "ProviderBusinessError: [1305][temporarily overloaded]",
        createdAt: "2026-07-01T10:00:00.000Z",
        updatedAt: "2026-07-01T10:01:00.000Z"
      });
      insertQueueJob(db, {
        repo: "owner/other",
        pullNumber: 5,
        headSha: "network-head",
        state: "failed",
        lastError: "GitHub API fetch failed for /app/installations/access_tokens: fetch failed; cause=Error: getaddrinfo ENOTFOUND api.github.com",
        createdAt: "2026-07-01T11:00:00.000Z",
        updatedAt: "2026-07-01T11:01:00.000Z"
      });
      insertQueueJob(db, {
        repo: "owner/repo",
        pullNumber: 6,
        headSha: "posted-head",
        state: "posted",
        lastError: "reviewed_after_provider_deferred; previous_reason=provider_request_rate_limit; previous_provider_code=1302",
        createdAt: "2026-07-01T12:00:00.000Z",
        updatedAt: "2026-07-01T12:01:00.000Z"
      });
    } finally {
      db.close();
    }

    const report = collectProviderThrottleReport({
      statePath,
      now: new Date("2026-07-08T00:00:00.000Z"),
      since: "7d",
      timezone: "Asia/Singapore",
      peakStartHour: 14,
      peakEndHour: 18
    });

    expect(report).toMatchObject({
      ok: true,
      timezone: "Asia/Singapore",
      recommendedPolicy: "measure_only",
      summary: {
        providerErrors: 6,
        requestRateLimit: 2,
        overloaded: 2,
        quotaExhausted: 1,
        networkOrGithubDependency: 1,
        unknownProviderError: 0,
        peakWindowErrors: 3,
        offPeakErrors: 3,
        worstLocalHour: "16:00"
      },
      retryOutcomes: {
        retriedPosted: 1,
        retriedProviderDeferred: 1,
        gaveUpAfterBackoff: 1
      }
    });
    expect(report.codes).toContainEqual({ code: "1302", count: 2 });
    expect(report.codes).toContainEqual({ code: "1305", count: 2 });
    expect(report.codes).toContainEqual({ code: "1310", count: 1 });
    expect(report.hourly.find((row) => row.localHour === "16:00")).toMatchObject({
      total: 1,
      requestRateLimit: 1
    });
    expect(report.repos[0]).toMatchObject({
      repo: "owner/repo",
      total: 4
    });
    expect(report.knownLimitations).toContain(
      "processed_reviews is a current-state table keyed by repo/pull/head; provider throttles that were overwritten before queue retry metadata was preserved may be undercounted."
    );
    expect(JSON.stringify(report)).not.toMatch(/secret-request-id|PRIVATE KEY|ghp_/);
  });

  it("rejects invalid timezone values before formatting buckets", () => {
    const root = mkdtempSync(join(tmpdir(), "provider-throttle-report-timezone-"));
    roots.push(root);
    const statePath = join(root, "state.sqlite");

    expect(() => collectProviderThrottleReport({
      statePath,
      timezone: "Foo/Bar"
    })).toThrow("Invalid --timezone value: Foo/Bar");
  });

  it("deduplicates processed and queued rows for the same provider incident", () => {
    const root = mkdtempSync(join(tmpdir(), "provider-throttle-report-dedupe-"));
    roots.push(root);
    const statePath = join(root, "state.sqlite");
    new ReviewStateStore(statePath).close();
    const db = new DatabaseSync(statePath);
    try {
      insertProcessed(db, {
        repo: "owner/repo",
        pullNumber: 7,
        headSha: "same-provider-head",
        status: "skipped",
        error: "provider_rate_limit_cooldown_until=2026-07-01T08:05:00.000Z; reason=provider_request_rate_limit; provider_code=1302",
        createdAt: "2026-07-01 08:00:00"
      });
      insertQueueJob(db, {
        repo: "owner/repo",
        pullNumber: 7,
        headSha: "same-provider-head",
        state: "provider_deferred",
        lastError: "provider_rate_limit_cooldown_until=2026-07-01T08:05:00.000Z; reason=provider_request_rate_limit; provider_code=1302",
        createdAt: "2026-07-01T08:00:00.000Z",
        updatedAt: "2026-07-01T08:01:00.000Z"
      });
    } finally {
      db.close();
    }

    const report = collectProviderThrottleReport({
      statePath,
      now: new Date("2026-07-08T00:00:00.000Z"),
      since: "7d",
      timezone: "Asia/Singapore"
    });

    expect(report.summary.providerErrors).toBe(1);
    expect(report.summary.requestRateLimit).toBe(1);
    expect(report.retryOutcomes.retriedProviderDeferred).toBe(1);
    expect(report.codes).toContainEqual({ code: "1302", count: 1 });
  });

  it("matches quota exhaustion text forms used by provider classification", () => {
    const root = mkdtempSync(join(tmpdir(), "provider-throttle-report-quota-"));
    roots.push(root);
    const statePath = join(root, "state.sqlite");
    new ReviewStateStore(statePath).close();
    const db = new DatabaseSync(statePath);
    try {
      insertProcessed(db, {
        repo: "owner/repo",
        pullNumber: 8,
        headSha: "usage-limit-head",
        status: "failed",
        error: "ProviderBusinessError: usage limit reached",
        createdAt: "2026-07-01 08:00:00"
      });
      insertProcessed(db, {
        repo: "owner/repo",
        pullNumber: 9,
        headSha: "expired-package-head",
        status: "failed",
        error: "ProviderBusinessError: package has expired",
        createdAt: "2026-07-01 09:00:00"
      });
    } finally {
      db.close();
    }

    const report = collectProviderThrottleReport({
      statePath,
      now: new Date("2026-07-08T00:00:00.000Z"),
      since: "7d",
      timezone: "Asia/Singapore"
    });

    expect(report.summary.providerErrors).toBe(2);
    expect(report.summary.quotaExhausted).toBe(2);
    expect(report.summary.unknownProviderError).toBe(0);
  });

  it("does not treat unrelated bracketed numbers as provider codes", () => {
    const root = mkdtempSync(join(tmpdir(), "provider-throttle-report-codes-"));
    roots.push(root);
    const statePath = join(root, "state.sqlite");
    new ReviewStateStore(statePath).close();
    const db = new DatabaseSync(statePath);
    try {
      insertProcessed(db, {
        repo: "owner/repo",
        pullNumber: 10,
        headSha: "unrelated-code-head",
        status: "failed",
        error: "Tool failed with internal marker [1234]",
        createdAt: "2026-07-01 08:00:00"
      });
      insertProcessed(db, {
        repo: "owner/repo",
        pullNumber: 11,
        headSha: "unrelated-known-code-head",
        status: "failed",
        error: "Tool failed with internal marker [1302]",
        createdAt: "2026-07-01 09:00:00"
      });
    } finally {
      db.close();
    }

    const report = collectProviderThrottleReport({
      statePath,
      now: new Date("2026-07-08T00:00:00.000Z"),
      since: "7d",
      timezone: "Asia/Singapore"
    });

    expect(report.summary.providerErrors).toBe(0);
    expect(report.codes).toEqual([]);
  });

  it("drops provider events whose SQLite timestamp cannot be bucketed by JavaScript", () => {
    const root = mkdtempSync(join(tmpdir(), "provider-throttle-report-malformed-timestamp-"));
    roots.push(root);
    const statePath = join(root, "state.sqlite");
    new ReviewStateStore(statePath).close();
    const db = new DatabaseSync(statePath);
    try {
      insertProcessed(db, {
        repo: "owner/repo",
        pullNumber: 11,
        headSha: "julian-date-head",
        status: "skipped",
        error: "provider_rate_limit_cooldown_until=2000-01-01T12:05:00.000Z; reason=provider_request_rate_limit; provider_code=1302",
        createdAt: "2451545.0"
      });
    } finally {
      db.close();
    }

    const report = collectProviderThrottleReport({
      statePath,
      now: new Date("2000-01-02T00:00:00.000Z"),
      since: "1999-12-31T00:00:00.000Z",
      timezone: "Asia/Singapore"
    });

    expect(report.summary).toMatchObject({
      providerErrors: 0,
      droppedEvents: 1,
      malformedTimestamps: 1
    });
    expect(report.hourly).toEqual([]);
    expect(report.repos).toEqual([]);
  });
});

function insertProcessed(
  db: DatabaseSync,
  input: {
    repo: string;
    pullNumber: number;
    headSha: string;
    status: string;
    error: string;
    createdAt: string;
  }
): void {
  db.prepare(
    `insert into processed_reviews (repo, pull_number, head_sha, status, error, created_at)
     values (?, ?, ?, ?, ?, ?)`
  ).run(input.repo, input.pullNumber, input.headSha, input.status, input.error, input.createdAt);
}

function insertQueueJob(
  db: DatabaseSync,
  input: {
    repo: string;
    pullNumber: number;
    headSha: string;
    state: string;
    lastError: string;
    createdAt: string;
    updatedAt: string;
  }
): void {
  db.prepare(
    `insert into review_queue_jobs
      (job_id, attempt_id, source, lane, repo, org, pull_number, head_sha,
       priority, state, last_error, created_at, updated_at)
     values (?, ?, 'automatic', 'background', ?, ?, ?, ?, 50, ?, ?, ?, ?)`
  ).run(
    `${input.state}-${input.headSha}`,
    `${input.state}:${input.repo}#${input.pullNumber}@${input.headSha}`,
    input.repo,
    input.repo.split("/")[0],
    input.pullNumber,
    input.headSha,
    input.state,
    input.lastError,
    input.createdAt,
    input.updatedAt
  );
}
