import { describe, expect, it } from "vitest";
import { classifyIssueEnrichmentReceipt, classifyIssueEnrichmentSnapshot } from "../src/issue-enrichment-receipt.js";
import { ISSUE_ENRICHMENT_RECEIPT_COUNT_KEYS, snapshotIssueEnrichmentReceipt } from "../src/issue-enrichment-receipt-snapshot.js";
import { buildIssueEnrichmentStatus, DEFAULT_ISSUE_ENRICHMENT_CONFIG, DRY_RUN_IGNORED_ISSUE_ENRICHMENT_BLOCKERS } from "../src/issue-enrichment.js";

const counts = (overrides: Record<string, unknown> = {}) => Object.fromEntries(ISSUE_ENRICHMENT_RECEIPT_COUNT_KEYS.map((key) => [key, overrides[key] ?? 0]));
const result = (overrides: Record<string, unknown> = {}) => ({ ok: true, dryRun: false, status: { state: "ready", blockers: [] }, summary: counts(), ...overrides });
const classify = (value: unknown) => classifyIssueEnrichmentReceipt(value as never);
const unknown = { ok: false, code: "result_not_ok", reason: "unknown_failure" };

const relationCases = [
  ["read failures", { reposScanned: 1, readFailures: 1 }, { reposScanned: 1, readFailures: 2 }, { ok: false }, "read_failure"],
  ["truncated repos", { reposScanned: 1, truncatedRepos: 1 }, { reposScanned: 1, truncatedRepos: 2 }, {}, undefined],
  ["skipped plus eligible", { issuesSeen: 2, skipped: 1, eligible: 1 }, { issuesSeen: 1, skipped: 1, eligible: 1 }, {}, undefined],
  ["would enrich", { issuesSeen: 1, eligible: 1, wouldEnrich: 1 }, { issuesSeen: 1, eligible: 0, wouldEnrich: 1 }, {}, undefined],
  ["would comment", { issuesSeen: 1, eligible: 1, wouldEnrich: 1, wouldComment: 1 }, { issuesSeen: 1, eligible: 1, wouldEnrich: 0, wouldComment: 1 }, {}, undefined],
  ["deferred", { issuesSeen: 1, eligible: 1, deferred: 1 }, { issuesSeen: 1, eligible: 0, deferred: 1 }, {}, undefined],
  ["posted", { issuesSeen: 1, eligible: 1, wouldEnrich: 1, wouldComment: 1, posted: 1 }, { issuesSeen: 1, eligible: 1, wouldEnrich: 1, wouldComment: 0, posted: 1 }, {}, undefined],
  ["dry-run recorded", { issuesSeen: 1, eligible: 1, wouldEnrich: 1, dryRunRecorded: 1 }, { issuesSeen: 1, eligible: 1, wouldEnrich: 0, dryRunRecorded: 1 }, { status: { state: "dry_run_only", blockers: ["issue_enrichment_live_posting_disabled"] } }, undefined],
  ["skipped recorded", { issuesSeen: 1, skipped: 1, skippedRecorded: 1 }, { issuesSeen: 1, skipped: 0, skippedRecorded: 1 }, {}, undefined],
  ["deferred recorded", { issuesSeen: 1, eligible: 1, deferred: 1, deferredRecorded: 1 }, { issuesSeen: 1, eligible: 1, deferred: 0, deferredRecorded: 1 }, {}, undefined],
  ["already processed", { issuesSeen: 1, alreadyProcessed: 1 }, { issuesSeen: 0, alreadyProcessed: 1 }, {}, undefined],
  ["item failures", { issuesSeen: 1, failed: 1 }, { issuesSeen: 0, failed: 1 }, { ok: false }, "item_failure"]
] as const;

