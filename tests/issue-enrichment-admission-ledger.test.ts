import { describe, expect, it } from "vitest";
import { createIssueEnrichmentAdmissionLedger } from "../src/issue-enrichment-admission-ledger.js";
import { classifyIssueEnrichmentAdmission } from "../src/issue-enrichment-admission-decision.js";
import { snapshotIssueEnrichmentAdmission, type IssueEnrichmentAdmissionInput as Input } from "../src/issue-enrichment-admission-snapshot.js";

const checkedAt = "2026-08-26T00:00:00Z", updatedAt = "2026-08-25T00:00:00Z";
const item = (repo: string, issueNumber: number, action: Input["items"][number]["action"] = "would_enrich") => ({ repo, issueNumber, state: "open", action, issueUpdatedAt: updatedAt });
const limits = (overrides: Record<string, unknown> = {}) => ({ globalMaxIssuesPerCycle: 3, globalMaxCommentsPerCycle: 2, repos: {
  "a/repo": { maxIssuesPerCycle: 2, maxCommentsPerCycle: 1, maxIssuesPerBurst: 3 },
  "b/repo": { maxIssuesPerCycle: 2, maxCommentsPerCycle: 2, maxIssuesPerBurst: 3 }
}, ...overrides });
const ledger = (items: Input["items"], extra: Partial<Input> = {}) => {
  const snapshot = snapshotIssueEnrichmentAdmission({ allowlist: ["a/repo", "b/repo"], checkedAt, items, limits: limits(), ...extra });
  return createIssueEnrichmentAdmissionLedger(snapshot, classifyIssueEnrichmentAdmission(snapshot));
};

