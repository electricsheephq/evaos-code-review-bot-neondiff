import { describe, expect, it } from "vitest";
import {
  ZCODE_SCHEMA_FAILURE_ERROR_PREFIX,
  isZCodeSchemaFailureError,
  parseZCodeReviewOutput
} from "../src/zcode.js";
import { applyRetryDegradedConfidencePenalty, buildRetryDegradedRuntimeNote, classifyProviderError } from "../src/worker.js";
import type { Finding } from "../src/types.js";

// A ZCode stdout envelope wrapping a valid review-JSON string (what extractZCodeResponse consumes).
const CLEAN = JSON.stringify({
  response: JSON.stringify({
    findings: [{ severity: "P2", path: "src/x.ts", line: 3, title: "Concern", body: "A concrete review comment.", confidence: 0.8 }],
    summary: "ok"
  })
});

describe("zcode retry-degraded provenance (#304)", () => {
  it("marks a clean first-pass parse as non-degraded on attempt 1", () => {
    const result = parseZCodeReviewOutput([CLEAN]);
    expect(result.attempts).toBe(1);
    expect(result.degradedRecovery).toBe(false);
    expect(result.findings).toHaveLength(1);
  });

  it("flags degradedRecovery when the first attempt fails to parse and a later attempt succeeds", () => {
    const result = parseZCodeReviewOutput(["not json at all", CLEAN]);
    expect(result.attempts).toBe(2);
    expect(result.degradedRecovery).toBe(true);
    expect(result.findings).toHaveLength(1);
  });

  it("throws a distinct, detectable schema-failure error when no attempt parses", () => {
    let thrown: unknown;
    try {
      parseZCodeReviewOutput(["nope", "still nope"]);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain(ZCODE_SCHEMA_FAILURE_ERROR_PREFIX);
    expect(isZCodeSchemaFailureError(thrown)).toBe(true);
  });
});

describe("retry-degraded confidence penalty (#304)", () => {
  const findings: Finding[] = [
    { severity: "P2", category: "runtime_correctness", path: "a.ts", line: 1, title: "One", body: "b", confidence: 0.9 },
    { severity: "P3", category: "runtime_correctness", path: "a.ts", line: 2, title: "Two", body: "b", confidence: 0.1 }
  ];

  it("is a no-op when the parse was not degraded", () => {
    const out = applyRetryDegradedConfidencePenalty(findings, false, 0.3);
    expect(out.map((f) => f.confidence)).toEqual([0.9, 0.1]);
  });

  it("is a no-op when no penalty is configured", () => {
    const out = applyRetryDegradedConfidencePenalty(findings, true, undefined);
    expect(out.map((f) => f.confidence)).toEqual([0.9, 0.1]);
  });

  it("subtracts the penalty (floored at 0) only for degraded findings — quieter-only", () => {
    const out = applyRetryDegradedConfidencePenalty(findings, true, 0.3);
    expect(out[0]?.confidence).toBeCloseTo(0.6, 10);
    expect(out[1]?.confidence).toBe(0); // 0.1 - 0.3 floored at 0
    // Penalty can only lower confidence, never raise it.
    for (const [i, f] of out.entries()) expect(f.confidence).toBeLessThanOrEqual(findings[i]!.confidence);
  });
});

describe("schema-failure provider classification (#304)", () => {
  it("classifies a schema-failure error as its own bounded retryable category", () => {
    const error = new Error(`${ZCODE_SCHEMA_FAILURE_ERROR_PREFIX}: did not parse after 2 attempts`);
    const classification = classifyProviderError(error);
    expect(classification.category).toBe("model_output_schema");
    expect(classification.retryable).toBe(true);
    expect(classification.cooldown).toBe(false);
  });

  it("leaves unrelated errors non-retryable", () => {
    expect(classifyProviderError(new Error("some other failure")).category).toBe("none");
    expect(classifyProviderError(new Error("some other failure")).retryable).toBe(false);
  });
});

describe("outcome-ledger retry-degraded runtime note (#304)", () => {
  it("emits a provenance note only when the parse was degraded", () => {
    expect(buildRetryDegradedRuntimeNote(1, false)).toBeUndefined();
    const note = buildRetryDegradedRuntimeNote(2, true);
    expect(note).toBeDefined();
    expect(note).toMatch(/degraded/i);
    expect(note).toContain("2");
  });
});
