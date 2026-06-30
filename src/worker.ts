import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildCommandStatusBody,
  buildCommandStatusMarker,
  collectTrustedReviewCommands,
  decideCommandAction,
  type CommandDecision
} from "./commands.js";
import { loadConfig, type BotConfig } from "./config.js";
import { validateFindingLocations } from "./diff.js";
import { decideReviewEvent, normalizeFindingsForReview } from "./findings.js";
import { assertGitClean, preparePullWorktree } from "./git.js";
import { GitHubApi } from "./github.js";
import {
  buildPullFileFilterImpact,
  filterPullFilesForProfile,
  listReposToScan,
  resolveRepoProfile
} from "./repo-policy.js";
import { ReviewRunBudget } from "./review-budget.js";
import { redactSecrets } from "./secrets.js";
import { ReviewStateStore, type ReviewRunLease } from "./state.js";
import { buildWalkthroughComment } from "./walkthrough.js";
import { postWalkthroughComment, reviewBodyAfterWalkthroughPost } from "./walkthrough-post.js";
import { buildReviewPrompt, runZCodeReview } from "./zcode.js";
import type { PullRequestSummary, ReviewPlan } from "./types.js";

export interface RunOnceOptions {
  configPath?: string;
  dryRun: boolean;
  repo?: string;
  pullNumber?: number;
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
  commandReviewRequested: number;
  skippedProcessed: number;
  skippedCapacity: number;
  skippedStaleHead: number;
  baselinedExisting: number;
  policySkips: { repo: string; reason: string }[];
}

export interface RetryFailedHeadResult {
  repo: string;
  pullNumber: number;
  headSha: string;
  status: ReviewPullResult | "failed" | "dry_run";
}

export interface FailedHeadRetryTarget {
  repo: string;
  pullNumber: number;
  headSha: string;
  previousError?: string;
}

