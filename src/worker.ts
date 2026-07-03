import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isPreActivationExistingPull } from "./activation-policy.js";
import {
  buildCommandStatusBody,
  buildCommandStatusMarker,
  collectTrustedReviewCommands,
  decideCommandAction,
  isFinishingTouchCommandAction,
  type CommandDecision
} from "./commands.js";
import { loadConfig, type BotConfig } from "./config.js";
import { assertGitClean, planPullWorktreePaths, preparePullWorktree } from "./git.js";
import {
  buildGitNexusContextPacket,
  type GitNexusCommandRunner,
  type GitNexusContextPacket
} from "./gitnexus-context.js";
import {
  buildGitHubRelatedContextPacket,
  type GitHubRelatedContextPacket,
  type GitHubRelatedContextReader
} from "./github-related-context.js";
import { buildEnrichmentComment, postEnrichmentComment } from "./enrichment.js";
import {
  buildFinishingTouchDraft,
  isFinishingTouchActionEnabled,
  validateFinishingTouchRequest,
  type FinishingTouchAction
} from "./finishing-touches.js";
import { GitHubApi } from "./github.js";
import { getProtectedCheckoutRoots } from "./path-safety.js";
import {
  buildPullFileFilterImpact,
  filterPullFilesForProfile,
  listReposToScan,
  resolveRepoProfile
} from "./repo-policy.js";
import { applyDeterministicReviewGate } from "./review-gate.js";
import { buildRepoMemoryPacket, readRepoMemoryMarkdown, type RepoMemoryPacket } from "./repo-memory.js";
import { ReviewRunBudget } from "./review-budget.js";
import {
  postReviewStatusComment,
  type ReviewStatusCommentGithub,
  type ReviewStatusCommentState
} from "./review-status-comment.js";
import { redactSecrets } from "./secrets.js";
import { buildSkillPackContextPacket, type SkillPackContextPacket } from "./skill-packs.js";
import {
  ACTIVATION_BASELINE_EXISTING_HEAD_ERROR,
  isActivationBaselineProcessedReview,
  parseProviderCooldownError,
  ReviewStateStore,
  type ProcessedStatus,
  type ReviewQueueJobState,
  type ReviewerSessionJobState,
  type ReviewRunLease,
  type StoredProcessedReviewRecord
} from "./state.js";
import { buildChangedSurfaceValidationReport, evaluateProofRequirements } from "./validation-selector.js";
import { buildWalkthroughComment } from "./walkthrough.js";
import { postWalkthroughComment, reviewBodyAfterWalkthroughPost } from "./walkthrough-post.js";
import { buildReviewPrompt, runZCodeReview } from "./zcode.js";
import type { PullFilePatch, PullRequestSummary, ReviewPlan } from "./types.js";

export interface RunOnceOptions {
  configPath?: string;
  dryRun: boolean;
  repo?: string;
  pullNumber?: number;
  expectedHeadSha?: string;
  useZCode?: boolean;
}

export interface RunOnceResult {
  reposScanned: number;
  pullsSeen: number;
  reviewed: number;
  failed: number;
  skippedDraft: number;
  skippedCanary: number;
  skippedPolicy: number;
  skippedCommandStop: number;
  skippedCommandExplain: number;
  skippedFinishingTouchDraft: number;
  commandReviewRequested: number;
  skippedProcessed: number;
  skippedCapacity: number;
  skippedProviderCooldown: number;
  skippedStaleHead: number;
  baselinedExisting: number;
  policySkips: { repo: string; reason: string }[];
  scopedPull?: {
    repo: string;
    pullNumber: number;
    headSha: string;
    title: string;
    url: string;
  };
}

export interface RetryFailedHeadResult {
  repo: string;
  pullNumber: number;
  headSha: string;
  status: ReviewPullResult | "failed" | "dry_run" | "skipped_closed";
}

export interface FailedHeadRetryTarget {
  repo: string;
  pullNumber: number;
  headSha: string;
  previousStatus: "failed" | "skipped";
  previousError?: string;
}

export interface RetryProviderCooldownsResult {
  ok: boolean;
  checkedAt: string;
  dryRun: boolean;
  expiredOnly: boolean;
  limit: number;
  repo?: string;
  candidates: number;
  attempted: number;
  results: RetryFailedHeadResult[];
  summary: {
    reviewed: number;
    dryRun: number;
    remainedCooldown: number;
    failed: number;
    skippedStaleHead: number;
    skippedProcessed: number;
    skippedClosed: number;
    skippedCapacity: number;
    other: number;
  };
}

export type ProviderErrorCategory = "none" | "request_rate_limit" | "overloaded" | "quota_exhausted";

export interface ProviderErrorClassification {
  category: ProviderErrorCategory;
  providerCode?: string;
  providerRequestId?: string;
  retryAfterMs?: number;
  reason: string;
  retryable: boolean;
  cooldown: boolean;
}

export type ReviewPullResult =
  | "reviewed"
  | "reviewed_command"
  | "skipped_draft"
  | "skipped_canary"
  | "skipped_policy"
  | "skipped_command_stop"
  | "skipped_command_explain"
  | "skipped_finishing_touch_draft"
  | "skipped_processed"
  | "skipped_capacity"
  | "skipped_provider_cooldown"
  | "skipped_stale_head";

export function isSuccessfulRetryStatus(status: RetryFailedHeadResult["status"]): boolean {
  switch (status) {
    case "reviewed":
    case "reviewed_command":
    case "dry_run":
    case "skipped_processed":
    case "skipped_closed":
      return true;
    case "failed":
    case "skipped_draft":
    case "skipped_canary":
    case "skipped_policy":
    case "skipped_command_stop":
    case "skipped_command_explain":
    case "skipped_finishing_touch_draft":
    case "skipped_capacity":
    case "skipped_provider_cooldown":
    case "skipped_stale_head":
      return false;
    default:
      return assertNever(status);
  }
}

export function assertExpectedReviewPrHead(input: {
  repo: string;
  pullNumber: number;
  expectedHeadSha?: string;
  currentHeadSha?: string;
}): void {
  if (!input.expectedHeadSha) return;
  if (input.currentHeadSha === input.expectedHeadSha) return;
  throw new Error(
    `review-pr expected head mismatch for ${input.repo}#${input.pullNumber}: expected=${input.expectedHeadSha} current=${input.currentHeadSha ?? "unknown"}`
  );
}

export async function runOnce(options: RunOnceOptions): Promise<RunOnceResult> {
  const config = loadConfig(options.configPath);
  const github = new GitHubApi(config.github);
  const state = new ReviewStateStore(config.statePath);
  const budget = new ReviewRunBudget(config.reviewConcurrency.maxActiveRuns);
  const result: RunOnceResult = {
    reposScanned: 0,
    pullsSeen: 0,
    reviewed: 0,
    failed: 0,
    skippedDraft: 0,
    skippedCanary: 0,
    skippedPolicy: 0,
    skippedCommandStop: 0,
    skippedCommandExplain: 0,
    skippedFinishingTouchDraft: 0,
    commandReviewRequested: 0,
    skippedProcessed: 0,
    skippedCapacity: 0,
    skippedProviderCooldown: 0,
    skippedStaleHead: 0,
    baselinedExisting: 0,
    policySkips: []
  };
  try {
    const repos = options.repo ? [options.repo] : listReposToScan(config);
    for (const repo of repos) {
      result.reposScanned += 1;
      const repoPolicy = resolveRepoProfile(config, repo);
      if (!repoPolicy.allowed) {
        result.skippedPolicy += 1;
        result.policySkips.push({ repo, reason: repoPolicy.reason });
        continue;
      }
      const pulls = options.pullNumber
        ? [await github.getPull(repo, options.pullNumber)]
        : await github.listOpenPulls(repo);
      if (options.pullNumber) {
        assertExpectedReviewPrHead({
          repo,
          pullNumber: options.pullNumber,
          expectedHeadSha: options.expectedHeadSha,
          currentHeadSha: pulls[0]?.head.sha
        });
      }
      if (options.pullNumber && pulls[0]) {
        result.scopedPull = {
          repo,
          pullNumber: pulls[0].number,
          headSha: pulls[0].head.sha,
          title: pulls[0].title,
          url: pulls[0].html_url
        };
      }
      result.pullsSeen += pulls.length;
      const activation = activateRepoForNewOnlyReview({
        config,
        state,
        repo,
        pulls,
        scopedPullNumber: options.pullNumber
      });
      result.baselinedExisting += activation.baselined;
      for (const pull of pulls) {
        let status: ReviewPullResult;
        try {
          status = await reviewPull({
            config,
            github,
            state,
            repo,
            pull,
            dryRun: options.dryRun,
            useZCode: options.useZCode ?? true,
            budget,
            allowActivationBaselineCommandLookup: options.pullNumber !== undefined
          });
        } catch (error) {
          if (recordProviderRateLimitCooldownIfNeeded({ config, state, repo, pull, error })) {
            result.skippedProviderCooldown += 1;
            continue;
          }
          recordFailedReview({ config, state, repo, pull, error });
          result.failed += 1;
          continue;
        }
        if (status === "reviewed" || status === "reviewed_command") result.reviewed += 1;
        if (status === "skipped_draft") result.skippedDraft += 1;
        if (status === "skipped_canary") result.skippedCanary += 1;
        if (status === "skipped_policy") result.skippedPolicy += 1;
        if (status === "skipped_command_stop") result.skippedCommandStop += 1;
        if (status === "skipped_command_explain") result.skippedCommandExplain += 1;
        if (status === "skipped_finishing_touch_draft") result.skippedFinishingTouchDraft += 1;
        if (status === "reviewed_command") result.commandReviewRequested += 1;
        if (status === "skipped_processed") result.skippedProcessed += 1;
        if (status === "skipped_capacity") result.skippedCapacity += 1;
        if (status === "skipped_provider_cooldown") result.skippedProviderCooldown += 1;
        if (status === "skipped_stale_head") result.skippedStaleHead += 1;
      }
    }
    return result;
  } finally {
    state.close();
  }
}

