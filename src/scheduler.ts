import { isPreActivationExistingPull } from "./activation-policy.js";
import { loadConfig, type BotConfig, type RepoReviewSchedulerConfig } from "./config.js";
import {
  collectTrustedReviewCommands,
  decideCommandAction,
  isBotCommandComment,
  isFinishingTouchCommandAction,
  isReviewCommandAction,
  type CommandDecision,
  type ReviewCommand
} from "./commands.js";
import { isFinishingTouchActionEnabled } from "./finishing-touches.js";
import { DEFAULT_BOT_LOGIN, GitHubApi } from "./github.js";
import { listReposToScan, resolveRepoProfile } from "./repo-policy.js";
import {
  postReviewStatusComment,
  type ReviewStatusCommentGithub,
  type ReviewStatusCommentPostResult,
  type ReviewStatusCommentState
} from "./review-status-comment.js";
import {
  buildReviewBudgetStatus,
  ReviewRunBudget,
  type ReviewBudgetStatus,
  type ReviewQueueDelayReason
} from "./review-budget.js";
import {
  ACTIVATION_BASELINE_EXISTING_HEAD_ERROR,
  isActivationBaselineProcessedReview,
  parseProviderCooldownError,
  ReviewStateStore,
  type ProcessedStatus,
  type ProcessedCommandAction,
  type ReviewReadinessState,
  type ReviewerSessionJobState,
  type ReviewQueueJobRecord,
  type ReviewQueueJobState,
  type ReviewQueueJobSource
} from "./state.js";
import type { ChangedSurfaceValidationReport, PullFilePatch, PullRequestSummary, ReviewEvent } from "./types.js";
import type { IssueCommentCommandSource } from "./commands.js";
import { buildChangedSurfaceValidationReport } from "./validation-selector.js";
import { redactSecrets } from "./secrets.js";
import {
  activateRepoForNewOnlyReview,
  isCanaryAllowed,
  recordFailedReview,
  classifyProviderError,
  recordProviderRateLimitCooldownIfNeeded,
  providerCooldownDurationMs,
  reviewPull,
  type ReviewPullInput,
  type ReviewPullResult,
  type RunOnceOptions,
  type RunOnceResult
} from "./worker.js";

export interface ScheduledRunResult extends RunOnceResult {
  commandFetchErrors: number;
  statusCommentFailures: number;
  queue: {
    enqueued: number;
    alreadyQueued: number;
    leased: number;
    completed: number;
    providerDeferred: number;
    staleRetired: number;
    closedRetired: number;
    failedQueueJobs: number;
    remainingQueued: number;
    delayedByReason: Partial<Record<ReviewQueueDelayReason, number>>;
    budget?: ReviewBudgetStatus;
  };
}

export interface SchedulerGitHubApi {
  listOpenPulls(repo: string): Promise<PullRequestSummary[]>;
  getPull(repo: string, pullNumber: number): Promise<PullRequestSummary>;
  listIssueComments(repo: string, issueNumber: number): Promise<IssueCommentCommandSource[]>;
  canPostAsApp?: ReviewStatusCommentGithub["canPostAsApp"];
  upsertIssueComment?: ReviewStatusCommentGithub["upsertIssueComment"];
  // Optional: only invoked when riskWeightedQueue is enabled, to derive risk from changed surface.
  listPullFiles?(repo: string, pullNumber: number): Promise<PullFilePatch[]>;
}

export async function runScheduledCycle(options: RunOnceOptions): Promise<ScheduledRunResult> {
  const config = loadConfig(options.configPath);
  const github = new GitHubApi(config.github);
  const state = new ReviewStateStore(config.statePath);
  try {
    return await runScheduledCycleWithDeps({
      config,
      github,
      state,
      options,
      reviewPullImpl: reviewPull
    });
  } finally {
    state.close();
  }
}

export async function runScheduledCycleWithDeps(input: {
  config: BotConfig;
  github: SchedulerGitHubApi;
  state: ReviewStateStore;
  options: RunOnceOptions;
  reviewPullImpl: (input: ReviewPullInput) => Promise<ReviewPullResult>;
  now?: Date;
  clock?: () => Date;
}): Promise<ScheduledRunResult> {
  const config = input.config;
  const scheduler = config.reviewScheduler;
  if (!scheduler?.enabled) {
    throw new Error("runScheduledCycleWithDeps requires config.reviewScheduler.enabled=true");
  }
  const result = emptyScheduledRunResult();
  const now = input.now ?? new Date();
  const eventClock = input.clock ?? (() => input.now ?? new Date());
  const repos = input.options.repo ? [input.options.repo] : listReposToScan(config);
  const providerId = config.zcode.providerId ?? config.zcode.model ?? "zcode";
  if (config.reviewerSessions?.enabled) {
    input.state.reconcileReviewerSessions(now, input.options.repo);
  }

  for (const repo of repos) {
    result.reposScanned += 1;
    const repoPolicy = resolveRepoProfile(config, repo);
    if (!repoPolicy.allowed) {
      result.skippedPolicy += 1;
      result.policySkips.push({ repo, reason: repoPolicy.reason });
      continue;
    }

    const pulls = input.options.pullNumber
      ? [await input.github.getPull(repo, input.options.pullNumber)]
      : await input.github.listOpenPulls(repo);
    result.pullsSeen += pulls.length;
    const activation = activateRepoForNewOnlyReview({
      config,
      state: input.state,
      repo,
      pulls,
      scopedPullNumber: input.options.pullNumber,
      now
    });
    result.baselinedExisting += activation.baselined;

    for (const pull of pulls) {
      const enqueueStatus = await enqueuePullIfEligible({
        config,
        github: input.github,
        state: input.state,
        repo,
        pull,
        providerId,
        now,
        dryRun: input.options.dryRun,
        reviewPullImpl: input.reviewPullImpl,
        allowActivationBaselineCommandLookup: input.options.pullNumber !== undefined,
        onStatusCommentFailure: () => {
          result.statusCommentFailures += 1;
        },
        onCommandFetchError: () => {
          result.commandFetchErrors += 1;
        }
      });
      applyEnqueueStatus(result, enqueueStatus);
    }
  }

  const reconciled = reconcileProcessedSkippedFailedQueueJobs(input.state, now);
  result.queue.providerDeferred += reconciled.providerDeferred;
  result.queue.staleRetired += reconciled.staleRetired;
  reprioritizeExistingSelfRepoQueueJobs({
    config,
    state: input.state,
    now
  });

  result.queue.budget = buildReviewBudgetStatus({
    config,
    jobs: input.state.listReviewQueueJobs(),
    now,
    includeDetails: false
  });
  result.queue.delayedByReason = result.queue.budget.delayedByReason;

  const budget = new ReviewRunBudget(Math.max(1, scheduler.maxProviderActive));
  const attemptedJobIds = new Set<string>();
  const attemptedJobs: ReviewQueueJobRecord[] = [];
  const repoActiveLimitOverrides = buildRepoActiveLimitOverrides(config, input.state.listReviewQueueJobs());
  // Lease just before execution to avoid idle active rows. This intentionally
  // performs a bounded scan per provider slot, not one bulk pre-lease.
  for (let leaseAttempt = 0; leaseAttempt < scheduler.maxProviderActive; leaseAttempt += 1) {
    const leased = input.state.leaseNextReviewQueueJobs({
      maxProviderActive: scheduler.maxProviderActive,
      maxOrgActive: scheduler.maxOrgActive,
      maxRepoActive: scheduler.maxRepoActive,
      maxRepoActiveByRepo: repoActiveLimitOverrides,
      manualCommandReserve: scheduler.manualCommandReserve,
      excludeJobIds: attemptedJobIds,
      reservedActiveJobs: attemptedJobs,
      limit: 1,
      leaseTtlMs: config.reviewConcurrency.leaseTtlMs,
      // Lease-time rescue aging (#346): pass through only when configured — the comparator no-ops
      // when aging is unset/disabled, keeping the default lease order byte-identical to today.
      ...(config.riskWeightedQueue?.aging ? { aging: config.riskWeightedQueue.aging } : {}),
      now: eventClock()
    });
    const job = leased[0];
    if (!job) break;
    attemptedJobIds.add(job.jobId);
    attemptedJobs.push(job);
    result.queue.leased += 1;
    const status = await runLeasedQueueJob({
      config,
      github: input.github,
      state: input.state,
      job,
      dryRun: input.options.dryRun,
      useZCode: input.options.useZCode ?? true,
      reviewPullImpl: input.reviewPullImpl,
      budget,
      onStatusCommentFailure: () => {
        result.statusCommentFailures += 1;
      },
      now,
      clock: eventClock
    });
    applyReviewStatus(result, status);
    if (status === "skipped_provider_cooldown") {
      result.queue.providerDeferred += deferQueuedProviderJobsForProviderThrottle({
        config,
        state: input.state,
        triggerJob: job,
        now: eventClock()
      });
      break;
    }
  }

  result.queue.remainingQueued = input.state.listReviewQueueJobs({ states: ["queued", "provider_deferred", "blocked_on_proof"] }).length;
  return result;
}

