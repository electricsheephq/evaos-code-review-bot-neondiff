import { describe, expect, it } from "vitest";
import { loadConfigFromObject } from "../src/config.js";

describe("confidence calibration config", () => {
  it("defaults public confidence display to uncalibrated", () => {
    const config = loadConfigFromObject({});

    expect(config.confidenceCalibration).toMatchObject({
      publicDisplay: {
        mode: "uncalibrated",
        minLabeledFindings: 100,
        minP0P1Labels: 30,
        minNegativeControlScenarios: 10,
        minWilsonLowerBound: 0.95
      }
    });
  });

  it("fills default public display floors for partial confidence calibration config", () => {
    const config = loadConfigFromObject({
      confidenceCalibration: {
        publicDisplay: {
          mode: "uncalibrated"
        }
      }
    });

    expect(config.confidenceCalibration?.publicDisplay).toMatchObject({
      mode: "uncalibrated",
      minLabeledFindings: 100,
      minP0P1Labels: 30,
      minNegativeControlScenarios: 10,
      minWilsonLowerBound: 0.95
    });
  });

  it("rejects non-object public display config before defaulting", () => {
    expect(() => loadConfigFromObject({
      confidenceCalibration: "calibrated" as unknown as Record<string, unknown>
    })).toThrow(/confidenceCalibration must be an object/);

    expect(() => loadConfigFromObject({
      confidenceCalibration: {
        publicDisplay: "calibrated" as unknown as Record<string, unknown>
      }
    })).toThrow(/publicDisplay must be an object/);
  });

  it("requires calibration evidence before public confidence display can be enabled", () => {
    expect(() => loadConfigFromObject({
      confidenceCalibration: {
        publicDisplay: {
          mode: "calibrated",
          evidenceUrl: "https://github.com/electricsheephq/evaos-code-review-bot/actions/runs/123",
          datasetId: "confidence-calibration-v1",
          labeledFindings: 99,
          minLabeledFindings: 100,
          p0p1Labels: 30,
          minP0P1Labels: 30,
          negativeControlScenarios: 10,
          minNegativeControlScenarios: 10,
          wilsonLowerBound: 0.95,
          minWilsonLowerBound: 0.95
        }
      }
    })).toThrow(/labeledFindings must be >= minLabeledFindings/);
  });

  it("requires P0/P1 labels and negative controls before public confidence display can be enabled", () => {
    const base = {
      mode: "calibrated" as const,
      evidenceUrl: "https://github.com/electricsheephq/evaos-code-review-bot/actions/runs/123",
      datasetId: "confidence-calibration-v1",
      labeledFindings: 100,
      minLabeledFindings: 100,
      p0p1Labels: 30,
      minP0P1Labels: 30,
      negativeControlScenarios: 10,
      minNegativeControlScenarios: 10,
      wilsonLowerBound: 0.95,
      minWilsonLowerBound: 0.95
    };

    expect(() => loadConfigFromObject({
      confidenceCalibration: { publicDisplay: { ...base, p0p1Labels: 29 } }
    })).toThrow(/p0p1Labels must be >= minP0P1Labels/);
    expect(() => loadConfigFromObject({
      confidenceCalibration: { publicDisplay: { ...base, negativeControlScenarios: 9 } }
    })).toThrow(/negativeControlScenarios must be >= minNegativeControlScenarios/);
  });

  it("rejects calibration configs that loosen hard public promotion floors", () => {
    const base = calibratedPublicDisplay();

    expect(() => loadConfigFromObject({
      confidenceCalibration: { publicDisplay: { ...base, minLabeledFindings: 99 } }
    })).toThrow(/minLabeledFindings must be >= 100/);
    expect(() => loadConfigFromObject({
      confidenceCalibration: { publicDisplay: { ...base, minP0P1Labels: 29 } }
    })).toThrow(/minP0P1Labels must be >= 30/);
    expect(() => loadConfigFromObject({
      confidenceCalibration: { publicDisplay: { ...base, minNegativeControlScenarios: 9 } }
    })).toThrow(/minNegativeControlScenarios must be >= 10/);
    expect(() => loadConfigFromObject({
      confidenceCalibration: { publicDisplay: { ...base, minWilsonLowerBound: 0.94 } }
    })).toThrow(/minWilsonLowerBound must be >= 0.95/);
  });

  it("requires calibrated evidence URLs to be usable https URLs", () => {
    const base = calibratedPublicDisplay();

    expect(() => loadConfigFromObject({
      confidenceCalibration: { publicDisplay: { ...base, evidenceUrl: "todo" } }
    })).toThrow(/evidenceUrl must be an https URL/);
    expect(() => loadConfigFromObject({
      confidenceCalibration: { publicDisplay: { ...base, evidenceUrl: "javascript:alert(1)" } }
    })).toThrow(/evidenceUrl must be an https URL/);
    expect(() => loadConfigFromObject({
      confidenceCalibration: { publicDisplay: { ...base, evidenceUrl: "http://github.com/electricsheephq/evaos-code-review-bot/actions/runs/123" } }
    })).toThrow(/evidenceUrl must be an https URL/);
  });
});