export async function retryFailedHead(options: {
  configPath?: string;
  repo: string;
  pullNumber: number;
  headSha: string;
  dryRun: boolean;
  useZCode?: boolean;
}): Promise<RetryFailedHeadResult> {
  const config = loadConfig(options.configPath);
  const github = new GitHubApi(config.github);
  const state = new ReviewStateStore(config.statePath);
  const budget = new ReviewRunBudget(1);
  try {
    return await retryFailedHeadWithDeps({ config, github, state, budget, options, reviewPullImpl: reviewPull });
  } finally {
    state.close();
  }
}

export async function retryProviderCooldowns(options: {
  configPath?: string;
  repo?: string;
  limit?: number;
  expiredOnly?: boolean;
  dryRun: boolean;
  useZCode?: boolean;
}): Promise<RetryProviderCooldownsResult> {
  const config = loadConfig(options.configPath);
  const github = new GitHubApi(config.github);
  const state = new ReviewStateStore(config.statePath);
  const budget = new ReviewRunBudget(1);
  try {
    return await retryProviderCooldownsWithDeps({
      config,
      github,
      state,
      budget,
      options,
      reviewPullImpl: reviewPull
    });
  } finally {
    state.close();
  }
}

export async function retryProviderCooldownsWithDeps(input: {
  config: BotConfig;
  github: GitHubApi;
  state: ReviewStateStore;
  budget: ReviewRunBudget;
  options: {
    repo?: string;
    limit?: number;
    expiredOnly?: boolean;
    dryRun: boolean;
    useZCode?: boolean;
  };
  reviewPullImpl: (input: ReviewPullInput) => Promise<ReviewPullResult>;
}): Promise<RetryProviderCooldownsResult> {
  const limit = input.options.limit ?? 5;
  if (!Number.isInteger(limit) || limit < 1) throw new Error("limit must be a positive integer");
  const expiredOnly = input.options.expiredOnly ?? true;
  const candidates = input.state.listProviderCooldownReviews({
    repo: input.options.repo,
    expiredOnly,
    limit,
    now: new Date()
  });
  const activeProviderCooldown = input.state.getActiveProviderCooldown(new Date());
  if (expiredOnly && candidates.length > 0 && activeProviderCooldown) {
    const results = candidates.map((candidate) => ({
      repo: candidate.repo,
      pullNumber: candidate.pullNumber,
      headSha: candidate.headSha,
      status: "skipped_provider_cooldown" as const
    }));
    const summary = summarizeRetryProviderCooldownResults(results);
    return {
      ok: true,
      checkedAt: new Date().toISOString(),
      dryRun: input.options.dryRun,
      expiredOnly,
      limit,
      ...(input.options.repo ? { repo: input.options.repo } : {}),
      candidates: candidates.length,
      attempted: 0,
      results,
      summary
    };
  }
  const results: RetryFailedHeadResult[] = [];
  for (const candidate of candidates) {
    const result = await retryFailedHeadWithDeps({
      config: input.config,
      github: input.github,
      state: input.state,
      budget: input.budget,
      options: {
        repo: candidate.repo,
        pullNumber: candidate.pullNumber,
        headSha: candidate.headSha,
        dryRun: input.options.dryRun,
        useZCode: input.options.useZCode
      },
      reviewPullImpl: input.reviewPullImpl
    });
    results.push(result);
  }

  const summary = summarizeRetryProviderCooldownResults(results);
  return {
    ok: summary.failed === 0 && summary.skippedCapacity === 0,
    checkedAt: new Date().toISOString(),
    dryRun: input.options.dryRun,
    expiredOnly,
    limit,
    ...(input.options.repo ? { repo: input.options.repo } : {}),
    candidates: candidates.length,
    attempted: results.length,
    results,
    summary
  };
}

export async function retryFailedHeadWithDeps(input: {
  config: BotConfig;
  github: GitHubApi;
  state: ReviewStateStore;
  budget: ReviewRunBudget;
  options: {
    repo: string;
    pullNumber: number;
    headSha: string;
    dryRun: boolean;
    useZCode?: boolean;
  };
  reviewPullImpl: (input: ReviewPullInput) => Promise<ReviewPullResult>;
}): Promise<RetryFailedHeadResult> {
  const { config, github, state, budget, options } = input;
  const repoPolicy = resolveRepoProfile(config, options.repo);
  if (!repoPolicy.allowed) {
    throw new Error(`Refusing retry for repo skipped by policy: ${options.repo} (${repoPolicy.reason})`);
  }
  const pull = await github.getPull(options.repo, options.pullNumber);
  if (isClosedPull(pull)) {
    recordClosedRetrySkip({ state, repo: options.repo, pull, headSha: options.headSha });
    updateRetryQueueJobsAfterRetry({
      state,
      repo: options.repo,
      pullNumber: options.pullNumber,
      headSha: options.headSha,
      status: "skipped_closed",
      dryRun: options.dryRun
    });
    await syncRetryReviewStatusComment({
      config,
      github,
      state,
      repo: options.repo,
      pull,
      headSha: options.headSha,
      status: "skipped_closed",
      dryRun: options.dryRun
    });
    return {
      repo: options.repo,
      pullNumber: options.pullNumber,
      headSha: options.headSha,
      status: "skipped_closed"
    };
  }
  const processed = state.getProcessedReview(options.repo, options.pullNumber, options.headSha);
  if (processed && processed.status !== "failed" && !isProviderCooldownProcessedReview(processed)) {
    updateRetryQueueJobsAfterRetry({
      state,
      repo: options.repo,
      pullNumber: options.pullNumber,
      headSha: options.headSha,
      status: "skipped_processed",
      dryRun: options.dryRun
    });
    await syncRetryReviewStatusComment({
      config,
      github,
      state,
      repo: options.repo,
      pull,
      headSha: options.headSha,
      status: "skipped_processed",
      dryRun: options.dryRun
    });
    return {
      repo: options.repo,
      pullNumber: options.pullNumber,
      headSha: options.headSha,
      status: "skipped_processed"
    };
  }
  if (pull.head.sha !== options.headSha) {
    const retryTarget = prepareRetryTargetFromProcessedRow({
      state,
      repo: options.repo,
      pullNumber: options.pullNumber,
      headSha: options.headSha
    });
    restoreFailedRetryRowIfNeeded({
      state,
      retryTarget,
      reason: "retry_did_not_review=skipped_stale_head"
    });
    updateRetryQueueJobsAfterRetry({
      state,
      repo: options.repo,
      pullNumber: options.pullNumber,
      headSha: options.headSha,
      status: "skipped_stale_head",
      dryRun: options.dryRun
    });
    await syncRetryReviewStatusComment({
      config,
      github,
      state,
      repo: options.repo,
      pull,
      headSha: options.headSha,
      status: "skipped_stale_head",
      dryRun: options.dryRun
    });
    return {
      repo: options.repo,
      pullNumber: options.pullNumber,
      headSha: options.headSha,
      status: "skipped_stale_head"
    };
  }
  const retryTarget = prepareFailedHeadRetry({
    state,
    repo: options.repo,
    pullNumber: options.pullNumber,
    headSha: options.headSha,
    livePull: pull
  });
  try {
    const retryReviewConfig: BotConfig = {
      ...config,
      reviewConcurrency: {
        ...config.reviewConcurrency,
        maxActiveRuns: 1
      }
    };
    const status = await input.reviewPullImpl({
      config: retryReviewConfig,
      github,
      state,
      repo: options.repo,
      pull,
      dryRun: options.dryRun,
      useZCode: options.useZCode ?? true,
      budget,
      processedHeadPolicy: "retry_failed_head"
    });
    const retryStatus = options.dryRun && (status === "reviewed" || status === "reviewed_command") ? "dry_run" : status;
    // A retry dry-run is a successful inspection, but the original row must remain retryable for the later live run.
    updateRetryQueueJobsAfterRetry({
      state,
      repo: options.repo,
      pullNumber: options.pullNumber,
      headSha: options.headSha,
      status: retryStatus,
      dryRun: options.dryRun
    });
    await syncRetryReviewStatusComment({
      config,
      github,
      state,
      repo: options.repo,
      pull,
      headSha: options.headSha,
      status: retryStatus,
      dryRun: options.dryRun
    });
    restoreFailedRetryRowIfNeeded({
      state,
      retryTarget,
      reason: retryStatus === "dry_run" ? "retry_dry_run" : `retry_did_not_review=${retryStatus}`
    });
    return {
      repo: options.repo,
      pullNumber: options.pullNumber,
      headSha: options.headSha,
      status: retryStatus
    };
  } catch (error) {
    if (recordProviderRateLimitCooldownIfNeeded({
      config,
      state,
      repo: options.repo,
      pull,
      error: retryFailureError(retryTarget.previousError, error)
    })) {
      updateRetryQueueJobsAfterRetry({
        state,
        repo: options.repo,
        pullNumber: options.pullNumber,
        headSha: options.headSha,
        status: "skipped_provider_cooldown",
        dryRun: options.dryRun
      });
      await syncRetryReviewStatusComment({
        config,
        github,
        state,
        repo: options.repo,
        pull,
        headSha: options.headSha,
        status: "skipped_provider_cooldown",
        dryRun: options.dryRun
      });
      return {
        repo: options.repo,
        pullNumber: options.pullNumber,
        headSha: options.headSha,
        status: "skipped_provider_cooldown"
      };
    }
    recordFailedReview({
      config,
      state,
      repo: options.repo,
      pull,
      error: retryFailureError(retryTarget.previousError, error)
    });
    updateRetryQueueJobsAfterRetry({
      state,
      repo: options.repo,
      pullNumber: options.pullNumber,
      headSha: options.headSha,
      status: "failed",
      dryRun: options.dryRun
    });
    await syncRetryReviewStatusComment({
      config,
      github,
      state,
      repo: options.repo,
      pull,
      headSha: options.headSha,
      status: "failed",
      dryRun: options.dryRun
    });
    return {
      repo: options.repo,
      pullNumber: options.pullNumber,
      headSha: options.headSha,
      status: "failed"
    };
  }
}

