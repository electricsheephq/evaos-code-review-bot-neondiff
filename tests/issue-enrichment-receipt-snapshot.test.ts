import { describe, expect, it } from "vitest";
import {
  ISSUE_ENRICHMENT_RECEIPT_COUNT_KEYS,
  snapshotIssueEnrichmentReceipt,
  type IssueEnrichmentReceiptSnapshot
} from "../src/issue-enrichment-receipt-snapshot.js";
const summary = (overrides: Record<string, unknown> = {}) => Object.fromEntries(ISSUE_ENRICHMENT_RECEIPT_COUNT_KEYS.map((key) => [key, overrides[key] ?? 0]));
const result = (overrides: Record<string, unknown> = {}) => ({ summary: summary(), status: { state: "ready", blockers: [] }, dryRun: false, ok: true, ...overrides });
const snap = (input: unknown): IssueEnrichmentReceiptSnapshot =>
  snapshotIssueEnrichmentReceipt(input as never);
describe("issue-enrichment hostile receipt snapshot", () => {
  it("never throws for a revoked result and returns only markers", () => {
    const revoked = Proxy.revocable({}, {}); revoked.revoke();
    const value = snap({ kind: "result", result: revoked.proxy });
    expect(value.kind).toBe("result");
    expect(value.summary.valid).toBe(false);
    expect(value.status).toMatchObject({ readable: false, state: "unreadable" });
    expect(Object.isFrozen(value.status.blockers.reasons)).toBe(true);
    expect(JSON.stringify(value)).not.toContain("proxy");
    const hostile = result(); for (const key of ["summary", "status", "dryRun", "ok"]) Object.defineProperty(hostile, key, { get: () => { throw new Error("hostile"); } });
    expect(snap({ kind: "result", result: hostile })).toMatchObject({ summary: { valid: false }, dryRun: "unreadable", ok: "unreadable" });
  });
  it("reads roots and all 18 counts at most once, then freezes values", () => {
    const reads = new Map<string, number>();
    const count = (key: string, value: unknown) => ({ get: () => {
      reads.set(key, (reads.get(key) ?? 0) + 1); return value;
    }});
    const counts = {}; Object.defineProperties(counts, Object.fromEntries(ISSUE_ENRICHMENT_RECEIPT_COUNT_KEYS.map((key) => [key, count(key, 1)])));
    const source = result({ summary: counts });
    for (const key of ["summary", "status", "dryRun", "ok"]) {
      const value = (source as Record<string, unknown>)[key];
      Object.defineProperty(source, key, { configurable: true, get: () => {
        reads.set(key, (reads.get(key) ?? 0) + 1); return value;
      }});
    }
    const value = snap({ kind: "result", result: source });
    expect([...reads.values()].every((read) => read === 1)).toBe(true);
    expect(value.summary.valid && value.summary.counts.failed).toBe(1);
    Object.defineProperty(source, "summary", { configurable: true, value: summary({ failed: 99 }) });
    expect(value.summary.valid && value.summary.counts.failed).toBe(1);
    expect(Object.isFrozen(value)).toBe(true);
  });
  it.each([
    ["missing", (() => { const value = summary(); delete value.failed; return value; })()],
    ["negative", summary({ failed: -1 })], ["NaN", summary({ failed: Number.NaN })],
    ["fractional", summary({ failed: 1.5 })], ["string", summary({ failed: "1" })],
    ["null", null], ["array", []]
  ])("fails the whole summary for %s", (_name, malformed) => {
    const value = snap({ kind: "result", result: result({ summary: malformed }) });
    expect(value.summary).toEqual({ valid: false });
  });
  it("caps blocker traversal and records sparse or revoked input", () => {
    const blockers: unknown[] = []; blockers.length = 2_000_000_000;
    let reads = 0;
    for (let index = 0; index < 40; index += 1) Object.defineProperty(blockers, String(index), {
      configurable: true, get: () => { reads += 1; return "github_app_issues_permission_required"; }
    });
    const value = snap({ kind: "result", result: result({ status: { state: "blocked", blockers } }) });
    expect(reads).toBe(32);
    expect(value.status.blockers).toMatchObject({ readable: true, complete: false });
    expect(snap({ kind: "result", result: result({ status: { state: "blocked", blockers: ["future_blocker", 1] } }) }).status.blockers.complete).toBe(false);
    const revoked = Proxy.revocable([], {}); revoked.revoke();
    expect(snap({ kind: "result", result: result({ status: { state: "blocked", blockers: revoked.proxy } }) })
      .status.blockers).toMatchObject({ readable: false, complete: false, reasons: [] });
  });
  it("keeps only an exact bounded leading blocker token from errors", () => {
    const token = "issue_enrichment_model_runtime_required";
    expect(snap({ kind: "thrown", error: new Error(`${token}: ${"x".repeat(10_000)}`) }))
      .toMatchObject({ kind: "thrown", reason: token });
    expect(snap({ kind: "thrown", error: `context ${token}` })).toMatchObject({ reason: "unknown_failure" });
    expect(snap({ kind: "thrown", error: `${" ".repeat(300)}${token}` })).toMatchObject({ reason: "unknown_failure" });
    const error = {}; Object.defineProperty(error, "message", { get: () => { throw new Error("revoked"); } });
    expect(snap({ kind: "thrown", error })).toMatchObject({ reason: "unknown_failure" });
    expect(snap({ kind: "oops", result: result() })).toMatchObject({ kind: "thrown", reason: "unknown_failure" });
    expect(Object.isFrozen(ISSUE_ENRICHMENT_RECEIPT_COUNT_KEYS)).toBe(true);
  });
});
