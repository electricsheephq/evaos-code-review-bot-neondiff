import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BotConfig } from "../src/config.js";
import { planPullWorktreePaths } from "../src/git.js";
import type { GitHubApi } from "../src/github.js";
import { ReviewRunBudget } from "../src/review-budget.js";
import { ReviewStateStore } from "../src/state.js";
import type { PullRequestSummary } from "../src/types.js";
import { detectStalePullHead, reviewPull } from "../src/worker.js";
import { testLicenseAdmission } from "./helpers/license-admission.js";

describe("exact-head stale guards", () => {
  const roots: string[] = [];
  const headA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const oldHead = "1111111111111111111111111111111111111111";
  const newHead = "2222222222222222222222222222222222222222";

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
      getPull: async () => pull(1213, newHead, "base-a"),
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
      pull: pull(1213, oldHead, "base-a"),
      dryRun: true,
      useZCode: false,
      licenseAdmission: testLicenseAdmission,
      budget: new ReviewRunBudget(1)
    })).resolves.toBe("skipped_stale_head");

    expect(store.hasProcessed("electricsheephq/WorldOS", 1213, oldHead)).toBe(true);
    store.close();
  });

  it("records finishing-touch commands as draft-only without fetching PR files", async () => {
    const root = mkdtempSync(join(tmpdir(), "finishing-touch-command-"));
    roots.push(root);
    const store = new ReviewStateStore(join(root, "state.sqlite"));
    const config = minimalConfig(root);
    let acknowledgementAttempts = 0;
    const github = {
      listIssueComments: async () => [
        {
          id: 9002,
          body: "@evaos-code-review-bot explain risk",
          user: { login: "100yenadmin", type: "User" }
        }
      ],
      getPull: async () => pull(1214, headA, "base-a"),
      listPullFiles: async () => {
        throw new Error("finishing-touch drafts must not fetch files or enter review work");
      },
      canPostAsApp: () => true,
      upsertIssueComment: async () => {
        acknowledgementAttempts += 1;
        throw new Error("finishing-touch drafts must not post acknowledgements");
      }
    } as unknown as GitHubApi;
    config.commands.acknowledge = true;
    config.repoProfiles = {
      repos: {
        "electricsheephq/WorldOS": {
          finishingTouches: {
            riskExplanation: { enabled: true }
          }
        }
      }
    };

    await expect(reviewPull({
      config,
      github,
      state: store,
      repo: "electricsheephq/WorldOS",
      pull: pull(1214, headA, "base-a"),
      dryRun: false,
      useZCode: false,
      licenseAdmission: testLicenseAdmission,
      budget: new ReviewRunBudget(1)
    })).resolves.toBe("skipped_finishing_touch_draft");

    expect(store.hasProcessedCommand("electricsheephq/WorldOS", 1214, headA, 9002)).toBe(true);
    expect(store.getFinishingTouchDraft({
      repo: "electricsheephq/WorldOS",
      pullNumber: 1214,
      headSha: headA,
      commandCommentId: 9002
    })).toMatchObject({
      action: "explain_risk",
      status: "drafted",
      proposedOutput: {
        mode: "draft_only",
        canPush: false,
        canCommit: false
      }
    });
    expect(acknowledgementAttempts).toBe(0);
    store.close();
  });

  it("honors the queued finishing-touch command id instead of the latest comment", async () => {
    const root = mkdtempSync(join(tmpdir(), "finishing-touch-command-id-"));
    roots.push(root);
    const store = new ReviewStateStore(join(root, "state.sqlite"));
    const config = minimalConfig(root);
    config.repoProfiles = {
      repos: {
        "electricsheephq/WorldOS": {
          finishingTouches: {
            riskExplanation: { enabled: true },
            unitTests: { enabled: true }
          }
        }
      }
    };
    const github = {
      listIssueComments: async () => [
        {
          id: 9005,
          body: "@evaos-code-review-bot explain risk",
          user: { login: "100yenadmin", type: "User" }
        },
        {
          id: 9006,
          body: "@evaos-code-review-bot generate tests",
          user: { login: "100yenadmin", type: "User" }
        }
      ],
      getPull: async () => pull(1214, headA, "base-a"),
      listPullFiles: async () => {
        throw new Error("finishing-touch drafts must not fetch files or enter review work");
      },
      canPostAsApp: () => false
    } as unknown as GitHubApi;

    await expect(reviewPull({
      config,
      github,
      state: store,
      repo: "electricsheephq/WorldOS",
      pull: pull(1214, headA, "base-a"),
      dryRun: false,
      useZCode: false,
      licenseAdmission: testLicenseAdmission,
      budget: new ReviewRunBudget(1),
      commandCommentId: 9005
    })).resolves.toBe("skipped_finishing_touch_draft");

    expect(store.hasProcessedCommand("electricsheephq/WorldOS", 1214, headA, 9005)).toBe(true);
    expect(store.hasProcessedCommand("electricsheephq/WorldOS", 1214, headA, 9006)).toBe(false);
    expect(store.getFinishingTouchDraft({
      repo: "electricsheephq/WorldOS",
      pullNumber: 1214,
      headSha: headA,
      commandCommentId: 9005
    })).toMatchObject({
      action: "explain_risk",
      status: "drafted"
    });
    expect(store.getFinishingTouchDraft({
      repo: "electricsheephq/WorldOS",
      pullNumber: 1214,
      headSha: headA,
      commandCommentId: 9006
    })).toBeUndefined();
    store.close();
  });

  it("rejects stale finishing-touch commands without recording the PR head as processed", async () => {
    const root = mkdtempSync(join(tmpdir(), "finishing-touch-stale-base-"));
    roots.push(root);
    const store = new ReviewStateStore(join(root, "state.sqlite"));
    const config = minimalConfig(root);
    config.repoProfiles = {
      repos: {
        "electricsheephq/WorldOS": {
          finishingTouches: {
            riskExplanation: { enabled: true }
          }
        }
      }
    };
    const github = {
      listIssueComments: async () => [
        {
          id: 9007,
          body: "@evaos-code-review-bot explain risk",
          user: { login: "100yenadmin", type: "User" }
        }
      ],
      getPull: async () => pull(1214, "head-a", "base-b"),
      listPullFiles: async () => {
        throw new Error("stale finishing-touch command should not fetch files");
      },
      canPostAsApp: () => false
    } as unknown as GitHubApi;

    await expect(reviewPull({
      config,
      github,
      state: store,
      repo: "electricsheephq/WorldOS",
      pull: pull(1214, "head-a", "base-a"),
      dryRun: false,
      useZCode: false,
      licenseAdmission: testLicenseAdmission,
      budget: new ReviewRunBudget(1),
      commandCommentId: 9007
    })).resolves.toBe("skipped_finishing_touch_draft");

    expect(store.hasProcessed("electricsheephq/WorldOS", 1214, "head-a")).toBe(false);
    expect(store.hasProcessedCommand("electricsheephq/WorldOS", 1214, "head-a", 9007)).toBe(true);
    expect(store.getFinishingTouchDraft({
      repo: "electricsheephq/WorldOS",
      pullNumber: 1214,
      headSha: "head-a",
      commandCommentId: 9007
    })).toMatchObject({
      action: "explain_risk",
      status: "rejected",
      proposedOutput: {
        ok: false,
        reason: "stale_head"
      }
    });
    store.close();
  });

  it("ignores finishing-touch commands unless the repo profile enables the matching draft action", async () => {
    const root = mkdtempSync(join(tmpdir(), "finishing-touch-disabled-"));
    roots.push(root);
    const store = new ReviewStateStore(join(root, "state.sqlite"));
    const config = minimalConfig(root);
    const github = {
      listIssueComments: async () => [
        {
          id: 9003,
          body: "@evaos-code-review-bot explain risk",
          user: { login: "100yenadmin", type: "User" }
        }
      ],
      getPull: async () => pull(1215, "head-a", "base-a"),
      listPullFiles: async () => {
        throw new Error("disabled finishing-touch command should not fetch files");
      },
      canPostAsApp: () => false
    } as unknown as GitHubApi;

    await expect(reviewPull({
      config,
      github,
      state: store,
      repo: "electricsheephq/WorldOS",
      pull: pull(1215, "head-a", "base-a"),
      dryRun: false,
      useZCode: false,
      licenseAdmission: testLicenseAdmission,
      budget: new ReviewRunBudget(1)
    })).rejects.toThrow(/disabled finishing-touch command should not fetch files/);

    expect(store.hasProcessedCommand("electricsheephq/WorldOS", 1215, "head-a", 9003)).toBe(false);
    expect(store.getFinishingTouchDraft({
      repo: "electricsheephq/WorldOS",
      pullNumber: 1215,
      headSha: "head-a",
      commandCommentId: 9003
    })).toBeUndefined();
    store.close();
  });

  it("rejects finishing-touch drafts when the existing deterministic worktree is dirty", async () => {
    const root = mkdtempSync(join(tmpdir(), "finishing-touch-dirty-worktree-"));
    roots.push(root);
    const store = new ReviewStateStore(join(root, "state.sqlite"));
    const config = minimalConfig(root);
    config.repoProfiles = {
      repos: {
        "electricsheephq/WorldOS": {
          finishingTouches: {
            riskExplanation: { enabled: true }
          }
        }
      }
    };
    const planned = planPullWorktreePaths({
      repo: "electricsheephq/WorldOS",
      pullNumber: 1216,
      expectedHeadSha: headA,
      workRoot: config.workRoot
    });
    mkdirSync(planned.worktreePath, { recursive: true });
    writeFileSync(join(planned.worktreePath, "dirty.txt"), "dirty");
    const github = {
      listIssueComments: async () => [
        {
          id: 9004,
          body: "@evaos-code-review-bot explain risk",
          user: { login: "100yenadmin", type: "User" }
        }
      ],
      getPull: async () => pull(1216, headA, "base-a"),
      listPullFiles: async () => {
        throw new Error("dirty finishing-touch command should not fetch files");
      },
      canPostAsApp: () => false
    } as unknown as GitHubApi;

    await expect(reviewPull({
      config,
      github,
      state: store,
      repo: "electricsheephq/WorldOS",
      pull: pull(1216, headA, "base-a"),
      dryRun: false,
      useZCode: false,
      licenseAdmission: testLicenseAdmission,
      budget: new ReviewRunBudget(1)
    })).resolves.toBe("skipped_finishing_touch_draft");

    expect(store.getFinishingTouchDraft({
      repo: "electricsheephq/WorldOS",
      pullNumber: 1216,
      headSha: headA,
      commandCommentId: 9004
    })).toMatchObject({
      action: "explain_risk",
      status: "rejected",
      proposedOutput: {
        ok: false,
        reason: "dirty_worktree"
      }
    });
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
      overloadBackoffMaxDurationMs: 10 * 60_000,
      overloadBackoffJitterMs: 0,
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
        full_name: "electricsheephq/WorldOS",
        private: true
      }
    },
    html_url: `https://github.test/electricsheephq/WorldOS/pull/${number}`
  };
}
