import { describe, expect, it } from "vitest";
import {
  classifyIssueEnrichmentReceipt,
  ISSUE_ENRICHMENT_RECEIPT_COUNT_KEYS,
  ISSUE_ENRICHMENT_RECEIPT_COUNT_CAP,
  type IssueEnrichmentReceiptInput
} from "../src/issue-enrichment-receipt.js";

const summary = (overrides: Record<string, unknown> = {}) => Object.fromEntries(
  ISSUE_ENRICHMENT_RECEIPT_COUNT_KEYS.map((key) => [key, overrides[key] ?? 0])
);
const result = (overrides: Record<string, unknown> = {}) => ({
  ok: true,
  dryRun: false,
  status: { state: "ready", blockers: [] },
  summary: summary(),
  ...overrides
});
const classify = (value: unknown): ReturnType<typeof classifyIssueEnrichmentReceipt> =>
  classifyIssueEnrichmentReceipt(value as IssueEnrichmentReceiptInput);

describe("issue-enrichment receipt precedence", () => {
  it.each([
    ["thrown raw sentinel", { kind: "thrown", error: new Error("ghp_fake_token issue_enrichment_model_runtime_required") }, "cycle_failed", "issue_enrichment_model_runtime_required"],
    ["lease overrides disabled", { kind: "result", result: result({ summary: summary({ workerSkipped: 1 }), status: { state: "disabled", blockers: [] } }) }, "lease_skipped", "worker_lease_held"],
    ["disabled", { kind: "result", result: result({ status: { state: "disabled", blockers: [] }, summary: summary({ issuesSeen: 5 }) }) }, "disabled", undefined],
    ["dry-run ignored blocker does not mask read failure", { kind: "result", result: result({ dryRun: true, ok: false, status: { state: "blocked", blockers: ["issue_enrichment_model_runtime_required"] }, summary: summary({ readFailures: 1 }) }) }, "result_not_ok", "read_failure"],
    ["mixed ignored and effective blocker", { kind: "result", result: result({ ok: false, dryRun: true, status: { state: "blocked", blockers: ["issue_enrichment_model_runtime_required", "github_app_issues_permission_required"] } }) }, "blocked", "github_app_issues_permission_required"],
    ["effective blocker after scan evidence", { kind: "result", result: result({ ok: false, status: { state: "blocked", blockers: ["github_app_issues_permission_required"] }, summary: summary({ issuesSeen: 1 }) }) }, "result_not_ok", "unknown_failure"],
    ["positive completed", { kind: "result", result: result({ summary: summary({ wouldEnrich: 1 }) }) }, "completed", undefined],
    ["all-zero no candidates", { kind: "result", result: result() }, "no_candidates", undefined],
    ["oversized valid values cap", { kind: "result", result: result({ summary: summary({ wouldEnrich: Number.MAX_SAFE_INTEGER }) }) }, "completed", undefined]
  ])("classifies %s", (_name, input, code, reason) => {
    const receipt = classify(input);
    expect(receipt).toMatchObject({ code, ...(reason ? { reason } : {}) });
    if (code === "lease_skipped") expect(receipt.counts.workerSkipped).toBe(1);
    if (code === "disabled") expect(Object.values(receipt.counts).every((count) => count === 0)).toBe(true);
    if (_name === "oversized valid values cap") expect(receipt.counts.wouldEnrich).toBe(ISSUE_ENRICHMENT_RECEIPT_COUNT_CAP);
  });

  it.each([
    ["missing", (() => { const value = summary(); delete value.failed; return value; })()],
    ["negative", summary({ failed: -1 })], ["NaN", summary({ failed: Number.NaN })],
    ["fractional", summary({ failed: 1.5 })], ["string", summary({ failed: "1" })],
    ["null", null], ["array", []]
  ])("malformed %s overrides worker lease", (_name, malformed) => {
    const receipt = classify({ kind: "result", result: result({ summary: malformed }) });
    expect(receipt).toMatchObject({ ok: false, code: "malformed_summary", reason: "malformed_summary" });
    expect(Object.values(receipt.counts).every((count) => count === 0)).toBe(true);
  });

  it("emits only the bounded sanitized receipt shape", () => {
    const receipt = classify({ kind: "thrown", error: new Error("customer body https://example.test ghp_secret") });
    expect(receipt).not.toHaveProperty("error");
    expect(receipt).not.toHaveProperty("result");
    expect(receipt).not.toHaveProperty("status");
    expect(receipt).not.toHaveProperty("blockers");
    expect(JSON.stringify(receipt)).not.toContain("ghp_secret");
    expect(JSON.stringify(receipt)).not.toContain("example.test");
  });
});
