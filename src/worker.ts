import { existsSync, mkdirSync, rmSync } from "node:fs";
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
import { planContextBudget, type ContextBudgetPlan } from "./context-budget.js";
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
import { parseFindings } from "./findings.js";
import { getProtectedCheckoutRoots } from "./path-safety.js";
import { evaluateLicenseReviewGate, type LicenseReviewGateResult } from "./license.js";
import {
  createAnthropicReviewAdapter,
  createGeminiReviewAdapter,
  createOpenAICompatibleReviewAdapter,
  createOpenAINativeReviewAdapter,
  type ProviderAdapterOutputContract,
  type ProviderRuntimeAdapter
} from "./provider-adapters.js";
import type { ProviderRegistryEntry } from "./providers.js";
import {
  buildPullFileFilterImpact,
  buildReviewSettingsPreview,
  filterPullFilesForProfile,
  listReposToScan,
  resolveRepoProfile
} from "./repo-policy.js";
import { applyDeterministicReviewGate, type RepoMemoryFalsePositiveEntry } from "./review-gate.js";
import {
  buildOutcomeLedger,
  buildOutcomeLedgerInputFromReviewPlan,
  renderOutcomeLedgerMarkdown,
  type OutcomeLedgerRuntimeInput,
  type OutcomeLedgerSafetyGateInput
} from "./outcome-ledger.js";
import { buildRepoMemoryPacket, readRepoMemoryMarkdown, type RepoMemoryPacket } from "./repo-memory.js";
import { ReviewRunBudget } from "./review-budget.js";
import { sanitizePublicConfidenceText, type PublicConfidenceDisplayPolicy } from "./public-confidence.js";
import {
  postReviewStatusComment,
  type ReviewStatusCommentGithub,
  type ReviewStatusCommentState
} from "./review-status-comment.js";
import { redactSecrets } from "./secrets.js";
import { buildSkillPackContextPacket, type SkillPackContextPacket } from "./skill-packs.js";
import { writeSecureFileSync } from "./temp-files.js";
import {
  ACTIVATION_BASELINE_EXISTING_HEAD_ERROR,
  isActivationBaselineProcessedReview,
  parseProviderCooldownError,
  ReviewStateStore,
  type ProcessedStatus,
  type ReviewQueueJobState,
  type ReviewHeadClaim,
  type ReviewFindingRecord,
  type ReviewReadinessRecord,
  type ReviewReadinessState,
  type ReviewerSessionJobState,
  type ReviewRunLease,
  type StoredProcessedReviewRecord
} from "./state.js";
import { buildChangedSurfaceValidationReport, evaluateProofRequirements } from "./validation-selector.js";
import { buildWalkthroughComment } from "./walkthrough.js";
import { postWalkthroughComment, reviewBodyAfterWalkthroughPost } from "./walkthrough-post.js";
import {
  buildReviewPrompt,
  extractAnyJsonObject,
  extractJsonObject,
  extractZCodeResponse,
  isZCodeSchemaFailureError,
  runZCodeJsonObject,
  runZCodeReview,
  type ZCodeReviewResult
} from "./zcode.js";
import { runSelfConsistencyRecheckAsync, type SelfConsistencySecondDrawResult } from "./self-consistency.js";
import type { DeterministicReviewGateResult } from "./review-gate.js";
import { formatZCodeTimeoutFailureError } from "./zcode-timeout.js";
import type {
  DroppedFinding,
  Finding,
  PullFilePatch,
  PullRequestSummary,
  RepositorySummary,
  ReviewComment,
  ReviewEvent,
  ReviewPlan,
  ReviewProviderMetadata
} from "./types.js";

const LICENSE_GATE_REPO_VISIBILITY_CACHE_TTL_MS = 10 * 60_000;
const LICENSE_GATE_UNKNOWN_REPO_VISIBILITY_CACHE_TTL_MS = 2 * 60_000;
const LICENSE_GATE_REPO_VISIBILITY_CACHE_MAX_ENTRIES = 256;
const LICENSE_GATE_RETRY_DELAY_MS = 15 * 60_000;
const licenseGateRepoVisibilityCache = new Map<string, { visibility: "public" | "private" | "unknown"; expiresAtMs: number }>();
const SELF_CONSISTENCY_OUTPUT_CONTRACT: ProviderAdapterOutputContract = {
  name: "neondiff_self_consistency_verdict",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["verified", "confidence"],
    properties: {
      verified: { type: "boolean" },
      confidence: { type: "number", minimum: 0, maximum: 1 }
    }
  },
  strict: true,
  systemInstruction: [
    "Return only the NeonDiff self-consistency verdict JSON object.",
    "Do not include markdown, prose, tool calls, or raw diff excerpts."
  ].join(" "),
  reviewJson: false
};

export function buildReviewProviderMetadata(config: BotConfig): ReviewProviderMetadata {
  const providerId = config.zcode.providerId ?? config.providers?.defaultProviderId ?? "zcode-glm";
  const provider = config.providers?.providers[providerId];
  if (!provider) {
    return {
      providerId,
      adapter: "zcode (registry miss)",
      model: "unknown",
      displayName: "Unregistered provider id"
    };
  }
  return {
    providerId,
    adapter: provider.adapter,
    model: provider.model,
    ...(provider.displayName ? { displayName: provider.displayName } : {})
  };
}

function resolveReviewContextWindowTokens(config: BotConfig): number | undefined {
  const providerId = config.zcode.providerId ?? config.providers?.defaultProviderId ?? "zcode-glm";
  return config.providers?.providers[providerId]?.contextWindowTokens;
}

function contextBudgetEvidence(plan: ContextBudgetPlan): Record<string, unknown> {
  return {
    mode: plan.mode,
    estimatedTokens: plan.estimatedTokens,
    reservedOutputTokens: plan.reservedOutputTokens,
    overflow: plan.overflow,
    ...(plan.contextWindowTokens !== undefined ? { contextWindowTokens: plan.contextWindowTokens } : {}),
    ...(plan.budgetTokens !== undefined ? { budgetTokens: plan.budgetTokens } : {}),
    ...(plan.reason ? { reason: plan.reason } : {}),
    ...(plan.chunks
      ? {
          chunks: plan.chunks.map((chunk) => ({
            index: chunk.index,
            filenames: chunk.filenames,
            estimatedTokens: chunk.estimatedTokens
          }))
        }
      : {})
  };
}

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
  skippedLicenseGate: number;
  skippedCommandStop: number;
  skippedCommandExplain: number;
  skippedFinishingTouchDraft: number;
  commandReviewRequested: number;
  skippedProcessed: number;
  skippedCapacity: number;
  skippedContextBudget: number;
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

