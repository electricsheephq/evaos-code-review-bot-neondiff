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

  it("rejects the same non-canonical offset clock vectors as the Swift fixture decoder", () => {
    const source = JSON.parse(readFileSync("apps/neondiff-desktop/fixtures/ui/tab-overview.json", "utf8"));
    for (const clock of ["2026-07-10T12:00:00+00:00", "2026-07-10T12:00:00+07:00"]) {
      source.environment.clock = clock;
      expect(() => validateDesktopEvaluationFixture(source)).toThrow(/clock is invalid/);
    }
  });

  it("rejects invalid calendar timestamps for the clock and repositories", () => {
    const source = JSON.parse(readFileSync("apps/neondiff-desktop/fixtures/ui/tab-overview.json", "utf8"));
    source.environment.clock = "2026-02-30T12:00:00Z";
    expect(() => validateDesktopEvaluationFixture(source)).toThrow(/clock is invalid/);
    source.environment.clock = "2026-07-10T12:00:00Z";
    source.state.repositories[0].lastReview = "2026-02-30T11:55:00Z";
    expect(() => validateDesktopEvaluationFixture(source)).toThrow(/lastReview is invalid/);
  });

  it("keeps fixture timestamps inside the shared modern-year contract", () => {
    for (const clock of ["0000-01-01T00:00:00Z", "1500-02-29T00:00:00Z"]) {
      const source = JSON.parse(readFileSync("apps/neondiff-desktop/fixtures/ui/tab-overview.json", "utf8"));
      source.environment.clock = clock;
      expect(() => validateDesktopEvaluationFixture(source)).toThrow(/clock is invalid/);
    }
  });

  it("rejects non-canonical offset repository timestamps", () => {
    const source = JSON.parse(readFileSync("apps/neondiff-desktop/fixtures/ui/tab-overview.json", "utf8"));
    source.state.repositories[0].lastReview = "2026-07-10T11:55:00+07:00";
    expect(() => validateDesktopEvaluationFixture(source)).toThrow(/lastReview is invalid/);
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

  it("rejects the same hostless provider URL as the Swift fixture decoder", () => {
    const source = JSON.parse(readFileSync("apps/neondiff-desktop/fixtures/ui/tab-providers.json", "utf8"));
    source.state.provider.baseURL = "https://";
    expect(() => validateDesktopEvaluationFixture(source)).toThrow(/baseURL is invalid/);
  });

  it("rejects WHATWG shorthand provider URLs that Swift cannot resolve with a host", () => {
    for (const baseURL of ["https:foo", "https:/example.com"]) {
      const source = JSON.parse(readFileSync("apps/neondiff-desktop/fixtures/ui/tab-providers.json", "utf8"));
      source.state.provider.baseURL = baseURL;
      expect(() => validateDesktopEvaluationFixture(source)).toThrow(/baseURL is invalid/);
    }
  });

  it("rejects WHATWG-normalized control characters and backslashes in provider URLs", () => {
    for (const baseURL of [
      "https://\nexample.com",
      "https://example.com\n",
      "https://example.com\t/path",
      "https://example.com\\evil",
      "https://example.com:99999",
      "https://@example.com",
      "https://example.com "
    ]) {
      const source = JSON.parse(readFileSync("apps/neondiff-desktop/fixtures/ui/tab-providers.json", "utf8"));
      source.state.provider.baseURL = baseURL;
      expect(() => validateDesktopEvaluationFixture(source)).toThrow(/baseURL is invalid/);
    }
  });

  it("rejects unactivated post-onboarding surfaces", () => {
    const source = JSON.parse(readFileSync("apps/neondiff-desktop/fixtures/ui/tab-overview.json", "utf8"));
    source.state.license = { entitlement: "not activated", credentialPresent: false, updateChannel: "dev" };
    expect(() => validateDesktopEvaluationFixture(source)).toThrow(/post-onboarding.*activation/i);
  });

  it("caps repository counts inside the shared integer contract", () => {
    const source = JSON.parse(readFileSync("apps/neondiff-desktop/fixtures/ui/tab-overview.json", "utf8"));
    source.state.github.repositoryCount = 10_001;
    expect(() => validateDesktopEvaluationFixture(source)).toThrow(/repositoryCount is invalid/);
    source.state.github.repositoryCount = 1e20;
    expect(() => validateDesktopEvaluationFixture(source)).toThrow(/repositoryCount is invalid/);
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
