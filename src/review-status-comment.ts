import { redactSecrets } from "./secrets.js";

export type ReviewStatusCommentState =
  | "queued"
  | "in_progress"
  | "completed"
  | "provider_deferred"
  | "stale_head"
  | "closed_or_merged_before_review"
  | "skipped"
  | "failed";

export interface ReviewStatusCommentGithub {
  canPostAsApp(): boolean;
  upsertIssueComment(input: {
    repo: string;
    issueNumber: number;
    marker: string;
    body: string;
  }): Promise<{ action: "created" | "updated"; html_url?: string; id: number }>;
}

export type ReviewStatusCommentPostResult =
  | { posted: true; action: "created" | "updated"; html_url?: string; id: number; state: ReviewStatusCommentState }
  | { posted: false; reason: "disabled" | "dry_run" | "missing_app_credentials" | "upsert_failed"; state: ReviewStatusCommentState; error?: string };

export interface BuildReviewStatusCommentInput {
  repo: string;
  pullNumber: number;
  headSha: string;
  state: ReviewStatusCommentState;
  pullTitle?: string;
  pullUrl?: string;
  reviewUrl?: string;
  details?: string;
  now?: Date;
}

export const REVIEW_STATUS_MARKER_PREFIX = "<!-- evaos-code-review-bot:review-status";
const REVIEW_STATUS_STATE_MARKER_PREFIX = "<!-- evaos-code-review-bot:review-status-state";
const REPO_SLUG_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const HEAD_SHA_PATTERN = /^[0-9a-f]{40}$/i;
const HTML_COMMENT_PATTERN = /<!--[\s\S]*?-->/g;

export function buildReviewStatusMarker(input: {
  repo: string;
  pullNumber: number;
  headSha: string;
}): string {
  validateMarkerIdentity(input);
  return `${REVIEW_STATUS_MARKER_PREFIX} repo=${input.repo} pr=${input.pullNumber} sha=${input.headSha} -->`;
}

export function buildReviewStatusComment(input: BuildReviewStatusCommentInput): {
  marker: string;
  body: string;
} {
  const marker = buildReviewStatusMarker(input);
  const updatedAt = (input.now ?? new Date()).toISOString();
  const title = formatInlinePublicText(input.pullTitle);
  const details = sanitizePublicText(input.details);
  const pullUrl = sanitizePublicText(input.pullUrl);
  const reviewUrl = sanitizePublicText(input.reviewUrl);
  const lines = [
    marker,
    `${REVIEW_STATUS_STATE_MARKER_PREFIX} status=${input.state} updated_at=${updatedAt} -->`,
    "",
    `## evaOS review status: ${formatStatus(input.state)}`,
    "",
    `PR: ${input.repo}#${input.pullNumber}${title ? ` - ${title}` : ""}`,
    `Head: \`${input.headSha}\``,
    `Updated: ${updatedAt}`,
    "",
    statusMessage(input),
    "",
    "Automation note: agents should wait for this comment to reach `completed`, `stale_head`, `closed_or_merged_before_review`, `skipped`, or `failed` before treating evaOS review as settled for this head. `provider_deferred` means evaOS still intends to retry.",
    ...(pullUrl ? ["", `PR URL: ${pullUrl}`] : []),
    ...(reviewUrl ? ["", `Review URL: ${reviewUrl}`] : []),
    ...(details ? ["", `Details: ${details}`] : [])
  ];

  return {
    marker,
    body: redactSecrets(lines.join("\n"))
  };
}

export async function postReviewStatusComment(input: {
  enabled: boolean;
  dryRun: boolean;
  github: ReviewStatusCommentGithub;
  repo: string;
  pullNumber: number;
  headSha: string;
  state: ReviewStatusCommentState;
  pullTitle?: string;
  pullUrl?: string;
  reviewUrl?: string;
  details?: string;
  now?: Date;
}): Promise<ReviewStatusCommentPostResult> {
  if (!input.enabled) return { posted: false, reason: "disabled", state: input.state };
  if (input.dryRun) return { posted: false, reason: "dry_run", state: input.state };
  if (!input.github.canPostAsApp()) return { posted: false, reason: "missing_app_credentials", state: input.state };

  try {
    const comment = buildReviewStatusComment(input);
    const result = await input.github.upsertIssueComment({
      repo: input.repo,
      issueNumber: input.pullNumber,
      marker: comment.marker,
      body: comment.body
    });
    return { posted: true, state: input.state, ...result };
  } catch (error) {
    return {
      posted: false,
      reason: "upsert_failed",
      state: input.state,
      error: redactSecrets(error instanceof Error ? error.message : String(error))
    };
  }
}

function formatStatus(state: ReviewStatusCommentState): string {
  return state.replaceAll("_", " ");
}

function validateMarkerIdentity(input: { repo: string; pullNumber: number; headSha: string }): void {
  if (!REPO_SLUG_PATTERN.test(input.repo)) throw new Error(`Invalid review status repo slug: ${input.repo}`);
  if (!Number.isInteger(input.pullNumber) || input.pullNumber <= 0) {
    throw new Error(`Invalid review status pull number: ${input.pullNumber}`);
  }
  if (!HEAD_SHA_PATTERN.test(input.headSha)) throw new Error(`Invalid review status head SHA: ${input.headSha}`);
}

function sanitizePublicText(value: string | undefined): string {
  if (!value) return "";
  return redactSecrets(value.replace(HTML_COMMENT_PATTERN, "[hidden comment removed]")).trim();
}

function formatInlinePublicText(value: string | undefined): string {
  return sanitizePublicText(value)
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^#{1,6}\s+/, "")
    .slice(0, 200);
}

function statusMessage(input: BuildReviewStatusCommentInput): string {
  switch (input.state) {
    case "queued":
      return "This PR head has entered the evaOS review queue. No final evaOS review has posted for this head yet.";
    case "in_progress":
      return "evaOS review is running for this PR head.";
    case "completed":
      return "evaOS review completed for this PR head.";
    case "provider_deferred":
      return "evaOS review is deferred because the model provider or worker capacity is temporarily unavailable. The worker will retry according to cooldown policy.";
    case "stale_head":
      return "evaOS review stopped because this queued head is no longer the live PR head.";
    case "closed_or_merged_before_review":
      return "evaOS review stopped because the PR closed or merged before this queued head could be reviewed.";
    case "skipped":
      return "evaOS review was intentionally skipped for this head because current repo, PR, or policy state says it should not run.";
    case "failed":
      return "evaOS review failed for this head and needs retry or operator attention.";
    default:
      return assertNever(input.state);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled review status comment state: ${String(value)}`);
}
