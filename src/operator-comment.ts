import { createHash } from "node:crypto";
import { containsCommandLine } from "./commands.js";
import type { BotConfig } from "./config.js";
import { ENRICHMENT_MARKER_PREFIX } from "./enrichment.js";
import { GitHubApi, GitHubApiRequestError, isAuthoredBy } from "./github.js";
import { authorizeAdmissionForVisibility, type ProductionLicenseAdmission } from "./license-admission.js";
import { visibilityFromRepositoryFlags } from "./public-repo-author-gate.js";
import {
  assertPublicReviewOutputSafe, listReposToScan, PUBLIC_REVIEW_PROFILE_FRAGMENT_WORD_WINDOW,
  publicReviewForbiddenProfileFragments, resolveRepoProfile, type ResolvedRepoProfile
} from "./repo-policy.js";
import { containsSecretLikeText } from "./secrets.js";
import type { ReviewStateStore } from "./state.js";
import { REVIEW_ATTRIBUTION_PREFIX } from "./walkthrough-post.js";
import { reviewPromptForbiddenFragments } from "./zcode.js";

const RESERVED_COMMENT_TEXT = [
  "<!-- evaos-", "<!-- lcm-x-ai-review", ENRICHMENT_MARKER_PREFIX, "<!-- neondiff",
  REVIEW_ATTRIBUTION_PREFIX
].map((text) => text.toLowerCase());
const OPERATOR_COMMENT_MARKER = "<!-- neondiff-operator-comment:";
const RETRY_WINDOW_MS = 24 * 60 * 60_000;

export function normalizeOperatorCommentRepo(value: string): string {
  const repo = value.trim().toLowerCase();
  if (!/^[a-z0-9-]+\/[a-z0-9._-]+$/.test(repo) || /\/\.{1,2}$/.test(repo)) {
    throw new Error("post-comment --repo must be owner/name");
  }
  return repo;
}

export function resolveOperatorCommentTarget(config: BotConfig, repo: string): { repo: string; profile: ResolvedRepoProfile } {
  const configuredRepo = listReposToScan(config).find((configured) => configured.toLowerCase() === repo);
  if (!configuredRepo) {
    throw new Error("post-comment repo must be present in configured repos");
  }
  const policy = resolveRepoProfile(config, repo);
  if (!policy.allowed) throw new Error(`post-comment repo is blocked by repo policy: ${policy.reason}`);
  return { repo: configuredRepo, profile: policy.profile };
}

export function inspectOperatorCommentBody(body: string, profile: ResolvedRepoProfile, botMentions: string[]): {
  bodyLength: number; bodySha256: string;
} {
  const bodyLength = Array.from(body).length;
  if (!body.trim()) throw new Error("post-comment body must be non-empty");
  if (bodyLength > 60_000) throw new Error("post-comment body must be at most 60,000 characters");
  if (containsSecretLikeText(body)) throw new Error("post-comment body contains secret-like text");
  assertPublicReviewOutputSafe(body, reviewPromptForbiddenFragments());
  assertPublicReviewOutputSafe(body, publicReviewForbiddenProfileFragments(profile), PUBLIC_REVIEW_PROFILE_FRAGMENT_WORD_WINDOW);
  const normalized = body.toLowerCase();
  if (RESERVED_COMMENT_TEXT.some((text) => normalized.includes(text))) {
    throw new Error("post-comment body contains a reserved NeonDiff marker or attribution");
  }
  if (containsCommandLine(body, botMentions)) throw new Error("post-comment body contains a NeonDiff command line");
  return { bodyLength, bodySha256: createHash("sha256").update(body).digest("hex") };
}

type OperatorCommentOutcome = Parameters<ReviewStateStore["finishOperatorComment"]>[1];
type PendingComment = ReturnType<ReviewStateStore["listPendingOperatorComments"]>[number];

