import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { detectCodexUsageLimit, parseCodexUsageLimitResetAt, runCodexReview } from "../src/codex-runtime.js";
import { loadConfigFromObject } from "../src/config.js";
import { GitHubApi } from "../src/github.js";
import { collectReleaseStatus } from "../src/release-status.js";
import { runScheduledCycleWithDeps } from "../src/scheduler.js";
import { ReviewStateStore } from "../src/state.js";
import type { PullRequestSummary } from "../src/types.js";
import { classifyAutoRetry, classifyProviderError, providerCooldownDurationMs, reviewPull } from "../src/worker.js";
import { testLicenseAdmission } from "./helpers/license-admission.js";

vi.mock("../src/git.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/git.js")>();
  return {
    ...actual,
    preparePullWorktree: vi.fn((input: { workRoot: string; expectedHeadSha: string }) => {
      const path = join(input.workRoot, "mock-worktree");
      mkdirSync(path, { recursive: true });
      return { path, headSha: input.expectedHeadSha };
    }),
    computeOwnDiffFingerprint: vi.fn(async () => ({ error: "fixture has no git checkout" })),
    assertGitClean: vi.fn()
  };
});

// Synthetic stderr shaped like a real Codex exit: banner, echoed prompt (well past 1000 characters), then the error.
const PREAMBLE = [
  "OpenAI Codex v0.171.0", "--------", "workdir: /fixture/worktree", "model: fixture-model", "--------", "user",
  "You are NeonDiff, a code reviewer.", ...Array.from({ length: 40 }, (_, index) => `+ const line${index} = "diff body ${index}";`)
].join("\n");
const LIMIT_AT = "ERROR: You’ve hit your usage limit. Visit https://chatgpt.com/settings/usage to purchase more credits or try again at 5:43 PM.";
const LIMIT_NO_TIME = "ERROR: You've hit your usage limit. Visit https://chatgpt.com/settings/usage to purchase more credits.";

const roots: string[] = [];
const stores: ReviewStateStore[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const state of stores.splice(0)) state.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "neondiff-usage-limit-")); roots.push(root);
  return root;
}

async function codexExitError(stderr: string, status = 1): Promise<Error> {
  const cwd = tempRoot();
  const error = await runCodexReview({ cwd, evidenceDir: join(cwd, "evidence"), prompt: "Fixture", cliPath: "/fixture/codex",
    model: "fixture-model", reasoningEffort: "high", timeoutMs: 1000, maxOutputBytes: 100000 }, {
    captureWorktreeState: () => "unchanged",
    runProcess: async () => ({ stdout: "", stderr, status, signal: null })
  }).then(() => undefined, (caught: unknown) => caught);
  if (!(error instanceof Error)) throw new Error("expected the Codex runtime to throw");
  return error;
}

describe("Codex usage-limit reset parsing (#1267)", () => {
  it("reads the printed local time as today while it is still ahead", () => {
    const now = new Date(2026, 10, 24, 12, 0, 0);
    expect(parseCodexUsageLimitResetAt(LIMIT_AT, now)).toEqual(new Date(2026, 10, 24, 17, 43, 0));
  });

  it("rolls a printed time that already passed today to tomorrow", () => {
    const now = new Date(2026, 10, 24, 18, 30, 0);
    expect(parseCodexUsageLimitResetAt(LIMIT_AT, now)).toEqual(new Date(2026, 10, 25, 17, 43, 0));
    expect(parseCodexUsageLimitResetAt("try again at 12:05 AM", new Date(2026, 10, 24, 23, 0))).toEqual(new Date(2026, 10, 25, 0, 5));
    expect(parseCodexUsageLimitResetAt("try again at 12:05 pm", new Date(2026, 10, 24, 9, 0))).toEqual(new Date(2026, 10, 24, 12, 5));
  });

  it("uses the default for a time that only just passed, an unparseable time, or no time", () => {
    // Codex prints whole minutes; a still-limited retry seconds after 5:43 must not wait until tomorrow.
    expect(parseCodexUsageLimitResetAt(LIMIT_AT, new Date(2026, 10, 24, 17, 43, 20))).toBeUndefined();
    expect(parseCodexUsageLimitResetAt("try again at 13:43 PM", new Date(2026, 10, 24, 9, 0))).toBeUndefined();
    expect(parseCodexUsageLimitResetAt(LIMIT_NO_TIME, new Date(2026, 10, 24, 9, 0))).toBeUndefined();
  });

  it("takes a dated reset as written", () => {
    const now = new Date(2026, 10, 24, 9, 0);
    expect(parseCodexUsageLimitResetAt("or try again at Nov 26th, 2026 5:43 PM.", now)).toEqual(new Date(2026, 10, 26, 17, 43));
    expect(parseCodexUsageLimitResetAt("or try again at Nov 20th, 2026 5:43 PM.", now)).toBeUndefined();
  });

  it("matches only Codex's own trailing ERROR line, case-insensitively", () => {
    const now = new Date(2026, 10, 24, 12, 0);
    expect(detectCodexUsageLimit(`${PREAMBLE}\nerror: YOU'VE HIT YOUR USAGE LIMIT. try again at 5:43 pm.\n`, now))
      .toMatchObject({ resetsAt: new Date(2026, 10, 24, 17, 43).toISOString() });
    // A diff or tool output quoting the message is not a limit.
    expect(detectCodexUsageLimit(`${PREAMBLE}\n${LIMIT_AT}\n${PREAMBLE}\nERROR: stream disconnected\n`, now)).toBeUndefined();
  });
});

