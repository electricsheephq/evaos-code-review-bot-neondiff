import { loadConfig, type BotConfig } from "./config.js";
import { collectTrustedReviewCommands, decideCommandAction, type CommandDecision } from "./commands.js";
import { GitHubApi } from "./github.js";
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
import type { PullRequestSummary, ReviewEvent } from "./types.js";
import type { IssueCommentCommandSource } from "./commands.js";
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
}): Promise<ScheduledRunResult> {
  const config = input.config;
  const scheduler = config.reviewScheduler;
  if (!scheduler?.enabled) {
    throw new Error("runScheduledCycleWithDeps requires config.reviewScheduler.enabled=true");
  }
  const result = emptyScheduledRunResult();
  const now = input.now ?? new Date();
  const repos = input.options.repo ? [input.options.repo] : listReposToScan(config);
  const providerId = config.zcode.providerId ?? config.zcode.model ?? "zcode";

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

  result.queue.budget = buildReviewBudgetStatus({
    config,
    jobs: input.state.listReviewQueueJobs(),
    now,
    includeDetails: false
  });
  result.queue.delayedByReason = result.queue.budget.delayedByReason;

  const leased = input.state.leaseNextReviewQueueJobs({
    maxProviderActive: scheduler.maxProviderActive,
    maxOrgActive: scheduler.maxOrgActive,
    maxRepoActive: scheduler.maxRepoActive,
    manualCommandReserve: scheduler.manualCommandReserve,
    // Provider capacity is the global API throttle; org/repo caps only decide which jobs can spend that budget.
    limit: scheduler.maxProviderActive,
    leaseTtlMs: config.reviewConcurrency.leaseTtlMs,
    now
  });
  result.queue.leased = leased.length;

  const budget = new ReviewRunBudget(Math.max(1, scheduler.maxProviderActive));
  for (const job of leased) {
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
      now
    });
    applyReviewStatus(result, status);
  }

  result.queue.remainingQueued = input.state.listReviewQueueJobs({ states: ["queued", "provider_deferred"] }).length;
  return result;
}

