import { describe, expect, it } from "vitest";
import { applyDeterministicReviewGate } from "../src/review-gate.js";
import type { Finding, PullFilePatch } from "../src/types.js";

/**
 * Evidence fixture for issue #349 (gate policy evaluation): categoryPrecisionFloors (#286 Part C)
 * is exercised at the `applyDeterministicReviewGate` end-to-end level. Config-shape validation
 * (unknown-category rejection, unset default) is already covered by
 * tests/confidence-config.test.ts; this file closes the gap at the gate-behavior level — the same
 * altitude as the existing requestChangesConfidenceFloors tests in tests/review-gate.test.ts.
 */
describe("categoryPrecisionFloors gate behavior (#286 Part C)", () => {
  const files: PullFilePatch[] = [
    {
      filename: "src/save.ts",
      patch: "@@ -1,2 +1,3 @@\n export function save() {\n+  overwriteAllData();\n }"
    }
  ];

  function findingAt(confidence: number): Finding {
    return {
      severity: "P0",
      category: "data_loss",
      path: "src/save.ts",
      line: 2,
      title: "Rollback can clobber fresh state",
      body: "The added call can overwrite newer data after a failed save.",
      confidence
    };
  }

  it("is byte-identical to an omitted categoryPrecisionFloors when unset (no floor configured)", () => {
    const withoutKey = applyDeterministicReviewGate({ findings: [findingAt(0.5)], files });
    const withUndefinedFloors = applyDeterministicReviewGate({
      findings: [findingAt(0.5)],
      files,
      categoryPrecisionFloors: undefined
    });

    expect(withUndefinedFloors).toEqual(withoutKey);
    expect(withoutKey.event).toBe("REQUEST_CHANGES");
    expect(withoutKey.summary.requestChangesEligible).toBe(1);
  });

  it("demotes a below-floor category finding out of REQUEST_CHANGES eligibility but still posts it as a comment", () => {
    const gate = applyDeterministicReviewGate({
      findings: [findingAt(0.5)],
      files,
      categoryPrecisionFloors: { data_loss: 0.8 }
    });

    expect(gate.event).toBe("COMMENT");
    expect(gate.comments).toHaveLength(1);
    expect(gate.comments[0]).toMatchObject({ category: "data_loss", severity: "P0", line: 2 });
    expect(gate.summary.requestChangesEligible).toBe(0);
    expect(gate.summary.acceptedComments).toBe(1);
  });

  it("keeps an at-or-above-floor category finding REQUEST_CHANGES-eligible (floor is inclusive)", () => {
    const atFloor = applyDeterministicReviewGate({
      findings: [findingAt(0.8)],
      files,
      categoryPrecisionFloors: { data_loss: 0.8 }
    });
    expect(atFloor.event).toBe("REQUEST_CHANGES");
    expect(atFloor.summary.requestChangesEligible).toBe(1);

    const aboveFloor = applyDeterministicReviewGate({
      findings: [findingAt(0.95)],
      files,
      categoryPrecisionFloors: { data_loss: 0.8 }
    });
    expect(aboveFloor.event).toBe("REQUEST_CHANGES");
    expect(aboveFloor.summary.requestChangesEligible).toBe(1);
  });

  it("a floor of 0 never demotes, regardless of how low confidence is", () => {
    const gate = applyDeterministicReviewGate({
      findings: [findingAt(0.01)],
      files,
      categoryPrecisionFloors: { data_loss: 0 }
    });

    expect(gate.event).toBe("REQUEST_CHANGES");
    expect(gate.summary.requestChangesEligible).toBe(1);
  });

  it("only demotes findings whose category is listed; an unlisted category is unaffected", () => {
    const authFinding: Finding = {
      severity: "P0",
      category: "auth",
      path: "src/save.ts",
      line: 2,
      title: "Session token regression",
      body: "The session token refresh returns stale credentials.",
      confidence: 0.3
    };

    const gate = applyDeterministicReviewGate({
      findings: [authFinding],
      files,
      categoryPrecisionFloors: { data_loss: 0.9 } // only data_loss is floored; auth is untouched
    });

    expect(gate.event).toBe("REQUEST_CHANGES");
    expect(gate.summary.requestChangesEligible).toBe(1);
  });

  it("never escalates: a category floor cannot raise confidence, add REQUEST_CHANGES eligibility beyond the model finding, or add a finding", () => {
    // Two distinct findings (different line/title, so same-run dedup doesn't collapse them): one
    // already eligible, one already ineligible on severity grounds (P2). A categoryPrecisionFloors
    // config can only ever subtract eligibility, never grant it, and never fabricates additional
    // comments beyond what normalizeFindingsForReview produced.
    const eligible = findingAt(0.95);
    const lowSeverity: Finding = { ...findingAt(0.95), severity: "P2", line: 3, title: "Unrelated low-severity nit" };

    const gate = applyDeterministicReviewGate({
      findings: [eligible, lowSeverity],
      files,
      categoryPrecisionFloors: { data_loss: 0 } // most permissive floor possible
    });

    expect(gate.comments).toHaveLength(2); // no findings fabricated or dropped by the floor itself
    expect(gate.summary.requestChangesEligible).toBe(1); // the P2 finding never becomes RC-eligible
  });
});
