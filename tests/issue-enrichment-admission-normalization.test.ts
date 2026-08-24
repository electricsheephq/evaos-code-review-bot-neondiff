import { describe, expect, it } from "vitest";
import { normalizeIssueEnrichmentCandidates, type IssueEnrichmentNormalizationInput as Input } from "../src/issue-enrichment-admission-normalization.js";

const checkedAt = "2026-08-24T00:00:00.000Z";
const limits = { globalMaxIssuesPerCycle: 3, repos: { "a/repo": { maxIssuesPerCycle: 2 } } };
const item = (repo: string, issueNumber: number, action: "would_enrich" | "would_comment" = "would_enrich") => ({
  repo, issueNumber, state: "open", action, issueUpdatedAt: "2026-08-23T00:00:00Z"
});
const input = (items: Input["items"], extra: Partial<Input> = {}): Input => ({
  allowlist: ["a/repo", "b/repo"], items, checkedAt, fallbackIntendedAction: "would_enrich", limits, ...extra
});

describe("issue-enrichment admission normalization", () => {
  it("keeps a frozen, allowlist/issue ordered unique candidate snapshot", () => {
    const source = input([item("b/repo", 2), item("a/repo", 2), item("a/repo", 2), { ...item("a/repo", 3), action: "skipped" }], {
      records: [{ repo: "a/repo", issueNumber: 2, status: "skipped" }]
    });
    const normalized = normalizeIssueEnrichmentCandidates(source);
    expect(normalized.candidates.map((candidate) => candidate.key)).toEqual(["a/repo#2", "b/repo#2"]);
    expect(Object.isFrozen(normalized.candidates[0])).toBe(true);
    source.items[0]!.issueNumber = 99;
    (source.allowlist as string[])[0] = "other/repo";
    source.records![0]!.status = "posted";
    (source.limits.repos as any)["a/repo"].maxIssuesPerCycle = 0;
    expect(normalized.candidates[1]!.key).toBe("b/repo#2");
    expect(normalized.allowlist[0]).toBe("a/repo");
    expect(normalized.records[0]!.status).toBe("skipped");
    expect(normalized.candidates[0]!.limits.repos["a/repo"].maxIssuesPerCycle).toBe(2);
  });

  it.each([
    ["explicit", { action: "deferred", intendedAction: "would_comment" }, "would_comment"],
    ["legacy", { action: "deferred" }, "would_comment"]
  ] as const)("retains %s deferred intent", (_name, patch, expected) => {
    const normalized = normalizeIssueEnrichmentCandidates(input([{ ...item("a/repo", 1), ...patch }], { fallbackIntendedAction: expected }));
    expect(normalized.candidates[0]!.intendedAction).toBe(expected);
    expect(normalized.candidates[0]!.pending).toBe(true);
  });

  it("rejects a legacy deferred row without an explicit current-cycle fallback", () => {
    expect(() => normalizeIssueEnrichmentCandidates(input([{ ...item("a/repo", 1), action: "deferred" }], { fallbackIntendedAction: undefined }))).toThrow(/fallbackIntendedAction/);
  });

  it("keeps unknown timestamps unknown and applies deadline-only fallback", () => {
    const unknown = normalizeIssueEnrichmentCandidates(input([{ ...item("a/repo", 1), issueUpdatedAt: "bad" }], {
      records: [{ repo: "a/repo", issueNumber: 1, status: "dry_run", issueUpdatedAt: "2026-08-23T00:00:00Z" }]
    })).candidates[0]!;
    expect(unknown.issueUpdatedAt).toBeUndefined();
    expect(unknown.pending).toBe(true);
    const future = normalizeIssueEnrichmentCandidates(input([{ ...item("a/repo", 1), action: "deferred", nextEligibleAt: "2026-08-25T00:00:00Z" }])).candidates[0]!;
    expect(future.pending).toBe(false);
    expect(normalizeIssueEnrichmentCandidates(input([{ ...item("a/repo", 1), action: "deferred", nextEligibleAt: checkedAt }])).candidates[0]!.pending).toBe(true);
  });

  it("keeps skipped records, dry-run-to-live, and posted rows pending", () => {
    const records = [
      { repo: "a/repo", issueNumber: 1, status: "skipped", issueUpdatedAt: "2026-08-23T00:00:00Z" },
      { repo: "a/repo", issueNumber: 2, status: "dry_run", issueUpdatedAt: "2026-08-23T00:00:00Z" },
      { repo: "a/repo", issueNumber: 3, status: "posted", analysisInputHash: "a".repeat(64) }
    ] as const;
    const normalized = normalizeIssueEnrichmentCandidates(input([item("a/repo", 1), item("a/repo", 2, "would_comment"), item("a/repo", 3)], { records }));
    expect(normalized.candidates.map((candidate) => [candidate.pending, candidate.sourceDependent])).toEqual([[true, false], [true, false], [true, true]]);
  });

  it("may classify only known unchanged dry-run enrichment as already recorded", () => {
    const candidate = normalizeIssueEnrichmentCandidates(input([item("a/repo", 1)], {
      records: [{ repo: "a/repo", issueNumber: 1, status: "dry_run", issueUpdatedAt: "2026-08-23T00:00:00Z" }]
    })).candidates[0]!;
    expect(candidate.reason).toBe("already_recorded");
    expect(candidate.pending).toBe(false);
  });
});
