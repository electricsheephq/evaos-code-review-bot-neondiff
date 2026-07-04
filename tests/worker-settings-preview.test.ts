import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BotConfig } from "../src/config.js";
import type { GitHubApi } from "../src/github.js";
import { ReviewStateStore } from "../src/state.js";
import type { PullRequestSummary } from "../src/types.js";

vi.mock("../src/git.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/git.js")>();
  return {
    ...actual,
    preparePullWorktree: vi.fn((input: { workRoot: string; expectedHeadSha: string }) => {
      const path = join(input.workRoot, "mock-worktree");
      mkdirSync(path, { recursive: true });
      return { path, headSha: input.expectedHeadSha };
    }),
    assertGitClean: vi.fn()
  };
});

const { localDateFolder, reviewPull } = await import("../src/worker.js");

describe("worker review settings preview evidence", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("writes review settings preview evidence and threads it into walkthrough output", async () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-worker-settings-preview-"));
    roots.push(root);
    const config = minimalConfig(root);
    const state = new ReviewStateStore(config.statePath);
    const pull = pullSummary(1410, "a".repeat(40));
    const secretLikeToken = "ghp_123456789012345678901234567890123456";
    const github = {
      getPull: async () => pull,
      listPullFiles: async () => [
        {
          filename: "src/walkthrough.ts",
          status: "modified",
          additions: 4,
          deletions: 1,
          changes: 5
        }
      ],
      canPostAsApp: () => false
    } as unknown as GitHubApi;

    const result = await reviewPull({
      config,
      github,
      state,
      repo: "electricsheephq/WorldOS",
      pull,
      dryRun: true,
      useZCode: false
    });

    expect(result).toBe("reviewed");
    const evidenceDir = join(
      root,
      "evidence",
      localDateFolder(),
      "electricsheephq__WorldOS",
      "pr-1410",
      pull.head.sha
    );
    const preview = JSON.parse(readFileSync(join(evidenceDir, "review-settings-preview.json"), "utf8"));
    const walkthrough = readFileSync(join(evidenceDir, "walkthrough.md"), "utf8");

    expect(preview.sections).toContainEqual({
      key: "reviewSummary",
      label: "Review summary",
      enabled: true,
      mode: "inline_review"
    });
    expect(walkthrough).toContain("### Review Settings Preview");
    expect(walkthrough).toContain("- Enabled sections: Review summary (inline_review); Walkthrough (inline_review)");
    expect(walkthrough).toContain("- Path instructions: `src/\\`templates\\`/**`");
    expect(walkthrough).not.toContain(secretLikeToken);
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
    providerCooldown: {
      enabled: false,
      durationMs: 15 * 60_000,
      requestRateLimitDurationMs: 90_000,
      overloadDurationMs: 2 * 60_000,
      quotaDurationMs: 30 * 60_000,
      overloadBackoffMaxDurationMs: 10 * 60_000,
      overloadBackoffJitterMs: 0,
      transientRetryAttempts: 1,
      transientRetryBaseDelayMs: 1,
      transientRetryMaxDelayMs: 1
    },
    walkthrough: {
      enabled: true,
      postIssueComment: false
    },
    commands: {
      enabled: false,
      botMentions: ["@evaos-code-review-bot"],
      trustedAuthors: [],
      acknowledge: false
    },
    repoProfiles: {
      repos: {
        "electricsheephq/WorldOS": {
          reviewProfile: "assertive",
          pathInstructions: {
            "src/`templates`/**": [`Do not quote ghp_123456789012345678901234567890123456 in public comments.`]
          },
          suggestedLabels: ["review-settings"],
          suggestedReviewers: ["maintainer-one"]
        }
      }
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
      sha: "b".repeat(40),
      ref: "main",
      repo: { full_name: "electricsheephq/WorldOS" }
    },
    html_url: `https://github.com/electricsheephq/WorldOS/pull/${number}`
  };
}