async function syncRetryReviewStatusComment(input: {
  config: BotConfig;
  github: GitHubApi;
  state: ReviewStateStore;
  repo: string;
  pull: PullRequestSummary;
  headSha: string;
  status: RetryFailedHeadResult["status"];
  dryRun: boolean;
}): Promise<void> {
  if (!isReviewStatusCommentGithub(input.github)) return;
  const processed = input.state.getProcessedReview(input.repo, input.pull.number, input.headSha);
  const state = retryStatusCommentState(input.status, processed?.status, processed?.error);
  if (!state) return;
  await postReviewStatusComment({
    enabled: input.config.reviewStatusComment?.enabled ?? false,
    dryRun: input.dryRun,
    github: input.github,
    repo: input.repo,
    pullNumber: input.pull.number,
    headSha: input.headSha,
    state,
    pullTitle: input.pull.title,
    pullUrl: input.pull.html_url,
    ...(processed?.reviewUrl ? { reviewUrl: processed.reviewUrl } : {}),
    ...(state === "failed" ? { details: "Review failed; see bot evidence for operator-only details." } : {})
  });
}

function isReviewStatusCommentGithub(github: GitHubApi): github is GitHubApi & ReviewStatusCommentGithub {
  const candidate = github as Partial<ReviewStatusCommentGithub>;
  return typeof candidate.canPostAsApp === "function" && typeof candidate.upsertIssueComment === "function";
}

function retryStatusCommentState(
  status: RetryFailedHeadResult["status"],
  processedStatus?: ProcessedStatus,
  processedError?: string
): ReviewStatusCommentState | undefined {
  switch (status) {
    case "reviewed":
    case "reviewed_command":
      return "completed";
    case "dry_run":
      return undefined;
    case "skipped_processed":
      if (processedStatus === "posted") return "completed";
      if (processedStatus === "skipped" && processedError && parseProviderCooldownError(processedError)) {
        return "provider_deferred";
      }
      if (processedStatus === "skipped") return "skipped";
      return undefined;
    case "skipped_provider_cooldown":
      return "provider_deferred";
    case "skipped_stale_head":
      return "stale_head";
    case "skipped_closed":
      return "closed_or_merged_before_review";
    case "failed":
      return "failed";
    case "skipped_capacity":
      return "provider_deferred";
    case "skipped_draft":
    case "skipped_canary":
    case "skipped_policy":
    case "skipped_command_stop":
    case "skipped_command_explain":
    case "skipped_finishing_touch_draft":
      return undefined;
    default:
      return assertNever(status);
  }
}

function updateRetryQueueJobsAfterRetry(input: {
  state: ReviewStateStore;
  repo: string;
  pullNumber: number;
  headSha: string;
  status: RetryFailedHeadResult["status"];
  dryRun: boolean;
}): void {
  const retryStates: ReviewQueueJobState[] = ["queued", "leased", "running", "provider_deferred"];
  if (!input.dryRun) retryStates.push("failed");
  const activeJobs = input.state
    .listReviewQueueJobsForPull({
      repo: input.repo,
      pullNumber: input.pullNumber,
      states: retryStates
    })
    .filter((job) => job.headSha === input.headSha);
  const targetJobs = isRetryCommandRecordedStatus(input.status)
    ? activeJobs.filter((job) => job.source === "manual_command")
    : activeJobs;
  if (targetJobs.length === 0) return;

  const processed = input.state.getProcessedReview(input.repo, input.pullNumber, input.headSha);
  const providerCooldown = parseProviderCooldownError(processed?.error);
  const patch = retryQueuePatchForStatus({
    status: input.status,
    dryRun: input.dryRun,
    processedStatus: processed?.status,
    processedReviewUrl: processed?.reviewUrl,
    providerCooldownUntil: providerCooldown?.cooldownUntil,
    processedError: processed?.error
  });
  for (const job of targetJobs) {
    input.state.updateReviewQueueJobState({
      jobId: job.jobId,
      state: patch.state,
      ...(patch.nextEligibleAt ? { nextEligibleAt: patch.nextEligibleAt } : {}),
      ...(patch.reviewUrl ? { reviewUrl: patch.reviewUrl } : {}),
      lastError: patch.lastError
    });
    if (job.sessionId && patch.sessionJobState) {
      input.state.updateReviewerSessionJobState({
        repo: job.repo,
        pullNumber: job.pullNumber,
        headSha: job.headSha,
        jobState: patch.sessionJobState,
        ...(patch.sessionProcessedStatus ? { processedReviewStatus: patch.sessionProcessedStatus } : {})
      });
    }
  }
}

function retryQueuePatchForStatus(input: {
  status: RetryFailedHeadResult["status"];
  dryRun: boolean;
  processedStatus?: ProcessedStatus;
  processedReviewUrl?: string;
  providerCooldownUntil?: string;
  processedError?: string;
}): {
  state: ReviewQueueJobState;
  nextEligibleAt?: string;
  reviewUrl?: string;
  lastError: string;
  sessionJobState?: ReviewerSessionJobState;
  sessionProcessedStatus?: ProcessedStatus;
} {
  switch (input.status) {
    case "reviewed":
    case "reviewed_command":
      return input.dryRun
        ? {
            state: "queued",
            lastError: "retry_dry_run_completed_not_posted",
            sessionJobState: "completed",
            sessionProcessedStatus: "dry_run"
          }
        : {
            state: "posted",
            ...(input.processedReviewUrl ? { reviewUrl: input.processedReviewUrl } : {}),
            lastError: input.status,
            sessionJobState: "completed",
            sessionProcessedStatus: "posted"
          };
    case "dry_run":
      return {
        state: "queued",
        lastError: "retry_dry_run_completed_not_posted",
        sessionJobState: "completed",
        sessionProcessedStatus: "dry_run"
      };
    case "skipped_provider_cooldown":
      return {
        state: "provider_deferred",
        ...(input.providerCooldownUntil ? { nextEligibleAt: input.providerCooldownUntil } : {}),
        lastError: input.processedError ?? "provider_deferred_without_cooldown",
        sessionJobState: "assigned"
      };
    case "skipped_stale_head":
      return {
        state: "stale_retired",
        lastError: "retry_did_not_review=skipped_stale_head",
        sessionJobState: "skipped",
        sessionProcessedStatus: "skipped"
      };
    case "skipped_closed":
      return {
        state: "closed_retired",
        lastError: "retry_did_not_review=skipped_closed",
        sessionJobState: "skipped",
        sessionProcessedStatus: "skipped"
      };
    case "skipped_capacity":
      return {
        state: "queued",
        lastError: "retry_did_not_review=skipped_capacity",
        sessionJobState: "assigned"
      };
    case "skipped_processed":
      return input.processedError && parseProviderCooldownError(input.processedError)
        ? {
            state: "provider_deferred",
            ...(input.providerCooldownUntil ? { nextEligibleAt: input.providerCooldownUntil } : {}),
            lastError: input.processedError,
            sessionJobState: "assigned",
            ...(input.processedStatus ? { sessionProcessedStatus: input.processedStatus } : {})
          }
        : {
            state: retryQueueJobStateForProcessedStatus(input.processedStatus, input.dryRun),
            ...(input.processedReviewUrl ? { reviewUrl: input.processedReviewUrl } : {}),
            lastError: `retry_did_not_review=skipped_processed:${input.processedStatus ?? "unknown"}`,
            sessionJobState: reviewerSessionJobStateForProcessedStatus(input.processedStatus),
            ...(input.processedStatus ? { sessionProcessedStatus: input.processedStatus } : {})
          };
    case "skipped_command_stop":
    case "skipped_command_explain":
    case "skipped_finishing_touch_draft":
      return {
        state: "command_recorded",
        lastError: retryQueueCommandRecordedReason(input.status),
        sessionJobState: "skipped",
        sessionProcessedStatus: "skipped"
      };
    case "failed":
    case "skipped_draft":
    case "skipped_canary":
    case "skipped_policy":
      return {
        state: "failed",
        lastError: `retry_did_not_review=${input.status}`,
        sessionJobState: "failed",
        sessionProcessedStatus: "failed"
      };
    default:
      return assertNever(input.status);
  }
}

function retryQueueJobStateForProcessedStatus(status: ProcessedStatus | undefined, dryRun: boolean): ReviewQueueJobState {
  switch (status) {
    case "posted":
      return "posted";
    case "dry_run":
      return "queued";
    case "failed":
      return "failed";
    case "skipped":
      return "stale_retired";
    case undefined:
      return "queued";
    default:
      return assertNever(status);
  }
}

function reviewerSessionJobStateForProcessedStatus(status: ProcessedStatus | undefined): ReviewerSessionJobState {
  switch (status) {
    case "posted":
    case "dry_run":
      return "completed";
    case "failed":
      return "failed";
    case "skipped":
      return "skipped";
    case undefined:
      return "assigned";
    default:
      return assertNever(status);
  }
}

function isRetryCommandRecordedStatus(
  status: RetryFailedHeadResult["status"]
): status is Extract<
  RetryFailedHeadResult["status"],
  "skipped_command_stop" | "skipped_command_explain" | "skipped_finishing_touch_draft"
> {
  return status === "skipped_command_stop" ||
    status === "skipped_command_explain" ||
    status === "skipped_finishing_touch_draft";
}

function retryQueueCommandRecordedReason(status: Extract<
  RetryFailedHeadResult["status"],
  "skipped_command_stop" | "skipped_command_explain" | "skipped_finishing_touch_draft"
>): string {
  switch (status) {
    case "skipped_command_stop":
      return "manual_command_stop_recorded";
    case "skipped_command_explain":
      return "manual_command_explain_recorded";
    case "skipped_finishing_touch_draft":
      return "manual_command_finishing_touch_draft_recorded";
    default:
      return assertNever(status);
  }
}

