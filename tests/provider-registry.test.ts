import { describe, expect, it } from "vitest";
import { loadConfigFromObject } from "../src/config.js";
import {
  buildProviderRegistrySummary,
  classifyProviderError,
  doctorProviderRegistry,
  isProviderId,
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
    const secondZCode = buildProviderRegistrySummary({
      registry: {
        ...config.providers!,
        providers: {
          ...config.providers!.providers,
          "zcode-glm-canary": {
            ...config.providers!.providers["zcode-glm"],
            enabled: false
          }
        }
      },
      currentZCode: {
        model: "GLM-5.2"
      }
    });
    expect(secondZCode.providers.find((provider) => provider.id === "zcode-glm")).toMatchObject({ currentRuntime: true });
    expect(secondZCode.providers.find((provider) => provider.id === "zcode-glm-canary")).toMatchObject({ currentRuntime: false });

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
            baseUrl: "https://gateway.example.test/v1",
            model: "review-model",
            authMode: "api-key-env",
            apiKeyEnv: "NEONDIFF_PROVIDER_API_KEY"
          }
        }
      }
    });
    const fetchImpl: typeof fetch = async (url, init) => {
      expect(String(url)).toBe("https://gateway.example.test/v1/models");
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
      baseUrl: "https://gateway.example.test/v1",
      apiKeyEnv: "NEONDIFF_PROVIDER_API_KEY",
      modelCount: 1
    });
    expect(JSON.stringify(result)).not.toContain("provider-secret");
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
    expect(isProviderId("openai-compatible")).toBe(true);
    expect(isProviderId("sk-live-secret-secret")).toBe(false);
  });

  it("reports HTTP and thrown smoke failures with category and redacted detail", async () => {
    const config = loadConfigFromObject({
      providers: {
        defaultProviderId: "openai-compatible",
        providers: {
          "openai-compatible": {
            enabled: true,
            model: "review-model",
            authMode: "none",
            baseUrl: "https://gateway.example.test/v1"
          }
        }
      }
    });

    const httpResult = await doctorProviderRegistry({
      registry: config.providers!,
      providerId: "openai-compatible",
      smoke: true,
      fetchImpl: async () => new Response("temporary provider overload", { status: 503 })
    });
    expect(httpResult.checks[0]).toMatchObject({
      ok: false,
      errorCategory: "transient",
      error: expect.stringContaining("OpenAI-compatible models endpoint returned 503")
    });

    const thrownResult = await doctorProviderRegistry({
      registry: config.providers!,
      providerId: "openai-compatible",
      smoke: true,
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED http://token-secret@example.test");
      }
    });
    expect(thrownResult.checks[0]).toMatchObject({
      ok: false,
      errorCategory: "transient",
      error: expect.stringContaining("transient:")
    });
    expect(JSON.stringify(thrownResult)).not.toContain("token-secret");
  });

  it("fails smoke when the configured model is not advertised", async () => {
    const config = loadConfigFromObject({
      providers: {
        defaultProviderId: "openai-compatible",
        providers: {
          "openai-compatible": {
            enabled: true,
            model: "wanted-model",
            authMode: "none",
            baseUrl: "https://gateway.example.test/v1"
          }
        }
      }
    });

    const result = await doctorProviderRegistry({
      registry: config.providers!,
      providerId: "openai-compatible",
      smoke: true,
      fetchImpl: async () => new Response(JSON.stringify({ data: [{ id: "other-model" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      })
    });

    expect(result.checks[0]).toMatchObject({
      ok: false,
      modelCount: 1,
      errorCategory: "model_output_schema",
      error: "Models response did not advertise configured model wanted-model."
    });
  });

  it("fails provider doctor for providers that cannot review JSON", async () => {
    const config = loadConfigFromObject({
      providers: {
        defaultProviderId: "anthropic",
        providers: {
          anthropic: {
            enabled: true,
            capabilities: {
              review: false
            }
          }
        }
      }
    });

    const result = await doctorProviderRegistry({
      registry: config.providers!,
      providerId: "anthropic"
    });

    expect(result).toMatchObject({
      ok: false,
      checks: [
        expect.objectContaining({
          providerId: "anthropic",
          ok: false,
          error: "Provider is not review-capable."
        })
      ],
      troubleshooting: [
        "Provider anthropic must support review and JSON output before it can be selected for review."
      ]
    });
  });

  it("aborts OpenAI-compatible smoke checks using provider timeoutMs", async () => {
    const config = loadConfigFromObject({
      providers: {
        defaultProviderId: "ollama-local",
        providers: {
          "ollama-local": {
            enabled: true,
            timeoutMs: 1
          }
        }
      }
    });
    const fetchImpl: typeof fetch = async (_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("The operation was aborted.")), { once: true });
    });

    const result = await doctorProviderRegistry({
      registry: config.providers!,
      providerId: "ollama-local",
      smoke: true,
      fetchImpl
    });

    expect(result.checks[0]).toMatchObject({
      ok: false,
      errorCategory: "timeout",
      error: expect.stringContaining("timeout:")
    });
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

    expect(() => loadConfigFromObject({
      providers: {
        defaultProviderId: "leaky-url",
        providers: {
          "leaky-url": {
            enabled: true,
            adapter: "openai-compatible",
            baseUrl: "https://user:password@gateway.example.test/v1",
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
    })).toThrow(/must not include username or password credentials/);

    expect(() => loadConfigFromObject({
      providers: {
        defaultProviderId: "leaky-query",
        providers: {
          "leaky-query": {
            enabled: true,
            adapter: "openai-compatible",
            baseUrl: "https://gateway.example.test/v1?api_key=short",
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
    })).toThrow(/must not include credential query parameters/);

    expect(() => loadConfigFromObject({
      providers: {
        defaultProviderId: "secret-env",
        providers: {
          "secret-env": {
            enabled: true,
            adapter: "openai-compatible",
            baseUrl: "https://gateway.example.test/v1",
            model: "review-model",
            authMode: "api-key-env",
            apiKeyEnv: "ghp_123456789012345678901234567890123456",
            capabilities: {
              review: true,
              jsonOutput: true,
              local: false,
              streaming: false
            }
          }
        }
      }
    })).toThrow(/apiKeyEnv must be an uppercase environment variable name, not a provider key/);

    expect(() => loadConfigFromObject({
      providers: {
        defaultProviderId: "zcode-bad",
        providers: {
          "zcode-bad": {
            enabled: true,
            adapter: "zcode",
            model: "GLM-5.2",
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
    })).toThrow(/authMode none is not supported for zcode provider/);
  });
});
