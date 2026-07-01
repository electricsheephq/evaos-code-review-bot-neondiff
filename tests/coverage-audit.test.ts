import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { BotConfig } from "../src/config.js";
import { collectCoverageAudit, CoverageStateReader } from "../src/coverage-audit.js";
import type { GitHubApi } from "../src/github.js";
import { ReviewStateStore } from "../src/state.js";
import type { PullRequestSummary } from "../src/types.js";

const roots: string[] = [];

describe("coverage audit", () => {
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("reports open eligible heads without DB rows while preserving skip/read-failure reasons", async () => {
    const { root, state } = createState();
    state.recordProcessed({
      repo: "owner/allowed",
      pullNumber: 1,
      headSha: "head-1",
      status: "posted",
      event: "COMMENT"
    });
    state.recordProcessed({
      repo: "owner/allowed",
      pullNumber: 3,
      headSha: "old-head-3",
      status: "posted",
      event: "COMMENT"
    });
    const rowsBefore = countProcessedRows(root);

    const audit = await collectCoverageAudit({
      config: {
        ...minimalConfig(root),
        pilotRepos: ["owner/allowed", "owner/disabled", "owner/missing", "owner/read-fail"],
        repoProfiles: {
          repos: {
            "owner/allowed": { displayName: "Allowed" },
            "owner/disabled": { enabled: false, displayName: "Disabled" },
            "owner/read-fail": { displayName: "Read Fail" }
          }
        }
      },
      github: {
        listOpenPulls: async (repo: string) => {
          if (repo === "owner/read-fail") throw new Error("GitHub API 404 for /repos/owner/read-fail/pulls");
          if (repo !== "owner/allowed") throw new Error(`unexpected GitHub fetch for ${repo}`);
          return [
            pull(1, "head-1"),
            pull(2, "head-2", { draft: true }),
            pull(3, "head-3"),
            pull(4, "head-4")
          ];
        }
      } as unknown as GitHubApi,
      state
    });

    expect(audit.ok).toBe(false);
    expect(audit.summary).toMatchObject({
      reposScanned: 4,
      pullsSeen: 4,
      processed: 1,
      unprocessed: 2,
      skipped: 3,
      readFailures: 1
    });
    expect(audit.unprocessed.map((entry) => `${entry.repo}#${entry.pullNumber}@${entry.headSha}`)).toEqual([
      "owner/allowed#3@head-3",
      "owner/allowed#4@head-4"
    ]);
    expect(audit.unprocessed[0]?.previousProcessedHeads).toEqual(["old-head-3"]);
    expect(audit.skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ repo: "owner/allowed", pullNumber: 2, reason: "draft" }),
        expect.objectContaining({ repo: "owner/disabled", reason: "repo_profile_disabled" }),
        expect.objectContaining({ repo: "owner/missing", reason: "repo_profile_missing" })
      ])
    );
    expect(audit.readFailures).toEqual([
      expect.objectContaining({ repo: "owner/read-fail", error: expect.stringContaining("GitHub API 404") })
    ]);
    expect(countProcessedRows(root)).toBe(rowsBefore);
    state.close();
  });

  it("supports canary and single-PR scoping without marking closed PRs as misses", async () => {
    const { root, state } = createState();
    let getPullCount = 0;

    const audit = await collectCoverageAudit({
      config: {
        ...minimalConfig(root),
        canaryPulls: ["owner/allowed#7"],
        repoProfiles: {
          repos: {
            "owner/allowed": { displayName: "Allowed" }
          }
        }
      },
      github: {
        getPull: async () => {
          getPullCount += 1;
          return pull(8, "head-8", { state: "closed" });
        }
      } as unknown as GitHubApi,
      state,
      repo: "owner/allowed",
      pullNumber: 8,
      verifyCurrentHeads: true
    });

    expect(audit.ok).toBe(true);
    expect(audit.summary).toMatchObject({
      reposScanned: 1,
      pullsSeen: 1,
      processed: 0,
      unprocessed: 0,
      skipped: 1,
      readFailures: 0
    });
    expect(audit.skipped).toEqual([
      expect.objectContaining({ repo: "owner/allowed", pullNumber: 8, reason: "closed" })
    ]);
    expect(getPullCount).toBe(1);
    expect(countProcessedRows(root)).toBe(0);
    state.close();
  });

  it("fails scoped audits when the requested repo is not eligible by policy", async () => {
    const { root, state } = createState();

    const audit = await collectCoverageAudit({
      config: {
        ...minimalConfig(root),
        repoProfiles: {
          repos: {
            "owner/allowed": { displayName: "Allowed" }
          }
        }
      },
      github: {
        getPull: async () => {
          throw new Error("getPull should not be called for a policy-skipped scoped repo");
        }
      } as unknown as GitHubApi,
      state,
      repo: "owner/typo",
      pullNumber: 1
    });

    expect(audit.ok).toBe(false);
    expect(audit.summary).toMatchObject({
      reposScanned: 1,
      pullsSeen: 0,
      unprocessed: 0,
      skipped: 1,
      readFailures: 1
    });
    expect(audit.skipped).toEqual([
      expect.objectContaining({ repo: "owner/typo", reason: "repo_profile_missing" })
    ]);
    expect(audit.readFailures).toEqual([
      expect.objectContaining({ repo: "owner/typo", error: expect.stringContaining("repo_profile_missing") })
    ]);
    state.close();
  });

  it("does not create a missing DB path while auditing", async () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-coverage-missing-db-"));
    roots.push(root);
    const statePath = join(root, "missing", "state.sqlite");

    const audit = await collectCoverageAudit({
      config: minimalConfig(root),
      github: {
        listOpenPulls: async () => [pull(9, "head-9")]
      } as unknown as GitHubApi,
      state: CoverageStateReader.open(statePath)
    });

    expect(audit.summary.unprocessed).toBe(1);
    expect(audit.unprocessed[0]?.previousProcessedHeads).toEqual([]);
    expect(existsSync(statePath)).toBe(false);
    expect(existsSync(join(root, "missing"))).toBe(false);
  });

  it("re-reads unprocessed open candidates and reports stale heads separately", async () => {
    const { root, state } = createState();

    const audit = await collectCoverageAudit({
      config: minimalConfig(root),
      github: {
        listOpenPulls: async () => [pull(10, "old-head")],
        getPull: async () => pull(10, "new-head")
      } as unknown as GitHubApi,
      state,
      verifyCurrentHeads: true
    });

    expect(audit.ok).toBe(false);
    expect(audit.summary).toMatchObject({
      staleHeads: 1,
      unprocessed: 1
    });
    expect(audit.staleHeads).toEqual([
      expect.objectContaining({
        repo: "owner/allowed",
        pullNumber: 10,
        expectedHeadSha: "old-head",
        liveHeadSha: "new-head"
      })
    ]);
    expect(audit.unprocessed.map((entry) => entry.headSha)).toEqual(["new-head"]);
    state.close();
  });

  it("does not fail the audit when a stale listed PR is closed on re-read", async () => {
    const { root, state } = createState();

    const audit = await collectCoverageAudit({
      config: minimalConfig(root),
      github: {
        listOpenPulls: async () => [pull(11, "head-11", { state: "open" })],
        getPull: async () => pull(11, "head-11", { state: "closed" })
      } as unknown as GitHubApi,
      state,
      verifyCurrentHeads: true
    });

    expect(audit.ok).toBe(true);
    expect(audit.summary).toMatchObject({
      staleHeads: 1,
      unprocessed: 0,
      skipped: 1,
      readFailures: 0
    });
    expect(audit.staleHeads).toEqual([
      expect.objectContaining({
        repo: "owner/allowed",
        pullNumber: 11,
        expectedState: "open",
        liveState: "closed"
      })
    ]);
    state.close();
  });

  it("counts a stale live head as processed when the live head already has a DB row", async () => {
    const { root, state } = createState();
    state.recordProcessed({
      repo: "owner/allowed",
      pullNumber: 12,
      headSha: "new-head",
      status: "posted",
      event: "COMMENT"
    });

    const audit = await collectCoverageAudit({
      config: minimalConfig(root),
      github: {
        listOpenPulls: async () => [pull(12, "old-head")],
        getPull: async () => pull(12, "new-head")
      } as unknown as GitHubApi,
      state,
      verifyCurrentHeads: true
    });

    expect(audit.ok).toBe(true);
    expect(audit.summary).toMatchObject({
      staleHeads: 1,
      processed: 1,
      unprocessed: 0,
      readFailures: 0
    });
    expect(audit.processed).toEqual([
      expect.objectContaining({
        repo: "owner/allowed",
        pullNumber: 12,
        headSha: "new-head",
        status: "posted"
      })
    ]);
    state.close();
  });
});

