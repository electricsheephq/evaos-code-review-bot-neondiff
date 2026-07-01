import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BotConfig } from "../src/config.js";
import type { GitHubApi } from "../src/github.js";
import { ReviewRunBudget } from "../src/review-budget.js";
import { ReviewStateStore } from "../src/state.js";
import type { PullRequestSummary } from "../src/types.js";
import { detectStalePullHead, reviewPull } from "../src/worker.js";

describe("exact-head stale guards", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("detects a stale PR head with phase-specific evidence", () => {
    expect(detectStalePullHead({
      expected: pull(1213, "head-a", "base-a"),
      live: pull(1213, "head-b", "base-a"),
      phase: "before_review"
    })).toEqual({
      reason: "stale_head_before_review",
      expectedHeadSha: "head-a",
      liveHeadSha: "head-b",
      expectedBaseSha: "base-a",
      liveBaseSha: "base-a"
    });

    expect(detectStalePullHead({
      expected: pull(1213, "head-a", "base-a"),
      live: pull(1213, "head-a", "base-a"),
      phase: "before_post"
    })).toBeUndefined();
  });

  it("skips a command-triggered review when the live head moved before review work starts", async () => {
    const root = mkdtempSync(join(tmpdir(), "stale-head-"));
    roots.push(root);
    const store = new ReviewStateStore(join(root, "state.sqlite"));
    const config = minimalConfig(root);
    const github = {
      listIssueComments: async () => [
        {
          id: 9001,
          body: "@evaos-code-review-bot re-review",
          user: { login: "100yenadmin", type: "User" }
        }
      ],
      getPull: async () => pull(1213, "new-head", "base-a"),
      listPullFiles: async () => {
        throw new Error("stale command review should not fetch files");
      },
      canPostAsApp: () => false
    } as unknown as GitHubApi;

    await expect(reviewPull({
      config,
      github,
      state: store,
      repo: "electricsheephq/WorldOS",
      pull: pull(1213, "old-head", "base-a"),
      dryRun: true,
      useZCode: false,
      budget: new ReviewRunBudget(1)
    })).resolves.toBe("skipped_stale_head");

    expect(store.hasProcessed("electricsheephq/WorldOS", 1213, "old-head")).toBe(true);
    store.close();
  });
});

function minimalConfig(root: string): BotConfig {
  mkdirSync(join(root, "work"), { recursive: true });
  return {
    pilotRepos: ["electricsheephq/WorldOS"],
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
      durationMs: 15 * 60_000,
      requestRateLimitDurationMs: 5 * 60_000,
      overloadDurationMs: 2 * 60_000,
      quotaDurationMs: 30 * 60_000,
      transientRetryAttempts: 2,
      transientRetryBaseDelayMs: 1,
      transientRetryMaxDelayMs: 1
    },
    walkthrough: {
      enabled: false,
      postIssueComment: false
    },
    commands: {
      enabled: true,
      botMentions: ["@evaos-code-review-bot"],
      trustedAuthors: ["100yenadmin"],
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

function pull(number: number, headSha: string, baseSha: string): PullRequestSummary {
  return {
    number,
    title: `PR ${number}`,
    draft: false,
    head: {
      sha: headSha,
      ref: `pr-${number}`
    },
    base: {
      sha: baseSha,
      ref: "main",
      repo: {
        full_name: "electricsheephq/WorldOS"
      }
    },
    html_url: `https://github.test/electricsheephq/WorldOS/pull/${number}`
  };
}
