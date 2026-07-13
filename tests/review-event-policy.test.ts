import { describe, expect, it } from "vitest";
import {
  decideReviewEventPolicy,
  selectReviewEventAuthorizationAttempt,
  type ReviewEventAuthorizationAttempt
} from "../src/review-event-policy.js";

const HEAD = "a".repeat(40);

describe("review event policy", () => {
  it("keeps the candidate event in explicit automatic compatibility mode", () => {
    expect(decideReviewEventPolicy({
      mode: "automatic",
      candidateEvent: "REQUEST_CHANGES",
      headSha: HEAD,
      authorization: { status: "missing" }
    })).toEqual({
      candidateEvent: "REQUEST_CHANGES",
      selectedEvent: "REQUEST_CHANGES",
      mode: "automatic",
      reason: "automatic",
      headSha: HEAD
    });
  });

  it("keeps a comment candidate advisory even with an eligible authorization", () => {
    expect(decideReviewEventPolicy({
      mode: "trusted_command_only",
      candidateEvent: "COMMENT",
      headSha: HEAD,
      authorization: eligibleAuthorization()
    })).toMatchObject({
      selectedEvent: "COMMENT",
      reason: "candidate_comment"
    });
  });

  it.each([
    ["missing", { status: "missing" }],
    ["malformed", { status: "malformed", commentId: 41 }],
    ["untrusted", { status: "untrusted", author: "outside-contributor", commentId: 41 }],
    ["stale head", { status: "stale_head", headSha: "b".repeat(40), author: "100yenadmin", commentId: 41 }],
    ["lookup failure", { status: "lookup_failed" }],
    ["consumed", { status: "consumed", author: "100yenadmin", commentId: 41 }],
    ["state error", { status: "state_error", author: "100yenadmin", commentId: 41 }]
  ] as const)("fails closed for %s authorization", (_label, authorization) => {
    expect(decideReviewEventPolicy({
      mode: "trusted_command_only",
      candidateEvent: "REQUEST_CHANGES",
      headSha: HEAD,
      authorization
    })).toMatchObject({
      selectedEvent: "COMMENT",
      reason: `authorization_${authorization.status}`
    });
  });

  it("permits REQUEST_CHANGES only for an eligible exact normalized head", () => {
    const decision = decideReviewEventPolicy({
      mode: "trusted_command_only",
      candidateEvent: "REQUEST_CHANGES",
      headSha: HEAD,
      authorization: {
        ...eligibleAuthorization({ headSha: HEAD.toUpperCase() }),
        commandBody: "@neondiff request-changes --repo owner/repo --pr 7 --head secret"
      } as ReviewEventAuthorizationAttempt
    });

    expect(decision).toMatchObject({
      selectedEvent: "REQUEST_CHANGES",
      reason: "authorization_eligible",
      headSha: HEAD,
      author: "100yenadmin",
      commentId: 41
    });
    expect(decision).not.toHaveProperty("commandBody");
  });

  it("downgrades an incorrectly labelled eligible authorization for another head", () => {
    expect(decideReviewEventPolicy({
      mode: "trusted_command_only",
      candidateEvent: "REQUEST_CHANGES",
      headSha: HEAD,
      authorization: eligibleAuthorization({ headSha: "b".repeat(40) })
    })).toMatchObject({
      selectedEvent: "COMMENT",
      reason: "authorization_stale_head"
    });
  });

  it("fails closed when an eligible authorization has an invalid head", () => {
    expect(decideReviewEventPolicy({
      mode: "trusted_command_only",
      candidateEvent: "REQUEST_CHANGES",
      headSha: "not-a-sha",
      authorization: eligibleAuthorization({ headSha: "also-not-a-sha" })
    })).toMatchObject({
      selectedEvent: "COMMENT",
      reason: "authorization_stale_head"
    });
  });

  it("selects an eligible authorization for the exact head without retaining command text", () => {
    const attempts: ReviewEventAuthorizationAttempt[] = [
      { status: "malformed", author: "100yenadmin", commentId: 40 },
      { status: "eligible", headSha: "b".repeat(40), author: "100yenadmin", commentId: 41 },
      eligibleAuthorization({ commentId: 42 })
    ];

    expect(selectReviewEventAuthorizationAttempt(attempts, HEAD)).toEqual(eligibleAuthorization({ commentId: 42 }));
  });
});

function eligibleAuthorization(overrides: Partial<Extract<ReviewEventAuthorizationAttempt, { status: "eligible" }>> = {}) {
  return {
    status: "eligible" as const,
    headSha: HEAD,
    author: "100yenadmin",
    commentId: 41,
    ...overrides
  };
}
