import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BotConfig } from "../src/config.js";
import type { GitHubApi } from "../src/github.js";
import { ReviewRunBudget } from "../src/review-budget.js";
import { ReviewStateStore } from "../src/state.js";
import type { PullRequestSummary } from "../src/types.js";
import { reviewPull } from "../src/worker.js";

describe("review run budget", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("caps concurrent active review runs", () => {
    const budget = new ReviewRunBudget(5);

    expect(Array.from({ length: 5 }, () => budget.tryStart())).toEqual([true, true, true, true, true]);
    expect(budget.tryStart()).toBe(false);
    expect(budget.activeRuns).toBe(5);

    budget.finish();

    expect(budget.activeRuns).toBe(4);
    expect(budget.tryStart()).toBe(true);
    expect(budget.activeRuns).toBe(5);
  });

  it("rejects invalid max active run settings", () => {
    expect(() => new ReviewRunBudget(0)).toThrow("maxActiveRuns must be at least 1");
    expect(() => new ReviewRunBudget(5.5)).toThrow("maxActiveRuns must be an integer");
  });

  it("does not let activeRuns go negative on extra finish calls", () => {
    const budget = new ReviewRunBudget(2);

    budget.finish();

    expect(budget.activeRuns).toBe(0);
    expect(budget.tryStart()).toBe(true);
    expect(budget.tryStart()).toBe(true);
    expect(budget.tryStart()).toBe(false);
  });

  it("prevents worker review work when the active run cap is reached", async () => {
    const budget = new ReviewRunBudget(1);
    expect(budget.tryStart()).toBe(true);

    const status = await reviewPull({
      config: minimalConfig(),
      github: {} as GitHubApi,
      state: {
        hasProcessed: () => false
      } as unknown as ReviewStateStore,
      repo: "electricsheephq/WorldOS",
      pull: pull(1190, "new-head"),
      dryRun: true,
      useZCode: false,
      budget
    });

    expect(status).toBe("skipped_capacity");
    expect(budget.activeRuns).toBe(1);
  });

  it("uses SQLite leases to cap overlapping worker entrypoints", async () => {
    const store = createStore(roots);
    const lease = store.tryAcquireReviewRunLease(1, 60_000, new Date("2026-07-01T00:00:00.000Z"));
    expect(lease).toBeDefined();

    const budget = new ReviewRunBudget(5);
    const status = await reviewPull({
      config: {
        ...minimalConfig(),
        reviewConcurrency: {
          maxActiveRuns: 1,
          leaseTtlMs: 60_000
        }
      },
      github: {} as GitHubApi,
      state: store,
      repo: "electricsheephq/WorldOS",
      pull: pull(1190, "new-head"),
      dryRun: true,
      useZCode: false,
      budget
    });

    expect(status).toBe("skipped_capacity");
    expect(budget.activeRuns).toBe(0);
    store.close();
  });
});

function createStore(roots: string[]): ReviewStateStore {
  const root = mkdtempSync(join(tmpdir(), "evaos-review-budget-"));
  roots.push(root);
  return new ReviewStateStore(join(root, "state.sqlite"));
}

function minimalConfig(): BotConfig {
  return {
    pilotRepos: ["electricsheephq/WorldOS"],
    pollIntervalMs: 60_000,
    skipDrafts: true,
    workRoot: "/unused",
    statePath: "/unused/state.sqlite",
    evidenceDir: "/unused/evidence",
    activation: {
      reviewExistingOpenPrsOnActivation: false
    },
    reviewConcurrency: {
      maxActiveRuns: 5,
      leaseTtlMs: 60_000
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

function pull(number: number, sha: string): PullRequestSummary {
  return {
    number,
    title: `PR ${number}`,
    draft: false,
    head: {
      sha,
      ref: `pr-${number}`
    },
    base: {
      sha: "base",
      ref: "main",
      repo: {
        full_name: "owner/repo"
      }
    },
    html_url: `https://github.test/owner/repo/pull/${number}`
  };
}