export function restoreFailedRetryRowIfNeeded(input: {
  state: Pick<ReviewStateStore, "getProcessedReview" | "recordProcessed">;
  retryTarget: FailedHeadRetryTarget;
  reason: string;
}): void {
  const current = input.state.getProcessedReview(
    input.retryTarget.repo,
    input.retryTarget.pullNumber,
    input.retryTarget.headSha
  );
  if (current?.status === "posted") return;
  if (current?.status === "failed") return;

  const restoreAsProviderCooldown =
    input.retryTarget.previousStatus === "skipped" &&
    Boolean(parseProviderCooldownError(input.retryTarget.previousError));
  const retireStaleProviderCooldown =
    restoreAsProviderCooldown &&
    input.reason === "retry_did_not_review=skipped_stale_head";
  const previousError = input.retryTarget.previousError
    ? `${retireStaleProviderCooldown ? "; previous_error=" : ""}${input.retryTarget.previousError}`
    : "";
  input.state.recordProcessed({
    repo: input.retryTarget.repo,
    pullNumber: input.retryTarget.pullNumber,
    headSha: input.retryTarget.headSha,
    status: restoreAsProviderCooldown ? "skipped" : "failed",
    error: retireStaleProviderCooldown
      ? `provider_cooldown_retry_stale_head; ${input.reason}${previousError}`
      : input.retryTarget.previousError
        ? `${input.retryTarget.previousError}; ${input.reason}`
        : input.reason
  });
}

export function prepareFailedHeadRetry(input: {
  state: Pick<ReviewStateStore, "getProcessedReview">;
  repo: string;
  pullNumber: number;
  headSha: string;
  livePull: PullRequestSummary;
}): FailedHeadRetryTarget {
  if (input.livePull.head.sha !== input.headSha) {
    throw new Error(`Refusing retry for stale head: requested=${input.headSha} live=${input.livePull.head.sha}`);
  }

  return prepareRetryTargetFromProcessedRow(input);
}

function prepareRetryTargetFromProcessedRow(input: {
  state: Pick<ReviewStateStore, "getProcessedReview">;
  repo: string;
  pullNumber: number;
  headSha: string;
}): FailedHeadRetryTarget {
  const processed = input.state.getProcessedReview(input.repo, input.pullNumber, input.headSha);
  if (!processed) {
    throw new Error(`No processed review row exists for ${input.repo}#${input.pullNumber}@${input.headSha}`);
  }
  if (processed.status !== "failed" && !isProviderCooldownProcessedReview(processed)) {
    throw new Error(
      `Refusing retry for ${input.repo}#${input.pullNumber}@${input.headSha}: status is ${processed.status}, not failed/provider-cooldown`
    );
  }

  return {
    repo: input.repo,
    pullNumber: input.pullNumber,
    headSha: input.headSha,
    previousStatus: processed.status === "skipped" ? "skipped" : "failed",
    ...(processed.error ? { previousError: processed.error } : {})
  };
}

export interface ReviewPullInput {
  config: BotConfig;
  github: GitHubApi;
  state: ReviewStateStore;
  repo: string;
  pull: PullRequestSummary;
  dryRun: boolean;
  useZCode: boolean;
  budget?: ReviewRunBudget;
  processedHeadPolicy?: "normal" | "retry_failed_head";
  commandCommentId?: number;
  allowActivationBaselineCommandLookup?: boolean;
}

