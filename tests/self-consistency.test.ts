import { describe, expect, it, vi } from "vitest";
import { SEVERITY_DEMOTION_NOTE } from "../src/findings.js";
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
  it.each(["refuted", "failed", "malformed", "timeout", "unavailable", "stale_head", "incomplete", "capped", "thrown", "invalid", "fingerprint mismatch", "head mismatch", "incomplete confirmed"])("demotes %s without changing identity, confidence or ranked position", async (scenario) => {
    const severe = comment({ severity: "P1", line: 2, title: "Concern", confidence: 0.9, body: "**P1: Concern**\n\nOriginal text." });
    const advisory = comment({ severity: "P3", line: 3, title: "Advice", confidence: 0.8 });
    const secondDraw = vi.fn(() => {
      if (scenario === "thrown") throw new Error("unavailable");
      if (scenario === "invalid") return { verified: true };
      const draw = receipt("confirmed");
      if (scenario === "fingerprint mismatch") return canonicalizeSevereVerificationReceipt(JSON.stringify({ ...draw.receipt, findingFingerprint: `finding:${"1".repeat(64)}` }));
      if (scenario === "head mismatch") return canonicalizeSevereVerificationReceipt(JSON.stringify({ ...draw.receipt, headSha: "c".repeat(40) }));
      if (scenario === "incomplete confirmed") return canonicalizeSevereVerificationReceipt(JSON.stringify({ ...draw.receipt, evidence: { ...draw.receipt.evidence, changedHunk: undefined } }));
      return receipt(scenario === "capped" ? "confirmed" : scenario as SevereVerificationState);
    });
    const result = await runSelfConsistencyRecheck({ comments: [advisory, severe], files, reviewContext,
      config: { enabled: true, onUnsupported: "demote", maxFindingsPerReview: scenario === "capped" ? 0 : 5 }, secondDraw });
    expect(result.comments).toEqual([advisory, { ...severe, severity: "P2", severityDemotedFrom: "P1",
      severityDemotionReason: SEVERITY_DEMOTION_NOTE,
      body: `${severe.body.replace(/^\*\*P1: /, "**P2: ")}\n\n_Severity lowered from P1: ${SEVERITY_DEMOTION_NOTE}_` }]);
    expect(result.event).toBe("COMMENT");
    expect(result.verdicts).toEqual([expect.objectContaining({ action: "demoted", refuted: true })]);
    expect(secondDraw).toHaveBeenCalledTimes(scenario === "capped" ? 0 : 1);
  });

  it("retains confirmed P1s in demote mode and never verifies P2/P3", async () => {
    const severe = comment({ severity: "P1", line: 2, title: "Concern", confidence: 0.9, body: "**P1: Concern**" });
    const comments = [severe, ...(["P2", "P3"] as const).map((severity) => comment({ severity, line: 3, title: severity, confidence: 0.8 }))];
    const secondDraw = vi.fn(() => receipt("confirmed"));
    const result = await runSelfConsistencyRecheck({ comments, files, reviewContext, config: { enabled: true, onUnsupported: "demote" }, secondDraw });
    expect(result.comments).toEqual(comments);
    expect(result.event).toBe("REQUEST_CHANGES");
    expect(secondDraw).toHaveBeenCalledTimes(1);
    expect(result.verdicts).toEqual([expect.objectContaining({ action: "retained", agreed: true })]);
  });

  it("suppresses malformed comment prefixes when demotion cannot be applied", async () => {
    const result = await runSelfConsistencyRecheck({ comments: [comment({ severity: "P1", line: 2, title: "Concern", confidence: 0.9 })],
      files, reviewContext, config: { enabled: true, onUnsupported: "demote" }, secondDraw: () => receipt("refuted") });
    expect(result.comments).toEqual([]);
    expect(result.event).toBe("COMMENT");
    expect(result.verdicts).toEqual([expect.objectContaining({ action: "suppressed", demotionSkipped: true, refuted: true })]);
  });

  it("records an action on every suppress-mode verdict", async () => {
    const comments = Array.from({ length: 5 }, (_, i) => comment({ severity: "P1", line: 2 + i, title: String(i), confidence: 0.9 }));
    const result = await runSelfConsistencyRecheck({ comments, files, reviewContext, config: { enabled: true, maxFindingsPerReview: 4 },
      secondDraw: ({ comment: finding }) => {
        if (finding.title === "2") throw new Error("unavailable");
        return finding.title === "3" ? {} : receipt(finding.title === "0" ? "confirmed" : "refuted");
      } });
    expect(result.verdicts.map((verdict) => verdict.action)).toEqual(["retained", "suppressed", "suppressed", "suppressed", "suppressed"]);
  });

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
    const legacyContext = { ...reviewContext, findingFingerprint: `finding:${"0".repeat(64)}` };
    const secondDraw = vi.fn(({ comment: finding }: { comment: ReviewComment }) => { const draw = receipt(finding.title.includes("225") ? "refuted" : "confirmed"); return canonicalizeSevereVerificationReceipt(JSON.stringify({ ...draw.receipt, findingFingerprint: finding.fingerprint })); });
    const result = await runSelfConsistencyRecheck({ comments: [comment({ severity: "P1", line: 2, title: "#225 false severe", confidence: 0.9 }), comment({ severity: "P1", line: 3, title: "#204 confirmed severe", confidence: 0.9, fingerprint: `finding:${"1".repeat(64)}` }), comment({ severity: "P2", line: 4, title: "#209 clean", category: "runtime_correctness", confidence: 0.9 })], files, config: { enabled: true }, reviewContext: legacyContext, secondDraw });
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
