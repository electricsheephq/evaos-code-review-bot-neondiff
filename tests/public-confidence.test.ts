import { describe, expect, it } from "vitest";
import {
  buildPublicConfidencePolicy,
  isPublicConfidenceDisplayAllowed,
  sanitizePublicConfidenceText
} from "../src/public-confidence.js";

describe("public confidence display policy", () => {
  it("defaults to uncalibrated wording and removes confidence percentages from public text", () => {
    const output = sanitizePublicConfidenceText("Confidence: 95%. I am 0.92 confident this is a bug.");

    expect(output).toContain("Confidence: uncalibrated.");
    expect(output).toContain("I am uncalibrated confident this is a bug.");
    expect(output).not.toMatch(/\b\d+(?:\.\d+)?\s*%/);
    expect(output).not.toContain("0.92 confident");
  });

  it("allows public confidence percentages only with explicit calibration evidence", () => {
    const policy = buildPublicConfidencePolicy({
      mode: "calibrated",
      evidenceUrl: "https://github.com/electricsheephq/evaos-code-review-bot/actions/runs/123",
      datasetId: "confidence-calibration-v1",
      minLabeledFindings: 100,
      labeledFindings: 124,
      wilsonLowerBound: 0.95
    });

    expect(isPublicConfidenceDisplayAllowed(policy)).toBe(true);
    expect(sanitizePublicConfidenceText("Confidence: 95%.", policy)).toBe("Confidence: 95%.");
  });

  it("does not allow percentage display when calibration evidence is incomplete", () => {
    const policy = buildPublicConfidencePolicy({
      mode: "calibrated",
      evidenceUrl: "https://github.com/electricsheephq/evaos-code-review-bot/actions/runs/123",
      datasetId: "confidence-calibration-v1",
      minLabeledFindings: 100,
      labeledFindings: 99,
      wilsonLowerBound: 0.95
    });

    expect(isPublicConfidenceDisplayAllowed(policy)).toBe(false);
    expect(sanitizePublicConfidenceText("Confidence: 95%.", policy)).toBe("Confidence: uncalibrated.");
  });
});