export async function reviewPull(input: ReviewPullInput): Promise<ReviewPullResult> {
  const { config, github, state, repo, pull } = input;
  const repoPolicy = resolveRepoProfile(config, repo);
  if (!repoPolicy.allowed) return "skipped_policy";
  if (config.skipDrafts && pull.draft) return "skipped_draft";
  if (!isCanaryAllowed(config, repo, pull.number)) return "skipped_canary";

  const processed = getProcessedReviewIfAvailable(state, repo, pull.number, pull.head.sha);
  if (
    input.processedHeadPolicy !== "retry_failed_head" &&
    !input.allowActivationBaselineCommandLookup &&
    !processed &&
    isPreActivationExistingPull({ config, state, repo, pull })
  ) {
    recordActivationBaselineExistingHead(state, repo, pull);
    backfillActivationBaselineReadinessFromProcessedHead(state, repo, pull);
    return "skipped_processed";
  }
  if (
    input.processedHeadPolicy !== "retry_failed_head" &&
    !input.allowActivationBaselineCommandLookup &&
    isActivationBaselineProcessedReview(processed)
  ) {
    return "skipped_processed";
  }

  const commandDecision = await resolvePullCommandDecision({
    config,
    github,
    state,
    repo,
    pull,
    commandCommentId: input.commandCommentId
  });
  if (commandDecision.action === "stop") {
    await recordAndAcknowledgeCommandDecision({ config, github, state, repo, pull, commandDecision });
    return "skipped_command_stop";
  }
  if (commandDecision.action === "explain") {
    await recordAndAcknowledgeCommandDecision({ config, github, state, repo, pull, commandDecision });
    return "skipped_command_explain";
  }
  const finishingTouchDecision = commandDecision.action !== "none" && isFinishingTouchCommandAction(commandDecision.action)
    ? commandDecision
    : undefined;
  if (finishingTouchDecision) {
    const finishingTouchAction: FinishingTouchAction = finishingTouchDecision.action as FinishingTouchAction;
    const livePull = await github.getPull(repo, pull.number);
    const stale = detectStalePullHead({ expected: pull, live: livePull, phase: "before_command" });
    const evidenceDir = buildEvidenceDir(config, repo, pull, finishingTouchDecision);
    if (stale) {
      mkdirSync(evidenceDir, { recursive: true });
      writeRedactedJson(join(evidenceDir, "finishing-touch-rejected.json"), {
        ok: false,
        reason: "stale_head",
        detail: `Command targeted ${pull.head.sha}/${pull.base.sha}, but current PR is ${livePull.head.sha}/${livePull.base.sha}.`,
        stale
      });
      state.recordFinishingTouchDraft({
        repo,
        pullNumber: pull.number,
        headSha: pull.head.sha,
        commandCommentId: finishingTouchDecision.commandId,
        action: finishingTouchAction,
        author: finishingTouchDecision.command.author,
        trigger: finishingTouchDecision.command.body,
        status: "rejected",
        proposedOutput: {
          ok: false,
          reason: "stale_head",
          stale
        }
      });
      await recordAndAcknowledgeCommandDecision({
        config,
        github,
        state,
        repo,
        pull,
        commandDecision: finishingTouchDecision,
        acknowledge: false
      });
      return "skipped_finishing_touch_draft";
    }
    mkdirSync(evidenceDir, { recursive: true });
    const draft = buildFinishingTouchDraft({
      repo,
      pullNumber: pull.number,
      headSha: pull.head.sha,
      action: finishingTouchAction,
      author: finishingTouchDecision.command.author,
      commentId: finishingTouchDecision.commandId,
      trigger: finishingTouchDecision.command.body
    });
    const validation = validateFinishingTouchRequest({
      repo,
      pullNumber: pull.number,
      headSha: pull.head.sha,
      currentHeadSha: livePull.head.sha,
      commentId: finishingTouchDecision.commandId,
      author: finishingTouchDecision.command.author,
      trustedAuthors: config.commands.trustedAuthors,
      worktreeClean: isExistingPullWorktreeClean(config, repo, pull),
      action: finishingTouchAction,
      proposedOutput: draft
    });
    if (!validation.ok) {
      state.recordFinishingTouchDraft({
        repo,
        pullNumber: pull.number,
        headSha: pull.head.sha,
        commandCommentId: finishingTouchDecision.commandId,
        action: finishingTouchAction,
        author: finishingTouchDecision.command.author,
        trigger: finishingTouchDecision.command.body,
        status: "rejected",
        proposedOutput: validation
      });
      await recordAndAcknowledgeCommandDecision({
        config,
        github,
        state,
        repo,
        pull,
        commandDecision: finishingTouchDecision,
        acknowledge: false
      });
      writeRedactedJson(join(evidenceDir, "finishing-touch-rejected.json"), validation);
      return "skipped_finishing_touch_draft";
    }
    const stored = state.recordFinishingTouchDraft({
      repo,
      pullNumber: pull.number,
      headSha: pull.head.sha,
      commandCommentId: finishingTouchDecision.commandId,
      action: finishingTouchAction,
      author: finishingTouchDecision.command.author,
      trigger: finishingTouchDecision.command.body,
      status: "drafted",
      proposedOutput: draft
    });
    await recordAndAcknowledgeCommandDecision({
      config,
      github,
      state,
      repo,
      pull,
      commandDecision: finishingTouchDecision,
      acknowledge: false
    });
    writeRedactedJson(join(evidenceDir, "finishing-touch-draft.json"), { draft, stored });
    writeFileSync(join(evidenceDir, "finishing-touch-draft.md"), draft.markdown);
    return "skipped_finishing_touch_draft";
  }

  const commandReviewRequested = commandDecision.shouldReview;
  if (commandReviewRequested) {
    const livePull = await github.getPull(repo, pull.number);
    const stale = detectStalePullHead({ expected: pull, live: livePull, phase: "before_review" });
    if (stale) {
      const evidenceDir = buildEvidenceDir(config, repo, pull, commandDecision);
      recordStaleHeadSkip({ state, repo, pull, stale, evidenceDir });
      return "skipped_stale_head";
    }
  }
  if (
    input.processedHeadPolicy !== "retry_failed_head" &&
    !commandReviewRequested &&
    (processed || state.hasProcessed(repo, pull.number, pull.head.sha))
  ) {
    return "skipped_processed";
  }
  const activeCooldown = config.providerCooldown.enabled && typeof state.getActiveRepoProviderCooldown === "function"
    ? state.getActiveRepoProviderCooldown(repo)
    : undefined;
  if (activeCooldown && input.processedHeadPolicy !== "retry_failed_head") {
    recordProviderCooldownSkip({
      state,
      repo,
      pull,
      cooldownUntil: activeCooldown.cooldownUntil,
      reason: activeCooldown.reason
    });
    return "skipped_provider_cooldown";
  }
  const budget = input.budget ?? new ReviewRunBudget(config.reviewConcurrency.maxActiveRuns);
  if (!budget.tryStart()) return "skipped_capacity";
  let lease: ReviewRunLease | undefined;

  try {
    lease = state.tryAcquireReviewRunLease(config.reviewConcurrency.maxActiveRuns, config.reviewConcurrency.leaseTtlMs);
    if (!lease) return "skipped_capacity";
    const evidenceDir = buildEvidenceDir(config, repo, pull, commandDecision);
    if (input.processedHeadPolicy === "retry_failed_head") {
      const current = state.getProcessedReview(repo, pull.number, pull.head.sha);
      if (current?.status !== "failed" && !isProviderCooldownProcessedReview(current ?? { status: "" })) {
        return "skipped_processed";
      }
      const liveBeforeReview = await github.getPull(repo, pull.number);
      const staleBeforeReview = detectStalePullHead({ expected: pull, live: liveBeforeReview, phase: "before_review" });
      if (staleBeforeReview) {
        recordStaleHeadSkip({ state, repo, pull, stale: staleBeforeReview, evidenceDir });
        return "skipped_stale_head";
      }
    }
    if (commandReviewRequested) {
      await recordAndAcknowledgeCommandDecision({ config, github, state, repo, pull, commandDecision });
    }

    mkdirSync(evidenceDir, { recursive: true });

    const files = await github.listPullFiles(repo, pull.number);
    const reviewFiles = filterPullFilesForProfile(files, repoPolicy.profile);
    const filterImpact = buildPullFileFilterImpact(files, repoPolicy.profile);
    const validation = buildChangedSurfaceValidationReport({
      repo,
      pull,
      files,
      profile: repoPolicy.profile
    });
    const proof = evaluateProofRequirements({ pull, validation });
    const worktree = preparePullWorktree({
      repo,
      pullNumber: pull.number,
      expectedHeadSha: pull.head.sha,
      workRoot: config.workRoot,
      protectedCheckoutRoots: getProtectedCheckoutRoots()
    });
    const repoMemory = buildRepoMemoryContext({
      config,
      state,
      repo,
      evidenceDir
    });
    const skillPackContext = buildSkillPackContext({
      config,
      evidenceDir
    });
    const gitnexusContext = buildGitNexusContext({
      config,
      repo,
      pull,
      files: reviewFiles,
      evidenceDir
    });
    const githubRelatedContext = await buildGitHubRelatedContext({
      config,
      github: createGitHubRelatedContextReader(config, github),
      repo,
      pull,
      evidenceDir
    });

    const prompt = buildReviewPrompt({
      repo,
      pull,
      files: reviewFiles,
      repoProfile: repoPolicy.profile,
      ...(skillPackContext.packet ? { skillPackContextPacket: skillPackContext.packet } : {}),
      ...(repoMemory.packet ? { repoMemoryPacket: repoMemory.packet } : {}),
      ...(gitnexusContext.packet ? { gitnexusContextPacket: gitnexusContext.packet } : {}),
      ...(githubRelatedContext.packet ? { githubRelatedContextPacket: githubRelatedContext.packet } : {}),
      maxPatchBytes: config.zcode.maxPatchBytes
    });
    writeFileSync(join(evidenceDir, "repo-profile.json"), `${JSON.stringify(repoPolicy.profile, null, 2)}\n`);
    writeFileSync(join(evidenceDir, "filter-impact.json"), `${JSON.stringify(filterImpact, null, 2)}\n`);
    if (commandDecision.action !== "none") {
      writeFileSync(join(evidenceDir, "command.json"), `${JSON.stringify(commandDecision.command, null, 2)}\n`);
    }
    writeFileSync(join(evidenceDir, "review-prompt.txt"), redactSecrets(prompt));
    writeRedactedJson(join(evidenceDir, "validation-selector.json"), validation);
    writeRedactedJson(join(evidenceDir, "proof-requirements.json"), proof);

    const zcodeResult = input.useZCode
      ? await runZCodeReviewWithProviderRetry({
          config,
          worktreePath: worktree.path,
          prompt,
          evidenceDir
        })
      : { findings: [], droppedFromSchema: [], rawResponse: "{\"findings\":[]}" };

    assertGitClean(worktree.path);

    const liveBeforePlan = await github.getPull(repo, pull.number);
    const staleBeforePlan = detectStalePullHead({ expected: pull, live: liveBeforePlan, phase: "before_plan" });
    if (staleBeforePlan) {
      recordStaleHeadSkip({ state, repo, pull, stale: staleBeforePlan, evidenceDir });
      return "skipped_stale_head";
    }

    const gate = applyDeterministicReviewGate({
      findings: zcodeResult.findings,
      files: reviewFiles,
      droppedFromSchema: zcodeResult.droppedFromSchema,
      maxInlineComments: 25,
      repoMemoryFalsePositiveFingerprints: repoMemory.falsePositiveFingerprints
    });
    const comments = gate.comments;
    const dropped = sanitizeDroppedFindings(gate.dropped);
    const event = gate.event;
    writeRedactedJson(join(evidenceDir, "deterministic-gate.json"), { ...gate, dropped });
    const summary = buildSummary({
      repo,
      pull,
      comments,
      dropped,
      dryRun: input.dryRun,
      commandDecision
    });
    const walkthrough = config.walkthrough.enabled
      ? buildWalkthroughComment({
          repo,
          pull,
          files: reviewFiles,
          comments,
          dropped,
          event,
          validation,
          proof,
          postIssueComment: config.walkthrough.postIssueComment
        })
      : undefined;
    const enrichment = config.enrichment?.enabled
      ? buildEnrichmentComment({
          repo,
          pull,
          files: reviewFiles,
          suggestedLabels: repoPolicy.profile.suggestedLabels,
          suggestedReviewers: repoPolicy.profile.suggestedReviewers,
          validationSuggestions: validation.recommendations.map((recommendation) => `${recommendation.title}: ${recommendation.reason}`),
          maxRelatedRefs: config.enrichment.maxRelatedRefs,
          maxSuggestions: config.enrichment.maxSuggestions,
          postIssueComment: config.enrichment.postIssueComment
        })
      : undefined;
    const plan: ReviewPlan = {
      event,
      comments,
      dropped,
      summary,
      deterministicGate: gate.summary,
      validation,
      proof,
      ...(walkthrough ? { walkthrough } : {}),
      ...(enrichment ? { enrichment } : {})
    };

    if (walkthrough) writeFileSync(join(evidenceDir, "walkthrough.md"), walkthrough.body);
    if (enrichment) writeFileSync(join(evidenceDir, "enrichment.md"), enrichment.body);
    writeFileSync(join(evidenceDir, "review-plan.json"), `${JSON.stringify(plan, null, 2)}\n`);

    if (input.dryRun) {
      state.recordProcessed({ repo, pullNumber: pull.number, headSha: pull.head.sha, status: "dry_run", event });
      return commandReviewRequested ? "reviewed_command" : "reviewed";
    }

    const liveBeforePost = await github.getPull(repo, pull.number);
    const staleBeforePost = detectStalePullHead({ expected: pull, live: liveBeforePost, phase: "before_post" });
    if (staleBeforePost) {
      recordStaleHeadSkip({ state, repo, pull, stale: staleBeforePost, evidenceDir });
      return "skipped_stale_head";
    }

    const reviewGithub = new GitHubApi(config.github);
    plan.walkthroughComment = await postWalkthroughComment({
      github: reviewGithub,
      repo,
      pullNumber: pull.number,
      evidenceDir,
      walkthrough: plan.walkthrough
    });
    plan.enrichmentComment = await postEnrichmentComment({
      enabled: config.enrichment?.enabled === true,
      dryRun: input.dryRun,
      github: reviewGithub,
      repo,
      pullNumber: pull.number,
      enrichment: plan.enrichment,
      evidenceDir
    });
    writeFileSync(join(evidenceDir, "review-plan.json"), `${JSON.stringify(plan, null, 2)}\n`);
    const review = await reviewGithub.createReview({
      repo,
      pullNumber: pull.number,
      event,
      body: reviewBodyAfterWalkthroughPost(plan),
      comments
    });
    state.recordProcessed({
      repo,
      pullNumber: pull.number,
      headSha: pull.head.sha,
      status: "posted",
      event,
      reviewUrl: review.html_url
    });
    return commandReviewRequested ? "reviewed_command" : "reviewed";
  } finally {
    if (lease) state.releaseReviewRunLease(lease.leaseId);
    budget.finish();
  }
}

function recordActivationBaselineExistingHead(state: ReviewStateStore, repo: string, pull: PullRequestSummary): void {
  if (state.hasProcessed(repo, pull.number, pull.head.sha)) return;
  state.recordProcessed({
    repo,
    pullNumber: pull.number,
    headSha: pull.head.sha,
    status: "skipped",
    error: ACTIVATION_BASELINE_EXISTING_HEAD_ERROR
  });
}

function backfillActivationBaselineReadinessFromProcessedHead(
  state: ReviewStateStore,
  repo: string,
  pull: PullRequestSummary
): void {
  const processed = getProcessedReviewIfAvailable(state, repo, pull.number, pull.head.sha);
  if (!isActivationBaselineProcessedReview(processed)) return;
  const existing = state.getReviewReadiness(repo, pull.number, pull.head.sha);
  if (existing?.state === "skipped" && existing.reason === ACTIVATION_BASELINE_EXISTING_HEAD_ERROR) return;
  state.recordReviewReadiness({
    repo,
    pullNumber: pull.number,
    headSha: pull.head.sha,
    state: "skipped",
    reason: ACTIVATION_BASELINE_EXISTING_HEAD_ERROR
  });
}

function getProcessedReviewIfAvailable(
  state: ReviewStateStore,
  repo: string,
  pullNumber: number,
  headSha: string
): StoredProcessedReviewRecord | undefined {
  const lookup = (state as Partial<Pick<ReviewStateStore, "getProcessedReview">>).getProcessedReview;
  return typeof lookup === "function" ? lookup.call(state, repo, pullNumber, headSha) : undefined;
}

