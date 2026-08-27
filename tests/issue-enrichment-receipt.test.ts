import { describe, expect, it } from "vitest";
import {
  classifyIssueEnrichmentReceipt,
  classifyIssueEnrichmentSnapshot,
  type IssueEnrichmentLaneReceipt
} from "../src/issue-enrichment-receipt.js";
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
const classify = (input: unknown): IssueEnrichmentLaneReceipt => classifyIssueEnrichmentReceipt(input as never);

describe("issue-enrichment receipt classifier", () => {
  it.each([
    ["resolved undefined", { kind: "result", result: undefined }, false, "malformed_summary", "malformed_summary"],
    ["thrown undefined", { kind: "thrown", error: undefined }, false, "cycle_failed", "unknown_failure"],
    ["lease before disabled", { kind: "result", result: result({ summary: counts({ workerSkipped: 1 }), status: { state: "disabled", blockers: ["issue_enrichment_disabled"] } }) }, true, "lease_skipped", "worker_lease_held"],
    ["disabled", { kind: "result", result: result({ summary: counts({ issuesSeen: 2 }), status: { state: "disabled", blockers: ["issue_enrichment_disabled"] } }) }, true, "disabled", undefined],
    ["ignored blocker with read failure", { kind: "result", result: result({ ok: false, dryRun: true, summary: counts({ readFailures: 1 }), status: { state: "blocked", blockers: ["issue_enrichment_model_runtime_required"] } }) }, false, "result_not_ok", "read_failure"],
    ["mixed blockers", { kind: "result", result: result({ ok: false, dryRun: true, status: { state: "blocked", blockers: ["issue_enrichment_model_runtime_required", "github_app_issues_permission_required"] } }) }, false, "blocked", "github_app_issues_permission_required"],
    ["blocker after scan", { kind: "result", result: result({ ok: false, summary: counts({ issuesSeen: 1 }), status: { state: "blocked", blockers: ["github_app_issues_permission_required"] } }) }, false, "result_not_ok", "unknown_failure"],
    ["completed", { kind: "result", result: result({ summary: counts({ wouldEnrich: 1 }) }) }, true, "completed", undefined],
    ["no candidates", { kind: "result", result: result() }, true, "no_candidates", undefined],
    ["capped completion", { kind: "result", result: result({ summary: counts({ posted: Number.MAX_SAFE_INTEGER }) }) }, true, "completed", undefined]
  ])("classifies %s", (_name, input, ok, code, reason) => {
    const receipt = classify(input);
    expect(receipt).toMatchObject({ ok, stage: "issue_enrichment", code, ...(reason ? { reason } : {}) });
    if (code === "disabled") expect(Object.values(receipt.counts).every((count) => count === 0)).toBe(true);
    if (_name === "capped completion") expect(receipt.counts.posted).toBe(ISSUE_ENRICHMENT_RECEIPT_COUNT_CAP);
  });

  it.each([
    ["missing count", (() => { const value = counts(); delete value.failed; return value; })()],
    ["negative", counts({ failed: -1 })], ["fractional", counts({ failed: 1.5 })],
    ["NaN", counts({ failed: Number.NaN })], ["string", counts({ failed: "1" })], ["null", null]
  ])("fails closed for malformed summary: %s", (_name, summary) => {
    expect(classify({ kind: "result", result: result({ summary }) })).toMatchObject({ ok: false, code: "malformed_summary", reason: "malformed_summary" });
  });

  it("fails closed when status, blockers, dry-run, or ok are unreadable", () => {
    const hostile = result();
    for (const key of ["status", "dryRun", "ok"]) Object.defineProperty(hostile, key, { get: () => { throw new Error("secret"); } });
    expect(classify({ kind: "result", result: hostile })).toMatchObject({ ok: false, code: "result_not_ok", reason: "unknown_failure" });
    const blockers = Proxy.revocable([], {}); blockers.revoke();
    expect(classify({ kind: "result", result: result({ status: { state: "blocked", blockers: blockers.proxy } }) })).toMatchObject({ ok: false, code: "result_not_ok" });
    expect(classify({ kind: "result", result: result({ summary: counts({ workerSkipped: 1 }), ok: "yes" }) })).toMatchObject({ ok: false, code: "result_not_ok" });
  });

  it("classifies a frozen snapshot deterministically and emits only the bounded schema", () => {
    const snapshot = snapshotIssueEnrichmentReceipt({ kind: "result", result: result({ summary: counts({ eligible: 1 }) }) });
    expect(classifyIssueEnrichmentSnapshot(snapshot)).toEqual(classifyIssueEnrichmentSnapshot(snapshot));
    const receipt = classify({ kind: "thrown", error: new Error("customer body https://example.test ghp_secret") });
    expect(Object.keys(receipt).sort()).toEqual(["code", "counts", "ok", "reason", "stage"]);
    expect(JSON.stringify(receipt)).not.toMatch(/ghp_secret|example\.test|customer body/);
  });
});
