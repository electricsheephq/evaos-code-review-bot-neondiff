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