export type ReviewPullResult =
  | "reviewed"
  | "reviewed_command"
  | "skipped_draft"
  | "skipped_canary"
  | "skipped_policy"
  | "skipped_command_stop"
  | "skipped_command_explain"
  | "skipped_processed"
  | "skipped_capacity"
  | "skipped_stale_head";

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
    commandReviewRequested: 0,
    skippedProcessed: 0,
    skippedCapacity: 0,
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
            budget
          });
        } catch (error) {
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
        if (status === "reviewed_command") result.commandReviewRequested += 1;
        if (status === "skipped_processed") result.skippedProcessed += 1;
        if (status === "skipped_capacity") result.skippedCapacity += 1;
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
  const retryTarget = prepareFailedHeadRetry({
    state,
    repo: options.repo,
    pullNumber: options.pullNumber,
    headSha: options.headSha,
    livePull: pull
  });
  try {
    const status = await input.reviewPullImpl({
      config,
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
    recordFailedReview({
      config,
      state,
      repo: options.repo,
      pull,
      error: retryFailureError(retryTarget.previousError, error)
    });
    return {
      repo: options.repo,
      pullNumber: options.pullNumber,
      headSha: options.headSha,
      status: "failed"
    };
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

  input.state.recordProcessed({
    repo: input.retryTarget.repo,
    pullNumber: input.retryTarget.pullNumber,
    headSha: input.retryTarget.headSha,
    status: "failed",
    error: input.retryTarget.previousError
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

  const processed = input.state.getProcessedReview(input.repo, input.pullNumber, input.headSha);
  if (!processed) {
    throw new Error(`No processed review row exists for ${input.repo}#${input.pullNumber}@${input.headSha}`);
  }
  if (processed.status !== "failed") {
    throw new Error(
      `Refusing retry for ${input.repo}#${input.pullNumber}@${input.headSha}: status is ${processed.status}, not failed`
    );
  }

  return {
    repo: input.repo,
    pullNumber: input.pullNumber,
    headSha: input.headSha,
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
}

export async function reviewPull(input: ReviewPullInput): Promise<ReviewPullResult> {
  const { config, github, state, repo, pull } = input;
  const repoPolicy = resolveRepoProfile(config, repo);
  if (!repoPolicy.allowed) return "skipped_policy";
  if (config.skipDrafts && pull.draft) return "skipped_draft";
  if (!isCanaryAllowed(config, repo, pull.number)) return "skipped_canary";

  const commandDecision = await resolvePullCommandDecision({ config, github, state, repo, pull });
  if (commandDecision.action === "stop") {
    await recordAndAcknowledgeCommandDecision({ config, github, state, repo, pull, commandDecision });
    return "skipped_command_stop";
  }
  if (commandDecision.action === "explain") {
    await recordAndAcknowledgeCommandDecision({ config, github, state, repo, pull, commandDecision });
    return "skipped_command_explain";
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
    state.hasProcessed(repo, pull.number, pull.head.sha)
  ) {
    return "skipped_processed";
  }
  const budget = input.budget ?? new ReviewRunBudget(config.reviewConcurrency.maxActiveRuns);
  if (!budget.tryStart()) return "skipped_capacity";
  let lease: ReviewRunLease | undefined;

  try {
    lease = state.tryAcquireReviewRunLease(config.reviewConcurrency.maxActiveRuns, config.reviewConcurrency.leaseTtlMs);
    if (!lease) return "skipped_capacity";
    if (commandReviewRequested) {
      await recordAndAcknowledgeCommandDecision({ config, github, state, repo, pull, commandDecision });
    }

    const evidenceDir = buildEvidenceDir(config, repo, pull, commandDecision);
    mkdirSync(evidenceDir, { recursive: true });

    const files = await github.listPullFiles(repo, pull.number);
    const reviewFiles = filterPullFilesForProfile(files, repoPolicy.profile);
    const filterImpact = buildPullFileFilterImpact(files, repoPolicy.profile);
    const worktree = preparePullWorktree({
      repo,
      pullNumber: pull.number,
      expectedHeadSha: pull.head.sha,
      workRoot: config.workRoot
    });

    const prompt = buildReviewPrompt({
      repo,
      pull,
      files: reviewFiles,
      repoProfile: repoPolicy.profile,
      maxPatchBytes: config.zcode.maxPatchBytes
    });
    writeFileSync(join(evidenceDir, "repo-profile.json"), `${JSON.stringify(repoPolicy.profile, null, 2)}\n`);
    writeFileSync(join(evidenceDir, "filter-impact.json"), `${JSON.stringify(filterImpact, null, 2)}\n`);
    if (commandDecision.action !== "none") {
      writeFileSync(join(evidenceDir, "command.json"), `${JSON.stringify(commandDecision.command, null, 2)}\n`);
    }
    writeFileSync(join(evidenceDir, "review-prompt.txt"), redactSecrets(prompt));

    const zcodeResult = input.useZCode
      ? runZCodeReview({
          cwd: worktree.path,
          prompt,
          cliPath: config.zcode.cliPath,
          appConfigPath: config.zcode.appConfigPath,
          model: config.zcode.model,
          providerId: config.zcode.providerId,
          evidenceDir,
          timeoutMs: config.zcode.timeoutMs,
          retryMaxRetries: config.zcode.retryMaxRetries
        })
      : { findings: [], droppedFromSchema: [], rawResponse: "{\"findings\":[]}" };

    assertGitClean(worktree.path);

    const liveBeforePlan = await github.getPull(repo, pull.number);
    const staleBeforePlan = detectStalePullHead({ expected: pull, live: liveBeforePlan, phase: "before_plan" });
    if (staleBeforePlan) {
      recordStaleHeadSkip({ state, repo, pull, stale: staleBeforePlan, evidenceDir });
      return "skipped_stale_head";
    }

    const located = validateFindingLocations(zcodeResult.findings, reviewFiles);
    const normalized = normalizeFindingsForReview(located.valid, { maxInlineComments: 25 });
    const comments = normalized.comments;
    const dropped = sanitizeDroppedFindings([...zcodeResult.droppedFromSchema, ...located.dropped, ...normalized.dropped]);
    const event = decideReviewEvent(comments);
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
          postIssueComment: config.walkthrough.postIssueComment
        })
      : undefined;
    const plan: ReviewPlan = {
      event,
      comments,
      dropped,
      summary,
      ...(walkthrough ? { walkthrough } : {})
    };

    if (walkthrough) writeFileSync(join(evidenceDir, "walkthrough.md"), walkthrough.body);
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
      error: "activation_baseline_existing_head"
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

export type StaleHeadPhase = "before_review" | "before_plan" | "before_post";

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
  return commandDecision.shouldReview ? join(evidenceBaseDir, `command-${commandDecision.commandId}`) : evidenceBaseDir;
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

function retryFailureError(previousError: string | undefined, error: unknown): string {
  const retryError = error instanceof Error ? error.message : String(error);
  return previousError ? `${previousError}; retry_error=${retryError}` : retryError;
}

async function resolvePullCommandDecision(input: {
  config: BotConfig;
  github: GitHubApi;
  state: ReviewStateStore;
  repo: string;
  pull: PullRequestSummary;
}): Promise<CommandDecision> {
  if (!input.config.commands.enabled) return { action: "none", shouldReview: false };

  const comments = await input.github.listIssueComments(input.repo, input.pull.number);
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

async function recordAndAcknowledgeCommandDecision(input: {
  config: BotConfig;
  github: GitHubApi;
  state: ReviewStateStore;
  repo: string;
  pull: PullRequestSummary;
  commandDecision: Exclude<CommandDecision, { action: "none"; shouldReview: false }>;
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

  if (input.config.commands.acknowledge && input.github.canPostAsApp()) {
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
