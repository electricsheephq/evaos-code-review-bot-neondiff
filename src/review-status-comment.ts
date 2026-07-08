import { redactSecrets } from "./secrets.js";
import { sanitizePublicConfidenceText, type PublicConfidenceDisplayPolicy } from "./public-confidence.js";
import {
  buildIssueHash,
  mapReviewOutcome,
  renderMarkerLifecycleFields,
  type MarkerLifecycleFields
} from "./marker-lifecycle.js";

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
  | { posted: false; reason: "disabled" | "dry_run" | "missing_app_credentials" | "build_failed" | "upsert_failed"; state: ReviewStatusCommentState; error?: string };

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
  publicConfidencePolicy?: PublicConfidenceDisplayPolicy;
  /**
   * Optional run id for correlating this marker with the review run (#263). Reuses the run's
   * existing id (e.g. queue jobId) — this surface does not mint a new one. Absent ⇒ byte-identical
   * marker.
   */
  runId?: string;
  /** Optional downstream-fixer pointer (#263). Diagnostic-only; rides the state marker. */
  handoffTarget?: string;
}

export const REVIEW_STATUS_MARKER_PREFIX = "<!-- evaos-code-review-bot:review-status";
const REVIEW_STATUS_STATE_MARKER_PREFIX = "<!-- evaos-code-review-bot:review-status-state";
const REPO_SLUG_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const HEAD_SHA_PATTERN = /^[0-9a-f]{40}$/i;
const HTML_COMMENT_PATTERN = /<!--[\s\S]*?-->/g;
const REVIEW_STATUS_STATE_PATTERN = /<!--\s*evaos-code-review-bot:review-status-state\b[^>]*\bstatus=([A-Za-z_]+)\b[^>]*-->/;

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
  // Opt-in only: a caller threads a runId/handoffTarget to attach lifecycle metadata. Without an
  // opt-in the state marker stays byte-identical to today (no role/outcome/issueHash tokens).
  const lifecycle = hasReviewLifecycleOptIn(input)
    ? renderMarkerLifecycleFields(buildReviewLifecycleFields(input))
    : "";
  const title = formatInlinePublicText(input.pullTitle, input.publicConfidencePolicy);
  const details = sanitizePublicText(input.details, input.publicConfidencePolicy);
  const pullUrl = sanitizePublicUrlText(input.pullUrl);
  const reviewUrl = sanitizePublicUrlText(input.reviewUrl);
  const lines = [
    marker,
    `${REVIEW_STATUS_STATE_MARKER_PREFIX} status=${input.state} updated_at=${updatedAt}${lifecycle} -->`,
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
    body: lines.join("\n")
  };
}

export function parseReviewStatusCommentState(body: string | null | undefined): ReviewStatusCommentState | undefined {
  const match = body?.match(REVIEW_STATUS_STATE_PATTERN);
  if (!match?.[1]) return undefined;
  return isReviewStatusCommentState(match[1]) ? match[1] : undefined;
}

export function isRepairableReviewStatusCommentState(state: ReviewStatusCommentState | undefined): boolean {
  return state === "queued" || state === "in_progress" || state === "provider_deferred";
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
  publicConfidencePolicy?: PublicConfidenceDisplayPolicy;
  runId?: string;
  handoffTarget?: string;
}): Promise<ReviewStatusCommentPostResult> {
  if (!input.enabled) return { posted: false, reason: "disabled", state: input.state };
  if (input.dryRun) return { posted: false, reason: "dry_run", state: input.state };
  if (!input.github.canPostAsApp()) return { posted: false, reason: "missing_app_credentials", state: input.state };

  let comment: ReturnType<typeof buildReviewStatusComment>;
  try {
    comment = buildReviewStatusComment(input);
  } catch (error) {
    return {
      posted: false,
      reason: "build_failed",
      state: input.state,
      error: redactSecrets(error instanceof Error ? error.message : String(error))
    };
  }

  try {
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

function isReviewStatusCommentState(value: string): value is ReviewStatusCommentState {
  return (
    value === "queued" ||
    value === "in_progress" ||
    value === "completed" ||
    value === "provider_deferred" ||
    value === "stale_head" ||
    value === "closed_or_merged_before_review" ||
    value === "skipped" ||
    value === "failed"
  );
}

function hasReviewLifecycleOptIn(input: BuildReviewStatusCommentInput): boolean {
  return input.runId !== undefined || input.handoffTarget !== undefined;
}

function buildReviewLifecycleFields(input: BuildReviewStatusCommentInput): MarkerLifecycleFields {
  // Role is fixed for the review-status surface; outcome is a mapping of the existing decision
  // (undefined for non-terminal states); issueHash correlates repo+pr+head. runId/handoffTarget
  // are optional passthroughs. All ride the diagnostic state marker only.
  return {
    role: "reviewer",
    issueHash: buildIssueHash({ repo: input.repo, pullNumber: input.pullNumber, headSha: input.headSha }),
    ...(mapReviewOutcome(input.state) ? { outcome: mapReviewOutcome(input.state) } : {}),
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.handoffTarget ? { handoffTarget: input.handoffTarget } : {})
  };
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

function sanitizePublicText(value: string | undefined, publicConfidencePolicy?: PublicConfidenceDisplayPolicy): string {
  if (!value) return "";
  return sanitizePublicConfidenceText(
    redactSecrets(value.replace(HTML_COMMENT_PATTERN, "[hidden comment removed]")),
    publicConfidencePolicy
  ).trim();
}

function sanitizePublicUrlText(value: string | undefined): string {
  if (!value) return "";
  // URLs skip confidence sanitization so query strings stay intact.
  return redactSecrets(value.replace(HTML_COMMENT_PATTERN, "[hidden comment removed]")).trim();
}

function formatInlinePublicText(value: string | undefined, publicConfidencePolicy?: PublicConfidenceDisplayPolicy): string {
  const normalizedText = redactSecrets((value ?? "").replace(HTML_COMMENT_PATTERN, "[hidden comment removed]"))
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^#{1,6}\s+/, "");
  return sanitizePublicConfidenceText(normalizedText, publicConfidencePolicy)
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