describe("issue-enrichment receipt classifier", () => {
  it.each([
    ["resolved undefined", { kind: "result", result: undefined }, { ok: false, code: "malformed_summary", reason: "malformed_summary" }],
    ["thrown undefined", { kind: "thrown", error: undefined }, { ok: false, code: "cycle_failed", reason: "unknown_failure" }],
    ["lease", { kind: "result", result: result({ summary: counts({ workerSkipped: 1 }) }) }, { ok: true, code: "lease_skipped" }],
    ["disabled", { kind: "result", result: result({ status: buildIssueEnrichmentStatus({ config: { issueEnrichment: DEFAULT_ISSUE_ENRICHMENT_CONFIG }, canPostAsApp: false }) }) }, { ok: true, code: "disabled" }],
    ["blocked", { kind: "result", result: result({ ok: false, status: { state: "blocked", blockers: ["github_app_issues_permission_required"] } }) }, { ok: false, code: "blocked" }],
    ["ignored dry-run blocker", { kind: "result", result: result({ dryRun: true, status: { state: "blocked", blockers: ["issue_enrichment_model_runtime_required"] } }) }, { ok: true, code: "no_candidates" }],
    ["read failure before ignored blocker", { kind: "result", result: result({ ok: false, dryRun: true, status: { state: "blocked", blockers: ["issue_enrichment_model_runtime_required"] }, summary: counts({ reposScanned: 1, readFailures: 1 }) }) }, { ok: false, reason: "read_failure" }],
    ["item failure before ignored blocker", { kind: "result", result: result({ ok: false, dryRun: true, status: { state: "blocked", blockers: ["issue_enrichment_model_runtime_required"] }, summary: counts({ issuesSeen: 1, failed: 1 }) }) }, { ok: false, reason: "item_failure" }],
    ["mixed effective blocker", { kind: "result", result: result({ ok: false, dryRun: true, status: { state: "blocked", blockers: ["issue_enrichment_model_runtime_required", "github_app_issues_permission_required"] } }) }, { ok: false, code: "blocked", reason: "github_app_issues_permission_required" }],
    ["completed", { kind: "result", result: result({ summary: counts({ issuesSeen: 1, eligible: 1 }) }) }, { ok: true, code: "completed" }],
    ["no candidates", { kind: "result", result: result() }, { ok: true, code: "no_candidates" }]
  ])("classifies %s", (_name, input, expected) => expect(classify(input)).toMatchObject(expected));

  it.each(relationCases)("accepts exact %s relation boundaries", (_name, valid, _invalid, controls, reason) => {
    const receipt = classify({ kind: "result", result: result({ ...controls, summary: counts(valid) }) });
    expect(receipt).not.toMatchObject(unknown); if (reason) expect(receipt.reason).toBe(reason);
  });
  it.each(relationCases)("rejects %s contradictions", (_name, _valid, invalid, controls) => {
    expect(classify({ kind: "result", result: result({ ...controls, summary: counts(invalid) }) })).toMatchObject(unknown);
  });

  it.each(["workerSkipped", "posted", "dryRunRecorded", "skippedRecorded", "deferredRecorded"])("rejects dry-run %s", (key) => {
    expect(classify({ kind: "result", result: result({ dryRun: true, summary: counts({ issuesSeen: 1, eligible: 1, wouldEnrich: 1, [key]: 1 }) }) })).toMatchObject(unknown);
  });
  it.each([
    ["duplicate blockers", { dryRun: true, status: { state: "blocked", blockers: ["issue_enrichment_model_runtime_required", "issue_enrichment_model_runtime_required"] } }],
    ["lease mixed", { summary: counts({ workerSkipped: 1, reposScanned: 1 }) }],
    ["disabled work", { status: { state: "disabled", blockers: ["issue_enrichment_disabled"] }, summary: counts({ issuesSeen: 1 }) }],
    ["live ready dry-run record", { summary: counts({ issuesSeen: 1, eligible: 1, wouldEnrich: 1, dryRunRecorded: 1 }) }],
    ["live dry-run-only post", { status: { state: "dry_run_only", blockers: ["issue_enrichment_live_posting_disabled"] }, summary: counts({ issuesSeen: 1, eligible: 1, wouldEnrich: 1, wouldComment: 1, posted: 1 }) }],
    ["blocked after work", { ok: false, status: { state: "blocked", blockers: ["github_app_issues_permission_required"] }, summary: counts({ reposScanned: 1 }) }]
  ])("rejects contradictory %s", (_name, overrides) => expect(classify({ kind: "result", result: result(overrides) })).toMatchObject(unknown));

  it("snapshots once, stays deterministic, and emits only bounded fields", () => {
    let reads = 0; const source = result(); for (const key of ["summary", "status", "dryRun", "ok"] as const) { const value = source[key]; Object.defineProperty(source, key, { get: () => { reads += 1; return value; } }); }
    const receipt = classify({ kind: "result", result: source }); expect(reads).toBe(4); expect(Object.keys(receipt).sort()).toEqual(["code", "counts", "ok", "stage"]);
    const reordered = { status: source.status, ok: source.ok, summary: source.summary, dryRun: source.dryRun };
    expect(classify({ kind: "result", result: reordered })).toEqual(receipt);
    const snapshot = snapshotIssueEnrichmentReceipt({ kind: "result", result: result({ dryRun: true, status: { state: "blocked", blockers: ["issue_enrichment_model_runtime_required"] } }) });
    const before = classifyIssueEnrichmentSnapshot(snapshot), removed = DRY_RUN_IGNORED_ISSUE_ENRICHMENT_BLOCKERS.delete("issue_enrichment_model_runtime_required");
    try { expect(classifyIssueEnrichmentSnapshot(snapshot)).toEqual(before); } finally { if (removed) DRY_RUN_IGNORED_ISSUE_ENRICHMENT_BLOCKERS.add("issue_enrichment_model_runtime_required"); }
    expect(JSON.stringify(classify({ kind: "thrown", error: new Error("customer https://example.test ghp_secret") }))).not.toMatch(/customer|example|ghp_/);
  });
});