export type ProviderErrorCategory = "none" | "request_rate_limit" | "overloaded" | "quota_exhausted" | "model_output_schema";

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
  | "skipped_license_gate"
  | "skipped_command_stop"
  | "skipped_command_explain"
  | "skipped_finishing_touch_draft"
  | "skipped_processed"
  | "skipped_capacity"
  | "skipped_context_budget"
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
    case "skipped_license_gate":
    case "skipped_command_stop":
    case "skipped_command_explain":
    case "skipped_finishing_touch_draft":
    case "skipped_capacity":
    case "skipped_context_budget":
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
    skippedLicenseGate: 0,
    skippedCommandStop: 0,
    skippedCommandExplain: 0,
    skippedFinishingTouchDraft: 0,
    commandReviewRequested: 0,
    skippedProcessed: 0,
    skippedCapacity: 0,
    skippedContextBudget: 0,
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
        if (status === "skipped_policy" || status === "skipped_license_gate") result.skippedPolicy += 1;
        if (status === "skipped_license_gate") result.skippedLicenseGate += 1;
        if (status === "skipped_command_stop") result.skippedCommandStop += 1;
        if (status === "skipped_command_explain") result.skippedCommandExplain += 1;
        if (status === "skipped_finishing_touch_draft") result.skippedFinishingTouchDraft += 1;
        if (status === "reviewed_command") result.commandReviewRequested += 1;
        if (status === "skipped_processed") result.skippedProcessed += 1;
        if (status === "skipped_capacity") result.skippedCapacity += 1;
        if (status === "skipped_context_budget") result.skippedContextBudget += 1;
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
      dryRun: options.dryRun,
      providerCooldownError: retryTarget.previousError
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
    ...(state === "failed" ? { details: "Review failed; see bot evidence for operator-only details." } : {}),
    publicConfidencePolicy: input.config.confidenceCalibration?.publicDisplay
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
    case "skipped_context_budget":
      return "skipped";
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
    case "skipped_license_gate":
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
  providerCooldownError?: string;
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
  const providerCooldown = parseProviderCooldownError(processed?.error) ?? parseProviderCooldownError(input.providerCooldownError);
  const patch = retryQueuePatchForStatus({
    status: input.status,
    dryRun: input.dryRun,
    processedStatus: processed?.status,
    processedReviewUrl: processed?.reviewUrl,
    providerCooldownUntil: providerCooldown?.cooldownUntil,
    processedError: processed?.error
  });
  for (const job of targetJobs) {
    const lastError = buildRetryQueueLastError({
      jobLastError: job.lastError,
      patchLastError: patch.lastError,
      patchState: patch.state,
      fallbackProviderCooldown: providerCooldown
    });
    input.state.updateReviewQueueJobState({
      jobId: job.jobId,
      state: patch.state,
      ...(patch.nextEligibleAt ? { nextEligibleAt: patch.nextEligibleAt } : {}),
      ...(patch.reviewUrl ? { reviewUrl: patch.reviewUrl } : {}),
      lastError
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

function buildRetryQueueLastError(input: {
  jobLastError?: string;
  patchLastError: string;
  patchState: ReviewQueueJobState;
  fallbackProviderCooldown?: ReturnType<typeof parseProviderCooldownError>;
}): string {
  if (input.patchState !== "posted") return input.patchLastError;
  const jobProviderCooldown = parseProviderCooldownError(input.jobLastError);
  const providerCooldown = jobProviderCooldown ?? input.fallbackProviderCooldown;
  if (!providerCooldown) return input.patchLastError;
  const previousReason = redactSecrets(providerCooldown.reason ?? "provider_cooldown");
  const previousProviderCode = providerCooldown.providerCode ?? input.fallbackProviderCooldown?.providerCode;
  const redactedProviderCode = previousProviderCode ? redactSecrets(previousProviderCode) : undefined;
  return [
    `${input.patchLastError}_after_provider_deferred`,
    `previous_reason=${previousReason}`,
    ...(redactedProviderCode ? [`previous_provider_code=${redactedProviderCode}`] : [])
  ].join("; ");
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
    case "skipped_context_budget":
      return {
        state: "failed",
        lastError: input.processedError ?? "retry_did_not_review=skipped_context_budget",
        sessionJobState: "skipped",
        sessionProcessedStatus: "skipped"
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
    case "skipped_license_gate":
      return {
        state: "blocked_on_proof",
        nextEligibleAt: nextLicenseGateRetryAt(),
        lastError: input.processedError ?? "license_entitlement_required",
        sessionJobState: "assigned"
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
    writeRedactedText(join(evidenceDir, "finishing-touch-draft.md"), draft.markdown);
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
    // This is a provider-free visibility repair for a GitHub review that is
    // already durable. Keep it before provider cooldown handling so agents do
    // not stay blocked on a stale queued status marker for a completed head.
    await reconcileProcessedHeadAfterDirectReviewSafely({
      config,
      github,
      state,
      repo,
      pull,
      dryRun: input.dryRun
    });
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
  if (input.processedHeadPolicy === "retry_failed_head") {
    const current = state.getProcessedReview(repo, pull.number, pull.head.sha);
    if (current?.status !== "failed" && !isProviderCooldownProcessedReview(current ?? { status: "" })) {
      return "skipped_processed";
    }
    const evidenceDir = buildEvidenceDir(config, repo, pull, commandDecision);
    const liveBeforeReview = await github.getPull(repo, pull.number);
    const staleBeforeReview = detectStalePullHead({ expected: pull, live: liveBeforeReview, phase: "before_review" });
    if (staleBeforeReview) {
      recordStaleHeadSkip({ state, repo, pull, stale: staleBeforeReview, evidenceDir });
      return "skipped_stale_head";
    }
  }
  const budget = input.budget ?? new ReviewRunBudget(config.reviewConcurrency.maxActiveRuns);
  let lease: ReviewRunLease | undefined;
  let headClaim: ReviewHeadClaim | undefined;
  let budgetStarted = false;
  const releaseReviewCapacity = (): void => {
    // Crash-safe release-on-failure (#295): if we hold the per-head claim and the finally runs
    // before recordProcessed retired it (error/early return), release it so the head is re-claimable.
    // recordProcessed already retires it on the success path; the state TTL is the last-resort backstop.
    if (headClaim) {
      state.releaseReviewHeadClaim(headClaim.claimId);
      headClaim = undefined;
    }
    if (lease) {
      state.releaseReviewRunLease(lease.leaseId);
      lease = undefined;
    }
    if (budgetStarted) {
      budget.finish();
      budgetStarted = false;
    }
  };
  const acquireReviewCapacity = (): boolean => {
    if (budgetStarted && lease) return true;
    if (!budget.tryStart()) return false;
    budgetStarted = true;
    lease = state.tryAcquireReviewRunLease(config.reviewConcurrency.maxActiveRuns, config.reviewConcurrency.leaseTtlMs);
    if (lease) return true;
    budget.finish();
    budgetStarted = false;
    return false;
  };

  try {
    const licenseGate = await buildLicenseGateForPull({ config, github, repo, pull, dryRun: input.dryRun });
    if (!licenseGate.ok) {
      const evidenceDir = buildEvidenceDir(config, repo, pull, commandDecision);
      mkdirSync(evidenceDir, { recursive: true });
      writeRedactedJson(join(evidenceDir, "license-gate.json"), licenseGate);
      state.recordReviewReadiness({
        repo,
        pullNumber: pull.number,
        headSha: pull.head.sha,
        state: "blocked_on_proof",
        reason: licenseGate.reason
      });
      return "skipped_license_gate";
    }

    if (!acquireReviewCapacity()) return "skipped_capacity";

    const evidenceDir = buildEvidenceDir(config, repo, pull, commandDecision);
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
      files: reviewFiles,
      evidenceDir
    });

    const promptForFiles = (filesForPrompt: PullFilePatch[]) => buildReviewPrompt({
      repo,
      pull,
      files: filesForPrompt,
      repoProfile: repoPolicy.profile,
      ...(skillPackContext.packet ? { skillPackContextPacket: skillPackContext.packet } : {}),
      ...(repoMemory.packet ? { repoMemoryPacket: repoMemory.packet } : {}),
      ...(gitnexusContext.packet ? { gitnexusContextPacket: gitnexusContext.packet } : {}),
      ...(githubRelatedContext.packet ? { githubRelatedContextPacket: githubRelatedContext.packet } : {}),
      maxPatchBytes: config.zcode.maxPatchBytes
    });
    const prompt = promptForFiles(reviewFiles);
    writeRedactedJson(join(evidenceDir, "repo-profile.json"), repoPolicy.profile);
    writeRedactedJson(join(evidenceDir, "filter-impact.json"), filterImpact);
    const settingsPreview = buildReviewSettingsPreview(config, repoPolicy.profile);
    writeRedactedJson(join(evidenceDir, "review-settings-preview.json"), settingsPreview);
    if (commandDecision.action !== "none") {
      writeRedactedJson(join(evidenceDir, "command.json"), commandDecision.command);
    }
    writeSecureFileSync(join(evidenceDir, "review-prompt.txt"), redactSecrets(prompt));
    writeRedactedJson(join(evidenceDir, "validation-selector.json"), validation);
    writeRedactedJson(join(evidenceDir, "proof-requirements.json"), proof);
    const contextBudget = planContextBudget({
      prompt,
      files: reviewFiles,
      contextWindowTokens: resolveReviewContextWindowTokens(config),
      config: config.contextBudget,
      buildPrompt: promptForFiles
    });
    writeRedactedJson(join(evidenceDir, "context-budget.json"), contextBudgetEvidence(contextBudget));
    if (contextBudget.mode === "skip") {
      state.recordProcessed({
        repo,
        pullNumber: pull.number,
        headSha: pull.head.sha,
        status: "failed",
        error: contextBudget.reason
      });
      return "skipped_context_budget";
    }

    const zcodeExecution = await runReviewWithContextBudget({
      config,
      github,
      state,
      repo,
      pull,
      worktreePath: worktree.path,
      prompt,
      contextBudget,
      promptForFiles,
      useZCode: input.useZCode,
      evidenceDir
    });
    if (zcodeExecution.status === "skipped_stale_head") return "skipped_stale_head";
    if (zcodeExecution.status === "skipped_context_budget") return "skipped_context_budget";
    const zcodeResult = zcodeExecution.result;

    assertGitClean(worktree.path);

    const liveBeforePlan = await github.getPull(repo, pull.number);
    const staleBeforePlan = detectStalePullHead({ expected: pull, live: liveBeforePlan, phase: "before_plan" });
    if (staleBeforePlan) {
      recordStaleHeadSkip({ state, repo, pull, stale: staleBeforePlan, evidenceDir });
      return "skipped_stale_head";
    }

    const gatedFindings = applyRetryDegradedConfidencePenalty(
      zcodeResult.findings,
      zcodeResult.degradedRecovery,
      config.reviewGate?.retryDegradedConfidencePenalty
    );
    const gate = applyDeterministicReviewGate({
      findings: gatedFindings,
      files: reviewFiles,
      droppedFromSchema: zcodeResult.droppedFromSchema,
      maxInlineComments: config.reviewGate?.maxInlineComments ?? 25,
      repoMemoryFalsePositiveFingerprints: repoMemory.falsePositiveFingerprints,
      repoMemoryFalsePositives: repoMemory.falsePositives,
      publicConfidencePolicy: config.confidenceCalibration?.publicDisplay,
      ...(config.reviewGate?.requestChangesConfidenceFloors
        ? { requestChangesConfidenceFloors: config.reviewGate.requestChangesConfidenceFloors }
        : {}),
      ...(config.reviewGate?.categoryPrecisionFloors
        ? { categoryPrecisionFloors: config.reviewGate.categoryPrecisionFloors }
        : {})
    });
    // Opt-in P0/P1 self-consistency re-check (#303): post-dedup, pre-event-decision. Quieter-only —
    // disagreement can lower confidence and strip REQUEST_CHANGES eligibility, never raise/add. When
    // disabled (default) this is a no-op returning the gate's own comments/event, byte-identical.
    const selfConsistency = await applySelfConsistencyRecheck({
      config,
      gate,
      files: reviewFiles,
      worktreePath: worktree.path,
      evidenceDir
    });
    if (selfConsistency.runtimeNote && Array.isArray(zcodeResult.runtime.notes)) {
      zcodeResult.runtime.notes.push(selfConsistency.runtimeNote);
    }
    const comments = selfConsistency.comments;
    // Gate output is already public-safe; this second pass keeps evidence redacted
    // and relies on sanitizePublicConfidenceText/redactSecrets idempotency tests.
    const dropped = sanitizeDroppedFindings(gate.dropped, config.confidenceCalibration?.publicDisplay);
    const event = selfConsistency.event;
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
          settingsPreview,
          provider: buildReviewProviderMetadata(config),
          postIssueComment: config.walkthrough.postIssueComment,
          publicConfidencePolicy: config.confidenceCalibration?.publicDisplay
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
          postIssueComment: config.enrichment.postIssueComment,
          publicConfidencePolicy: config.confidenceCalibration?.publicDisplay
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

    if (walkthrough) writeRedactedText(join(evidenceDir, "walkthrough.md"), walkthrough.body);
    if (enrichment) writeRedactedText(join(evidenceDir, "enrichment.md"), enrichment.body);
    if (input.dryRun) {
      writeDryRunOutcomeLedgerEvidence({
        evidenceDir,
        repo,
        pull,
        files: reviewFiles,
        plan,
        runtime: zcodeResult.runtime,
        duplicateSameHead: processed
          ? {
              name: "duplicate_same_head",
              status: "unknown",
              detail: `A processed row already existed with status ${processed.status}; dry-run review proceeded under the current processed-head policy and posts no public comments.`
            }
          : {
              name: "duplicate_same_head",
              status: "pass",
              detail: "ReviewPull processed-head preflight found no existing processed row for this head; dry-run posts no public comments."
            }
      });
    }
    writeRedactedJson(join(evidenceDir, "review-plan.json"), plan);

    if (input.dryRun) {
      // Dry-run posts nothing public, so it does NOT acquire a per-head claim (#295): claiming would
      // add contention/TTL churn for a run that cannot violate the at-most-one-posted-review invariant.
      state.recordProcessed({ repo, pullNumber: pull.number, headSha: pull.head.sha, status: "dry_run", event });
      return commandReviewRequested ? "reviewed_command" : "reviewed";
    }

    // Atomic per-head claim (#295): acquired here — after every eligibility/stale check and after the
    // dry-run branch, immediately before posting — so exactly one of a racing manual-review-pr and
    // daemon posts a review on this head. The loser records a structured skip and no-ops.
    headClaim = state.tryClaimReviewHead({
      repo,
      pullNumber: pull.number,
      headSha: pull.head.sha,
      claimTtlMs: config.reviewConcurrency.leaseTtlMs
    });
    if (!headClaim) {
      recordConcurrentClaimSkip({ state, repo, pull, evidenceDir });
      return "skipped_processed";
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
    writeRedactedJson(join(evidenceDir, "review-plan.json"), plan);
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
    // Public-safe findings ledger (#357): record the coordinates we just posted publicly so the
    // daemon calibration-observe pass can re-derive outcome labels later. BEST-EFFORT / FAIL-OPEN —
    // the review is already durable; observation bookkeeping must never block or fail the review.
    recordPostedReviewFindings({ state, repo, pull, comments });
    releaseReviewCapacity();
    if (input.processedHeadPolicy !== "retry_failed_head") {
      await reconcileProcessedHeadAfterDirectReviewSafely({
        config,
        github,
        state,
        repo,
        pull,
        dryRun: input.dryRun
      });
    }
    return commandReviewRequested ? "reviewed_command" : "reviewed";
  } finally {
    releaseReviewCapacity();
  }
}

async function reconcileProcessedHeadAfterDirectReviewSafely(input: {
  config: BotConfig;
  github: GitHubApi;
  state: ReviewStateStore;
  repo: string;
  pull: PullRequestSummary;
  dryRun: boolean;
  now?: Date;
}): Promise<void> {
  try {
    await reconcileProcessedHeadAfterDirectReview(input);
  } catch (error) {
    // The GitHub review and processed row are already durable here. Reconciliation
    // is an operator-visibility repair, so it must not turn a posted review into
    // a failed review if local state or status-comment upsert hiccups.
    console.warn(
      `[reconcile] processed-head reconcile failed repo=${input.repo} pr=${input.pull.number} sha=${input.pull.head.sha}: ${
        redactSecrets(error instanceof Error ? error.message : String(error))
      }`
    );
  }
}

const DIRECT_REVIEW_RECONCILE_QUEUE_STATES: ReviewQueueJobState[] = [
  "queued",
  "leased",
  "running",
  "provider_deferred",
  "blocked_on_proof"
];

export async function reconcileProcessedHeadAfterDirectReview(input: {
  config: BotConfig;
  github: GitHubApi;
  state: ReviewStateStore;
  repo: string;
  pull: PullRequestSummary;
  dryRun: boolean;
  now?: Date;
}): Promise<{ activeQueueJobs: number; settledQueueJobs: number; statusCommentPosted: boolean }> {
  if (input.dryRun) return { activeQueueJobs: 0, settledQueueJobs: 0, statusCommentPosted: false };
  const processed = input.state.getProcessedReview(input.repo, input.pull.number, input.pull.head.sha);
  const activeJobs = input.state
    .listReviewQueueJobsForPull({
      repo: input.repo,
      pullNumber: input.pull.number,
      states: DIRECT_REVIEW_RECONCILE_QUEUE_STATES
    })
    .filter((job) => job.headSha === input.pull.head.sha);
  if (processed?.status !== "posted") {
    return { activeQueueJobs: activeJobs.length, settledQueueJobs: 0, statusCommentPosted: false };
  }

  const now = input.now ?? new Date();
  if (activeJobs.length === 0) {
    recordDirectReviewReadinessIfRepairable({
      state: input.state,
      repo: input.repo,
      pull: input.pull,
      processed,
      existingReadiness: input.state.getReviewReadiness(input.repo, input.pull.number, input.pull.head.sha),
      now
    });
    return {
      activeQueueJobs: 0,
      settledQueueJobs: 0,
      statusCommentPosted: await postDirectReviewCompletedStatusComment({ ...input, processed, now })
    };
  }

  const manualCommandJob =
    activeJobs.find((job) => job.source === "manual_command" && job.commentId) ??
    activeJobs.find((job) => job.source === "manual_command");
  const existingReadiness = input.state.getReviewReadiness(input.repo, input.pull.number, input.pull.head.sha);

  for (const job of activeJobs) {
    input.state.updateReviewQueueJobState({
      jobId: job.jobId,
      state: "posted",
      ...(processed.reviewUrl ? { reviewUrl: processed.reviewUrl } : {}),
      lastError: directReviewReconcileLastError(job.lastError),
      now
    });
    if (job.sessionId && input.state.getReviewerSessionJob(job.repo, job.pullNumber, job.headSha)) {
      input.state.updateReviewerSessionJobState({
        repo: job.repo,
        pullNumber: job.pullNumber,
        headSha: job.headSha,
        jobState: "completed",
        processedReviewStatus: "posted",
        now
      });
    }
  }

  input.state.recordReviewReadiness({
    repo: input.repo,
    pullNumber: input.pull.number,
    headSha: input.pull.head.sha,
    state: readinessStateForDirectProcessedReview(processed.event),
    reason: directReviewReconcileReadinessReason(existingReadiness),
    ...(processed.event ? { event: processed.event } : {}),
    ...(processed.reviewUrl ? { reviewUrl: processed.reviewUrl } : {}),
    ...(manualCommandJob?.commentId ? { commandCommentId: manualCommandJob.commentId } : {}),
    now
  });

  return {
    activeQueueJobs: activeJobs.length,
    settledQueueJobs: activeJobs.length,
    statusCommentPosted: await postDirectReviewCompletedStatusComment({ ...input, processed, now })
  };
}

async function postDirectReviewCompletedStatusComment(input: {
  config: BotConfig;
  github: GitHubApi;
  repo: string;
  pull: PullRequestSummary;
  dryRun: boolean;
  processed: { reviewUrl?: string };
  now: Date;
}): Promise<boolean> {
  if (!isReviewStatusCommentGithub(input.github)) return false;
  const result = await postReviewStatusComment({
    enabled: input.config.reviewStatusComment?.enabled ?? false,
    dryRun: input.dryRun,
    github: input.github,
    repo: input.repo,
    pullNumber: input.pull.number,
    headSha: input.pull.head.sha,
    state: "completed",
    pullTitle: input.pull.title,
    pullUrl: input.pull.html_url,
    ...(input.processed.reviewUrl ? { reviewUrl: input.processed.reviewUrl } : {}),
    now: input.now,
    publicConfidencePolicy: input.config.confidenceCalibration?.publicDisplay
  });
  return result.posted;
}

const DIRECT_REVIEW_RECONCILED_ERROR = "direct_review_reconciled_processed_head=posted";
const DIRECT_REVIEW_RECONCILED_REASON = "direct_review_reconciled_processed_head";

function directReviewReconcileLastError(previous?: string): string {
  if (!previous) return DIRECT_REVIEW_RECONCILED_ERROR;
  if (previous.includes(DIRECT_REVIEW_RECONCILED_ERROR)) return previous;
  return `${DIRECT_REVIEW_RECONCILED_ERROR}; previous_last_error=${previous}`;
}

function directReviewReconcileReadinessReason(previous?: ReviewReadinessRecord): string {
  const previousReason = previous?.reason?.trim();
  if (!previousReason || previousReason.includes(DIRECT_REVIEW_RECONCILED_REASON)) {
    return DIRECT_REVIEW_RECONCILED_REASON;
  }
  return `${DIRECT_REVIEW_RECONCILED_REASON}; previous_reason=${redactSecrets(previousReason).slice(0, 200)}`;
}

function recordDirectReviewReadinessIfRepairable(input: {
  state: ReviewStateStore;
  repo: string;
  pull: PullRequestSummary;
  processed: { event?: ReviewEvent; reviewUrl?: string };
  existingReadiness?: ReviewReadinessRecord;
  now: Date;
}): void {
  if (!shouldRepairDirectReviewReadiness(input.existingReadiness)) return;
  input.state.recordReviewReadiness({
    repo: input.repo,
    pullNumber: input.pull.number,
    headSha: input.pull.head.sha,
    state: readinessStateForDirectProcessedReview(input.processed.event),
    reason: directReviewReconcileReadinessReason(input.existingReadiness),
    ...(input.processed.event ? { event: input.processed.event } : {}),
    ...(input.processed.reviewUrl ? { reviewUrl: input.processed.reviewUrl } : {}),
    now: input.now
  });
}

function shouldRepairDirectReviewReadiness(readiness?: ReviewReadinessRecord): boolean {
  return (
    !readiness ||
    readiness.state === "queued" ||
    readiness.state === "reviewing" ||
    readiness.state === "awaiting_re_review" ||
    readiness.state === "provider_deferred"
  );
}

function readinessStateForDirectProcessedReview(event?: ReviewEvent): ReviewReadinessState {
  return event === "REQUEST_CHANGES" ? "needs_fix" : "ready_for_human";
}

export async function buildLicenseGateForPull(input: {
  config: BotConfig;
  github: GitHubApi;
  repo: string;
  pull: PullRequestSummary;
  dryRun: boolean;
}): Promise<LicenseReviewGateResult> {
  const license = input.config.license;
  if (!license?.enabled) {
    return {
      ok: true,
      repo: input.repo,
      visibility: "unknown",
      status: "active",
      reason: "license enforcement disabled"
    };
  }
  let visibility = visibilityFromPullSummary(input.pull);
  if (visibility === "unknown" && !license.privateReposRequireEntitlement) {
    return evaluateLicenseReviewGate({
      config: license,
      repo: input.repo,
      visibility
    });
  }
  if (visibility === "unknown" && input.dryRun) {
    return evaluateLicenseReviewGate({
      config: license,
      repo: input.repo,
      visibility,
      refresh: false
    });
  }
  if (visibility === "unknown") {
    try {
      visibility = await getRepoVisibilityForLicenseGate(input.github, input.repo);
    } catch (error) {
      return {
        ok: false,
        repo: input.repo,
        visibility,
        status: "network",
        reason: `could not determine repo visibility for license gate: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }
  return evaluateLicenseReviewGate({
    config: license,
    repo: input.repo,
    visibility,
    refresh: !input.dryRun
  });
}

function visibilityFromRepositorySummary(repoMetadata: RepositorySummary): "public" | "private" | "unknown" {
  if (repoMetadata.private || repoMetadata.visibility === "private" || repoMetadata.visibility === "internal") return "private";
  if (repoMetadata.visibility === "public") return "public";
  return "unknown";
}

function visibilityFromPullSummary(pull: PullRequestSummary): "public" | "private" | "unknown" {
  const repo = pull.base.repo;
  if (repo.private === true || repo.visibility === "private" || repo.visibility === "internal") return "private";
  if (repo.visibility === "public" || repo.private === false) return "public";
  return "unknown";
}

async function getRepoVisibilityForLicenseGate(github: GitHubApi, repo: string): Promise<"public" | "private" | "unknown"> {
  const now = Date.now();
  const cached = licenseGateRepoVisibilityCache.get(repo);
  if (cached) {
    if (cached.expiresAtMs > now) {
      licenseGateRepoVisibilityCache.delete(repo);
      licenseGateRepoVisibilityCache.set(repo, cached);
      return cached.visibility;
    }
    licenseGateRepoVisibilityCache.delete(repo);
  }

  const repoMetadata = await getRepoMetadataForLicenseGate(github, repo);
  const visibility = visibilityFromRepositorySummary(repoMetadata);
  cacheLicenseGateRepoVisibility(repo, visibility, now);
  return visibility;
}

async function getRepoMetadataForLicenseGate(github: GitHubApi, repo: string): ReturnType<GitHubApi["getRepo"]> {
  return github.getRepo(repo);
}

function cacheLicenseGateRepoVisibility(repo: string, visibility: "public" | "private" | "unknown", now: number): void {
  if (!licenseGateRepoVisibilityCache.has(repo) && licenseGateRepoVisibilityCache.size >= LICENSE_GATE_REPO_VISIBILITY_CACHE_MAX_ENTRIES) {
    const oldest = licenseGateRepoVisibilityCache.keys().next().value;
    if (oldest) licenseGateRepoVisibilityCache.delete(oldest);
  }
  licenseGateRepoVisibilityCache.set(repo, {
    visibility,
    expiresAtMs: now + (visibility === "unknown"
      ? LICENSE_GATE_UNKNOWN_REPO_VISIBILITY_CACHE_TTL_MS
      : LICENSE_GATE_REPO_VISIBILITY_CACHE_TTL_MS)
  });
}

function nextLicenseGateRetryAt(now = new Date()): string {
  return new Date(now.getTime() + LICENSE_GATE_RETRY_DELAY_MS).toISOString();
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

export type StaleHeadPhase = "before_command" | "before_review" | "before_chunk" | "before_plan" | "before_post";

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
}): { packet?: RepoMemoryPacket; falsePositiveFingerprints: string[]; falsePositives: RepoMemoryFalsePositiveEntry[] } {
  const repoMemoryConfig = input.config.repoMemory;
  if (!repoMemoryConfig?.enabled) return { falsePositiveFingerprints: [], falsePositives: [] };

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
  const liveFalsePositiveNotes = falsePositiveNotes.filter(
    (note) => note.kind === "false_positive" && note.fingerprint && !isRepoMemoryNoteExpired(note, generatedAtDate)
  );
  const falsePositiveFingerprints = liveFalsePositiveNotes.map((note) => note.fingerprint!);
  // Structured entries carry the coarse-match fields (#302) when the note has them (v0.2+); notes
  // that predate the coarse fields still supply their exact fingerprint via the list above.
  const falsePositives: RepoMemoryFalsePositiveEntry[] = liveFalsePositiveNotes
    .filter((note) => note.coarsePath && note.coarseCategory && typeof note.coarseLine === "number" && note.coarseTitle)
    .map((note) => ({
      fingerprint: note.fingerprint!,
      path: note.coarsePath!,
      category: note.coarseCategory!,
      line: note.coarseLine!,
      title: note.coarseTitle!,
      ...(note.confirmedByHuman !== undefined ? { confirmedByHuman: note.confirmedByHuman } : {})
    }));
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
      return { falsePositiveFingerprints, falsePositives };
    }
    throw new Error(`Repo memory packet failed closed: ${packetResult.error}`);
  }

  writeRedactedJson(join(input.evidenceDir, "repo-memory-packet.json"), packetResult);
  writeRedactedText(join(input.evidenceDir, "repo-memory-packet.md"), packetResult.packet.markdown);
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
  return { packet: packetResult.packet, falsePositiveFingerprints, falsePositives };
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
  writeRedactedText(join(input.evidenceDir, "gitnexus-context-packet.md"), packetResult.packet.markdown);
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
  writeRedactedText(join(input.evidenceDir, "skill-pack-context-packet.md"), packetResult.packet.markdown);
  return { packet: packetResult.packet };
}

export async function buildGitHubRelatedContext(input: {
  config: BotConfig;
  github: GitHubRelatedContextReader;
  repo: string;
  pull: PullRequestSummary;
  files?: PullFilePatch[];
  evidenceDir: string;
}): Promise<{ packet?: GitHubRelatedContextPacket }> {
  const relatedConfig = input.config.githubRelatedContext;
  if (!relatedConfig?.enabled) return {};

  const packetResult = await buildGitHubRelatedContextPacket({
    repo: input.repo,
    pull: input.pull,
    config: relatedConfig,
    reader: input.github,
    ...(input.files ? { files: input.files } : {})
  });

  if (!packetResult.ok) {
    writeRedactedJson(join(input.evidenceDir, "github-related-context-packet-error.json"), packetResult);
    return {};
  }

  writeRedactedJson(join(input.evidenceDir, "github-related-context-packet.json"), packetResult);
  writeRedactedText(join(input.evidenceDir, "github-related-context-packet.md"), packetResult.packet.markdown);
  // Evidence: the relevance component breakdown (#119 R8) makes the ranking replayable/inspectable.
  if (packetResult.relevanceBreakdown) {
    writeRedactedJson(join(input.evidenceDir, "github-related-context-relevance.json"), packetResult.relevanceBreakdown);
  }
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

export function writeDryRunOutcomeLedgerEvidence(input: {
  evidenceDir: string;
  repo: string;
  pull: PullRequestSummary;
  files: PullFilePatch[];
  plan: ReviewPlan;
  provider?: string;
  model?: string;
  runtime?: OutcomeLedgerRuntimeInput;
  duplicateSameHead?: OutcomeLedgerSafetyGateInput;
}): { ok: true } | { ok: false; error: string } {
  try {
    const outcomeLedger = buildOutcomeLedger(buildOutcomeLedgerInputFromReviewPlan({
      repo: input.repo,
      pull: input.pull,
      files: input.files,
      plan: input.plan,
      dryRun: true,
      safetyGateEvidence: {
        currentHead: {
          name: "current_head",
          status: "pass",
          detail: "Worker reached dry-run review-plan construction after stale-head preflight."
        },
        duplicateSameHead: input.duplicateSameHead ?? {
          name: "duplicate_same_head",
          status: "pass",
          detail: "Caller did not provide processed-head state; dry-run helper writes no public comments."
        },
        inlineCoordinateValidation: {
          name: "inline_coordinate_validation",
          status: "pass",
          detail: `${input.plan.comments.length} accepted inline comment(s) survived deterministic location validation before review-plan evidence was written.`
        }
      },
      runtime: {
        ...input.runtime,
        provider: input.provider ?? input.runtime?.provider,
        model: input.model ?? input.runtime?.model
      }
    }));
    const jsonPath = join(input.evidenceDir, "outcome-ledger.json");
    const markdownPath = join(input.evidenceDir, "outcome-ledger.md");
    const markdown = renderOutcomeLedgerMarkdown(outcomeLedger);
    try {
      writeRedactedJson(jsonPath, outcomeLedger);
      writeRedactedText(markdownPath, markdown);
    } catch (error) {
      rmSync(jsonPath, { force: true, recursive: true });
      rmSync(markdownPath, { force: true, recursive: true });
      throw error;
    }
    return { ok: true };
  } catch (error) {
    const message = redactSecrets(error instanceof Error ? error.message : String(error));
    writeRedactedJson(join(input.evidenceDir, "outcome-ledger-error.json"), {
      ok: false,
      error: message,
      proofBoundary: "Outcome Ledger dry-run evidence failed to build; stable review-plan evidence must continue."
    });
    return { ok: false, error: message };
  }
}

function recordStaleHeadSkip(input: {
  state: ReviewStateStore;
  repo: string;
  pull: PullRequestSummary;
  stale: StaleHeadEvidence;
  evidenceDir: string;
}): void {
  mkdirSync(input.evidenceDir, { recursive: true });
  writeRedactedJson(join(input.evidenceDir, "stale-head.json"), input.stale);
  input.state.recordProcessed({
    repo: input.repo,
    pullNumber: input.pull.number,
    headSha: input.pull.head.sha,
    status: "skipped",
    error: `${input.stale.reason}: live=${input.stale.liveHeadSha}`
  });
}

/**
 * Best-effort, FAIL-OPEN recording of the posted findings' public coordinates (#357). The fingerprint
 * is derived from the same fields as the gate so it matches label-store rows; title/body are used only
 * to compute the fingerprint and are NEVER stored. Any failure is swallowed — the review is already
 * posted and durable, so observation bookkeeping must never block or fail it.
 */
export function recordPostedReviewFindings(input: {
  state: Pick<ReviewStateStore, "recordReviewFindings">;
  repo: string;
  pull: PullRequestSummary;
  comments: ReviewComment[];
  now?: Date;
}): void {
  try {
    if (input.comments.length === 0) return;
    const recordedAt = (input.now ?? new Date()).toISOString();
    const records: ReviewFindingRecord[] = input.comments.map((comment) => ({
      // Use the gate-computed fingerprint threaded onto the comment (over the ORIGINAL finding,
      // incl. why_this_matters + raw title/body). Recomputing here from the sanitized comment would
      // hash a DIFFERENT identity (why_this_matters="", redacted title/body) and key the ledger under
      // a fingerprint that finding_outcome_labels never uses — silently breaking the #357 join.
      fingerprint: comment.fingerprint,
      repo: input.repo,
      pullNumber: input.pull.number,
      headSha: input.pull.head.sha,
      path: comment.path,
      line: comment.line,
      severity: comment.severity,
      category: comment.category,
      confidence: comment.confidence,
      recordedAt
    }));
    input.state.recordReviewFindings(records);
  } catch (error) {
    console.warn(
      `[findings-ledger] best-effort review-findings record failed repo=${input.repo} pr=${input.pull.number}: ${
        redactSecrets(error instanceof Error ? error.message : String(error))
      }`
    );
  }
}

export function recordConcurrentClaimSkip(input: {
  state: ReviewStateStore;
  repo: string;
  pull: PullRequestSummary;
  evidenceDir: string;
}): void {
  // The other claimant owns this head (#295). Do NOT recordProcessed here: that would `insert or
  // replace` the winner's row AND retire the winner's live claim. Record a skipped readiness note
  // (separate table) plus an evidence file, matching the existing skip-evidence idiom, and log it.
  const evidence = {
    reason: "concurrent_review_claim_held",
    repo: input.repo,
    pullNumber: input.pull.number,
    headSha: input.pull.head.sha,
    detail: "Another reviewPull (manual review-pr or daemon) holds the atomic per-head claim for this head; skipping to preserve at-most-one-review-per-head."
  };
  mkdirSync(input.evidenceDir, { recursive: true });
  // Through the redacting writer like every other evidence write (defense-in-depth; the
  // network-data-to-evidence-file pattern itself is the evidence-packet design, triaged as a
  // class under #249).
  writeRedactedJson(join(input.evidenceDir, "concurrent-claim-skip.json"), evidence);
  input.state.recordReviewReadiness({
    repo: input.repo,
    pullNumber: input.pull.number,
    headSha: input.pull.head.sha,
    state: "skipped",
    reason: "concurrent_review_claim_held"
  });
  console.warn(
    `[head-claim] concurrent claim held repo=${input.repo} pr=${input.pull.number} sha=${input.pull.head.sha}: skipping duplicate same-head review`
  );
}

export function recordFailedReview(input: {
  config: BotConfig;
  state: ReviewStateStore;
  repo: string;
  pull: PullRequestSummary;
  error: unknown;
  writeErrorEvidence?: boolean;
}): string {
  const evidenceDir = buildEvidenceDir(input.config, input.repo, input.pull, { action: "none", shouldReview: false });
  const previous = input.state.getProcessedReview(input.repo, input.pull.number, input.pull.head.sha);
  const rawErrorMessage = redactSecrets(input.error instanceof Error ? input.error.message : String(input.error));
  const errorMessage = formatZCodeTimeoutFailureError({
    error: input.error,
    previousError: previous?.error,
    timeoutMs: input.config.zcode.timeoutMs ?? 180_000
  }) ?? rawErrorMessage;
  if (input.writeErrorEvidence !== false) {
    mkdirSync(evidenceDir, { recursive: true });
    writeRedactedJson(join(evidenceDir, "review-error.json"), {
      repo: input.repo,
      pullNumber: input.pull.number,
      headSha: input.pull.head.sha,
      error: errorMessage,
      recordedAt: new Date().toISOString()
    });
  }
  input.state.recordProcessed({
    repo: input.repo,
    pullNumber: input.pull.number,
    headSha: input.pull.head.sha,
    status: "failed",
    error: errorMessage
  });
  return errorMessage;
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

/**
 * Config-gated retry-degraded confidence penalty (#304, default off). When a review's findings came
 * from a degraded (strict-JSON retry) parse and a penalty is configured, subtract it from each
 * finding's confidence (floored at 0) BEFORE the gate. Quieter-only by construction: lower confidence
 * can only demote ranking/floor eligibility, never promote. A no-op when not degraded or unconfigured.
 */
export function applyRetryDegradedConfidencePenalty(
  findings: Finding[],
  degradedRecovery: boolean,
  penalty: number | undefined
): Finding[] {
  if (!degradedRecovery || penalty === undefined || penalty <= 0) return findings;
  return findings.map((finding) => ({ ...finding, confidence: Math.max(0, finding.confidence - penalty) }));
}

/** Runtime-note provenance line for the outcome ledger (#304); undefined for a clean first-pass parse. */
export function buildRetryDegradedRuntimeNote(attempts: number, degradedRecovery: boolean): string | undefined {
  if (!degradedRecovery) return undefined;
  return `Findings recovered via the strict-JSON retry path (degraded): parsed on attempt ${attempts} of the ZCode review, not the first pass.`;
}

export function classifyProviderError(error: unknown): ProviderErrorClassification {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  const providerCode = extractProviderCode(message);
  const providerRequestId = extractProviderRequestId(message);
  const retryAfterMs = extractRetryAfterMs(message);
  const requestRateLimited =
    normalized.includes("429") ||
    normalized.includes("throttle") ||
    normalized.includes("too many requests") ||
    normalized.includes("rate limit") ||
    normalized.includes("rate_limit_error") ||
    normalized.includes("providercode: '1302'") ||
    normalized.includes('providercode: "1302"') ||
    normalized.includes("[1302]") ||
    providerCode === "1302";
  const overloaded =
    /\b5\d\d\b/.test(normalized) ||
    normalized.includes("network failure") ||
    normalized.includes("service unavailable") ||
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
  // Persistent model-output-schema/parse failures (#304): retryable within runWithProviderRetry's
  // bounded attempt budget (attempt < maxAttempts), but NOT a provider cooldown — it is a model
  // formatting problem, not a rate/quota/overload signal. The bound guarantees no infinite loop.
  if (isZCodeSchemaFailureError(error)) {
    return { ...base, category: "model_output_schema", reason: "model_output_schema_failure", retryable: true, cooldown: false };
  }
  if (/\b(json|schema|parseable|review object|review json|findings array|malformed output|invalid output)\b/.test(normalized)) {
    return { ...base, category: "model_output_schema", reason: "model_output_schema_failure", retryable: true, cooldown: false };
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

async function applySelfConsistencyRecheck(input: {
  config: BotConfig;
  gate: DeterministicReviewGateResult;
  files: PullFilePatch[];
  worktreePath: string;
  evidenceDir: string;
}): Promise<{ comments: DeterministicReviewGateResult["comments"]; event: DeterministicReviewGateResult["event"]; runtimeNote?: string }> {
  const selfConsistencyConfig = input.config.reviewGate?.selfConsistency;
  if (!selfConsistencyConfig?.enabled) {
    return { comments: input.gate.comments, event: input.gate.event };
  }

  const providerId = selfConsistencyConfig.provider ?? resolveSelectedReviewProvider(input.config).providerId;
  const result = await runSelfConsistencyRecheckAsync({
    comments: input.gate.comments,
    files: input.files,
    config: selfConsistencyConfig,
    ...(input.config.reviewGate?.requestChangesConfidenceFloors
      ? { requestChangesConfidenceFloors: input.config.reviewGate.requestChangesConfidenceFloors }
      : {}),
    ...(input.config.reviewGate?.categoryPrecisionFloors
      ? { categoryPrecisionFloors: input.config.reviewGate.categoryPrecisionFloors }
      : {}),
    secondDraw: async ({ comment, hunk }) => {
      const rawResponse = await runSelfConsistencySecondDraw({
        config: input.config,
        providerId,
        worktreePath: input.worktreePath,
        evidenceDir: input.evidenceDir,
        prompt: buildSelfConsistencyPrompt(comment, hunk)
      });
      return parseSelfConsistencyVerdict(rawResponse);
    }
  });

  // Redacted evidence: verdicts + both confidences, never raw model prose beyond the sanitized fields.
  writeRedactedJson(join(input.evidenceDir, "self-consistency.json"), {
    enabled: true,
    provider: providerId,
    maxFindingsPerReview: selfConsistencyConfig.maxFindingsPerReview ?? 5,
    verdicts: result.verdicts
  });

  const agreed = result.verdicts.filter((verdict) => verdict.agreed === true).length;
  const refuted = result.verdicts.filter((verdict) => verdict.refuted === true).length;
  const failed = result.verdicts.filter((verdict) => verdict.error !== undefined).length;
  const runtimeNote = result.verdicts.length
    ? `Self-consistency re-check (#303): ${result.verdicts.length} P0/P1 finding(s) re-drawn — ${agreed} agreed, ${refuted} refuted (downgraded/ineligible), ${failed} second-draw failure(s) left untouched.`
    : undefined;

  return { comments: result.comments, event: result.event, ...(runtimeNote ? { runtimeNote } : {}) };
}

async function runSelfConsistencySecondDraw(input: {
  config: BotConfig;
  providerId: string;
  worktreePath: string;
  evidenceDir: string;
  prompt: string;
}): Promise<string> {
  const selection = resolveSelectedReviewProvider(input.config, input.providerId);
  if (!selection.provider || selection.provider.adapter === "zcode") {
    const draw = runZCodeJsonObject({
      cwd: input.worktreePath,
      prompt: input.prompt,
      cliPath: input.config.zcode.cliPath,
      appConfigPath: input.config.zcode.appConfigPath,
      model: input.config.zcode.model,
      providerId: selection.providerId,
      evidenceDir: input.evidenceDir,
      timeoutMs: input.config.zcode.timeoutMs,
      retryMaxRetries: input.config.zcode.retryMaxRetries
    });
    return draw.rawResponse;
  }

  const provider = selection.provider;
  const adapter = createReviewRuntimeAdapter(selection.providerId, provider);
  const execution = await runWithProviderRetry({
    config: input.config,
    evidenceDir: input.evidenceDir,
    operation: () => adapter.execute({
      fixtureId: "self-consistency",
      providerId: selection.providerId,
      adapterId: provider.adapter,
      model: provider.model,
      prompt: input.prompt,
      outputContract: SELF_CONSISTENCY_OUTPUT_CONTRACT
    })
  });
  writeRedactedJson(join(input.evidenceDir, "self-consistency-provider-evidence.json"), {
    providerId: selection.providerId,
    adapterId: provider.adapter,
    model: provider.model,
    rawEvidence: execution.rawEvidence
  });
  return execution.text;
}

function buildSelfConsistencyPrompt(comment: DeterministicReviewGateResult["comments"][number], hunk: string): string {
  return [
    "You are re-checking a SINGLE prior code-review finding for self-consistency.",
    "Do not modify files, run commands, or inspect anything beyond the finding and diff hunk below.",
    "Decide independently whether the finding is a genuine, actionable issue on the current diff.",
    "Return JSON ONLY: {\"verified\": true|false, \"confidence\": 0.0}. No prose, no code fences.",
    "verified=true means you AGREE the finding is real; verified=false means you REFUTE it.",
    "",
    `Finding severity: ${comment.severity}`,
    `Finding file: ${comment.path} (line ${comment.line})`,
    `Finding title: ${comment.title}`,
    `Finding detail: ${comment.body}`,
    "",
    "Relevant diff hunk:",
    "```diff",
    hunk,
    "```"
  ].join("\n");
}

function parseSelfConsistencyVerdict(rawResponse: string): SelfConsistencySecondDrawResult {
  let response = rawResponse;
  try {
    response = extractZCodeResponse(rawResponse);
  } catch {
    // Native/provider-adapter self-consistency responses are already model JSON text.
  }
  const parsed = JSON.parse(extractAnyJsonObject(response)) as { verified?: unknown; confidence?: unknown };
  if (typeof parsed.verified !== "boolean") {
    throw new Error("Self-consistency verdict missing boolean verified field.");
  }
  if (typeof parsed.confidence !== "number" || !Number.isFinite(parsed.confidence)) {
    throw new Error("Self-consistency verdict missing finite confidence field.");
  }
  const verified = parsed.verified === true;
  const confidence = Math.min(1, Math.max(0, parsed.confidence));
  return { verified, confidence };
}

type ContextBudgetReviewExecution =
  | { status: "reviewed"; result: ZCodeReviewResult & { runtime: OutcomeLedgerRuntimeInput } }
  | { status: "skipped_context_budget" }
  | { status: "skipped_stale_head" };

async function runReviewWithContextBudget(input: {
  config: BotConfig;
  github: GitHubApi;
  state: ReviewStateStore;
  repo: string;
  pull: PullRequestSummary;
  worktreePath: string;
  prompt: string;
  contextBudget: ContextBudgetPlan;
  promptForFiles: (files: PullFilePatch[]) => string;
  useZCode: boolean;
  evidenceDir: string;
}): Promise<ContextBudgetReviewExecution> {
  if (input.contextBudget.mode === "chunk") {
    return runChunkedZCodeReview({
      ...input,
      contextBudget: input.contextBudget
    });
  }

  const result = input.useZCode
    ? await runSelectedReviewWithProviderRetry({
        config: input.config,
        worktreePath: input.worktreePath,
        prompt: input.prompt,
        evidenceDir: input.evidenceDir
      })
    : disabledZCodeReviewResult(input.config);
  return { status: "reviewed", result };
}

async function runChunkedZCodeReview(input: {
  config: BotConfig;
  github: GitHubApi;
  state: ReviewStateStore;
  repo: string;
  pull: PullRequestSummary;
  worktreePath: string;
  contextBudget: Extract<ContextBudgetPlan, { mode: "chunk" }>;
  promptForFiles: (files: PullFilePatch[]) => string;
  useZCode: boolean;
  evidenceDir: string;
}): Promise<ContextBudgetReviewExecution> {
  const startedAt = new Date();
  const findings: ZCodeReviewResult["findings"] = [];
  const droppedFromSchema: ZCodeReviewResult["droppedFromSchema"] = [];
  const rawResponses: Array<{ index: number; rawResponse: string }> = [];
  const runtimeNotes: string[] = [`Context budget chunked review executed in ${input.contextBudget.chunks.length} chunks.`];
  let attempts = 0;
  let degradedRecovery = false;
  let providerAttempts = 0;

  for (const chunk of input.contextBudget.chunks) {
    const livePull = await input.github.getPull(input.repo, input.pull.number);
    const stale = detectStalePullHead({ expected: input.pull, live: livePull, phase: "before_chunk" });
    if (stale) {
      recordStaleHeadSkip({ state: input.state, repo: input.repo, pull: input.pull, stale, evidenceDir: input.evidenceDir });
      return { status: "skipped_stale_head" };
    }
    const chunkDir = join(input.evidenceDir, "context-chunks", `chunk-${String(chunk.index).padStart(3, "0")}`);
    mkdirSync(chunkDir, { recursive: true });
    const prompt = input.promptForFiles(chunk.files);
    writeSecureFileSync(join(chunkDir, "review-prompt.txt"), redactSecrets(prompt));

    let result: ZCodeReviewResult & { runtime: OutcomeLedgerRuntimeInput };
    try {
      result = input.useZCode
        ? await runSelectedReviewWithProviderRetry({
            config: input.config,
            worktreePath: input.worktreePath,
            prompt,
            evidenceDir: chunkDir
          })
        : disabledZCodeReviewResult(input.config);
    } catch (error) {
      const message = redactSecrets(error instanceof Error ? error.message : String(error));
      const failure = new Error(`context_budget_chunk_provider_failure chunk=${chunk.index}: ${message}`);
      writeRedactedJson(join(chunkDir, "review-error.json"), {
        repo: input.repo,
        pullNumber: input.pull.number,
        headSha: input.pull.head.sha,
        chunk: chunk.index,
        error: failure.message,
        recordedAt: new Date().toISOString()
      });
      recordFailedReview({
        config: input.config,
        state: input.state,
        repo: input.repo,
        pull: input.pull,
        error: failure,
        writeErrorEvidence: false
      });
      return { status: "skipped_context_budget" };
    }

    const allowedFilenames = new Set(chunk.filenames);
    const chunkFindings = result.findings.filter((finding) => allowedFilenames.has(finding.path));
    const droppedCrossChunkFindings: DroppedFinding[] = result.findings
      .filter((finding) => !allowedFilenames.has(finding.path))
      .map((finding) => ({ ...finding, reason: "chunk_path_mismatch" }));
    findings.push(...chunkFindings);
    droppedFromSchema.push(...result.droppedFromSchema, ...droppedCrossChunkFindings);
    rawResponses.push({ index: chunk.index, rawResponse: result.rawResponse });
    attempts += result.attempts;
    degradedRecovery = degradedRecovery || result.degradedRecovery;
    providerAttempts += result.runtime.providerAttempts ?? 0;
    if (droppedCrossChunkFindings.length > 0) {
      runtimeNotes.push(`chunk ${chunk.index}: dropped ${droppedCrossChunkFindings.length} finding(s) outside this chunk's file set.`);
    }
    if (result.runtime.notes) {
      runtimeNotes.push(...result.runtime.notes.map((note) => `chunk ${chunk.index}: ${note}`));
    }
  }

  const completedAt = new Date();
  const providerMetadata = buildReviewProviderMetadata(input.config);
  return {
    status: "reviewed",
    result: {
      findings,
      droppedFromSchema,
      rawResponse: JSON.stringify({ findings, chunks: rawResponses }),
      attempts,
      degradedRecovery,
      runtime: {
        provider: providerMetadata.providerId,
        model: providerMetadata.model,
        startedAt: startedAt.toISOString(),
        completedAt: completedAt.toISOString(),
        latencyMs: completedAt.getTime() - startedAt.getTime(),
        providerAttempts,
        notes: runtimeNotes
      }
    }
  };
}

function disabledZCodeReviewResult(config: BotConfig): ZCodeReviewResult & { runtime: OutcomeLedgerRuntimeInput } {
  const provider = buildReviewProviderMetadata(config);
  return {
    findings: [],
    droppedFromSchema: [],
    rawResponse: "{\"findings\":[]}",
    attempts: 0,
    degradedRecovery: false,
    runtime: {
      provider: provider.providerId,
      model: provider.model,
      providerAttempts: 0,
      notes: ["Review provider execution disabled for this dry-run; provider latency and token usage were not measured."]
    }
  };
}

async function runSelectedReviewWithProviderRetry(input: {
  config: BotConfig;
  worktreePath: string;
  prompt: string;
  evidenceDir: string;
  providerId?: string;
}): Promise<ZCodeReviewResult & { runtime: OutcomeLedgerRuntimeInput }> {
  const selection = resolveSelectedReviewProvider(input.config, input.providerId);
  if (!selection.provider || selection.provider.adapter === "zcode") {
    return runZCodeReviewWithProviderRetry(input);
  }
  const provider = selection.provider;
  const adapter = createReviewRuntimeAdapter(selection.providerId, provider);
  const startedAt = new Date();
  let providerAttempts = 0;
  const result = await runWithProviderRetry({
    config: input.config,
    evidenceDir: input.evidenceDir,
    operation: async () => {
      providerAttempts += 1;
      const execution = await adapter.execute({
        fixtureId: "live-review",
        providerId: selection.providerId,
        adapterId: provider.adapter,
        model: provider.model,
        prompt: input.prompt
      });
      writeRedactedJson(join(input.evidenceDir, "provider-adapter-evidence.json"), {
        providerId: selection.providerId,
        adapterId: provider.adapter,
        model: provider.model,
        reviewJsonValidated: execution.reviewJsonValidated === true,
        rawEvidence: execution.rawEvidence
      });
      const parsed = JSON.parse(extractJsonObject(execution.text)) as unknown;
      const { findings, dropped } = parseFindings(parsed);
      return {
        findings,
        droppedFromSchema: dropped,
        rawResponse: execution.text,
        attempts: 1,
        degradedRecovery: false
      };
    }
  });
  const completedAt = new Date();
  return {
    ...result,
    runtime: {
      provider: selection.providerId,
      model: provider.model,
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      latencyMs: completedAt.getTime() - startedAt.getTime(),
      providerAttempts,
      notes: [
        `Observed outer provider retry attempts: ${providerAttempts}.`,
        `Review executed through ${provider.adapter} provider adapter.`
      ]
    }
  };
}

function resolveSelectedReviewProvider(config: BotConfig, providerOverride?: string): {
  providerId: string;
  provider?: ProviderRegistryEntry;
} {
  const providerId = providerOverride ?? config.zcode.providerId ?? config.providers?.defaultProviderId ?? "zcode-glm";
  return {
    providerId,
    provider: config.providers?.providers[providerId]
  };
}

function createReviewRuntimeAdapter(providerId: string, provider: ProviderRegistryEntry): ProviderRuntimeAdapter {
  if (!provider.enabled) throw new Error(`Selected review provider ${providerId} is disabled.`);
  if (!provider.capabilities.review || !provider.capabilities.jsonOutput) {
    throw new Error(`Selected review provider ${providerId} must declare review and JSON output capabilities.`);
  }
  if (provider.adapter === "openai-compatible") {
    return createOpenAICompatibleReviewAdapter({ providerId, provider });
  }
  if (provider.adapter === "anthropic") {
    return createAnthropicReviewAdapter({ providerId, provider });
  }
  if (provider.adapter === "openai") {
    return createOpenAINativeReviewAdapter({ providerId, provider });
  }
  if (provider.adapter === "gemini") {
    return createGeminiReviewAdapter({ providerId, provider });
  }
  throw new Error(`Selected review provider ${providerId} uses unsupported adapter ${provider.adapter}.`);
}

async function runZCodeReviewWithProviderRetry(input: {
  config: BotConfig;
  worktreePath: string;
  prompt: string;
  evidenceDir: string;
  providerId?: string;
}): Promise<ZCodeReviewResult & { runtime: OutcomeLedgerRuntimeInput }> {
  const startedAt = new Date();
  let providerAttempts = 0;
  const result = await runWithProviderRetry({
    config: input.config,
    evidenceDir: input.evidenceDir,
    operation: () => {
      providerAttempts += 1;
      return runZCodeReview({
        cwd: input.worktreePath,
        prompt: input.prompt,
        cliPath: input.config.zcode.cliPath,
        appConfigPath: input.config.zcode.appConfigPath,
        model: input.config.zcode.model,
        providerId: input.providerId ?? input.config.zcode.providerId,
        evidenceDir: input.evidenceDir,
        timeoutMs: input.config.zcode.timeoutMs,
        retryMaxRetries: input.config.zcode.retryMaxRetries
      });
    }
  });
  const completedAt = new Date();
  return {
    ...result,
    runtime: {
      provider: input.providerId ?? input.config.zcode.providerId,
      model: input.config.zcode.model,
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      latencyMs: completedAt.getTime() - startedAt.getTime(),
      notes: [
        `Observed outer provider retry attempts: ${providerAttempts}.`,
        "Internal ZCode retry attempts and token usage are not exposed by the configured provider path; providerAttempts and token metrics remain null.",
        // Retry-degraded provenance (#304): surfaced only when the strict-JSON retry path produced
        // the accepted parse, so evidence packets and the ledger runtime honestly flag it.
        ...(result.degradedRecovery
          ? [buildRetryDegradedRuntimeNote(result.attempts, result.degradedRecovery)!]
          : [])
      ]
    }
  };
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
  writeRedactedJson(join(evidenceDir, "provider-retry.json"), attempts);
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
  // A public command (#345) reaching this re-resolution path was already authorized (bot + cooldown
  // gated) at enqueue, so match it by its known commentId without re-running the cooldown. Without a
  // specific commentId, only trusted commands act here — the scheduler owns public admission.
  const commands = input.commandCommentId
    ? [...collected.commands, ...collected.publicEligible].filter((command) => command.commentId === input.commandCommentId)
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

function sanitizeDroppedFindings(dropped: ReviewPlan["dropped"], publicConfidencePolicy?: PublicConfidenceDisplayPolicy): ReviewPlan["dropped"] {
  return dropped.map((finding) => ({
    ...finding,
    ...(typeof finding.title === "string" ? { title: sanitizePublicConfidenceText(redactSecrets(finding.title), publicConfidencePolicy) } : {}),
    ...(typeof finding.body === "string" ? { body: sanitizePublicConfidenceText(redactSecrets(finding.body), publicConfidencePolicy) } : {}),
    ...(typeof finding.why_this_matters === "string"
      ? { why_this_matters: sanitizePublicConfidenceText(redactSecrets(finding.why_this_matters), publicConfidencePolicy) }
      : {})
  }));
}

function writeRedactedJson(path: string, value: unknown): void {
  writeSecureFileSync(path, `${redactSecrets(JSON.stringify(value, null, 2))}\n`);
}

function writeRedactedText(path: string, value: string): void {
  writeSecureFileSync(path, redactSecrets(value));
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
