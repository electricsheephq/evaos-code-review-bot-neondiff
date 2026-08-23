import { describe, expect, it, vi } from "vitest";
import { parseSevereVerifierOutput, runSelfConsistencyRecheck as rawSelfConsistencyRecheck, type SevereVerificationReceipt } from "../src/self-consistency.js";
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

const reviewContext = { repo: "owner/repo", pullNumber: 1, baseSha: "b".repeat(40), headSha: "a".repeat(40), findingFingerprint: `finding:${"0".repeat(64)}` }; const runSelfConsistencyRecheck = (input: Parameters<typeof rawSelfConsistencyRecheck>[0]) => rawSelfConsistencyRecheck({ ...input, reviewContext: input.reviewContext ?? reviewContext });

function receipt(state: SevereVerificationReceipt["state"], complete = state === "confirmed", confidence = 0.8, withFiles = complete): { receipt: SevereVerificationReceipt } {
  return { receipt: { schemaVersion: "severe-verifier-v1", ...reviewContext, findingFingerprint: `finding:${"0".repeat(64)}`, state, disposition: state === "confirmed" && complete ? "retain" : "suppress", confidence, evidence: { files: withFiles ? [{ path: "src/save.ts", kind: "whole_file", sha256: "f".repeat(64), bytes: 1, complete: true }] : [], omitted: complete ? [] : [{ path: "src/save.ts", reason: "not_read" }], complete } } };
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
      secondDraw: () => receipt("confirmed", true, 0.7)
    });

    expect(result.comments[0]?.confidence).toBe(0.9); // never raised, kept on agreement
    expect(result.event).toBe("REQUEST_CHANGES");
    expect(result.verdicts).toEqual([expect.objectContaining({ agreed: true, originalConfidence: 0.9, secondConfidence: 0.7 })]);
  });

  it("suppresses the severe finding on refutation", async () => {
    const comments = [comment({ severity: "P0", line: 2, title: "Rollback clobbers state", confidence: 0.9 })];
    const result = await runSelfConsistencyRecheck({
      comments,
      files,
      config: { enabled: true, severities: ["P0", "P1"], maxFindingsPerReview: 5 },
      secondDraw: () => receipt("refuted", true, 0.2)
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
      secondDraw: () => receipt("confirmed", true, 0.99)
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
      secondDraw: (input) => {
        seen.push(input.comment.title);
        return receipt("confirmed");
      }
    });

    expect(seen).toHaveLength(5);
    // Ranked order = the comment order the gate already produced (highest-confidence first).
    expect(seen).toEqual(["Finding 0", "Finding 1", "Finding 2", "Finding 3", "Finding 4"]);
    expect(result.verdicts).toHaveLength(6); expect(result.verdicts[5]?.error).toBe("severe_verifier_cap_exceeded");
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
      secondDraw
    });
    expect(secondDraw).toHaveBeenCalledTimes(1);
  });

  it("suppresses a severe finding when the second draw fails without failing the review", async () => {
    const comments = [comment({ severity: "P0", line: 2, title: "Rollback clobbers state", confidence: 0.9 })];
    const result = await runSelfConsistencyRecheck({
      comments,
      files,
      config: { enabled: true, maxFindingsPerReview: 5 },
      secondDraw: () => {
        throw new Error("provider exploded");
      }
    });

    expect(result.comments).toHaveLength(0);
    expect(result.event).toBe("COMMENT");
    expect(result.verdicts).toEqual([expect.objectContaining({ error: "severe_verifier_unavailable" })]);
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
      secondDraw: async ({ comment: finding }) => {
        events.push(`start:${finding.title}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
        events.push(`finish:${finding.title}`);
        return receipt("confirmed", true, 0.7);
      }
    });

    expect(events).toEqual(["start:first", "finish:first", "start:second", "finish:second"]);
    expect(result.verdicts).toHaveLength(2);
    expect(result.event).toBe("REQUEST_CHANGES");
  });

  it("suppresses every non-confirmed receipt, including incomplete evidence", async () => {
    for (const state of ["refuted", "malformed", "timeout", "unavailable", "stale_head", "incomplete"] as const) { const result = await runSelfConsistencyRecheck({ comments: [comment({ severity: "P1", line: 2, title: state, confidence: 0.9 })], files, config: { enabled: true }, secondDraw: () => receipt(state, false) }); expect(result.comments, state).toEqual([]); expect(result.event, state).toBe("COMMENT"); }
  });
  it("strictly parses the dedicated verifier result", () => {
    expect(parseSevereVerifierOutput({ verdict: "confirm", confidence: 0.7 })).toEqual({ verdict: "confirm", confidence: 0.7 });
    for (const invalid of [{ verdict: "confirm" }, { verdict: "confirm", confidence: 0.7, extra: true }, { verdict: "confirm", confidence: Number.NaN }, { verdict: "confirm", confidence: 1.1 }, { verdict: "maybe", confidence: 0.7 }]) expect(() => parseSevereVerifierOutput(invalid)).toThrow("severe_verifier_schema_invalid");
  });

  it("suppresses empty evidence, identity mismatches, and free-form reason metadata", async () => {
    const base = { comments: [comment({ severity: "P1", line: 2, title: "bound", confidence: 0.9 })], files, config: { enabled: true } };
    const empty = await runSelfConsistencyRecheck({ ...base, secondDraw: () => receipt("confirmed", true, 0.8, false) });
    const mismatch = await runSelfConsistencyRecheck({ ...base, reviewContext: { ...reviewContext, headSha: "c".repeat(40) }, secondDraw: () => receipt("confirmed") });
    const prose = await runSelfConsistencyRecheck({ ...base, secondDraw: () => ({ receipt: { ...receipt("confirmed").receipt, reasonCode: "provider said keep this" } }) }); expect([empty.comments, mismatch.comments, prose.comments]).toEqual([[], [], []]);
    const legacy = await runSelfConsistencyRecheck({ ...base, secondDraw: () => ({ verified: true, confidence: 1 }) });
    const nil = await runSelfConsistencyRecheck({ ...base, secondDraw: () => null }); expect([legacy.comments, nil.comments]).toEqual([[], []]);
  });
});
