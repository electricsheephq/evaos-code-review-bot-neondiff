import { describe, expect, it } from "vitest";
import { decideReviewEvent, formatReviewComment, normalizeFindingsForReview, parseFindings } from "../src/findings.js";
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
    expect(result.comments[0]?.body).toContain("Category: Data loss");
    expect(result.dropped.filter((drop) => drop.reason === "comment_cap_exceeded")).toHaveLength(5);
  });

  it("keeps model confidence internal and strips confidence percentages from public inline comments by default", () => {
    const result = normalizeFindingsForReview([
      {
        severity: "P1",
        category: "runtime_correctness",
        path: "src/reviewer.ts",
        line: 12,
        title: "Regression with 99% confidence",
        body: "Confidence: 99%. I am 0.99 confident this branch regresses review output.",
        confidence: 0.99
      }
    ]);

    expect(result.comments).toHaveLength(1);
    expect(result.comments[0]?.title).toBe("Regression with confidence not calibrated");
    expect(result.comments[0]?.body).toContain("Confidence: confidence not calibrated.");
    expect(result.comments[0]?.body).toContain("I am confidence not calibrated this branch regresses review output.");
    expect(result.comments[0]?.title).not.toMatch(/\b\d+(?:\.\d+)?\s*%/);
    expect(result.comments[0]?.body).not.toMatch(/\b\d+(?:\.\d+)?\s*%/);
    expect(result.comments[0]?.body).not.toContain("0.99 confident");
  });

  it("does not re-sanitize already-public review comment text", () => {
    const comment = formatReviewComment(
      {
        severity: "P2",
        category: "runtime_correctness",
        path: "src/reviewer.ts",
        line: 12,
        title: "Regression with confidence not calibrated",
        body: "Confidence: confidence not calibrated.",
        why_this_matters: "Confidence: confidence not calibrated.",
        confidence: 0.99
      },
      undefined,
      { textAlreadySanitized: true }
    );

    expect(comment.match(/confidence not calibrated/g)).toHaveLength(3);
    expect(comment).not.toMatch(/confidence not calibrated confidence not calibrated/);
    expect(comment).not.toMatch(/\b\d+(?:\.\d+)?\s*%/);
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
    expect(decideReviewEvent([{ severity: "P1", category: "proof_gap" }])).toBe("REQUEST_CHANGES");
    expect(decideReviewEvent([{ severity: "P1", category: "docs_only" }])).toBe("REQUEST_CHANGES");
    expect(decideReviewEvent([{ severity: "P1", category: "unknown" }])).toBe("REQUEST_CHANGES");
    expect(decideReviewEvent([{ severity: "P1", category: "data_loss" }])).toBe("REQUEST_CHANGES");
    expect(decideReviewEvent([{ severity: "P0", category: "security_boundary" }])).toBe("REQUEST_CHANGES");
  });

  it("ignores unsupported optional model categories without dropping the finding", () => {
    const parsed = parseFindings({
      findings: [
        {
          severity: "P1",
          category: "correctness",
          path: "src/auth.ts",
          line: 1,
          title: "Session token regression",
          body: "The session token refresh path now returns stale credentials.",
          confidence: 0.8
        }
      ]
    });

    expect(parsed.dropped).toEqual([]);
    expect(parsed.findings).toEqual([
      expect.objectContaining({
        severity: "P1",
        path: "src/auth.ts",
        title: "Session token regression"
      })
    ]);

    const normalized = normalizeFindingsForReview(parsed.findings);
    expect(normalized.comments[0]).toMatchObject({ severity: "P1", category: "auth" });
    expect(decideReviewEvent(normalized.comments)).toBe("REQUEST_CHANGES");
  });

  it("treats model-supplied category as a hint, not the source of truth", () => {
    const result = normalizeFindingsForReview([
      {
        severity: "P0",
        category: "docs_only",
        path: "docs/operator-cli.md",
        line: 2,
        title: "Leaked private key in rollback docs",
        body: "The private key is pasted into the operator rollback instructions.",
        confidence: 0.98
      }
    ]);

    expect(result.comments[0]).toMatchObject({
      severity: "P0",
      category: "security_boundary"
    });
    expect(decideReviewEvent(result.comments)).toBe("REQUEST_CHANGES");
  });
});
