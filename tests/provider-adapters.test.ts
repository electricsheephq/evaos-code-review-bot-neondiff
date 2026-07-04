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
      b: 2,
      a: 1
    });
    const secondAdapter = makeAdapter({
      a: 1,
      b: 2,
      authorization: "Bearer provider-secret-1234567890",
      providerUrl: "https://gateway.example.test/v1?api_key=secret-provider-key-123456",
      note: "Review this private patch content with sk-live-secret-secret.",
      echoedPrompt: "Review this private patch content with sk-live-secret-secret."
    });

    const fixture = {
      id: "review-json-fixture",
      providerId: "openai-compatible",
      adapterId: "openai-compatible",
      model: "review-model",
      prompt: "Review this private patch content with sk-live-secret-secret.",
      expectJsonObject: true
    };

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
        outputSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        outputPreview: '{"findings":[]}'
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
    const fixture = {
      id: "runtime-private-error-fixture",
      providerId: "openai-compatible",
      adapterId: "openai-compatible",
      model: "review-model",
      prompt: "Review this private patch content before posting a comment.",
      expectJsonObject: true
    };
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

  it("hashes redacted provider output instead of raw private output", async () => {
    const fixture = {
      id: "private-output-fixture",
      providerId: "openai-compatible",
      adapterId: "openai-compatible",
      model: "review-model",
      prompt: "Review this private patch content before posting a comment."
    };
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
    expect(result.evidence.outputSha256).toBe(sha256("[redacted-private-evidence]"));
    expect(result.evidence.outputSha256).not.toBe(sha256("Review this private patch content before posting a comment."));
  });

  it("classifies adapter runtime errors into provider-safe categories with redacted evidence", async () => {
    expect(classifyProviderAdapterError("401 invalid api key")).toBe("auth");
    expect(classifyProviderAdapterError("429 rate limit exceeded")).toBe("throttle");
    expect(classifyProviderAdapterError("rate-limit exceeded")).toBe("throttle");
    expect(classifyProviderAdapterError("ECONNRESET from gateway")).toBe("network");
    expect(classifyProviderAdapterError("request timed out")).toBe("timeout");
    expect(classifyProviderAdapterError("request timed-out")).toBe("timeout");
    expect(classifyProviderAdapterError("model returned malformed JSON")).toBe("model-output");
    expect(classifyProviderAdapterError("network reachable but returned unexpected json")).toBe("network");

    const fixture = {
      id: "runtime-error-fixture",
      providerId: "openai-compatible",
      adapterId: "openai-compatible",
      model: "review-model",
      prompt: "Prompt containing provider-secret-1234567890",
      expectJsonObject: true
    };

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
      fixture: {
        id: "invalid-json-fixture",
        providerId: "openai-compatible",
        adapterId: "openai-compatible",
        model: "review-model",
        prompt: "review patch",
        expectJsonObject: true
      }
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
    const fixture = {
      id: "raw-evidence-fixture",
      providerId: "openai-compatible",
      adapterId: "openai-compatible",
      model: "review-model",
      prompt: "Review this private patch content before posting a comment.",
      expectJsonObject: true
    };

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
                harmless: true
              },
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
    expect(serialized).toContain("adapter fixture");
    expect(serialized).not.toContain("private patch content");
    expect(serialized).not.toContain("diff --git");
    expect(serialized).not.toContain("secret");
  });
});

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
