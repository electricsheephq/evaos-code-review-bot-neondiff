import { describe, expect, it, vi } from "vitest";
import { runSelfConsistencyRecheck } from "../src/self-consistency.js";
import type { PullFilePatch, ReviewComment } from "../src/types.js";

function comment(overrides: Partial<ReviewComment> & Pick<ReviewComment, "severity" | "line" | "title" | "confidence">): ReviewComment {
  return {
    path: "src/save.ts",
    side: "RIGHT",
    body: "A concrete review comment.",
    category: "data_loss",
    ...overrides
  };
}

const files: PullFilePatch[] = [
  { filename: "src/save.ts", patch: "@@ -1,2 +1,3 @@\n export function save() {\n+  overwriteAllData();\n }" }
];

describe("self-consistency re-check (#303)", () => {
  it("is a no-op with zero second-draw calls when disabled (byte-identical)", () => {
    const secondDraw = vi.fn();
    const comments = [comment({ severity: "P0", line: 2, title: "Rollback clobbers state", confidence: 0.9 })];

    const result = runSelfConsistencyRecheck({
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

  it("keeps confidence and eligibility on agreement, recording the verdict", () => {
    const comments = [comment({ severity: "P0", line: 2, title: "Rollback clobbers state", confidence: 0.9 })];
    const result = runSelfConsistencyRecheck({
      comments,
      files,
      config: { enabled: true, severities: ["P0", "P1"], maxFindingsPerReview: 5 },
      secondDraw: () => ({ verified: true, confidence: 0.7 })
    });

    expect(result.comments[0]?.confidence).toBe(0.9); // never raised, kept on agreement
    expect(result.event).toBe("REQUEST_CHANGES");
    expect(result.verdicts).toEqual([expect.objectContaining({ agreed: true, originalConfidence: 0.9, secondConfidence: 0.7 })]);
  });

  it("downgrades confidence and removes REQUEST_CHANGES eligibility on refutation", () => {
    const comments = [comment({ severity: "P0", line: 2, title: "Rollback clobbers state", confidence: 0.9 })];
    const result = runSelfConsistencyRecheck({
      comments,
      files,
      config: { enabled: true, severities: ["P0", "P1"], maxFindingsPerReview: 5 },
      secondDraw: () => ({ verified: false, confidence: 0.2 })
    });

    expect(result.comments[0]?.confidence).toBe(0.2); // min(0.9, 0.2)
    expect(result.comments).toHaveLength(1); // still POSTS as a comment
    expect(result.event).toBe("COMMENT"); // lost eligibility ⇒ quieter
    expect(result.verdicts).toEqual([expect.objectContaining({ agreed: false, refuted: true })]);
  });

  it("never raises confidence even when the second draw is more confident (agreement)", () => {
    const result = runSelfConsistencyRecheck({
      comments: [comment({ severity: "P1", line: 2, title: "Concern", confidence: 0.4 })],
      files,
      config: { enabled: true, maxFindingsPerReview: 5 },
      secondDraw: () => ({ verified: true, confidence: 0.99 })
    });
    expect(result.comments[0]?.confidence).toBe(0.4);
  });

  it("respects the cost bound: 6 eligible findings with max 5 ⇒ 5 calls in ranked order", () => {
    const comments = Array.from({ length: 6 }, (_, i) =>
      comment({ severity: "P0", line: 2 + i, title: `Finding ${i}`, confidence: 0.9 - i * 0.01 })
    );
    const seen: string[] = [];
    const result = runSelfConsistencyRecheck({
      comments,
      files,
      config: { enabled: true, severities: ["P0"], maxFindingsPerReview: 5 },
      secondDraw: (input) => {
        seen.push(input.comment.title);
        return { verified: true, confidence: 0.8 };
      }
    });

    expect(seen).toHaveLength(5);
    // Ranked order = the comment order the gate already produced (highest-confidence first).
    expect(seen).toEqual(["Finding 0", "Finding 1", "Finding 2", "Finding 3", "Finding 4"]);
    expect(result.verdicts).toHaveLength(5);
  });

  it("only re-checks findings at configured severities (default P0/P1)", () => {
    const secondDraw = vi.fn(() => ({ verified: true, confidence: 0.8 }));
    runSelfConsistencyRecheck({
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

  it("leaves a finding untouched when the second draw fails (quieter-only, never blocks)", () => {
    const comments = [comment({ severity: "P0", line: 2, title: "Rollback clobbers state", confidence: 0.9 })];
    const result = runSelfConsistencyRecheck({
      comments,
      files,
      config: { enabled: true, maxFindingsPerReview: 5 },
      secondDraw: () => {
        throw new Error("provider exploded");
      }
    });

    expect(result.comments[0]?.confidence).toBe(0.9);
    expect(result.event).toBe("REQUEST_CHANGES");
    expect(result.verdicts).toEqual([expect.objectContaining({ error: expect.stringContaining("provider exploded") })]);
  });
});
