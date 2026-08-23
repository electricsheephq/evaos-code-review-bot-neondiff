import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import type { GitHubRelatedIssueOrPull } from "../src/github-related-context.js";
import type { BoundedGithubList } from "../src/github.js";
import type { IssueAnalysis } from "../src/issue-analysis.js";
import { runIssueEnrichmentCycle } from "../src/issue-enrichment.js";
import { ReviewStateStore } from "../src/state.js";
import { createTestLicenseAdmission } from "./helpers/license-admission.js";

const admission = await createTestLicenseAdmission({ operation: "issue_enrichment" });
const analysis = (): IssueAnalysis => ({
  classification: "needs-repro", priority: "P3", priorityState: "provisional", confidence: "needs-repro",
  repositoryImpact: "fixture", currentMainApplicability: "fixture", verifiedFacts: [],
  reproductionOrInvariantGap: "fixture", relatedWork: [], migrationDisposition: "needs-repro",
  nextGate: "fixture", limitations: [], labelProposals: []
});

describe("label-event promotion consumer", () => {
  it("defers only the overflow issue and holds its repository watermark", async () => {
    const root = mkdtempSync(join(tmpdir(), "issue-label-overflow-"));
    const statePath = join(root, "state.sqlite");
    const configPath = join(root, "config.json");
    const config = {
      statePath,
      issueEnrichment: {
        enabled: true, postIssueComment: true, allowlist: ["owner/repo"], maxIssuesPerCycle: 3,
        maxCommentsPerCycle: 3, processExistingOpenIssuesOnActivation: true,
        repos: { "owner/repo": { maxIssuesPerCycle: 3, maxCommentsPerCycle: 3, cooldownMs: 60_000,
          burstWindowMs: 60_000, maxIssuesPerBurst: 10, lookbackMs: 60_000,
          promotionMaintainers: [{ login: "trusted", validFrom: "2026-01-01T00:00:00Z" }] } }
      }
    };
    writeFileSync(configPath, `${JSON.stringify(config)}\n`);
    const state = new ReviewStateStore(statePath);
    const overflowEvents = Object.assign(Array.from({ length: 500 }, () => ({ event: "labeled" })), {
      items: Array.from({ length: 500 }, () => ({ event: "labeled" })), rawCount: 500, truncated: true, overflow: true
    }) as BoundedGithubList<{ event?: string }>;
    const overflowIssue: GitHubRelatedIssueOrPull = {
      number: 738, title: "overflow", state: "open", updated_at: "2026-08-24T00:01:00Z",
      labels: [{ name: "upstream-intake" }, { name: "active-continuation" }], body: "fixture"
    };
    const ordinaryIssue: GitHubRelatedIssueOrPull = {
      number: 739, title: "ordinary", state: "open", updated_at: "2026-08-24T00:01:00Z", labels: [], body: "fixture"
    };
    state.recordIssueEnrichmentRepoWatermark({ repo: "owner/repo", activatedAt: "2026-08-24T00:00:00Z", lastCheckedAt: "2026-08-24T00:00:00Z", now: new Date("2026-08-24T00:00:00Z") });
    let posts = 0;
    try {
      const result = await runIssueEnrichmentCycle({
        config: loadConfig(configPath), state, dryRun: false, includeExisting: true, checkedAt: "2026-08-24T00:02:00Z",
        licenseAdmission: admission, analyzeIssue: async () => analysis(),
        github: {
          listIssuesForEnrichment: async () => [overflowIssue, ordinaryIssue],
          listIssueLabelEvents: async () => overflowEvents,
          getCollaboratorPermission: async () => "maintain",
          canPostAsApp: () => true,
          upsertIssueComment: async () => { posts += 1; return { action: "created" as const, comment: { html_url: "https://github.test/comment" } }; }
        }
      });

      expect(result.summary).toMatchObject({ posted: 1, deferred: 1, deferredRecorded: 1, skipped: 0, failed: 0 });
      expect(result.items).toEqual(expect.arrayContaining([
        expect.objectContaining({ issueNumber: 738, action: "deferred", reason: "issue_label_event_overflow", recordStatus: "deferred" }),
        expect.objectContaining({ issueNumber: 739, action: "would_comment", recordStatus: "posted" })
      ]));
      expect(posts).toBe(1);
      expect(state.getIssueEnrichmentRecord("owner/repo", 738)).toMatchObject({ status: "deferred", reason: "issue_label_event_overflow" });
      expect(state.getIssueEnrichmentRepoWatermark("owner/repo")).toMatchObject({ lastCheckedAt: "2026-08-24T00:00:00.000Z" });
    } finally {
      state.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
