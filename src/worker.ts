import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, type BotConfig } from "./config.js";
import { validateFindingLocations } from "./diff.js";
import { decideReviewEvent, normalizeFindingsForReview } from "./findings.js";
import { assertGitClean, preparePullWorktree } from "./git.js";
import { GitHubApi } from "./github.js";
import { ReviewStateStore } from "./state.js";
import { buildReviewPrompt, runZCodeReview } from "./zcode.js";
import type { PullRequestSummary, ReviewPlan } from "./types.js";

export interface RunOnceOptions {
  configPath?: string;
  dryRun: boolean;
  repo?: string;
  pullNumber?: number;
  useZCode?: boolean;
}

export async function runOnce(options: RunOnceOptions): Promise<void> {
  const config = loadConfig(options.configPath);
  const github = new GitHubApi(config.github);
  const state = new ReviewStateStore(config.statePath);
  try {
    const repos = options.repo ? [options.repo] : config.pilotRepos;
    for (const repo of repos) {
      const pulls = options.pullNumber
        ? [await github.getPull(repo, options.pullNumber)]
        : await github.listOpenPulls(repo);
      for (const pull of pulls) {
        await reviewPull({ config, github, state, repo, pull, dryRun: options.dryRun, useZCode: options.useZCode ?? true });
      }
    }
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
}): Promise<void> {
  const { config, github, state, repo, pull } = input;
  if (config.skipDrafts && pull.draft) return;
  if (state.hasProcessed(repo, pull.number, pull.head.sha)) return;

  const evidenceDir = join(config.evidenceDir, new Date().toISOString().slice(0, 10), repo.replace("/", "__"), `pr-${pull.number}`, pull.head.sha);
  mkdirSync(evidenceDir, { recursive: true });

  const files = await github.listPullFiles(repo, pull.number);
  const worktree = preparePullWorktree({
    repo,
    pullNumber: pull.number,
    expectedHeadSha: pull.head.sha,
    workRoot: config.workRoot
  });

  const prompt = buildReviewPrompt({ repo, pull, files, maxPatchBytes: config.zcode.maxPatchBytes });
  writeFileSync(join(evidenceDir, "review-prompt.txt"), prompt);

  const zcodeResult = input.useZCode
    ? runZCodeReview({
        cwd: worktree.path,
        prompt,
        cliPath: config.zcode.cliPath,
        appConfigPath: config.zcode.appConfigPath,
        model: config.zcode.model,
        providerId: config.zcode.providerId,
        evidenceDir,
        timeoutMs: config.zcode.timeoutMs
      })
    : { findings: [], droppedFromSchema: [], rawResponse: "{\"findings\":[]}" };

  assertGitClean(worktree.path);

  const located = validateFindingLocations(zcodeResult.findings, files);
  const normalized = normalizeFindingsForReview(located.valid, { maxInlineComments: 25 });
  const comments = normalized.comments;
  const dropped = [...zcodeResult.droppedFromSchema, ...located.dropped, ...normalized.dropped];
  const event = decideReviewEvent(comments);
  const plan: ReviewPlan = {
    event,
    comments,
    dropped,
    summary: buildSummary({ repo, pull, comments, dropped, dryRun: input.dryRun })
  };

  writeFileSync(join(evidenceDir, "review-plan.json"), `${JSON.stringify(plan, null, 2)}\n`);

  if (input.dryRun) {
    state.recordProcessed({ repo, pullNumber: pull.number, headSha: pull.head.sha, status: "dry_run", event });
    return;
  }

  const review = await github.createReview({
    repo,
    pullNumber: pull.number,
    event,
    body: plan.summary,
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