describe("issue-enrichment admission ledger", () => {
  it("preserves stable order and enforces repo/global issue and comment caps", () => {
    const admission = ledger([item("a/repo", 1, "would_comment"), item("a/repo", 2, "would_comment"), item("b/repo", 1)]);
    expect(admission.candidates.map(({ key }) => key)).toEqual(["a/repo#1", "a/repo#2", "b/repo#1"]);
    expect(admission.next()?.candidate.key).toBe("a/repo#1");
    expect(admission.next()?.candidate.key).toBe("b/repo#1");
    expect(admission.next()).toBeUndefined();
    expect(admission.snapshot().find(({ candidate }) => candidate.key === "a/repo#2")).toMatchObject({ outputAction: "deferred", reason: "repo_max_comments_per_cycle" });
  });

  it("consumes the issue slot when a comment cap defers a candidate", () => {
    const admission = ledger([item("a/repo", 1, "would_comment"), item("a/repo", 2, "would_comment"), item("b/repo", 1)], { limits: limits({ globalMaxIssuesPerCycle: 2, globalMaxCommentsPerCycle: 2 }) });
    expect(admission.next()?.candidate.key).toBe("a/repo#1");
    expect(admission.next()).toBeUndefined();
    admission.release(admission.candidates[1]!);
    expect(admission.next()).toBeUndefined();
    expect(admission.snapshot().find(({ candidate }) => candidate.key === "b/repo#1")?.reason).toBe("global_max_issues_per_cycle");
  });

  it("releases and blocks repositories so healthy siblings backfill", () => {
    const admission = ledger([item("a/repo", 1), item("a/repo", 2), item("b/repo", 1)], { limits: limits({ globalMaxIssuesPerCycle: 1 }) });
    const first = admission.next()!; expect(first.candidate.key).toBe("a/repo#1");
    admission.release(first.candidate); admission.blockRepo("a/repo");
    expect(admission.next()?.candidate.key).toBe("b/repo#1");
    expect(admission.snapshot().find(({ candidate }) => candidate.key === "a/repo#2")?.reason).toBe("repository_blocked");
  });

  it("does not re-admit an issue-cap denial after another reservation is released", () => {
    const admission = ledger([item("a/repo", 1), item("b/repo", 1)], { limits: limits({ globalMaxIssuesPerCycle: 1 }) });
    const first = admission.next()!; expect(first.candidate.key).toBe("a/repo#1");
    expect(admission.next()).toBeUndefined(); admission.release(first.candidate);
    expect(admission.next()).toBeUndefined();
    expect(admission.snapshot().find(({ candidate }) => candidate.key === "b/repo#1")?.reason).toBe("global_max_issues_per_cycle");
  });

  it("reconsiders healthy cap denials after their blocking repository is removed", () => {
    const admission = ledger([item("a/repo", 1), item("b/repo", 1)], { limits: limits({ globalMaxIssuesPerCycle: 1 }) });
    expect(admission.next()?.candidate.key).toBe("a/repo#1"); expect(admission.next()).toBeUndefined();
    admission.blockRepo("a/repo");
    expect(admission.next()?.candidate.key).toBe("b/repo#1");
  });

  it("applies atomic burst limits and multiple blocked repositories deterministically", () => {
    const burst = ledger([item("a/repo", 1), item("a/repo", 2), item("a/repo", 3)], { limits: limits({ repos: { ...limits().repos, "a/repo": { maxIssuesPerCycle: 3, maxCommentsPerCycle: 3, maxIssuesPerBurst: 2 } } }) });
    expect(burst.next()).toBeUndefined(); expect(burst.snapshot().every(({ reason }) => reason === "burst_threshold_exceeded")).toBe(true);
    const blocked = ledger([item("a/repo", 1), item("b/repo", 1)]); blocked.blockRepo("a/repo"); blocked.blockRepo("b/repo"); expect(blocked.next()).toBeUndefined();
  });

  it("admits posted source-dependent rows and dry-run-to-live while preserving intent", () => {
    const records = [
      { repo: "a/repo", issueNumber: 1, status: "posted", issueUpdatedAt: updatedAt, analysisInputHash: "a".repeat(64) },
      { repo: "a/repo", issueNumber: 2, status: "posted", issueUpdatedAt: updatedAt },
      { repo: "b/repo", issueNumber: 1, status: "dry_run", issueUpdatedAt: updatedAt }
    ] as const;
    const admission = ledger([item("a/repo", 1), item("a/repo", 2), item("b/repo", 1, "would_comment")], { records });
    expect([admission.next()?.classification.state, admission.next()?.classification.state, admission.next()?.classification.state]).toEqual(["source_dependent", "source_dependent", "pending"]);
    expect(admission.candidates.map(({ intendedAction }) => intendedAction)).toEqual(["would_enrich", "would_enrich", "would_comment"]);
  });

  it("excludes held, already-recorded, skipped, and empty candidates without mutation", () => {
    const records = [{ repo: "a/repo", issueNumber: 1, status: "dry_run", issueUpdatedAt: updatedAt }] as const;
    const admission = ledger([item("a/repo", 1), { ...item("a/repo", 2, "deferred"), intendedAction: "would_enrich", nextEligibleAt: "2026-08-27T00:00:00Z" }, item("b/repo", 1, "skipped")], { records });
    expect(admission.next()).toBeUndefined(); expect(admission.candidates).toHaveLength(2); expect(Object.isFrozen(admission.candidates)).toBe(true);
    const empty = ledger([]); expect(empty.next()).toBeUndefined(); expect(empty.snapshot()).toEqual([]);
  });

  it("rejects shallow-frozen containers with mutable candidate or decision records", () => {
    const accepted = snapshotIssueEnrichmentAdmission({ allowlist: ["a/repo"], checkedAt, items: [item("a/repo", 1)], limits: limits() });
    const candidate = { ...accepted.candidates[0]! }, decision = { ...classifyIssueEnrichmentAdmission(accepted)[0]!, candidate };
    const shallowSnapshot = Object.freeze({ ...accepted, candidates: Object.freeze([candidate]) });
    expect(() => createIssueEnrichmentAdmissionLedger(shallowSnapshot, Object.freeze([decision]))).toThrow("invalid_inputs");
  });
});
