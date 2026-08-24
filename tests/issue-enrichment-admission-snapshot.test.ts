import { describe, expect, it } from "vitest";
import { snapshotIssueEnrichmentAdmission, type IssueEnrichmentAdmissionInput as Input } from "../src/issue-enrichment-admission-snapshot.js";

const checkedAt = "2026-08-24T00:00:00.000Z";
const base = (items: Input["items"], extra: Partial<Input> = {}): Input => ({
  allowlist: ["a/repo", "b/repo"], checkedAt, items,
  limits: { globalMaxIssuesPerCycle: 3, repos: { "a/repo": { maxIssuesPerCycle: 2 } } }, ...extra
});
const item = (repo: string, issueNumber: number, action: Input["items"][number]["action"] = "would_enrich") => ({
  repo, issueNumber, state: "open", action, issueUpdatedAt: "2026-08-23T00:00:00Z"
});

describe("issue-enrichment admission input snapshots", () => {
  it("deep-copies/freezes inputs and orders candidates by allowlist then issue order", () => {
    const source = base([item("b/repo", 3), item("a/repo", 2), item("a/repo", 1)], { records: [{ repo: "a/repo", issueNumber: 1, status: "posted", nextEligibleAt: "2026-08-25T00:00:00Z", bodyHash: "h" }] });
    const snapshot = snapshotIssueEnrichmentAdmission(source);
    expect(snapshot.candidates.map((candidate) => candidate.key)).toEqual(["a/repo#2", "a/repo#1", "b/repo#3"]);
    expect(Object.isFrozen(snapshot.candidates[0])).toBe(true);
    (source.items[0] as any).issueNumber = 99;
    (source.limits as any).repos["a/repo"].maxIssuesPerCycle = 0;
    expect(snapshot.candidates[2]!.issueNumber).toBe(3);
    expect((snapshot.limits.repos as any)["a/repo"].maxIssuesPerCycle).toBe(2);
    expect(snapshot.candidates[1]!.record?.nextEligibleAt).toBe("2026-08-25T00:00:00.000Z");
  });

  it("preserves explicit deferred intent, requires a fallback, and rejects contradictory concrete intent", () => {
    expect(snapshotIssueEnrichmentAdmission(base([{ ...item("a/repo", 1), action: "deferred", intendedAction: "would_comment" }])).candidates[0]!.intendedAction).toBe("would_comment");
    expect(snapshotIssueEnrichmentAdmission(base([{ ...item("a/repo", 1), action: "deferred" }], { fallbackIntendedAction: "would_comment" })).candidates[0]!.intendedAction).toBe("would_comment");
    expect(() => snapshotIssueEnrichmentAdmission(base([{ ...item("a/repo", 1), action: "deferred" }]))).toThrow(/missing_intent/);
    expect(() => snapshotIssueEnrichmentAdmission(base([{ ...item("a/repo", 1), action: "would_comment", intendedAction: "would_enrich" }]))).toThrow(/contradictory_intent/);
  });

  it("rejects duplicate scan/record keys deterministically and keeps unknown timestamps unknown", () => {
    const records = [{ repo: "a/repo", issueNumber: 1, status: "posted" }, { repo: "a/repo", issueNumber: 1, status: "dry_run" }] as const;
    for (const ordered of [records, [...records].reverse()]) expect(() => snapshotIssueEnrichmentAdmission(base([item("a/repo", 1)], { records: ordered }))).toThrow("duplicate_record:a/repo#1");
    expect(() => snapshotIssueEnrichmentAdmission(base([item("a/repo", 1), item("a/repo", 1)]))).toThrow("duplicate_scan:a/repo#1");
    const unknown = snapshotIssueEnrichmentAdmission(base([{ ...item("a/repo", 1), issueUpdatedAt: "not-a-date" }])).candidates[0]!;
    expect(unknown.issueUpdatedAt).toBeUndefined();
    expect(unknown.issueUpdatedAt).not.toBe(checkedAt);
  });

  it.each([new Map([["x", 1]]), new Date(0), new Set([1]), () => 1, new Proxy({}, {})])("rejects mutable/non-plain values", (value) => {
    expect(() => snapshotIssueEnrichmentAdmission(base([item("a/repo", 1)], { limits: { extension: value } }))).toThrow(/non_plain|cycle/);
  });

  it("rejects accessors and cycles while allowing an empty snapshot", () => {
    const accessor = {} as Record<string, unknown>;
    Object.defineProperty(accessor, "allowlist", { get: () => ["a/repo"], enumerable: true });
    expect(() => snapshotIssueEnrichmentAdmission(accessor as unknown as Input)).toThrow(/accessor|non_plain/);
    const cycle: any = {}; cycle.self = cycle;
    expect(() => snapshotIssueEnrichmentAdmission(base([], { limits: cycle }))).toThrow(/cycle/);
    const empty = snapshotIssueEnrichmentAdmission(base([]));
    expect(empty.candidates).toEqual([]);
    expect(Object.isFrozen(empty)).toBe(true);
  });
});
