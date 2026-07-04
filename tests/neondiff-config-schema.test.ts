import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";

const schemaPath = "docs/schema/neondiff-config.schema.json";
const fixtureRoot = "tests/fixtures/neondiff-config";
const providerIds = ["openai-compatible", "glm", "ollama-local", "zcode", "custom"] as const;

type JsonRecord = Record<string, unknown>;

const invalidFixtureExpectedPaths: Record<string, string[]> = {
  "invalid-local-provider-enum": ["/providers/local/provider"],
  "invalid-unsafe-enabled": [
    "/safetyGates/mutation/enabled",
    "/finishingTouches/enabled",
    "/issueEnrichment/enabled",
    "/confidence/displayPercentages"
  ]
};

const credentialSmokePatterns: RegExp[] = [
  /BEGIN (?:RSA |DSA |EC |OPENSSH |PRIVATE )?PRIVATE KEY/,
  /\bghp_[A-Za-z0-9_]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{20,}\b/,
  /\bglpat-[0-9A-Za-z_-]{20,}\b/,
  /\bglm-[0-9A-Za-z_-]{20,}\b/,
  /\bzai[._-][0-9A-Za-z_-]{20,}\b/
];

function readJson(path: string): JsonRecord {
  return JSON.parse(readFileSync(path, "utf8")) as JsonRecord;
}

