import { describe, expect, it } from "vitest";
import {
  buildPublicConfidencePolicy,
  isPublicConfidenceDisplayAllowed,
  sanitizePublicConfidenceText
} from "../src/public-confidence.js";

describe("public confidence display policy", () => {
  it("defaults to uncalibrated wording and removes confidence percentages from public text", () => {
    const output = sanitizePublicConfidenceText("Confidence: 95%. I am 0.92 confident this is a bug.");

    expect(output).toContain("Confidence: [confidence not calibrated].");
    expect(output).toContain("I am [confidence not calibrated] this is a bug.");
    expect(output).not.toMatch(/\b\d+(?:\.\d+)?\s*%/);
    expect(output).not.toContain("0.92 confident");
  });

  it("sanitizes common public confidence bypass phrasings", () => {
    const input = [
      "model confidence 0.95",
      "confidence 0.95",
      "confidence score of 0.95",
      "confidence score: 0.95",
      "confidence score = 95%",
      "confidence score=95%",
      "confidence is 0.95",
      "confidence was 95%",
      "confidence at 95%",
      "confidence in 0.95",
      "0.95 in confidence",
      "model confidence in 0.95",
      "X confidence in 0.95",
      "99 percent confident",
      "95 percent confidence",
      "I have 0.95 confidence in this",
      "high confidence (0.95)",
      "certainty: 95%",
      "reliability: 95%",
      "sure: 99%",
      "99% reliable",
      "0.95confident",
      "`0.95confident`",
      "0.95reliable",
      "confidence95%",
      "confidence-95%",
      "confidence_score-95%"
    ].join("\n");

    const output = sanitizePublicConfidenceText(input);

    expect(output).not.toContain("0.95");
    expect(output).not.toContain("0.95confident");
    expect(output).not.toContain("`0.95confident`");
    expect(output).not.toContain("0.95reliable");
    expect(output).not.toContain("0.95 in confidence");
    expect(output).not.toContain("confidence95%");
    expect(output).not.toMatch(/\b\d+(?:\.\d+)?\s*(?:%|percent)\b/i);
    expect(output).toContain("confidence not calibrated");
    for (const token of ["99%", "95%", "99 percent", "95 percent"]) {
      expect(output).not.toContain(token);
    }
  });

  it("redacts residual confidence values near confidence nouns as a final safety pass", () => {
    const input = [
      "Reliability after the model pass lands near 0.95 even though phrased oddly.",
      "Confidence after all that prose eventually sits around 95%.",
      "Reviewer certainty after manual labeling sits near 0.91."
    ].join("\n");
    const output = sanitizePublicConfidenceText(input);

    expect(output).toContain("confidence not calibrated");
    expect(output).not.toContain("95 percent");
    expect(output).not.toContain("0.95");
    expect(output).not.toContain("95%");
    expect(output).not.toContain("0.91");
  });

  it("preserves ordinary numeric values near common reliability wording", () => {
    const input = [
      "Make sure the lock timeout of 0.5 s is reliable.",
      "A reliable retry backoff of 0.75 seconds avoids churn.",
      "This path is 100 percent deterministic and reliable in the fixture."
    ].join("\n");

    expect(sanitizePublicConfidenceText(input)).toBe(input);
  });

  it("preserves technical accuracy and likelihood prose that is not a review confidence claim", () => {
    const input = [
      "classification accuracy 0.92 on the eval set remains relevant.",
      "recall/precision accuracy 0.88 should not be rewritten.",
      "mutation likelihood 0.5 per generation is part of the simulation.",
      "This matches with 90% likelihood against the baseline.",
      "A follow-up is 0.91 likely after the migration lands."
    ].join("\n");

    expect(sanitizePublicConfidenceText(input)).toBe(input);
  });

  it("renders mid-sentence confidence labels as clean prose without leaking the value", () => {
    const output = sanitizePublicConfidenceText("The model confidence: 0.95 is the only signal we have.");

    expect(output).toBe("The model [confidence not calibrated]; it is the only signal we have.");
    expect(output).not.toContain("0.95");
    expect(output).not.toContain("confidence: [confidence not calibrated] is");
  });

  it("normalizes non-confidence label continuations to confidence wording", () => {
    const output = sanitizePublicConfidenceText("The model certainty: 0.95 is the only signal we have.");

    expect(output).toBe("The model [confidence not calibrated]; it is the only signal we have.");
    expect(output).not.toContain("certainty is not calibrated");
    expect(output).not.toContain("0.95");
  });

  it("sanitizes markdown and inline-code wrapped confidence tokens from review bodies", () => {
    const input = [
      "**Confidence**: `95%` that this is exploitable.",
      "- `0.92` confident this regression is real.",
      "- `95%` reliable after model judgment.",
      "Body says **99 percent confidence** after the model pass.",
      "Why this matters: `95% confident` claims are not public calibration evidence."
    ].join("\n");

    const output = sanitizePublicConfidenceText(input);

    expect(output).toContain("[confidence not calibrated]; this is exploitable.");
    expect(output).not.toMatch(/\b\d+(?:\.\d+)?\s*(?:%|percent)\b/i);
    expect(output).not.toContain("0.92");
    expect(output).not.toContain("`95%` reliable");
    expect(output).not.toContain("95% confident");
  });

  it("does not corrupt unrelated confidence interval or threshold decimals", () => {
    const output = sanitizePublicConfidenceText([
      "The confidence interval at 0.95 remains statistically meaningful.",
      "Reviewer confidence threshold 0.95 was met by 12 findings."
    ].join("\n"));

    expect(output).toContain("confidence interval at 0.95");
    expect(output).toContain("confidence threshold 0.95");
    expect(output).not.toContain("confidence not calibrated");
  });

  it("redacts ambiguous statistical confidence phrasing unless explicitly carved out", () => {
    const output = sanitizePublicConfidenceText([
      "The confidence level 0.95 should not be public before calibration.",
      "Bayesian confidence posterior 0.91 is ambiguous in review prose."
    ].join("\n"));

    expect(output).not.toContain("confidence level 0.95");
    expect(output).not.toContain("posterior 0.91");
    expect(output).toContain("confidence not calibrated");
  });

  it("preserves version-like decimals and metric percentages near confidence context", () => {
    const input = [
      "Reliability improved after upgrading dependency 1.0.5.",
      "Confidence calibration target met; precision held at 95% on the eval set.",
      "Confidence calibration target met; recall held at 94 percent on the eval set.",
      "Confidence calibration target met; accuracy held at 0.97 on the eval set."
    ].join("\n");

    expect(sanitizePublicConfidenceText(input)).toBe(input);
  });

  it("bounds pathological input before sanitizing", () => {
    const output = sanitizePublicConfidenceText(`${"safe prose ".repeat(20_000)} Confidence: 95%.`);

    expect(output).toContain("[truncated before public confidence sanitization]");
    expect(output).not.toContain("95%");
    expect(output.length).toBeLessThan(129_000);
  });

  it("leaves marker-free oversized input on the bounded prefilter path", () => {
    const input = `${"safe prose ".repeat(20_000)}complete tail marker`;
    const output = sanitizePublicConfidenceText(input);

    expect(output).toContain("[truncated before public confidence sanitization]");
    expect(output).toContain("safe prose");
    expect(output).not.toContain("[confidence not calibrated]");
    expect(output.length).toBeLessThan(129_000);
  });

  it("does not drop oversized prose after an early preserved confidence mention", () => {
    const early = "The confidence interval at 0.95 remains statistically meaningful. ";
    const tailMarker = "legitimate review prose near the truncation boundary survives";
    const confidenceClaim = " Confidence: 95%.";
    const filler = "x".repeat(128_000 - early.length - tailMarker.length - confidenceClaim.length - 12);
    const input = `${early}${filler} ${tailMarker}${confidenceClaim} after boundary`;
    const output = sanitizePublicConfidenceText(input);

    expect(output).toContain("confidence interval at 0.95");
    expect(output).toContain(tailMarker);
    expect(output).toContain("[truncated before public confidence sanitization]");
    expect(output).not.toContain("Confidence: 95%");
  });

  it("does not drop legitimate oversized prose after a complete in-window confidence mention", () => {
    const claim = "reliability score is stable.";
    const tailMarker = "legitimate prose survives after the confidence-like mention";
    const fillerBeforeClaim = "a".repeat(124_000);
    const fillerAfterClaim = "b".repeat(2_000);
    const input = `${fillerBeforeClaim} ${claim} ${fillerAfterClaim} ${tailMarker} ${"c".repeat(4_500)}`;
    const output = sanitizePublicConfidenceText(input);

    expect(output).toContain(claim);
    expect(output).toContain(tailMarker);
    expect(output).toContain("[truncated before public confidence sanitization]");
  });

  it("does not leak a partial confidence token at the truncation boundary", () => {
    const output = sanitizePublicConfidenceText(`${"a".repeat(127_990)} 95% confident after boundary`);

    expect(output).toContain("[truncated before public confidence sanitization]");
    expect(output).not.toContain("95%");
    expect(output).not.toContain("95% confi");
  });

  it("does not leak no-space confidence tokens at the truncation boundary", () => {
    for (const token of ["confidence95%", "0.95confident"]) {
      const output = sanitizePublicConfidenceText(`${"a".repeat(128_000 - token.length + 3)}${token} after boundary`);

      expect(output).toContain("[truncated before public confidence sanitization]");
      expect(output).not.toContain("95%");
      expect(output).not.toContain("0.95");
      expect(output).not.toContain("confidence95%");
      expect(output).not.toContain("0.95confid");
    }
  });

  it("drops confidence fragments that begin before the trailing truncation window", () => {
    const token = `confidence score ${"x".repeat(140)} 95%`;
    const output = sanitizePublicConfidenceText(`${"a".repeat(128_000 - token.length + 3)}${token} after boundary`);

    expect(output).toContain("[truncated before public confidence sanitization]");
    expect(output).not.toContain("95%");
    expect(output).not.toContain("confidence score");
  });

  it("does not over-sanitize ordinary numbered review prose", () => {
    const input = [
      "1 likely cause is a missing guard, and 2 likely follow-ups are documented.",
      "1 accurate test can be better than 3 broad assertions.",
      "1 reliable repro exists, but 0 flaky checks remain.",
      "The review is sure to need 1 migration note.",
      "This is 100 percent deterministic because it has no model judgment."
    ].join("\n");

    expect(sanitizePublicConfidenceText(input)).toBe(input);
  });

  it("allows public confidence percentages only with explicit calibration evidence", () => {
    const policy = buildPublicConfidencePolicy(calibratedPolicyInput());

    expect(policy.evidenceUrl).toBe("https://github.com/electricsheephq/evaos-code-review-bot/actions/runs/123");
    expect(policy.datasetId).toBe("confidence-calibration-v1");
    expect(isPublicConfidenceDisplayAllowed(policy)).toBe(true);
    expect(sanitizePublicConfidenceText("Confidence: 95%.", policy)).toBe("Confidence: 95%.");
  });

  it("still bounds oversized text when calibrated display is allowed", () => {
    const output = sanitizePublicConfidenceText(`${"safe prose ".repeat(20_000)} Confidence: 95%.`, buildPublicConfidencePolicy(calibratedPolicyInput()));

    expect(output).toContain("[truncated before public confidence sanitization]");
    expect(output.length).toBeLessThan(129_000);
  });

  it("sanitizes with an explicit uncalibrated policy even when evidence fields are present", () => {
    const policy = buildPublicConfidencePolicy({
      ...calibratedPolicyInput(),
      mode: "uncalibrated"
    });

    expect(isPublicConfidenceDisplayAllowed(policy)).toBe(false);
    expect(sanitizePublicConfidenceText("Confidence: 95%.", policy)).toBe(sanitizePublicConfidenceText("Confidence: 95%."));
    expect(sanitizePublicConfidenceText("Confidence: 95%.", policy)).toBe("Confidence: [confidence not calibrated].");
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
    expect(sanitizePublicConfidenceText("Confidence: 95%.", policy)).toBe("Confidence: [confidence not calibrated].");
  });

  it("does not allow percentage display when calibration evidence is not an http URL", () => {
    const policy = buildPublicConfidencePolicy({
      ...calibratedPolicyInput(),
      evidenceUrl: "javascript:alert(1)"
    });

    expect(isPublicConfidenceDisplayAllowed(policy)).toBe(false);
    expect(sanitizePublicConfidenceText("Confidence: 95%.", policy)).toBe("Confidence: [confidence not calibrated].");
  });

  it("requires calibration evidence to use https", () => {
    const policy = buildPublicConfidencePolicy({
      ...calibratedPolicyInput(),
      evidenceUrl: "http://github.com/electricsheephq/evaos-code-review-bot/actions/runs/123"
    });

    expect(isPublicConfidenceDisplayAllowed(policy)).toBe(false);
    expect(sanitizePublicConfidenceText("Confidence: 95%.", policy)).toBe("Confidence: [confidence not calibrated].");
  });

  it("requires every eval promotion threshold before enabling public percentages", () => {
    const basePolicy = calibratedPolicyInput();

    expect(isPublicConfidenceDisplayAllowed(buildPublicConfidencePolicy({ ...basePolicy, labeledFindings: 99 }))).toBe(false);
    expect(isPublicConfidenceDisplayAllowed(buildPublicConfidencePolicy({ ...basePolicy, p0p1Labels: 29 }))).toBe(false);
    expect(isPublicConfidenceDisplayAllowed(buildPublicConfidencePolicy({ ...basePolicy, negativeControlScenarios: 9 }))).toBe(false);
    expect(isPublicConfidenceDisplayAllowed(buildPublicConfidencePolicy({ ...basePolicy, wilsonLowerBound: 0.94 }))).toBe(false);
    expect(isPublicConfidenceDisplayAllowed(buildPublicConfidencePolicy(basePolicy))).toBe(true);
  });

  it("rejects non-finite calibrated policy values from direct callers", () => {
    const basePolicy = buildPublicConfidencePolicy(calibratedPolicyInput());

    for (const override of [
      { minLabeledFindings: Number.NaN },
      { minLabeledFindings: 100.5 },
      { minP0P1Labels: Number.NaN },
      { minP0P1Labels: Number.POSITIVE_INFINITY },
      { minNegativeControlScenarios: Number.NaN },
      { minWilsonLowerBound: Number.NaN },
      { minWilsonLowerBound: Number.POSITIVE_INFINITY },
      { labeledFindings: Number.NaN },
      { labeledFindings: 124.5 },
      { p0p1Labels: Number.NaN },
      { negativeControlScenarios: Number.NaN },
      { wilsonLowerBound: Number.NaN },
      { wilsonLowerBound: 1.5 }
    ]) {
      const policy = { ...basePolicy, ...override };

      expect(isPublicConfidenceDisplayAllowed(policy)).toBe(false);
      expect(sanitizePublicConfidenceText("Confidence: 95%.", policy)).toBe("Confidence: [confidence not calibrated].");
    }
  });

  it("keeps hard promotion floors even when lower minima are supplied directly", () => {
    const policy = buildPublicConfidencePolicy({
      ...calibratedPolicyInput(),
      minLabeledFindings: 1,
      minP0P1Labels: 1,
      minNegativeControlScenarios: 1,
      minWilsonLowerBound: 0
    });

    expect(policy).toMatchObject({
      minLabeledFindings: 100,
      minP0P1Labels: 30,
      minNegativeControlScenarios: 10,
      minWilsonLowerBound: 0.95
    });
    expect(isPublicConfidenceDisplayAllowed({
      ...policy,
      labeledFindings: 1,
      p0p1Labels: 1,
      negativeControlScenarios: 1,
      wilsonLowerBound: 0
    })).toBe(false);
    expect(isPublicConfidenceDisplayAllowed({
      ...calibratedPolicyInput(),
      minLabeledFindings: 1,
      minP0P1Labels: 1,
      minNegativeControlScenarios: 1,
      minWilsonLowerBound: 0,
      labeledFindings: 1,
      p0p1Labels: 1,
      negativeControlScenarios: 1,
      wilsonLowerBound: 0
    })).toBe(false);
  });

  it("preserves all confidence phrasings when calibrated mode is legitimately allowed", () => {
    const input = [
      "Confidence: 95%.",
      "Confidence: 0.95.",
      "model confidence 0.95",
      "confidence score of 0.95",
      "confidence score: 0.95",
      "confidence score = 95%",
      "confidence score=95%",
      "confidence is 0.95",
      "confidence was 95%",
      "confidence at 95%",
      "99 percent confident",
      "95 percent confidence",
      "I have 0.95 confidence in this",
      "high confidence (0.95)",
      "certainty: 95%",
      "reliability: 95%",
      "accuracy 0.9",
      "likelihood 90%",
      "sure: 99%",
      "99% reliable",
      "0.91 likely"
    ].join("\n");

    expect(sanitizePublicConfidenceText(input, buildPublicConfidencePolicy(calibratedPolicyInput()))).toBe(input);
  });

  it("sanitizes long repeated confidence text deterministically", () => {
    const input = Array.from({ length: 750 }, (_value, index) =>
      `finding ${index}: confidence score: 0.95; **Confidence**: \`95%\`; ${index % 2 === 0 ? "0.91 reliable" : "99 percent confident"}`
    ).join("\n");

    const first = sanitizePublicConfidenceText(input);
    const second = sanitizePublicConfidenceText(input);

    expect(first).toBe(second);
    expect(first).not.toMatch(/\b\d+(?:\.\d+)?\s*(?:%|percent)\b/i);
    expect(first).not.toContain("0.95");
    expect(first).not.toContain("0.91 reliable");
    expect(first.match(/confidence not calibrated/g)?.length ?? 0).toBeGreaterThanOrEqual(750);
    expect(first).not.toMatch(/confidence not calibrated confidence not calibrated/);
  });

  it("is idempotent for already-sanitized public comments", () => {
    const once = sanitizePublicConfidenceText("Confidence: 95%. This has 0.91 reliability after review.");

    expect(sanitizePublicConfidenceText(once)).toBe(once);
  });
});

function calibratedPolicyInput() {
  return {
    mode: "calibrated" as const,
    evidenceUrl: " https://github.com/electricsheephq/evaos-code-review-bot/actions/runs/123 ",
    datasetId: " confidence-calibration-v1 ",
    minLabeledFindings: 100,
    minP0P1Labels: 30,
    minNegativeControlScenarios: 10,
    minWilsonLowerBound: 0.95,
    labeledFindings: 124,
    p0p1Labels: 31,
    negativeControlScenarios: 10,
    wilsonLowerBound: 0.95
  };
}
