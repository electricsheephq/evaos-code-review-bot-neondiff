import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  classifyProviderAdapterError,
  runProviderAdapterFixture,
  type ProviderRuntimeAdapter
} from "../src/provider-adapters.js";

describe("provider adapter fixtures", () => {
  it("runs adapter fixtures deterministically without exposing prompt text or secrets in evidence", async () => {
    function makeAdapter(rawEvidence: Record<string, unknown>): ProviderRuntimeAdapter {
      return {
        id: "fixture-openai-compatible",
        async execute(input) {
          expect(input.fixtureId).toBe("review-json-fixture");
          expect(input.prompt).toContain("private patch content");
          return {
            text: '{"findings":[]}',
            rawEvidence
          };
        }
      };
    }
    const firstAdapter = makeAdapter({
      echoedPrompt: "Review this private patch content with sk-live-secret-secret.",
      note: "Review this private patch content with sk-live-secret-secret.",
      providerUrl: "https://gateway.example.test/v1?api_key=secret-provider-key-123456",
      authorization: "Bearer provider-secret-1234567890",
      Z: "upper-z",
      A: "upper-a",
      Aa: "upper-aa",
      _: "underscore",
      aA: "lower-upper",
      aa: "lower-aa",
      b: 2,
      a: 1
    });
    const secondAdapter = makeAdapter({
      a: 1,
      b: 2,
      aa: "lower-aa",
      aA: "lower-upper",
      _: "underscore",
      Aa: "upper-aa",
      A: "upper-a",
      Z: "upper-z",
      authorization: "Bearer provider-secret-1234567890",
      providerUrl: "https://gateway.example.test/v1?api_key=secret-provider-key-123456",
      note: "Review this private patch content with sk-live-secret-secret.",
      echoedPrompt: "Review this private patch content with sk-live-secret-secret."
    });

    const fixture = makeFixture({
      id: "review-json-fixture",
      prompt: "Review this private patch content with sk-live-secret-secret.",
      expectJsonObject: true
    });

    const first = await runProviderAdapterFixture({ adapter: firstAdapter, fixture });
    const second = await runProviderAdapterFixture({ adapter: secondAdapter, fixture });

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      ok: true,
      fixtureId: "review-json-fixture",
      providerId: "openai-compatible",
      adapterId: "openai-compatible",
      model: "review-model",
      evidence: {
        promptSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        redactedOutputSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        outputPreview: '{"findings":[]}',
        rawEvidencePreview:
          '{"A":"upper-a","Aa":"upper-aa","Z":"upper-z","_":"underscore","a":1,"aA":"lower-upper","aa":"lower-aa","authorization":"[redacted-sensitive-field]","b":2,"echoedPrompt":"[redacted-private-field]","note":"[redacted-private-evidence]","providerUrl":"[redacted-private-evidence]"}'
      }
    });
    const serialized = JSON.stringify(first);
    expect(serialized).not.toContain("private patch content");
    expect(serialized).not.toContain("sk-live-secret-secret");
    expect(serialized).not.toContain("secret-provider-key-123456");
    expect(serialized).not.toContain("provider-secret-1234567890");
    expect(serialized).toContain("[redacted-private-evidence]");
    expect(serialized).toContain("[redacted-private-field]");
  });

  it("redacts private adapter error messages with the same evidence boundary", async () => {
    const fixture = makeFixture({
      id: "runtime-private-error-fixture",
      expectJsonObject: true
    });
    const adapter: ProviderRuntimeAdapter = {
      id: "fixture-openai-compatible",
      async execute() {
        throw new Error("failed processing diff --git a/private.ts b/private.ts with Review this private patch content");
      }
    };

    const result = await runProviderAdapterFixture({ adapter, fixture });

    expect(result).toMatchObject({
      ok: false,
      error: {
        class: "unknown",
        message: "[redacted-private-evidence]"
      }
    });
    expect(JSON.stringify(result)).not.toContain("diff --git");
    expect(JSON.stringify(result)).not.toContain("private patch content");
  });

  it("truncates raw evidence previews with an explicit sentinel without splitting redaction tokens", async () => {
    const fixture = makeFixture({
      id: "truncated-raw-evidence-fixture",
      expectJsonObject: true
    });
    const result = await runProviderAdapterFixture({
      adapter: {
        id: "fixture-openai-compatible",
        async execute() {
          return {
            text: '{"findings":[]}',
            rawEvidence: Object.fromEntries(
              Array.from({ length: 40 }, (_, index) => [
                `rawResponse${String(index).padStart(2, "0")}`,
                {
                  message: "Review this private patch content before posting a comment."
                }
              ])
            )
          };
        }
      },
      fixture
    });

    expect(result.ok).toBe(true);
    expect(result.evidence.rawEvidencePreview).toBeDefined();
    expect(result.evidence.rawEvidencePreview?.length).toBeLessThanOrEqual(500);
    expect(result.evidence.rawEvidencePreview).toMatch(/\.\.\.\[truncated\]$/);
    expect(result.evidence.rawEvidencePreview).not.toMatch(/\[redacted-[^\]]*$/);
    expect(JSON.stringify(result)).not.toContain("private patch content");
  });

  it.each([
    "[redacted-private-evidence]",
    "[redacted-private-field]",
    "[redacted-secret]",
    "[redacted-sensitive-field]",
    "[redacted-unserializable-evidence]"
  ])("truncates output previews without splitting the %s token", async (redactionToken) => {
    const result = await runProviderAdapterFixture({
      adapter: {
        id: "fixture-openai-compatible",
        async execute() {
          return {
            text: `${"x".repeat(480)}${redactionToken.repeat(40)}`
          };
        }
      },
      fixture: makeFixture({
        id: `truncated-output-${redactionToken.replace(/[^a-z]/g, "-")}`,
        prompt: "review patch"
      })
    });

    expect(result.ok).toBe(true);
    expect(result.evidence.outputPreview).toBeDefined();
    expect(result.evidence.outputPreview?.length).toBeLessThanOrEqual(500);
    expect(result.evidence.outputPreview).toMatch(/\.\.\.\[truncated\]$/);
    expect(result.evidence.outputPreview).not.toMatch(/\[redacted-[^\]]*$/);
  });

  it("hashes redacted provider output instead of raw private output", async () => {
    const fixture = makeFixture({ id: "private-output-fixture" });
    const result = await runProviderAdapterFixture({
      adapter: {
        id: "fixture-openai-compatible",
        async execute() {
          return {
            text: "Review this private patch content before posting a comment."
          };
        }
      },
      fixture
    });

    expect(result.ok).toBe(true);
    expect(result.evidence.outputPreview).toBe("[redacted-private-evidence]");
    expect(result.evidence.redactedOutputSha256).toBe(sha256("[redacted-private-evidence]"));
    expect(result.evidence.redactedOutputSha256).not.toBe(sha256("Review this private patch content before posting a comment."));
    expect(result.evidence).not.toHaveProperty("outputSha256");
  });

  it("omits raw evidence preview when adapter returns no raw evidence", async () => {
    const result = await runProviderAdapterFixture({
      adapter: {
        id: "fixture-openai-compatible",
        async execute() {
          return {
            text: '{"findings":[]}'
          };
        }
      },
      fixture: makeFixture({ id: "no-raw-evidence-fixture" })
    });

    expect(result).toMatchObject({
      ok: true,
      evidence: {
        outputPreview: '{"findings":[]}'
      }
    });
    expect(result.evidence).not.toHaveProperty("rawEvidencePreview");
  });

  it("classifies adapter runtime errors into provider-safe categories with redacted evidence", async () => {
    expect(classifyProviderAdapterError("401 invalid api key")).toBe("auth");
    expect(classifyProviderAdapterError("429 rate limit exceeded")).toBe("throttle");
    expect(classifyProviderAdapterError("rate-limit exceeded")).toBe("throttle");
    expect(classifyProviderAdapterError("ECONNRESET from gateway")).toBe("network");
    expect(classifyProviderAdapterError("request timed out")).toBe("timeout");
    expect(classifyProviderAdapterError("request timed-out")).toBe("timeout");
    expect(classifyProviderAdapterError("model returned malformed JSON")).toBe("model-output");
    expect(classifyProviderAdapterError("network reachable but returned unexpected json")).toBe("model-output");
    expect(classifyProviderAdapterError("network-error while parsing invalid response")).toBe("network");
    expect(classifyProviderAdapterError("request timed out while validating structured output schema")).toBe("timeout");
    expect(classifyProviderAdapterError("ECONNRESET before structured output completed")).toBe("network");
    expect(classifyProviderAdapterError("ECONNRESET after request timed out")).toBe("timeout");
    expect(classifyProviderAdapterError("401 invalid api key while validating json schema")).toBe("auth");
    expect(classifyProviderAdapterError("429 rate limit while parsing invalid response")).toBe("throttle");

    const fixture = makeFixture({
      id: "runtime-error-fixture",
      prompt: "Prompt containing provider-secret-1234567890",
      expectJsonObject: true
    });

    const adapter: ProviderRuntimeAdapter = {
      id: "fixture-openai-compatible",
      async execute() {
        throw new Error("429 quota exhausted for Bearer provider-secret-1234567890");
      }
    };

    const result = await runProviderAdapterFixture({ adapter, fixture });

    expect(result).toMatchObject({
      ok: false,
      error: {
        class: "throttle",
        message: "[redacted-private-evidence]"
      }
    });
    expect(JSON.stringify(result)).not.toContain("provider-secret-1234567890");
  });

  it.each([
    {
      expectedClass: "auth",
      message: "401 invalid api key for Bearer provider-secret-1234567890"
    },
    {
      expectedClass: "timeout",
      message: "request timed out while using Bearer provider-secret-1234567890"
    },
    {
      expectedClass: "network",
      message: "ECONNRESET from gateway with Bearer provider-secret-1234567890"
    }
  ] as const)(
    "redacts $expectedClass adapter errors through fixture execution",
    async ({ expectedClass, message }) => {
      const fixture = makeFixture({
        id: `${expectedClass}-runtime-error-fixture`,
        prompt: "Prompt containing provider-secret-1234567890",
        expectJsonObject: true
      });

      const adapter: ProviderRuntimeAdapter = {
        id: "fixture-openai-compatible",
        async execute() {
          throw new Error(message);
        }
      };

      const result = await runProviderAdapterFixture({ adapter, fixture });

      expect(result).toMatchObject({
        ok: false,
        error: {
          class: expectedClass,
          message: "[redacted-private-evidence]"
        }
      });
      expect(JSON.stringify(result)).not.toContain("provider-secret-1234567890");
    }
  );

  it("marks schema failures as model-output without preserving raw invalid output", async () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhZGFwdGVyLWZpeHR1cmUifQ.signature12345";
    const result = await runProviderAdapterFixture({
      adapter: {
        id: "fixture-openai-compatible",
        async execute() {
          return {
            text: `not json with leaked token sk-live-secret-secret {"x-api-key":"rawapikey1234567890"} ${jwt}`
          };
        }
      },
      fixture: makeFixture({
        id: "invalid-json-fixture",
        prompt: "review patch",
        expectJsonObject: true
      })
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        class: "model-output",
        message: "Adapter output was not a JSON object."
      },
      evidence: {
        outputPreview: "[redacted-private-evidence]"
      }
    });
    expect(JSON.stringify(result)).not.toContain("sk-live-secret-secret");
    expect(JSON.stringify(result)).not.toContain("rawapikey1234567890");
    expect(JSON.stringify(result)).not.toContain(jwt);
  });

  it("fails closed for raw private evidence stored under innocuous field names", async () => {
    const fixture = makeFixture({
      id: "raw-evidence-fixture",
      expectJsonObject: true
    });

    const result = await runProviderAdapterFixture({
      adapter: {
        id: "fixture-openai-compatible",
        async execute(input) {
          return {
            text: '{"findings":[]}',
            rawEvidence: {
              note: input.prompt,
              metadata: {
                label: "adapter fixture",
                harmless: true,
                content: "benign token-count metadata",
                message: "provider reported finished",
                response: {
                  id: "response-id-only",
                  statusCode: 200
                }
              },
              rawResponse: {
                content: "Review this private patch content before posting a comment."
              },
              rawAPIResponse: {
                status: 200,
                data: "private api response text"
              },
              fullJSONOutput: {
                findings: ["private json output"]
              },
              originalHTTPBody: "private http body",
              rawIDToken: "id-token-secret-value",
              transcript: "diff --git a/private.ts b/private.ts\n@@ -1 +1 @@\n-secret\n+fixed"
            }
          };
        }
      },
      fixture
    });

    const serialized = JSON.stringify(result);
    expect(result.ok).toBe(true);
    expect(serialized).toContain("[redacted-private-evidence]");
    expect(serialized).toContain("[redacted-private-field]");
    expect(serialized).toContain("adapter fixture");
    expect(serialized).toContain("benign token-count metadata");
    expect(serialized).toContain("provider reported finished");
    expect(serialized).toContain("response-id-only");
    expect(serialized).toContain("statusCode");
    expect(serialized).not.toContain("private patch content");
    expect(serialized).not.toContain("private api response text");
    expect(serialized).not.toContain("private json output");
    expect(serialized).not.toContain("private http body");
    expect(serialized).not.toContain("id-token-secret-value");
    expect(serialized).not.toContain("diff --git");
    expect(serialized).not.toContain("secret");
  });

  it("redacts provider token, base64, and split PEM shapes from raw evidence values", async () => {
    const anthropicToken = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234567890";
    const googleToken = "ya29.a0AfH6SMDabcdefghijklmnopqrstuvwxyz1234567890";
    const base64Blob = "VGhpcy1sb29rcy1saWtlLWVuY29kZWQtcHJvdmlkZXItZXZpZGVuY2UtdGhhdC1zaG91bGQtYmUtcmVkYWN0ZWQ=";
    const result = await runProviderAdapterFixture({
      adapter: {
        id: "fixture-openai-compatible",
        async execute() {
          return {
            text: '{"findings":[]}',
            rawEvidence: {
              providerText: `anthropic ${anthropicToken}`,
              googleText: `google ${googleToken}`,
              encodedPayload: base64Blob,
              pemParts: ["-----BEGIN ", "PRIVATE KEY-----", "abc123", "-----END PRIVATE KEY-----"]
            }
          };
        }
      },
      fixture: makeFixture({ id: "provider-token-raw-evidence-fixture" })
    });

    const serialized = JSON.stringify(result);
    expect(result.ok).toBe(true);
    expect(serialized).toContain("[redacted-secret]");
    expect(serialized).not.toContain(anthropicToken);
    expect(serialized).not.toContain(googleToken);
    expect(serialized).not.toContain(base64Blob);
    expect(serialized).not.toContain("PRIVATE KEY");
  });

  it("preserves benign long hashes and request ids while redacting high-risk base64 blobs", async () => {
    const sha256Hex = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const requestId = "req_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    const base64Blob = "VGhpcy1sb29rcy1saWtlLWVuY29kZWQtcHJvdmlkZXItZXZpZGVuY2UtdGhhdC1zaG91bGQtYmUtcmVkYWN0ZWQ=";
    const result = await runProviderAdapterFixture({
      adapter: {
        id: "fixture-openai-compatible",
        async execute() {
          return {
            text: '{"findings":[]}',
            rawEvidence: {
              sha256Hex,
              requestId,
              encodedPayload: base64Blob
            }
          };
        }
      },
      fixture: makeFixture({ id: "benign-long-id-raw-evidence-fixture" })
    });

    const serialized = JSON.stringify(result);
    expect(result.ok).toBe(true);
    expect(serialized).toContain(sha256Hex);
    expect(serialized).toContain(requestId);
    expect(serialized).toContain("[redacted-secret]");
    expect(serialized).not.toContain(base64Blob);
  });

  it("does not throw when raw evidence contains non-json primitives", async () => {
    const result = await runProviderAdapterFixture({
      adapter: {
        id: "fixture-openai-compatible",
        async execute() {
          return {
            text: '{"findings":[]}',
            rawEvidence: {
              bigint: BigInt(1),
              missing: undefined,
              notANumber: Number.NaN,
              positiveInfinity: Number.POSITIVE_INFINITY
            }
          };
        }
      },
      fixture: makeFixture({ id: "non-json-raw-evidence-fixture" })
    });

    expect(result).toMatchObject({
      ok: true,
      evidence: {
        rawEvidencePreview: "[redacted-unserializable-evidence]"
      }
    });
  });

  it("redacts root-level array raw evidence", async () => {
    const result = await runProviderAdapterFixture({
      adapter: {
        id: "fixture-openai-compatible",
        async execute(input) {
          return {
            text: '{"findings":[]}',
            rawEvidence: [
              "public marker",
              input.prompt,
              "diff --git a/private.ts b/private.ts\n@@ -1 +1 @@\n-secret\n+fixed"
            ]
          };
        }
      },
      fixture: makeFixture({ id: "array-raw-evidence-fixture" })
    });

    const serialized = JSON.stringify(result);
    expect(result.ok).toBe(true);
    expect(serialized).toContain("public marker");
    expect(serialized).toContain("[redacted-private-evidence]");
    expect(serialized).not.toContain("private patch content");
    expect(serialized).not.toContain("diff --git");
  });
});

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function makeFixture(overrides: Partial<{
  id: string;
  providerId: string;
  adapterId: string;
  model: string;
  prompt: string;
  expectJsonObject: boolean;
}> = {}) {
  return {
    id: "fixture",
    providerId: "openai-compatible",
    adapterId: "openai-compatible",
    model: "review-model",
    prompt: "Review this private patch content before posting a comment.",
    ...overrides
  };
}
