import { tmpdir } from "node:os";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { enrichmentListing } from "./helpers/issue-enrichment-listing.js";
import { createTestLicenseAdmission } from "./helpers/license-admission.js";

const { prepare, analyze } = vi.hoisted(() => ({ prepare: vi.fn(), analyze: vi.fn() }));
vi.mock("../src/git.js", async (original) => ({ ...await original<typeof import("../src/git.js")>(), prepareBranchWorktree: prepare }));
vi.mock("../src/issue-analysis.js", async (original) => ({ ...await original<typeof import("../src/issue-analysis.js")>(), runIssueAnalysis: analyze }));
vi.mock("../src/codex-runtime.js", async (original) => ({ ...await original<typeof import("../src/codex-runtime.js")>(), resolveCheckoutReadsStatus: () => ({ status: "enabled" }) }));
import { buildIssueEvidenceContext, collectIssueEnrichmentScan, DEFAULT_ISSUE_ENRICHMENT_CONFIG, runIssueEnrichmentCycle, type IssueEnrichmentConfig } from "../src/issue-enrichment.js";
import { buildIssueAnalysisInputHash } from "../src/issue-analysis.js";
import { ISSUE_ANALYSIS_PUBLIC_RENDERER_VERSION } from "../src/enrichment.js";
import type { GitHubRelatedIssueOrPull } from "../src/github-related-context.js";
import type { IssueEnrichmentRecord, IssueEnrichmentRepoWatermark, RecordIssueEnrichmentInput } from "../src/state.js";

