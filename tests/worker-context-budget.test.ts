import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BotConfig } from "../src/config.js";
import type { GitHubApi } from "../src/github.js";
import { ReviewStateStore } from "../src/state.js";
import type { PullRequestSummary } from "../src/types.js";

const zcodePrompts = vi.hoisted((): string[] => []);

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

vi.mock("../src/zcode.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/zcode.js")>();
  return {
    ...actual,
    runZCodeReview: vi.fn((input: { prompt: string }) => {
      zcodePrompts.push(input.prompt);
      return {
        findings: [],
        droppedFromSchema: [],
        rawResponse: "{\"findings\":[]}",
        attempts: 1,
        degradedRecovery: false
      };
    })
  };
});

const { localDateFolder, reviewPull } = await import("../src/worker.js");
const { buildReviewPrompt } = await import("../src/zcode.js");

describe("worker context budget preflight", () => {
  const roots: string[] = [];

  afterEach(() => {
    zcodePrompts.length = 0;
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("skips oversized prompts before provider execution and records operator evidence", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-context-budget-skip-"));
    roots.push(root);
    const config = minimalConfig(root);
    config.contextBudget = {
      enabled: true,
      overflow: "skip",
      reservedOutputTokens: 100,
      charsPerToken: 1,
      providerFudgeFactor: 1,
      maxChunks: 4
    };
    config.providers!.providers["zcode-glm"]!.contextWindowTokens = 500;
    const state = new ReviewStateStore(config.statePath);
    const pull = pullSummary(401, "c".repeat(40));

    const result = await reviewPull({
      config,
      github: githubForPull(pull, [
        {
          filename: "src/large.ts",
          patch: [
            "@@ -1,1 +1,2 @@",
            "+const large = \"",
            "+".repeat(4_000),
            "\";"
          ].join("\n"),
          status: "modified",
          additions: 2,
          deletions: 0,
          changes: 2
        }
      ]),
      state,
      repo: "electricsheephq/WorldOS",
      pull,
      dryRun: false,
      useZCode: true
    });

    expect(result).toBe("skipped_context_budget");
    expect(zcodePrompts).toEqual([]);
    expect(state.getProcessedReview("electricsheephq/WorldOS", pull.number, pull.head.sha)).toMatchObject({
      status: "skipped",
      error: "context_budget_overflow"
    });
    const evidenceDir = join(
      root,
      "evidence",
      localDateFolder(),
      "electricsheephq__WorldOS",
      `pr-${pull.number}`,
      pull.head.sha
    );
    expect(existsSync(join(evidenceDir, "review-plan.json"))).toBe(false);
    const budgetEvidence = JSON.parse(readFileSync(join(evidenceDir, "context-budget.json"), "utf8"));
    expect(budgetEvidence).toMatchObject({
      mode: "skip",
      reason: "context_budget_overflow",
      contextWindowTokens: 500,
      budgetTokens: 400
    });
    state.close();
  });

  it("executes provider review once per deterministic context chunk", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-context-budget-chunk-"));
    roots.push(root);
    const config = minimalConfig(root);
    config.contextBudget = {
      enabled: true,
      overflow: "chunk",
      reservedOutputTokens: 50,
      charsPerToken: 1,
      providerFudgeFactor: 1,
      maxChunks: 5
    };
    const state = new ReviewStateStore(config.statePath);
    const pull = pullSummary(402, "d".repeat(40));
    const files = [
      pullFile("src/a.ts", 5_000),
      pullFile("src/b.ts", 5_000),
      pullFile("src/c.ts", 5_000)
    ];
    const singlePromptLengths = files.map((entry) => reviewPromptLength(config, pull, [entry]));
    const fullPromptLength = reviewPromptLength(config, pull, files);
    const largestSinglePromptLength = Math.max(...singlePromptLengths);
    config.providers!.providers["zcode-glm"]!.contextWindowTokens = largestSinglePromptLength + config.contextBudget.reservedOutputTokens + 2_000;

    expect(fullPromptLength).toBeGreaterThan(config.providers!.providers["zcode-glm"]!.contextWindowTokens);

    const result = await reviewPull({
      config,
      github: githubForPull(pull, files),
      state,
      repo: "electricsheephq/WorldOS",
      pull,
      dryRun: true,
      useZCode: true
    });

    expect(result).toBe("reviewed");
    expect(zcodePrompts).toHaveLength(3);
    for (const prompt of zcodePrompts) {
      expect(prompt.length).toBeLessThan(fullPromptLength);
    }
    const evidenceDir = join(
      root,
      "evidence",
      localDateFolder(),
      "electricsheephq__WorldOS",
      `pr-${pull.number}`,
      pull.head.sha
    );
    const budgetEvidence = JSON.parse(readFileSync(join(evidenceDir, "context-budget.json"), "utf8"));
    expect(budgetEvidence).toMatchObject({
      mode: "chunk",
      reason: "context_budget_overflow"
    });
    expect(budgetEvidence.chunks.map((chunk: { filenames: string[] }) => chunk.filenames)).toEqual([
      ["src/a.ts"],
      ["src/b.ts"],
      ["src/c.ts"]
    ]);
    expect(state.getProcessedReview("electricsheephq/WorldOS", pull.number, pull.head.sha)).toMatchObject({
      status: "dry_run"
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
    contextBudget: {
      enabled: true,
      overflow: "skip",
      reservedOutputTokens: 4096,
      charsPerToken: 4,
      providerFudgeFactor: 1.15,
      maxChunks: 8
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
      providerId: "zcode-glm",
      cliPath: "/unused/zcode.cjs",
      appConfigPath: "/unused/config.json",
      model: "GLM-5.2",
      timeoutMs: 1,
      maxPatchBytes: 80_000,
      retryMaxRetries: 0
    },
    providers: {
      defaultProviderId: "zcode-glm",
      providers: {
        "zcode-glm": {
          enabled: true,
          adapter: "zcode",
          displayName: "GLM/Z.ai through ZCode",
          model: "GLM-5.2",
          authMode: "zcode-app-config",
          contextWindowTokens: 128_000,
          timeoutMs: 180_000,
          retryMaxRetries: 0,
          capabilities: {
            review: true,
            jsonOutput: true,
            local: false,
            streaming: false
          }
        }
      }
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

function pullFile(filename: string, patchLength: number): {
  filename: string;
  patch: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
} {
  return {
    filename,
    patch: [
      "@@ -1,1 +1,2 @@",
      "+const value = \"",
      "x".repeat(patchLength),
      "\";"
    ].join("\n"),
    status: "modified",
    additions: 2,
    deletions: 0,
    changes: 2
  };
}

function reviewPromptLength(config: BotConfig, pull: PullRequestSummary, files: ReturnType<typeof pullFile>[]): number {
  return buildReviewPrompt({
    repo: "electricsheephq/WorldOS",
    pull,
    files,
    maxPatchBytes: config.zcode.maxPatchBytes
  }).length;
}

function githubForPull(pull: PullRequestSummary, files: Array<{
  filename: string;
  patch?: string;
  status?: string;
  additions?: number;
  deletions?: number;
  changes?: number;
}>): GitHubApi {
  return {
    getPull: async () => pull,
    listPullFiles: async () => files,
    canPostAsApp: () => false
  } as unknown as GitHubApi;
}
