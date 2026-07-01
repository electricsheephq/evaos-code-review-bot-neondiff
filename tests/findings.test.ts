import { describe, expect, it } from "vitest";
import { decideReviewEvent, normalizeFindingsForReview, parseFindings } from "../src/findings.js";
import type { Finding } from "../src/types.js";

describe("finding normalization and review policy", () => {
  it("keeps validated findings, caps aggressive inline comments, and sorts by severity", () => {
    const findings: Finding[] = Array.from({ length: 30 }, (_, index) => ({
      severity: index === 29 ? "P0" : index % 2 === 0 ? "P2" : "P3",
      category: index === 29 ? "data_loss" : "runtime_correctness",
      path: "a.ts",
      line: 1,
      title: `Finding ${index}`,
      body: "A concrete review comment.",
      confidence: 0.8
    }));

    const result = normalizeFindingsForReview(findings, { maxInlineComments: 25 });

    expect(result.comments).toHaveLength(25);
    expect(result.comments[0]?.severity).toBe("P0");
    expect(result.comments[0]?.category).toBe("data_loss");
    expect(result.dropped.filter((drop) => drop.reason === "comment_cap_exceeded")).toHaveLength(5);
  });

  it("drops any finding whose title or body contains secret-looking material", () => {
    const token = ["ghp", "1234567890abcdefghijklmnopqrstuvwx"].join("_");
    const result = normalizeFindingsForReview([
      {
        severity: "P1",
        category: "security_boundary",
        path: "a.ts",
        line: 1,
        title: "Leaked token",
        body: `The raw token ${token} should never be posted.`,
        confidence: 0.99
      }
    ]);

    expect(result.comments).toEqual([]);
    expect(result.dropped).toEqual([expect.objectContaining({ reason: "secret_detected" })]);
    expect(JSON.stringify(result.dropped)).not.toContain(token);
  });

  it("drops findings that repeat hyphenated fixture tokens", () => {
    const fixtureToken = ["super", "secret", "token"].join("-");
    const result = normalizeFindingsForReview([
      {
        severity: "P1",
        category: "security_boundary",
        path: "scripts/check-public-sensitive-content.js",
        line: 64,
        title: "Scanner self-trip",
        body: `The scanner repeats ${fixtureToken} in its own source.`,
        confidence: 0.9
      }
    ]);

    expect(result.comments).toEqual([]);
    expect(result.dropped).toEqual([expect.objectContaining({ reason: "secret_detected" })]);
    expect(JSON.stringify(result.dropped)).not.toContain(fixtureToken);
  });

  it("requests changes only for P0 or P1 findings in eligible regression categories", () => {
    expect(decideReviewEvent([{ severity: "P2", category: "data_loss" }, { severity: "P3", category: "auth" }])).toBe("COMMENT");
    expect(decideReviewEvent([{ severity: "P1", category: "proof_gap" }])).toBe("COMMENT");
    expect(decideReviewEvent([{ severity: "P1", category: "docs_only" }])).toBe("COMMENT");
    expect(decideReviewEvent([{ severity: "P1", category: "unknown" }])).toBe("REQUEST_CHANGES");
    expect(decideReviewEvent([{ severity: "P1", category: "data_loss" }])).toBe("REQUEST_CHANGES");
    expect(decideReviewEvent([{ severity: "P0", category: "security_boundary" }])).toBe("REQUEST_CHANGES");
  });

  it("drops unsupported model categories at schema parse time", () => {
    const parsed = parseFindings({
      findings: [
        {
          severity: "P1",
          category: "nitpick",
          path: "a.ts",
          line: 1,
          title: "Bad category",
          body: "This category is not in the deterministic taxonomy.",
          confidence: 0.8
        }
      ]
    });

    expect(parsed.findings).toEqual([]);
    expect(parsed.dropped).toEqual([{ reason: "invalid_schema" }]);
  });
});
