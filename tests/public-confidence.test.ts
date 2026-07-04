import { describe, expect, it } from "vitest";
import {
  buildPublicConfidencePolicy,
  isPublicConfidenceDisplayAllowed,
  sanitizePublicConfidenceText
} from "../src/public-confidence.js";

describe("public confidence display policy", () => {
  it("defaults to uncalibrated wording and removes confidence percentages from public text", () => {
    const output = sanitizePublicConfidenceText("Confidence: 95%. I am 0.92 confident this is a bug.");

    expect(output).toContain("Confidence: confidence not calibrated.");
    expect(output).toContain("I am confidence not calibrated this is a bug.");
    expect(output).not.toMatch(/\b\d+(?:\.\d+)?\s*%/);
    expect(output).not.toContain("0.92 confident");
  });

  it("sanitizes common public confidence bypass phrasings", () => {
    const input = [
      "model confidence 0.95",
      "confidence 0.95",
      "confidence score of 0.95",
      "99 percent confident",
      "95 percent confidence",
      "high confidence (0.95)",
      "certainty: 95%"
    ].join("\n");

    const output = sanitizePublicConfidenceText(input);

    expect(output).not.toContain("0.95");
    expect(output).not.toMatch(/\b\d+(?:\.\d+)?\s*(?:%|percent)\b/i);
    expect(output.match(/confidence not calibrated/g)).toHaveLength(7);
  });

  it("allows public confidence percentages only with explicit calibration evidence", () => {
    const policy = buildPublicConfidencePolicy({
      mode: "calibrated",
      evidenceUrl: " https://github.com/electricsheephq/evaos-code-review-bot/actions/runs/123 ",
      datasetId: " confidence-calibration-v1 ",
      minLabeledFindings: 100,
      labeledFindings: 124,
      p0p1Labels: 31,
      negativeControlScenarios: 10,
      wilsonLowerBound: 0.95
    });

    expect(policy.evidenceUrl).toBe("https://github.com/electricsheephq/evaos-code-review-bot/actions/runs/123");
    expect(policy.datasetId).toBe("confidence-calibration-v1");
    expect(isPublicConfidenceDisplayAllowed(policy)).toBe(true);
    expect(sanitizePublicConfidenceText("Confidence: 95%.", policy)).toBe("Confidence: 95%.");
  });

  it("does not allow percentage display when calibration evidence is blank", () => {
    const policy = buildPublicConfidencePolicy({
      mode: "calibrated",
      evidenceUrl: "   ",
      datasetId: "\t",
      minLabeledFindings: 100,
      labeledFindings: 124,
      p0p1Labels: 31,
      negativeControlScenarios: 10,
      wilsonLowerBound: 0.95
    });

    expect(isPublicConfidenceDisplayAllowed(policy)).toBe(false);
    expect(sanitizePublicConfidenceText("Confidence: 95%.", policy)).toBe("Confidence: confidence not calibrated.");
  });

  it("requires every eval promotion threshold before enabling public percentages", () => {
    const basePolicy = {
      mode: "calibrated" as const,
      evidenceUrl: "https://github.com/electricsheephq/evaos-code-review-bot/actions/runs/123",
      datasetId: "confidence-calibration-v1",
      minLabeledFindings: 100,
      minP0P1Labels: 30,
      minNegativeControlScenarios: 10,
      minWilsonLowerBound: 0.95,
      labeledFindings: 124,
      p0p1Labels: 31,
      negativeControlScenarios: 10,
      wilsonLowerBound: 0.95
    };

    expect(isPublicConfidenceDisplayAllowed(buildPublicConfidencePolicy({ ...basePolicy, labeledFindings: 99 }))).toBe(false);
    expect(isPublicConfidenceDisplayAllowed(buildPublicConfidencePolicy({ ...basePolicy, p0p1Labels: 29 }))).toBe(false);
    expect(isPublicConfidenceDisplayAllowed(buildPublicConfidencePolicy({ ...basePolicy, negativeControlScenarios: 9 }))).toBe(false);
    expect(isPublicConfidenceDisplayAllowed(buildPublicConfidencePolicy({ ...basePolicy, wilsonLowerBound: 0.94 }))).toBe(false);
    expect(isPublicConfidenceDisplayAllowed(buildPublicConfidencePolicy(basePolicy))).toBe(true);
  });
});