export function activateRepoForNewOnlyReview(input: {
  config: Pick<BotConfig, "activation" | "canaryPulls" | "skipDrafts">;
  state: Pick<ReviewStateStore, "hasProcessed" | "hasRepoActivation" | "recordRepoActivation" | "recordProcessed">;
  repo: string;
  pulls: PullRequestSummary[];
  scopedPullNumber?: number;
  now?: Date;
}): { activated: boolean; baselined: number } {
  const { config, state, repo, pulls } = input;
  if (input.scopedPullNumber !== undefined) return { activated: false, baselined: 0 };
  const repoHasCanaryOverride = (config.canaryPulls ?? []).some((entry) => entry.startsWith(`${repo}#`));
  if (repoHasCanaryOverride) return { activated: false, baselined: 0 };
  if (state.hasRepoActivation(repo)) return { activated: false, baselined: 0 };

  if (config.activation.reviewExistingOpenPrsOnActivation) {
    state.recordRepoActivation(repo, (input.now ?? new Date()).toISOString());
    return { activated: true, baselined: 0 };
  }

  let baselined = 0;
  for (const pull of pulls) {
    if (config.skipDrafts && pull.draft) continue;
    if (state.hasProcessed(repo, pull.number, pull.head.sha)) continue;
    state.recordProcessed({
      repo,
      pullNumber: pull.number,
      headSha: pull.head.sha,
      status: "skipped",
      error: ACTIVATION_BASELINE_EXISTING_HEAD_ERROR
    });
    baselined += 1;
  }
  state.recordRepoActivation(repo, (input.now ?? new Date()).toISOString());
  return { activated: true, baselined };
}

export function isCanaryAllowed(config: Pick<BotConfig, "canaryPulls">, repo: string, pullNumber: number): boolean {
  if (!config.canaryPulls || config.canaryPulls.length === 0) return true;
  return new Set(config.canaryPulls).has(`${repo}#${pullNumber}`);
}

export type StaleHeadPhase = "before_command" | "before_review" | "before_plan" | "before_post";

export interface StaleHeadEvidence {
  reason: `stale_head_${StaleHeadPhase}`;
  expectedHeadSha: string;
  liveHeadSha: string;
  expectedBaseSha: string;
  liveBaseSha: string;
}

export function detectStalePullHead(input: {
  expected: PullRequestSummary;
  live: PullRequestSummary;
  phase: StaleHeadPhase;
}): StaleHeadEvidence | undefined {
  if (input.expected.head.sha === input.live.head.sha && input.expected.base.sha === input.live.base.sha) return undefined;
  return {
    reason: `stale_head_${input.phase}`,
    expectedHeadSha: input.expected.head.sha,
    liveHeadSha: input.live.head.sha,
    expectedBaseSha: input.expected.base.sha,
    liveBaseSha: input.live.base.sha
  };
}

function buildEvidenceDir(
  config: BotConfig,
  repo: string,
  pull: PullRequestSummary,
  commandDecision: CommandDecision
): string {
  const evidenceBaseDir = join(config.evidenceDir, localDateFolder(), repo.replace("/", "__"), `pr-${pull.number}`, pull.head.sha);
  return commandDecision.action !== "none" ? join(evidenceBaseDir, `command-${commandDecision.commandId}`) : evidenceBaseDir;
}

function isExistingPullWorktreeClean(config: BotConfig, repo: string, pull: PullRequestSummary): boolean {
  const paths = planPullWorktreePaths({
    repo,
    pullNumber: pull.number,
    expectedHeadSha: pull.head.sha,
    workRoot: config.workRoot,
    protectedCheckoutRoots: getProtectedCheckoutRoots()
  });
  if (!existsSync(paths.worktreePath)) return true;
  try {
    assertGitClean(paths.worktreePath);
    return true;
  } catch {
    return false;
  }
}

export function buildRepoMemoryContext(input: {
  config: BotConfig;
  state: ReviewStateStore;
  repo: string;
  evidenceDir: string;
}): { packet?: RepoMemoryPacket; falsePositiveFingerprints: string[] } {
  const repoMemoryConfig = input.config.repoMemory;
  if (!repoMemoryConfig?.enabled) return { falsePositiveFingerprints: [] };

  const generatedAt = new Date().toISOString();
  const generatedAtDate = new Date(generatedAt);
  const promptNotes = input.state.listRepoMemoryNotes({
    repo: input.repo,
    includeExpired: repoMemoryConfig.includeStaleNotes,
    now: generatedAtDate,
    limit: repoMemoryConfig.maxStateNotes,
    excludeKind: "false_positive"
  });
  const falsePositiveNotes = input.state.listRepoMemoryNotes({
    repo: input.repo,
    includeExpired: repoMemoryConfig.includeStaleNotes,
    now: generatedAtDate,
    limit: repoMemoryConfig.maxStateNotes,
    kind: "false_positive"
  });
  const falsePositiveFingerprints = falsePositiveNotes
    .filter((note) => note.kind === "false_positive" && note.fingerprint && !isRepoMemoryNoteExpired(note, generatedAtDate))
    .map((note) => note.fingerprint!);
  const packetResult = buildRepoMemoryPacket({
    repo: input.repo,
    humanMarkdown: readRepoMemoryMarkdown(repoMemoryConfig.memoryRoot, input.repo),
    stateNotes: promptNotes,
    generatedAt,
    packetVersion: repoMemoryConfig.packetVersion,
    maxPacketBytes: repoMemoryConfig.maxPacketBytes,
    includeStaleNotes: repoMemoryConfig.includeStaleNotes
  });

  if (!packetResult.ok) {
    writeRedactedJson(join(input.evidenceDir, "repo-memory-packet-error.json"), packetResult);
    if (isRepoMemoryBudgetFailure(packetResult)) {
      return { falsePositiveFingerprints };
    }
    throw new Error(`Repo memory packet failed closed: ${packetResult.error}`);
  }

  writeRedactedJson(join(input.evidenceDir, "repo-memory-packet.json"), packetResult);
  writeFileSync(join(input.evidenceDir, "repo-memory-packet.md"), packetResult.packet.markdown);
  input.state.recordRepoMemoryPacketBuild({
    packetSha: packetResult.packet.sha256,
    repo: packetResult.packet.repo,
    packetVersion: packetResult.packet.packetVersion,
    generatedAt: packetResult.packet.generatedAt,
    byteEstimate: packetResult.packet.byteEstimate,
    tokenEstimate: packetResult.packet.tokenEstimate,
    includedNoteIds: packetResult.packet.sources.filter((source) => source.type === "sqlite_note").map((source) => source.id),
    redactionStatus: packetResult.redactionReport.ok ? "passed" : "failed",
    memoryRoot: repoMemoryConfig.memoryRoot
  });
  return { packet: packetResult.packet, falsePositiveFingerprints };
}

function isRepoMemoryBudgetFailure(packetResult: ReturnType<typeof buildRepoMemoryPacket>): boolean {
  return !packetResult.ok &&
    packetResult.redactionReport.ok &&
    packetResult.excluded.some((source) => source.reason === "budget_exceeded");
}

function isRepoMemoryNoteExpired(note: { expiresAt?: string }, now: Date): boolean {
  if (!note.expiresAt) return false;
  const expiresAtMs = Date.parse(note.expiresAt);
  return !Number.isFinite(expiresAtMs) || expiresAtMs <= now.getTime();
}

export function buildGitNexusContext(input: {
  config: BotConfig;
  repo: string;
  pull: PullRequestSummary;
  files: PullFilePatch[];
  evidenceDir: string;
  commandRunner?: GitNexusCommandRunner;
  gitnexusListText?: string;
}): { packet?: GitNexusContextPacket } {
  const gitnexusConfig = input.config.gitnexusContext;
  if (!gitnexusConfig?.enabled) return {};

  const packetResult = buildGitNexusContextPacket({
    repo: input.repo,
    pull: input.pull,
    files: input.files,
    config: gitnexusConfig,
    ...(input.commandRunner ? { commandRunner: input.commandRunner } : {}),
    ...(input.gitnexusListText !== undefined ? { gitnexusListText: input.gitnexusListText } : {})
  });

  if (!packetResult.ok) {
    writeRedactedJson(join(input.evidenceDir, "gitnexus-context-packet-error.json"), packetResult);
    if (isGitNexusContextBudgetFailure(packetResult)) return {};
    throw new Error(`GitNexus context packet failed closed: ${packetResult.error}`);
  }

  writeRedactedJson(join(input.evidenceDir, "gitnexus-context-packet.json"), packetResult);
  writeFileSync(join(input.evidenceDir, "gitnexus-context-packet.md"), packetResult.packet.markdown);
  return { packet: packetResult.packet };
}

function isGitNexusContextBudgetFailure(packetResult: ReturnType<typeof buildGitNexusContextPacket>): boolean {
  return !packetResult.ok &&
    packetResult.redactionReport.ok &&
    packetResult.omittedContext.some((source) => source.reason === "budget_exceeded");
}

export function buildSkillPackContext(input: {
  config: BotConfig;
  evidenceDir: string;
}): { packet?: SkillPackContextPacket } {
  const skillConfig = input.config.skillPacks;
  if (!skillConfig?.enabled) return {};

  const packetResult = buildSkillPackContextPacket({
    config: skillConfig
  });

  if (!packetResult.ok) {
    writeRedactedJson(join(input.evidenceDir, "skill-pack-context-packet-error.json"), packetResult);
    throw new Error(`Skill-pack context packet failed closed: ${packetResult.error}`);
  }

  writeRedactedJson(join(input.evidenceDir, "skill-pack-context-packet.json"), packetResult);
  writeFileSync(join(input.evidenceDir, "skill-pack-context-packet.md"), packetResult.packet.markdown);
  return { packet: packetResult.packet };
}

export async function buildGitHubRelatedContext(input: {
  config: BotConfig;
  github: GitHubRelatedContextReader;
  repo: string;
  pull: PullRequestSummary;
  evidenceDir: string;
}): Promise<{ packet?: GitHubRelatedContextPacket }> {
  const relatedConfig = input.config.githubRelatedContext;
  if (!relatedConfig?.enabled) return {};

  const packetResult = await buildGitHubRelatedContextPacket({
    repo: input.repo,
    pull: input.pull,
    config: relatedConfig,
    reader: input.github
  });

  if (!packetResult.ok) {
    writeRedactedJson(join(input.evidenceDir, "github-related-context-packet-error.json"), packetResult);
    return {};
  }

  writeRedactedJson(join(input.evidenceDir, "github-related-context-packet.json"), packetResult);
  writeFileSync(join(input.evidenceDir, "github-related-context-packet.md"), packetResult.packet.markdown);
  return { packet: packetResult.packet };
}

