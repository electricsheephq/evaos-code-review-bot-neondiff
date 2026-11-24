import { createHash } from "node:crypto";
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
  "<!-- evaos-code-review-bot", "<!-- lcm-x-ai-review", ENRICHMENT_MARKER_PREFIX, "<!-- neondiff",
  REVIEW_ATTRIBUTION_PREFIX
].map((text) => text.toLowerCase());

export function normalizeOperatorCommentRepo(value: string): string {
  const repo = value.trim().toLowerCase();
  if (!/^[a-z0-9-]+\/[a-z0-9._-]+$/.test(repo) || /\/\.{1,2}$/.test(repo)) {
    throw new Error("post-comment --repo must be owner/name");
  }
  return repo;
}

export function resolveOperatorCommentProfile(config: BotConfig, repo: string): ResolvedRepoProfile {
  if (!listReposToScan(config).some((configured) => configured.toLowerCase() === repo)) {
    throw new Error("post-comment repo must be present in configured repos");
  }
  const policy = resolveRepoProfile(config, repo);
  if (!policy.allowed) throw new Error(`post-comment repo is blocked by repo policy: ${policy.reason}`);
  return policy.profile;
}

export function inspectOperatorCommentBody(body: string, profile: ResolvedRepoProfile): { bodyLength: number; bodySha256: string } {
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
      const outcome = await postOperatorComment(request, input.config, input.admission, () => github ??= new GitHubApi(input.config.github));
      input.state.finishOperatorComment(request.id, outcome);
      if (outcome.status !== "pending") input.recordOutcome(request.id, outcome);
    } finally {
      input.state.releaseOperatorComment(request.id);
    }
  }
}

async function postOperatorComment(
  request: PendingComment,
  config: BotConfig,
  admission: ProductionLicenseAdmission,
  getGithub: () => GitHubApi
): Promise<OperatorCommentOutcome> {
  let profile: ResolvedRepoProfile;
  try {
    profile = resolveOperatorCommentProfile(config, normalizeOperatorCommentRepo(request.repo));
  } catch {
    return { status: "refused", errorClass: "repo_policy" };
  }
  try {
    const metadata = inspectOperatorCommentBody(request.body, profile);
    if (metadata.bodySha256 !== request.bodySha256 || !/^[a-f0-9-]{36}$/.test(request.id)) {
      return { status: "refused", errorClass: "invalid_request" };
    }
  } catch {
    return { status: "refused", errorClass: "unsafe_body" };
  }
  try {
    const github = getGithub();
    if (!github.canPostAsApp()) return { status: "refused", errorClass: "missing_app_credentials" };
    const repo = await github.getRepo(request.repo);
    if (repo.full_name?.toLowerCase() !== request.repo ||
      !authorizeAdmissionForVisibility(admission, visibilityFromRepositoryFlags(repo), "daemon_cycle").ok) {
      return { status: "refused", errorClass: "repo_admission" };
    }
    const marker = `<!-- neondiff-operator-comment:${request.id} -->`;
    const identity = await github.postingIdentity();
    const comments = await github.listIssueComments(request.repo, request.number);
    const existing = comments.find((comment) => isAuthoredBy(comment.user, identity) && comment.body?.includes(marker));
    const posted = existing ?? await github.createIssueComment({
      repo: request.repo, issueNumber: request.number, body: `${request.body}\n\n${marker}`
    });
    return { status: "posted", id: posted.id, html_url: posted.html_url };
  } catch (error) {
    const status = error instanceof GitHubApiRequestError ? error.status : undefined;
    return {
      status: (status !== undefined && status < 500) || request.attempts >= 4 ? "failed" : "pending",
      errorClass: status !== undefined ? `github_${status}` : "github_request_error"
    };
  }
}
