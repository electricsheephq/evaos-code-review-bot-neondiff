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
});
