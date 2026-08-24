import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BotConfig } from "../src/config.js";
import type { GitHubApi } from "../src/github.js";
import { ReviewStateStore } from "../src/state.js";
import type { Finding, PullRequestSummary } from "../src/types.js";
import { buildFindingFingerprint } from "../src/findings.js";
import { testLicenseAdmission } from "./helpers/license-admission.js";

const zcodePrompts = vi.hoisted((): string[] => []);
const zcodeCompletedPrompts = vi.hoisted((): string[] => []);
const zcodeFindingsByPath = vi.hoisted(() => new Map<string, Finding[]>());
const zcodeFailuresByPath = vi.hoisted(() => new Map<string, string>());
const zcodeDelaysByPath = vi.hoisted(() => new Map<string, number>());
const zcodeBarriersByPath = vi.hoisted(() => new Map<string, Promise<void>>());
const zcodeFirstFailuresByPath = vi.hoisted(() => new Map<string, { message: string; beforeThrow?: () => void }>());
const severeRawResponse = vi.hoisted(() => ({ value: "" }));
const severeCurrentWorktree = vi.hoisted(() => ({ enabled: false }));
const createdReviews = vi.hoisted((): Array<{
  repo: string;
  pullNumber: number;
  headSha: string;
  event: string;
  body: string;
  comments: Array<{ path: string; line: number; title: string }>;
}> => []);
const reviewPostControl = vi.hoisted((): {
  error?: Error;
  afterCreate?: () => void;
  afterAuxiliaryPost?: () => void;
} => ({}));
const evidenceWriteControl = vi.hoisted((): { failPostedReview?: boolean } => ({}));
const walkthroughBuildEvents = vi.hoisted((): string[] => []);

vi.mock("../src/git.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/git.js")>();
  return {
    ...actual,
    preparePullWorktree: vi.fn((input: { workRoot: string; expectedHeadSha: string }) => {
      const path = severeCurrentWorktree.enabled ? process.cwd() : join(input.workRoot, "mock-worktree");
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
    runZCodeReview: vi.fn(async (input: { prompt: string }) => {
      zcodePrompts.push(input.prompt);
      const delay = [...zcodeDelaysByPath.entries()].find(([path]) => input.prompt.includes(path));
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay[1]));
      const barrier = [...zcodeBarriersByPath.entries()].find(([path]) => input.prompt.includes(path));
      if (barrier) await barrier[1];
      const firstFailure = [...zcodeFirstFailuresByPath.entries()].find(([path]) => input.prompt.includes(path));
      if (firstFailure) {
        zcodeFirstFailuresByPath.delete(firstFailure[0]);
        firstFailure[1].beforeThrow?.();
        throw new Error(firstFailure[1].message);
      }
      const failure = [...zcodeFailuresByPath.entries()].find(([path]) => input.prompt.includes(path));
      if (failure) throw new Error(failure[1]);
      const findings = [...zcodeFindingsByPath.entries()]
        .filter(([path]) => input.prompt.includes(path))
        .flatMap(([, entries]) => entries);
      zcodeCompletedPrompts.push(input.prompt);
      return {
        findings,
        droppedFromSchema: [],
        rawResponse: JSON.stringify({ findings }),
        attempts: 1,
        degradedRecovery: false
      };
    }),
    runZCodeRawJson: vi.fn(async ({ prompt }: { prompt: string }) => (zcodePrompts.push(prompt), severeRawResponse.value))
  };
});

vi.mock("../src/github.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/github.js")>();
  return {
    ...actual,
    GitHubApi: class {
      canPostAsApp(): boolean {
        return true;
      }

      async upsertIssueComment(): Promise<{ action: "created"; html_url: string; id: number }> {
        reviewPostControl.afterAuxiliaryPost?.();
        return { action: "created", html_url: "https://github.test/comment/1", id: 1 };
      }

      async createReview(input: {
        repo: string;
        pullNumber: number;
        headSha: string;
        event: string;
        body: string;
        comments: Array<{ path: string; line: number; title: string }>;
      }): Promise<{ html_url: string; id: number }> {
        if (reviewPostControl.error) throw reviewPostControl.error;
        createdReviews.push(input);
        reviewPostControl.afterCreate?.();
        return {
          html_url: `https://github.com/${input.repo}/pull/${input.pullNumber}#pullrequestreview-${createdReviews.length}`,
          id: createdReviews.length
        };
      }
    }
  };
});

vi.mock("../src/temp-files.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/temp-files.js")>();
  return {
    ...actual,
    writeSecureFileSync: (path: string, contents: string) => {
      if (evidenceWriteControl.failPostedReview && path.endsWith("posted-review.json")) {
        throw new Error("injected posted-review evidence failure");
      }
      return actual.writeSecureFileSync(path, contents);
    }
  };
});

vi.mock("../src/walkthrough.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/walkthrough.js")>();
  return {
    ...actual,
    buildWalkthroughComment: vi.fn((input: Parameters<typeof actual.buildWalkthroughComment>[0]) => {
      walkthroughBuildEvents.push(input.event);
      return actual.buildWalkthroughComment(input);
    })
  };
});

const {
  localDateFolder,
  buildReviewApprovalRevision,
  prepareFailedHeadRetry,
  recoverPostedReviewReceipt,
  recoverPostedReviewReceiptForCurrentHead,
  reviewPull: reviewPullImpl,
  reviewWasAlreadyPosted
} = await import("../src/worker.js");
const reviewPull = (input: Parameters<typeof reviewPullImpl>[0]) => reviewPullImpl({
  ...input,
  pull: {
    ...input.pull,
    base: { ...input.pull.base, repo: { ...input.pull.base.repo, private: false, visibility: "public" } }
  },
  licenseAdmission: input.licenseAdmission ?? testLicenseAdmission
});
const { buildReviewPrompt } = await import("../src/zcode.js");

