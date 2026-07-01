import { loadConfig, type BotConfig } from "./config.js";
import { collectTrustedReviewCommands, decideCommandAction, type CommandDecision } from "./commands.js";
import { GitHubApi } from "./github.js";
import { listReposToScan, resolveRepoProfile } from "./repo-policy.js";
import { ReviewRunBudget } from "./review-budget.js";
import {
  parseProviderCooldownError,
  ReviewStateStore,
  type ProcessedStatus,
  type ReviewerSessionJobState,
  type ReviewQueueJobRecord,
  type ReviewQueueJobSource
} from "./state.js";
import type { PullRequestSummary } from "./types.js";
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
  };
}

export interface SchedulerGitHubApi {
  listOpenPulls(repo: string): Promise<PullRequestSummary[]>;
  getPull(repo: string, pullNumber: number): Promise<PullRequestSummary>;
  listIssueComments(repo: string, issueNumber: number): Promise<IssueCommentCommandSource[]>;
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
        now
      });
      applyEnqueueStatus(result, enqueueStatus);
    }
  }

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
}): Promise<EnqueueStatus> {
  if (isClosedPull(input.pull)) return "closed_retired";
  if (input.config.skipDrafts && input.pull.draft) return "skipped_draft";
  if (!isCanaryAllowed(input.config, input.repo, input.pull.number)) return "skipped_canary";

  const commandDecision = await resolveSchedulerCommandDecision(input);
  if (commandDecision.action !== "none") {
    const queued = enqueueReviewJob(input, commandDecision);
    return queued.enqueued ? "enqueued" : "already_queued";
  }

  if (input.state.hasProcessed(input.repo, input.pull.number, input.pull.head.sha)) return "skipped_processed";
  if (hasActiveQueueJobForHead(input.state, input.repo, input.pull.number, input.pull.head.sha)) return "already_queued";
  if (!hasRepoQueueCapacity(input.state, input.repo, input.config.reviewScheduler?.maxQueuedPerRepo ?? 10)) {
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
    return "provider_deferred";
  }

  const enqueued = enqueueReviewJob(input);
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
  const sessionId = assignReviewerSessionForQueueJob(input, source)?.session?.sessionId;
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

async function resolveSchedulerCommandDecision(input: {
  config: BotConfig;
  github: SchedulerGitHubApi;
  state: ReviewStateStore;
  repo: string;
  pull: PullRequestSummary;
}): Promise<CommandDecision> {
  if (!input.config.commands.enabled) return { action: "none", shouldReview: false };
  let comments: IssueCommentCommandSource[];
  try {
    comments = await input.github.listIssueComments(input.repo, input.pull.number);
  } catch {
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

function assignReviewerSessionForQueueJob(input: {
  config: BotConfig;
  state: ReviewStateStore;
  repo: string;
  pull: PullRequestSummary;
  providerId: string;
  now: Date;
}, source: ReviewQueueJobSource) {
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
    assignmentReason: source === "manual_command" ? "manual_command_priority" : undefined
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
  now?: Date;
}): Promise<ReviewPullResult | "failed" | "closed_retired" | "stale_retired"> {
  const now = input.now ?? new Date();
  input.state.updateReviewQueueJobState({
    jobId: input.job.jobId,
    state: "running",
    now
  });

  let pull: PullRequestSummary;
  try {
    pull = await input.github.getPull(input.job.repo, input.job.pullNumber);
  } catch (error) {
    input.state.updateReviewQueueJobState({
      jobId: input.job.jobId,
      state: "failed",
      lastError: error instanceof Error ? error.message : String(error)
    });
    updateReviewerSessionJobFromQueueStatus(input, "failed", "failed");
    return "failed";
  }

  if (isClosedPull(pull)) {
    input.state.updateReviewQueueJobState({
      jobId: input.job.jobId,
      state: "closed_retired",
      lastError: `closed_or_merged_before_review state=${pull.state ?? "unknown"}`
    });
    updateReviewerSessionJobFromQueueStatus(input, "skipped", "skipped");
    return "closed_retired";
  }

  if (pull.head.sha !== input.job.headSha || (input.job.baseSha && pull.base.sha !== input.job.baseSha)) {
    input.state.updateReviewQueueJobState({
      jobId: input.job.jobId,
      state: "stale_retired",
      lastError: `stale_head_before_review live=${pull.head.sha}`
    });
    updateReviewerSessionJobFromQueueStatus(input, "skipped", "skipped");
    return "stale_retired";
  }

  const sessionId = ensureReviewerSessionForLeasedJob(input, now);
  updateReviewerSessionJobFromQueueStatus({ ...input, job: { ...input.job, ...(sessionId ? { sessionId } : {}) } }, "running");

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
      processedHeadPolicy: isProviderDeferredRetryJob(input.job) ? "retry_failed_head" : "normal"
    });
    updateQueueJobAfterReviewStatus({ state: input.state, job: input.job, pull, status, dryRun: input.dryRun });
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
    input.state.updateReviewQueueJobState({
      jobId: input.job.jobId,
      state: "failed",
      lastError: error instanceof Error ? error.message : String(error)
    });
    updateReviewerSessionJobFromQueueStatus({ ...input, job: { ...input.job, ...(sessionId ? { sessionId } : {}) } }, "failed", "failed");
    return "failed";
  }
}

function ensureReviewerSessionForLeasedJob(input: {
  config: BotConfig;
  state: ReviewStateStore;
  job: ReviewQueueJobRecord;
  now?: Date;
}, now: Date): string | undefined {
  if (!input.config.reviewerSessions?.enabled) return input.job.sessionId;
  if (input.job.sessionId) return input.job.sessionId;

  const providerId = input.job.providerId ?? input.config.zcode.providerId ?? input.config.zcode.model ?? "zcode";
  const assignment = input.state.assignReviewerSessionJob({
    repo: input.job.repo,
    pullNumber: input.job.pullNumber,
    headSha: input.job.headSha,
    ttlMs: input.config.reviewerSessions.ttlMs,
    headCountLimit: input.config.reviewerSessions.headCountLimit,
    now,
    model: input.config.zcode.model,
    provider: providerId,
    assignmentReason: input.job.source === "manual_command" ? "manual_command_priority" : undefined
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
    case "skipped_processed":
      updateReviewerSessionJobFromQueueStatus(input, "completed", input.dryRun ? "dry_run" : "posted");
      return;
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
      input.state.updateReviewQueueJobState({
        jobId: input.job.jobId,
        state: "posted",
        lastError: "processed_head_already_exists"
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
        state: "posted",
        lastError: "manual_command_stop_recorded"
      });
      return;
    case "skipped_command_explain":
      input.state.updateReviewQueueJobState({
        jobId: input.job.jobId,
        state: "posted",
        lastError: "manual_command_explain_recorded"
      });
      return;
    default:
      assertNever(input.status);
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
  return state.listReviewQueueJobs({
    repo,
    states: ["queued", "leased", "running", "provider_deferred"]
  }).some((job) => job.pullNumber === pullNumber && job.headSha === headSha);
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
      remainingQueued: 0
    }
  };
}

function isClosedPull(pull: PullRequestSummary): boolean {
  return Boolean(pull.state && pull.state !== "open");
}

function assertNever(value: never): never {
  throw new Error(`Unexpected scheduler status: ${String(value)}`);
}