const repo = "fixture/repo", checkedAt = "2026-10-31T10:00:00.000Z", oldWatermark = "2026-08-22T10:00:00.000Z";
const admission = await createTestLicenseAdmission({ operation: "issue_enrichment" });
const issue = (number: number, extra = {}): GitHubRelatedIssueOrPull => ({ number, title: `Issue ${number}`, body: "Acceptance criteria and owner present.", state: "open", updated_at: new Date(Date.parse(checkedAt) - number * 1000).toISOString(), ...extra });
const newIssue = (number: number) => issue(number, { created_at: "2026-10-31T09:55:00.000Z" });
function harness(initialRows: GitHubRelatedIssueOrPull[], overrides: Partial<IssueEnrichmentConfig> = {}) {
  let rows = initialRows;
  const records = new Map<number, IssueEnrichmentRecord>();
  let watermark: IssueEnrichmentRepoWatermark = { repo, activatedAt: oldWatermark, lastCheckedAt: oldWatermark, createdAt: oldWatermark, updatedAt: oldWatermark };
  const configured = { ...DEFAULT_ISSUE_ENRICHMENT_CONFIG, enabled: true, postIssueComment: true, allowlist: [repo], ...overrides };
  configured.repos = { [repo]: { maxIssuesPerCycle: configured.maxIssuesPerCycle, maxCommentsPerCycle: configured.maxCommentsPerCycle, maxIssuesPerBurst: configured.maxIssuesPerBurst, cooldownMs: configured.cooldownMs, burstWindowMs: configured.burstWindowMs, lookbackMs: configured.lookbackMs } };
  const config = { workRoot: tmpdir(), evidenceDir: `${tmpdir()}/burst-recovery-evidence`, codexRuntime: { enabled: true, cliPath: "/usr/bin/false", model: "fixture", reasoningEffort: "low" as const, timeoutMs: 1, maxOutputBytes: 1 }, reviewGate: { publicRepoAuthorGate: { mode: "off" as const, allowedAssociations: [], allowedLogins: [] } }, issueEnrichment: configured };
  const state: Parameters<typeof runIssueEnrichmentCycle>[0]["state"] = {
    getIssueEnrichmentRecord: (_repo, number) => records.get(number),
    recordIssueEnrichment: vi.fn((input: RecordIssueEnrichmentInput) => {
      const { now, ...value } = input;
      const stored = { ...value, createdAt: records.get(value.issueNumber)?.createdAt ?? checkedAt, updatedAt: (now ?? new Date(checkedAt)).toISOString() };
      records.set(value.issueNumber, stored); return stored;
    }),
    getIssueEnrichmentRepoWatermark: () => watermark,
    recordIssueEnrichmentRepoWatermark: vi.fn((input) => { const { now, ...value } = input; watermark = { ...value, createdAt: oldWatermark, updatedAt: now!.toISOString() }; return watermark; }),
    tryAcquireIssueEnrichmentRunLease: () => ({ leaseId: "fixture", expiresAt: "2026-10-31T11:00:00.000Z", ownerPid: 1 }),
    releaseIssueEnrichmentRunLease: () => undefined,
    clearIssueEnrichmentAuthorGateSkip: () => false
  };
  const visited: number[] = [];
  const github = {
    listIssuesForEnrichment: vi.fn(enrichmentListing(() => rows, visited)),
    getRepo: async () => ({ default_branch: "main" }),
    listIssueLabelEvents: vi.fn(async () => []),
    listIssueComments: vi.fn(async () => []), // Each call marks a source/evidence probe.
    getIssueOrPull: async (_repo: string, number: number) => rows.find((row) => row.number === number),
    canPost: () => true,
    upsertIssueComment: vi.fn(async ({ issueNumber }: { issueNumber: number }) => ({ action: "created" as const, id: issueNumber, html_url: `https://example.test/comment/${issueNumber}` }))
  };
  const seed = (row: GitHubRelatedIssueOrPull, extra: Partial<IssueEnrichmentRecord>) => records.set(row.number, { repo, issueNumber: row.number, issueUpdatedAt: row.updated_at!, createdAt: checkedAt, updatedAt: checkedAt, status: "deferred", ...extra });
  const posted = async (row: GitHubRelatedIssueOrPull) => {
    const evidenceContext = await buildIssueEvidenceContext({ repo, issue: row, github, defaultBranch: "main", headSha: "a".repeat(40) });
    const analysisInputHash = buildIssueAnalysisInputHash({ repo, issue: row, headSha: "a".repeat(40), evidenceContext, repoPolicy: { validationSuggestions: [], suggestedLabels: [], suggestedReviewers: [], labelAliases: {} }, allowedLabels: [], allowedOwners: [], suggestedOwners: [], rendererVersion: ISSUE_ANALYSIS_PUBLIC_RENDERER_VERSION, model: "fixture", reasoningEffort: "low", maxSuggestions: 8 });
    seed(row, { status: "posted", analysisInputHash, commentUrl: `https://example.test/comment/${row.number}` });
    github.listIssueLabelEvents.mockClear(); github.listIssueComments.mockClear();
  };
  return { config, state, github, records, visited, seed, posted, setRows: (value: GitHubRelatedIssueOrPull[]) => { rows = value; }, cycle: (at = checkedAt) => runIssueEnrichmentCycle({ config, state, github, dryRun: false, checkedAt: at, licenseAdmission: admission }) };
}
const expectBurstSkip = (value: IssueEnrichmentRecord | undefined) => {
  expect(value).toMatchObject({ status: "skipped", reason: "burst_threshold_exceeded" });
  expect(value).not.toHaveProperty("nextEligibleAt");
};

beforeEach(() => {
  vi.clearAllMocks();
  prepare.mockResolvedValue({ path: tmpdir(), headSha: "a".repeat(40) });
  analyze.mockResolvedValue({ analysis: { classification: "needs-repro", priority: "P3", priorityState: "provisional", confidence: "needs-repro", repositoryImpact: "fixture", currentMainApplicability: "fixture", verifiedFacts: [], reproductionOrInvariantGap: "fixture", relatedWork: [], migrationDisposition: "needs-repro", nextGate: "fixture", limitations: [], labelProposals: [] } });
});