describe("worker context budget preflight", () => {
  const roots: string[] = [];

  afterEach(() => {
    zcodePrompts.length = 0;
    zcodeCompletedPrompts.length = 0;
    zcodeFindingsByPath.clear();
    zcodeFailuresByPath.clear();
    zcodeDelaysByPath.clear();
    zcodeBarriersByPath.clear();
    zcodeFirstFailuresByPath.clear();
    severeRawResponse.value = "";
    severeCurrentWorktree.enabled = false;
    createdReviews.length = 0;
    walkthroughBuildEvents.length = 0;
    delete reviewPostControl.error;
    delete reviewPostControl.afterCreate;
    delete reviewPostControl.afterAuxiliaryPost;
    delete evidenceWriteControl.failPostedReview;
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("completes a scoped dry run over an existing activation baseline", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-scoped-baseline-override-"));
    roots.push(root);
    const config = minimalConfig(root);
    const state = new ReviewStateStore(config.statePath);
    const pull = pullSummary(400, "b".repeat(40));
    state.recordProcessed({
      repo: "electricsheephq/WorldOS",
      pullNumber: pull.number,
      headSha: pull.head.sha,
      status: "skipped",
      error: "activation_baseline_existing_head"
    });

    const result = await reviewPull({
      config,
      github: githubForPull(pull, [pullFile("src/scoped.ts", 20)]),
      state,
      repo: "electricsheephq/WorldOS",
      pull,
      dryRun: true,
      useZCode: true,
      allowActivationBaselineCommandLookup: true
    });

    expect(result).toBe("reviewed");
    expect(zcodePrompts).toHaveLength(1);
    expect(createdReviews).toEqual([]);
    const recorded = state.getProcessedReview("electricsheephq/WorldOS", pull.number, pull.head.sha);
    expect(recorded).toMatchObject({ status: "dry_run" });
    expect(recorded?.error).toBeUndefined();
    state.close();
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
    config.zcode.providerId = "builtin:zai-coding-plan";
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
      status: "failed",
      error: "context_budget_overflow"
    });
    expect(prepareFailedHeadRetry({
      state,
      repo: "electricsheephq/WorldOS",
      pullNumber: pull.number,
      headSha: pull.head.sha,
      livePull: pull
    })).toMatchObject({
      previousStatus: "failed",
      previousError: "context_budget_overflow"
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

  it("preserves over-reserved input budget evidence when no provider input tokens are available", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-context-budget-no-input-"));
    roots.push(root);
    const config = minimalConfig(root);
    config.contextBudget = {
      enabled: true,
      overflow: "skip",
      reservedOutputTokens: 600,
      charsPerToken: 4,
      providerFudgeFactor: 1,
      maxChunks: 4
    };
    config.providers!.providers["zcode-glm"]!.contextWindowTokens = 500;
    const state = new ReviewStateStore(config.statePath);
    const pull = pullSummary(404, "g".repeat(40));

    const result = await reviewPull({
      config,
      github: githubForPull(pull, [pullFile("src/tiny.ts", 10)]),
      state,
      repo: "electricsheephq/WorldOS",
      pull,
      dryRun: false,
      useZCode: true
    });

    expect(result).toBe("skipped_context_budget");
    expect(zcodePrompts).toEqual([]);
    expect(state.getProcessedReview("electricsheephq/WorldOS", pull.number, pull.head.sha)).toMatchObject({
      status: "failed",
      error: "context_budget_no_available_input_tokens"
    });
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
      mode: "skip",
      reason: "context_budget_no_available_input_tokens",
      contextWindowTokens: 500,
      reservedOutputTokens: 600,
      budgetTokens: -100
    });
    state.close();
  });

  it("executes provider review once per deterministic context chunk and posts merged current-line comments", async () => {
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
    zcodeFindingsByPath.set("src/a.ts", [finding("src/a.ts", "Chunk A finding")]);
    zcodeFindingsByPath.set("src/b.ts", [finding("src/b.ts", "Chunk B finding")]);
    zcodeFindingsByPath.set("src/c.ts", [finding("src/a.ts", "Cross-chunk misplaced finding")]);
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
      dryRun: false,
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
    const reviewPlan = JSON.parse(readFileSync(join(evidenceDir, "review-plan.json"), "utf8"));
    expect(reviewPlan.comments.map((comment: { path: string; line: number; title: string }) => ({
      path: comment.path,
      line: comment.line,
      title: comment.title
    }))).toEqual([
      { path: "src/a.ts", line: 1, title: "Chunk A finding" },
      { path: "src/b.ts", line: 1, title: "Chunk B finding" }
    ]);
    expect(reviewPlan.dropped).toEqual([
      expect.objectContaining({
        reason: "chunk_path_mismatch",
        path: "src/a.ts",
        title: "Cross-chunk misplaced finding"
      })
    ]);
    expect(createdReviews).toHaveLength(1);
    expect(createdReviews[0]).toMatchObject({
      repo: "electricsheephq/WorldOS",
      pullNumber: pull.number,
      event: "COMMENT"
    });
    expect(createdReviews[0]?.comments.map((comment) => ({
      path: comment.path,
      line: comment.line,
      title: comment.title
    }))).toEqual([
      { path: "src/a.ts", line: 1, title: "Chunk A finding" },
      { path: "src/b.ts", line: 1, title: "Chunk B finding" }
    ]);
    expect(state.getProcessedReview("electricsheephq/WorldOS", pull.number, pull.head.sha)).toMatchObject({
      status: "posted",
      reviewUrl: `https://github.com/electricsheephq/WorldOS/pull/${pull.number}#pullrequestreview-1`
    });
    state.close();
  });

  it("accepts a dry-run when the lens fits the unsent full prompt but is omitted from every chunk", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-context-budget-chunk-risk-lens-"));
    roots.push(root);
    const config = minimalConfig(root);
    const reviewRiskLens = "Focus on lossless ordering and provenance; session and profile isolation. ".repeat(18);
    config.repoProfiles = { repos: { "electricsheephq/WorldOS": { reviewRiskLens } } };
    config.contextBudget = {
      enabled: true,
      overflow: "chunk",
      reservedOutputTokens: 50,
      charsPerToken: 1,
      providerFudgeFactor: 1,
      maxChunks: 5
    };
    const state = new ReviewStateStore(config.statePath);
    const pull = pullSummary(403, "e".repeat(40));
    const files = [pullFile("src/a.ts", 5_000), pullFile("src/b.ts", 5_000), pullFile("src/c.ts", 5_000)];
    zcodeFindingsByPath.set("src/a.ts", [finding("src/a.ts", "Focus on lossless ordering and provenance; session and")]);
    const largestSinglePromptLength = Math.max(...files.map((entry) => reviewPromptLength(config, pull, [entry])));
    config.providers!.providers["zcode-glm"]!.contextWindowTokens = largestSinglePromptLength + 2_050;

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
    expect(zcodePrompts.every((prompt) => !prompt.includes(reviewRiskLens.trim()))).toBe(true);
    expect(createdReviews).toEqual([]);
    state.close();
  });

  it("runs the enabled shadow ensemble without changing the canonical posted review", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-review-ensemble-shadow-"));
    roots.push(root);
    const config = minimalConfig(root);
    config.reviewEnsemble = { enabled: true, mode: "shadow" };
    const state = new ReviewStateStore(config.statePath);
    const pull = pullSummary(421, "9".repeat(40));
    const files = [pullFile("src/a.ts", 200)];
    zcodeFindingsByPath.set("src/a.ts", [finding("src/a.ts", "Anchor finding")]);
    zcodeFindingsByPath.set("State and lifecycle review", [finding("src/a.ts", "State-only finding")]);

    const result = await reviewPull({
      config,
      github: githubForPull(pull, files),
      state,
      repo: "electricsheephq/WorldOS",
      pull,
      dryRun: false,
      useZCode: true
    });

    expect(result).toBe("reviewed");
    expect(zcodePrompts).toHaveLength(4);
    expect(zcodePrompts.filter((prompt) => prompt.includes("State and lifecycle review"))).toHaveLength(1);
    expect(zcodePrompts.filter((prompt) => prompt.includes("Authority and integration-boundary review"))).toHaveLength(1);
    expect(zcodePrompts.filter((prompt) => prompt.includes("Failure, concurrency, and operator-truth review"))).toHaveLength(1);
    expect(createdReviews).toHaveLength(1);
    expect(createdReviews[0]?.comments.map((comment) => comment.title)).toEqual(["Anchor finding"]);
    expect(state.getProcessedReview("electricsheephq/WorldOS", pull.number, pull.head.sha)).toMatchObject({ status: "posted" });

    const ensembleDir = join(
      root,
      "evidence",
      localDateFolder(),
      "electricsheephq__WorldOS",
      `pr-${pull.number}`,
      pull.head.sha,
      "review-ensemble"
    );
    expect(JSON.parse(readFileSync(join(ensembleDir, "manifest.json"), "utf8"))).toMatchObject({
      complete: true,
      subject: { repo: "electricsheephq/WorldOS", pullNumber: pull.number, headSha: pull.head.sha }
    });
    expect(JSON.parse(readFileSync(join(ensembleDir, "shadow-packet.json"), "utf8"))).toMatchObject({
      complete: true,
      postingEligible: false,
      gate: { comments: expect.arrayContaining([expect.objectContaining({ title: "State-only finding" })]) }
    });
    state.close();
  });

  it("keeps a specialist failure out of canonical processed state", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-review-ensemble-partial-"));
    roots.push(root);
    const config = minimalConfig(root);
    config.reviewEnsemble = { enabled: true, mode: "shadow" };
    const state = new ReviewStateStore(config.statePath);
    const pull = pullSummary(423, "6".repeat(40));
    const files = [pullFile("src/a.ts", 200)];
    zcodeFindingsByPath.set("src/a.ts", [finding("src/a.ts", "Canonical finding")]);
    zcodeFailuresByPath.set("Failure, concurrency, and operator-truth review", "specialist provider failed");

    const result = await reviewPull({
      config,
      github: githubForPull(pull, files),
      state,
      repo: "electricsheephq/WorldOS",
      pull,
      dryRun: false,
      useZCode: true
    });

    expect(result).toBe("reviewed");
    expect(createdReviews).toHaveLength(1);
    expect(createdReviews[0]?.comments.map((comment) => comment.title)).toEqual(["Canonical finding"]);
    expect(state.getProcessedReview("electricsheephq/WorldOS", pull.number, pull.head.sha)).toMatchObject({ status: "posted" });
    const ensembleDir = join(
      root,
      "evidence",
      localDateFolder(),
      "electricsheephq__WorldOS",
      `pr-${pull.number}`,
      pull.head.sha,
      "review-ensemble"
    );
    expect(JSON.parse(readFileSync(join(ensembleDir, "manifest.json"), "utf8"))).toMatchObject({
      complete: false,
      leaves: expect.arrayContaining([
        expect.objectContaining({ id: "failure", status: "failed", error: "specialist provider failed" })
      ])
    });
    expect(JSON.parse(readFileSync(join(ensembleDir, "shadow-packet.json"), "utf8"))).toMatchObject({
      complete: false,
      postingEligible: false
    });
    state.close();
  });

  it("posts the canonical anchor before a slow specialist settles", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-review-ensemble-slow-shadow-"));
    roots.push(root);
    const config = minimalConfig(root);
    config.reviewEnsemble = { enabled: true, mode: "shadow" };
    const state = new ReviewStateStore(config.statePath);
    const pull = pullSummary(424, "5".repeat(40));
    const files = [pullFile("src/a.ts", 200)];
    zcodeFindingsByPath.set("src/a.ts", [finding("src/a.ts", "Canonical before shadow")]);
    let releaseSpecialist: (() => void) | undefined;
    zcodeBarriersByPath.set("State and lifecycle review", new Promise<void>((resolve) => {
      releaseSpecialist = resolve;
    }));
    reviewPostControl.afterCreate = () => {
      expect(zcodeCompletedPrompts.some((prompt) => prompt.includes("State and lifecycle review"))).toBe(false);
      releaseSpecialist?.();
    };

    const result = await reviewPull({
      config,
      github: githubForPull(pull, files),
      state,
      repo: "electricsheephq/WorldOS",
      pull,
      dryRun: false,
      useZCode: true
    });

    expect(result).toBe("reviewed");
    expect(createdReviews).toHaveLength(1);
    expect(zcodeCompletedPrompts.some((prompt) => prompt.includes("State and lifecycle review"))).toBe(true);
    state.close();
  });

  it("releases ordinary review capacity before direct-review status reconciliation", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-review-capacity-before-reconcile-"));
    roots.push(root);
    const config = minimalConfig(root);
    config.reviewStatusComment = { enabled: true };
    const state = new ReviewStateStore(config.statePath);
    const pull = pullSummary(425, "4".repeat(40));
    const files = [pullFile("src/a.ts", 200)];
    zcodeFindingsByPath.set("src/a.ts", [finding("src/a.ts", "Canonical finding")]);
    let reconciliationLease: ReturnType<ReviewStateStore["tryAcquireReviewRunLease"]>;
    const github = {
      getPull: async () => pull,
      listPullFiles: async () => files,
      canPostAsApp: () => true,
      createReview: async (input: typeof createdReviews[number]) => {
        createdReviews.push(input);
        return { html_url: `https://github.test/review/${createdReviews.length}`, id: createdReviews.length };
      },
      upsertIssueComment: async () => {
        reconciliationLease = state.tryAcquireReviewRunLease(1, 60_000);
        return { action: "created" as const, html_url: "https://github.test/comment/1", id: 1 };
      }
    } as unknown as GitHubApi;

    const result = await reviewPull({
      config,
      github,
      state,
      repo: "electricsheephq/WorldOS",
      pull,
      dryRun: false,
      useZCode: true
    });

    expect(result).toBe("reviewed");
    expect(reconciliationLease).toBeDefined();
    if (reconciliationLease) state.releaseReviewRunLease(reconciliationLease.leaseId);
    state.close();
  });

  it("finishes canonical self-consistency before starting advisory leaves", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-review-ensemble-self-consistency-priority-"));
    roots.push(root);
    const config = minimalConfig(root);
    config.reviewEnsemble = { enabled: true, mode: "shadow" };
    config.reviewGate = { maxInlineComments: 25, selfConsistency: { enabled: true } };
    severeCurrentWorktree.enabled = true;
    const state = new ReviewStateStore(config.statePath);
    const pull = pullSummary(426, execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim());
    const files = [pullFile("src/severe-verification-evidence.ts", 200)];
    zcodeFindingsByPath.set("src/severe-verification-evidence.ts", [p1Finding("src/severe-verification-evidence.ts", "Canonical blocking finding")]);

    const result = await reviewPull({
      config,
      github: githubForPull(pull, files),
      state,
      repo: "electricsheephq/WorldOS",
      pull,
      dryRun: false,
      useZCode: true
    });

    expect(result).toBe("reviewed");
    const selfConsistencyIndex = zcodePrompts.findIndex((prompt) => prompt.includes("severe-verifier-input-v1"));
    const firstShadowIndex = zcodePrompts.findIndex((prompt) => prompt.includes("State and lifecycle review"));
    expect(selfConsistencyIndex).toBeGreaterThan(0);
    expect(firstShadowIndex).toBeGreaterThan(selfConsistencyIndex);
    state.close();
  });

  it("binds severe verification to original finding fields after public normalization", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-severe-worker-original-finding-"));
    roots.push(root);
    const config = minimalConfig(root);
    severeCurrentWorktree.enabled = true;
    config.reviewGate = { maxInlineComments: 25, selfConsistency: { enabled: true } };
    const state = new ReviewStateStore(config.statePath);
    const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const pull = pullSummary(430, head);
    const file = pullFile("src/severe-verification-evidence.ts", 40);
    const original: Finding = { ...p1Finding(file.filename, "Proof gap with 95% confidence"), body: "The confidence is 95%; inspect this exact proof gap.", category: "proof_gap" };
    zcodeFindingsByPath.set(file.filename, [original]);
    const hunkHash = createHash("sha256").update(file.patch, "utf8").digest("hex");
    const fileBytes = readFileSync(join(process.cwd(), file.filename));
    const fileHash = createHash("sha256").update(fileBytes).digest("hex");
    severeRawResponse.value = JSON.stringify({
      schemaVersion: "severe-verifier-v1", repo: "electricsheephq/WorldOS", pullNumber: pull.number,
      baseSha: pull.base.sha, headSha: head, findingFingerprint: buildFindingFingerprint(original),
      state: "confirmed", disposition: "retain", confidence: 0.8,
      evidence: { changedHunk: { sha256: hunkHash, bytes: Buffer.byteLength(file.patch), complete: true },
        files: [{ path: file.filename, kind: "whole_file", sha256: fileHash, bytes: fileBytes.length, complete: true }], omitted: [], complete: true }
    });
    const result = await reviewPull({ config, github: githubForPull(pull, [file]), state, repo: "electricsheephq/WorldOS", pull, dryRun: false, useZCode: true });
    expect(result).toBe("reviewed");
    const transport = JSON.parse(JSON.parse(zcodePrompts.find((prompt) => prompt.includes("severe-verifier-input-v1"))!)[1].content);
    expect(transport.finding).toMatchObject({ category: "proof_gap", title: original.title, body: original.body });
    expect(createdReviews[0]?.comments).toHaveLength(1);
    state.close();
  });

  it("rechecks the approved provider revision before an ensemble retry", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-review-ensemble-provider-revision-"));
    roots.push(root);
    const config = minimalConfig(root);
    config.reviewEnsemble = { enabled: true, mode: "shadow" };
    const appConfigPath = join(root, "zcode-app.json");
    writeFileSync(appConfigPath, "{\"provider\":\"one\"}\n");
    config.zcode.appConfigPath = appConfigPath;
    const sourceConfigRevision = "f".repeat(64);
    const approvedRevision = buildReviewApprovalRevision({
      configRevision: sourceConfigRevision,
      useZCode: true,
      zcodeAppConfigPath: appConfigPath
    })!;
    const state = new ReviewStateStore(config.statePath);
    const pull = pullSummary(427, "3".repeat(40));
    const files = [pullFile("src/a.ts", 200)];
    zcodeFirstFailuresByPath.set("src/a.ts", {
      message: "provider temporarily overloaded",
      beforeThrow: () => writeFileSync(appConfigPath, "{\"provider\":\"two\"}\n")
    });

    await expect(reviewPull({
      config,
      github: githubForPull(pull, files),
      state,
      repo: "electricsheephq/WorldOS",
      pull,
      dryRun: false,
      useZCode: true,
      configRevision: approvedRevision,
      sourceConfigRevision
    })).rejects.toThrow("review-pr provider configuration changed; run a new dry review before posting");
    expect(createdReviews).toHaveLength(0);
    state.close();
  });
  it("keeps allowed receipt paths and passes the strict Codex receipt schema", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-severe-zcode-raw-")); roots.push(root);
    const script = join(root, "zcode.cjs"); writeFileSync(script, `process.stdout.write(${JSON.stringify(JSON.stringify({ response: JSON.stringify({ path: "src/person@example.com" }) }))});`);
    const app = join(root, "app.json"); writeFileSync(app, '{"provider":{"zcode-glm":{"enabled":true,"options":{"apiKey":"fixture","baseURL":"https://example.invalid"},"models":{"GLM-5.2":{}}}}}');
    const zcode = await vi.importActual<typeof import("../src/zcode.js")>("../src/zcode.js");
    expect(await zcode.runZCodeRawJson({ cwd: root, prompt: "", cliPath: script, appConfigPath: app, model: "GLM-5.2" })).toContain("src/person@example.com"); expect(readFileSync(join(process.cwd(), "src/worker.ts"), "utf8")).toContain("schema: SEVERE_VERIFICATION_RECEIPT_JSON_SCHEMA"); });

  it("writes a shadow packet when a chunked anchor aborts", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-review-ensemble-anchor-abort-"));
    roots.push(root);
    const config = minimalConfig(root);
    config.reviewEnsemble = { enabled: true, mode: "shadow" };
    config.contextBudget = {
      enabled: true,
      overflow: "chunk",
      reservedOutputTokens: 50,
      charsPerToken: 1,
      providerFudgeFactor: 1,
      maxChunks: 5
    };
    const state = new ReviewStateStore(config.statePath);
    const pull = pullSummary(428, "2".repeat(40));
    const files = [pullFile("src/a.ts", 5_000), pullFile("src/b.ts", 5_000)];
    const largestSinglePromptLength = Math.max(...files.map((entry) => reviewPromptLength(config, pull, [entry])));
    config.providers!.providers["zcode-glm"]!.contextWindowTokens = largestSinglePromptLength + config.contextBudget.reservedOutputTokens + 2_000;
    zcodeFailuresByPath.set("src/a.ts", "anchor provider failure");

    const result = await reviewPull({
      config,
      github: githubForPull(pull, files),
      state,
      repo: "electricsheephq/WorldOS",
      pull,
      dryRun: false,
      useZCode: true
    });

    expect(result).toBe("skipped_context_budget");
    const ensembleDir = join(
      root,
      "evidence",
      localDateFolder(),
      "electricsheephq__WorldOS",
      `pr-${pull.number}`,
      pull.head.sha,
      "review-ensemble"
    );
    expect(JSON.parse(readFileSync(join(ensembleDir, "shadow-packet.json"), "utf8"))).toMatchObject({
      complete: false,
      postingEligible: false
    });
    state.close();
  });

  it("defers retry admission until chunk-failure shadow evidence settles", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-review-ensemble-anchor-claim-"));
    roots.push(root);
    const config = minimalConfig(root);
    config.reviewEnsemble = { enabled: true, mode: "shadow" };
    config.reviewGate = { maxInlineComments: 25, selfConsistency: { enabled: true } };
    config.contextBudget = {
      enabled: true,
      overflow: "chunk",
      reservedOutputTokens: 50,
      charsPerToken: 1,
      providerFudgeFactor: 1,
      maxChunks: 5
    };
    const state = new ReviewStateStore(config.statePath);
    const pull = pullSummary(429, "1".repeat(40));
    const files = [pullFile("src/a.ts", 5_000), pullFile("src/b.ts", 5_000)];
    const largestSinglePromptLength = Math.max(...files.map((entry) => reviewPromptLength(config, pull, [entry])));
    config.providers!.providers["zcode-glm"]!.contextWindowTokens = largestSinglePromptLength + config.contextBudget.reservedOutputTokens + 2_000;
    zcodeFirstFailuresByPath.set("src/a.ts", { message: "anchor provider failure" });
    let releaseSpecialist: (() => void) | undefined;
    zcodeBarriersByPath.set("State and lifecycle review", new Promise<void>((resolve) => {
      releaseSpecialist = resolve;
    }));

    const review = reviewPull({
      config,
      github: githubForPull(pull, files),
      state,
      repo: "electricsheephq/WorldOS",
      pull,
      dryRun: false,
      useZCode: true
    });
    await vi.waitFor(() => {
      expect(zcodePrompts.some((prompt) => prompt.includes("State and lifecycle review"))).toBe(true);
    });

    expect(state.getProcessedReview("electricsheephq/WorldOS", pull.number, pull.head.sha)).toBeUndefined();
    expect(await reviewPull({
      config,
      github: githubForPull(pull, files),
      state,
      repo: "electricsheephq/WorldOS",
      pull,
      dryRun: false,
      useZCode: true,
      processedHeadPolicy: "retry_failed_head"
    })).toBe("skipped_processed");

    releaseSpecialist?.();
    expect(await review).toBe("skipped_context_budget");
    expect(state.getProcessedReview("electricsheephq/WorldOS", pull.number, pull.head.sha)).toMatchObject({
      status: "failed",
      error: expect.stringContaining("context_budget_chunk_provider_failure")
    });
    state.close();
  });

  it("applies every ensemble lens to every context chunk while retaining one canonical post", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-review-ensemble-chunk-"));
    roots.push(root);
    const config = minimalConfig(root);
    config.reviewEnsemble = { enabled: true, mode: "shadow" };
    config.contextBudget = {
      enabled: true,
      overflow: "chunk",
      reservedOutputTokens: 50,
      charsPerToken: 1,
      providerFudgeFactor: 1,
      maxChunks: 5
    };
    const state = new ReviewStateStore(config.statePath);
    const pull = pullSummary(422, "7".repeat(40));
    const files = [pullFile("src/a.ts", 5_000), pullFile("src/b.ts", 5_000)];
    zcodeFindingsByPath.set("src/a.ts", [finding("src/a.ts", "Chunk anchor finding")]);
    const largestSinglePromptLength = Math.max(...files.map((entry) => reviewPromptLength(config, pull, [entry])));
    config.providers!.providers["zcode-glm"]!.contextWindowTokens = largestSinglePromptLength + config.contextBudget.reservedOutputTokens + 2_000;

    const result = await reviewPull({
      config,
      github: githubForPull(pull, files),
      state,
      repo: "electricsheephq/WorldOS",
      pull,
      dryRun: false,
      useZCode: true
    });

    expect(result).toBe("reviewed");
    expect(zcodePrompts).toHaveLength(8);
    expect(zcodePrompts.filter((prompt) => prompt.includes("State and lifecycle review"))).toHaveLength(2);
    expect(zcodePrompts.filter((prompt) => prompt.includes("Authority and integration-boundary review"))).toHaveLength(2);
    expect(zcodePrompts.filter((prompt) => prompt.includes("Failure, concurrency, and operator-truth review"))).toHaveLength(2);
    expect(createdReviews).toHaveLength(1);
    expect(createdReviews[0]?.comments.map((comment) => comment.title)).toEqual(["Chunk anchor finding"]);
    expect(state.getProcessedReview("electricsheephq/WorldOS", pull.number, pull.head.sha)).toMatchObject({ status: "posted" });
    state.close();
  });

  it("records dry-run evidence after successful chunked execution without posting", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-context-budget-chunk-dry-run-"));
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
    const pull = pullSummary(406, "j".repeat(40));
    const files = [
      pullFile("src/a.ts", 5_000),
      pullFile("src/b.ts", 5_000)
    ];
    zcodeFindingsByPath.set("src/a.ts", [finding("src/a.ts", "Dry-run chunk A finding")]);
    const largestSinglePromptLength = Math.max(...files.map((entry) => reviewPromptLength(config, pull, [entry])));
    config.providers!.providers["zcode-glm"]!.contextWindowTokens = largestSinglePromptLength + config.contextBudget.reservedOutputTokens + 2_000;

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
    expect(zcodePrompts).toHaveLength(2);
    expect(createdReviews).toEqual([]);
    expect(state.getProcessedReview("electricsheephq/WorldOS", pull.number, pull.head.sha)).toMatchObject({
      status: "dry_run"
    });
    const evidenceDir = join(root, "evidence", localDateFolder(), "electricsheephq__WorldOS", `pr-${pull.number}`, pull.head.sha);
    const reviewPlan = JSON.parse(readFileSync(join(evidenceDir, "review-plan.json"), "utf8"));
    expect(reviewPlan.comments).toHaveLength(1);
    state.close();
  });

  it("permits one exact live review to supersede its matching dry-run row", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-context-budget-dry-to-live-"));
    roots.push(root);
    const config = minimalConfig(root);
    const state = new ReviewStateStore(config.statePath);
    const pull = pullSummary(416, "f".repeat(40));
    const files = [pullFile("src/a.ts", 200)];
    const configRevision = "a".repeat(64);
    zcodeFindingsByPath.set("src/a.ts", [finding("src/a.ts", "Approved dry-to-live finding")]);
    const github = githubForPull(pull, files);

    const dryResult = await reviewPull({
      config,
      github,
      state,
      repo: "electricsheephq/WorldOS",
      pull,
      dryRun: true,
      useZCode: true,
      configRevision
    });
    await expect(reviewPull({
      config,
      github,
      state,
      repo: "electricsheephq/WorldOS",
      pull,
      dryRun: false,
      useZCode: true,
      processedHeadPolicy: "approved_dry_run"
    })).rejects.toThrow(
      "approved dry-run transition requires an exact configuration revision"
    );
    expect(createdReviews).toHaveLength(0);
    const liveResult = await reviewPull({
      config,
      github,
      state,
      repo: "electricsheephq/WorldOS",
      pull,
      dryRun: false,
      useZCode: true,
      configRevision,
      processedHeadPolicy: "approved_dry_run"
    });

    expect(dryResult).toBe("reviewed");
    expect(liveResult).toBe("reviewed");
    expect(createdReviews).toHaveLength(1);
    expect(state.getProcessedReview("electricsheephq/WorldOS", pull.number, pull.head.sha)).toMatchObject({
      status: "posted"
    });
    state.close();
  });

  it("refuses an approved live review when no matching dry-run receipt exists", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-approved-live-without-dry-run-"));
    roots.push(root);
    const config = minimalConfig(root);
    const state = new ReviewStateStore(config.statePath);
    const pull = pullSummary(420, "8".repeat(40));
    const configRevision = "b".repeat(64);

    expect(await reviewPull({
      config,
      github: githubForPull(pull, [pullFile("src/a.ts", 200)]),
      state,
      repo: "electricsheephq/WorldOS",
      pull,
      dryRun: false,
      useZCode: true,
      configRevision,
      processedHeadPolicy: "approved_dry_run"
    })).toBe("skipped_processed");
    expect(state.getProcessedReview(
      "electricsheephq/WorldOS",
      pull.number,
      pull.head.sha
    )).toBeUndefined();
    expect(createdReviews).toHaveLength(0);
    state.close();
  });

  it("does not let a daemon dry-run overwrite an already posted head", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-daemon-dry-posted-head-"));
    roots.push(root);
    const config = minimalConfig(root);
    const state = new ReviewStateStore(config.statePath);
    const pull = pullSummary(418, "d".repeat(40));
    const github = githubForPull(pull, [pullFile("src/a.ts", 200)]);
    state.recordProcessed({
      repo: "electricsheephq/WorldOS",
      pullNumber: pull.number,
      headSha: pull.head.sha,
      status: "posted",
      event: "COMMENT",
      reviewUrl: "https://github.com/electricsheephq/WorldOS/pull/418#pullrequestreview-1"
    });

    expect(await reviewPull({
      config,
      github,
      state,
      repo: "electricsheephq/WorldOS",
      pull,
      dryRun: true,
      useZCode: true
    })).toBe("skipped_processed");
    expect(state.getProcessedReview(
      "electricsheephq/WorldOS",
      pull.number,
      pull.head.sha
    )).toMatchObject({
      status: "posted",
      reviewUrl: "https://github.com/electricsheephq/WorldOS/pull/418#pullrequestreview-1"
    });
    expect(createdReviews).toHaveLength(0);
    state.close();
  });

  it("marks a post-success receipt persistence failure as already posted", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-post-receipt-failure-"));
    roots.push(root);
    const config = minimalConfig(root);
    const state = new ReviewStateStore(config.statePath);
    const pull = pullSummary(417, "e".repeat(40));
    const files = [pullFile("src/a.ts", 200)];
    const configRevision = "c".repeat(64);
    zcodeFindingsByPath.set("src/a.ts", [finding("src/a.ts", "Posted before receipt failure")]);
    const github = githubForPull(pull, files);

    await reviewPull({
      config,
      github,
      state,
      repo: "electricsheephq/WorldOS",
      pull,
      dryRun: true,
      useZCode: true,
      configRevision
    });
    const persistence = vi.spyOn(state, "recordProcessed")
      .mockImplementationOnce(() => {
        throw new Error("state receipt unavailable");
      });

    let caught: unknown;
    try {
      await reviewPull({
        config,
        github,
        state,
        repo: "electricsheephq/WorldOS",
        pull,
        dryRun: false,
        useZCode: true,
        configRevision,
        processedHeadPolicy: "approved_dry_run"
      });
    } catch (error) {
      caught = error;
    }

    expect(createdReviews).toHaveLength(1);
    expect(reviewWasAlreadyPosted(caught)).toBe(true);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain(
      "review posted but its durable receipt could not be recorded"
    );
    expect(state.getProcessedReview(
      "electricsheephq/WorldOS",
      pull.number,
      pull.head.sha
    )).toMatchObject({
      status: "skipped",
      configRevision,
      error: "approved_dry_run_consumed_for_live_post"
    });
    expect(await reviewPull({
      config,
      github,
      state,
      repo: "electricsheephq/WorldOS",
      pull,
      dryRun: false,
      useZCode: true,
      configRevision,
      processedHeadPolicy: "approved_dry_run"
    })).toBe("skipped_processed");
    expect(createdReviews).toHaveLength(1);
    persistence.mockRestore();
    expect(recoverPostedReviewReceipt({
      state,
      repo: "electricsheephq/WorldOS",
      pull,
      error: caught
    })).toBe(true);
    expect(state.getProcessedReview(
      "electricsheephq/WorldOS",
      pull.number,
      pull.head.sha
    )).toMatchObject({
      status: "posted",
      event: "COMMENT",
      reviewUrl: "https://github.com/electricsheephq/WorldOS/pull/417#pullrequestreview-1"
    });
    state.close();
  });

  it("withholds current-head success when a recovered review receipt belongs to a stale head", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-recovered-receipt-stale-head-"));
    roots.push(root);
    const config = minimalConfig(root);
    const state = new ReviewStateStore(config.statePath);
    const pull = pullSummary(419, "a".repeat(40));
    const error = Object.assign(new Error("receipt persistence failed"), {
      reviewAlreadyPosted: true,
      receipt: {
        event: "COMMENT" as const,
        reviewUrl: "https://github.com/electricsheephq/WorldOS/pull/419#pullrequestreview-1",
        preserveExistingBlocking: false
      }
    });

    const result = await recoverPostedReviewReceiptForCurrentHead({
      config,
      github: {
        getPull: async () => pullSummary(419, "b".repeat(40))
      },
      state,
      repo: "electricsheephq/WorldOS",
      pull,
      error
    });

    expect(result).toBe("posted_stale_head");
    expect(state.getProcessedReview(
      "electricsheephq/WorldOS",
      pull.number,
      pull.head.sha
    )).toMatchObject({
      status: "posted",
      event: "COMMENT",
      reviewUrl: "https://github.com/electricsheephq/WorldOS/pull/419#pullrequestreview-1",
      error: "review_posted_head_changed"
    });
    state.close();
  });

  it("fails closed without throwing when posted-review receipt recovery cannot persist", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-recovered-receipt-persistence-failed-"));
    roots.push(root);
    const config = minimalConfig(root);
    const state = new ReviewStateStore(config.statePath);
    const pull = pullSummary(420, "d".repeat(40));
    mkdirSync(join(
      root,
      "evidence",
      localDateFolder(),
      "electricsheephq__WorldOS",
      `pr-${pull.number}`,
      pull.head.sha
    ), { recursive: true });
    const error = Object.assign(new Error("receipt persistence failed"), {
      reviewAlreadyPosted: true,
      receipt: {
        event: "COMMENT" as const,
        reviewUrl: "https://github.com/electricsheephq/WorldOS/pull/420#pullrequestreview-1",
        preserveExistingBlocking: false
      }
    });
    const getPull = vi.fn(async () => pullSummary(420, pull.head.sha));
    const persistence = vi.spyOn(state, "recordProcessed").mockImplementation(() => {
      throw new Error("state write still unavailable");
    });

    await expect(recoverPostedReviewReceiptForCurrentHead({
      config,
      github: { getPull },
      state,
      repo: "electricsheephq/WorldOS",
      pull,
      error
    })).resolves.toBe("posted_head_unverified");
    expect(getPull).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(join(
      root,
      "evidence",
      localDateFolder(),
      "electricsheephq__WorldOS",
      `pr-${pull.number}`,
      pull.head.sha,
      "post-receipt-recovery-persistence-failed.json"
    ), "utf8"))).toMatchObject({
      reason: "post_receipt_recovery_persistence_failed",
      repo: "electricsheephq/WorldOS",
      pullNumber: 420,
      expectedHeadSha: pull.head.sha,
      reviewUrl: "https://github.com/electricsheephq/WorldOS/pull/420#pullrequestreview-1",
      error: "state write still unavailable"
    });
    persistence.mockRestore();
    state.close();
  });

  it("withholds current-head success when recovered receipt head verification is unavailable", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-recovered-receipt-unverified-head-"));
    roots.push(root);
    const config = minimalConfig(root);
    const state = new ReviewStateStore(config.statePath);
    const pull = pullSummary(420, "c".repeat(40));
    const lookupSecret = ["ghp", "recovery", "lookup", "secret"].join("_");
    mkdirSync(join(
      root,
      "evidence",
      localDateFolder(),
      "electricsheephq__WorldOS",
      `pr-${pull.number}`,
      pull.head.sha
    ), { recursive: true });
    const error = Object.assign(new Error("receipt persistence failed"), {
      reviewAlreadyPosted: true,
      receipt: {
        event: "COMMENT" as const,
        reviewUrl: "https://github.com/electricsheephq/WorldOS/pull/420#pullrequestreview-1",
        preserveExistingBlocking: false
      }
    });

    const result = await recoverPostedReviewReceiptForCurrentHead({
      config,
      github: {
        getPull: async () => { throw new Error(`lookup failed ${lookupSecret}`); }
      },
      state,
      repo: "electricsheephq/WorldOS",
      pull,
      error
    });

    expect(result).toBe("posted_head_unverified");
    expect(state.getProcessedReview(
      "electricsheephq/WorldOS",
      pull.number,
      pull.head.sha
    )).toMatchObject({
      status: "posted",
      error: "post_review_head_unverified"
    });
    const incident = JSON.parse(readFileSync(join(
      root,
      "evidence",
      localDateFolder(),
      "electricsheephq__WorldOS",
      `pr-${pull.number}`,
      pull.head.sha,
      "post-receipt-recovery-head-lookup-failed.json"
    ), "utf8"));
    expect(JSON.stringify(incident)).not.toContain(lookupSecret);
    state.close();
  });

  it("permits a fresh dry proof after a consumed live approval fails before posting", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-consumed-live-failed-before-post-"));
    roots.push(root);
    const config = minimalConfig(root);
    const state = new ReviewStateStore(config.statePath);
    const pull = pullSummary(421, "7".repeat(40));
    const files = [pullFile("src/a.ts", 200)];
    const configRevision = "d".repeat(64);
    zcodeFindingsByPath.set("src/a.ts", [finding("src/a.ts", "Fresh approval after failed live post")]);
    state.recordProcessed({
      repo: "electricsheephq/WorldOS",
      pullNumber: pull.number,
      headSha: pull.head.sha,
      status: "skipped",
      configRevision,
      event: "COMMENT",
      error: "approved_dry_run_consumed_for_live_post; post_error=provider transport failed before posting"
    });

    expect(await reviewPull({
      config,
      github: githubForPull(pull, files),
      state,
      repo: "electricsheephq/WorldOS",
      pull,
      dryRun: true,
      useZCode: true,
      configRevision
    })).toBe("reviewed");
    expect(createdReviews).toHaveLength(0);
    expect(state.getProcessedReview(
      "electricsheephq/WorldOS",
      pull.number,
      pull.head.sha
    )).toMatchObject({
      status: "dry_run",
      configRevision
    });
    state.close();
  });

  it("does not replace an uncertain post-success receipt with a fresh dry proof", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-consumed-live-post-uncertain-"));
    roots.push(root);
    const config = minimalConfig(root);
    const state = new ReviewStateStore(config.statePath);
    const pull = pullSummary(422, "6".repeat(40));
    const configRevision = "e".repeat(64);
    state.recordProcessed({
      repo: "electricsheephq/WorldOS",
      pullNumber: pull.number,
      headSha: pull.head.sha,
      status: "skipped",
      configRevision,
      event: "COMMENT",
      error: "approved_dry_run_consumed_for_live_post"
    });

    expect(await reviewPull({
      config,
      github: githubForPull(pull, [pullFile("src/a.ts", 200)]),
      state,
      repo: "electricsheephq/WorldOS",
      pull,
      dryRun: true,
      useZCode: true,
      configRevision
    })).toBe("skipped_processed");
    expect(createdReviews).toHaveLength(0);
    expect(state.getProcessedReview(
      "electricsheephq/WorldOS",
      pull.number,
      pull.head.sha
    )).toMatchObject({
      status: "skipped",
      error: "approved_dry_run_consumed_for_live_post"
    });
    state.close();
  });

  it("preserves an approved dry-run receipt while the repository provider cooldown is active", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-approved-dry-run-active-cooldown-"));
    roots.push(root);
    const config = minimalConfig(root);
    config.providerCooldown.enabled = true;
    const state = new ReviewStateStore(config.statePath);
    const pull = pullSummary(419, "9".repeat(40));
    const configRevision = "a".repeat(64);
    state.recordProcessed({
      repo: "electricsheephq/WorldOS",
      pullNumber: pull.number,
      headSha: pull.head.sha,
      status: "dry_run",
      configRevision
    });
    state.recordRepoProviderCooldown({
      repo: "electricsheephq/WorldOS",
      cooldownUntil: new Date("2999-01-01T00:00:00.000Z"),
      reason: "provider_request_rate_limit"
    });

    expect(await reviewPull({
      config,
      github: githubForPull(pull, [pullFile("src/a.ts", 200)]),
      state,
      repo: "electricsheephq/WorldOS",
      pull,
      dryRun: false,
      useZCode: true,
      configRevision,
      processedHeadPolicy: "approved_dry_run"
    })).toBe("skipped_provider_cooldown");
    expect(state.getProcessedReview(
      "electricsheephq/WorldOS",
      pull.number,
      pull.head.sha
    )).toMatchObject({
      status: "dry_run",
      configRevision
    });
    expect(createdReviews).toHaveLength(0);
    state.close();
  });

  it("preserves a retryable consumed approval while a replacement dry run is provider-cooled", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-retryable-approval-active-cooldown-"));
    roots.push(root);
    const config = minimalConfig(root);
    config.providerCooldown.enabled = true;
    const state = new ReviewStateStore(config.statePath);
    const pull = pullSummary(424, "6".repeat(40));
    const configRevision = "c".repeat(64);
    const retryableError = "approved_dry_run_consumed_for_live_post; post_error=provider transport failed before posting";
    state.recordProcessed({
      repo: "electricsheephq/WorldOS",
      pullNumber: pull.number,
      headSha: pull.head.sha,
      status: "skipped",
      configRevision,
      error: retryableError
    });
    state.recordRepoProviderCooldown({
      repo: "electricsheephq/WorldOS",
      cooldownUntil: new Date("2999-01-01T00:00:00.000Z"),
      reason: "provider_request_rate_limit"
    });

    expect(await reviewPull({
      config,
      github: githubForPull(pull, [pullFile("src/a.ts", 200)]),
      state,
      repo: "electricsheephq/WorldOS",
      pull,
      dryRun: true,
      useZCode: true,
      configRevision,
      processedHeadPolicy: "refresh_dry_run"
    })).toBe("skipped_provider_cooldown");
    expect(state.getProcessedReview(
      "electricsheephq/WorldOS",
      pull.number,
      pull.head.sha
    )).toMatchObject({
      status: "skipped",
      configRevision,
      error: retryableError
    });
    expect(createdReviews).toHaveLength(0);
    state.close();
  });

  it("deduplicates ordinary daemon dry runs for an unchanged processed head", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-daemon-dry-run-dedup-"));
    roots.push(root);
    const config = minimalConfig(root);
    const state = new ReviewStateStore(config.statePath);
    const pull = pullSummary(425, "7".repeat(40));
    state.recordProcessed({
      repo: "electricsheephq/WorldOS",
      pullNumber: pull.number,
      headSha: pull.head.sha,
      status: "dry_run"
    });

    expect(await reviewPull({
      config,
      github: githubForPull(pull, [pullFile("src/a.ts", 200)]),
      state,
      repo: "electricsheephq/WorldOS",
      pull,
      dryRun: true,
      useZCode: true
    })).toBe("skipped_processed");
    expect(zcodePrompts).toHaveLength(0);
    expect(createdReviews).toHaveLength(0);
    state.close();
  });

  it("admits a fresh dry proof after a pre-claim live failure leaves the prior dry receipt", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-refresh-approved-dry-run-"));
    roots.push(root);
    const config = minimalConfig(root);
    const state = new ReviewStateStore(config.statePath);
    const pull = pullSummary(423, "5".repeat(40));
    const oldRevision = "a".repeat(64);
    const newRevision = "b".repeat(64);
    state.recordProcessed({
      repo: "electricsheephq/WorldOS",
      pullNumber: pull.number,
      headSha: pull.head.sha,
      status: "dry_run",
      configRevision: oldRevision
    });

    expect(await reviewPull({
      config,
      github: githubForPull(pull, [pullFile("src/a.ts", 200)]),
      state,
      repo: "electricsheephq/WorldOS",
      pull,
      dryRun: true,
      useZCode: true,
      configRevision: newRevision,
      processedHeadPolicy: "refresh_dry_run"
    })).toBe("reviewed");
    expect(createdReviews).toHaveLength(0);
    expect(state.getProcessedReview(
      "electricsheephq/WorldOS",
      pull.number,
      pull.head.sha
    )).toMatchObject({
      status: "dry_run",
      configRevision: newRevision
    });
    state.close();
  });

  it("uses the single-prompt path when overflow chunk is configured but the prompt fits", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-context-budget-within-chunk-config-"));
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
    const pull = pullSummary(407, "k".repeat(40));
    const files = [pullFile("src/a.ts", 200)];
    zcodeFindingsByPath.set("src/a.ts", [finding("src/a.ts", "Within-budget finding")]);
    const fullPromptLength = reviewPromptLength(config, pull, files);
    config.providers!.providers["zcode-glm"]!.contextWindowTokens = fullPromptLength + config.contextBudget.reservedOutputTokens + 2_000;

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
    expect(zcodePrompts).toHaveLength(1);
    expect(zcodePrompts[0]).toContain("src/a.ts");
    expect(createdReviews).toEqual([]);
    expect(state.getProcessedReview("electricsheephq/WorldOS", pull.number, pull.head.sha)).toMatchObject({
      status: "dry_run"
    });
    const evidenceDir = join(root, "evidence", localDateFolder(), "electricsheephq__WorldOS", `pr-${pull.number}`, pull.head.sha);
    const budgetEvidence = JSON.parse(readFileSync(join(evidenceDir, "context-budget.json"), "utf8"));
    expect(budgetEvidence).toMatchObject({
      mode: "within_budget",
      reason: "context_budget_within_budget"
    });
    expect(existsSync(join(evidenceDir, "context-chunks"))).toBe(false);
    state.close();
  });

  it("records failed processed evidence when chunk mode exceeds maxChunks", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-context-budget-max-chunks-"));
    roots.push(root);
    const config = minimalConfig(root);
    config.contextBudget = {
      enabled: true,
      overflow: "chunk",
      reservedOutputTokens: 50,
      charsPerToken: 1,
      providerFudgeFactor: 1,
      maxChunks: 1
    };
    const state = new ReviewStateStore(config.statePath);
    const pull = pullSummary(408, "l".repeat(40));
    const files = [
      pullFile("src/a.ts", 5_000),
      pullFile("src/b.ts", 5_000)
    ];
    const largestSinglePromptLength = Math.max(...files.map((entry) => reviewPromptLength(config, pull, [entry])));
    config.providers!.providers["zcode-glm"]!.contextWindowTokens = largestSinglePromptLength + config.contextBudget.reservedOutputTokens + 2_000;

    const result = await reviewPull({
      config,
      github: githubForPull(pull, files),
      state,
      repo: "electricsheephq/WorldOS",
      pull,
      dryRun: false,
      useZCode: true
    });

    expect(result).toBe("skipped_context_budget");
    expect(zcodePrompts).toEqual([]);
    expect(state.getProcessedReview("electricsheephq/WorldOS", pull.number, pull.head.sha)).toMatchObject({
      status: "failed",
      error: "context_budget_chunk_count_exceeded"
    });
    const evidenceDir = join(root, "evidence", localDateFolder(), "electricsheephq__WorldOS", `pr-${pull.number}`, pull.head.sha);
    const budgetEvidence = JSON.parse(readFileSync(join(evidenceDir, "context-budget.json"), "utf8"));
    expect(budgetEvidence).toMatchObject({
      mode: "skip",
      reason: "context_budget_chunk_count_exceeded"
    });
    state.close();
  });

  it("stops chunk execution if the PR head advances between chunks", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-context-budget-stale-chunk-"));
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
    const pull = pullSummary(403, "e".repeat(40));
    const stalePull = pullSummary(403, "f".repeat(40));
    const files = [
      pullFile("src/a.ts", 5_000),
      pullFile("src/b.ts", 5_000),
      pullFile("src/c.ts", 5_000)
    ];
    const largestSinglePromptLength = Math.max(...files.map((entry) => reviewPromptLength(config, pull, [entry])));
    config.providers!.providers["zcode-glm"]!.contextWindowTokens = largestSinglePromptLength + config.contextBudget.reservedOutputTokens + 2_000;

    const result = await reviewPull({
      config,
      github: {
        ...githubForPull(pull, files),
        getPull: async () => stalePull
      } as unknown as GitHubApi,
      state,
      repo: "electricsheephq/WorldOS",
      pull,
      dryRun: true,
      useZCode: true
    });

    expect(result).toBe("skipped_stale_head");
    expect(zcodePrompts).toHaveLength(0);
    expect(state.getProcessedReview("electricsheephq/WorldOS", pull.number, pull.head.sha)).toMatchObject({
      status: "skipped"
    });
    state.close();
  });

  it("records a retryable failed row when a later context chunk provider call fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-context-budget-chunk-failure-"));
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
    const pull = pullSummary(405, "i".repeat(40));
    const files = [
      pullFile("src/a.ts", 5_000),
      pullFile("src/b.ts", 5_000),
      pullFile("src/c.ts", 5_000)
    ];
    const largestSinglePromptLength = Math.max(...files.map((entry) => reviewPromptLength(config, pull, [entry])));
    config.providers!.providers["zcode-glm"]!.contextWindowTokens = largestSinglePromptLength + config.contextBudget.reservedOutputTokens + 2_000;
    const fakeSecret = ["sk-live", "secret-secret"].join("-");
    zcodeFailuresByPath.set("src/b.ts", `provider chunk failure for ${fakeSecret}`);

    const result = await reviewPull({
      config,
      github: githubForPull(pull, files),
      state,
      repo: "electricsheephq/WorldOS",
      pull,
      dryRun: false,
      useZCode: true
    });

    expect(result).toBe("skipped_context_budget");
    expect(zcodePrompts).toHaveLength(2);
    expect(createdReviews).toEqual([]);
    expect(state.getProcessedReview("electricsheephq/WorldOS", pull.number, pull.head.sha)).toMatchObject({
      status: "failed",
      error: expect.stringContaining("context_budget_chunk_provider_failure chunk=2")
    });
    expect(state.getProcessedReview("electricsheephq/WorldOS", pull.number, pull.head.sha)?.error).not.toContain(fakeSecret);
    expect(prepareFailedHeadRetry({
      state,
      repo: "electricsheephq/WorldOS",
      pullNumber: pull.number,
      headSha: pull.head.sha,
      livePull: pull
    })).toMatchObject({
      previousStatus: "failed",
      previousError: expect.stringContaining("context_budget_chunk_provider_failure chunk=2")
    });
    const evidenceDir = join(
      root,
      "evidence",
      localDateFolder(),
      "electricsheephq__WorldOS",
      `pr-${pull.number}`,
      pull.head.sha
    );
    const chunkError = JSON.parse(readFileSync(join(evidenceDir, "context-chunks", "chunk-002", "review-error.json"), "utf8"));
    expect(chunkError.error).toContain("context_budget_chunk_provider_failure chunk=2");
    expect(chunkError.error).not.toContain(fakeSecret);
    expect(existsSync(join(evidenceDir, "review-error.json"))).toBe(false);
    state.close();
  });

  it("lets a validated failed-head retry acquire the post claim and replace the failure", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-failed-head-live-retry-"));
    roots.push(root);
    const config = minimalConfig(root);
    const state = new ReviewStateStore(config.statePath);
    const pull = pullSummary(406, "f".repeat(40));
    const file = pullFile("src/retry.ts", 200);
    zcodeFindingsByPath.set(file.filename, [finding(file.filename, "Recovered retry finding")]);
    state.recordProcessed({
      repo: "electricsheephq/WorldOS",
      pullNumber: pull.number,
      headSha: pull.head.sha,
      status: "failed",
      error: "transient provider failure"
    });

    const result = await reviewPull({
      config,
      github: githubForPull(pull, [file]),
      state,
      repo: "electricsheephq/WorldOS",
      pull,
      dryRun: false,
      useZCode: true,
      processedHeadPolicy: "retry_failed_head"
    });

    expect(result).toBe("reviewed");
    expect(createdReviews).toHaveLength(1);
    expect(createdReviews[0]).toMatchObject({
      repo: "electricsheephq/WorldOS",
      pullNumber: pull.number,
      headSha: pull.head.sha,
      event: "COMMENT"
    });
    expect(state.getProcessedReview("electricsheephq/WorldOS", pull.number, pull.head.sha)).toMatchObject({
      status: "posted",
      event: "COMMENT",
      reviewUrl: `https://github.com/electricsheephq/WorldOS/pull/${pull.number}#pullrequestreview-1`
    });
    state.close();
  });

  it("downgrades an unauthorized P1 candidate to COMMENT without dropping inline findings", async () => {
    const scenario = await runOwnerPolicyReview({ roots, pullNumber: 501, enableWalkthrough: true });

    expect(scenario.result).toBe("reviewed");
    expect(createdReviews).toHaveLength(1);
    expect(createdReviews[0]).toMatchObject({
      headSha: scenario.pull.head.sha,
      event: "COMMENT",
      comments: [expect.objectContaining({ severity: "P1" })]
    });
    expect(scenario.state.getProcessedReview("electricsheephq/WorldOS", 501, scenario.pull.head.sha)).toMatchObject({
      status: "posted",
      event: "COMMENT"
    });
    expect(readDecision(scenario.evidenceDir)).toEqual({
      candidateEvent: "REQUEST_CHANGES",
      selectedEvent: "COMMENT",
      mode: "trusted_command_only",
      reason: "authorization_missing",
      headSha: scenario.pull.head.sha,
      consumed: false,
      dryRun: false
    });
    expect(JSON.parse(readFileSync(join(scenario.evidenceDir, "review-plan.json"), "utf8")).walkthrough.body).toContain(
      "Review event: `COMMENT`."
    );
    expect(walkthroughBuildEvents).toEqual(["COMMENT"]);
    scenario.state.close();
  });

  it("does not preflight exact authorization for an ordinary command on a processed head", async () => {
    const headSha = "a".repeat(40);
    const commandComment = {
      id: 40,
      body: "@evaos-code-review-bot re-review",
      user: { login: "100yenadmin", type: "User" }
    };
    const scenario = await runOwnerPolicyReview({
      roots,
      pullNumber: 500,
      headSha,
      commandComment,
      commandCommentId: commandComment.id,
      configureState: (state) => state.recordProcessed({
        repo: "electricsheephq/WorldOS",
        pullNumber: 500,
        headSha,
        status: "posted",
        event: "COMMENT"
      })
    });

    expect(scenario.result).toBe("reviewed_command");
    expect(scenario.exactCommentLookups).toEqual([commandComment.id]);
    scenario.state.close();
  });

  it("posts and persists REQUEST_CHANGES only for the exact queued trusted owner command", async () => {
    const scenario = await runOwnerPolicyReview({
      roots,
      pullNumber: 502,
      commandComment: requestChangesComment(41, 502, "b".repeat(40)),
      commandCommentId: 41
    });

    expect(scenario.result).toBe("reviewed_command");
    expect(createdReviews[0]).toMatchObject({ headSha: scenario.pull.head.sha, event: "REQUEST_CHANGES" });
    expect(scenario.state.getProcessedReview("electricsheephq/WorldOS", 502, scenario.pull.head.sha)).toMatchObject({
      status: "posted",
      event: "REQUEST_CHANGES"
    });
    expect(readDecision(scenario.evidenceDir)).toMatchObject({
      candidateEvent: "REQUEST_CHANGES",
      selectedEvent: "REQUEST_CHANGES",
      reason: "authorization_eligible",
      author: "100yenadmin",
      commentId: 41,
      consumed: true,
      dryRun: false
    });
    expect(JSON.stringify(readDecision(scenario.evidenceDir))).not.toContain("request-changes");
    expect(JSON.parse(readFileSync(join(scenario.evidenceDir, "review-plan.json"), "utf8")).event).toBe("REQUEST_CHANGES");
    scenario.state.close();
  });

  it("fails closed when the exact authorization was already consumed", async () => {
    const headSha = "c".repeat(40);
    const scenario = await runOwnerPolicyReview({
      roots,
      pullNumber: 503,
      headSha,
      commandComment: requestChangesComment(42, 503, headSha),
      commandCommentId: 42,
      configureState: (state) => {
        expect(state.tryConsumeReviewEventAuthorization({
          repo: "electricsheephq/WorldOS",
          pullNumber: 503,
          headSha,
          commentId: 42,
          author: "100yenadmin"
        })).toBe(true);
      }
    });

    expect(scenario.result).toBe("skipped_consumed_authorization");
    expect(createdReviews).toEqual([]);
    expect(zcodePrompts).toEqual([]);
    expect(scenario.state.getProcessedReview("electricsheephq/WorldOS", 503, headSha)).toBeUndefined();
    expect(scenario.state.getReviewEventAuthorizationConsumption("electricsheephq/WorldOS", 503, headSha)).toMatchObject({
      incidentError: "exact_authorization_already_consumed",
      incidentCommentId: 42
    });
    expect(scenario.state.getReviewReadiness("electricsheephq/WorldOS", 503, headSha)).toMatchObject({
      state: "failed",
      reason: "exact_authorization_already_consumed"
    });
    expect(JSON.parse(readFileSync(join(scenario.evidenceDir, "consumed-authorization-incident.json"), "utf8"))).toMatchObject({
      reason: "exact_authorization_already_consumed",
      repo: "electricsheephq/WorldOS",
      pullNumber: 503,
      headSha,
      commentId: 42
    });
    scenario.state.close();
  });

  it("does not mistake an older advisory post for a consumed blocking authorization receipt", async () => {
    const headSha = "2".repeat(40);
    const scenario = await runOwnerPolicyReview({
      roots,
      pullNumber: 522,
      headSha,
      commandComment: requestChangesComment(72, 522, headSha),
      commandCommentId: 72,
      configureState: (state) => {
        state.recordProcessed({
          repo: "electricsheephq/WorldOS",
          pullNumber: 522,
          headSha,
          status: "posted",
          event: "COMMENT",
          reviewUrl: "https://github.com/electricsheephq/WorldOS/pull/522#pullrequestreview-1"
        });
        expect(state.tryConsumeReviewEventAuthorization({
          repo: "electricsheephq/WorldOS",
          pullNumber: 522,
          headSha,
          commentId: 71,
          author: "100yenadmin"
        })).toBe(true);
      }
    });

    expect(scenario.result).toBe("skipped_consumed_authorization");
    expect(createdReviews).toEqual([]);
    expect(zcodePrompts).toEqual([]);
    expect(scenario.state.getProcessedReview("electricsheephq/WorldOS", 522, headSha)).toMatchObject({
      status: "posted",
      event: "COMMENT",
      reviewUrl: "https://github.com/electricsheephq/WorldOS/pull/522#pullrequestreview-1"
    });
    expect(scenario.state.getReviewEventAuthorizationConsumption("electricsheephq/WorldOS", 522, headSha)).toMatchObject({
      commentId: 71,
      incidentError: "exact_authorization_already_consumed",
      incidentCommentId: 72
    });
    expect(scenario.state.getReviewReadiness("electricsheephq/WorldOS", 522, headSha)).toMatchObject({
      state: "failed",
      reason: "exact_authorization_already_consumed"
    });
    scenario.state.close();
  });

  it("rechecks the owner authorization receipt after a concurrent provider run reaches the post claim", async () => {
    const headSha = "3".repeat(40);
    let state!: ReviewStateStore;
    const scenario = await runOwnerPolicyReview({
      roots,
      pullNumber: 523,
      headSha,
      commandComment: requestChangesComment(74, 523, headSha),
      commandCommentId: 74,
      lateCommentLookupError: new Error("late GitHub comment lookup failed"),
      configureState: (configuredState) => {
        state = configuredState;
        const claim = state.tryClaimReviewHeadWithOutcome.bind(state);
        vi.spyOn(state, "tryClaimReviewHeadWithOutcome").mockImplementation((input) => {
          if (!state.getReviewEventAuthorizationConsumption("electricsheephq/WorldOS", 523, headSha)) {
            expect(state.tryConsumeReviewEventAuthorization({
              repo: "electricsheephq/WorldOS",
              pullNumber: 523,
              headSha,
              commentId: 73,
              author: "100yenadmin"
            })).toBe(true);
            state.recordAuthorizedReviewPosted({
              repo: "electricsheephq/WorldOS",
              pullNumber: 523,
              headSha,
              commentId: 73,
              author: "100yenadmin",
              event: "REQUEST_CHANGES",
              reviewUrl: "https://github.com/electricsheephq/WorldOS/pull/523#pullrequestreview-concurrent"
            });
          }
          return claim(input);
        });
      }
    });

    expect(scenario.result).toBe("skipped_processed");
    expect(scenario.exactCommentLookups).toEqual([74, 74]);
    expect(zcodePrompts).toHaveLength(1);
    expect(createdReviews).toEqual([]);
    expect(scenario.state.getProcessedReview("electricsheephq/WorldOS", 523, headSha)).toMatchObject({
      status: "posted",
      event: "REQUEST_CHANGES",
      reviewUrl: "https://github.com/electricsheephq/WorldOS/pull/523#pullrequestreview-concurrent"
    });
    scenario.state.close();
  });

  it("lets a concurrent receipt win atomically after a worker reads an unreceipted consumption", async () => {
    const headSha = "4".repeat(40);
    let state!: ReviewStateStore;
    const scenario = await runOwnerPolicyReview({
      roots,
      pullNumber: 524,
      headSha,
      commandComment: requestChangesComment(77, 524, headSha),
      commandCommentId: 77,
      configureState: (configuredState) => {
        state = configuredState;
        expect(state.tryConsumeReviewEventAuthorization({
          repo: "electricsheephq/WorldOS",
          pullNumber: 524,
          headSha,
          commentId: 76,
          author: "100yenadmin"
        })).toBe(true);
        const recordIncident = state.recordReviewEventAuthorizationIncident.bind(state);
        vi.spyOn(state, "recordReviewEventAuthorizationIncident").mockImplementation((input) => {
          if (!state.getReviewEventAuthorizationConsumption("electricsheephq/WorldOS", 524, headSha)?.postedAt) {
            state.recordAuthorizedReviewPosted({
              repo: "electricsheephq/WorldOS",
              pullNumber: 524,
              headSha,
              commentId: 76,
              author: "100yenadmin",
              event: "REQUEST_CHANGES",
              reviewUrl: "https://github.com/electricsheephq/WorldOS/pull/524#pullrequestreview-concurrent"
            });
          }
          return recordIncident(input);
        });
      }
    });

    expect(scenario.result).toBe("skipped_processed");
    expect(createdReviews).toEqual([]);
    expect(zcodePrompts).toEqual([]);
    expect(scenario.state.getReviewEventAuthorizationConsumption("electricsheephq/WorldOS", 524, headSha)).toMatchObject({
      postedEvent: "REQUEST_CHANGES",
      reviewUrl: "https://github.com/electricsheephq/WorldOS/pull/524#pullrequestreview-concurrent"
    });
    expect(scenario.state.getReviewEventAuthorizationConsumption("electricsheephq/WorldOS", 524, headSha)).not.toHaveProperty("incidentError");
    expect(scenario.state.getReviewReadiness("electricsheephq/WorldOS", 524, headSha)).toMatchObject({
      state: "needs_fix",
      reason: "request_changes_review_posted"
    });
    scenario.state.close();
  });

  it("re-fetches only the queued ordinary command id and ignores another valid authorization", async () => {
    const headSha = "d".repeat(40);
    const ordinaryComment = {
      id: 43,
      body: "@evaos-code-review-bot re-review",
      user: { login: "100yenadmin", type: "User" }
    };
    const scenario = await runOwnerPolicyReview({
      roots,
      pullNumber: 504,
      headSha,
      commandComment: ordinaryComment,
      otherListedComments: [requestChangesComment(44, 504, headSha)],
      commandCommentId: 43
    });

    expect(scenario.exactCommentLookups).toEqual([43]);
    expect(createdReviews[0]?.event).toBe("COMMENT");
    expect(readDecision(scenario.evidenceDir)).toMatchObject({
      selectedEvent: "COMMENT",
      reason: "authorization_missing",
      commentId: 43,
      consumed: false
    });
    scenario.state.close();
  });

  it("fails closed to COMMENT when the exact comment lookup fails", async () => {
    const scenario = await runOwnerPolicyReview({
      roots,
      pullNumber: 505,
      commandCommentId: 45,
      commentLookupError: new Error("GitHub comment read failed")
    });

    expect(createdReviews[0]?.event).toBe("COMMENT");
    expect(readDecision(scenario.evidenceDir)).toMatchObject({
      selectedEvent: "COMMENT",
      reason: "authorization_lookup_failed",
      commentId: 45,
      consumed: false
    });
    scenario.state.close();
  });

  it("fails closed to COMMENT when atomic authorization consumption throws", async () => {
    const headSha = "e".repeat(40);
    const scenario = await runOwnerPolicyReview({
      roots,
      pullNumber: 506,
      headSha,
      commandComment: requestChangesComment(46, 506, headSha),
      commandCommentId: 46,
      configureState: (state) => {
        vi.spyOn(state, "tryConsumeReviewEventAuthorization").mockImplementation(() => {
          throw new Error("database is busy");
        });
      }
    });

    expect(scenario.result).toBe("reviewed_command");
    expect(createdReviews[0]?.event).toBe("COMMENT");
    expect(readDecision(scenario.evidenceDir)).toMatchObject({
      selectedEvent: "COMMENT",
      reason: "authorization_state_error",
      commentId: 46,
      consumed: false
    });
    scenario.state.close();
  });

  it("records an explicit dry-run decision without consuming or posting", async () => {
    const headSha = "f".repeat(40);
    const scenario = await runOwnerPolicyReview({
      roots,
      pullNumber: 507,
      headSha,
      commandComment: requestChangesComment(47, 507, headSha),
      commandCommentId: 47,
      dryRun: true
    });

    expect(scenario.result).toBe("reviewed_command");
    expect(createdReviews).toEqual([]);
    expect(readDecision(scenario.evidenceDir)).toMatchObject({
      candidateEvent: "REQUEST_CHANGES",
      selectedEvent: "REQUEST_CHANGES",
      reason: "authorization_eligible",
      commentId: 47,
      consumed: false,
      dryRun: true
    });
    expect(scenario.state.tryConsumeReviewEventAuthorization({
      repo: "electricsheephq/WorldOS",
      pullNumber: 507,
      headSha,
      commentId: 47,
      author: "100yenadmin"
    })).toBe(true);
    scenario.state.close();
  });

  it("does not consume when the head moves after exact authorization lookup and before post", async () => {
    const headSha = "1".repeat(40);
    const scenario = await runOwnerPolicyReview({
      roots,
      pullNumber: 508,
      headSha,
      commandComment: requestChangesComment(48, 508, headSha),
      commandCommentId: 48,
      moveHeadAfterCommentLookup: "2".repeat(40)
    });

    expect(scenario.result).toBe("skipped_stale_head");
    expect(createdReviews).toEqual([]);
    expect(scenario.state.tryConsumeReviewEventAuthorization({
      repo: "electricsheephq/WorldOS",
      pullNumber: 508,
      headSha,
      commentId: 48,
      author: "100yenadmin"
    })).toBe(true);
    scenario.state.close();
  });

  it("never restores consumed authority after a review POST failure", async () => {
    const headSha = "2".repeat(40);
    reviewPostControl.error = new Error("GitHub review POST failed");
    const scenario = await runOwnerPolicyReview({
      roots,
      pullNumber: 509,
      headSha,
      commandComment: requestChangesComment(49, 509, headSha),
      commandCommentId: 49
    });

    expect(scenario.error).toEqual(expect.objectContaining({ message: "GitHub review POST failed" }));
    expect(scenario.state.tryConsumeReviewEventAuthorization({
      repo: "electricsheephq/WorldOS",
      pullNumber: 509,
      headSha,
      commentId: 49,
      author: "100yenadmin"
    })).toBe(false);
    scenario.state.close();
  });

  it("records a bounded incident and withholds current-head readiness when the head moves during POST", async () => {
    const headSha = "3".repeat(40);
    const scenario = await runOwnerPolicyReview({
      roots,
      pullNumber: 510,
      headSha,
      commandComment: requestChangesComment(50, 510, headSha),
      commandCommentId: 50,
      moveHeadDuringPost: "4".repeat(40)
    });

    expect(scenario.result).toBe("posted_stale_head");
    expect(createdReviews[0]).toMatchObject({ headSha, event: "REQUEST_CHANGES" });
    expect(scenario.state.getProcessedReview("electricsheephq/WorldOS", 510, headSha)).toMatchObject({
      status: "posted",
      event: "REQUEST_CHANGES",
      reviewUrl: "https://github.com/electricsheephq/WorldOS/pull/510#pullrequestreview-1",
      error: "review_posted_head_changed"
    });
    expect(JSON.parse(readFileSync(join(scenario.evidenceDir, "posted-review.json"), "utf8"))).toEqual({
      event: "REQUEST_CHANGES",
      reviewId: 1,
      reviewUrl: "https://github.com/electricsheephq/WorldOS/pull/510#pullrequestreview-1"
    });
    expect(JSON.parse(readFileSync(join(scenario.evidenceDir, "head-changed-during-post.json"), "utf8"))).toEqual({
      reason: "head_changed_during_post",
      repo: "electricsheephq/WorldOS",
      pullNumber: 510,
      expectedHeadSha: headSha,
      liveHeadSha: "4".repeat(40),
      reviewId: 1
    });
    expect(scenario.state.getReviewReadiness("electricsheephq/WorldOS", 510, headSha)).toMatchObject({
      state: "stale",
      reason: "review_posted_head_changed"
    });
    scenario.state.close();
  });

  it("preserves a prior posted review row when an exact owner supersession becomes stale", async () => {
    const headSha = "d".repeat(40);
    const reviewUrl = "https://github.com/electricsheephq/WorldOS/pull/518#pullrequestreview-518";
    let postedBeforeSupersession: ReturnType<ReviewStateStore["getProcessedReview"]>;
    const scenario = await runOwnerPolicyReview({
      roots,
      pullNumber: 518,
      headSha,
      commandComment: requestChangesComment(58, 518, headSha),
      commandCommentId: 58,
      moveHeadAfterCommentLookup: "e".repeat(40),
      configureState: (state) => {
        state.recordProcessed({
          repo: "electricsheephq/WorldOS",
          pullNumber: 518,
          headSha,
          status: "posted",
          event: "COMMENT",
          reviewUrl
        });
        postedBeforeSupersession = state.getProcessedReview("electricsheephq/WorldOS", 518, headSha);
      }
    });

    expect(scenario.result).toBe("skipped_stale_head");
    expect(createdReviews).toEqual([]);
    expect(scenario.state.getProcessedReview("electricsheephq/WorldOS", 518, headSha)).toEqual(postedBeforeSupersession);
    expect(JSON.parse(readFileSync(join(scenario.evidenceDir, "stale-head.json"), "utf8"))).toMatchObject({
      reason: "stale_head_before_review",
      expectedHeadSha: headSha,
      liveHeadSha: "e".repeat(40)
    });
    scenario.state.close();
  });

  it("consumes an exact eligible command even when the deterministic candidate is already COMMENT", async () => {
    const headSha = "5".repeat(40);
    const scenario = await runOwnerPolicyReview({
      roots,
      pullNumber: 511,
      headSha,
      commandComment: requestChangesComment(51, 511, headSha),
      commandCommentId: 51,
      candidateSeverity: "P2"
    });

    expect(scenario.error).toBeUndefined();
    expect(scenario.result).toBe("reviewed_command");
    expect(createdReviews[0]?.event).toBe("COMMENT");
    expect(readDecision(scenario.evidenceDir)).toMatchObject({
      candidateEvent: "COMMENT",
      selectedEvent: "COMMENT",
      reason: "candidate_comment",
      commentId: 51,
      consumed: true
    });
    expect(scenario.state.tryConsumeReviewEventAuthorization({
      repo: "electricsheephq/WorldOS",
      pullNumber: 511,
      headSha,
      commentId: 51,
      author: "100yenadmin"
    })).toBe(false);
    expect(scenario.state.getReviewEventAuthorizationConsumption("electricsheephq/WorldOS", 511, headSha)).toMatchObject({
      commentId: 51,
      postedEvent: "COMMENT",
      reviewUrl: "https://github.com/electricsheephq/WorldOS/pull/511#pullrequestreview-1"
    });

    const replay = await runOwnerPolicyReview({
      roots,
      existing: scenario,
      pullNumber: 511,
      headSha,
      commandComment: requestChangesComment(75, 511, headSha),
      commandCommentId: 75,
      candidateSeverity: "P2"
    });
    expect(replay.error).toBeUndefined();
    expect(replay.result).toBe("skipped_processed");
    expect(createdReviews.map((review) => review.event)).toEqual(["COMMENT"]);
    replay.state.close();
  });

  it("terminally consumes an owner command without reposting an already-posted COMMENT", async () => {
    const headSha = "7".repeat(40);
    const priorReviewUrl = "https://github.com/electricsheephq/WorldOS/pull/525#pullrequestreview-prior";
    let priorProcessed: ReturnType<ReviewStateStore["getProcessedReview"]>;
    let priorReadiness: ReturnType<ReviewStateStore["getReviewReadiness"]>;
    const first = await runOwnerPolicyReview({
      roots,
      pullNumber: 525,
      headSha,
      commandComment: requestChangesComment(83, 525, headSha),
      commandCommentId: 83,
      candidateSeverity: "P2",
      configureState: (state) => {
        state.recordProcessed({
          repo: "electricsheephq/WorldOS",
          pullNumber: 525,
          headSha,
          status: "posted",
          event: "COMMENT",
          reviewUrl: priorReviewUrl
        });
        state.recordReviewReadiness({
          repo: "electricsheephq/WorldOS",
          pullNumber: 525,
          headSha,
          state: "ready_for_human",
          reason: "comment_review_posted",
          event: "COMMENT",
          reviewUrl: priorReviewUrl,
          now: new Date("2026-07-13T02:00:00.000Z")
        });
        priorProcessed = state.getProcessedReview("electricsheephq/WorldOS", 525, headSha);
        priorReadiness = state.getReviewReadiness("electricsheephq/WorldOS", 525, headSha);
      }
    });

    expect(first.error).toBeUndefined();
    expect(first.result).toBe("skipped_processed");
    expect(createdReviews).toEqual([]);
    expect(zcodePrompts).toHaveLength(1);
    expect(first.state.getProcessedReview("electricsheephq/WorldOS", 525, headSha)).toEqual(priorProcessed);
    expect(first.state.getReviewReadiness("electricsheephq/WorldOS", 525, headSha)).toEqual(priorReadiness);
    expect(first.state.getReviewEventAuthorizationConsumption("electricsheephq/WorldOS", 525, headSha)).toMatchObject({
      commentId: 83,
      author: "100yenadmin",
      terminalOutcome: "no_op",
      terminalReason: "candidate_comment_already_posted",
      terminalAt: expect.any(String)
    });
    expect(first.state.getReviewEventAuthorizationConsumption("electricsheephq/WorldOS", 525, headSha)).not.toHaveProperty("postedAt");
    expect(first.state.getReviewEventAuthorizationConsumption("electricsheephq/WorldOS", 525, headSha)).not.toHaveProperty("incidentError");
    expect(existsSync(join(first.evidenceDir, "posted-review.json"))).toBe(false);

    first.state.close();
    const reopenedState = new ReviewStateStore(first.config.statePath);
    const reopened = { root: first.root, config: first.config, state: reopenedState };
    const replay = await runOwnerPolicyReview({
      roots,
      existing: reopened,
      pullNumber: 525,
      headSha,
      commandComment: requestChangesComment(83, 525, headSha),
      commandCommentId: 83,
      candidateSeverity: "P2"
    });
    expect(replay.error).toBeUndefined();
    expect(replay.result).toBe("skipped_processed");

    const laterCommand = await runOwnerPolicyReview({
      roots,
      existing: reopened,
      pullNumber: 525,
      headSha,
      commandComment: requestChangesComment(84, 525, headSha),
      commandCommentId: 84,
      candidateSeverity: "P2"
    });
    expect(laterCommand.error).toBeUndefined();
    expect(laterCommand.result).toBe("skipped_processed");
    expect(createdReviews).toEqual([]);
    expect(zcodePrompts).toHaveLength(1);
    expect(laterCommand.state.getProcessedReview("electricsheephq/WorldOS", 525, headSha)).toEqual(priorProcessed);
    expect(laterCommand.state.getReviewReadiness("electricsheephq/WorldOS", 525, headSha)).toEqual(priorReadiness);
    expect(laterCommand.state.getReviewEventAuthorizationConsumption("electricsheephq/WorldOS", 525, headSha)).toMatchObject({
      commentId: 83,
      terminalOutcome: "no_op",
      terminalReason: "candidate_comment_already_posted"
    });
    laterCommand.state.close();
  });

  it("lets an exact queued owner command supersede a posted advisory COMMENT on the same head", async () => {
    const headSha = "6".repeat(40);
    const scenario = await runOwnerPolicyReview({
      roots,
      pullNumber: 512,
      headSha,
      commandComment: requestChangesComment(52, 512, headSha),
      commandCommentId: 52,
      configureState: (state) => state.recordProcessed({
        repo: "electricsheephq/WorldOS",
        pullNumber: 512,
        headSha,
        status: "posted",
        event: "COMMENT"
      })
    });

    expect(scenario.result).toBe("reviewed_command");
    expect(scenario.exactCommentLookups).toEqual([52, 52]);
    expect(createdReviews).toHaveLength(1);
    expect(createdReviews[0]?.event).toBe("REQUEST_CHANGES");
    expect(scenario.state.getProcessedReview("electricsheephq/WorldOS", 512, headSha)).toMatchObject({
      status: "posted",
      event: "REQUEST_CHANGES"
    });
    scenario.state.close();
  });

  it.each([
    ["untrusted", { id: 53, body: `@evaos-code-review-bot request-changes --repo electricsheephq/WorldOS --pr 513 --head ${"7".repeat(40)}`, user: { login: "outside-contributor", type: "User" } }],
    ["malformed", { id: 54, body: "@evaos-code-review-bot request-changes --repo electricsheephq/WorldOS --pr 514 --head short", user: { login: "100yenadmin", type: "User" } }]
  ])("does not give a same-head processed bypass to an %s command", async (_label, commandComment) => {
    const pullNumber = commandComment.id === 53 ? 513 : 514;
    const headSha = commandComment.id === 53 ? "7".repeat(40) : "8".repeat(40);
    const scenario = await runOwnerPolicyReview({
      roots,
      pullNumber,
      headSha,
      commandComment,
      commandCommentId: commandComment.id,
      configureState: (state) => state.recordProcessed({
        repo: "electricsheephq/WorldOS",
        pullNumber,
        headSha,
        status: "posted",
        event: "COMMENT"
      })
    });

    expect(scenario.result).toBe("skipped_processed");
    expect(scenario.exactCommentLookups).toEqual([commandComment.id]);
    expect(createdReviews).toEqual([]);
    expect(scenario.state.getProcessedReview("electricsheephq/WorldOS", pullNumber, headSha)?.event).toBe("COMMENT");
    scenario.state.close();
  });

  it("keeps consumed authority consumed when the head moves before any auxiliary or review POST", async () => {
    const headSha = "9".repeat(40);
    const scenario = await runOwnerPolicyReview({
      roots,
      pullNumber: 515,
      headSha,
      commandComment: requestChangesComment(55, 515, headSha),
      commandCommentId: 55,
      moveHeadAfterConsume: "a".repeat(40)
    });

    expect(scenario.result).toBe("skipped_stale_head");
    expect(createdReviews).toEqual([]);
    expect(scenario.state.tryConsumeReviewEventAuthorization({
      repo: "electricsheephq/WorldOS",
      pullNumber: 515,
      headSha,
      commentId: 55,
      author: "100yenadmin"
    })).toBe(false);
    scenario.state.close();
  });

  it("stops before review when the head moves during an auxiliary walkthrough POST", async () => {
    const headSha = "a".repeat(40);
    const scenario = await runOwnerPolicyReview({
      roots,
      pullNumber: 516,
      headSha,
      commandComment: requestChangesComment(56, 516, headSha),
      commandCommentId: 56,
      enableWalkthroughPost: true,
      moveHeadAfterAuxiliaryPost: "b".repeat(40)
    });

    expect(scenario.result).toBe("skipped_stale_head");
    expect(createdReviews).toEqual([]);
    expect(scenario.state.tryConsumeReviewEventAuthorization({
      repo: "electricsheephq/WorldOS",
      pullNumber: 516,
      headSha,
      commentId: 56,
      author: "100yenadmin"
    })).toBe(false);
    scenario.state.close();
  });

  it("returns skipped_closed without posting when the pull merges during an active review", async () => {
    const headSha = "d".repeat(40);
    const scenario = await runOwnerPolicyReview({
      roots,
      pullNumber: 518,
      headSha,
      commandComment: requestChangesComment(58, 518, headSha),
      commandCommentId: 58,
      closeAfterConsume: true
    });

    expect(scenario.error).toBeUndefined();
    expect(scenario.result).toBe("skipped_closed");
    expect(createdReviews).toEqual([]);
    expect(scenario.state.getProcessedReview("electricsheephq/WorldOS", 518, headSha)).toMatchObject({
      status: "skipped",
      error: "closed_or_merged_before_review state=closed; merged_at=2026-07-20T10:01:55.000Z"
    });
    expect(JSON.parse(readFileSync(join(scenario.evidenceDir, "closed-before-review-post.json"), "utf8"))).toMatchObject({
      reason: "closed_or_merged_before_review",
      state: "closed",
      mergedAt: "2026-07-20T10:01:55.000Z",
      expectedHeadSha: headSha,
      liveHeadSha: headSha
    });
    scenario.state.close();
  });

  it("prefers skipped_closed when a changed pull head closes before final posting", async () => {
    const headSha = "e".repeat(40);
    const liveHeadSha = "f".repeat(40);
    const scenario = await runOwnerPolicyReview({
      roots,
      pullNumber: 526,
      headSha,
      commandComment: requestChangesComment(85, 526, headSha),
      commandCommentId: 85,
      closeAfterHeadClaimWithSha: liveHeadSha
    });

    expect(scenario.error).toBeUndefined();
    expect(scenario.result).toBe("skipped_closed");
    expect(createdReviews).toEqual([]);
    expect(scenario.state.getProcessedReview("electricsheephq/WorldOS", 526, headSha)).toMatchObject({
      status: "skipped",
      error: "closed_or_merged_before_review state=closed; merged_at=2026-07-20T10:01:55.000Z"
    });
    expect(JSON.parse(readFileSync(join(scenario.evidenceDir, "closed-before-review-post.json"), "utf8"))).toMatchObject({
      reason: "closed_or_merged_before_review",
      state: "closed",
      expectedHeadSha: headSha,
      liveHeadSha
    });
    scenario.state.close();
  });

  it("keeps a successful review posted when the immediate post-review head lookup fails", async () => {
    const headSha = "c".repeat(40);
    const lookupSecret = "ghp_post_lookup_secret";
    const scenario = await runOwnerPolicyReview({
      roots,
      pullNumber: 517,
      headSha,
      commandComment: requestChangesComment(57, 517, headSha),
      commandCommentId: 57,
      postReviewHeadLookupError: new Error(`post lookup failed ${lookupSecret}`)
    });

    expect(scenario.error).toBeUndefined();
    expect(scenario.result).toBe("posted_head_unverified");
    expect(createdReviews).toHaveLength(1);
    expect(scenario.state.getProcessedReview("electricsheephq/WorldOS", 517, headSha)).toMatchObject({
      status: "posted",
      event: "REQUEST_CHANGES",
      reviewUrl: "https://github.com/electricsheephq/WorldOS/pull/517#pullrequestreview-1",
      error: "post_review_head_unverified"
    });
    expect(JSON.parse(readFileSync(join(scenario.evidenceDir, "posted-review.json"), "utf8"))).toEqual({
      event: "REQUEST_CHANGES",
      reviewId: 1,
      reviewUrl: "https://github.com/electricsheephq/WorldOS/pull/517#pullrequestreview-1"
    });
    const incident = JSON.parse(readFileSync(join(scenario.evidenceDir, "post-review-head-lookup-failed.json"), "utf8"));
    expect(incident).toMatchObject({
      reason: "post_review_head_lookup_failed",
      repo: "electricsheephq/WorldOS",
      pullNumber: 517,
      expectedHeadSha: headSha,
      reviewId: 1,
      error: expect.stringContaining("[redacted-secret]")
    });
    expect(JSON.stringify(incident)).not.toContain(lookupSecret);
    expect(scenario.state.getReviewReadiness("electricsheephq/WorldOS", 517, headSha)).toMatchObject({
      state: "failed",
      reason: "post_review_head_unverified"
    });
    scenario.state.close();
  });

  it("keeps the first blocking review durable and posts nothing for a second exact command", async () => {
    const headSha = "f".repeat(40);
    const first = await runOwnerPolicyReview({
      roots,
      pullNumber: 519,
      headSha,
      commandComment: requestChangesComment(59, 519, headSha),
      commandCommentId: 59
    });
    const blocking = first.state.getProcessedReview("electricsheephq/WorldOS", 519, headSha);
    expect(blocking).toMatchObject({ status: "posted", event: "REQUEST_CHANGES" });

    const second = await runOwnerPolicyReview({
      roots,
      existing: first,
      pullNumber: 519,
      headSha,
      commandComment: requestChangesComment(60, 519, headSha),
      commandCommentId: 60
    });

    expect(second.result).toBe("skipped_processed");
    expect(createdReviews.map((review) => review.event)).toEqual(["REQUEST_CHANGES"]);
    expect(second.state.getProcessedReview("electricsheephq/WorldOS", 519, headSha)).toEqual(blocking);
    expect(second.state.getReviewReadiness("electricsheephq/WorldOS", 519, headSha)).toMatchObject({
      state: "needs_fix",
      event: "REQUEST_CHANGES",
      reviewUrl: blocking?.reviewUrl
    });
    expect(first.evidenceDir).toContain("command-59");
    expect(existsSync(join(first.evidenceDir, "review-event-decision.json"))).toBe(true);
    expect(existsSync(join(first.evidenceDir, "command.json"))).toBe(false);
    expect(JSON.parse(readFileSync(join(first.evidenceDir, "posted-review.json"), "utf8"))).toEqual({
      event: "REQUEST_CHANGES",
      reviewId: 1,
      reviewUrl: "https://github.com/electricsheephq/WorldOS/pull/519#pullrequestreview-1"
    });
    expect(readFileSync(join(first.evidenceDir, "posted-review.json"), "utf8")).not.toContain("request-changes --repo");
    expect(JSON.stringify(readDecision(first.evidenceDir))).not.toContain("request-changes");
    second.state.close();
  });

  it("keeps a successful remote review durable when posted-review evidence cannot be written", async () => {
    const headSha = "1".repeat(40);
    evidenceWriteControl.failPostedReview = true;
    const first = await runOwnerPolicyReview({
      roots,
      pullNumber: 520,
      headSha,
      commandComment: requestChangesComment(61, 520, headSha),
      commandCommentId: 61
    });

    expect(first.error).toBeUndefined();
    expect(first.result).toBe("reviewed_command");
    expect(first.state.getProcessedReview("electricsheephq/WorldOS", 520, headSha)).toMatchObject({
      status: "posted",
      event: "REQUEST_CHANGES",
      reviewUrl: "https://github.com/electricsheephq/WorldOS/pull/520#pullrequestreview-1"
    });
    expect(existsSync(join(first.evidenceDir, "posted-review.json"))).toBe(false);

    const replay = await runOwnerPolicyReview({
      roots,
      existing: first,
      pullNumber: 520,
      headSha,
      commandComment: requestChangesComment(61, 520, headSha),
      commandCommentId: 61
    });
    expect(replay.result).toBe("skipped_processed");
    expect(createdReviews).toHaveLength(1);
    replay.state.close();
  });

  it("does not post or contaminate a verified blocking row when a later exact command is replayed", async () => {
    const headSha = "2".repeat(40);
    const first = await runOwnerPolicyReview({
      roots,
      pullNumber: 521,
      headSha,
      commandComment: requestChangesComment(62, 521, headSha),
      commandCommentId: 62
    });
    const blocking = first.state.getProcessedReview("electricsheephq/WorldOS", 521, headSha);
    expect(blocking).toMatchObject({ status: "posted", event: "REQUEST_CHANGES" });
    expect(blocking?.error).toBeUndefined();

    const advisory = await runOwnerPolicyReview({
      roots,
      existing: first,
      pullNumber: 521,
      headSha,
      commandComment: requestChangesComment(63, 521, headSha),
      commandCommentId: 63,
      postReviewHeadLookupError: new Error("advisory reread unavailable")
    });

    expect(advisory.result).toBe("skipped_processed");
    expect(createdReviews.map((review) => review.event)).toEqual(["REQUEST_CHANGES"]);
    expect(advisory.state.getProcessedReview("electricsheephq/WorldOS", 521, headSha)).toEqual(blocking);
    advisory.state.close();
  });
});