describe("review gate config", () => {
  it("defaults review gate to the built-in inline comment cap without confidence floors", () => {
    const config = loadConfigFromObject({});

    expect(config.reviewGate).toMatchObject({ maxInlineComments: 25 });
    expect(config.reviewGate?.requestChangesConfidenceFloors).toBeUndefined();
  });

  it("accepts an explicit inline comment cap and per-severity confidence floors", () => {
    const config = loadConfigFromObject({
      reviewGate: {
        maxInlineComments: 10,
        requestChangesConfidenceFloors: { P0: 0.8, P1: 0.6 }
      }
    });

    expect(config.reviewGate).toMatchObject({
      maxInlineComments: 10,
      requestChangesConfidenceFloors: { P0: 0.8, P1: 0.6 }
    });
  });

  it("rejects a non-positive-integer inline comment cap", () => {
    expect(() => loadConfigFromObject({ reviewGate: { maxInlineComments: 0 } })).toThrow(
      /reviewGate\.maxInlineComments must be a positive integer/
    );
    expect(() => loadConfigFromObject({ reviewGate: { maxInlineComments: 2.5 } })).toThrow(
      /reviewGate\.maxInlineComments must be a positive integer/
    );
  });

  it("defaults retryDegradedConfidencePenalty to unset (off) and accepts a valid penalty (#304)", () => {
    expect(loadConfigFromObject({}).reviewGate?.retryDegradedConfidencePenalty).toBeUndefined();
    expect(
      loadConfigFromObject({ reviewGate: { retryDegradedConfidencePenalty: 0.2 } }).reviewGate?.retryDegradedConfidencePenalty
    ).toBe(0.2);
  });

  it("rejects an out-of-range or non-number retryDegradedConfidencePenalty (#304)", () => {
    expect(() => loadConfigFromObject({ reviewGate: { retryDegradedConfidencePenalty: -0.1 } })).toThrow(
      /reviewGate\.retryDegradedConfidencePenalty must be a number from 0 to 1/
    );
    expect(() => loadConfigFromObject({ reviewGate: { retryDegradedConfidencePenalty: 1.5 } })).toThrow(
      /reviewGate\.retryDegradedConfidencePenalty must be a number from 0 to 1/
    );
    expect(() =>
      loadConfigFromObject({ reviewGate: { retryDegradedConfidencePenalty: "high" as unknown as number } })
    ).toThrow(/reviewGate\.retryDegradedConfidencePenalty must be a number from 0 to 1/);
  });

  it("defaults selfConsistency to unset (off) and accepts a full valid config (#303)", () => {
    expect(loadConfigFromObject({}).reviewGate?.selfConsistency).toBeUndefined();
    const config = loadConfigFromObject({
      reviewGate: { selfConsistency: { enabled: true, severities: ["P0"], provider: "zcode-glm", maxFindingsPerReview: 3 } }
    });
    expect(config.reviewGate?.selfConsistency).toEqual({
      enabled: true,
      severities: ["P0"],
      provider: "zcode-glm",
      maxFindingsPerReview: 3
    });
  });

  it("fails closed on malformed selfConsistency fields (#303)", () => {
    expect(() => loadConfigFromObject({ reviewGate: { selfConsistency: { enabled: "yes" } } })).toThrow(
      /reviewGate\.selfConsistency\.enabled must be a boolean/
    );
    expect(() => loadConfigFromObject({ reviewGate: { selfConsistency: { enabled: true, maxFindingsPerReview: 0 } } })).toThrow(
      /reviewGate\.selfConsistency\.maxFindingsPerReview must be a positive integer/
    );
    expect(() => loadConfigFromObject({ reviewGate: { selfConsistency: { enabled: true, severities: ["P2"] } } })).toThrow(
      /reviewGate\.selfConsistency\.severities.* P0 or P1/
    );
    expect(() => loadConfigFromObject({ reviewGate: { selfConsistency: { enabled: true, provider: 42 } } })).toThrow(
      /reviewGate\.selfConsistency\.provider must be a string/
    );
  });

  it("rejects unknown keys in the confidence floors map", () => {
    expect(() =>
      loadConfigFromObject({ reviewGate: { requestChangesConfidenceFloors: { p0: 0.8 } } })
    ).toThrow(/reviewGate\.requestChangesConfidenceFloors has unknown key "p0"; expected only P0 or P1/);
    expect(() =>
      loadConfigFromObject({ reviewGate: { requestChangesConfidenceFloors: { P2: 0.5 } } })
    ).toThrow(/reviewGate\.requestChangesConfidenceFloors has unknown key "P2"; expected only P0 or P1/);
  });

  it("rejects out-of-range or non-number confidence floors", () => {
    expect(() =>
      loadConfigFromObject({ reviewGate: { requestChangesConfidenceFloors: { P0: -0.1 } } })
    ).toThrow(/reviewGate\.requestChangesConfidenceFloors\.P0 must be a number from 0 to 1/);
    expect(() =>
      loadConfigFromObject({ reviewGate: { requestChangesConfidenceFloors: { P1: 1.5 } } })
    ).toThrow(/reviewGate\.requestChangesConfidenceFloors\.P1 must be a number from 0 to 1/);
    expect(() =>
      loadConfigFromObject({
        reviewGate: { requestChangesConfidenceFloors: { P0: "high" as unknown as number } }
      })
    ).toThrow(/reviewGate\.requestChangesConfidenceFloors\.P0 must be a number from 0 to 1/);
  });
});

function calibratedPublicDisplay() {
  return {
    mode: "calibrated" as const,
    evidenceUrl: "https://github.com/electricsheephq/evaos-code-review-bot/actions/runs/123",
    datasetId: "confidence-calibration-v1",
    labeledFindings: 100,
    minLabeledFindings: 100,
    p0p1Labels: 30,
    minP0P1Labels: 30,
    negativeControlScenarios: 10,
    minNegativeControlScenarios: 10,
    wilsonLowerBound: 0.95,
    minWilsonLowerBound: 0.95
  };
}