function readYaml(path: string): JsonRecord {
  return parseYaml(readFileSync(path, "utf8")) as JsonRecord;
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function get(path: string, value: unknown): unknown {
  return path.split(".").reduce<unknown>((cursor, key) => asRecord(cursor)[key], value);
}

function compileSchema(): ValidateFunction {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  return ajv.compile(readJson(schemaPath));
}

function validateConfig(validate: ValidateFunction, config: JsonRecord): ErrorObject[] {
  const valid = validate(config);
  return valid ? [] : [...(validate.errors ?? [])];
}

function errorPaths(errors: ErrorObject[]): string[] {
  return [...new Set(errors.map((error) => error.instancePath))].sort();
}

function fixtureNames(prefix: "valid" | "invalid", extension: ".json" | ".neondiff.yml"): string[] {
  return readdirSync(fixtureRoot)
    .filter((name) => name.startsWith(`${prefix}-`) && name.endsWith(extension))
    .sort();
}

function withoutExtension(name: string): string {
  return name.replace(/(?:\.neondiff\.yml|\.json)$/, "");
}

function expectValidFixture(validate: ValidateFunction, name: string, config: JsonRecord): void {
  const errors = validateConfig(validate, config);
  expect(errorPaths(errors), name).toEqual([]);
}

function expectInvalidFixture(validate: ValidateFunction, name: string, config: JsonRecord): void {
  const errors = validateConfig(validate, config);
  const baseName = withoutExtension(name);
  const expectedPaths = invalidFixtureExpectedPaths[baseName];

  expect(expectedPaths, `${baseName} declares expected schema paths`).toBeDefined();
  expect(errors, name).not.toEqual([]);
  expect(errorPaths(errors), name).toEqual(expect.arrayContaining(expectedPaths ?? []));
}

function expectCredentialSmokeClean(fixture: string, text: string): void {
  for (const pattern of credentialSmokePatterns) {
    expect(text, `${fixture} matched ${pattern}`).not.toMatch(pattern);
  }
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
    expect(get("properties.$schema.description", schema)).toMatch(/NeonDiff-specific editor hint/);
    expect(get("properties.$schema.description", schema)).toMatch(/not a JSON Schema meta-schema/);

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
    expect(get("properties.review.properties.maxComments.description", schema)).toMatch(/stricter lower cap wins/);
    expect(get("properties.review.properties.maxComments.minimum", schema)).toBe(1);
    expect(get("properties.providers.properties.default.$ref", schema)).toBe("#/$defs/providerId");
    expect(get("properties.providers.properties.default.description", schema)).toMatch(/providers\.allowed/);
    expect(get("properties.providers.properties.local.properties.provider.description", schema)).toMatch(/openai-compatible/);
    expect(get("properties.providers.properties.local.properties.provider.description", schema)).toMatch(/ollama-local/);
    expect(get("properties.providers.properties.local.properties.provider.enum", schema)).toEqual(["ollama", "none"]);
    expect(get("properties.providers.properties.local.allOf", schema)).toBeDefined();
    expect(get("properties.providers.properties.local.properties.baseUrl.description", schema)).toMatch(/HTTP-only loopback/);
    expect(get("properties.providers.properties.local.properties.baseUrl.description", schema)).toMatch(
      /HTTPS loopback is intentionally rejected/
    );
    expect(get("properties.providers.properties.local.properties.baseUrl.pattern", schema)).toBe(
      "^http://(localhost|127\\.0\\.0\\.1|\\[::1\\])(:[0-9]+)?/v[1-9][0-9]*/?$"
    );
    expect(get("properties.safetyGates.properties.commentCaps.properties.maxPerPullRequest.minimum", schema)).toBe(1);
    expect(get("properties.safetyGates.properties.commentCaps.properties.maxPerPullRequest.description", schema)).toMatch(
      /stricter lower cap wins/
    );
    expect(get("properties.safetyGates.properties.commentCaps.properties.maxPerFile.minimum", schema)).toBe(1);
  });

  it("validates JSON fixtures against the published JSON Schema", () => {
    const validate = compileSchema();
    const validFixtures = fixtureNames("valid", ".json");

    expect(validFixtures).toEqual(["valid-full.json", "valid-minimal.json"]);

    for (const fixture of validFixtures) {
      expectValidFixture(validate, fixture, readJson(join(fixtureRoot, fixture)));
    }
  });

  it("rejects invalid JSON fixtures with expected schema paths", () => {
    const validate = compileSchema();
    const invalidFixtures = fixtureNames("invalid", ".json");

    expect(invalidFixtures).toEqual(["invalid-local-provider-enum.json", "invalid-unsafe-enabled.json"]);

    for (const fixture of invalidFixtures) {
      expectInvalidFixture(validate, fixture, readJson(join(fixtureRoot, fixture)));
    }
  });

  it("validates YAML fixtures against the same published JSON Schema", () => {
    const validate = compileSchema();
    const validFixtures = fixtureNames("valid", ".neondiff.yml");
    const invalidFixtures = fixtureNames("invalid", ".neondiff.yml");

    expect(validFixtures).toEqual(["valid-full.neondiff.yml", "valid-minimal.neondiff.yml"]);
    expect(invalidFixtures).toEqual(["invalid-local-provider-enum.neondiff.yml", "invalid-unsafe-enabled.neondiff.yml"]);

    for (const fixture of validFixtures) {
      expectValidFixture(validate, fixture, readYaml(join(fixtureRoot, fixture)));
    }

    for (const fixture of invalidFixtures) {
      expectInvalidFixture(validate, fixture, readYaml(join(fixtureRoot, fixture)));
    }
  });

  it("keeps YAML fixtures structurally aligned with their JSON twins", () => {
    const jsonFixtures = readdirSync(fixtureRoot)
      .filter((name) => name.endsWith(".json"))
      .sort();

    for (const jsonFixture of jsonFixtures) {
      const baseName = withoutExtension(jsonFixture);
      const yamlFixture = `${baseName}.neondiff.yml`;

      expect(readYaml(join(fixtureRoot, yamlFixture)), yamlFixture).toEqual(readJson(join(fixtureRoot, jsonFixture)));
    }
  });

  it("enforces providers.default as a supported provider id included in providers.allowed", () => {
    const validate = compileSchema();
    const baseConfig = readJson(join(fixtureRoot, "valid-minimal.json"));

    for (const providerId of providerIds) {
      expectValidFixture(validate, `${providerId} default`, {
        ...baseConfig,
        providers: {
          ...asRecord(baseConfig.providers),
          default: providerId,
          allowed: [providerId]
        }
      });

      const disallowedErrors = validateConfig(validate, {
        ...baseConfig,
        providers: {
          ...asRecord(baseConfig.providers),
          default: providerId,
          allowed: providerId === "openai-compatible" ? ["glm"] : ["openai-compatible"]
        }
      });

      expect(errorPaths(disallowedErrors), `${providerId} must be allowed`).toContain("/providers/allowed");
    }

    const unsupportedErrors = validateConfig(validate, {
      ...baseConfig,
      providers: {
        ...asRecord(baseConfig.providers),
        default: "not-a-provider"
      }
    });

    expect(errorPaths(unsupportedErrors)).toContain("/providers/default");
  });

  it("rejects remote provider ids and local adapter ids in the wrong slot", () => {
    const validate = compileSchema();
    const baseConfig = readJson(join(fixtureRoot, "valid-minimal.json"));

    for (const provider of ["openai-compatible", "ollama-local"]) {
      const localProviderErrors = validateConfig(validate, {
        ...baseConfig,
        providers: {
          ...asRecord(baseConfig.providers),
          local: {
            ...asRecord(get("providers.local", baseConfig)),
            provider
          }
        }
      });

      expect(errorPaths(localProviderErrors), `local.provider ${provider}`).toContain("/providers/local/provider");
    }

    const defaultProviderErrors = validateConfig(validate, {
      ...baseConfig,
      providers: {
        ...asRecord(baseConfig.providers),
        default: "ollama"
      }
    });

    expect(errorPaths(defaultProviderErrors)).toContain("/providers/default");
  });

  it("keeps the invalid local-provider fixture scoped to closed enum enforcement", () => {
    const validate = compileSchema();
    const fixture = readJson(join(fixtureRoot, "invalid-local-provider-enum.json"));
    const errors = validateConfig(validate, fixture);

    expect(get("providers.default", fixture)).toBe("openai-compatible");
    expect(get("providers.local.provider", fixture)).toBe("openai-compatible");
    expect(errorPaths(errors)).toEqual(["/providers/local/provider"]);
    expect(errorPaths(errors)).not.toContain("/providers/default");
  });

  it("accepts only local-only adapter ids for providers.local.provider", () => {
    const validate = compileSchema();
    const baseConfig = readJson(join(fixtureRoot, "valid-minimal.json"));

    for (const provider of ["ollama", "none"]) {
      expectValidFixture(validate, `local provider ${provider}`, {
        ...baseConfig,
        providers: {
          ...asRecord(baseConfig.providers),
          local: {
            ...asRecord(get("providers.local", baseConfig)),
            provider
          }
        }
      });
    }

    const remoteAliasErrors = validateConfig(validate, {
      ...baseConfig,
      providers: {
        ...asRecord(baseConfig.providers),
        local: {
          ...asRecord(get("providers.local", baseConfig)),
          provider: "openai-compatible"
        }
      }
    });

    expect(errorPaths(remoteAliasErrors)).toContain("/providers/local/provider");
  });

  it("requires enabled local providers to name a real adapter and model", () => {
    const validate = compileSchema();
    const baseConfig = readJson(join(fixtureRoot, "valid-minimal.json"));

    const errors = validateConfig(validate, {
      ...baseConfig,
      providers: {
        ...asRecord(baseConfig.providers),
        local: {
          ...asRecord(get("providers.local", baseConfig)),
          enabled: true,
          provider: "none",
          model: ""
        }
      }
    });

    expect(errorPaths(errors)).toEqual(expect.arrayContaining(["/providers/local/model", "/providers/local/provider"]));
  });

  it("keeps local provider baseUrl constrained to HTTP loopback version roots", () => {
    const validate = compileSchema();
    const baseConfig = readJson(join(fixtureRoot, "valid-minimal.json"));

    for (const baseUrl of [
      "http://localhost:11434/v1",
      "http://127.0.0.1:8080/v2",
      "http://[::1]/v1/"
    ]) {
      expectValidFixture(validate, baseUrl, {
        ...baseConfig,
        providers: {
          ...asRecord(baseConfig.providers),
          local: {
            ...asRecord(get("providers.local", baseConfig)),
            baseUrl
          }
        }
      });
    }

    for (const baseUrl of [
      "https://localhost:11434/v1",
      "http://localhost:11434/v0",
      "http://localhost:11434/v00",
      "http://localhost:11434/v1/chat/completions",
      "http://localhost:11434/../../admin",
      "http://example.com/v1"
    ]) {
      const errors = validateConfig(validate, {
        ...baseConfig,
        providers: {
          ...asRecord(baseConfig.providers),
          local: {
            ...asRecord(get("providers.local", baseConfig)),
            baseUrl
          }
        }
      });

      expect(errorPaths(errors), baseUrl).toContain("/providers/local/baseUrl");
    }
  });

  it("rejects zero pull-request comment budgets to avoid silent no-op review output", () => {
    const validate = compileSchema();
    const baseConfig = readJson(join(fixtureRoot, "valid-minimal.json"));

    const reviewErrors = validateConfig(validate, {
      ...baseConfig,
      review: {
        ...asRecord(baseConfig.review),
        maxComments: 0
      }
    });

    expect(errorPaths(reviewErrors), "review.maxComments").toContain("/review/maxComments");

    for (const commentCaps of [
      { maxPerPullRequest: 0, maxPerFile: 4 },
      { maxPerPullRequest: 12, maxPerFile: 0 }
    ]) {
      const errors = validateConfig(validate, {
        ...baseConfig,
        safetyGates: {
          ...asRecord(baseConfig.safetyGates),
          commentCaps
        }
      });

      expect(errorPaths(errors), JSON.stringify(commentCaps)).toContain(
        commentCaps.maxPerPullRequest === 0
          ? "/safetyGates/commentCaps/maxPerPullRequest"
          : "/safetyGates/commentCaps/maxPerFile"
      );
    }
  });

  it("keeps committed examples credential-smoke-clean", () => {
    const fixtures = readdirSync(fixtureRoot)
      .filter((name) => name.endsWith(".json") || name.endsWith(".neondiff.yml"))
      .sort();

    for (const fixture of fixtures) {
      const text = readFileSync(join(fixtureRoot, fixture), "utf8");

      expect(text).toMatch(/"?\$schema"?:\s*"?docs\/schema\/neondiff-config\.schema\.json"?/);
      expectCredentialSmokeClean(fixture, text);
    }
  });
});
