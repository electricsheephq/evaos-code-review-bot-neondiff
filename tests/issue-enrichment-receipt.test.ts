import { describe, expect, it } from "vitest";
import { classifyIssueEnrichmentReceipt, classifyIssueEnrichmentSnapshot } from "../src/issue-enrichment-receipt.js";
import {
  ISSUE_ENRICHMENT_RECEIPT_COUNT_CAP,
  ISSUE_ENRICHMENT_RECEIPT_COUNT_KEYS,
  snapshotIssueEnrichmentReceipt
} from "../src/issue-enrichment-receipt-snapshot.js";

const counts = (overrides: Record<string, unknown> = {}) => Object.fromEntries(
  ISSUE_ENRICHMENT_RECEIPT_COUNT_KEYS.map((key) => [key, overrides[key] ?? 0])
);
const result = (overrides: Record<string, unknown> = {}) => ({
  ok: true, dryRun: false, status: { state: "ready", blockers: [] }, summary: counts(), ...overrides
});
const classify = (input: unknown) => classifyIssueEnrichmentReceipt(input as never);

describe("issue-enrichment receipt classifier", () => {
  it.each([
    ["resolved undefined", { kind: "result", result: undefined }, false, "malformed_summary", "malformed_summary"],
    ["thrown undefined", { kind: "thrown", error: undefined }, false, "cycle_failed", "unknown_failure"],
    ["lease before disabled", { kind: "result", result: result({ summary: counts({ workerSkipped: 1 }), status: { state: "disabled", blockers: ["issue_enrichment_disabled"] } }) }, true, "lease_skipped", "worker_lease_held"],
    ["disabled", { kind: "result", result: result({ summary: counts({ issuesSeen: 2 }), status: { state: "disabled", blockers: ["issue_enrichment_disabled"] } }) }, true, "disabled", undefined],
    ["ignored blocker with read failure", { kind: "result", result: result({ ok: false, dryRun: true, summary: counts({ readFailures: 1 }), status: { state: "blocked", blockers: ["issue_enrichment_model_runtime_required"] } }) }, false, "result_not_ok", "read_failure"],
    ["mixed blockers", { kind: "result", result: result({ ok: false, dryRun: true, status: { state: "blocked", blockers: ["issue_enrichment_model_runtime_required", "github_app_issues_permission_required"] } }) }, false, "blocked", "github_app_issues_permission_required"],
    ["ready plus effective blocker", { kind: "result", result: result({ status: { state: "ready", blockers: ["github_app_issues_permission_required"] } }) }, false, "result_not_ok", "unknown_failure"],
    ["ready plus ignored blocker in dry run", { kind: "result", result: result({ dryRun: true, status: { state: "ready", blockers: ["issue_enrichment_live_posting_disabled"] } }) }, false, "result_not_ok", "unknown_failure"],
    ["dry-run-only cycle", { kind: "result", result: result({ status: { state: "dry_run_only", blockers: ["issue_enrichment_live_posting_disabled"] }, summary: counts({ wouldEnrich: 1 }) }) }, true, "completed", undefined],
    ["dry-run-only without canonical blocker", { kind: "result", result: result({ status: { state: "dry_run_only", blockers: [] } }) }, false, "result_not_ok", "unknown_failure"],
    ["dry-run-only plus effective blocker", { kind: "result", result: result({ status: { state: "dry_run_only", blockers: ["issue_enrichment_live_posting_disabled", "github_app_issues_permission_required"] } }) }, false, "result_not_ok", "unknown_failure"],
    ["blocked without blockers", { kind: "result", result: result({ status: { state: "blocked", blockers: [] } }) }, false, "result_not_ok", "unknown_failure"],
    ["blocked with nonblocking reason", { kind: "result", result: result({ dryRun: true, status: { state: "blocked", blockers: ["issue_enrichment_live_posting_disabled"] } }) }, false, "result_not_ok", "unknown_failure"],
    ["blocked ignored blocker in dry run", { kind: "result", result: result({ dryRun: true, status: { state: "blocked", blockers: ["issue_enrichment_model_runtime_required"] } }) }, true, "no_candidates", undefined],
    ["effective blocker before scan", { kind: "result", result: result({ ok: false, status: { state: "blocked", blockers: ["github_app_issues_permission_required"] } }) }, false, "blocked", "github_app_issues_permission_required"],
    ["effective blocker after scan", { kind: "result", result: result({ ok: false, summary: counts({ issuesSeen: 1 }), status: { state: "blocked", blockers: ["github_app_issues_permission_required"] } }) }, false, "result_not_ok", "unknown_failure"],
    ["completed", { kind: "result", result: result({ summary: counts({ posted: 1 }) }) }, true, "completed", undefined],
    ["no candidates", { kind: "result", result: result() }, true, "no_candidates", undefined],
    ["capped completion", { kind: "result", result: result({ summary: counts({ posted: Number.MAX_SAFE_INTEGER }) }) }, true, "completed", undefined]
  ])("classifies %s", (name, input, ok, code, reason) => {
    const receipt = classify(input);
    expect(receipt).toMatchObject({ ok, stage: "issue_enrichment", code, ...(reason ? { reason } : {}) });
    if (code === "disabled") expect(Object.values(receipt.counts).every((count) => count === 0)).toBe(true);
    if (name === "capped completion") expect(receipt.counts.posted).toBe(ISSUE_ENRICHMENT_RECEIPT_COUNT_CAP);
  });

  it.each([
    ["missing count", (() => { const value = counts(); delete value.failed; return value; })()],
    ["negative", counts({ failed: -1 })], ["fractional", counts({ failed: 1.5 })],
    ["NaN", counts({ failed: Number.NaN })], ["string", counts({ failed: "1" })], ["null", null]
  ])("fails closed for malformed summary: %s", (_name, summary) => {
    expect(classify({ kind: "result", result: result({ summary }) })).toMatchObject({ ok: false, code: "malformed_summary" });
  });

  it("fails closed for hostile controls and emits only the bounded schema", () => {
    const hostile = result();
    for (const key of ["status", "dryRun", "ok"]) Object.defineProperty(hostile, key, { get: () => { throw new Error("secret"); } });
    expect(classify({ kind: "result", result: hostile })).toMatchObject({ ok: false, code: "result_not_ok", reason: "unknown_failure" });
    const receipt = classify({ kind: "thrown", error: new Error("customer body https://example.test ghp_secret") });
    expect(Object.keys(receipt).sort()).toEqual(["code", "counts", "ok", "reason", "stage"]);
    expect(JSON.stringify(receipt)).not.toMatch(/ghp_secret|example\.test|customer body/);
    const snapshot = snapshotIssueEnrichmentReceipt({ kind: "result", result: result({ summary: counts({ eligible: 1 }) }) });
    expect(classifyIssueEnrichmentSnapshot(snapshot)).toEqual(classifyIssueEnrichmentSnapshot(snapshot));
  });
});
