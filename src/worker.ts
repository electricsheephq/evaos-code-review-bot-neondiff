import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, type BotConfig } from "./config.js";
import { validateFindingLocations } from "./diff.js";
import { decideReviewEvent, normalizeFindingsForReview } from "./findings.js";
import { assertGitClean, preparePullWorktree } from "./git.js";
import { GitHubApi } from "./github.js";
import { filterPullFilesForProfile, listReposToScan, resolveRepoProfile } from "./repo-policy.js";
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
  skippedDraft: number;
  skippedCanary: number;
  skippedPolicy: number;
  skippedProcessed: number;
  skippedCapacity: number;
  baselinedExisting: number;
  policySkips: { repo: string; reason: string }[];
}

type ReviewPullResult =
  | "reviewed"
  | "skipped_draft"
  | "skipped_canary"
  | "skipped_policy"
  | "skipped_processed"
  | "skipped_capacity";

export async function runOnce(options: RunOnceOptions): Promise<RunOnceResult> {
  const config = loadConfig(options.configPath);
  const github = new GitHubApi(config.github);
  const state = new ReviewStateStore(config.statePath);
  const budget = new ReviewRunBudget(config.reviewConcurrency.maxActiveRuns);
  const result: RunOnceResult = {
    reposScanned: 0,
    pullsSeen: 0,
    reviewed: 0,
    skippedDraft: 0,
    skippedCanary: 0,
    skippedPolicy: 0,
    skippedProcessed: 0,
    skippedCapacity: 0,
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
        const status = await reviewPull({
          config,
          github,
          state,
          repo,
          pull,
          dryRun: options.dryRun,
          useZCode: options.useZCode ?? true,
          budget
        });
        if (status === "reviewed") result.reviewed += 1;
        if (status === "skipped_draft") result.skippedDraft += 1;
        if (status === "skipped_canary") result.skippedCanary += 1;
        if (status === "skipped_policy") result.skippedPolicy += 1;
        if (status === "skipped_processed") result.skippedProcessed += 1;
        if (status === "skipped_capacity") result.skippedCapacity += 1;
      }
    }
    return result;
  } finally {
    state.close();
  }
}

export async function reviewPull(input: {
  config: BotConfig;
  github: GitHubApi;
  state: ReviewStateStore;
  repo: string;
  pull: PullRequestSummary;
  dryRun: boolean;
  useZCode: boolean;
  budget?: ReviewRunBudget;
}): Promise<ReviewPullResult> {
  const { config, github, state, repo, pull } = input;
  const repoPolicy = resolveRepoProfile(config, repo);
  if (!repoPolicy.allowed) return "skipped_policy";
  if (config.skipDrafts && pull.draft) return "skipped_draft";
  if (!isCanaryAllowed(config, repo, pull.number)) return "skipped_canary";
  if (state.hasProcessed(repo, pull.number, pull.head.sha)) return "skipped_processed";
  const budget = input.budget ?? new ReviewRunBudget(config.reviewConcurrency.maxActiveRuns);
  if (!budget.tryStart()) return "skipped_capacity";
  let lease: ReviewRunLease | undefined;

  try {
    lease = state.tryAcquireReviewRunLease(config.reviewConcurrency.maxActiveRuns, config.reviewConcurrency.leaseTtlMs);
    if (!lease) return "skipped_capacity";

    const evidenceDir = join(config.evidenceDir, localDateFolder(), repo.replace("/", "__"), `pr-${pull.number}`, pull.head.sha);
    mkdirSync(evidenceDir, { recursive: true });

    const files = await github.listPullFiles(repo, pull.number);
    const reviewFiles = filterPullFilesForProfile(files, repoPolicy.profile);
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

    const located = validateFindingLocations(zcodeResult.findings, reviewFiles);
    const normalized = normalizeFindingsForReview(located.valid, { maxInlineComments: 25 });
    const comments = normalized.comments;
    const dropped = sanitizeDroppedFindings([...zcodeResult.droppedFromSchema, ...located.dropped, ...normalized.dropped]);
    const event = decideReviewEvent(comments);
    const summary = buildSummary({ repo, pull, comments, dropped, dryRun: input.dryRun });
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
      return "reviewed";
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
    return "reviewed";
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
}): string {
  const p0p1 = input.comments.filter((comment) => comment.severity === "P0" || comment.severity === "P1").length;
  return [
    `evaOS ZCode review ${input.dryRun ? "dry run" : "result"} for ${input.repo}#${input.pull.number} at ${input.pull.head.sha}.`,
    `Inline comments: ${input.comments.length}. High-severity comments: ${p0p1}. Dropped findings: ${input.dropped.length}.`,
    "Pilot policy: this bot never approves PRs; it requests changes only for validated P0/P1 findings."
  ].join("\n\n");
}