export function createGitHubRelatedContextReader(config: BotConfig, fallback: GitHubRelatedContextReader): GitHubRelatedContextReader {
  const relatedConfig = config.githubRelatedContext;
  if (!relatedConfig?.enabled) return fallback;
  return new GitHubApi({
    ...config.github,
    requestTimeoutMs: relatedConfig.requestTimeoutMs
  });
}

function recordStaleHeadSkip(input: {
  state: ReviewStateStore;
  repo: string;
  pull: PullRequestSummary;
  stale: StaleHeadEvidence;
  evidenceDir: string;
}): void {
  mkdirSync(input.evidenceDir, { recursive: true });
  writeFileSync(join(input.evidenceDir, "stale-head.json"), `${JSON.stringify(input.stale, null, 2)}\n`);
  input.state.recordProcessed({
    repo: input.repo,
    pullNumber: input.pull.number,
    headSha: input.pull.head.sha,
    status: "skipped",
    error: `${input.stale.reason}: live=${input.stale.liveHeadSha}`
  });
}

export function recordFailedReview(input: {
  config: BotConfig;
  state: ReviewStateStore;
  repo: string;
  pull: PullRequestSummary;
  error: unknown;
}): void {
  const evidenceDir = buildEvidenceDir(input.config, input.repo, input.pull, { action: "none", shouldReview: false });
  const errorMessage = redactSecrets(input.error instanceof Error ? input.error.message : String(input.error));
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(join(evidenceDir, "review-error.json"), `${JSON.stringify({
    repo: input.repo,
    pullNumber: input.pull.number,
    headSha: input.pull.head.sha,
    error: errorMessage,
    recordedAt: new Date().toISOString()
  }, null, 2)}\n`);
  input.state.recordProcessed({
    repo: input.repo,
    pullNumber: input.pull.number,
    headSha: input.pull.head.sha,
    status: "failed",
    error: errorMessage
  });
}

export function recordProviderRateLimitCooldownIfNeeded(input: {
  config: BotConfig;
  state: ReviewStateStore;
  repo: string;
  pull: PullRequestSummary;
  error: unknown;
  now?: Date;
}): boolean {
  if (!input.config.providerCooldown.enabled) return false;
  const classification = classifyProviderError(input.error);
  if (!classification.cooldown) return false;

  const now = input.now ?? new Date();
  const previous = input.state.getProcessedReview(input.repo, input.pull.number, input.pull.head.sha);
  const retryAttempt = nextProviderCooldownRetryAttempt(previous?.error, classification);
  const jitterMs = providerCooldownJitterMs(input.config, classification, retryAttempt);
  const durationMs = providerCooldownDurationMs(input.config, classification, retryAttempt, jitterMs);
  const cooldownUntil = new Date(now.getTime() + durationMs);
  input.state.recordRepoProviderCooldown({
    repo: input.repo,
    cooldownUntil,
    reason: classification.reason
  });
  recordProviderCooldownSkip({
    state: input.state,
    repo: input.repo,
    pull: input.pull,
    cooldownUntil: cooldownUntil.toISOString(),
    reason: classification.reason,
    ...(classification.category === "overloaded" ? { retryAttempt } : {}),
    ...(classification.category === "overloaded" && classification.providerCode ? { providerCode: classification.providerCode } : {}),
    ...(classification.category === "overloaded" && classification.retryAfterMs ? { retryAfterMs: classification.retryAfterMs } : {})
  });
  return true;
}

export function classifyProviderError(error: unknown): ProviderErrorClassification {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  const providerCode = extractProviderCode(message);
  const providerRequestId = extractProviderRequestId(message);
  const retryAfterMs = extractRetryAfterMs(message);
  const requestRateLimited =
    normalized.includes("rate limit") ||
    normalized.includes("rate_limit_error") ||
    normalized.includes("providercode: '1302'") ||
    normalized.includes('providercode: "1302"') ||
    normalized.includes("[1302]") ||
    providerCode === "1302";
  const overloaded =
    normalized.includes("temporarily overloaded") ||
    normalized.includes("overloaded_error") ||
    normalized.includes("providercode: '1305'") ||
    normalized.includes('providercode: "1305"') ||
    normalized.includes("[1305]") ||
    providerCode === "1305";
  const quotaExhausted =
    normalized.includes("usage limit reached") ||
    normalized.includes("weekly/monthly limit exhausted") ||
    normalized.includes("package has expired") ||
    ["1308", "1309", "1310", "1316", "1317"].includes(providerCode ?? "");
  const base = {
    ...(providerCode ? { providerCode } : {}),
    ...(providerRequestId ? { providerRequestId } : {}),
    ...(retryAfterMs ? { retryAfterMs } : {})
  };
  if (quotaExhausted) {
    return { ...base, category: "quota_exhausted", reason: "provider_quota_exhausted", retryable: false, cooldown: true };
  }
  if (overloaded) {
    return { ...base, category: "overloaded", reason: "provider_overloaded", retryable: true, cooldown: true };
  }
  if (requestRateLimited) {
    return { ...base, category: "request_rate_limit", reason: "provider_request_rate_limit", retryable: true, cooldown: true };
  }
  return {
    ...base,
    category: "none",
    reason: "not_provider_retryable",
    retryable: false,
    cooldown: false
  };
}

export function providerCooldownDurationMs(
  config: BotConfig,
  classification: ProviderErrorClassification,
  retryAttempt = 1,
  jitterMs = 0
): number {
  if (classification.category === "request_rate_limit") return config.providerCooldown.requestRateLimitDurationMs;
  if (classification.category === "overloaded") {
    const attempt = Math.max(1, Math.floor(retryAttempt));
    const exponential = config.providerCooldown.overloadDurationMs * 2 ** Math.max(0, attempt - 1);
    const boundedJitter = Math.min(
      Math.max(0, Math.floor(jitterMs)),
      config.providerCooldown.overloadBackoffJitterMs
    );
    return Math.min(config.providerCooldown.overloadBackoffMaxDurationMs, exponential + boundedJitter);
  }
  if (classification.category === "quota_exhausted") return config.providerCooldown.quotaDurationMs;
  return config.providerCooldown.durationMs;
}

function nextProviderCooldownRetryAttempt(
  previousError: string | undefined,
  classification: ProviderErrorClassification
): number {
  if (classification.category !== "overloaded") return 1;
  const previous = parseProviderCooldownError(previousError);
  if (previous?.reason !== classification.reason) return 1;
  return Math.min(99, (previous.retryAttempt ?? 1) + 1);
}

function providerCooldownJitterMs(
  config: BotConfig,
  classification: ProviderErrorClassification,
  retryAttempt: number
): number {
  if (classification.category !== "overloaded") return 0;
  if (retryAttempt <= 1) return 0;
  const max = config.providerCooldown.overloadBackoffJitterMs;
  if (max <= 0) return 0;
  return Math.floor(Math.random() * (max + 1));
}

async function runZCodeReviewWithProviderRetry(input: {
  config: BotConfig;
  worktreePath: string;
  prompt: string;
  evidenceDir: string;
}): Promise<ReturnType<typeof runZCodeReview>> {
  return runWithProviderRetry({
    config: input.config,
    evidenceDir: input.evidenceDir,
    operation: () => runZCodeReview({
      cwd: input.worktreePath,
      prompt: input.prompt,
      cliPath: input.config.zcode.cliPath,
      appConfigPath: input.config.zcode.appConfigPath,
      model: input.config.zcode.model,
      providerId: input.config.zcode.providerId,
      evidenceDir: input.evidenceDir,
      timeoutMs: input.config.zcode.timeoutMs,
      retryMaxRetries: input.config.zcode.retryMaxRetries
    })
  });
}

