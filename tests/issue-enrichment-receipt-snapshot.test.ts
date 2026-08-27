import { describe, expect, it } from "vitest";
import {
  ISSUE_ENRICHMENT_RECEIPT_COUNT_KEYS,
  snapshotIssueEnrichmentReceipt,
  type IssueEnrichmentReceiptSnapshot
} from "../src/issue-enrichment-receipt-snapshot.js";

const counts = (overrides: Record<string, unknown> = {}) => Object.fromEntries(
  ISSUE_ENRICHMENT_RECEIPT_COUNT_KEYS.map((key) => [key, overrides[key] ?? 0])
);
const plainResult = (overrides: Record<string, unknown> = {}) => ({
  summary: counts(), status: { state: "ready", blockers: [] }, dryRun: false, ok: true, ...overrides
});
const snap = (value: unknown): IssueEnrichmentReceiptSnapshot => snapshotIssueEnrichmentReceipt(value as never);

describe("issue-enrichment hostile receipt snapshot", () => {
  it("accepts only ordinary roots and nested containers", () => {
    class Result { summary = counts(); status = { state: "ready", blockers: [] }; dryRun = false; ok = true; }
    for (const value of [new Map(), new Date(), new Result()]) {
      Object.assign(value, plainResult());
      expect(snap({ kind: "result", result: value }).summary).toEqual({ valid: false });
    }
    const nullResult = Object.assign(Object.create(null), plainResult());
    expect(snap({ kind: "result", result: nullResult }).summary.valid).toBe(true);
    for (const key of ["summary", "status"]) {
      const nested = new Date(); Object.assign(nested, key === "summary" ? counts() : { state: "ready", blockers: [] });
      expect(snap({ kind: "result", result: plainResult({ [key]: nested }) }).summary.valid).toBe(key !== "summary");
    }
    Object.assign(Object.prototype, { summary: counts(), status: { state: "ready", blockers: [] }, dryRun: false, ok: true });
    try { expect(snap({ kind: "result", result: {} })).toMatchObject({ summary: { valid: false }, dryRun: "unreadable", ok: "unreadable" }); } finally { for (const key of ["summary", "status", "dryRun", "ok"]) delete (Object.prototype as Record<string, unknown>)[key]; }
  });

  it("fails closed for revoked and throwing/stateful surfaces", () => {
    const revoked = Proxy.revocable({}, {}); revoked.revoke();
    const value = snap({ kind: "result", result: revoked.proxy });
    expect(value).toMatchObject({ kind: "result", summary: { valid: false }, status: { readable: false } });
    const hostile = plainResult();
    for (const key of ["summary", "status", "dryRun", "ok"]) Object.defineProperty(hostile, key, { get: () => { throw new Error("hostile"); } });
    expect(snap({ kind: "result", result: hostile })).toMatchObject({ summary: { valid: false }, dryRun: "unreadable", ok: "unreadable" });
    const status = new Proxy({ state: "blocked", blockers: [] }, { get() { throw new Error("status"); } });
    expect(snap({ kind: "result", result: plainResult({ status }) }).status).toMatchObject({ readable: false, state: "unreadable" });
    expect(snap({ kind: "result", result: new Proxy({}, { getOwnPropertyDescriptor() { throw new Error("descriptor"); } }) })).toMatchObject({ summary: { valid: false } });
    const blockers = Proxy.revocable([], {}); blockers.revoke();
    expect(snap({ kind: "result", result: plainResult({ status: { state: "blocked", blockers: blockers.proxy } }) }).status.blockers)
      .toMatchObject({ readable: false, complete: false, reasons: [] });
  });

  it("reads each count once, caps counts, and freezes an independent result", () => {
    const reads = new Map<string, number>();
    const summary = Object.fromEntries(ISSUE_ENRICHMENT_RECEIPT_COUNT_KEYS.map((key) => [key, {
      get: () => { reads.set(key, (reads.get(key) ?? 0) + 1); return key === "failed" ? 2_000_000 : 1; }
    }]));
    for (const [key, descriptor] of Object.entries(summary)) Object.defineProperty(summary, key, descriptor);
    const source = plainResult({ summary });
    const value = snap({ kind: "result", result: source });
    expect(reads.size).toBe(18); expect([...reads.values()].every((count) => count === 1)).toBe(true);
    expect(value.summary.valid && value.summary.counts.failed).toBe(1_000_000);
    expect(Object.isFrozen(value)).toBe(true); expect(Object.isFrozen(value.status.blockers.reasons)).toBe(true);
    Object.defineProperty(source, "summary", { value: counts({ failed: 0 }) });
    expect(value.summary.valid && value.summary.counts.failed).toBe(1_000_000);
  });

  it("caps blocker inspection at 32 and rejects sparse or unknown entries", () => {
    const blockers: unknown[] = []; blockers.length = 2_000_000_000; let reads = 0;
    for (let i = 0; i < 40; i++) Object.defineProperty(blockers, String(i), { get: () => { reads++; return "github_app_issues_permission_required"; } });
    const value = snap({ kind: "result", result: plainResult({ status: { state: "blocked", blockers } }) });
    expect(reads).toBe(32); expect(value.status.blockers).toMatchObject({ readable: true, complete: false });
    expect(snap({ kind: "result", result: plainResult({ status: { state: "blocked", blockers: ["future", 1] } }) }).status.blockers.complete).toBe(false);
  });

  it("extracts only a bounded leading blocker token from thrown errors", () => {
    const token = "issue_enrichment_model_runtime_required";
    expect(snap({ kind: "thrown", error: new Error(`${token}:${"x".repeat(10_000)}`) })).toMatchObject({ reason: token });
    expect(snap({ kind: "thrown", error: `context ${token}` })).toMatchObject({ reason: "unknown_failure" });
    const error = {}; Object.defineProperty(error, "message", { get: () => { throw new Error("no"); } });
    expect(snap({ kind: "thrown", error })).toMatchObject({ reason: "unknown_failure" });
    expect(snap({ kind: "oops", result: plainResult() })).toMatchObject({ kind: "thrown", reason: "unknown_failure" });
    expect(Object.isFrozen(ISSUE_ENRICHMENT_RECEIPT_COUNT_KEYS)).toBe(true);
  });
});