async function runOwnerPolicyReview(input: {
  roots: string[];
  existing?: { root: string; config: BotConfig; state: ReviewStateStore };
  pullNumber: number;
  headSha?: string;
  commandComment?: { id: number; body: string; user: { login: string; type: string } };
  otherListedComments?: Array<{ id: number; body: string; user: { login: string; type: string } }>;
  commandCommentId?: number;
  dryRun?: boolean;
  commentLookupError?: Error;
  lateCommentLookupError?: Error;
  moveHeadAfterCommentLookup?: string;
  moveHeadDuringPost?: string;
  moveHeadAfterConsume?: string;
  moveHeadAfterAuxiliaryPost?: string;
  closeAfterConsume?: boolean;
  closeAfterHeadClaimWithSha?: string;
  postReviewHeadLookupError?: Error;
  enableWalkthrough?: boolean;
  enableWalkthroughPost?: boolean;
  candidateSeverity?: "P1" | "P2";
  configureState?: (state: ReviewStateStore) => void;
}) {
  const root = input.existing?.root ?? mkdtempSync(join(tmpdir(), "neondiff-owner-policy-"));
  if (!input.existing) input.roots.push(root);
  const config = input.existing?.config ?? minimalConfig(root);
  config.commands = {
    enabled: true,
    botMentions: ["@evaos-code-review-bot"],
    trustedAuthors: ["100yenadmin"],
    acknowledge: false
  };
  config.reviewGate = {
    maxInlineComments: 25,
    reviewEventPolicy: { mode: "trusted_command_only" }
  };
  config.walkthrough.enabled = input.enableWalkthrough === true || input.enableWalkthroughPost === true;
  config.walkthrough.postIssueComment = input.enableWalkthroughPost ?? false;
  const state = input.existing?.state ?? new ReviewStateStore(config.statePath);
  const headSha = input.headSha ?? "b".repeat(40);
  const pull = pullSummary(input.pullNumber, headSha);
  let livePull = pull;
  input.configureState?.(state);
  if (input.closeAfterHeadClaimWithSha) {
    const tryClaim = state.tryClaimReviewHeadWithOutcome.bind(state);
    vi.spyOn(state, "tryClaimReviewHeadWithOutcome").mockImplementation((claim) => {
      const outcome = tryClaim(claim);
      livePull = {
        ...pullSummary(input.pullNumber, input.closeAfterHeadClaimWithSha!),
        state: "closed",
        merged_at: "2026-07-20T10:01:55.000Z"
      };
      return outcome;
    });
  }
  if (input.moveHeadAfterConsume || input.closeAfterConsume) {
    const consume = state.tryConsumeReviewEventAuthorization.bind(state);
    vi.spyOn(state, "tryConsumeReviewEventAuthorization").mockImplementation((authorization) => {
      const consumed = consume(authorization);
      if (input.closeAfterConsume) {
        livePull = {
          ...pull,
          state: "closed",
          merged_at: "2026-07-20T10:01:55.000Z"
        };
      } else {
        livePull = pullSummary(input.pullNumber, input.moveHeadAfterConsume!);
      }
      return consumed;
    });
  }
  const file = pullFile(`src/policy-${input.pullNumber}.ts`, 200);
  zcodeFindingsByPath.set(file.filename, [
    input.candidateSeverity === "P2"
      ? finding(file.filename, `P2 policy finding ${input.pullNumber}`)
      : p1Finding(file.filename, `P1 policy finding ${input.pullNumber}`)
  ]);
  const exactCommentLookups: number[] = [];
  if (input.moveHeadDuringPost || input.postReviewHeadLookupError) {
    reviewPostControl.afterCreate = () => {
      if (input.moveHeadDuringPost) livePull = pullSummary(input.pullNumber, input.moveHeadDuringPost);
      if (input.postReviewHeadLookupError) postReviewHeadLookupError = input.postReviewHeadLookupError;
    };
  }
  if (input.moveHeadAfterAuxiliaryPost) {
    reviewPostControl.afterAuxiliaryPost = () => {
      livePull = pullSummary(input.pullNumber, input.moveHeadAfterAuxiliaryPost!);
    };
  }
  let postReviewHeadLookupError: Error | undefined;
  const github = {
    getPull: async () => {
      if (postReviewHeadLookupError) {
        const error = postReviewHeadLookupError;
        postReviewHeadLookupError = undefined;
        throw error;
      }
      return livePull;
    },
    listPullFiles: async () => [file],
    listIssueComments: async () => [
      ...(input.commandComment ? [input.commandComment] : []),
      ...(input.otherListedComments ?? [])
    ],
    getIssueComment: async (_repo: string, commentId: number) => {
      exactCommentLookups.push(commentId);
      if (input.commentLookupError) throw input.commentLookupError;
      if (input.lateCommentLookupError && exactCommentLookups.length > 1) {
        throw input.lateCommentLookupError;
      }
      if (input.moveHeadAfterCommentLookup) {
        livePull = pullSummary(input.pullNumber, input.moveHeadAfterCommentLookup);
      }
      return input.commandComment ?? {
        id: commentId,
        body: "ordinary non-authorization comment",
        user: { login: "100yenadmin", type: "User" }
      };
    },
    canPostAsApp: () => false
  } as unknown as GitHubApi;

  let result: Awaited<ReturnType<typeof reviewPull>> | undefined;
  let error: unknown;
  try {
    result = await reviewPull({
      config,
      github,
      state,
      repo: "electricsheephq/WorldOS",
      pull,
      dryRun: input.dryRun ?? false,
      useZCode: true,
      ...(input.commandCommentId ? { commandCommentId: input.commandCommentId } : {})
    });
  } catch (caught) {
    error = caught;
  }

  const commandSubdir = input.commandCommentId ? `command-${input.commandCommentId}` : undefined;
  const evidenceDir = join(
    root,
    "evidence",
    localDateFolder(),
    "electricsheephq__WorldOS",
    `pr-${input.pullNumber}`,
    headSha,
    ...(commandSubdir ? [commandSubdir] : [])
  );
  return { root, config, state, pull, result, error, evidenceDir, exactCommentLookups };
}

function requestChangesComment(id: number, pullNumber: number, headSha: string) {
  return {
    id,
    body: `@evaos-code-review-bot request-changes --repo electricsheephq/WorldOS --pr ${pullNumber} --head ${headSha}`,
    user: { login: "100yenadmin", type: "User" }
  };
}

function readDecision(evidenceDir: string) {
  return JSON.parse(readFileSync(join(evidenceDir, "review-event-decision.json"), "utf8"));
}

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
      "@@ -0,0 +1,2 @@",
      `+const value = "${"x".repeat(patchLength)}";`,
      "+export const ready = true;"
    ].join("\n"),
    status: "modified",
    additions: 2,
    deletions: 0,
    changes: 2
  };
}

function finding(path: string, title: string): Finding {
  return {
    severity: "P2",
    path,
    line: 1,
    title,
    body: `${title} body`,
    confidence: 0.9,
    category: "runtime_correctness",
    why_this_matters: `${title} matters`
  };
}

function p1Finding(path: string, title: string): Finding {
  return {
    ...finding(path, title),
    severity: "P1",
    confidence: 0.99
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
