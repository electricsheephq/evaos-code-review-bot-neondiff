import { describe, expect, it } from "vitest";
import { classifyIssueEnrichmentReceipt, classifyIssueEnrichmentSnapshot } from "../src/issue-enrichment-receipt.js";
import { ISSUE_ENRICHMENT_RECEIPT_COUNT_KEYS, snapshotIssueEnrichmentReceipt } from "../src/issue-enrichment-receipt-snapshot.js";

const counts = (overrides: Record<string, unknown> = {}) => Object.fromEntries(
  ISSUE_ENRICHMENT_RECEIPT_COUNT_KEYS.map((key) => [key, overrides[key] ?? 0])
);
const result = (overrides: Record<string, unknown> = {}) => ({
  ok: true, dryRun: false, status: { state: "ready", blockers: [] }, summary: counts(), ...overrides
});
const classify = (value: unknown) => classifyIssueEnrichmentReceipt(value as never);
const notOk = { ok: false, code: "result_not_ok", reason: "unknown_failure" };

describe("issue-enrichment receipt classifier", () => {
  it.each([
    ["resolved undefined", { kind: "result", result: undefined }, { ok: false, code: "malformed_summary", reason: "malformed_summary" }],
    ["thrown undefined", { kind: "thrown", error: undefined }, { ok: false, code: "cycle_failed", reason: "unknown_failure" }],
    ["canonical lease", { kind: "result", result: result({ summary: counts({ workerSkipped: 1 }) }) }, { ok: true, code: "lease_skipped", reason: "worker_lease_held" }],
    ["dry-run-only lease", { kind: "result", result: result({ status: { state: "dry_run_only", blockers: ["issue_enrichment_live_posting_disabled"] }, summary: counts({ workerSkipped: 1 }) }) }, { ok: true, code: "lease_skipped", reason: "worker_lease_held" }],
    ["canonical disabled", { kind: "result", result: result({ status: { state: "disabled", blockers: ["issue_enrichment_disabled"] } }) }, { ok: true, code: "disabled" }],
    ["effective blocker", { kind: "result", result: result({ ok: false, status: { state: "blocked", blockers: ["github_app_issues_permission_required"] } }) }, { ok: false, code: "blocked", reason: "github_app_issues_permission_required" }],
    ["ignored dry-run blocker", { kind: "result", result: result({ dryRun: true, status: { state: "blocked", blockers: ["issue_enrichment_model_runtime_required"] } }) }, { ok: true, code: "no_candidates" }],
    ["dry-run-only work", { kind: "result", result: result({ status: { state: "dry_run_only", blockers: ["issue_enrichment_live_posting_disabled"] }, summary: counts({ issuesSeen: 1, wouldEnrich: 1 }) }) }, { ok: true, code: "completed" }],
    ["no candidates", { kind: "result", result: result() }, { ok: true, code: "no_candidates" }]
  ])("classifies %s", (_name, input, expected) => expect(classify(input)).toMatchObject(expected));

  it.each(["workerSkipped", "posted", "dryRunRecorded", "skippedRecorded", "deferredRecorded"])(
    "rejects dry-run %s", (key) => expect(classify({ kind: "result", result: result({ dryRun: true, summary: counts({ [key]: 1 }) }) })).toMatchObject(notOk)
  );

  it.each(["eligible", "skipped", "wouldEnrich", "wouldComment", "deferred", "posted", "dryRunRecorded", "skippedRecorded", "deferredRecorded", "alreadyProcessed", "failed"])(
    "requires issuesSeen for %s", (key) => expect(classify({ kind: "result", result: result({ ok: false, summary: counts({ [key]: 1 }) }) })).toMatchObject(notOk)
  );

  it.each([
    ["lease count", { summary: counts({ workerSkipped: 2 }) }],
    ["lease mixed", { summary: counts({ workerSkipped: 1, reposScanned: 1 }) }],
    ["blocked lease", { ok: false, status: { state: "blocked", blockers: ["github_app_issues_permission_required"] }, summary: counts({ workerSkipped: 1 }) }],
    ["disabled marker", { status: { state: "disabled", blockers: [] } }],
    ["disabled work", { status: { state: "disabled", blockers: ["issue_enrichment_disabled"] }, summary: counts({ issuesSeen: 1 }) }],
    ["live ready dry-run record", { summary: counts({ issuesSeen: 1, dryRunRecorded: 1 }) }],
    ["live dry-run-only post", { status: { state: "dry_run_only", blockers: ["issue_enrichment_live_posting_disabled"] }, summary: counts({ issuesSeen: 1, posted: 1 }) }],
    ["mixed post modes", { summary: counts({ issuesSeen: 1, posted: 1, dryRunRecorded: 1 }) }],
    ["post without issue", { summary: counts({ posted: 1 }) }],
    ["read failure without repo", { ok: false, summary: counts({ readFailures: 1 }) }],
    ["successful read failure", { summary: counts({ reposScanned: 1, readFailures: 1 }) }],
    ["successful item failure", { summary: counts({ issuesSeen: 1, failed: 1 }) }],
    ["blocked after work", { ok: false, status: { state: "blocked", blockers: ["github_app_issues_permission_required"] }, summary: counts({ issuesSeen: 1 }) }]
  ])("rejects contradictory %s evidence", (_name, overrides) => {
    expect(classify({ kind: "result", result: result(overrides) })).toMatchObject(notOk);
  });

  it.each([
    [{ ok: false, summary: counts({ reposScanned: 1, readFailures: 1 }) }, "read_failure"],
    [{ ok: false, summary: counts({ issuesSeen: 1, failed: 1 }) }, "item_failure"]
  ])("preserves a valid partial failure", (overrides, reason) => {
    expect(classify({ kind: "result", result: result(overrides) })).toMatchObject({ ok: false, code: "result_not_ok", reason });
  });

  it("snapshots once and emits only the bounded stable schema", () => {
    let reads = 0; const source = result();
    for (const key of ["summary", "status", "dryRun", "ok"] as const) {
      const value = source[key]; Object.defineProperty(source, key, { get: () => { reads += 1; return value; } });
    }
    const receipt = classify({ kind: "result", result: source });
    expect(reads).toBe(4); expect(Object.keys(receipt).sort()).toEqual(["code", "counts", "ok", "stage"]);
    const snapshot = snapshotIssueEnrichmentReceipt({ kind: "result", result: result({ summary: counts({ issuesSeen: 1, eligible: 1 }) }) });
    expect(classifyIssueEnrichmentSnapshot(snapshot)).toEqual(classifyIssueEnrichmentSnapshot(snapshot));
    expect(JSON.stringify(classify({ kind: "thrown", error: new Error("customer https://example.test ghp_secret") }))).not.toMatch(/customer|example|ghp_/);
    const hostile = Proxy.revocable({}, {}); hostile.revoke(); expect(classify({ kind: "result", result: hostile.proxy })).toMatchObject({ ok: false, code: "malformed_summary" });
  });
});