describe("Codex usage-limit classification (#1267)", () => {
  it("1: a usage-limit exit past the first 1000 stderr characters carries the printed reset", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 10, 24, 12, 0));
    const error = await codexExitError(`${PREAMBLE}\nwarning: fixture\n${LIMIT_AT}\n${LIMIT_AT}\n`);
    expect(PREAMBLE.length).toBeGreaterThan(1000);
    expect(error.message).toMatch(/^codex_runtime_nonzero_exit: status=1 codex_usage_limit resets_at=/);
    const classification = classifyProviderError(error);
    expect(classification).toMatchObject({ category: "quota_exhausted", reason: "provider_usage_limit", cooldown: true,
      resetsAt: new Date(2026, 10, 24, 17, 43).toISOString() });
    const config = loadConfigFromObject({ pilotRepos: ["org/repo"], workRoot: tempRoot() });
    expect(providerCooldownDurationMs(config, classification, 1, 0, new Date())).toBe((5 * 60 + 43) * 60_000);
    // A deferral is not an automatic-retry grant.
    expect(classifyAutoRetry(error)).toMatchObject({ retryable: false, reason: "provider_classified" });
  });

  it("2: a usage-limit exit without a time uses the configurable default", async () => {
    const error = await codexExitError(`${PREAMBLE}\n${LIMIT_NO_TIME}\n`);
    expect(error.message).toContain("codex_usage_limit resets_at=unknown;");
    const classification = classifyProviderError(error);
    expect(classification).toMatchObject({ category: "quota_exhausted", reason: "provider_usage_limit", cooldown: true });
    expect(classification.resetsAt).toBeUndefined();
    const config = loadConfigFromObject({ pilotRepos: ["org/repo"], workRoot: tempRoot() });
    expect(providerCooldownDurationMs(config, classification)).toBe(30 * 60_000);
    expect(providerCooldownDurationMs({ ...config, providerCooldown: { ...config.providerCooldown, quotaDurationMs: 5 * 60_000 } },
      classification)).toBe(5 * 60_000);
  });

  it("3: other nonzero exits, including one that only quotes the message, still fail as before", async () => {
    for (const stderr of [`${PREAMBLE}\nERROR: stream disconnected before completion\n`, `${LIMIT_AT}\n${PREAMBLE}\nERROR: boom\n`]) {
      const error = await codexExitError(stderr);
      expect(error.message).toMatch(/^codex_runtime_nonzero_exit: status=1 (?:OpenAI Codex|ERROR: You)/);
      expect(error.message).not.toContain("codex_usage_limit");
      expect(classifyProviderError(error).category).toBe("none");
      expect(classifyAutoRetry(error)).toMatchObject({ retryable: true, reason: "codex_nonzero_exit" });
    }
    // A forged marker later in the message (prompt or diff text) is not anchored and does not match.
    const forged = new Error("codex_runtime_nonzero_exit: status=1 user said codex_usage_limit resets_at=2026-11-25T00:00:00.000Z; x");
    expect(classifyProviderError(forged).category).toBe("none");
  });
});