type EnqueueStatus =
  | "enqueued"
  | "already_queued"
  | "skipped_draft"
  | "skipped_canary"
  | "skipped_processed"
  | "skipped_capacity"
  | "skipped_finishing_touch_draft"
  | "skipped_stale_head"
  | "provider_deferred"
  | "closed_retired";

async function enqueuePullIfEligible(input: {
  config: BotConfig;
  github: SchedulerGitHubApi;
  state: ReviewStateStore;
  repo: string;
  pull: PullRequestSummary;
  providerId: string;
  now: Date;
  dryRun: boolean;
  reviewPullImpl: (input: ReviewPullInput) => Promise<ReviewPullResult>;
  allowActivationBaselineCommandLookup?: boolean;
  onStatusCommentFailure?: () => void;
  onCommandFetchError?: () => void;
  automaticPriorityOverride?: number;
}): Promise<EnqueueStatus> {
  if (isClosedPull(input.pull)) {
    await retireQueuedJobsForClosedPull(input);
    return "closed_retired";
  }
  markSupersededReadinessRowsForPull(input.state, input.repo, input.pull, input.now);
  if (input.config.skipDrafts && input.pull.draft) {
    recordReadinessTransition({
      state: input.state,
      repo: input.repo,
      pull: input.pull,
      readinessState: "skipped",
      reason: "draft_pr",
      now: input.now
    });
    return "skipped_draft";
  }
  if (!isCanaryAllowed(input.config, input.repo, input.pull.number)) {
    recordReadinessTransition({
      state: input.state,
      repo: input.repo,
      pull: input.pull,
      readinessState: "skipped",
      reason: "canary_policy",
      now: input.now
    });
    return "skipped_canary";
  }

  const processed = input.state.getProcessedReview(input.repo, input.pull.number, input.pull.head.sha);
  if (
    !input.allowActivationBaselineCommandLookup &&
    !processed &&
    isPreActivationExistingPull({
      config: input.config,
      state: input.state,
      repo: input.repo,
      pull: input.pull
    })
  ) {
    await retireSupersededQueueJobsForPull(input);
    recordActivationBaselineExistingHead(input.state, input.repo, input.pull);
    backfillReadinessFromProcessedHead(input.state, input.repo, input.pull, input.now);
    return "skipped_processed";
  }
  if (!input.allowActivationBaselineCommandLookup && isActivationBaselineProcessedReview(processed)) {
    await retireSupersededQueueJobsForPull(input);
    backfillReadinessFromProcessedHead(input.state, input.repo, input.pull, input.now);
    return "skipped_processed";
  }

  const commandDecision = await resolveSchedulerCommandDecision(input);
  if (commandDecision.action !== "none") {
    if (commandDecision.shouldReview) {
      await retireSupersededQueueJobsForPull(input);
    }
    const queued = enqueueReviewJob(input, commandDecision);
    recordReadinessForEnqueue({
      state: input.state,
      repo: input.repo,
      pull: input.pull,
      source: "manual_command",
      commandAction: commandDecision.action,
      commandCommentId: commandDecision.commandId,
      now: input.now
    });
    if (isFinishingTouchCommandAction(commandDecision.action)) {
      if (!queued.enqueued) return "already_queued";
      input.state.updateReviewQueueJobState({
        jobId: queued.job.jobId,
        state: "command_recorded",
        lastError: "manual_command_finishing_touch_draft_recorded",
        now: input.now
      });
      const status = await input.reviewPullImpl({
        config: input.config,
        github: input.github as GitHubApi,
        state: input.state,
        repo: input.repo,
        pull: input.pull,
        dryRun: input.dryRun,
        useZCode: false,
        budget: new ReviewRunBudget(1),
        allowActivationBaselineCommandLookup: true,
        commandCommentId: commandDecision.commandId
      });
      return status === "skipped_stale_head" ? "skipped_stale_head" : "skipped_finishing_touch_draft";
    }
    if (queued.enqueued && commandDecision.shouldReview) {
      await syncReviewStatusComment({
        config: input.config,
        github: input.github,
        dryRun: input.dryRun,
        repo: input.repo,
        pull: input.pull,
        state: "queued",
        onStatusCommentFailure: input.onStatusCommentFailure,
        now: input.now
      });
    }
    return queued.enqueued ? "enqueued" : "already_queued";
  }

  await retireSupersededQueueJobsForPull(input);
  if (processed || input.state.hasProcessed(input.repo, input.pull.number, input.pull.head.sha)) {
    backfillReadinessFromProcessedHead(input.state, input.repo, input.pull, input.now);
    return "skipped_processed";
  }
  const activeQueueJob = getActiveQueueJobForHead(input.state, input.repo, input.pull.number, input.pull.head.sha);
  if (activeQueueJob) {
    backfillReadinessFromActiveQueueJob(input.state, input.repo, input.pull, activeQueueJob, input.now);
    return "already_queued";
  }
  const repoScheduler = resolveRepoReviewScheduler(input.config, input.repo);
  const maxQueuedHeads = repoScheduler?.maxQueuedHeads ?? input.config.reviewScheduler?.maxQueuedPerRepo ?? 10;
  if (!hasRepoQueueCapacity(input.state, input.repo, maxQueuedHeads)) {
    const overflowAction = repoScheduler?.overflowAction ?? "defer";
    const deferredDetails = `Repo review queue capacity is full for this repo (limit ${maxQueuedHeads}).`;
    if (overflowAction === "skip") {
      // Explicit policy escape hatch: "skip" is terminal for this exact head.
      // The default "defer" path keeps transient burst heads eligible once capacity frees.
      input.state.recordProcessed({
        repo: input.repo,
        pullNumber: input.pull.number,
        headSha: input.pull.head.sha,
        status: "skipped",
        error: "repo_queue_capacity_full"
      });
      recordReadinessTransition({
        state: input.state,
        repo: input.repo,
        pull: input.pull,
        readinessState: "skipped",
        reason: "repo_queue_capacity_full",
        now: input.now
      });
      await syncReviewStatusComment({
        config: input.config,
        github: input.github,
        dryRun: input.dryRun,
        repo: input.repo,
        pull: input.pull,
        state: "skipped",
        details: `${deferredDetails} Repo policy skips excess burst heads.`,
        onStatusCommentFailure: input.onStatusCommentFailure,
        now: input.now
      });
      return "skipped_capacity";
    }
    if (!isCapacityDeferredReadiness(input.state, input.repo, input.pull)) {
      recordReadinessTransition({
        state: input.state,
        repo: input.repo,
        pull: input.pull,
        readinessState: "provider_deferred",
        reason: "repo_queue_capacity_full",
        now: input.now
      });
      await syncReviewStatusComment({
        config: input.config,
        github: input.github,
        dryRun: input.dryRun,
        repo: input.repo,
        pull: input.pull,
        state: "provider_deferred",
        details: deferredDetails,
        onStatusCommentFailure: input.onStatusCommentFailure,
        now: input.now
      });
    }
    return "skipped_capacity";
  }

  const activeRepoCooldown = input.state.getActiveRepoProviderCooldown(input.repo, input.now);
  if (activeRepoCooldown) {
    const queued = enqueueReviewJob(input);
    input.state.updateReviewQueueJobState({
      jobId: queued.job.jobId,
      state: "provider_deferred",
      nextEligibleAt: activeRepoCooldown.cooldownUntil,
      lastError: `repo_provider_cooldown_until=${activeRepoCooldown.cooldownUntil}; reason=${activeRepoCooldown.reason}`,
      now: input.now
    });
    recordReadinessTransition({
      state: input.state,
      repo: input.repo,
      pull: input.pull,
      readinessState: "provider_deferred",
      reason: "repo_provider_cooldown_active",
      now: input.now
    });
    if (queued.enqueued) {
      await syncReviewStatusComment({
        config: input.config,
        github: input.github,
        dryRun: input.dryRun,
        repo: input.repo,
        pull: input.pull,
        state: "provider_deferred",
        details: "Provider cooldown is active for this repo.",
        onStatusCommentFailure: input.onStatusCommentFailure,
        now: input.now
      });
    }
    return "provider_deferred";
  }

  // Risk-weighted enqueue priority (#301): only when explicitly enabled do we fetch the changed
  // surface to derive a risk tier. Disabled (default) ⇒ no extra GitHub call, flat priority.
  input.automaticPriorityOverride = await resolveRiskWeightedPriorityOverride(input);

  const enqueued = enqueueReviewJob(input);
  recordReadinessForEnqueue({
    state: input.state,
    repo: input.repo,
    pull: input.pull,
    source: "automatic",
    now: input.now
  });
  if (enqueued.enqueued) {
    await syncReviewStatusComment({
      config: input.config,
      github: input.github,
      dryRun: input.dryRun,
      repo: input.repo,
      pull: input.pull,
      state: "queued",
      onStatusCommentFailure: input.onStatusCommentFailure,
      now: input.now
    });
  }
  return enqueued.enqueued ? "enqueued" : "already_queued";
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

function enqueueReviewJob(input: {
  config: BotConfig;
  state: ReviewStateStore;
  repo: string;
  pull: PullRequestSummary;
  providerId: string;
  now: Date;
  automaticPriorityOverride?: number;
}, commandDecision?: Exclude<CommandDecision, { action: "none"; shouldReview: false }>) {
  const source: ReviewQueueJobSource = commandDecision ? "manual_command" : "automatic";
  const sessionId = shouldAssignReviewerSession(commandDecision)
    ? assignReviewerSessionForQueueJob(input, source, commandDecision)?.session?.sessionId
    : undefined;
  const automaticPriority = input.automaticPriorityOverride ?? automaticQueuePriority(input.config, input.repo);
  return input.state.enqueueReviewQueueJob({
    repo: input.repo,
    pullNumber: input.pull.number,
    headSha: input.pull.head.sha,
    baseSha: input.pull.base.sha,
    source,
    lane: source === "manual_command" ? "manual" : "background",
    providerId: input.providerId,
    priority: source === "manual_command" ? undefined : automaticPriority,
    ...(commandDecision ? { commentId: commandDecision.commandId } : {}),
    ...(sessionId ? { sessionId } : {}),
    now: input.now
  });
}

export async function resolveRiskWeightedPriorityOverride(input: {
  config: BotConfig;
  github: SchedulerGitHubApi;
  repo: string;
  pull: PullRequestSummary;
}): Promise<number | undefined> {
  // Gated (#301): disabled (default) or an API that can't list files ⇒ no fetch, flat priority.
  if (!input.config.riskWeightedQueue?.enabled || !input.github.listPullFiles) return undefined;
  let report;
  try {
    const files = await input.github.listPullFiles(input.repo, input.pull.number);
    const profile = resolveRepoProfile(input.config, input.repo);
    report = buildChangedSurfaceValidationReport({
      repo: input.repo,
      pull: input.pull,
      files,
      ...(profile.allowed ? { profile: profile.profile } : {})
    });
  } catch (error) {
    // Never block enqueue on a file-fetch failure: log and fall back to flat priority.
    console.warn(
      `[risk-queue] changed-surface fetch failed repo=${input.repo} pr=${input.pull.number} sha=${input.pull.head.sha}: ${
        redactSecrets(error instanceof Error ? error.message : String(error))
      }`
    );
    return undefined;
  }
  const { priority, tier, reason } = riskWeightedQueuePriority({ config: input.config, repo: input.repo, report });
  if (tier !== "default") {
    console.warn(
      redactSecrets(
        `[risk-queue] repo=${input.repo} pr=${input.pull.number} sha=${input.pull.head.sha} tier=${tier} priority=${priority ?? "default"} reason=${reason}`
      )
    );
  }
  return priority;
}

function automaticQueuePriority(config: BotConfig, repo: string): number | undefined {
  const backgroundPriority = config.reviewScheduler?.backgroundPriority;
  if (!isSelfRepo(repo)) return backgroundPriority;
  return Math.min(backgroundPriority ?? 50, 1);
}

export type RiskQueueTier = "elevated" | "docs_only" | "default";

/**
 * Risk-weighted enqueue priority (#301): derive a queue tier from the already-shipped
 * changed-surface validation report — a PR whose changed files match a required-validation category
 * (auth/security/migration/release/runtime) is elevated (numerically lower priority = leased
 * sooner); a docs-only PR is deferred. When the feature is disabled or no report is available, this
 * returns the flat automaticQueuePriority so behavior is byte-identical to today. Pure and exported
 * for tests; no new path-classification logic (the report is the sole risk source).
 */
export function riskWeightedQueuePriority(input: {
  config: BotConfig;
  repo: string;
  report?: ChangedSurfaceValidationReport;
}): { priority: number | undefined; tier: RiskQueueTier; reason: string } {
  const base = automaticQueuePriority(input.config, input.repo);
  const risk = input.config.riskWeightedQueue;
  if (!risk?.enabled || !input.report) {
    return { priority: base, tier: "default", reason: "risk_weighting_disabled" };
  }
  const backgroundPriority = input.config.reviewScheduler?.backgroundPriority ?? 50;
  const requiresValidation = input.report.recommendations.some((recommendation) => recommendation.status === "required");
  if (requiresValidation) {
    const elevated = risk.elevatedPriority ?? Math.min(backgroundPriority, 10);
    // Never de-prioritize a self-repo below its existing elevation.
    const priority = base === undefined ? elevated : Math.min(base, elevated);
    return { priority, tier: "elevated", reason: "risk_elevated_required_validation" };
  }
  if (input.report.docsOnly) {
    const docsOnly = risk.docsOnlyPriority ?? backgroundPriority;
    const priority = base === undefined ? docsOnly : Math.max(base, docsOnly);
    return { priority, tier: "docs_only", reason: "risk_docs_only" };
  }
  return { priority: base, tier: "default", reason: "risk_no_required_surface" };
}

const SELF_REPOS = new Set([
  "electricsheephq/evaos-code-review-bot",
  "electricsheephq/evaos-code-review-bot-neondiff"
]);
const LICENSE_GATE_RETRY_DELAY_MS = 15 * 60_000;

function isSelfRepo(repo: string): boolean {
  return SELF_REPOS.has(repo.toLowerCase());
}

function reprioritizeExistingSelfRepoQueueJobs(input: {
  config: BotConfig;
  state: ReviewStateStore;
  now: Date;
}): number {
  let updated = 0;
  for (const job of input.state.listReviewQueueJobs({ states: ["queued", "provider_deferred", "blocked_on_proof"] })) {
    if (!isSelfRepo(job.repo)) continue;
    if (job.source !== "automatic" || job.lane !== "background") continue;
    const targetPriority = automaticQueuePriority(input.config, job.repo);
    if (targetPriority === undefined) continue;
    if (job.priority <= targetPriority) continue;
    input.state.updateReviewQueueJobPriority({
      jobId: job.jobId,
      priority: targetPriority,
      now: input.now
    });
    updated += 1;
  }
  return updated;
}

function resolveRepoReviewScheduler(config: BotConfig, repo: string): RepoReviewSchedulerConfig | undefined {
  const resolution = resolveRepoProfile(config, repo);
  if (!resolution.allowed) return undefined;
  return resolution.profile.reviewScheduler;
}

function buildRepoActiveLimitOverrides(
  config: BotConfig,
  jobs: Pick<ReviewQueueJobRecord, "repo">[]
): Record<string, number> | undefined {
  const overrides: Record<string, number> = {};
  for (const job of jobs) {
    const repo = job.repo.toLowerCase();
    if (!isValidRepoName(repo)) continue;
    const maxActiveHeads = resolveRepoReviewScheduler(config, job.repo)?.maxActiveHeads;
    if (maxActiveHeads !== undefined) overrides[repo] = maxActiveHeads;
  }
  return Object.keys(overrides).length > 0 ? overrides : undefined;
}

function isValidRepoName(repo: string): boolean {
  const [owner, name, extra] = repo.split("/");
  return (
    extra === undefined &&
    Boolean(owner) &&
    Boolean(name) &&
    owner !== "." &&
    owner !== ".." &&
    name !== "." &&
    name !== ".." &&
    /^[A-Za-z0-9_.-]+$/.test(owner) &&
    /^[A-Za-z0-9_.-]+$/.test(name)
  );
}

function isCapacityDeferredReadiness(
  state: ReviewStateStore,
  repo: string,
  pull: PullRequestSummary
): boolean {
  const readiness = state.getReviewReadiness(repo, pull.number, pull.head.sha);
  return readiness?.state === "provider_deferred" && readiness.reason === "repo_queue_capacity_full";
}

function recordReadinessForEnqueue(input: {
  state: ReviewStateStore;
  repo: string;
  pull: PullRequestSummary;
  source: ReviewQueueJobSource;
  commandAction?: ProcessedCommandAction;
  commandCommentId?: number;
  now: Date;
}): void {
  const isManual = input.source === "manual_command";
  const manualReviewCommand = isManual && input.commandAction ? isReviewCommandAction(input.commandAction) : false;
  const readinessState: ReviewReadinessState =
    isManual && input.commandAction === "re-review" ? "awaiting_re_review" :
    isManual && input.commandAction === "stop" ? "skipped" :
    isManual && input.commandAction && !manualReviewCommand ? "command_recorded" :
    "queued";
  const reason = isManual && input.commandAction
    ? `trusted_${input.commandAction.replaceAll("-", "_")}_command`
    : "automatic_enqueue";
  recordReadinessTransition({
    state: input.state,
    repo: input.repo,
    pull: input.pull,
    readinessState,
    reason,
    ...(input.commandAction ? { commandAction: input.commandAction } : {}),
    ...(input.commandCommentId ? { commandCommentId: input.commandCommentId } : {}),
    ...(isManual ? {} : { clearCommandMetadata: true }),
    now: input.now
  });
}

function markSupersededReadinessRowsForPull(
  state: ReviewStateStore,
  repo: string,
  pull: PullRequestSummary,
  now: Date
): void {
  const supersedableStates: ReviewReadinessState[] = [
    "queued",
    "reviewing",
    "needs_fix",
    "awaiting_re_review",
    "ready_for_human",
    "provider_deferred",
    "command_recorded"
  ];
  for (const readiness of state.listReviewReadiness({ repo, pullNumber: pull.number, states: supersedableStates })) {
    if (readiness.headSha === pull.head.sha) continue;
    state.recordReviewReadiness({
      repo,
      pullNumber: pull.number,
      headSha: readiness.headSha,
      state: "stale",
      reason: `superseded_by_head=${pull.head.sha}`,
      now
    });
  }
}

async function retireSupersededQueueJobsForPull(input: {
  config: BotConfig;
  github: SchedulerGitHubApi;
  state: ReviewStateStore;
  repo: string;
  pull: PullRequestSummary;
  dryRun: boolean;
  now: Date;
  onStatusCommentFailure?: () => void;
}): Promise<void> {
  const jobs = input.state.listReviewQueueJobsForPull({
    repo: input.repo,
    pullNumber: input.pull.number,
    states: ["queued", "provider_deferred", "blocked_on_proof"]
  }).filter((job) => job.headSha !== input.pull.head.sha);

  for (const job of jobs) {
    input.state.updateReviewQueueJobState({
      jobId: job.jobId,
      state: "stale_retired",
      lastError: `superseded_by_head=${input.pull.head.sha}`,
      now: input.now
    });
    recordReadinessTransition({
      state: input.state,
      repo: input.repo,
      pull: pullForQueueJob(job, input.pull),
      readinessState: "stale",
      reason: `superseded_by_head=${input.pull.head.sha}`,
      now: input.now
    });
    updateReviewerSessionJobFromQueueStatus({ state: input.state, job }, "skipped", "skipped");
    await syncReviewStatusComment({
      config: input.config,
      github: input.github,
      dryRun: input.dryRun,
      repo: input.repo,
      pull: pullForQueueJob(job, input.pull),
      state: "stale_head",
      details: "Superseded by a newer PR head.",
      onStatusCommentFailure: input.onStatusCommentFailure,
      now: input.now
    });
  }
}

async function retireQueuedJobsForClosedPull(input: {
  config: BotConfig;
  github: SchedulerGitHubApi;
  state: ReviewStateStore;
  repo: string;
  pull: PullRequestSummary;
  dryRun: boolean;
  now: Date;
  onStatusCommentFailure?: () => void;
}): Promise<void> {
  const jobs = input.state.listReviewQueueJobsForPull({
    repo: input.repo,
    pullNumber: input.pull.number,
    states: ["queued", "provider_deferred", "blocked_on_proof"]
  });

  for (const job of jobs) {
    input.state.updateReviewQueueJobState({
      jobId: job.jobId,
      state: "closed_retired",
      lastError: `closed_or_merged_before_review state=${input.pull.state ?? "unknown"}`,
      now: input.now
    });
    recordReadinessTransition({
      state: input.state,
      repo: input.repo,
      pull: pullForQueueJob(job, input.pull),
      readinessState: "closed",
      reason: `closed_or_merged_before_review state=${input.pull.state ?? "unknown"}`,
      now: input.now
    });
    updateReviewerSessionJobFromQueueStatus({ state: input.state, job }, "skipped", "skipped");
    await syncReviewStatusComment({
      config: input.config,
      github: input.github,
      dryRun: input.dryRun,
      repo: input.repo,
      pull: pullForQueueJob(job, input.pull),
      state: "closed_or_merged_before_review",
      details: `state=${input.pull.state ?? "unknown"}`,
      onStatusCommentFailure: input.onStatusCommentFailure,
      now: input.now
    });
  }
}

async function resolveSchedulerCommandDecision(input: {
  config: BotConfig;
  github: SchedulerGitHubApi;
  state: ReviewStateStore;
  repo: string;
  pull: PullRequestSummary;
  onCommandFetchError?: () => void;
}): Promise<CommandDecision> {
  if (!input.config.commands.enabled) return { action: "none", shouldReview: false };
  let comments: IssueCommentCommandSource[];
  try {
    comments = await input.github.listIssueComments(input.repo, input.pull.number);
  } catch {
    input.onCommandFetchError?.();
    return { action: "none", shouldReview: false };
  }
  const collected = collectTrustedReviewCommands(comments, input.config.commands);
  const repoProfile = resolveRepoProfile(input.config, input.repo);
  // Public review/re-review policy (#345): the stateful bot + per-head cooldown gate runs HERE, where
  // the store and head SHA are in scope (mirrors the #295 per-head-claim placement). Admitted public
  // commands then flow through the exact same pipeline as trusted ones — authorization only decides
  // whether a command may enqueue a review; nothing downstream changes.
  const admittedPublic = admitPublicCommands({
    config: input.config,
    state: input.state,
    repo: input.repo,
    pull: input.pull,
    publicEligible: collected.publicEligible,
    comments
  });
  const authorizedCommands = [...collected.commands, ...admittedPublic].sort((left, right) => left.commentId - right.commentId);
  return decideCommandAction({
    commands: authorizedCommands.filter((command) =>
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

export function admitPublicCommands(input: {
  config: BotConfig;
  state: ReviewStateStore;
  repo: string;
  pull: PullRequestSummary;
  publicEligible: ReviewCommand[];
  comments: IssueCommentCommandSource[];
  now?: Date;
}): ReviewCommand[] {
  const publicCommands = input.config.commands.publicCommands;
  if (!publicCommands?.enabled || input.publicEligible.length === 0) return [];
  const botLogin = input.config.github.botLogin ?? DEFAULT_BOT_LOGIN;
  const commentsById = new Map(input.comments.map((comment) => [comment.id, comment]));
  const admitted: ReviewCommand[] = [];
  for (const command of input.publicEligible) {
    // Bot-author rejection (loop protection): a bot's own review comment never triggers a review.
    const source = commentsById.get(command.commentId);
    if (isBotCommandComment(source?.user, botLogin)) continue;
    // Atomic per-{repo,pr,head,author,action} cooldown — denied invocations are a no-op.
    const allowed = input.state.tryRecordPublicCommandInvocation({
      repo: input.repo,
      pullNumber: input.pull.number,
      headSha: input.pull.head.sha,
      author: command.author,
      action: command.action,
      cooldownMs: publicCommands.cooldownMinutes * 60_000,
      ...(input.now ? { now: input.now } : {})
    });
    if (allowed) admitted.push(command);
  }
  return admitted;
}

function shouldAssignReviewerSession(commandDecision?: Exclude<CommandDecision, { action: "none"; shouldReview: false }>): boolean {
  return !commandDecision || commandDecision.shouldReview;
}

function assignReviewerSessionForQueueJob(input: {
  config: BotConfig;
  state: ReviewStateStore;
  repo: string;
  pull: PullRequestSummary;
  providerId: string;
  now: Date;
}, source: ReviewQueueJobSource, commandDecision?: Exclude<CommandDecision, { action: "none"; shouldReview: false }>) {
  if (!input.config.reviewerSessions?.enabled) return undefined;
  const assignment = input.state.assignReviewerSessionJob({
    repo: input.repo,
    pullNumber: input.pull.number,
    headSha: input.pull.head.sha,
    ttlMs: input.config.reviewerSessions.ttlMs,
    headCountLimit: input.config.reviewerSessions.headCountLimit,
    now: input.now,
    model: input.config.zcode.model,
    provider: input.providerId,
    assignmentReason: source === "manual_command" ? "manual_command_priority" : undefined,
    allowProcessed: commandDecision?.shouldReview === true
  });
  return assignment.assigned || assignment.session ? assignment : undefined;
}

async function runLeasedQueueJob(input: {
  config: BotConfig;
  github: SchedulerGitHubApi;
  state: ReviewStateStore;
  job: ReviewQueueJobRecord;
  dryRun: boolean;
  useZCode: boolean;
  reviewPullImpl: (input: ReviewPullInput) => Promise<ReviewPullResult>;
  budget: ReviewRunBudget;
  onStatusCommentFailure?: () => void;
  now?: Date;
  clock?: () => Date;
}): Promise<ReviewPullResult | "failed" | "closed_retired" | "stale_retired"> {
  const now = input.now ?? new Date();
  input.state.updateReviewQueueJobState({
    jobId: input.job.jobId,
    state: "running",
    now
  });
  if (shouldMarkJobReviewing(input.state, input.job)) {
    recordReadinessTransition({
      state: input.state,
      repo: input.job.repo,
      pull: pullForQueueJobWithoutLive(input.job),
      readinessState: "reviewing",
      reason: "queue_job_running",
      now
    });
  }

  let pull: PullRequestSummary;
  try {
    pull = await input.github.getPull(input.job.repo, input.job.pullNumber);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    input.state.updateReviewQueueJobState({
      jobId: input.job.jobId,
      state: "failed",
      lastError: errorMessage,
      now
    });
    recordReadinessTransition({
      state: input.state,
      repo: input.job.repo,
      pull: pullForQueueJobWithoutLive(input.job),
      readinessState: "failed",
      reason: `github_refetch_failed: ${errorMessage}`,
      now
    });
    updateReviewerSessionJobFromQueueStatus(input, "failed", "failed");
    await syncReviewStatusComment({
      config: input.config,
      github: input.github,
      dryRun: input.dryRun,
      repo: input.job.repo,
      pull: pullForQueueJobWithoutLive(input.job),
      state: "failed",
      details: "GitHub refetch failed; see bot evidence for operator-only details.",
      onStatusCommentFailure: input.onStatusCommentFailure,
      now
    });
    return "failed";
  }

  if (isClosedPull(pull)) {
    input.state.updateReviewQueueJobState({
      jobId: input.job.jobId,
      state: "closed_retired",
      lastError: `closed_or_merged_before_review state=${pull.state ?? "unknown"}`,
      now
    });
    recordReadinessTransition({
      state: input.state,
      repo: input.job.repo,
      pull: pullForQueueJob(input.job, pull),
      readinessState: "closed",
      reason: `closed_or_merged_before_review state=${pull.state ?? "unknown"}`,
      now
    });
    updateReviewerSessionJobFromQueueStatus(input, "skipped", "skipped");
    await syncReviewStatusComment({
      config: input.config,
      github: input.github,
      dryRun: input.dryRun,
      repo: input.job.repo,
      pull: pullForQueueJob(input.job, pull),
      state: "closed_or_merged_before_review",
      details: `state=${pull.state ?? "unknown"}`,
      onStatusCommentFailure: input.onStatusCommentFailure,
      now
    });
    return "closed_retired";
  }

  if (pull.head.sha !== input.job.headSha) {
    input.state.updateReviewQueueJobState({
      jobId: input.job.jobId,
      state: "stale_retired",
      lastError: `stale_head_before_review live=${pull.head.sha}`,
      now
    });
    recordReadinessTransition({
      state: input.state,
      repo: input.job.repo,
      pull: pullForQueueJob(input.job, pull),
      readinessState: "stale",
      reason: `stale_head_before_review live=${pull.head.sha}`,
      now
    });
    updateReviewerSessionJobFromQueueStatus(input, "skipped", "skipped");
    await syncReviewStatusComment({
      config: input.config,
      github: input.github,
      dryRun: input.dryRun,
      repo: input.job.repo,
      pull: pullForQueueJob(input.job, pull),
      state: "stale_head",
      details: `live=${pull.head.sha}`,
      onStatusCommentFailure: input.onStatusCommentFailure,
      now
    });
    return "stale_retired";
  }

  if (input.job.source !== "manual_command" && input.job.baseSha && pull.base.sha !== input.job.baseSha) {
    input.state.updateReviewQueueJobState({
      jobId: input.job.jobId,
      state: "stale_retired",
      lastError: `base_changed_before_review live=${pull.base.sha}`,
      now
    });
    recordReadinessTransition({
      state: input.state,
      repo: input.job.repo,
      pull: pullForQueueJob(input.job, pull),
      readinessState: "stale",
      reason: `base_changed_before_review live=${pull.base.sha}`,
      now
    });
    updateReviewerSessionJobFromQueueStatus(input, "skipped", "skipped");
    await syncReviewStatusComment({
      config: input.config,
      github: input.github,
      dryRun: input.dryRun,
      repo: input.job.repo,
      pull: pullForQueueJob(input.job, pull),
      state: "stale_head",
      details: `base_changed live=${pull.base.sha}`,
      onStatusCommentFailure: input.onStatusCommentFailure,
      now
    });
    return "stale_retired";
  }

  const sessionId = ensureReviewerSessionForLeasedJob(input, now);
  updateReviewerSessionJobFromQueueStatus({ ...input, job: { ...input.job, ...(sessionId ? { sessionId } : {}) } }, "running");
  if (input.job.source !== "manual_command" && shouldPostInProgressStatusForLeasedJob(input.job)) {
    await syncReviewStatusComment({
      config: input.config,
      github: input.github,
      dryRun: input.dryRun,
      repo: input.job.repo,
      pull,
      state: "in_progress",
      onStatusCommentFailure: input.onStatusCommentFailure,
      now
    });
  }

  try {
    const status = await input.reviewPullImpl({
      config: input.config,
      github: input.github as GitHubApi,
      state: input.state,
      repo: input.job.repo,
      pull,
      dryRun: input.dryRun,
      useZCode: input.useZCode,
      budget: input.budget,
      processedHeadPolicy: processedHeadPolicyForQueueJob(input.state, input.job, pull),
      allowActivationBaselineCommandLookup: input.job.source === "manual_command",
      ...(input.job.source === "manual_command" && input.job.commentId ? { commandCommentId: input.job.commentId } : {})
    });
    updateQueueJobAfterReviewStatus({ state: input.state, job: input.job, pull, status, dryRun: input.dryRun, now });
    syncReadinessForReviewResult({
      state: input.state,
      job: input.job,
      pull,
      status,
      now
    });
    await syncReviewStatusCommentForReviewResult({
      config: input.config,
      github: input.github,
      dryRun: input.dryRun,
      job: input.job,
      pull,
      status,
      state: input.state,
      onStatusCommentFailure: input.onStatusCommentFailure,
      now
    });
    updateReviewerSessionJobAfterReviewStatus({
      state: input.state,
      job: { ...input.job, ...(sessionId ? { sessionId } : {}) },
      status,
      dryRun: input.dryRun
    });
    return status;
  } catch (error) {
    const failureNow = input.clock?.() ?? now;
    if (recordProviderRateLimitCooldownIfNeeded({
      config: input.config,
      state: input.state,
      repo: input.job.repo,
      pull,
      error,
      now: failureNow
    })) {
      markQueueJobProviderDeferredFromProcessed({ state: input.state, job: input.job, pull, error, config: input.config, now: failureNow });
      recordReadinessTransition({
        state: input.state,
        repo: input.job.repo,
        pull,
        readinessState: "provider_deferred",
        reason: "provider_rate_limit_cooldown",
        now: failureNow
      });
      await syncReviewStatusComment({
        config: input.config,
        github: input.github,
        dryRun: input.dryRun,
        repo: input.job.repo,
        pull,
        state: "provider_deferred",
        details: "Provider cooldown recorded; see bot evidence for operator-only details.",
        onStatusCommentFailure: input.onStatusCommentFailure,
        now: failureNow
      });
      updateReviewerSessionJobFromQueueStatus({ ...input, job: { ...input.job, ...(sessionId ? { sessionId } : {}) } }, "assigned");
      return "skipped_provider_cooldown";
    }
    const errorMessage = recordFailedReview({
      config: input.config,
      state: input.state,
      repo: input.job.repo,
      pull,
      error
    });
    input.state.updateReviewQueueJobState({
      jobId: input.job.jobId,
      state: "failed",
      lastError: errorMessage
    });
    recordReadinessTransition({
      state: input.state,
      repo: input.job.repo,
      pull,
      readinessState: "failed",
      reason: `review_failed: ${errorMessage}`,
      now
    });
    await syncReviewStatusComment({
      config: input.config,
      github: input.github,
      dryRun: input.dryRun,
      repo: input.job.repo,
      pull,
      state: "failed",
      details: "Review failed; see bot evidence for operator-only details.",
      onStatusCommentFailure: input.onStatusCommentFailure,
      now
    });
    updateReviewerSessionJobFromQueueStatus({ ...input, job: { ...input.job, ...(sessionId ? { sessionId } : {}) } }, "failed", "failed");
    return "failed";
  }
}

async function syncReviewStatusComment(input: {
  config: BotConfig;
  github: SchedulerGitHubApi;
  dryRun: boolean;
  repo: string;
  pull: PullRequestSummary;
  state: ReviewStatusCommentState;
  reviewUrl?: string;
  details?: string;
  onStatusCommentFailure?: () => void;
  now?: Date;
}): Promise<void> {
  if (!isReviewStatusCommentGithub(input.github)) return;
  const result = await postReviewStatusComment({
    enabled: input.config.reviewStatusComment?.enabled ?? false,
    dryRun: input.dryRun,
    github: input.github,
    repo: input.repo,
    pullNumber: input.pull.number,
    headSha: input.pull.head.sha,
    state: input.state,
    pullTitle: input.pull.title,
    pullUrl: input.pull.html_url,
    ...(input.reviewUrl ? { reviewUrl: input.reviewUrl } : {}),
    ...(input.details ? { details: input.details } : {}),
    now: input.now,
    publicConfidencePolicy: input.config.confidenceCalibration?.publicDisplay
  });
  if (isStatusCommentFailure(result)) input.onStatusCommentFailure?.();
}

function isStatusCommentFailure(result: ReviewStatusCommentPostResult): boolean {
  return !result.posted && (
    result.reason === "missing_app_credentials" ||
    result.reason === "build_failed" ||
    result.reason === "upsert_failed"
  );
}

async function syncReviewStatusCommentForReviewResult(input: {
  config: BotConfig;
  github: SchedulerGitHubApi;
  dryRun: boolean;
  job: ReviewQueueJobRecord;
  pull: PullRequestSummary;
  status: ReviewPullResult;
  state: ReviewStateStore;
  onStatusCommentFailure?: () => void;
  now?: Date;
}): Promise<void> {
  const processed = input.state.getProcessedReview(input.job.repo, input.pull.number, input.pull.head.sha);
  const nextState = reviewResultStatusCommentState(input.status, processed);
  if (!nextState) return;
  await syncReviewStatusComment({
    config: input.config,
    github: input.github,
    dryRun: input.dryRun,
    repo: input.job.repo,
    pull: input.pull,
    state: nextState,
    ...(processed?.reviewUrl ? { reviewUrl: processed.reviewUrl } : {}),
    onStatusCommentFailure: input.onStatusCommentFailure,
    now: input.now
  });
}

function shouldPostInProgressStatusForLeasedJob(job: ReviewQueueJobRecord): boolean {
  return !isProofBlockedQueueJob(job);
}

function isProofBlockedQueueJob(job: ReviewQueueJobRecord): boolean {
  if (job.state === "blocked_on_proof") return true;
  return Boolean(job.lastError && /license_entitlement_required|review requires active entitlement|blocked_on_proof/i.test(job.lastError));
}

function reviewResultStatusCommentState(
  status: ReviewPullResult,
  processed?: { status: ProcessedStatus; error?: string }
): ReviewStatusCommentState | undefined {
  switch (status) {
    case "reviewed":
    case "reviewed_command":
      return "completed";
    case "skipped_processed":
      return reviewStatusCommentStateForProcessedStatus(processed);
    case "skipped_provider_cooldown":
      return "provider_deferred";
    case "skipped_stale_head":
      return "stale_head";
    case "skipped_capacity":
      return "provider_deferred";
    case "skipped_draft":
    case "skipped_canary":
    case "skipped_policy":
    case "skipped_license_gate":
      return "skipped";
    case "skipped_command_stop":
    case "skipped_command_explain":
    case "skipped_finishing_touch_draft":
      return undefined;
    default:
      return assertNever(status);
  }
}

function syncReadinessForReviewResult(input: {
  state: ReviewStateStore;
  job: ReviewQueueJobRecord;
  pull: PullRequestSummary;
  status: ReviewPullResult;
  now: Date;
}): void {
  const processed = input.state.getProcessedReview(input.job.repo, input.pull.number, input.pull.head.sha);
  const readinessState = readinessStateForReviewResult(input.status, processed);
  if (!readinessState) return;
  const existing = input.status === "skipped_license_gate"
    ? input.state.getReviewReadiness(input.job.repo, input.pull.number, input.pull.head.sha)
    : undefined;
  recordReadinessTransition({
    state: input.state,
    repo: input.job.repo,
    pull: input.pull,
    readinessState,
    reason: input.status === "skipped_license_gate" && existing?.state === "blocked_on_proof" && existing.reason
      ? existing.reason
      : readinessReasonForReviewResult(input.status, processed),
    ...(processed?.event ? { event: processed.event } : {}),
    ...(processed?.reviewUrl ? { reviewUrl: processed.reviewUrl } : {}),
    now: input.now
  });
}

function backfillReadinessFromProcessedHead(
  state: ReviewStateStore,
  repo: string,
  pull: PullRequestSummary,
  now: Date
): void {
  const processed = state.getProcessedReview(repo, pull.number, pull.head.sha);
  if (!processed) return;
  const existing = state.getReviewReadiness(repo, pull.number, pull.head.sha);
  const targetState = readinessStateForProcessedStatus(processed.status, processed.event, processed.error);
  if (
    existing?.state === targetState &&
    (!processed.event || existing.event === processed.event) &&
    (!processed.reviewUrl || existing.reviewUrl === processed.reviewUrl)
  ) {
    return;
  }
  recordReadinessTransition({
    state,
    repo,
    pull,
    readinessState: targetState,
    reason: readinessReasonForProcessedHead(processed),
    ...(processed.event ? { event: processed.event } : {}),
    ...(processed.reviewUrl ? { reviewUrl: processed.reviewUrl } : {}),
    now
  });
}

function backfillReadinessFromActiveQueueJob(
  state: ReviewStateStore,
  repo: string,
  pull: PullRequestSummary,
  job: ReviewQueueJobRecord,
  now: Date
): void {
  const readinessState = readinessStateForActiveQueueJob(job);
  recordReadinessTransition({
    state,
    repo,
    pull,
    readinessState,
    reason: readinessReasonForActiveQueueJob(job),
    ...(job.source === "manual_command" && job.commentId ? { commandCommentId: job.commentId } : {}),
    ...(job.source === "manual_command" ? {} : { clearCommandMetadata: true }),
    now
  });
}

function shouldMarkJobReviewing(state: ReviewStateStore, job: ReviewQueueJobRecord): boolean {
  if (job.source !== "manual_command") return true;
  const existing = state.getReviewReadiness(job.repo, job.pullNumber, job.headSha);
  return existing?.commandAction ? isReviewCommandAction(existing.commandAction) : true;
}

function deferQueuedProviderJobsForProviderThrottle(input: {
  config: BotConfig;
  state: ReviewStateStore;
  triggerJob: ReviewQueueJobRecord;
  now: Date;
}): number {
  const cooldown = providerThrottleCooldownFromTriggerJob(input);
  const providerId = input.triggerJob.providerId ?? "default";
  const backgroundPriority = input.config.reviewScheduler?.backgroundPriority ?? 50;
  let deferred = 0;
  for (const job of input.state.listReviewQueueJobs({ state: "queued" })) {
    if ((job.providerId ?? "default") !== providerId) continue;
    if (job.source === "manual_command" || job.lane === "manual" || job.priority < backgroundPriority) continue;
    input.state.updateReviewQueueJobState({
      jobId: job.jobId,
      state: "provider_deferred",
      nextEligibleAt: cooldown.cooldownUntil,
      lastError: `provider_throttle_cycle_deferred_until=${cooldown.cooldownUntil}; reason=${cooldown.reason}; trigger_repo=${input.triggerJob.repo}`,
      now: input.now
    });
    deferred += 1;
  }
  return deferred;
}

function providerThrottleCooldownFromTriggerJob(input: {
  config: BotConfig;
  state: ReviewStateStore;
  triggerJob: ReviewQueueJobRecord;
  now: Date;
}): { cooldownUntil: string; reason: string } {
  const processed = input.state.getProcessedReview(input.triggerJob.repo, input.triggerJob.pullNumber, input.triggerJob.headSha);
  const parsed = parseProviderCooldownError(processed?.error);
  const repoCooldown = input.state.getActiveRepoProviderCooldown(input.triggerJob.repo, input.now);
  const fallbackCooldownUntil = new Date(input.now.getTime() + input.config.providerCooldown.durationMs).toISOString();
  return {
    cooldownUntil: parsed?.cooldownUntil ?? repoCooldown?.cooldownUntil ?? fallbackCooldownUntil,
    reason: parsed?.reason ?? repoCooldown?.reason ?? "provider_cooldown"
  };
}

function readinessStateForReviewResult(
  status: ReviewPullResult,
  processed?: { status: ProcessedStatus; event?: ReviewEvent; error?: string }
): ReviewReadinessState | undefined {
  switch (status) {
    case "reviewed":
    case "reviewed_command":
      return processed?.event === "REQUEST_CHANGES" ? "needs_fix" : "ready_for_human";
    case "skipped_processed":
      return readinessStateForProcessedStatus(processed?.status, processed?.event, processed?.error);
    case "skipped_provider_cooldown":
    case "skipped_capacity":
      return "provider_deferred";
    case "skipped_stale_head":
      return "stale";
    case "skipped_draft":
    case "skipped_canary":
    case "skipped_command_stop":
      return "skipped";
    case "skipped_policy":
      return "failed";
    case "skipped_license_gate":
      return "blocked_on_proof";
    case "skipped_command_explain":
    case "skipped_finishing_touch_draft":
      return undefined;
    default:
      return assertNever(status);
  }
}

function readinessReasonForReviewResult(
  status: ReviewPullResult,
  processed?: { status: ProcessedStatus; event?: ReviewEvent; error?: string }
): string {
  switch (status) {
    case "reviewed":
    case "reviewed_command":
      return processed?.event === "REQUEST_CHANGES" ? "request_changes_review_posted" : "comment_review_posted";
    case "skipped_processed":
      return processed ? readinessReasonForProcessedHead(processed) : "processed_head_already_unknown";
    case "skipped_provider_cooldown":
      return "provider_cooldown";
    case "skipped_capacity":
      return "review_capacity_busy";
    case "skipped_stale_head":
      return "stale_head";
    case "skipped_draft":
      return "draft_pr";
    case "skipped_canary":
      return "canary_policy";
    case "skipped_policy":
      return "unexpected_scheduler_review_status=skipped_policy";
    case "skipped_license_gate":
      return processed?.error ?? "license_entitlement_required";
    case "skipped_command_stop":
      return "manual_command_stop";
    case "skipped_command_explain":
      return "manual_command_explain";
    case "skipped_finishing_touch_draft":
      return "manual_command_finishing_touch_draft";
    default:
      return assertNever(status);
  }
}

function readinessStateForProcessedStatus(
  status?: ProcessedStatus,
  event?: ReviewEvent,
  error?: string
): ReviewReadinessState {
  if (parseProviderCooldownError(error)) return "provider_deferred";
  switch (status) {
    case "posted":
    case "dry_run":
      return event === "REQUEST_CHANGES" ? "needs_fix" : "ready_for_human";
    case "failed":
      return "failed";
    case "skipped":
      return "skipped";
    case undefined:
      return "queued";
    default:
      return assertNever(status);
  }
}

function readinessReasonForProcessedHead(processed: { status: ProcessedStatus; error?: string }): string {
  const providerCooldown = parseProviderCooldownError(processed.error);
  if (providerCooldown) return `processed_head_provider_deferred: ${providerCooldown.reason ?? "provider_cooldown"}`;
  if (processed.status === "skipped" && processed.error === ACTIVATION_BASELINE_EXISTING_HEAD_ERROR) {
    return ACTIVATION_BASELINE_EXISTING_HEAD_ERROR;
  }
  return `processed_head_already_${processed.status}`;
}

function readinessStateForActiveQueueJob(job: ReviewQueueJobRecord): ReviewReadinessState {
  if (job.state === "provider_deferred") return "provider_deferred";
  if (job.state === "leased" || job.state === "running") return "reviewing";
  return "queued";
}

function readinessReasonForActiveQueueJob(job: ReviewQueueJobRecord): string {
  return job.lastError ? `active_queue_job_${job.state}: ${job.lastError}` : `active_queue_job_${job.state}`;
}

function recordReadinessTransition(input: {
  state: ReviewStateStore;
  repo: string;
  pull: PullRequestSummary;
  readinessState: ReviewReadinessState;
  reason: string;
  event?: ReviewEvent;
  reviewUrl?: string;
  commandAction?: ProcessedCommandAction;
  commandCommentId?: number;
  clearCommandMetadata?: boolean;
  now: Date;
}): void {
  input.state.recordReviewReadiness({
    repo: input.repo,
    pullNumber: input.pull.number,
    headSha: input.pull.head.sha,
    state: input.readinessState,
    reason: input.reason,
    ...(input.event ? { event: input.event } : {}),
    ...(input.reviewUrl ? { reviewUrl: input.reviewUrl } : {}),
    ...(input.commandAction ? { commandAction: input.commandAction } : {}),
    ...(input.commandCommentId ? { commandCommentId: input.commandCommentId } : {}),
    ...(input.clearCommandMetadata ? { clearCommandMetadata: true } : {}),
    now: input.now
  });
}

function pullForQueueJob(job: ReviewQueueJobRecord, livePull: PullRequestSummary): PullRequestSummary {
  return {
    ...livePull,
    head: {
      ...livePull.head,
      sha: job.headSha
    },
    ...(job.baseSha
      ? {
          base: {
            ...livePull.base,
            sha: job.baseSha
          }
        }
      : {})
  };
}

function pullForQueueJobWithoutLive(job: ReviewQueueJobRecord): PullRequestSummary {
  return {
    number: job.pullNumber,
    title: "",
    draft: false,
    state: "open",
    head: {
      sha: job.headSha,
      ref: job.headSha,
      repo: {
        full_name: job.repo
      }
    },
    base: {
      sha: job.baseSha ?? "",
      ref: "",
      repo: {
        full_name: job.repo
      }
    },
    html_url: `https://github.com/${job.repo}/pull/${job.pullNumber}`
  };
}

function isReviewStatusCommentGithub(github: SchedulerGitHubApi): github is SchedulerGitHubApi & ReviewStatusCommentGithub {
  return typeof github.canPostAsApp === "function" && typeof github.upsertIssueComment === "function";
}

function ensureReviewerSessionForLeasedJob(input: {
  config: BotConfig;
  state: ReviewStateStore;
  job: ReviewQueueJobRecord;
  now?: Date;
}, now: Date): string | undefined {
  if (!input.config.reviewerSessions?.enabled) return input.job.sessionId;
  if (input.job.sessionId) return input.job.sessionId;
  if (input.job.source === "manual_command") return undefined;

  const providerId = input.job.providerId ?? input.config.zcode.providerId ?? input.config.zcode.model ?? "zcode";
  const assignment = input.state.assignReviewerSessionJob({
    repo: input.job.repo,
    pullNumber: input.job.pullNumber,
    headSha: input.job.headSha,
    ttlMs: input.config.reviewerSessions.ttlMs,
    headCountLimit: input.config.reviewerSessions.headCountLimit,
    now,
    model: input.config.zcode.model,
    provider: providerId
  });
  const sessionId = assignment.session?.sessionId;
  if (sessionId) {
    input.state.updateReviewQueueJobState({
      jobId: input.job.jobId,
      state: "running",
      sessionId,
      clearLease: false,
      now
    });
  }
  return sessionId;
}

function updateReviewerSessionJobAfterReviewStatus(input: {
  state: ReviewStateStore;
  job: ReviewQueueJobRecord;
  status: ReviewPullResult;
  dryRun: boolean;
}): void {
  switch (input.status) {
    case "reviewed":
    case "reviewed_command":
      updateReviewerSessionJobFromQueueStatus(input, "completed", input.dryRun ? "dry_run" : "posted");
      return;
    case "skipped_processed": {
      const processed = input.state.getProcessedReview(input.job.repo, input.job.pullNumber, input.job.headSha);
      if (parseProviderCooldownError(processed?.error)) {
        updateReviewerSessionJobFromQueueStatus(input, "assigned", processed?.status);
        return;
      }
      const sessionState = reviewerSessionJobStateForProcessedStatus(processed?.status);
      updateReviewerSessionJobFromQueueStatus(input, sessionState, processed?.status);
      return;
    }
    case "skipped_provider_cooldown":
    case "skipped_capacity":
      updateReviewerSessionJobFromQueueStatus(input, "assigned");
      return;
    case "skipped_draft":
    case "skipped_canary":
    case "skipped_policy":
    case "skipped_license_gate":
    case "skipped_command_stop":
    case "skipped_command_explain":
    case "skipped_finishing_touch_draft":
    case "skipped_stale_head":
      updateReviewerSessionJobFromQueueStatus(input, "skipped", "skipped");
      return;
    default:
      assertNever(input.status);
  }
}

function updateReviewerSessionJobFromQueueStatus(input: {
  state: ReviewStateStore;
  job: ReviewQueueJobRecord;
}, jobState: ReviewerSessionJobState, processedReviewStatus?: ProcessedStatus): void {
  if (!input.job.sessionId) return;
  input.state.updateReviewerSessionJobState({
    repo: input.job.repo,
    pullNumber: input.job.pullNumber,
    headSha: input.job.headSha,
    jobState,
    ...(processedReviewStatus ? { processedReviewStatus } : {})
  });
}

function updateQueueJobAfterReviewStatus(input: {
  state: ReviewStateStore;
  job: ReviewQueueJobRecord;
  pull: PullRequestSummary;
  status: ReviewPullResult;
  dryRun: boolean;
  now: Date;
}): void {
  switch (input.status) {
    case "reviewed":
    case "reviewed_command": {
      const processed = input.state.getProcessedReview(input.job.repo, input.pull.number, input.pull.head.sha);
      input.state.updateReviewQueueJobState({
        jobId: input.job.jobId,
        state: input.dryRun ? "queued" : "posted",
        ...(processed?.reviewUrl ? { reviewUrl: processed.reviewUrl } : {}),
        lastError: input.dryRun ? "dry_run_completed_not_posted" : input.status
      });
      return;
    }
    case "skipped_provider_cooldown":
      markQueueJobProviderDeferredFromProcessed(input);
      return;
    case "skipped_stale_head":
      input.state.updateReviewQueueJobState({
        jobId: input.job.jobId,
        state: "stale_retired",
        lastError: "review_pull_returned_stale_head"
      });
      return;
    case "skipped_processed":
      const processed = input.state.getProcessedReview(input.job.repo, input.pull.number, input.pull.head.sha);
      if (parseProviderCooldownError(processed?.error)) {
        markQueueJobProviderDeferredFromProcessed(input);
        return;
      }
      input.state.updateReviewQueueJobState({
        jobId: input.job.jobId,
        state: reviewQueueJobStateForProcessedStatus(processed?.status, input.dryRun),
        ...(processed?.reviewUrl ? { reviewUrl: processed.reviewUrl } : {}),
        lastError: `processed_head_already_${processed?.status ?? "unknown"}`
      });
      return;
    case "skipped_capacity":
      input.state.updateReviewQueueJobState({
        jobId: input.job.jobId,
        state: "queued",
        lastError: "legacy_review_capacity_busy"
      });
      return;
    case "skipped_canary":
    case "skipped_policy":
    case "skipped_license_gate":
      input.state.updateReviewQueueJobState({
        jobId: input.job.jobId,
        state: input.status === "skipped_license_gate" ? "blocked_on_proof" : "failed",
        ...(input.status === "skipped_license_gate" ? { nextEligibleAt: nextLicenseGateRetryAt(input.now) } : {}),
        lastError: input.status === "skipped_license_gate"
          ? input.state.getReviewReadiness(input.job.repo, input.pull.number, input.pull.head.sha)?.reason ?? "license_entitlement_required"
          : `unexpected_scheduler_review_status=${input.status}`
      });
      return;
    case "skipped_draft":
      input.state.updateReviewQueueJobState({
        jobId: input.job.jobId,
        state: "stale_retired",
        lastError: "draft_pr"
      });
      return;
    case "skipped_command_stop":
      input.state.updateReviewQueueJobState({
        jobId: input.job.jobId,
        state: "command_recorded",
        lastError: "manual_command_stop_recorded"
      });
      return;
    case "skipped_command_explain":
      input.state.updateReviewQueueJobState({
        jobId: input.job.jobId,
        state: "command_recorded",
        lastError: "manual_command_explain_recorded"
      });
      return;
    case "skipped_finishing_touch_draft":
      input.state.updateReviewQueueJobState({
        jobId: input.job.jobId,
        state: "command_recorded",
        lastError: "manual_command_finishing_touch_draft_recorded"
      });
      return;
    default:
      assertNever(input.status);
  }
}

function reconcileProcessedSkippedFailedQueueJobs(
  state: ReviewStateStore,
  now: Date
): { providerDeferred: number; staleRetired: number } {
  const result = { providerDeferred: 0, staleRetired: 0 };
  for (const job of state.listReviewQueueJobs({ state: "failed" })) {
    if (job.lastError !== "processed_head_already_skipped") continue;
    const processed = state.getProcessedReview(job.repo, job.pullNumber, job.headSha);
    if (processed?.status !== "skipped") continue;
    const providerCooldown = parseProviderCooldownError(processed.error);
    if (providerCooldown) {
      state.updateReviewQueueJobState({
        jobId: job.jobId,
        state: "provider_deferred",
        nextEligibleAt: providerCooldown.cooldownUntil,
        lastError: processed.error,
        now
      });
      result.providerDeferred += 1;
      continue;
    }
    state.updateReviewQueueJobState({
      jobId: job.jobId,
      state: "stale_retired",
      lastError: "processed_head_already_skipped_reconciled",
      now
    });
    result.staleRetired += 1;
  }
  return result;
}

function reviewStatusCommentStateForProcessedStatus(
  processed?: { status: ProcessedStatus; error?: string }
): ReviewStatusCommentState {
  if (parseProviderCooldownError(processed?.error)) return "provider_deferred";
  const status = processed?.status;
  switch (status) {
    case "posted":
    case "dry_run":
      return "completed";
    case "failed":
      return "failed";
    case "skipped":
      return "skipped";
    case undefined:
      return "queued";
    default:
      return assertNever(status);
  }
}

function reviewQueueJobStateForProcessedStatus(status: ProcessedStatus | undefined, dryRun: boolean): ReviewQueueJobState {
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

function markQueueJobProviderDeferredFromProcessed(input: {
  state: ReviewStateStore;
  job: ReviewQueueJobRecord;
  pull: PullRequestSummary;
  error?: unknown;
  config?: BotConfig;
  now?: Date;
}): void {
  const processed = input.state.getProcessedReview(input.job.repo, input.pull.number, input.pull.head.sha);
  const directCooldown = input.error && input.config
    ? providerCooldownFromError(input.config, input.error, input.now ?? new Date())
    : undefined;
  const parsed = parseProviderCooldownError(processed?.error);
  const repoCooldown = input.state.getActiveRepoProviderCooldown(input.job.repo, input.now);
  const cooldownUntil = parsed?.cooldownUntil ?? repoCooldown?.cooldownUntil ?? directCooldown?.cooldownUntil;
  const reason = parsed?.reason ?? repoCooldown?.reason ?? directCooldown?.reason;
  input.state.updateReviewQueueJobState({
    jobId: input.job.jobId,
    state: "provider_deferred",
    ...(cooldownUntil ? { nextEligibleAt: cooldownUntil } : {}),
    lastError: processed?.error ??
      (cooldownUntil ? `repo_provider_cooldown_until=${cooldownUntil}; reason=${reason ?? "provider_cooldown"}` : "provider_deferred_without_cooldown")
  });
}

function providerCooldownFromError(config: BotConfig, error: unknown, now: Date): { cooldownUntil: string; reason: string } | undefined {
  const classification = classifyProviderError(error);
  if (!classification.cooldown) return undefined;
  return {
    cooldownUntil: new Date(now.getTime() + providerCooldownDurationMs(config, classification)).toISOString(),
    reason: classification.reason
  };
}

function hasActiveQueueJobForHead(
  state: ReviewStateStore,
  repo: string,
  pullNumber: number,
  headSha: string
): boolean {
  return Boolean(getActiveQueueJobForHead(state, repo, pullNumber, headSha));
}

function getActiveQueueJobForHead(
  state: ReviewStateStore,
  repo: string,
  pullNumber: number,
  headSha: string
): ReviewQueueJobRecord | undefined {
  return state.listReviewQueueJobs({
    repo,
    states: ["queued", "leased", "running", "provider_deferred", "blocked_on_proof"]
  }).find((job) => job.pullNumber === pullNumber && job.headSha === headSha);
}

function hasRepoQueueCapacity(state: ReviewStateStore, repo: string, maxQueuedPerRepo: number): boolean {
  const active = state.listReviewQueueJobs({
    repo,
    states: ["queued", "leased", "running", "provider_deferred", "blocked_on_proof"]
  }).filter((job) => job.state !== "blocked_on_proof");
  return active.length < maxQueuedPerRepo;
}

function isProviderDeferredRetryJob(job: ReviewQueueJobRecord): boolean {
  return Boolean(
    parseProviderCooldownError(job.lastError) ||
    job.lastError?.includes("repo_provider_cooldown_until=") ||
    job.lastError === "provider_deferred_without_cooldown"
  );
}

function processedHeadPolicyForQueueJob(
  state: ReviewStateStore,
  job: ReviewQueueJobRecord,
  pull: PullRequestSummary
): ReviewPullInput["processedHeadPolicy"] {
  if (isProviderDeferredRetryJob(job)) return "retry_failed_head";
  const processed = state.getProcessedReview(job.repo, pull.number, pull.head.sha);
  return processed?.status === "failed" || parseProviderCooldownError(processed?.error)
    ? "retry_failed_head"
    : "normal";
}

function nextLicenseGateRetryAt(now = new Date()): string {
  return new Date(now.getTime() + LICENSE_GATE_RETRY_DELAY_MS).toISOString();
}

function applyEnqueueStatus(result: ScheduledRunResult, status: EnqueueStatus): void {
  switch (status) {
    case "enqueued":
      result.queue.enqueued += 1;
      break;
    case "already_queued":
      result.queue.alreadyQueued += 1;
      break;
    case "provider_deferred":
      result.skippedProviderCooldown += 1;
      result.queue.providerDeferred += 1;
      break;
    case "closed_retired":
      result.queue.closedRetired += 1;
      break;
    case "skipped_draft":
      result.skippedDraft += 1;
      break;
    case "skipped_canary":
      result.skippedCanary += 1;
      break;
    case "skipped_processed":
      result.skippedProcessed += 1;
      break;
    case "skipped_capacity":
      result.skippedCapacity += 1;
      break;
    case "skipped_finishing_touch_draft":
      result.skippedFinishingTouchDraft += 1;
      break;
    case "skipped_stale_head":
      result.skippedStaleHead += 1;
      break;
    default:
      assertNever(status);
  }
}

function applyReviewStatus(result: ScheduledRunResult, status: ReviewPullResult | "failed" | "closed_retired" | "stale_retired"): void {
  switch (status) {
    case "reviewed":
    case "reviewed_command":
      result.reviewed += 1;
      result.queue.completed += 1;
      if (status === "reviewed_command") result.commandReviewRequested += 1;
      break;
    case "skipped_draft":
      result.skippedDraft += 1;
      break;
    case "skipped_canary":
      result.skippedCanary += 1;
      break;
    case "skipped_policy":
    case "skipped_license_gate":
      result.skippedPolicy += 1;
      if (status === "skipped_license_gate") result.skippedLicenseGate += 1;
      break;
    case "skipped_command_stop":
      result.skippedCommandStop += 1;
      break;
    case "skipped_command_explain":
      result.skippedCommandExplain += 1;
      break;
    case "skipped_finishing_touch_draft":
      result.skippedFinishingTouchDraft += 1;
      break;
    case "skipped_processed":
      result.skippedProcessed += 1;
      result.queue.completed += 1;
      break;
    case "skipped_capacity":
      result.skippedCapacity += 1;
      break;
    case "skipped_provider_cooldown":
      result.skippedProviderCooldown += 1;
      result.queue.providerDeferred += 1;
      break;
    case "skipped_stale_head":
    case "stale_retired":
      result.skippedStaleHead += 1;
      result.queue.staleRetired += 1;
      break;
    case "closed_retired":
      result.queue.closedRetired += 1;
      break;
    case "failed":
      result.failed += 1;
      result.queue.failedQueueJobs += 1;
      break;
    default:
      assertNever(status);
  }
}

function emptyScheduledRunResult(): ScheduledRunResult {
  return {
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
    skippedProviderCooldown: 0,
    skippedStaleHead: 0,
    baselinedExisting: 0,
    commandFetchErrors: 0,
    statusCommentFailures: 0,
    policySkips: [],
    queue: {
      enqueued: 0,
      alreadyQueued: 0,
      leased: 0,
      completed: 0,
      providerDeferred: 0,
      staleRetired: 0,
      closedRetired: 0,
      failedQueueJobs: 0,
      remainingQueued: 0,
      delayedByReason: {}
    }
  };
}

function isClosedPull(pull: PullRequestSummary): boolean {
  return Boolean(pull.state && pull.state !== "open");
}

function assertNever(value: never): never {
  throw new Error(`Unexpected scheduler status: ${String(value)}`);
}
