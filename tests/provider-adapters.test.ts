import { describe, expect, it } from "vitest";
import {
  classifyProviderAdapterError,
  runProviderAdapterFixture,
  type ProviderRuntimeAdapter
} from "../src/provider-adapters.js";

describe("provider adapter fixtures", () => {
  it("runs adapter fixtures deterministically without exposing prompt text or secrets in evidence", async () => {
    const adapter: ProviderRuntimeAdapter = {
      id: "fixture-openai-compatible",
      async execute(input) {
        expect(input.fixtureId).toBe("review-json-fixture");
        expect(input.prompt).toContain("private patch content");
        return {
          text: '{"findings":[]}',
          rawEvidence: {
            echoedPrompt: input.prompt,
            providerUrl: "https://gateway.example.test/v1?api_key=secret-provider-key-123456",
            authorization: "Bearer provider-secret-1234567890"
          }
        };
      }
    };

    const fixture = {
      id: "review-json-fixture",
      providerId: "openai-compatible",
      adapterId: "openai-compatible",
      model: "review-model",
      prompt: "Review this private patch content with sk-live-secret-secret.",
      expectJsonObject: true
    };

    const first = await runProviderAdapterFixture({ adapter, fixture });
    const second = await runProviderAdapterFixture({ adapter, fixture });

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
    expect(serialized).toContain("[redacted-secret]");
  });

  it("classifies adapter runtime errors into provider-safe categories with redacted evidence", async () => {
    expect(classifyProviderAdapterError("401 invalid api key")).toBe("auth");
    expect(classifyProviderAdapterError("429 rate limit exceeded")).toBe("throttle");
    expect(classifyProviderAdapterError("ECONNRESET from gateway")).toBe("network");
    expect(classifyProviderAdapterError("request timed out")).toBe("timeout");
    expect(classifyProviderAdapterError("model returned malformed JSON")).toBe("model-output");

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
        message: expect.stringContaining("[redacted-secret]")
      }
    });
    expect(JSON.stringify(result)).not.toContain("provider-secret-1234567890");
  });

  it("marks schema failures as model-output without preserving raw invalid output", async () => {
    const result = await runProviderAdapterFixture({
      adapter: {
        id: "fixture-openai-compatible",
        async execute() {
          return {
            text: "not json with leaked token sk-live-secret-secret"
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
        outputPreview: "not json with leaked token [redacted-secret]"
      }
    });
    expect(JSON.stringify(result)).not.toContain("sk-live-secret-secret");
  });
});
