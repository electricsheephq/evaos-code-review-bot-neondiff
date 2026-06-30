import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BotConfig } from "../src/config.js";
import type { GitHubApi } from "../src/github.js";
import { ReviewRunBudget } from "../src/review-budget.js";
import { ReviewStateStore } from "../src/state.js";
import type { PullRequestSummary } from "../src/types.js";
import {
  localDateFolder,
  prepareFailedHeadRetry,
  recordFailedReview,
  restoreFailedRetryRowIfNeeded,
  reviewPull
} from "../src/worker.js";

describe("worker review failures", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("records a failed head with redacted evidence so duplicate suppression can hold", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-worker-failure-"));
    roots.push(root);
    const state = new ReviewStateStore(join(root, "state.sqlite"));
    const config = minimalConfig(root);
    const pull = pullSummary(1222, "head-failed");

    recordFailedReview({
      config,
      state,
      repo: "electricsheephq/WorldOS",
      pull,
      error: new Error("ZCode failed before completion: spawnSync node ETIMEDOUT with ghp_1234567890abcdefghijklmnopqrstuvwx")
    });

    expect(state.hasProcessed("electricsheephq/WorldOS", 1222, "head-failed")).toBe(true);
    const evidence = readFileSync(
      join(root, "evidence", localDateFolder(), "electricsheephq__WorldOS", "pr-1222", "head-failed", "review-error.json"),
      "utf8"
    );
    expect(evidence).toContain("ETIMEDOUT");
    expect(evidence).not.toContain("ghp_1234567890abcdefghijklmnopqrstuvwx");
    state.close();
  });

  it("prepares exactly one failed current head for retry without deleting the failure row", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-worker-retry-"));
    roots.push(root);
    const config = minimalConfig(root);
    const state = new ReviewStateStore(config.statePath);
    state.recordProcessed({
      repo: "electricsheephq/WorldOS",
      pullNumber: 1223,
      headSha: "head-retry",
      status: "failed",
      error: "transient API timeout"
    });
    state.recordProcessed({
      repo: "electricsheephq/WorldOS",
      pullNumber: 1223,
      headSha: "other-head",
      status: "failed",
      error: "separate failure"
    });

    const result = prepareFailedHeadRetry({
      state,
      repo: "electricsheephq/WorldOS",
      pullNumber: 1223,
      headSha: "head-retry",
      livePull: pullSummary(1223, "head-retry")
    });
    expect(result).toMatchObject({
      repo: "electricsheephq/WorldOS",
      pullNumber: 1223,
      headSha: "head-retry"
    });
    expect(state.getProcessedReview("electricsheephq/WorldOS", 1223, "head-retry")).toMatchObject({
      status: "failed"
    });
    expect(state.getProcessedReview("electricsheephq/WorldOS", 1223, "other-head")).toMatchObject({
      status: "failed"
    });
    state.close();
  });

  it("refuses retry when the requested failed head is stale", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-worker-stale-retry-"));
    roots.push(root);
    const config = minimalConfig(root);
    const state = new ReviewStateStore(config.statePath);
    state.recordProcessed({
      repo: "electricsheephq/WorldOS",
      pullNumber: 1224,
      headSha: "old-head",
      status: "failed",
      error: "transient API timeout"
    });
    expect(() => prepareFailedHeadRetry({
      state,
      repo: "electricsheephq/WorldOS",
      pullNumber: 1224,
      headSha: "old-head",
      livePull: pullSummary(1224, "new-head")
    })).toThrow("Refusing retry for stale head");

    expect(state.getProcessedReview("electricsheephq/WorldOS", 1224, "old-head")).toMatchObject({
      status: "failed"
    });
    state.close();
  });

  it("refuses retry when the current head is not failed", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-worker-nonfailed-retry-"));
    roots.push(root);
    const config = minimalConfig(root);
    const state = new ReviewStateStore(config.statePath);
    state.recordProcessed({
      repo: "electricsheephq/WorldOS",
      pullNumber: 1225,
      headSha: "head-posted",
      status: "posted",
      event: "COMMENT"
    });
    expect(() => prepareFailedHeadRetry({
      state,
      repo: "electricsheephq/WorldOS",
      pullNumber: 1225,
      headSha: "head-posted",
      livePull: pullSummary(1225, "head-posted")
    })).toThrow("status is posted, not failed");
    state.close();
  });

  it("preserves the failed row when retry review work is skipped for capacity", async () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-worker-retry-capacity-"));
    roots.push(root);
    const config = minimalConfig(root);
    const state = new ReviewStateStore(config.statePath);
    const pull = pullSummary(1226, "head-capacity");
    const budget = new ReviewRunBudget(1);
    expect(budget.tryStart()).toBe(true);
    state.recordProcessed({
      repo: "electricsheephq/WorldOS",
      pullNumber: 1226,
      headSha: "head-capacity",
      status: "failed",
      error: "transient API timeout"
    });

    await expect(reviewPull({
      config,
      github: {} as unknown as GitHubApi,
      state,
      repo: "electricsheephq/WorldOS",
      pull,
      dryRun: true,
      useZCode: false,
      budget,
      ignoreProcessedHead: true
    })).resolves.toBe("skipped_capacity");
    expect(state.getProcessedReview("electricsheephq/WorldOS", 1226, "head-capacity")).toMatchObject({
      status: "failed"
    });
    budget.finish();
    state.close();
  });

  it("restores a failed row after a retry dry-run records dry_run", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-worker-retry-dry-run-"));
    roots.push(root);
    const config = minimalConfig(root);
    const state = new ReviewStateStore(config.statePath);
    const retryTarget = {
      repo: "electricsheephq/WorldOS",
      pullNumber: 1227,
      headSha: "head-dry-run",
      previousError: "transient API timeout"
    };
    state.recordProcessed({
      repo: retryTarget.repo,
      pullNumber: retryTarget.pullNumber,
      headSha: retryTarget.headSha,
      status: "dry_run",
      event: "COMMENT"
    });

    restoreFailedRetryRowIfNeeded({ state, retryTarget, reason: "retry_dry_run" });

    expect(state.getProcessedReview(retryTarget.repo, retryTarget.pullNumber, retryTarget.headSha)).toMatchObject({
      status: "failed",
      error: expect.stringContaining("retry_dry_run")
    });
    state.close();
  });

  it("does not rewrite an already failed retry row for intentional skip statuses", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-worker-retry-skip-"));
    roots.push(root);
    const config = minimalConfig(root);
    const state = new ReviewStateStore(config.statePath);
    const retryTarget = {
      repo: "electricsheephq/WorldOS",
      pullNumber: 1228,
      headSha: "head-skip",
      previousError: "original failure"
    };
    state.recordProcessed({
      repo: retryTarget.repo,
      pullNumber: retryTarget.pullNumber,
      headSha: retryTarget.headSha,
      status: "failed",
      error: retryTarget.previousError
    });

    restoreFailedRetryRowIfNeeded({ state, retryTarget, reason: "retry_did_not_review=skipped_command_stop" });

    expect(state.getProcessedReview(retryTarget.repo, retryTarget.pullNumber, retryTarget.headSha)).toMatchObject({
      status: "failed",
      error: "original failure"
    });
    state.close();
  });
});

function minimalConfig(root: string): BotConfig {
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

function pullSummary(number: number, headSha: string): PullRequestSummary {
  return {
    number,
    title: `PR ${number}`,
    draft: false,
    head: {
      sha: headSha,
      ref: `pr-${number}`,
      repo: { full_name: "electricsheephq/WorldOS" }
    },
    base: {
      sha: "base",
      ref: "main",
      repo: { full_name: "electricsheephq/WorldOS" }
    },
    html_url: `https://github.com/electricsheephq/WorldOS/pull/${number}`
  };
}
