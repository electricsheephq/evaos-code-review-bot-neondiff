import { describe, expect, it } from "vitest";
import { classifyIssueEnrichmentAdmission } from "../src/issue-enrichment-admission-decision.js";
import { snapshotIssueEnrichmentAdmission, type IssueEnrichmentAdmissionInput as Input } from "../src/issue-enrichment-admission-snapshot.js";

const checkedAt = "2026-08-26T00:00:00Z", issueUpdatedAt = "2026-08-25T00:00:00Z";
const snapshot = (action: Input["items"][number]["action"], record?: Input["records"] extends readonly (infer Record)[] | undefined ? Record : never, itemExtra: Record<string, unknown> = {}) => snapshotIssueEnrichmentAdmission({
  allowlist: ["a/repo"], checkedAt, limits: {},
  items: [{ repo: "a/repo", issueNumber: 1, state: "open", action, issueUpdatedAt, ...itemExtra }],
  ...(record ? { records: [{ repo: "a/repo", issueNumber: 1, ...record }] as Input["records"] } : {})
});

describe("issue-enrichment admission decisions", () => {
  it.each([
    ["no record", snapshot("would_enrich"), "pending", "no_record"],
    ["failed", snapshot("would_enrich", { status: "failed", issueUpdatedAt }), "pending", "record_failed"],
    ["skipped", snapshot("would_enrich", { status: "skipped", issueUpdatedAt }), "pending", "record_skipped"],
    ["future persisted defer, equal identity", snapshot("would_enrich", { status: "deferred", issueUpdatedAt, nextEligibleAt: "2026-08-27T00:00:00Z" }), "held", "persisted_defer_active"],
    ["future persisted defer, changed identity", snapshot("would_enrich", { status: "deferred", issueUpdatedAt: "2026-08-24T00:00:00Z", nextEligibleAt: "2026-08-27T00:00:00Z" }), "pending", "persisted_defer_identity_unknown_or_changed"],
    ["future persisted defer, unknown identity", snapshot("would_enrich", { status: "deferred", nextEligibleAt: "2026-08-27T00:00:00Z" }, { issueUpdatedAt: undefined }), "pending", "persisted_defer_identity_unknown_or_changed"],
    ["due persisted defer", snapshot("would_enrich", { status: "deferred", issueUpdatedAt, nextEligibleAt: checkedAt }), "pending", "persisted_defer_due_or_unknown"],
    ["dry run enrich, equal identity", snapshot("would_enrich", { status: "dry_run", issueUpdatedAt }), "already_recorded", "dry_run_equal_identity"],
    ["dry run enrich, changed identity", snapshot("would_enrich", { status: "dry_run", issueUpdatedAt: "2026-08-24T00:00:00Z" }), "pending", "dry_run_identity_unknown_or_changed"],
    ["dry run to live comment", snapshot("would_comment", { status: "dry_run", issueUpdatedAt }), "pending", "dry_run_requires_live"],
    ["posted always needs source comparison", snapshot("would_enrich", { status: "posted", issueUpdatedAt, analysisInputHash: "a".repeat(64) }), "source_dependent", "posted_requires_source_comparison"],
    ["future current defer", snapshot("deferred", undefined, { intendedAction: "would_enrich", nextEligibleAt: "2026-08-27T00:00:00Z" }), "held", "current_defer_active"],
    ["due current defer", snapshot("deferred", undefined, { intendedAction: "would_enrich", nextEligibleAt: checkedAt }), "pending", "current_defer_due_or_unknown"],
    ["current skipped", snapshot("skipped"), "pending", "current_scan_skipped"]
  ] as const)("classifies %s conservatively", (_name, input, state, reason) => {
    expect(classifyIssueEnrichmentAdmission(input)).toMatchObject([{ key: "a/repo#1", state, reason }]);
  });

  it("is deterministic and freezes decisions without changing candidate order", () => {
    const input = snapshotIssueEnrichmentAdmission({ allowlist: ["b/repo", "a/repo"], checkedAt, limits: {}, items: [
      { repo: "a/repo", issueNumber: 1, state: "open", action: "would_enrich", issueUpdatedAt },
      { repo: "b/repo", issueNumber: 2, state: "open", action: "would_enrich", issueUpdatedAt }
    ] });
    const decisions = classifyIssueEnrichmentAdmission(input);
    expect(decisions.map(({ key }) => key)).toEqual(["b/repo#2", "a/repo#1"]);
    expect(Object.isFrozen(decisions)).toBe(true); expect(decisions.every(Object.isFrozen)).toBe(true);
    expect(() => classifyIssueEnrichmentAdmission(null as any)).toThrow(/invalid_snapshot/);
  });
});
