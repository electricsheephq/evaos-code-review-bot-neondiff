import { describe, expect, it, vi } from "vitest";
import { canonicalizeSevereVerificationReceipt } from "../src/severe-verification-receipt-canonical.js";
import { runSelfConsistencyRecheck, type SelfConsistencyReviewContext } from "../src/self-consistency.js";
import type { SevereVerificationReceipt, SevereVerificationState } from "../src/severe-verification-receipt-schema.js";
import type { PullFilePatch, ReviewComment } from "../src/types.js";

function comment(overrides: Partial<ReviewComment> & Pick<ReviewComment, "severity" | "line" | "title" | "confidence">): ReviewComment {
  return {
    path: "src/save.ts",
    side: "RIGHT",
    body: "A concrete review comment.",
    category: "data_loss",
    fingerprint: `finding:${"0".repeat(64)}`,
    ...overrides
  };
}

const files: PullFilePatch[] = [
  { filename: "src/save.ts", patch: "@@ -1,2 +1,3 @@\n export function save() {\n+  overwriteAllData();\n }" }
];

const reviewContext: SelfConsistencyReviewContext = { repo: "owner/repo", pullNumber: 1, baseSha: "b".repeat(40), headSha: "a".repeat(40) };
const failureReason: Record<Exclude<SevereVerificationState, "confirmed">, SevereVerificationReceipt["reasonCode"]> = {
  refuted: "refuted", failed: "provider_unavailable", malformed: "malformed", timeout: "timeout", unavailable: "unavailable", stale_head: "stale_head", incomplete: "incomplete"
};
function receipt(state: SevereVerificationState, confidence = 0.8) {
  const confirmed = state === "confirmed";
  const complete = confirmed || state === "refuted";
  const value: SevereVerificationReceipt = {
    schemaVersion: "severe-verifier-v1", ...reviewContext, findingFingerprint: `finding:${"0".repeat(64)}`, state,
    disposition: confirmed ? "retain" : "suppress", ...(confirmed ? { confidence } : { reasonCode: failureReason[state] }),
    evidence: complete
      ? { changedHunk: { sha256: "e".repeat(64), bytes: 1, complete: true }, files: [{ path: "src/save.ts", kind: "whole_file", sha256: "f".repeat(64), bytes: 1, complete: true }], omitted: [], complete: true }
      : { files: [], omitted: [{ path: "src/save.ts", code: failureReason[state]! }], complete: false }
  };
  return canonicalizeSevereVerificationReceipt(JSON.stringify(value));
}

