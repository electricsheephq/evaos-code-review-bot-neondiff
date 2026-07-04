import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const schemaPath = "docs/schema/neondiff-config.schema.json";
const fixtureRoot = "tests/fixtures/neondiff-config";
const providerIds = ["openai-compatible", "glm", "ollama-local", "zcode", "custom"];

type JsonRecord = Record<string, unknown>;

function readJson(path: string): JsonRecord {
  return JSON.parse(readFileSync(path, "utf8")) as JsonRecord;
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function get(path: string, value: unknown): unknown {
  return path.split(".").reduce<unknown>((cursor, key) => asRecord(cursor)[key], value);
}

function isProviderId(value: unknown): value is string {
  return typeof value === "string" && providerIds.includes(value);
}

function validateFixture(config: JsonRecord): string[] {
  const errors: string[] = [];
  const providersDefault = get("providers.default", config);
  const providersAllowed = get("providers.allowed", config);

  if (config.version !== 1) errors.push("version must be 1");
  if (!["conservative", "balanced", "thorough"].includes(String(get("review.profile", config)))) {
    errors.push("review.profile must be conservative, balanced, or thorough");
  }
  if (typeof get("review.maxComments", config) !== "number") errors.push("review.maxComments must be a number");
  if (!Array.isArray(get("paths.include", config))) errors.push("paths.include must be an array");
  if (!Array.isArray(get("paths.exclude", config))) errors.push("paths.exclude must be an array");
  if (!isProviderId(providersDefault)) errors.push("providers.default must be a supported provider id");
  if (!Array.isArray(providersAllowed) || !providersAllowed.every(isProviderId)) {
    errors.push("providers.allowed must list supported provider ids");
  } else if (isProviderId(providersDefault) && !providersAllowed.includes(providersDefault)) {
    errors.push("providers.default must be included in providers.allowed");
  }
  if (get("providers.byok.required", config) !== true && get("providers.byok.required", config) !== false) {
    errors.push("providers.byok.required must be a boolean");
  }
  if (get("providers.local.enabled", config) !== true && get("providers.local.enabled", config) !== false) {
    errors.push("providers.local.enabled must be a boolean");
  }
  if (get("safetyGates.mutation.enabled", config) !== false) errors.push("safetyGates.mutation.enabled must default false");
  if (get("finishingTouches.enabled", config) !== false) errors.push("finishingTouches.enabled must default false");
  if (get("issueEnrichment.enabled", config) !== false) errors.push("issueEnrichment.enabled must default false");
  if (!Array.isArray(get("issueEnrichment.allowlist", config))) errors.push("issueEnrichment.allowlist must be an array");
  if (get("confidence.mode", config) !== "uncalibrated") errors.push("confidence.mode must be uncalibrated");
  if (get("confidence.displayPercentages", config) !== false) errors.push("confidence.displayPercentages must default false");
  if (typeof get("repo.visibility", config) !== "string") errors.push("repo.visibility must be a string");
  if (typeof get("repo.reviewDraftPullRequests", config) !== "boolean") {
    errors.push("repo.reviewDraftPullRequests must be a boolean");
  }

  return errors;
}

describe("NeonDiff config schema draft", () => {
  it("publishes a conservative public .neondiff.yml schema contract for issue 109", () => {
    const schema = readJson(schemaPath);
    const properties = asRecord(schema.properties);

    expect(schema.$id).toBe("https://neondiff.com/schemas/neondiff-config.schema.json");
    expect(schema.title).toBe("NeonDiff .neondiff.yml configuration");
    expect(schema.additionalProperties).toBe(false);
    expect(schema.description).toMatch(/draft/i);
    expect(schema.description).toMatch(/not yet wired into runtime/i);
    expect(schema.description).toMatch(/#109/i);

    for (const topLevelKey of [
      "version",
      "review",
      "paths",
      "providers",
      "safetyGates",
      "finishingTouches",
      "issueEnrichment",
      "confidence",
      "repo"
    ]) {
      expect(properties[topLevelKey], `${topLevelKey} is documented`).toBeDefined();
    }

    expect(get("properties.review.properties.profile.default", schema)).toBe("conservative");
    expect(get("properties.safetyGates.properties.mutation.properties.enabled.default", schema)).toBe(false);
    expect(get("properties.finishingTouches.properties.enabled.default", schema)).toBe(false);
    expect(get("properties.issueEnrichment.properties.enabled.default", schema)).toBe(false);
    expect(get("properties.confidence.properties.mode.default", schema)).toBe("uncalibrated");
    expect(get("properties.confidence.properties.displayPercentages.default", schema)).toBe(false);
    expect(get("properties.providers.properties.default.$ref", schema)).toBe("#/$defs/providerId");
    expect(JSON.stringify(get("properties.providers.allOf", schema))).toContain("\"contains\":{\"const\":\"glm\"}");
  });

  it("keeps valid examples inside the schema-owned public contract", () => {
    const validFixtures = readdirSync(fixtureRoot)
      .filter((name) => name.startsWith("valid-") && name.endsWith(".json"))
      .sort();

    expect(validFixtures).toEqual(["valid-full.json", "valid-minimal.json"]);

    for (const fixture of validFixtures) {
      const errors = validateFixture(readJson(join(fixtureRoot, fixture)));
      expect(errors, fixture).toEqual([]);
    }
  });

  it("keeps invalid examples invalid for clear user-facing reasons", () => {
    const invalidFixtures = readdirSync(fixtureRoot)
      .filter((name) => name.startsWith("invalid-") && name.endsWith(".json"))
      .sort();

    expect(invalidFixtures).toEqual(["invalid-unsafe-enabled.json"]);

    const errors = validateFixture(readJson(join(fixtureRoot, invalidFixtures[0]!)));
    expect(errors).toEqual([
      "safetyGates.mutation.enabled must default false",
      "finishingTouches.enabled must default false",
      "issueEnrichment.enabled must default false",
      "confidence.displayPercentages must default false"
    ]);
  });

  it("rejects unsupported or disallowed default providers while accepting a valid default", () => {
    const validConfig = readJson(join(fixtureRoot, "valid-full.json"));

    expect(validateFixture(validConfig)).toEqual([]);
    expect(validateFixture({
      ...validConfig,
      providers: {
        ...asRecord(validConfig.providers),
        default: "not-a-provider"
      }
    })).toContain("providers.default must be a supported provider id");
    expect(validateFixture({
      ...validConfig,
      providers: {
        ...asRecord(validConfig.providers),
        default: "glm",
        allowed: ["openai-compatible"]
      }
    })).toContain("providers.default must be included in providers.allowed");
  });

  it("documents committed examples without secrets", () => {
    const fixtures = readdirSync(fixtureRoot)
      .filter((name) => name.endsWith(".json") || name.endsWith(".neondiff.yml"))
      .sort();

    for (const fixture of fixtures) {
      const text = readFileSync(join(fixtureRoot, fixture), "utf8");

      expect(text).toMatch(/"?\$schema"?:\s*"?docs\/schema\/neondiff-config\.schema\.json"?/);
      expect(text).not.toMatch(/BEGIN (RSA|OPENSSH|PRIVATE) KEY|ghp_|github_pat_|sk-[A-Za-z0-9]/);
    }
  });
});