describe("Codex usage-limit deferral through the scheduler (#1267)", () => {
  function fixture() {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 10, 24, 12, 0));
    const root = tempRoot();
    const repo = "org/repo";
    const headSha = "0".repeat(40);
    // reviewAutoRetry stays off: the deferral must not depend on it.
    const config = loadConfigFromObject({
      pilotRepos: [repo], workRoot: join(root, "work"), statePath: join(root, "state.sqlite"), evidenceDir: join(root, "evidence"),
      activation: { reviewExistingOpenPrsOnActivation: true },
      reviewScheduler: { enabled: true }, reviewerSessions: { enabled: false },
      reviewStatusComment: { enabled: false }, walkthrough: { enabled: false }, enrichment: { enabled: false },
      commands: { enabled: false }, repoWiki: { enabled: false }, gitnexus: { enabled: false }
    });
    expect(config.reviewAutoRetry.enabled).toBe(false);
    const state = new ReviewStateStore(config.statePath); stores.push(state);
    const pull: PullRequestSummary = { number: 1, title: "Fixture", draft: false, state: "open",
      head: { sha: headSha, ref: "feature", repo: { full_name: repo } },
      base: { sha: "base-a", ref: "main", repo: { full_name: repo, private: false, visibility: "public" } },
      html_url: "https://github.com/org/repo/pull/1" };
    const github = {
      getPull: vi.fn(async () => pull), listOpenPulls: async () => [pull],
      listIssueComments: async () => [], listPullReviewComments: async () => [],
      listPullFiles: vi.fn(async () => []), canPost: () => true,
      postingIdentity: async () => ({ login: "neondiff[bot]", type: "Bot" })
    } as unknown as GitHubApi;
    vi.spyOn(GitHubApi.prototype, "listPullReviews").mockResolvedValue([]);
    vi.spyOn(GitHubApi.prototype, "postingIdentity").mockResolvedValue({ login: "poster", type: "User" });
    const post = vi.spyOn(GitHubApi.prototype, "createReview")
      .mockResolvedValue({ id: 1, html_url: "https://github.com/org/repo/pull/1#pullrequestreview-1" });
    const cycle = (reviewPullImpl: typeof reviewPull = reviewPull) => runScheduledCycleWithDeps({ config, state, github,
      options: { dryRun: false, useZCode: false }, reviewPullImpl, licenseAdmission: testLicenseAdmission,
      now: new Date(), clock: () => new Date() });
    const release = () => collectReleaseStatus({ cwd: root, statePath: config.statePath,
      configPath: join(root, "absent.json"), launchdLabel: "test.neondiff.usage-limit" });
    return { repo, headSha, state, post, cycle, release };
  }

  it("4/5: defers until the printed reset, is not a failed job, then reviews the head exactly once", async () => {
    const f = fixture();
    const limitError = await codexExitError(`${PREAMBLE}\n${LIMIT_AT}\n`);
    const resetAt = new Date(2026, 10, 24, 17, 43).toISOString();
    const limited = vi.fn(async () => { throw limitError; });

    await f.cycle(limited);
    expect(limited).toHaveBeenCalledTimes(1);
    const job = f.state.listReviewQueueJobs().at(-1)!;
    expect(job).toMatchObject({ state: "provider_deferred", nextEligibleAt: resetAt });
    expect(f.state.getProcessedReview(f.repo, 1, f.headSha)?.status).not.toBe("failed");
    expect(f.state.getActiveRepoProviderCooldown(f.repo)).toMatchObject({ cooldownUntil: resetAt, reason: "provider_usage_limit" });
    expect(f.state.getAutoRetry(f.repo, 1, f.headSha)).toBeUndefined();

    const status = f.release();
    expect(status.database.failedReviewQueueJobCount).toBe(0);
    expect(status.database.providerUsageLimitUntil).toBe(resetAt);
    expect(status.gates.find((gate) => gate.name === "provider_cooldown_backlog")?.detail)
      .toContain(`provider at usage limit until ${resetAt}`);
    for (const name of ["queue_no_failed_jobs", "live_db_no_errors", "provider_cooldown_backlog"]) {
      expect(status.gates.find((gate) => gate.name === name)).toMatchObject({ ok: true });
    }

    // Before the reset nothing starts.
    vi.setSystemTime(new Date(Date.parse(resetAt) - 60_000));
    await f.cycle(limited);
    expect(limited).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date(resetAt));
    await f.cycle(); await f.cycle();
    expect(f.post).toHaveBeenCalledTimes(1);
    expect(f.state.getProcessedReview(f.repo, 1, f.headSha)?.status).toBe("posted");
    expect(f.state.getReviewQueueJob(job.jobId)?.state).toBe("posted");
    expect(f.release().database.providerUsageLimitUntil).toBeUndefined();
  });

  it("1/2: without a printed time the job waits the default, then reviews once", async () => {
    const f = fixture();
    const limitError = await codexExitError(`${PREAMBLE}\n${LIMIT_NO_TIME}\n`);
    const defaultUntil = new Date(Date.now() + 30 * 60_000).toISOString();

    await f.cycle(async () => { throw limitError; });
    const job = f.state.listReviewQueueJobs().at(-1)!;
    expect(job).toMatchObject({ state: "provider_deferred", nextEligibleAt: defaultUntil });
    expect(f.state.getActiveRepoProviderCooldown(f.repo)).toMatchObject({ cooldownUntil: defaultUntil, reason: "provider_usage_limit" });
    expect(f.release().database.failedReviewQueueJobCount).toBe(0);

    vi.setSystemTime(new Date(defaultUntil));
    await f.cycle(); await f.cycle();
    expect(f.post).toHaveBeenCalledTimes(1);
    expect(f.state.getReviewQueueJob(job.jobId)?.state).toBe("posted");
  });
});