describe("burst recovery acceptance", () => {
  it("1: drains legacy due rows and the held tail without comments, exempting NEW", async () => {
    const old = Array.from({ length: 15 }, (_, i) => issue(i + 1)), fresh = newIssue(100), h = harness([...old, fresh]);
    for (const row of [...old, fresh]) h.seed(row, { reason: "burst_threshold_exceeded", nextEligibleAt: row.number > 10 && row.number < 100 ? "2026-10-31T10:30:00.000Z" : "2026-10-31T09:00:00.000Z" });
    const first = await h.cycle();
    for (const row of old.slice(0, 10)) expectBurstSkip(h.records.get(row.number));
    for (const row of old.slice(10)) expect(h.records.get(row.number)).toMatchObject({ status: "deferred", reason: "burst_threshold_exceeded", nextEligibleAt: "2026-10-31T10:30:00.000Z" });
    expect(first.summary).toMatchObject({ posted: 1, skippedRecorded: 10, deferredRecorded: 5 });
    expect(h.state.getIssueEnrichmentRepoWatermark(repo)?.lastCheckedAt).toBe(oldWatermark);
    const second = await h.cycle("2026-10-31T11:01:00.000Z");
    for (const row of old) expectBurstSkip(h.records.get(row.number));
    expect(second.summary).toMatchObject({ posted: 0, skippedRecorded: 5, deferredRecorded: 0 });
    expect(h.github.upsertIssueComment.mock.calls.map(([value]) => value.issueNumber)).toEqual([100]);
    expect(h.state.getIssueEnrichmentRepoWatermark(repo)?.lastCheckedAt).toBe("2026-10-31T11:01:00.000Z");
  });

  it("2: skips a whole fresh burst and admits a later update", async () => {
    const rows = Array.from({ length: 25 }, (_, i) => issue(i + 1)), h = harness(rows);
    const first = await h.cycle();
    expect(first.summary).toMatchObject({ skippedRecorded: 25, posted: 0, deferredRecorded: 0, truncatedRepos: 0 });
    for (const row of rows) { expectBurstSkip(h.records.get(row.number)); expect(h.records.get(row.number)?.issueUpdatedAt).toBe(row.updated_at); }
    expect(h.state.getIssueEnrichmentRepoWatermark(repo)?.lastCheckedAt).toBe(checkedAt);
    h.setRows([{ ...rows[0]!, updated_at: "2026-10-31T10:01:00.000Z" }, ...rows.slice(1)]);
    const second = await h.cycle("2026-10-31T10:02:00.000Z");
    expect(second.summary.posted).toBe(1);
    expect(h.records.get(1)?.status).toBe("posted");
  });

  it("3: a newest NEW issue cannot hide eleven existing updates", async () => {
    const fresh = newIssue(1), old = Array.from({ length: 11 }, (_, i) => issue(i + 2)), h = harness([fresh, ...old]);
    await h.cycle();
    for (const row of old) expectBurstSkip(h.records.get(row.number));
    expect(h.records.get(1)?.status).toBe("posted");
    expect(h.github.upsertIssueComment.mock.calls.map(([value]) => value.issueNumber)).toEqual([1]);
  });

  it("5: unchanged posted records survive an existing-issue burst", async () => {
    const old = Array.from({ length: 11 }, (_, i) => issue(i + 2)), posted = issue(1), h = harness([posted, ...old]);
    await h.posted(posted);
    const before = h.records.get(1);
    await h.cycle();
    for (const row of old) expectBurstSkip(h.records.get(row.number));
    expect(h.records.get(1)).toEqual(before);
    expect(h.github.listIssueComments).toHaveBeenCalledTimes(1);
    expect(h.github.upsertIssueComment).not.toHaveBeenCalled();
  });

  it("6: missing and malformed creation dates fail closed", async () => {
    const h = harness([issue(1), issue(2, { created_at: "invalid" })], { maxIssuesPerBurst: 1 });
    await h.cycle();
    expectBurstSkip(h.records.get(1)); expectBurstSkip(h.records.get(2));
    expect(h.github.upsertIssueComment).not.toHaveBeenCalled();
  });

  it("6b: an issue created after the cycle's checkedAt still counts as NEW", async () => {
    const opened = "2026-10-31T10:00:30.000Z";
    const h = harness([issue(1), issue(2), issue(3, { created_at: opened, updated_at: opened })], { maxIssuesPerBurst: 1 });
    await h.cycle();
    expectBurstSkip(h.records.get(1)); expectBurstSkip(h.records.get(2));
    expect(h.records.get(3)?.status).toBe("posted");
    expect(h.github.upsertIssueComment.mock.calls.map(([value]) => value.issueNumber)).toEqual([3]);
  });

  it("7: NEW issues still wait for comment caps and hold the watermark", async () => {
    const h = harness([newIssue(1), newIssue(2), newIssue(3)], { maxCommentsPerCycle: 1 });
    const result = await h.cycle();
    expect(result.summary).toMatchObject({ posted: 1, deferredRecorded: 2, skippedRecorded: 0 });
    for (const number of [2, 3]) expect(h.records.get(number)).toMatchObject({ status: "deferred", reason: "repo_max_comments_per_cycle", nextEligibleAt: "2026-10-31T11:00:00.000Z" });
    expect(h.state.getIssueEnrichmentRepoWatermark(repo)?.lastCheckedAt).toBe(oldWatermark);
  });

  it("8: standalone scan skips existing bursts while exempting NEW", async () => {
    const h = harness([newIssue(1), issue(2), issue(3)], { maxIssuesPerBurst: 1 });
    const scan = await collectIssueEnrichmentScan({ config: h.config, reader: h.github, dryRun: true, includeExisting: true, checkedAt });
    expect(scan.items.filter(({ issueNumber }) => issueNumber !== 1)).toEqual([2, 3].map((issueNumber) => expect.objectContaining({ issueNumber, action: "skipped", reason: "burst_threshold_exceeded" })));
    expect(scan.items.find(({ issueNumber }) => issueNumber === 1)).toMatchObject({ action: "would_comment", reason: "eligible" });
    expect(scan.items.every((item) => item.nextEligibleAt === undefined)).toBe(true);
  });

  it("9: reaches a cap-deferred issue below the WorldOS posted prefix", async () => {
    const prefix = [issue(1), issue(2), issue(3)], pending = issue(4), h = harness([...prefix, pending], { maxIssuesPerCycle: 1, maxCommentsPerCycle: 1, maxIssuesPerBurst: 2 });
    for (const row of prefix) await h.posted(row);
    h.seed(pending, { reason: "repo_max_comments_per_cycle", nextEligibleAt: "2026-10-31T09:00:00.000Z" });
    const result = await h.cycle();
    expect(result.summary).toMatchObject({ posted: 1, truncatedRepos: 0 });
    expect(h.records.get(4)?.status).toBe("posted");
    expect(h.state.getIssueEnrichmentRepoWatermark(repo)?.lastCheckedAt).toBe(checkedAt);
  });

  it("10: reads the held window but caps posted event and source probes", async () => {
    const rows = Array.from({ length: 30 }, (_, i) => issue(i + 1)), h = harness(rows);
    for (const row of rows) await h.posted(row);
    const before = new Map(h.records);
    const result = await h.cycle();
    expect(h.visited).toHaveLength(30);
    expect(h.github.listIssueLabelEvents).toHaveBeenCalledTimes(11);
    expect(h.github.listIssueComments).toHaveBeenCalledTimes(11);
    expect(result.items.map(({ issueNumber }) => issueNumber)).toEqual(rows.slice(0, 11).map(({ number }) => number));
    for (const row of rows.slice(11)) expect(h.records.get(row.number)).toBe(before.get(row.number));
    expect(h.state.recordIssueEnrichment).not.toHaveBeenCalled();
    expect(result.summary.truncatedRepos).toBe(0);
  });
});