function createState(): { root: string; state: ReviewStateStore } {
  const root = mkdtempSync(join(tmpdir(), "evaos-coverage-audit-"));
  roots.push(root);
  return { root, state: new ReviewStateStore(join(root, "state.sqlite")) };
}

function countProcessedRows(root: string): number {
  const db = new DatabaseSync(join(root, "state.sqlite"));
  try {
    return (db.prepare("select count(*) as count from processed_reviews").get() as { count: number }).count;
  } finally {
    db.close();
  }
}

function minimalConfig(root: string): BotConfig {
  return {
    pilotRepos: ["owner/allowed"],
    pollIntervalMs: 60_000,
    skipDrafts: true,
    workRoot: join(root, "work"),
    statePath: join(root, "state.sqlite"),
    evidenceDir: join(root, "evidence"),
    activation: {
      reviewExistingOpenPrsOnActivation: false
    },
    reviewConcurrency: {
      maxActiveRuns: 1,
      leaseTtlMs: 60_000
    },
    providerCooldown: {
      enabled: true,
      durationMs: 15 * 60_000
    },
    walkthrough: {
      enabled: false,
      postIssueComment: false
    },
    commands: {
      enabled: false,
      botMentions: ["@evaos-code-review-bot"],
      trustedAuthors: [],
      acknowledge: false
    },
    zcode: {
      cliPath: "/unused/zcode.cjs",
      appConfigPath: "/unused/config.json",
      model: "GLM-5.2",
      timeoutMs: 1,
      maxPatchBytes: 1,
      retryMaxRetries: 0
    },
    github: {}
  };
}

function pull(
  number: number,
  headSha: string,
  options: { draft?: boolean; state?: string } = {}
): PullRequestSummary {
  return {
    number,
    title: `PR ${number}`,
    draft: options.draft ?? false,
    state: options.state ?? "open",
    head: {
      sha: headSha,
      ref: `pr-${number}`,
      repo: { full_name: "owner/allowed" }
    },
    base: {
      sha: "base",
      ref: "main",
      repo: { full_name: "owner/allowed" }
    },
    html_url: `https://github.test/owner/allowed/pull/${number}`
  };
}
