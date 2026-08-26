import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestLicenseAdmission } from "./helpers/license-admission.js";
const { prepareBranchWorktree, runIssueAnalysis } = vi.hoisted(() => ({ prepareBranchWorktree: vi.fn(), runIssueAnalysis: vi.fn(async () => ({ analysis: { classification: "needs-repro", priority: "P3", priorityState: "provisional", confidence: "needs-repro", repositoryImpact: "fixture", currentMainApplicability: "fixture", verifiedFacts: [], reproductionOrInvariantGap: "fixture", relatedWork: [], migrationDisposition: "needs-repro", nextGate: "fixture", limitations: [], labelProposals: [] } })) }));
vi.mock("../src/git.js", async (original) => ({ ...await original<typeof import("../src/git.js")>(), prepareBranchWorktree }));
vi.mock("../src/issue-analysis.js", async (original) => ({ ...await original<typeof import("../src/issue-analysis.js")>(), runIssueAnalysis }));
import { runIssueEnrichmentCycle } from "../src/issue-enrichment.js";

const config = (allowlist: string[]) => ({ workRoot: "/tmp/work", evidenceDir: "/tmp/evidence", codexRuntime: { enabled: true, cliPath: "/usr/bin/false", model: "fixture", reasoningEffort: "low" as const, timeoutMs: 1, maxOutputBytes: 1 }, issueEnrichment: {
  enabled: true, postIssueComment: true, allowlist, allowedLabels: [], allowedReviewers: [], maxIssuesPerCycle: 1, maxCommentsPerCycle: 1, globalMaxIssuesPerCycle: 1, globalMaxCommentsPerCycle: 1, maxActiveRuns: 1, leaseTtlMs: 60_000, cooldownMs: 60_000, burstWindowMs: 60_000, maxIssuesPerBurst: 1, lookbackMs: 60_000, processExistingOpenIssuesOnActivation: true,
  repos: Object.fromEntries(allowlist.map((repo) => [repo, { maxIssuesPerCycle: 1, maxCommentsPerCycle: 1, cooldownMs: 60_000, burstWindowMs: 60_000, maxIssuesPerBurst: 1, lookbackMs: 60_000 }]))
} });
const state = () => ({ getIssueEnrichmentRecord: () => undefined, recordIssueEnrichment: (value: unknown) => value as never, getIssueEnrichmentRepoWatermark: () => undefined, recordIssueEnrichmentRepoWatermark: (value: unknown) => value as never, tryAcquireIssueEnrichmentRunLease: () => ({ leaseId: "fixture", expiresAt: "2026-08-26T10:01:00.000Z", ownerPid: 1 }), releaseIssueEnrichmentRunLease: () => undefined });
const issue = (number: number) => ({ number, title: `Issue ${number}`, state: "open", updated_at: "2026-08-26T09:00:00.000Z", body: "Acceptance criteria and owner present." });
const admission = await createTestLicenseAdmission({ operation: "issue_enrichment" });

describe("issue-enrichment lazy source settlement", () => {
  beforeEach(() => vi.clearAllMocks());
  it("does not prepare source for an empty repository scan", async () => {
    prepareBranchWorktree.mockResolvedValue({ path: "/tmp/unused", headSha: "a".repeat(40) });
    const result = await runIssueEnrichmentCycle({ config: config(["owner/empty"]), state: state(), github: { getRepo: async () => ({ default_branch: "main" }), listIssuesForEnrichment: async () => [], canPostAsApp: () => true, upsertIssueComment: async () => { throw new Error("must not post"); } }, dryRun: false, includeExisting: true, checkedAt: "2026-08-26T10:00:00.000Z", licenseAdmission: admission });
    expect(result.summary).toMatchObject({ issuesSeen: 0, posted: 0, failed: 0 }); expect(prepareBranchWorktree).not.toHaveBeenCalled();
  });
  it("scans case-insensitive duplicate allowlist entries once", async () => {
    const listIssuesForEnrichment = vi.fn(async () => []); const result = await runIssueEnrichmentCycle({ config: config(["Owner/Repo", "owner/repo"]), state: state(), github: { getRepo: async () => ({ default_branch: "main" }), listIssuesForEnrichment, canPostAsApp: () => true, upsertIssueComment: async () => { throw new Error("must not post"); } }, dryRun: false, includeExisting: true, checkedAt: "2026-08-26T10:00:00.000Z", licenseAdmission: admission }); expect(result.summary.issuesSeen).toBe(0); expect(listIssuesForEnrichment).toHaveBeenCalledTimes(1); expect(prepareBranchWorktree).not.toHaveBeenCalled();
  });
  it("releases preparation failures and backfills a healthy repository", async () => {
    const repos = ["owner/fail-a", "owner/fail-b", "owner/healthy"], posted: number[] = [];
    prepareBranchWorktree.mockImplementation(async ({ repo }: { repo: string }) => { if (repo.includes("fail")) throw new Error("fixture prepare failure"); return { path: "/tmp/healthy", headSha: "a".repeat(40) }; });
    const result = await runIssueEnrichmentCycle({ config: config(repos), state: state(), github: { getRepo: async () => ({ default_branch: "main" }), listIssuesForEnrichment: async (repo) => [issue(repos.indexOf(repo) + 1)], getIssueOrPull: async (_repo, number) => issue(number), canPostAsApp: () => true, upsertIssueComment: async ({ issueNumber }) => { posted.push(issueNumber); return { action: "created" as const, id: issueNumber }; } }, dryRun: false, includeExisting: true, checkedAt: "2026-08-26T10:00:00.000Z", licenseAdmission: admission });
    expect(result.summary).toMatchObject({ posted: 1, failed: 2, deferredRecorded: 0 }); expect(posted).toEqual([3]); expect(prepareBranchWorktree).toHaveBeenCalledTimes(3);
  });
  it("releases one evidence failure and reuses the prepared repo for backfill", async () => {
    const configured = config(["owner/repo"]); configured.issueEnrichment.maxIssuesPerBurst = 2; configured.issueEnrichment.repos["owner/repo"].maxIssuesPerBurst = 2; let evidenceReads = 0;
    prepareBranchWorktree.mockResolvedValue({ path: "/tmp/repo", headSha: "a".repeat(40) });
    const result = await runIssueEnrichmentCycle({ config: configured, state: state(), github: { getRepo: async () => ({ default_branch: "main" }), listIssuesForEnrichment: async () => [issue(1), issue(2)], listIssueCommentsForEnrichment: async () => { if (evidenceReads++ === 0) throw new Error("fixture evidence failure"); return Object.assign([], { items: [], rawCount: 0, truncated: false, overflow: false }); }, getIssueOrPull: async (_repo, number) => issue(number), canPostAsApp: () => true, upsertIssueComment: async ({ issueNumber }) => ({ action: "created" as const, id: issueNumber }) }, dryRun: false, includeExisting: true, checkedAt: "2026-08-26T10:00:00.000Z", licenseAdmission: admission });
    expect(result.summary).toMatchObject({ posted: 1, failed: 1 }); expect(prepareBranchWorktree).toHaveBeenCalledTimes(1); expect(result.items.find(({ issueNumber }) => issueNumber === 2)?.recordStatus).toBe("posted");
  });
});
