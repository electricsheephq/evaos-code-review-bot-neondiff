import { describe, expect, it } from "vitest";
import { createIssueEnrichmentAdmission, type IssueEnrichmentAdmissionInput } from "../src/issue-enrichment-admission.js";

const checkedAt = "2026-08-24T00:00:00.000Z";
const limits = (overrides: Partial<IssueEnrichmentAdmissionInput["limits"]> = {}): IssueEnrichmentAdmissionInput["limits"] => ({
  globalMaxIssuesPerCycle: 3, globalMaxCommentsPerCycle: 2, repos: {
    "a/repo": { maxIssuesPerCycle: 2, maxCommentsPerCycle: 1, maxIssuesPerBurst: 2 },
    "b/repo": { maxIssuesPerCycle: 2, maxCommentsPerCycle: 2, maxIssuesPerBurst: 2 }
  }, ...overrides
});
const item = (repo: string, issueNumber: number, action: "would_enrich" | "would_comment" = "would_comment") => ({ repo, issueNumber, state: "open", action, issueUpdatedAt: "2026-08-23T00:00:00Z" } as const);
const input = (items: IssueEnrichmentAdmissionInput["items"], extra: Partial<IssueEnrichmentAdmissionInput> = {}): IssueEnrichmentAdmissionInput => ({ allowlist: ["a/repo", "b/repo"], items, checkedAt, limits: limits(), ...extra });

describe("issue enrichment admission ledger", () => {
  it.each([
    ["repo and global caps", [item("a/repo", 1), item("a/repo", 2), item("b/repo", 3)], ["a/repo#1", "b/repo#3"]],
    ["burst cap", [item("a/repo", 1, "would_enrich"), item("a/repo", 2, "would_enrich"), item("a/repo", 3, "would_enrich")], [undefined, undefined]]
  ])("admits stable candidates under %s", (_name, items, expected) => {
    const admission = createIssueEnrichmentAdmission(input(items as IssueEnrichmentAdmissionInput["items"]));
    expect(admission.candidates.map((candidate) => candidate.key)).toEqual((items as readonly { repo: string; issueNumber: number }[]).map((entry) => `${entry.repo}#${entry.issueNumber}`));
    expect([admission.ledger.next()?.candidate.key, admission.ledger.next()?.candidate.key]).toEqual(expected);
  });

  it("keeps intent immutable, carries records, and makes live comments pending", () => {
    const admission = createIssueEnrichmentAdmission(input([item("a/repo", 1), item("a/repo", 2), item("b/repo", 3)], {
      records: [
        { repo: "a/repo", issueNumber: 1, status: "posted", analysisInputHash: "a" },
        { repo: "a/repo", issueNumber: 2, status: "dry_run", issueUpdatedAt: "2026-08-22T00:00:00Z" },
        { repo: "b/repo", issueNumber: 3, status: "posted" }
      ]
    }));
    expect(admission.candidates.map((candidate) => [candidate.sourceDependent, candidate.pending, candidate.record?.analysisInputHash])).toEqual([[true, true, "a"], [false, true, undefined], [true, true, undefined]]);
    const original = admission.candidates[0]!.scanItem;
    admission.ledger.next();
    expect(original.action).toBe("would_comment");
  });

  it("reports burst projection independently of repository issue caps", () => {
    const admission = createIssueEnrichmentAdmission(input([item("a/repo", 1, "would_enrich"), item("a/repo", 2, "would_enrich")], {
      limits: limits({ repos: { ...limits().repos, "a/repo": { maxIssuesPerCycle: 2, maxCommentsPerCycle: 1, maxIssuesPerBurst: 1 } } })
    }));
    expect(admission.ledger.snapshot()[1]).toMatchObject({ outputAction: "deferred", reason: "burst_threshold_exceeded" });
  });

  it("holds deferred rows until nextEligibleAt", () => {
    const deferred = { ...item("a/repo", 9), action: "deferred" as const, intendedAction: "would_comment" as const, nextEligibleAt: "2026-08-25T00:00:00Z" };
    const future = input([deferred], { records: [{ repo: "a/repo", issueNumber: 9, status: "deferred", nextEligibleAt: "2026-08-25T00:00:00Z" }] });
    expect(createIssueEnrichmentAdmission(future).ledger.next()).toBeUndefined();
    expect(createIssueEnrichmentAdmission({ ...future, checkedAt: "2026-08-25T00:00:00Z" }).ledger.next()?.candidate.key).toBe("a/repo#9");
  });

  it("releases reservations and blocks repos without starving siblings", () => {
    const admission = createIssueEnrichmentAdmission(input([item("a/repo", 1), item("b/repo", 1), item("a/repo", 2)], { limits: limits({ globalMaxIssuesPerCycle: 1 }) }));
    const first = admission.ledger.next()!;
    expect(first.candidate.key).toBe("a/repo#1");
    admission.ledger.release(first.candidate);
    admission.ledger.blockRepo("a/repo");
    expect(admission.ledger.next()!.candidate.key).toBe("b/repo#1");
    expect(admission.ledger.snapshot().find((decision) => decision.candidate.key === "a/repo#2")?.reason).toBe("repository_blocked");
  });

  it("projects deferred output without changing empty or skipped inputs", () => {
    const skipped = item("a/repo", 1);
    const admission = createIssueEnrichmentAdmission(input([{ ...skipped, action: "skipped" }]));
    expect(admission.candidates).toHaveLength(0);
    expect(admission.ledger.snapshot()).toEqual([]);
  });
});