describe("self-consistency re-check (#303)", () => {
  it("is a no-op with zero second-draw calls when disabled (byte-identical)", async () => {
    const secondDraw = vi.fn();
    const comments = [comment({ severity: "P0", line: 2, title: "Rollback clobbers state", confidence: 0.9 })];

    const result = await runSelfConsistencyRecheck({
      comments,
      files,
      config: { enabled: false },
      secondDraw
    });

    expect(secondDraw).not.toHaveBeenCalled();
    expect(result.comments).toEqual(comments);
    expect(result.event).toBe("REQUEST_CHANGES");
    expect(result.verdicts).toEqual([]);
  });

  it("keeps confidence and eligibility on agreement, recording the verdict", async () => {
    const comments = [comment({ severity: "P0", line: 2, title: "Rollback clobbers state", confidence: 0.9 })];
    const result = await runSelfConsistencyRecheck({
      comments,
      files,
      config: { enabled: true, severities: ["P0", "P1"], maxFindingsPerReview: 5 },
      reviewContext,
      secondDraw: () => receipt("confirmed", 0.7)
    });

    expect(result.comments[0]?.confidence).toBe(0.9); // never raised, kept on agreement
    expect(result.event).toBe("REQUEST_CHANGES");
    expect(result.verdicts).toEqual([expect.objectContaining({ agreed: true, originalConfidence: 0.9, secondConfidence: 0.7 })]);
  });

  it("suppresses the severe publication on refutation", async () => {
    const comments = [comment({ severity: "P0", line: 2, title: "Rollback clobbers state", confidence: 0.9 })];
    const result = await runSelfConsistencyRecheck({
      comments,
      files,
      config: { enabled: true, severities: ["P0", "P1"], maxFindingsPerReview: 5 },
      reviewContext,
      secondDraw: () => receipt("refuted", 0.2)
    });

    expect(result.comments).toHaveLength(0);
    expect(result.event).toBe("COMMENT");
    expect(result.verdicts).toEqual([expect.objectContaining({ agreed: false, refuted: true })]);
  });

  it("never raises confidence even when the second draw is more confident (agreement)", async () => {
    const result = await runSelfConsistencyRecheck({
      comments: [comment({ severity: "P1", line: 2, title: "Concern", confidence: 0.4 })],
      files,
      config: { enabled: true, maxFindingsPerReview: 5 },
      reviewContext,
      secondDraw: () => receipt("confirmed", 0.99)
    });
    expect(result.comments[0]?.confidence).toBe(0.4);
  });

  it("respects the cost bound: 6 eligible findings with max 5 ⇒ 5 calls in ranked order", async () => {
    const comments = Array.from({ length: 6 }, (_, i) =>
      comment({ severity: "P0", line: 2 + i, title: `Finding ${i}`, confidence: 0.9 - i * 0.01 })
    );
    const seen: string[] = [];
    const result = await runSelfConsistencyRecheck({
      comments,
      files,
      config: { enabled: true, severities: ["P0"], maxFindingsPerReview: 5 },
      reviewContext,
      secondDraw: (input) => {
        seen.push(input.comment.title);
        return receipt("confirmed");
      }
    });

    expect(seen).toHaveLength(5);
    // Ranked order = the comment order the gate already produced (highest-confidence first).
    expect(seen).toEqual(["Finding 0", "Finding 1", "Finding 2", "Finding 3", "Finding 4"]);
    expect(result.comments).toHaveLength(5);
    expect(result.verdicts).toHaveLength(6);
    expect(result.verdicts[5]?.error).toBe("severe_verifier_cap_exceeded");
  });

  it("only re-checks findings at configured severities (default P0/P1)", async () => {
    const secondDraw = vi.fn(() => receipt("confirmed"));
    await runSelfConsistencyRecheck({
      comments: [
        comment({ severity: "P0", line: 2, title: "high", confidence: 0.9 }),
        comment({ severity: "P2", line: 3, title: "low", category: "runtime_correctness", confidence: 0.9 })
      ],
      files,
      config: { enabled: true, maxFindingsPerReview: 5 },
      reviewContext,
      secondDraw
    });
    expect(secondDraw).toHaveBeenCalledTimes(1);
  });

  it("suppresses a finding when the second draw fails without failing the review", async () => {
    const comments = [comment({ severity: "P0", line: 2, title: "Rollback clobbers state", confidence: 0.9 })];
    const result = await runSelfConsistencyRecheck({
      comments,
      files,
      config: { enabled: true, maxFindingsPerReview: 5 },
      reviewContext,
      secondDraw: () => {
        throw new Error("provider exploded");
      }
    });

    expect(result.comments).toHaveLength(0);
    expect(result.event).toBe("COMMENT");
    expect(result.verdicts).toEqual([expect.objectContaining({ error: "severe_verifier_unavailable", refuted: true })]);
  });

  it("awaits asynchronous second draws sequentially in ranked order", async () => {
    const comments = [
      comment({ severity: "P0", line: 2, title: "first", confidence: 0.9 }),
      comment({ severity: "P1", line: 3, title: "second", confidence: 0.8 })
    ];
    const events: string[] = [];

    const result = await runSelfConsistencyRecheck({
      comments,
      files,
      config: { enabled: true, maxFindingsPerReview: 5 },
      reviewContext,
      secondDraw: async ({ comment: finding }) => {
        events.push(`start:${finding.title}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
        events.push(`finish:${finding.title}`);
        return receipt("confirmed", 0.7);
      }
    });

    expect(events).toEqual(["start:first", "finish:first", "start:second", "finish:second"]);
    expect(result.verdicts).toHaveLength(2);
    expect(result.event).toBe("REQUEST_CHANGES");
  });

  it("retains #204, suppresses false-severe #225, and leaves clean #209 advisory", async () => {
    const secondDraw = vi.fn(({ comment: finding }: { comment: ReviewComment }) => receipt(finding.title.includes("225") ? "refuted" : "confirmed"));
    const result = await runSelfConsistencyRecheck({ comments: [comment({ severity: "P1", line: 2, title: "#225 false severe", confidence: 0.9 }), comment({ severity: "P1", line: 3, title: "#204 confirmed severe", confidence: 0.9 }), comment({ severity: "P2", line: 4, title: "#209 clean", category: "runtime_correctness", confidence: 0.9 })], files, config: { enabled: true }, reviewContext, secondDraw });
    expect(result.comments.map(({ title }) => title)).toEqual(["#204 confirmed severe", "#209 clean"]);
    expect(secondDraw).toHaveBeenCalledTimes(2);
    expect(result.event).toBe("REQUEST_CHANGES");
  });

  it("suppresses every terminal failure state and rejects legacy, mismatched, and incomplete receipts", async () => {
    for (const state of ["refuted", "failed", "malformed", "timeout", "unavailable", "stale_head", "incomplete"] as const) {
      const result = await runSelfConsistencyRecheck({ comments: [comment({ severity: "P1", line: 2, title: state, confidence: 0.9 })], files, config: { enabled: true }, reviewContext, secondDraw: () => receipt(state) });
      expect(result.comments, state).toEqual([]);
    }
    const complete = receipt("confirmed");
    const incomplete = canonicalizeSevereVerificationReceipt(JSON.stringify({ ...complete.receipt, evidence: { ...complete.receipt.evidence, changedHunk: undefined } }));
    const mismatched = canonicalizeSevereVerificationReceipt(JSON.stringify({ ...complete.receipt, headSha: "c".repeat(40) }));
    for (const draw of [{ verified: true, confidence: 1 }, incomplete, mismatched]) {
      const result = await runSelfConsistencyRecheck({ comments: [comment({ severity: "P1", line: 2, title: "invalid", confidence: 0.9 })], files, config: { enabled: true }, reviewContext, secondDraw: () => draw });
      expect(result.comments).toEqual([]);
    }
  });
});
