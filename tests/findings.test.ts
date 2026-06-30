import { describe, expect, it } from "vitest";
import { decideReviewEvent, normalizeFindingsForReview } from "../src/findings.js";
import type { Finding } from "../src/types.js";

describe("finding normalization and review policy", () => {
  it("keeps validated findings, caps aggressive inline comments, and sorts by severity", () => {
    const findings: Finding[] = Array.from({ length: 30 }, (_, index) => ({
      severity: index === 29 ? "P0" : index % 2 === 0 ? "P2" : "P3",
      path: "a.ts",
      line: 1,
      title: `Finding ${index}`,
      body: "A concrete review comment.",
      confidence: 0.8
    }));

    const result = normalizeFindingsForReview(findings, { maxInlineComments: 25 });

    expect(result.comments).toHaveLength(25);
    expect(result.comments[0]?.severity).toBe("P0");
    expect(result.dropped.filter((drop) => drop.reason === "comment_cap_exceeded")).toHaveLength(5);
  });

  it("drops any finding whose title or body contains secret-looking material", () => {
    const result = normalizeFindingsForReview([
      {
        severity: "P1",
        path: "a.ts",
        line: 1,
        title: "Leaked token",
        body: "The raw token ghp_1234567890abcdefghijklmnopqrstuvwx should never be posted.",
        confidence: 0.99
      }
    ]);

    expect(result.comments).toEqual([]);
    expect(result.dropped).toEqual([expect.objectContaining({ reason: "secret_detected" })]);
  });

  it("requests changes only for P0 or P1 findings", () => {
    expect(decideReviewEvent([{ severity: "P2" }, { severity: "P3" }])).toBe("COMMENT");
    expect(decideReviewEvent([{ severity: "P1" }])).toBe("REQUEST_CHANGES");
    expect(decideReviewEvent([{ severity: "P0" }])).toBe("REQUEST_CHANGES");
  });
});
