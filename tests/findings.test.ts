import { describe, expect, it } from "vitest";
import { decideReviewEvent, formatReviewComment, normalizeFindingsForReview, parseFindings, suppressSameRunNearDuplicates } from "../src/findings.js";
import type { PublicConfidenceDisplayPolicy } from "../src/public-confidence.js";
import type { Finding } from "../src/types.js";

describe("finding normalization and review policy", () => {
  it("orders same-severity findings by confidence and caps the lowest-confidence first", () => {
    const findings: Finding[] = [
      {
        severity: "P2",
        category: "runtime_correctness",
        path: "a.ts",
        line: 1,
        title: "Low confidence concern",
        body: "A concrete review comment.",
        confidence: 0.1
      },
      {
        severity: "P2",
        category: "runtime_correctness",
        path: "a.ts",
        line: 1,
        title: "High confidence concern",
        body: "A concrete review comment.",
        confidence: 0.99
      }
    ];

    const result = normalizeFindingsForReview(findings, { maxInlineComments: 1 });

    expect(result.comments).toHaveLength(1);
    expect(result.comments[0]?.title).toBe("High confidence concern");
    expect(result.comments[0]?.confidence).toBe(0.99);
    expect(result.dropped).toEqual([
      expect.objectContaining({ title: "Low confidence concern", reason: "comment_cap_exceeded" })
    ]);
  });

  it("keeps cross-severity ordering independent of confidence", () => {
    const findings: Finding[] = [
      {
        severity: "P2",
        category: "runtime_correctness",
        path: "a.ts",
        line: 1,
        title: "High confidence low severity",
        body: "A concrete review comment.",
        confidence: 0.99
      },
      {
        severity: "P1",
        category: "runtime_correctness",
        path: "a.ts",
        line: 1,
        title: "Low confidence high severity",
        body: "A concrete review comment.",
        confidence: 0.1
      }
    ];

    const result = normalizeFindingsForReview(findings);

    expect(result.comments[0]?.severity).toBe("P1");
    expect(result.comments[0]?.title).toBe("Low confidence high severity");
    expect(result.comments[1]?.severity).toBe("P2");
  });

  it("carries confidence metadata on review comments without rendering it in the body or title", () => {
    const result = normalizeFindingsForReview([
      {
        severity: "P1",
        category: "runtime_correctness",
        path: "src/reviewer.ts",
        line: 12,
        title: "Regression concern",
        body: "A concrete review comment.",
        confidence: 0.73
      }
    ]);

    expect(result.comments[0]?.confidence).toBe(0.73);
    expect(result.comments[0]?.title).not.toContain("0.73");
    expect(result.comments[0]?.body).not.toContain("0.73");
  });

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
    expect(result.comments[0]?.title).toBe("Regression with [confidence not calibrated]");
    expect(result.comments[0]?.body).toContain("Confidence: [confidence not calibrated].");
    expect(result.comments[0]?.body).toContain("I am [confidence not calibrated] this branch regresses review output.");
    expect(result.comments[0]?.title).not.toMatch(/\b\d+(?:\.\d+)?\s*%/);
    expect(result.comments[0]?.body).not.toMatch(/\b\d+(?:\.\d+)?\s*%/);
    expect(result.comments[0]?.body).not.toContain("0.99 confident");
  });

  it("preserves confidence text when public confidence display is calibrated and eligible", () => {
    const publicConfidencePolicy: PublicConfidenceDisplayPolicy = {
      mode: "calibrated",
      evidenceUrl: "https://github.com/electricsheephq/evaos-code-review-bot/actions/runs/123",
      datasetId: "confidence-calibration-v1",
      minLabeledFindings: 100,
      labeledFindings: 124,
      minP0P1Labels: 30,
      p0p1Labels: 31,
      minNegativeControlScenarios: 10,
      negativeControlScenarios: 10,
      minWilsonLowerBound: 0.95,
      wilsonLowerBound: 0.95
    };
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
    ], { publicConfidencePolicy });

    expect(result.comments[0]?.title).toBe("Regression with 99% confidence");
    expect(result.comments[0]?.body).toContain("Confidence: 99%.");
    expect(result.comments[0]?.body).toContain("I am 0.99 confident this branch regresses review output.");
  });

  it("keeps sanitized review comment titles aligned with rendered body titles for batches", () => {
    const result = normalizeFindingsForReview([
      {
        severity: "P2",
        category: "runtime_correctness",
        path: "src/reviewer.ts",
        line: 12,
        title: "Regression with 99% confidence",
        body: "Confidence: 99%. This branch regresses review output.",
        confidence: 0.99
      },
      {
        severity: "P3",
        category: "proof_gap",
        path: "src/walkthrough.ts",
        line: 44,
        title: "Walkthrough has confidence95%",
        body: "The model was 0.95 confident in this finding.",
        confidence: 0.95
      }
    ]);

    expect(result.comments).toHaveLength(2);
    for (const comment of result.comments) {
      const renderedTitle = comment.body.match(/^\*\*(P\d): (.+)\*\*/)?.[2];

      expect(renderedTitle).toBe(comment.title);
      expect(comment.title).not.toMatch(/\b\d+(?:\.\d+)?\s*(?:%|percent)\b/i);
      expect(comment.body).not.toMatch(/\b\d+(?:\.\d+)?\s*(?:%|percent)\b/i);
    }
  });

  it("sanitizes confidence text from dropped findings before public summaries can reuse them", () => {
    const findings: Finding[] = [
      {
        severity: "P2",
        category: "runtime_correctness",
        path: "src/reviewer.ts",
        line: 12,
        title: "Kept finding",
        body: "A concrete review comment.",
        confidence: 0.8
      },
      {
        severity: "P3",
        category: "proof_gap",
        path: "src/reviewer.ts",
        line: 13,
        title: "Dropped with 99% confidence",
        body: "Confidence: 99%. This should be capped.",
        why_this_matters: "The model was 0.99 confident.",
        confidence: 0.99
      }
    ];

    const result = normalizeFindingsForReview(findings, { maxInlineComments: 1 });

    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0]).toMatchObject({
      reason: "comment_cap_exceeded",
      title: "Dropped with [confidence not calibrated]"
    });
    expect(result.dropped[0]?.body).toBe("Confidence: [confidence not calibrated]. This should be capped.");
    expect(result.dropped[0]?.why_this_matters).toBe("The model was [confidence not calibrated].");
    expect(JSON.stringify(result.dropped)).not.toMatch(/\b\d+(?:\.\d+)?\s*(?:%|percent)\b/i);
    expect(JSON.stringify(result.dropped)).not.toContain("0.99 confident");
  });

  it("does not re-sanitize already-public review comment text", () => {
    const comment = formatReviewComment(
      {
        severity: "P2",
        category: "runtime_correctness",
        path: "src/reviewer.ts",
        line: 12,
        title: "Regression with [confidence not calibrated]",
        body: "Confidence: [confidence not calibrated].",
        why_this_matters: "Confidence: [confidence not calibrated].",
        confidence: 0.99
      },
      undefined,
      { textAlreadySanitized: true }
    );

    expect(comment.match(/confidence not calibrated/g)).toHaveLength(3);
    expect(comment).not.toMatch(/confidence not calibrated confidence not calibrated/);
    expect(comment).not.toMatch(/\b\d+(?:\.\d+)?\s*%/);
  });

  it("renders only known severity labels in public review comment headers", () => {
    const comment = formatReviewComment({
      severity: "P1**\n\nraw severity injection" as Finding["severity"],
      category: "runtime_correctness",
      path: "src/reviewer.ts",
      line: 12,
      title: "Regression title",
      body: "A concrete review comment.",
      confidence: 0.99
    });

    expect(comment.startsWith("**P3: Regression title**")).toBe(true);
    expect(comment).not.toContain("raw severity injection");
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

  it("sanitizes confidence text from secret-dropped findings after redaction", () => {
    const token = ["ghp", "1234567890abcdefghijklmnopqrstuvwx"].join("_");
    const result = normalizeFindingsForReview([
      {
        severity: "P1",
        category: "security_boundary",
        path: "a.ts",
        line: 1,
        title: "Leaked token with 99% confidence",
        body: `Confidence: 99%. The raw token ${token} should never be posted.`,
        confidence: 0.99
      }
    ]);

    expect(result.comments).toEqual([]);
    expect(result.dropped).toEqual([expect.objectContaining({ reason: "secret_detected" })]);
    expect(JSON.stringify(result.dropped)).not.toContain(token);
    expect(JSON.stringify(result.dropped)).not.toContain("99%");
    expect(JSON.stringify(result.dropped)).toContain("confidence not calibrated");
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
    expect(decideReviewEvent([{ severity: "P2", category: "data_loss", confidence: 0.9 }, { severity: "P3", category: "auth", confidence: 0.9 }])).toBe("COMMENT");
    expect(decideReviewEvent([{ severity: "P1", category: "proof_gap", confidence: 0.9 }])).toBe("COMMENT");
    expect(decideReviewEvent([{ severity: "P1", category: "docs_only", confidence: 0.9 }])).toBe("COMMENT");
    expect(decideReviewEvent([{ severity: "P1", category: "flaky_test_risk", confidence: 0.9 }])).toBe("REQUEST_CHANGES");
    expect(decideReviewEvent([{ severity: "P1", category: "dependency", confidence: 0.9 }])).toBe("REQUEST_CHANGES");
    expect(decideReviewEvent([{ severity: "P1", category: "unknown", confidence: 0.9 }])).toBe("REQUEST_CHANGES");
    expect(decideReviewEvent([{ severity: "P1", category: "data_loss", confidence: 0.9 }])).toBe("REQUEST_CHANGES");
    expect(decideReviewEvent([{ severity: "P0", category: "security_boundary", confidence: 0.9 }])).toBe("REQUEST_CHANGES");
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

describe("same-run near-duplicate suppression (#281)", () => {
  function base(overrides: Partial<Finding> & Pick<Finding, "path" | "line" | "title">): Finding {
    return {
      severity: "P1",
      category: "runtime_correctness",
      body: "A concrete review comment.",
      confidence: 0.8,
      ...overrides
    };
  }

  it("drops a near-duplicate on an adjacent line and keeps the higher-confidence member", () => {
    const findings: Finding[] = [
      base({ path: "src/save.ts", line: 42, title: "Rollback clobbers fresh state", confidence: 0.95 }),
      base({ path: "src/save.ts", line: 44, title: "rollback clobbers fresh state!", confidence: 0.6 })
    ];

    const kept = suppressSameRunNearDuplicates(findings);

    expect(kept.kept).toHaveLength(1);
    expect(kept.kept[0]?.confidence).toBe(0.95);
    // The pure helper returns the raw dropped finding; the caller attaches the reason (see the
    // cap-interaction test for the reason on the normalizeFindingsForReview dropped[] output).
    expect(kept.dropped).toEqual([expect.objectContaining({ line: 44, confidence: 0.6 })]);
  });

  it("keeps both when the line delta exceeds the window", () => {
    const findings: Finding[] = [
      base({ path: "src/save.ts", line: 10, title: "Rollback clobbers fresh state" }),
      base({ path: "src/save.ts", line: 40, title: "Rollback clobbers fresh state" })
    ];

    const kept = suppressSameRunNearDuplicates(findings);

    expect(kept.kept).toHaveLength(2);
    expect(kept.dropped).toEqual([]);
  });

  it("keeps both when categories differ on adjacent lines", () => {
    const findings: Finding[] = [
      base({ path: "src/save.ts", line: 42, title: "Rollback clobbers fresh state", category: "runtime_correctness" }),
      base({ path: "src/save.ts", line: 43, title: "Rollback clobbers fresh state", category: "data_loss" })
    ];

    const kept = suppressSameRunNearDuplicates(findings);

    expect(kept.kept).toHaveLength(2);
    expect(kept.dropped).toEqual([]);
  });

  it("keeps both when the same title appears on different paths", () => {
    const findings: Finding[] = [
      base({ path: "src/save.ts", line: 42, title: "Rollback clobbers fresh state" }),
      base({ path: "src/load.ts", line: 42, title: "Rollback clobbers fresh state" })
    ];

    const kept = suppressSameRunNearDuplicates(findings);

    expect(kept.kept).toHaveLength(2);
    expect(kept.dropped).toEqual([]);
  });

  it("treats a normalized-title prefix as a duplicate but not a short prefix under 12 chars", () => {
    const prefixDup: Finding[] = [
      base({ path: "src/save.ts", line: 42, title: "Race in save path" }),
      base({ path: "src/save.ts", line: 43, title: "Race in save path corrupts state on retry" })
    ];
    const shortPrefix: Finding[] = [
      base({ path: "src/save.ts", line: 42, title: "Bad flag" }),
      base({ path: "src/save.ts", line: 43, title: "Bad flag breaks retry accounting entirely" })
    ];

    expect(suppressSameRunNearDuplicates(prefixDup).kept).toHaveLength(1);
    expect(suppressSameRunNearDuplicates(shortPrefix).kept).toHaveLength(2);
  });

  it("runs before the cap so a freed slot lets the distinct pair post (cap interaction)", () => {
    const findings: Finding[] = [
      base({ path: "src/save.ts", line: 42, title: "Rollback clobbers fresh state", confidence: 0.95 }),
      base({ path: "src/save.ts", line: 43, title: "rollback clobbers fresh state", confidence: 0.6 }),
      base({ path: "src/load.ts", line: 5, title: "Distinct unrelated concern", confidence: 0.9 })
    ];

    const result = normalizeFindingsForReview(findings, { maxInlineComments: 2 });

    expect(result.comments).toHaveLength(2);
    const titles = result.comments.map((comment) => comment.title);
    expect(titles).toContain("Rollback clobbers fresh state");
    expect(titles).toContain("Distinct unrelated concern");
    expect(result.dropped).toEqual([
      expect.objectContaining({ line: 43, reason: "same_run_near_duplicate" })
    ]);
  });

  it("redacts a secret-containing dropped duplicate that reaches dropped[]", () => {
    const token = ["ghp", "1234567890abcdefghijklmnopqrstuvwx"].join("_");
    const findings: Finding[] = [
      base({ path: "src/save.ts", line: 42, title: "Rollback clobbers fresh state", confidence: 0.95 }),
      base({
        path: "src/save.ts",
        line: 43,
        title: "Rollback clobbers fresh state",
        body: `Duplicate concern; raw token ${token} leaked here.`,
        confidence: 0.6
      })
    ];

    const result = normalizeFindingsForReview(findings);

    // A duplicate whose body contains a secret is dropped by the secret filter first (never reaches
    // dedup). Asserting the explicit secret_detected reason makes that ordering invariant loud: if
    // the pipeline were ever reordered so dedup ran first, the reason would flip to
    // same_run_near_duplicate and this test would fail instead of silently passing.
    expect(result.comments).toHaveLength(1);
    expect(result.comments[0]?.title).toBe("Rollback clobbers fresh state");
    expect(result.dropped).toEqual([expect.objectContaining({ line: 43, reason: "secret_detected" })]);
    expect(JSON.stringify(result.dropped)).not.toContain(token);
  });
});
