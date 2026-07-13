import type { ReviewEvent } from "./types.js";

export type ReviewEventPolicyMode = "automatic" | "trusted_command_only";

export interface ReviewEventPolicyConfig {
  mode: ReviewEventPolicyMode;
}

type AuthorizationMetadata = {
  author?: string;
  commentId?: number;
};

export type ReviewEventAuthorizationAttempt =
  | ({ status: "missing" | "malformed" | "untrusted" | "lookup_failed" | "consumed" } & AuthorizationMetadata)
  | ({ status: "stale_head"; headSha: string } & AuthorizationMetadata)
  | ({ status: "eligible"; headSha: string; author: string; commentId: number });

export type ReviewEventDecisionReason =
  | "automatic"
  | "candidate_comment"
  | "authorization_missing"
  | "authorization_malformed"
  | "authorization_untrusted"
  | "authorization_stale_head"
  | "authorization_lookup_failed"
  | "authorization_consumed"
  | "authorization_eligible";

export interface ReviewEventDecision {
  candidateEvent: ReviewEvent;
  selectedEvent: ReviewEvent;
  mode: ReviewEventPolicyMode;
  reason: ReviewEventDecisionReason;
  headSha: string;
  author?: string;
  commentId?: number;
}

export interface DecideReviewEventPolicyInput {
  mode: ReviewEventPolicyMode;
  candidateEvent: ReviewEvent;
  headSha: string;
  authorization: ReviewEventAuthorizationAttempt;
}

/**
 * Select the most recent eligible authorization for the supplied exact head. Invalid attempts do
 * not prevent an independently valid owner authorization from being considered.
 */
export function selectReviewEventAuthorizationAttempt(
  attempts: readonly ReviewEventAuthorizationAttempt[],
  headSha: string
): ReviewEventAuthorizationAttempt {
  const normalizedHeadSha = normalizeHeadSha(headSha);
  const mostRecentEligible = [...attempts].reverse().find((attempt) =>
    attempt.status === "eligible" && normalizedHeadSha !== undefined && normalizeHeadSha(attempt.headSha) === normalizedHeadSha
  );
  if (mostRecentEligible) return mostRecentEligible;

  return [...attempts].reverse().find((attempt) => attempt.status !== "missing") ?? { status: "missing" };
}

export function decideReviewEventPolicy(input: DecideReviewEventPolicyInput): ReviewEventDecision {
  const headSha = normalizeHeadSha(input.headSha) ?? input.headSha;
  const base = {
    candidateEvent: input.candidateEvent,
    mode: input.mode,
    headSha
  };

  if (input.mode === "automatic") {
    return { ...base, selectedEvent: input.candidateEvent, reason: "automatic" };
  }

  if (input.candidateEvent === "COMMENT") {
    return { ...base, selectedEvent: "COMMENT", reason: "candidate_comment" };
  }

  const authorization = input.authorization;
  const metadata = selectedMetadata(authorization);
  if (authorization.status === "eligible") {
    const authorizationHeadSha = normalizeHeadSha(authorization.headSha);
    const currentHeadSha = normalizeHeadSha(input.headSha);
    if (authorizationHeadSha !== undefined && currentHeadSha !== undefined && authorizationHeadSha === currentHeadSha) {
      return { ...base, selectedEvent: "REQUEST_CHANGES", reason: "authorization_eligible", ...metadata };
    }
    return { ...base, selectedEvent: "COMMENT", reason: "authorization_stale_head", ...metadata };
  }

  return {
    ...base,
    selectedEvent: "COMMENT",
    reason: authorizationReason(authorization.status),
    ...metadata
  };
}

function authorizationReason(status: Exclude<ReviewEventAuthorizationAttempt["status"], "eligible">): ReviewEventDecisionReason {
  switch (status) {
    case "missing":
      return "authorization_missing";
    case "malformed":
      return "authorization_malformed";
    case "untrusted":
      return "authorization_untrusted";
    case "stale_head":
      return "authorization_stale_head";
    case "lookup_failed":
      return "authorization_lookup_failed";
    case "consumed":
      return "authorization_consumed";
  }
}

function normalizeHeadSha(headSha: string): string | undefined {
  return /^[0-9a-f]{40}$/i.test(headSha) ? headSha.toLowerCase() : undefined;
}

function selectedMetadata(authorization: ReviewEventAuthorizationAttempt): AuthorizationMetadata {
  const author = typeof authorization.author === "string" ? authorization.author.slice(0, 100) : undefined;
  const commentId = Number.isSafeInteger(authorization.commentId) && (authorization.commentId as number) > 0
    ? authorization.commentId
    : undefined;
  return { ...(author === undefined ? {} : { author }), ...(commentId === undefined ? {} : { commentId }) };
}
