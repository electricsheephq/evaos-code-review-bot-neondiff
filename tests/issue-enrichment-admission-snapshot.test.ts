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
    const source = base([item("b/repo", 3), item("a/repo", 2), item("a/repo", 1)], { records: [{ repo: "a/repo", issueNumber: 1, status: "posted", nextEligibleAt: "2026-08-25T00:00:00Z", deadlineAt: "2026-08-26T00:00:00Z", bodyHash: "a".repeat(64), analysisInputHash: "B".repeat(64) }] });
    const snapshot = snapshotIssueEnrichmentAdmission(source);
    expect(snapshot.candidates.map((candidate) => candidate.key)).toEqual(["a/repo#2", "a/repo#1", "b/repo#3"]);
    expect(Object.isFrozen(snapshot.candidates[0])).toBe(true);
    (source.items[0] as any).issueNumber = 99;
    (source.limits as any).repos["a/repo"].maxIssuesPerCycle = 0;
    expect(snapshot.candidates[2]!.issueNumber).toBe(3);
    expect((snapshot.limits.repos as any)["a/repo"].maxIssuesPerCycle).toBe(2);
    expect(snapshot.candidates[1]!.record).toMatchObject({ status: "posted", nextEligibleAt: "2026-08-25T00:00:00.000Z", deadlineAt: "2026-08-26T00:00:00.000Z", bodyHash: "a".repeat(64), analysisInputHash: "B".repeat(64) });
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

  it.each([new Map([["x", 1]]), new Date(0), new Set([1]), () => 1, new Proxy({}, {}), { [Symbol("hidden")]: 1 }])("rejects mutable/non-plain values", (value) => {
    expect(() => snapshotIssueEnrichmentAdmission(base([item("a/repo", 1)], { limits: { extension: value } }))).toThrow(/non_plain|cycle/);
  });

  it("fails closed over reserved fields, arrays, records, identity, time, accessors, and cycles", () => {
    for (const field of ["record", "status", "bodyHash", "analysisInputHash", "createdAt", "updatedAt", "deadlineAt"]) expect.soft(() => snapshotIssueEnrichmentAdmission(base([{ ...item("a/repo", 1), [field]: "spoofed" }]))).toThrow(field);
    const sparse: string[] = []; sparse.length = 1; const aliased: string[] = []; Object.defineProperty(aliased, "0", { value: "a/repo", enumerable: true }); Object.defineProperty(aliased, "00", { value: "b/repo", enumerable: true }); aliased.length = 2; expect.soft(() => snapshotIssueEnrichmentAdmission(base([], { allowlist: sparse }))).toThrow(/non_plain/); expect.soft(() => snapshotIssueEnrichmentAdmission(base([], { allowlist: aliased }))).toThrow(/non_plain/);
    expect.soft(() => snapshotIssueEnrichmentAdmission(base([], { allowlist: ["Owner/Repo", "owner/repo"] }))).toThrow(/duplicate_allowlist/); expect.soft(() => snapshotIssueEnrichmentAdmission(base([], { checkedAt: "2026-08-24T00:00:00" }))).toThrow(/invalid_checkedAt/); expect.soft(snapshotIssueEnrichmentAdmission(base([{ ...item("a/repo", 1), issueUpdatedAt: "2026-02-29T00:00:00Z" }])).candidates[0]!.issueUpdatedAt).toBeUndefined(); for (const records of [null, undefined]) expect.soft(() => snapshotIssueEnrichmentAdmission(base([], { records: records as any }))).toThrow(/input_shape/); for (const field of ["bodyHash", "analysisInputHash"] as const) for (const digest of [42, "bad"]) expect.soft(() => snapshotIssueEnrichmentAdmission(base([], { records: [{ repo: "a/repo", issueNumber: 1, status: "posted", [field]: digest } as any] }))).toThrow(field);
    let calls = 0; const nested: Record<string, unknown> = {}; Object.defineProperty(nested, "value", { get: () => { calls += 1; return 1; }, enumerable: true }); let proxyCalls = 0; const trapped = new Proxy({}, { ownKeys: () => { proxyCalls += 1; return []; } });
    expect.soft(() => snapshotIssueEnrichmentAdmission(base([], { limits: { nested } }))).toThrow(/accessor/); expect.soft(calls).toBe(0); expect.soft(() => snapshotIssueEnrichmentAdmission(base([], { limits: { trapped } }))).toThrow(/non_plain/); expect.soft(proxyCalls).toBe(0);
    const accessor = {} as Record<string, unknown>; Object.defineProperty(accessor, "allowlist", { get: () => ["a/repo"], enumerable: true }); expect.soft(() => snapshotIssueEnrichmentAdmission(accessor as unknown as Input)).toThrow(/accessor|non_plain/);
    const cycle: any = {}; cycle.self = cycle; expect.soft(() => snapshotIssueEnrichmentAdmission(base([], { limits: cycle }))).toThrow(/cycle/);
    const empty = snapshotIssueEnrichmentAdmission(base([])); expect.soft(empty.candidates).toEqual([]); expect.soft(Object.isFrozen(empty)).toBe(true);
  });
});
