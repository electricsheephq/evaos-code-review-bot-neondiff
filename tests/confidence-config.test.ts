import { describe, expect, it } from "vitest";
import { loadConfigFromObject } from "../src/config.js";

describe("confidence calibration config", () => {
  it("defaults public confidence display to uncalibrated", () => {
    const config = loadConfigFromObject({});

    expect(config.confidenceCalibration).toMatchObject({
      publicDisplay: {
        mode: "uncalibrated",
        minLabeledFindings: 100,
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
          wilsonLowerBound: 0.95,
          minWilsonLowerBound: 0.95
        }
      }
    })).toThrow(/labeledFindings must be >= minLabeledFindings/);
  });
});
