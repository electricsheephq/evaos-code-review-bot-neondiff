import { describe, expect, it } from "vitest";
import { loadConfigFromObject } from "../src/config.js";
import {
  buildProviderRegistrySummary,
  classifyProviderError,
  doctorProviderRegistry,
  redactProviderUrl
} from "../src/providers.js";

describe("provider registry", () => {
  it("loads safe default providers and doctors only enabled/default entries by default", async () => {
    const config = loadConfigFromObject({});
    const summary = buildProviderRegistrySummary({
      registry: config.providers!,
      currentZCode: {
        providerId: config.zcode.providerId,
        model: config.zcode.model
      }
    });

    expect(summary.defaultProviderId).toBe("zcode-glm");
    expect(summary.providers.map((provider) => provider.id)).toEqual(
      expect.arrayContaining(["zcode-glm", "ollama-local", "openai-compatible", "anthropic", "openai", "gemini"])
    );
    expect(summary.providers.find((provider) => provider.id === "zcode-glm")).toMatchObject({
      enabled: true,
      adapter: "zcode",
      authMode: "zcode-app-config",
      currentRuntime: true
    });
    expect(summary.providers.find((provider) => provider.id === "openai-compatible")).toMatchObject({
      authMode: "api-key-env",
      apiKeyEnv: "NEONDIFF_PROVIDER_API_KEY"
    });

    const doctor = await doctorProviderRegistry({ registry: config.providers! });
    expect(doctor).toMatchObject({
      ok: true,
      command: "providers doctor",
      defaultProviderId: "zcode-glm"
    });
    expect(doctor.checks).toHaveLength(1);
    expect(doctor.checks[0]).toMatchObject({
      providerId: "zcode-glm",
      ok: true,
      smokeAttempted: false,
      readMode: "metadata_only"
    });
  });

  it("smokes an OpenAI-compatible provider with an environment-backed bearer token", async () => {
    const config = loadConfigFromObject({
      providers: {
        defaultProviderId: "openai-compatible",
        providers: {
          "openai-compatible": {
            enabled: true,
            baseUrl: "https://gateway.example.test/v1?token=do-not-leak",
            model: "review-model",
            authMode: "api-key-env",
            apiKeyEnv: "NEONDIFF_PROVIDER_API_KEY"
          }
        }
      }
    });
    const fetchImpl: typeof fetch = async (url, init) => {
      expect(String(url)).toBe("https://gateway.example.test/v1/models?token=do-not-leak");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer provider-secret");
      return new Response(JSON.stringify({ data: [{ id: "review-model" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    };

    const result = await doctorProviderRegistry({
      registry: config.providers!,
      providerId: "openai-compatible",
      smoke: true,
      fetchImpl,
      env: {
        NEONDIFF_PROVIDER_API_KEY: "provider-secret"
      }
    });

    expect(result.ok).toBe(true);
    expect(result.checks[0]).toMatchObject({
      providerId: "openai-compatible",
      ok: true,
      smokeAttempted: true,
      readMode: "openai_compatible_models",
      baseUrl: "https://gateway.example.test/v1?token=%5Bredacted-secret%5D",
      apiKeyEnv: "NEONDIFF_PROVIDER_API_KEY",
      modelCount: 1
    });
    expect(JSON.stringify(result)).not.toContain("provider-secret");
    expect(JSON.stringify(result)).not.toContain("do-not-leak");
  });

  it("classifies provider failures and redacts provider URLs", () => {
    expect(classifyProviderError("401 invalid api key")).toBe("auth");
    expect(classifyProviderError("429 too many requests")).toBe("quota_or_rate_limit");
    expect(classifyProviderError("spawnSync ETIMEDOUT")).toBe("timeout");
    expect(classifyProviderError("maximum context length exceeded")).toBe("context_limit");
    expect(classifyProviderError("malformed JSON schema output")).toBe("model_output_schema");
    expect(classifyProviderError("503 service unavailable")).toBe("transient");
    expect(classifyProviderError("something else")).toBe("unknown");

    expect(redactProviderUrl("https://user:pass@example.test/v1?api_key=secret&safe=1")).toBe(
      "https://%5Bredacted%5D:%5Bredacted-secret%5D@example.test/v1?api_key=%5Bredacted-secret%5D&safe=1"
    );
  });

  it("rejects unsafe enabled provider config", () => {
    expect(() => loadConfigFromObject({
      providers: {
        defaultProviderId: "remote-http",
        providers: {
          "remote-http": {
            enabled: true,
            adapter: "openai-compatible",
            baseUrl: "http://example.test/v1",
            model: "review-model",
            authMode: "none",
            capabilities: {
              review: true,
              jsonOutput: true,
              local: false,
              streaming: false
            }
          }
        }
      }
    })).toThrow(/must use https unless it points to localhost\/loopback/);

    expect(() => loadConfigFromObject({
      providers: {
        defaultProviderId: "needs-key",
        providers: {
          "needs-key": {
            enabled: true,
            adapter: "openai-compatible",
            baseUrl: "https://gateway.example.test/v1",
            model: "review-model",
            authMode: "api-key-env",
            capabilities: {
              review: true,
              jsonOutput: true,
              local: false,
              streaming: false
            }
          }
        }
      }
    })).toThrow(/apiKeyEnv is required/);
  });
});
