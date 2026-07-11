import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  canonicalDesktopEvaluationFixtureJSON,
  decodeDesktopEvaluationFixtureData,
  validateDesktopEvaluationFixture
} from "../scripts/shared/desktop-evaluation-fixture-validator.mjs";

function reverseObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .reverse()
        .map(([key, item]) => [key, reverseObjectKeys(item)])
    );
  }
  return value;
}

describe("desktop fixture validator parity", () => {
  it("canonicalizes semantically identical resolver data independent of key order", () => {
    const source = JSON.parse(readFileSync("apps/neondiff-desktop/fixtures/ui/tab-overview.json", "utf8"));
    const reordered = reverseObjectKeys(source);
    expect(canonicalDesktopEvaluationFixtureJSON(validateDesktopEvaluationFixture(source))).toBe(
      canonicalDesktopEvaluationFixtureJSON(validateDesktopEvaluationFixture(reordered))
    );
  });

  it("rejects the same non-ISO clock vector as the Swift fixture decoder", () => {
    const source = JSON.parse(readFileSync("apps/neondiff-desktop/fixtures/ui/tab-overview.json", "utf8"));
    source.environment.clock = "0";
    expect(() => validateDesktopEvaluationFixture(source)).toThrow(/clock is invalid/);
  });

  it("rejects string dimensions and non-string IDs instead of coercing them", () => {
    const source = JSON.parse(readFileSync("apps/neondiff-desktop/fixtures/ui/tab-overview.json", "utf8"));
    source.environment.contentSize = { width: "1040", height: "680" };
    expect(() => validateDesktopEvaluationFixture(source)).toThrow(/contentSize is invalid/);
    delete source.environment.contentSize;
    source.id = 1;
    expect(() => validateDesktopEvaluationFixture(source)).toThrow(/identity is invalid/);
  });

  it("rejects non-string provider URLs instead of coercing them", () => {
    const source = JSON.parse(readFileSync("apps/neondiff-desktop/fixtures/ui/tab-providers.json", "utf8"));
    source.state.provider.baseURL = ["https://example.com"];
    expect(() => validateDesktopEvaluationFixture(source)).toThrow(/baseURL is invalid/);
  });

  it("rejects semantic and whitespace fixture payloads over the Swift byte limit", () => {
    const source = JSON.parse(readFileSync("apps/neondiff-desktop/fixtures/ui/tab-overview.json", "utf8"));
    source.safeCopy = Array.from({ length: 100 }, () => "x".repeat(3_000));
    expect(() => decodeDesktopEvaluationFixtureData(Buffer.from(JSON.stringify(source)))).toThrow(/exceeds.*byte limit/);

    const small = readFileSync("apps/neondiff-desktop/fixtures/ui/tab-overview.json");
    const padded = Buffer.concat([small, Buffer.alloc(256 * 1024, 0x20)]);
    expect(() => decodeDesktopEvaluationFixtureData(padded)).toThrow(/exceeds.*byte limit/);
  });
});