type EnqueueStatus =
  | "enqueued"
  | "already_queued"
  | "skipped_draft"
  | "skipped_canary"
  | "skipped_processed"
  | "skipped_capacity"
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
  onStatusCommentFailure?: () => void;
  onCommandFetchError?: () => void;
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
  if (input.state.hasProcessed(input.repo, input.pull.number, input.pull.head.sha)) {
    backfillReadinessFromProcessedHead(input.state, input.repo, input.pull, input.now);
    return "skipped_processed";
  }
  const activeQueueJob = getActiveQueueJobForHead(input.state, input.repo, input.pull.number, input.pull.head.sha);
  if (activeQueueJob) {
    backfillReadinessFromActiveQueueJob(input.state, input.repo, input.pull, activeQueueJob, input.now);
    return "already_queued";
  }
  if (!hasRepoQueueCapacity(input.state, input.repo, input.config.reviewScheduler?.maxQueuedPerRepo ?? 10)) {
    recordReadinessTransition({
      state: input.state,
      repo: input.repo,
      pull: input.pull,
      readinessState: "provider_deferred",
      reason: "repo_queue_capacity_full",
      now: input.now
    });
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

function enqueueReviewJob(input: {
  config: BotConfig;
  state: ReviewStateStore;
  repo: string;
  pull: PullRequestSummary;
  providerId: string;
  now: Date;
}, commandDecision?: Exclude<CommandDecision, { action: "none"; shouldReview: false }>) {
  const source: ReviewQueueJobSource = commandDecision ? "manual_command" : "automatic";
  const sessionId = shouldAssignReviewerSession(commandDecision)
    ? assignReviewerSessionForQueueJob(input, source, commandDecision)?.session?.sessionId
    : undefined;
  return input.state.enqueueReviewQueueJob({
    repo: input.repo,
    pullNumber: input.pull.number,
    headSha: input.pull.head.sha,
    baseSha: input.pull.base.sha,
    source,
    lane: source === "manual_command" ? "manual" : "background",
    providerId: input.providerId,
    priority: source === "manual_command" ? undefined : input.config.reviewScheduler?.backgroundPriority,
    ...(commandDecision ? { commentId: commandDecision.commandId } : {}),
    ...(sessionId ? { sessionId } : {}),
    now: input.now
  });
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
  const readinessState: ReviewReadinessState =
    isManual && input.commandAction === "re-review" ? "awaiting_re_review" :
    isManual && input.commandAction === "stop" ? "skipped" :
    isManual && input.commandAction === "explain" ? "command_recorded" :
    "queued";
  const reason = isManual && input.commandAction
    ? `trusted_${input.commandAction.replace("-", "_")}_command`
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
    states: ["queued", "provider_deferred"]
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
    states: ["queued", "provider_deferred"]
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
  return decideCommandAction({
    commands: collected.commands,
    repo: input.repo,
    pullNumber: input.pull.number,
    headSha: input.pull.head.sha,
    hasProcessedCommand: (repo, pullNumber, headSha, commentId) =>
      input.state.hasProcessedCommand(repo, pullNumber, headSha, commentId)
  });
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
  if (input.job.source !== "manual_command") {
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
      processedHeadPolicy: isProviderDeferredRetryJob(input.job) ? "retry_failed_head" : "normal",
      ...(input.job.source === "manual_command" && input.job.commentId ? { commandCommentId: input.job.commentId } : {})
    });
    updateQueueJobAfterReviewStatus({ state: input.state, job: input.job, pull, status, dryRun: input.dryRun });
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
    if (recordProviderRateLimitCooldownIfNeeded({
      config: input.config,
      state: input.state,
      repo: input.job.repo,
      pull,
      error,
      now
    })) {
      markQueueJobProviderDeferredFromProcessed({ state: input.state, job: input.job, pull, error, config: input.config, now });
      recordReadinessTransition({
        state: input.state,
        repo: input.job.repo,
        pull,
        readinessState: "provider_deferred",
        reason: "provider_rate_limit_cooldown",
        now
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
        now
      });
      updateReviewerSessionJobFromQueueStatus({ ...input, job: { ...input.job, ...(sessionId ? { sessionId } : {}) } }, "assigned");
      return "skipped_provider_cooldown";
    }
    recordFailedReview({
      config: input.config,
      state: input.state,
      repo: input.job.repo,
      pull,
      error
    });
    const errorMessage = error instanceof Error ? error.message : String(error);
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
    now: input.now
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
      return "skipped";
    case "skipped_command_stop":
    case "skipped_command_explain":
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
  recordReadinessTransition({
    state: input.state,
    repo: input.job.repo,
    pull: input.pull,
    readinessState,
    reason: readinessReasonForReviewResult(input.status, processed),
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
  // Only stop/explain commands suppress reviewing because they do not perform review work.
  return existing?.commandAction !== "stop" && existing?.commandAction !== "explain";
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
    case "skipped_command_explain":
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
    case "skipped_command_stop":
      return "manual_command_stop";
    case "skipped_command_explain":
      return "manual_command_explain";
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
      return "ready_for_human";
    default:
      return assertNever(status);
  }
}

function readinessReasonForProcessedHead(processed: { status: ProcessedStatus; error?: string }): string {
  const providerCooldown = parseProviderCooldownError(processed.error);
  if (providerCooldown) return `processed_head_provider_deferred: ${providerCooldown.reason ?? "provider_cooldown"}`;
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
      updateReviewerSessionJobFromQueueStatus(input, sessionState, processed?.status ?? (input.dryRun ? "dry_run" : "posted"));
      return;
    }
    case "skipped_provider_cooldown":
    case "skipped_capacity":
      updateReviewerSessionJobFromQueueStatus(input, "assigned");
      return;
    case "skipped_draft":
    case "skipped_canary":
    case "skipped_policy":
    case "skipped_command_stop":
    case "skipped_command_explain":
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
    case "skipped_draft":
    case "skipped_canary":
    case "skipped_policy":
      input.state.updateReviewQueueJobState({
        jobId: input.job.jobId,
        state: "failed",
        lastError: `unexpected_scheduler_review_status=${input.status}`
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
      return "completed";
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
      return dryRun ? "queued" : "posted";
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
      return "completed";
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
  const cooldownUntil = directCooldown?.cooldownUntil ?? parsed?.cooldownUntil ?? repoCooldown?.cooldownUntil;
  const reason = directCooldown?.reason ?? parsed?.reason ?? repoCooldown?.reason;
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
    states: ["queued", "leased", "running", "provider_deferred"]
  }).find((job) => job.pullNumber === pullNumber && job.headSha === headSha);
}

function hasRepoQueueCapacity(state: ReviewStateStore, repo: string, maxQueuedPerRepo: number): boolean {
  const active = state.listReviewQueueJobs({
    repo,
    states: ["queued", "leased", "running", "provider_deferred"]
  });
  return active.length < maxQueuedPerRepo;
}

function isProviderDeferredRetryJob(job: ReviewQueueJobRecord): boolean {
  return Boolean(
    job.nextEligibleAt ||
    parseProviderCooldownError(job.lastError) ||
    job.lastError?.includes("repo_provider_cooldown_until=") ||
    job.lastError === "provider_deferred_without_cooldown"
  );
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
      result.skippedPolicy += 1;
      break;
    case "skipped_command_stop":
      result.skippedCommandStop += 1;
      break;
    case "skipped_command_explain":
      result.skippedCommandExplain += 1;
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
    skippedCommandStop: 0,
    skippedCommandExplain: 0,
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