export async function runWithProviderRetry<T>(input: {
  config: BotConfig;
  evidenceDir: string;
  operation: () => T | Promise<T>;
}): Promise<T> {
  let lastError: unknown;
  const maxAttempts = Math.max(1, input.config.providerCooldown.transientRetryAttempts + 1);
  const attempts: Array<{
    attempt: number;
    providerCode?: string;
    providerRequestId?: string;
    retryAfterMs?: number;
    category: ProviderErrorCategory;
    reason: string;
    retryable: boolean;
    nextDelayMs?: number;
    final?: boolean;
  }> = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const result = await input.operation();
      if (attempts.length > 0) {
        attempts.push({ attempt, category: "none", reason: "success_after_retry", retryable: false, final: true });
        writeProviderRetryEvidence(input.evidenceDir, attempts);
      }
      return result;
    } catch (error) {
      lastError = error;
      const classification = classifyProviderError(error);
      const shouldRetry = classification.retryable && attempt < maxAttempts;
      const nextDelayMs = shouldRetry ? providerRetryDelayMs(input.config, attempt, classification.retryAfterMs) : undefined;
      attempts.push({
        attempt,
        ...(classification.providerCode ? { providerCode: classification.providerCode } : {}),
        ...(classification.providerRequestId ? { providerRequestId: classification.providerRequestId } : {}),
        ...(classification.retryAfterMs ? { retryAfterMs: classification.retryAfterMs } : {}),
        category: classification.category,
        reason: classification.reason,
        retryable: classification.retryable,
        ...(nextDelayMs !== undefined ? { nextDelayMs } : {}),
        final: !shouldRetry
      });
      writeProviderRetryEvidence(input.evidenceDir, attempts);
      if (!shouldRetry) break;
      await sleep(nextDelayMs);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function providerRetryDelayMs(config: BotConfig, attempt: number, retryAfterMs?: number): number {
  const base = config.providerCooldown.transientRetryBaseDelayMs;
  const max = config.providerCooldown.transientRetryMaxDelayMs;
  if (retryAfterMs !== undefined) return Math.min(max, Math.max(1, retryAfterMs));
  const exponential = base * 2 ** Math.max(0, attempt - 1);
  const jitter = Math.floor(Math.random() * Math.max(1, Math.floor(base / 2)));
  return Math.min(max, exponential + jitter);
}

function writeProviderRetryEvidence(evidenceDir: string, attempts: unknown): void {
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(join(evidenceDir, "provider-retry.json"), `${JSON.stringify(attempts, null, 2)}\n`);
}

function extractProviderCode(message: string): string | undefined {
  return (
    message.match(/providerCode:\s*['"]?(\d{4})['"]?/)?.[1] ??
    message.match(/"code"\s*:\s*"(\d{4})"/)?.[1] ??
    message.match(/\[(\d{4})\]/)?.[1]
  );
}

function extractProviderRequestId(message: string): string | undefined {
  return (
    message.match(/providerRequestId:\s*['"]([^'"]+)['"]/)?.[1] ??
    message.match(/request_id['"]?\s*:\s*['"]([^'"]+)['"]/)?.[1]
  );
}

function extractRetryAfterMs(message: string): number | undefined {
  const numeric =
    message.match(/retry-after['"]?\s*[:=]\s*['"]?(\d+(?:\.\d+)?)['"]?/i)?.[1] ??
    message.match(/retryAfterMs['"]?\s*[:=]\s*['"]?(\d+(?:\.\d+)?)['"]?/i)?.[1];
  if (numeric !== undefined) {
    const value = Number(numeric);
    if (Number.isFinite(value) && value > 0) {
      return message.toLowerCase().includes("retryafterms") ? Math.ceil(value) : Math.ceil(value * 1000);
    }
  }

  const date = message.match(/retry-after['"]?\s*[:=]\s*['"]?([^'",\n}]+)/i)?.[1];
  if (!date) return undefined;
  const parsed = Date.parse(date);
  if (!Number.isFinite(parsed)) return undefined;
  const delayMs = parsed - Date.now();
  return delayMs > 0 ? Math.ceil(delayMs) : undefined;
}

function sleep(ms: number | undefined): Promise<void> {
  if (!ms || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function recordProviderCooldownSkip(input: {
  state: ReviewStateStore;
  repo: string;
  pull: PullRequestSummary;
  cooldownUntil: string;
  reason: string;
  retryAttempt?: number;
  providerCode?: string;
  retryAfterMs?: number;
}): void {
  const metadata = [
    `reason=${redactSecrets(input.reason)}`,
    ...(input.retryAttempt ? [`retry_attempt=${input.retryAttempt}`] : []),
    ...(input.providerCode ? [`provider_code=${redactSecrets(input.providerCode)}`] : []),
    ...(input.retryAfterMs ? [`retry_after_ms=${input.retryAfterMs}`] : [])
  ];
  input.state.recordProcessed({
    repo: input.repo,
    pullNumber: input.pull.number,
    headSha: input.pull.head.sha,
    status: "skipped",
    error: `provider_rate_limit_cooldown_until=${input.cooldownUntil}; ${metadata.join("; ")}`
  });
}

function isProviderCooldownProcessedReview(record: { status: string; error?: string }): boolean {
  return record.status === "skipped" && Boolean(parseProviderCooldownError(record.error));
}

function summarizeRetryProviderCooldownResults(results: RetryFailedHeadResult[]): RetryProviderCooldownsResult["summary"] {
  const summary: RetryProviderCooldownsResult["summary"] = {
    reviewed: 0,
    dryRun: 0,
    remainedCooldown: 0,
    failed: 0,
    skippedStaleHead: 0,
    skippedProcessed: 0,
    skippedClosed: 0,
    skippedCapacity: 0,
    other: 0
  };
  for (const result of results) {
    switch (result.status) {
      case "reviewed":
      case "reviewed_command":
        summary.reviewed += 1;
        break;
      case "dry_run":
        summary.dryRun += 1;
        break;
      case "skipped_provider_cooldown":
        summary.remainedCooldown += 1;
        break;
      case "failed":
        summary.failed += 1;
        break;
      case "skipped_stale_head":
        summary.skippedStaleHead += 1;
        break;
      case "skipped_processed":
        summary.skippedProcessed += 1;
        break;
      case "skipped_closed":
        summary.skippedClosed += 1;
        break;
      case "skipped_capacity":
        summary.skippedCapacity += 1;
        break;
      default:
        summary.other += 1;
        break;
    }
  }
  return summary;
}

function isClosedPull(pull: PullRequestSummary): boolean {
  return Boolean(pull.state && pull.state !== "open");
}

function recordClosedRetrySkip(input: {
  state: Pick<ReviewStateStore, "getProcessedReview" | "recordProcessed">;
  repo: string;
  pull: PullRequestSummary;
  headSha: string;
}): void {
  const previous = input.state.getProcessedReview(input.repo, input.pull.number, input.headSha);
  const state = input.pull.state ?? "unknown";
  const mergedAt = input.pull.merged_at ? `; merged_at=${input.pull.merged_at}` : "";
  const previousError = previous?.error ? `; previous_error=${redactSecrets(previous.error)}` : "";
  input.state.recordProcessed({
    repo: input.repo,
    pullNumber: input.pull.number,
    headSha: input.headSha,
    status: "skipped",
    error: `closed_pr_retry_skip: state=${state}${mergedAt}${previousError}`
  });
}

function retryFailureError(previousError: string | undefined, error: unknown): string {
  const retryError = error instanceof Error ? error.message : String(error);
  return previousError ? `${previousError}; retry_error=${retryError}` : retryError;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled retry status: ${String(value)}`);
}

async function resolvePullCommandDecision(input: {
  config: BotConfig;
  github: GitHubApi;
  state: ReviewStateStore;
  repo: string;
  pull: PullRequestSummary;
  commandCommentId?: number;
}): Promise<CommandDecision> {
  if (!input.config.commands.enabled) return { action: "none", shouldReview: false };

  const comments = await input.github.listIssueComments(input.repo, input.pull.number);
  const collected = collectTrustedReviewCommands(comments, input.config.commands);
  const repoProfile = resolveRepoProfile(input.config, input.repo);
  const commands = input.commandCommentId
    ? collected.commands.filter((command) => command.commentId === input.commandCommentId)
    : collected.commands;
  return decideCommandAction({
    commands: commands.filter((command) =>
      !isFinishingTouchCommandAction(command.action) ||
      (repoProfile.allowed && isFinishingTouchActionEnabled(command.action, repoProfile.profile.finishingTouches))
    ),
    repo: input.repo,
    pullNumber: input.pull.number,
    headSha: input.pull.head.sha,
    hasProcessedCommand: (repo, pullNumber, headSha, commentId) =>
      input.state.hasProcessedCommand(repo, pullNumber, headSha, commentId)
  });
}

async function recordAndAcknowledgeCommandDecision(input: {
  config: BotConfig;
  github: GitHubApi;
  state: ReviewStateStore;
  repo: string;
  pull: PullRequestSummary;
  commandDecision: Exclude<CommandDecision, { action: "none"; shouldReview: false }>;
  acknowledge?: boolean;
}): Promise<void> {
  input.state.recordProcessedCommand({
    repo: input.repo,
    pullNumber: input.pull.number,
    headSha: input.pull.head.sha,
    commentId: input.commandDecision.commandId,
    action: input.commandDecision.action,
    status:
      input.commandDecision.action === "stop"
        ? "stopped"
        : input.commandDecision.action === "explain"
          ? "explained"
          : "triggered",
    author: input.commandDecision.command.author,
    url: input.commandDecision.command.url
  });

  if (input.commandDecision.action === "stop") {
    const existing = input.state.getProcessedReview(input.repo, input.pull.number, input.pull.head.sha);
    if (existing?.status !== "posted") {
      input.state.recordProcessed({
        repo: input.repo,
        pullNumber: input.pull.number,
        headSha: input.pull.head.sha,
        status: "skipped",
        error: `manual_command_stop comment_id=${input.commandDecision.commandId}; author=${input.commandDecision.command.author}`
      });
    }
  }

  if (input.acknowledge !== false && input.config.commands.acknowledge && input.github.canPostAsApp()) {
    await input.github.upsertIssueComment({
      repo: input.repo,
      issueNumber: input.pull.number,
      marker: buildCommandStatusMarker(input.repo, input.pull.number, input.pull.head.sha),
      body: buildCommandStatusBody({
        repo: input.repo,
        pullNumber: input.pull.number,
        headSha: input.pull.head.sha,
        decision: input.commandDecision
      })
    });
  }
}

export function localDateFolder(now = new Date()): string {
  const year = String(now.getFullYear()).padStart(4, "0");
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function sanitizeDroppedFindings(dropped: ReviewPlan["dropped"]): ReviewPlan["dropped"] {
  return dropped.map((finding) => ({
    ...finding,
    ...(typeof finding.title === "string" ? { title: redactSecrets(finding.title) } : {}),
    ...(typeof finding.body === "string" ? { body: redactSecrets(finding.body) } : {}),
    ...(typeof finding.why_this_matters === "string"
      ? { why_this_matters: redactSecrets(finding.why_this_matters) }
      : {})
  }));
}

function writeRedactedJson(path: string, value: unknown): void {
  writeFileSync(path, `${redactSecrets(JSON.stringify(value, null, 2))}\n`);
}

function buildSummary(input: {
  repo: string;
  pull: PullRequestSummary;
  comments: { severity: string }[];
  dropped: { reason: string }[];
  dryRun: boolean;
  commandDecision?: CommandDecision;
}): string {
  const p0p1 = input.comments.filter((comment) => comment.severity === "P0" || comment.severity === "P1").length;
  const lines = [
    `evaOS ZCode review ${input.dryRun ? "dry run" : "result"} for ${input.repo}#${input.pull.number} at ${input.pull.head.sha}.`,
    `Inline comments: ${input.comments.length}. High-severity comments: ${p0p1}. Dropped findings: ${input.dropped.length}.`,
    "Pilot policy: this bot never approves PRs; it requests changes only for validated P0/P1 findings."
  ];
  if (input.commandDecision && input.commandDecision.action !== "none") {
    lines.push(
      `Command source: ${input.commandDecision.action} comment ${input.commandDecision.commandId} by ${input.commandDecision.command.author}.`
    );
  }
  return lines.join("\n\n");
}
