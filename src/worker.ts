import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, type BotConfig } from "./config.js";
import { validateFindingLocations } from "./diff.js";
import { decideReviewEvent, normalizeFindingsForReview } from "./findings.js";
import { assertGitClean, preparePullWorktree } from "./git.js";
import { GitHubApi } from "./github.js";
import { redactSecrets } from "./secrets.js";
import { ReviewStateStore } from "./state.js";
import { buildWalkthroughComment } from "./walkthrough.js";
import { postWalkthroughComment } from "./walkthrough-post.js";
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
  skippedProcessed: number;
}

type ReviewPullResult = "reviewed" | "skipped_draft" | "skipped_canary" | "skipped_processed";

export async function runOnce(options: RunOnceOptions): Promise<RunOnceResult> {
  const config = loadConfig(options.configPath);
  const github = new GitHubApi(config.github);
  const state = new ReviewStateStore(config.statePath);
  const result: RunOnceResult = {
    reposScanned: 0,
    pullsSeen: 0,
    reviewed: 0,
    skippedDraft: 0,
    skippedCanary: 0,
    skippedProcessed: 0
  };
  try {
    const repos = options.repo ? [options.repo] : config.pilotRepos;
    for (const repo of repos) {
      result.reposScanned += 1;
      const pulls = options.pullNumber
        ? [await github.getPull(repo, options.pullNumber)]
        : await github.listOpenPulls(repo);
      result.pullsSeen += pulls.length;
      for (const pull of pulls) {
        const status = await reviewPull({
          config,
          github,
          state,
          repo,
          pull,
          dryRun: options.dryRun,
          useZCode: options.useZCode ?? true
        });
        if (status === "reviewed") result.reviewed += 1;
        if (status === "skipped_draft") result.skippedDraft += 1;
        if (status === "skipped_canary") result.skippedCanary += 1;
        if (status === "skipped_processed") result.skippedProcessed += 1;
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
}): Promise<ReviewPullResult> {
  const { config, github, state, repo, pull } = input;
  if (config.skipDrafts && pull.draft) return "skipped_draft";
  if (!isCanaryAllowed(config, repo, pull.number)) return "skipped_canary";
  if (state.hasProcessed(repo, pull.number, pull.head.sha)) return "skipped_processed";

  const evidenceDir = join(config.evidenceDir, localDateFolder(), repo.replace("/", "__"), `pr-${pull.number}`, pull.head.sha);
  mkdirSync(evidenceDir, { recursive: true });

  const files = await github.listPullFiles(repo, pull.number);
  const worktree = preparePullWorktree({
    repo,
    pullNumber: pull.number,
    expectedHeadSha: pull.head.sha,
    workRoot: config.workRoot
  });

  const prompt = buildReviewPrompt({ repo, pull, files, maxPatchBytes: config.zcode.maxPatchBytes });
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

  const located = validateFindingLocations(zcodeResult.findings, files);
  const normalized = normalizeFindingsForReview(located.valid, { maxInlineComments: 25 });
  const comments = normalized.comments;
  const dropped = sanitizeDroppedFindings([...zcodeResult.droppedFromSchema, ...located.dropped, ...normalized.dropped]);
  const event = decideReviewEvent(comments);
  const summary = buildSummary({ repo, pull, comments, dropped, dryRun: input.dryRun });
  const walkthrough = config.walkthrough.enabled
    ? buildWalkthroughComment({
        repo,
        pull,
        files,
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
  await postWalkthroughComment({ github: reviewGithub, repo, pullNumber: pull.number, evidenceDir, walkthrough: plan.walkthrough });
  const review = await reviewGithub.createReview({
    repo,
    pullNumber: pull.number,
    event,
    body: plan.walkthrough && !plan.walkthrough.postIssueComment ? plan.walkthrough.body : plan.summary,
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