export async function processOperatorComments(input: {
  config: BotConfig;
  state: ReviewStateStore;
  admission: ProductionLicenseAdmission;
  recordOutcome: (id: string, outcome: OperatorCommentOutcome) => void;
}): Promise<void> {
  let github: GitHubApi | undefined;
  for (const request of input.state.listPendingOperatorComments(5)) {
    if (!input.state.tryClaimOperatorComment(request.id, request.attempts)) continue;
    try {
      const outcome = await postOperatorComment(request, input.config, input.admission,
        () => github ??= new GitHubApi(input.config.github), () => input.state.isOperatorCommentClaimCurrent(request.id));
      if (outcome && input.state.finishOperatorComment(request.id, outcome) && outcome.status !== "pending") {
        input.recordOutcome(request.id, outcome);
      }
    } finally {
      input.state.releaseOperatorComment(request.id);
    }
  }
}

async function postOperatorComment(
  request: PendingComment,
  config: BotConfig,
  admission: ProductionLicenseAdmission,
  getGithub: () => GitHubApi,
  claimIsCurrent: () => boolean
): Promise<OperatorCommentOutcome | undefined> {
  let target: ReturnType<typeof resolveOperatorCommentTarget>;
  try {
    target = resolveOperatorCommentTarget(config, normalizeOperatorCommentRepo(request.repo));
  } catch {
    return { status: "refused", errorClass: "repo_policy" };
  }
  try {
    const metadata = inspectOperatorCommentBody(request.body, target.profile, config.commands.botMentions);
    if (metadata.bodySha256 !== request.bodySha256 || !/^[a-f0-9-]{36}$/.test(request.id)) {
      return { status: "refused", errorClass: "invalid_request" };
    }
  } catch {
    return { status: "refused", errorClass: "unsafe_body" };
  }
  const retryDeadline = Date.parse(request.requestedAt) + RETRY_WINDOW_MS;
  const exhausted = { status: "failed", errorClass: "retry_exhausted" } as const;
  try {
    const github = getGithub();
    if (!github.canPostAsApp()) return { status: "refused", errorClass: "missing_app_credentials" };
    const repo = await github.getRepo(target.repo);
    if (repo.full_name?.toLowerCase() !== request.repo ||
      !authorizeAdmissionForVisibility(admission, visibilityFromRepositoryFlags(repo), "daemon_cycle").ok) {
      return { status: "refused", errorClass: "repo_admission" };
    }
    const marker = `${OPERATOR_COMMENT_MARKER}${request.id}:${request.bodySha256} -->`;
    const bodyMarker = new RegExp(`${OPERATOR_COMMENT_MARKER}[^:\\s>]+:${request.bodySha256} -->`);
    const identity = await github.postingIdentity();
    const comments = await github.listIssueComments(target.repo, request.number);
    const existing = comments.find((comment) => {
      const appId = comment.performed_via_github_app?.id;
      const ownComment = appId === undefined ? isAuthoredBy(comment.user, identity) : appId === Number(config.github.appId);
      if (!ownComment || !comment.body) return false;
      const legacy = comment.body.match(/\n\n<!-- neondiff-operator-comment:[a-f0-9-]{36} -->$/);
      return bodyMarker.test(comment.body) || (legacy !== null && comment.body.slice(0, legacy.index) === request.body);
    });
    if (!existing && Date.now() >= retryDeadline) return exhausted;
    if (!existing && !claimIsCurrent()) return undefined;
    const posted = existing ?? await github.createIssueComment({
      repo: target.repo, issueNumber: request.number, body: `${request.body}\n\n${marker}`
    });
    return { status: "posted", id: posted.id, html_url: posted.html_url };
  } catch (error) {
    const now = Date.now();
    if (now >= retryDeadline) return exhausted;
    const githubError = error instanceof GitHubApiRequestError ? error : undefined;
    const status = githubError?.status;
    const errorClass = status !== undefined ? `github_${status}` : "github_request_error";
    if (status === 404 || status === 410 || status === 422 || (status === 403 && !githubError?.isRateLimited)) {
      return { status: "failed", errorClass };
    }
    const backoffMs = Math.min(60, 2 ** request.attempts) * 60_000;
    return {
      status: "pending", errorClass, nextAttemptAt: new Date(Math.min(now + backoffMs, retryDeadline)).toISOString()
    };
  }
}
