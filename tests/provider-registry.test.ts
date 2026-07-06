import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { loadConfigFromObject } from "../src/config.js";
import {
  buildOpenAIModelsUrl,
  buildProviderRegistrySummary,
  classifyProviderError,
  doctorProviderRegistry,
  isProviderId,
  type ProviderSmokeRequestImpl,
  type ProviderSmokeRequestOptions,
  redactProviderUrl
} from "../src/providers.js";

class MockProviderClientRequest extends EventEmitter {
  ended = false;
  destroyedWith?: Error;

  end(): this {
    this.ended = true;
    return this;
  }

  destroy(error?: Error): this {
    this.destroyedWith = error;
    if (error) this.emit("error", error);
    return this;
  }
}

class MockProviderIncomingMessage extends EventEmitter {
  statusCode?: number;
  statusMessage?: string;
  headers: Record<string, string | string[] | undefined>;

  constructor(input: {
    status: number;
    body: string;
    headers?: Record<string, string | string[] | undefined>;
    responseError?: Error;
  }) {
    super();
    this.statusCode = input.status;
    this.statusMessage = String(input.status);
    this.headers = input.headers ?? {};
    queueMicrotask(() => {
      if (input.responseError) {
        this.emit("error", input.responseError);
        return;
      }
      this.emit("data", Buffer.from(input.body));
      this.emit("end");
    });
  }
}

function mockProviderRequest(response: {
  status: number;
  body: string;
  headers?: Record<string, string | string[] | undefined>;
  responseError?: Error;
  onOptions?: (options: ProviderSmokeRequestOptions) => void;
}): ProviderSmokeRequestImpl {
  return (options, onResponse) => {
    response.onOptions?.(options);
    const request = new MockProviderClientRequest();
    queueMicrotask(() => onResponse(new MockProviderIncomingMessage(response) as IncomingMessage));
    return request;
  };
}

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
    const zcodeRuntimeWithAlternateDefault = buildProviderRegistrySummary({
      registry: {
        ...config.providers!,
        defaultProviderId: "ollama-local"
      },
      currentZCode: {
        model: config.zcode.model
      }
    });
    expect(zcodeRuntimeWithAlternateDefault.providers.find((provider) => provider.id === "zcode-glm")).toMatchObject({ currentRuntime: true });
    expect(zcodeRuntimeWithAlternateDefault.providers.find((provider) => provider.id === "ollama-local")).toMatchObject({ currentRuntime: false });

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
            baseUrl: "http://127.0.0.1:8080/v1",
            model: "review-model",
            authMode: "api-key-env",
            apiKeyEnv: "NEONDIFF_PROVIDER_API_KEY",
            capabilities: {
              review: true,
              jsonOutput: true,
              local: true,
              streaming: false
            }
          }
        }
      }
    });
    const fetchImpl: typeof fetch = async (url, init) => {
      expect(String(url)).toBe("http://127.0.0.1:8080/v1/models");
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
      baseUrl: "http://127.0.0.1:8080/v1",
      apiKeyEnv: "NEONDIFF_PROVIDER_API_KEY",
      modelCount: 1
    });
    expect(JSON.stringify(result)).not.toContain("provider-secret");
  });

  it("denies hosted remote OpenAI-compatible smoke by default even with a selected provider", async () => {
    const config = loadConfigFromObject({
      providers: {
        defaultProviderId: "hosted-byok",
        providers: {
          "hosted-byok": {
            enabled: true,
            adapter: "openai-compatible",
            baseUrl: "https://gateway.example.test/v1",
            model: "review-model",
            authMode: "api-key-env",
            apiKeyEnv: "NEONDIFF_PROVIDER_API_KEY",
            capabilities: {
              review: true,
              jsonOutput: true,
              local: false,
              streaming: false
            }
          }
        }
      }
    });
    let fetchCalls = 0;
    let dnsCalls = 0;

    const result = await doctorProviderRegistry({
      registry: config.providers!,
      providerId: "hosted-byok",
      smoke: true,
      fetchImpl: async () => {
        fetchCalls += 1;
        return new Response(JSON.stringify({ data: [] }));
      },
      dnsLookupImpl: async () => {
        dnsCalls += 1;
        return [{ address: "93.184.216.34", family: 4 }];
      },
      env: {
        NEONDIFF_PROVIDER_API_KEY: "provider-secret"
      }
    });

    expect(result.checks[0]).toMatchObject({
      ok: false,
      smokeAttempted: true,
      readMode: "openai_compatible_models",
      error: "Remote OpenAI-compatible smoke checks require explicit remote opt-in and --provider <id>."
    });
    expect(fetchCalls).toBe(0);
    expect(dnsCalls).toBe(0);
    expect(JSON.stringify(result)).not.toContain("provider-secret");
  });

  it("allows explicitly opted-in hosted BYOK smoke through DNS-pinned transport", async () => {
    const config = loadConfigFromObject({
      providers: {
        defaultProviderId: "hosted-byok",
        providers: {
          "hosted-byok": {
            enabled: true,
            adapter: "openai-compatible",
            baseUrl: "https://gateway.example.test/v1",
            model: "review-model",
            authMode: "api-key-env",
            apiKeyEnv: "NEONDIFF_PROVIDER_API_KEY",
            capabilities: {
              review: true,
              jsonOutput: true,
              local: false,
              streaming: false
            }
          }
        }
      }
    });
    const dnsCalls: string[] = [];
    const requestOptions: ProviderSmokeRequestOptions[] = [];

    const result = await doctorProviderRegistry({
      registry: config.providers!,
      providerId: "hosted-byok",
      smoke: true,
      allowRemoteSmoke: true,
      dnsLookupImpl: async (hostname) => {
        dnsCalls.push(hostname);
        return [{ address: "93.184.216.34", family: 4 }];
      },
      fetchImpl: async () => {
        throw new Error("remote smoke must not use fetch");
      },
      requestImpl: mockProviderRequest({
        status: 200,
        body: JSON.stringify({ data: [{ id: "review-model" }] }),
        headers: { "Content-Type": "application/json" },
        onOptions: (options) => {
          requestOptions.push(options);
        }
      }),
      env: {
        NEONDIFF_PROVIDER_API_KEY: "provider-secret"
      }
    });

    expect(result.ok).toBe(true);
    expect(result.checks[0]).toMatchObject({
      providerId: "hosted-byok",
      ok: true,
      smokeAttempted: true,
      readMode: "openai_compatible_models",
      baseUrl: "https://gateway.example.test/v1",
      apiKeyEnv: "NEONDIFF_PROVIDER_API_KEY",
      modelCount: 1
    });
    expect(dnsCalls).toEqual(["gateway.example.test"]);
    expect(requestOptions).toHaveLength(1);
    expect(requestOptions[0]).toMatchObject({
      protocol: "https:",
      hostname: "gateway.example.test",
      path: "/v1/models",
      method: "GET",
      servername: "gateway.example.test"
    });
    expect(requestOptions[0].headers).toMatchObject({
      accept: "application/json",
      authorization: "Bearer provider-secret"
    });
    let pinnedLookup: { address?: string; family?: number } = {};
    requestOptions[0].lookup?.("gateway.example.test", {}, (error, address, family) => {
      expect(error).toBeNull();
      pinnedLookup = { address, family };
    });
    expect(pinnedLookup).toEqual({ address: "93.184.216.34", family: 4 });
    expect(JSON.stringify(result)).not.toContain("provider-secret");
  });

  it("allows hosted BYOK smoke through an explicit environment opt-in", async () => {
    const config = loadConfigFromObject({
      providers: {
        defaultProviderId: "hosted-byok",
        providers: {
          "hosted-byok": {
            enabled: true,
            adapter: "openai-compatible",
            baseUrl: "https://gateway.example.test/v1",
            model: "review-model",
            authMode: "api-key-env",
            apiKeyEnv: "NEONDIFF_PROVIDER_API_KEY",
            capabilities: {
              review: true,
              jsonOutput: true,
              local: false,
              streaming: false
            }
          }
        }
      }
    });

    const result = await doctorProviderRegistry({
      registry: config.providers!,
      providerId: "hosted-byok",
      smoke: true,
      dnsLookupImpl: async () => [{ address: "93.184.216.34", family: 4 }],
      fetchImpl: async () => {
        throw new Error("remote smoke must not use fetch");
      },
      requestImpl: mockProviderRequest({
        status: 200,
        body: JSON.stringify({ data: [{ id: "review-model" }] }),
        headers: { "Content-Type": "application/json" }
      }),
      env: {
        NEONDIFF_ALLOW_REMOTE_SMOKE: "true",
        NEONDIFF_PROVIDER_API_KEY: "provider-secret"
      }
    });

    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain("provider-secret");
  });

  it("requires hosted remote smoke to be env-key-backed before DNS or fetch", async () => {
    const config = loadConfigFromObject({
      providers: {
        defaultProviderId: "hosted-byok",
        providers: {
          "hosted-byok": {
            enabled: true,
            adapter: "openai-compatible",
            baseUrl: "https://gateway.example.test/v1",
            model: "review-model",
            authMode: "api-key-env",
            apiKeyEnv: "NEONDIFF_PROVIDER_API_KEY",
            capabilities: {
              review: true,
              jsonOutput: true,
              local: false,
              streaming: false
            }
          }
        }
      }
    });
    let fetchCalls = 0;
    let dnsCalls = 0;

    const missingEnv = await doctorProviderRegistry({
      registry: config.providers!,
      providerId: "hosted-byok",
      smoke: true,
      allowRemoteSmoke: true,
      fetchImpl: async () => {
        fetchCalls += 1;
        return new Response(JSON.stringify({ data: [] }));
      },
      dnsLookupImpl: async () => {
        dnsCalls += 1;
        return [{ address: "93.184.216.34", family: 4 }];
      },
      env: {}
    });

    expect(missingEnv.checks[0]).toMatchObject({
      ok: false,
      error: "Missing API key environment variable NEONDIFF_PROVIDER_API_KEY."
    });

    const noneAuthProvider = {
      ...config.providers!.providers["hosted-byok"],
      authMode: "none" as const
    };
    delete noneAuthProvider.apiKeyEnv;
    const noneAuth = await doctorProviderRegistry({
      registry: {
        ...config.providers!,
        providers: {
          "hosted-byok": noneAuthProvider
        }
      },
      providerId: "hosted-byok",
      smoke: true,
      allowRemoteSmoke: true,
      fetchImpl: async () => {
        fetchCalls += 1;
        return new Response(JSON.stringify({ data: [] }));
      },
      dnsLookupImpl: async () => {
        dnsCalls += 1;
        return [{ address: "93.184.216.34", family: 4 }];
      },
      env: {}
    });

    expect(noneAuth.checks[0]).toMatchObject({
      ok: false,
      error: "Hosted remote smoke requires authMode api-key-env and apiKeyEnv."
    });
    expect(fetchCalls).toBe(0);
    expect(dnsCalls).toBe(0);
  });

  it("rejects hosted remote DNS resolutions to unsafe networks before fetch", async () => {
    const config = loadConfigFromObject({
      providers: {
        defaultProviderId: "hosted-byok",
        providers: {
          "hosted-byok": {
            enabled: true,
            adapter: "openai-compatible",
            baseUrl: "https://gateway.example.test/v1",
            model: "review-model",
            authMode: "api-key-env",
            apiKeyEnv: "NEONDIFF_PROVIDER_API_KEY",
            capabilities: {
              review: true,
              jsonOutput: true,
              local: false,
              streaming: false
            }
          }
        }
      }
    });
    let fetchCalls = 0;

    const result = await doctorProviderRegistry({
      registry: config.providers!,
      providerId: "hosted-byok",
      smoke: true,
      allowRemoteSmoke: true,
      fetchImpl: async () => {
        fetchCalls += 1;
        return new Response(JSON.stringify({ data: [] }));
      },
      dnsLookupImpl: async () => [{ address: "10.0.0.25", family: 4 }],
      env: {
        NEONDIFF_PROVIDER_API_KEY: "provider-secret"
      }
    });

    expect(result.checks[0]).toMatchObject({
      ok: false,
      error: "Remote OpenAI-compatible smoke DNS resolved to an unsafe private, link-local, loopback, or metadata address."
    });
    expect(fetchCalls).toBe(0);
    expect(JSON.stringify(result)).not.toContain("provider-secret");
  });

  it("fails hosted remote DNS lookup closed on provider timeout", async () => {
    const config = loadConfigFromObject({
      providers: {
        defaultProviderId: "hosted-byok",
        providers: {
          "hosted-byok": {
            enabled: true,
            adapter: "openai-compatible",
            baseUrl: "https://gateway.example.test/v1",
            model: "review-model",
            authMode: "api-key-env",
            apiKeyEnv: "NEONDIFF_PROVIDER_API_KEY",
            timeoutMs: 1,
            capabilities: {
              review: true,
              jsonOutput: true,
              local: false,
              streaming: false
            }
          }
        }
      }
    });
    let requestCalls = 0;

    const result = await doctorProviderRegistry({
      registry: config.providers!,
      providerId: "hosted-byok",
      smoke: true,
      allowRemoteSmoke: true,
      dnsLookupImpl: async () => new Promise(() => {}),
      requestImpl: mockProviderRequest({
        status: 200,
        body: "{}",
        onOptions: () => {
          requestCalls += 1;
        }
      }),
      env: {
        NEONDIFF_PROVIDER_API_KEY: "provider-secret"
      }
    });

    expect(result.checks[0]).toMatchObject({
      ok: false,
      error: "Remote OpenAI-compatible smoke DNS lookup timed out."
    });
    expect(requestCalls).toBe(0);
    expect(JSON.stringify(result)).not.toContain("provider-secret");
  });

  it("redacts hosted remote DNS lookup failures before request", async () => {
    const config = loadConfigFromObject({
      providers: {
        defaultProviderId: "hosted-byok",
        providers: {
          "hosted-byok": {
            enabled: true,
            adapter: "openai-compatible",
            baseUrl: "https://gateway.example.test/v1",
            model: "review-model",
            authMode: "api-key-env",
            apiKeyEnv: "NEONDIFF_PROVIDER_API_KEY",
            capabilities: {
              review: true,
              jsonOutput: true,
              local: false,
              streaming: false
            }
          }
        }
      }
    });
    let requestCalls = 0;

    const result = await doctorProviderRegistry({
      registry: config.providers!,
      providerId: "hosted-byok",
      smoke: true,
      allowRemoteSmoke: true,
      dnsLookupImpl: async () => {
        throw new Error("lookup failed for sk-testsecret12345");
      },
      requestImpl: mockProviderRequest({
        status: 200,
        body: "{}",
        onOptions: () => {
          requestCalls += 1;
        }
      }),
      env: {
        NEONDIFF_PROVIDER_API_KEY: "provider-secret"
      }
    });

    expect(result.checks[0]).toMatchObject({
      ok: false,
      error: "Remote OpenAI-compatible smoke DNS lookup failed: lookup failed for [redacted-secret]"
    });
    expect(requestCalls).toBe(0);
    expect(JSON.stringify(result)).not.toContain("sk-testsecret12345");
    expect(JSON.stringify(result)).not.toContain("provider-secret");
  });

  it("fails hosted remote DNS edge cases closed before request", async () => {
    const config = loadConfigFromObject({
      providers: {
        defaultProviderId: "hosted-byok",
        providers: {
          "hosted-byok": {
            enabled: true,
            adapter: "openai-compatible",
            baseUrl: "https://gateway.example.test/v1",
            model: "review-model",
            authMode: "api-key-env",
            apiKeyEnv: "NEONDIFF_PROVIDER_API_KEY",
            capabilities: {
              review: true,
              jsonOutput: true,
              local: false,
              streaming: false
            }
          }
        }
      }
    });
    const scenarios = [
      {
        addresses: [],
        error: "Remote OpenAI-compatible smoke DNS lookup returned no addresses."
      },
      {
        addresses: [{ address: "203.0.113.10", family: 0 }],
        error: "Remote OpenAI-compatible smoke DNS lookup returned no IPv4 or IPv6 addresses."
      },
      {
        addresses: [
          { address: "93.184.216.34", family: 4 },
          { address: "169.254.169.254", family: 4 }
        ],
        error: "Remote OpenAI-compatible smoke DNS resolved to an unsafe private, link-local, loopback, or metadata address."
      }
    ];

    for (const scenario of scenarios) {
      let requestCalls = 0;
      const result = await doctorProviderRegistry({
        registry: config.providers!,
        providerId: "hosted-byok",
        smoke: true,
        allowRemoteSmoke: true,
        dnsLookupImpl: async () => scenario.addresses,
        requestImpl: mockProviderRequest({
          status: 200,
          body: "{}",
          onOptions: () => {
            requestCalls += 1;
          }
        }),
        env: {
          NEONDIFF_PROVIDER_API_KEY: "provider-secret"
        }
      });

      expect(result.checks[0]).toMatchObject({
        ok: false,
        error: scenario.error
      });
      expect(requestCalls).toBe(0);
      expect(JSON.stringify(result)).not.toContain("provider-secret");
    }
  });

  it("bounds hosted remote pinned transport response bodies", async () => {
    const config = loadConfigFromObject({
      providers: {
        defaultProviderId: "hosted-byok",
        providers: {
          "hosted-byok": {
            enabled: true,
            adapter: "openai-compatible",
            baseUrl: "https://gateway.example.test/v1",
            model: "review-model",
            authMode: "api-key-env",
            apiKeyEnv: "NEONDIFF_PROVIDER_API_KEY",
            capabilities: {
              review: true,
              jsonOutput: true,
              local: false,
              streaming: false
            }
          }
        }
      }
    });
    let requestCalls = 0;

    const result = await doctorProviderRegistry({
      registry: config.providers!,
      providerId: "hosted-byok",
      smoke: true,
      allowRemoteSmoke: true,
      dnsLookupImpl: async () => [{ address: "93.184.216.34", family: 4 }],
      requestImpl: mockProviderRequest({
        status: 200,
        body: "x".repeat(256 * 1024 + 1),
        onOptions: () => {
          requestCalls += 1;
        }
      }),
      env: {
        NEONDIFF_PROVIDER_API_KEY: "provider-secret"
      }
    });

    expect(result.checks[0]).toMatchObject({
      ok: false,
      errorCategory: "model_output_schema",
      error: "Models response exceeded 262144 byte limit."
    });
    expect(requestCalls).toBe(1);
    expect(JSON.stringify(result)).not.toContain("provider-secret");
  });

  it("redacts hosted remote response stream errors", async () => {
    const config = loadConfigFromObject({
      providers: {
        defaultProviderId: "hosted-byok",
        providers: {
          "hosted-byok": {
            enabled: true,
            adapter: "openai-compatible",
            baseUrl: "https://gateway.example.test/v1",
            model: "review-model",
            authMode: "api-key-env",
            apiKeyEnv: "NEONDIFF_PROVIDER_API_KEY",
            capabilities: {
              review: true,
              jsonOutput: true,
              local: false,
              streaming: false
            }
          }
        }
      }
    });

    const result = await doctorProviderRegistry({
      registry: config.providers!,
      providerId: "hosted-byok",
      smoke: true,
      allowRemoteSmoke: true,
      dnsLookupImpl: async () => [{ address: "93.184.216.34", family: 4 }],
      requestImpl: mockProviderRequest({
        status: 200,
        body: "{}",
        responseError: new Error("response reset while using provider-secret")
      }),
      env: {
        NEONDIFF_PROVIDER_API_KEY: "provider-secret"
      }
    });

    expect(result.checks[0]).toMatchObject({
      ok: false,
      errorCategory: "unknown",
      error: "unknown: response reset while using [redacted-provider-key]"
    });
    expect(JSON.stringify(result)).not.toContain("provider-secret");
  });

  it("does not follow hosted remote redirects or read oversized redirect bodies", async () => {
    const config = loadConfigFromObject({
      providers: {
        defaultProviderId: "hosted-byok",
        providers: {
          "hosted-byok": {
            enabled: true,
            adapter: "openai-compatible",
            baseUrl: "https://gateway.example.test/v1",
            model: "review-model",
            authMode: "api-key-env",
            apiKeyEnv: "NEONDIFF_PROVIDER_API_KEY",
            capabilities: {
              review: true,
              jsonOutput: true,
              local: false,
              streaming: false
            }
          }
        }
      }
    });

    const result = await doctorProviderRegistry({
      registry: config.providers!,
      providerId: "hosted-byok",
      smoke: true,
      allowRemoteSmoke: true,
      dnsLookupImpl: async () => [{ address: "93.184.216.34", family: 4 }],
      fetchImpl: async () => {
        throw new Error("remote smoke must not use fetch");
      },
      requestImpl: mockProviderRequest({
        status: 302,
        body: "x".repeat(256 * 1024 + 1),
        headers: {
          Location: "https://redirect.example.test/v1/models"
        }
      }),
      env: {
        NEONDIFF_PROVIDER_API_KEY: "provider-secret"
      }
    });

    expect(result.checks[0]).toMatchObject({
      ok: false,
      error: expect.stringContaining("OpenAI-compatible models endpoint redirected with 302")
    });
    expect(result.checks[0]?.error).toContain("remote smoke does not follow redirects");
    expect(result.checks[0]?.error).not.toContain("exceeded 262144 byte limit");
    expect(JSON.stringify(result)).not.toContain("provider-secret");
    expect(JSON.stringify(result)).not.toContain("xxxxx");
  });

  it("rejects invalid percent-encoded smoke paths without crashing the doctor run", async () => {
    let dnsCalls = 0;

    const result = await doctorProviderRegistry({
      registry: {
        defaultProviderId: "hosted-byok",
        providers: {
          "hosted-byok": {
            enabled: true,
            adapter: "openai-compatible",
            baseUrl: "https://gateway.example.test/v1%",
            model: "review-model",
            authMode: "api-key-env",
            apiKeyEnv: "NEONDIFF_PROVIDER_API_KEY",
            capabilities: {
              review: true,
              jsonOutput: true,
              local: false,
              streaming: false
            }
          }
        }
      },
      providerId: "hosted-byok",
      smoke: true,
      allowRemoteSmoke: true,
      dnsLookupImpl: async () => {
        dnsCalls += 1;
        return [{ address: "93.184.216.34", family: 4 }];
      },
      env: {
        NEONDIFF_PROVIDER_API_KEY: "provider-secret"
      }
    });

    expect(result.checks[0]).toMatchObject({
      ok: false,
      error: "OpenAI-compatible smoke target contains an invalid percent-encoded path or fragment."
    });
    expect(dnsCalls).toBe(0);
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
            authMode: "api-key-env",
            apiKeyEnv: "NEONDIFF_PROVIDER_API_KEY",
            baseUrl: "http://127.0.0.1:8080/v1",
            capabilities: {
              review: true,
              jsonOutput: true,
              local: true,
              streaming: false
            }
          }
        }
      }
    });

    const httpResult = await doctorProviderRegistry({
      registry: config.providers!,
      providerId: "openai-compatible",
      smoke: true,
      fetchImpl: async () => new Response("temporary provider overload for short-provider-key", { status: 503 }),
      env: {
        NEONDIFF_PROVIDER_API_KEY: "short-provider-key"
      }
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
      },
      env: {
        NEONDIFF_PROVIDER_API_KEY: "short-provider-key"
      }
    });
    expect(thrownResult.checks[0]).toMatchObject({
      ok: false,
      errorCategory: "transient",
      error: expect.stringContaining("transient:")
    });
    expect(JSON.stringify(httpResult)).not.toContain("short-provider-key");
    expect(JSON.stringify(httpResult)).toContain("[redacted-provider-key]");
    expect(JSON.stringify(thrownResult)).not.toContain("token-secret");

    const categoryResult = await doctorProviderRegistry({
      registry: config.providers!,
      providerId: "openai-compatible",
      smoke: true,
      fetchImpl: async () => new Response("gateway echoed overload", { status: 400 }),
      env: {
        NEONDIFF_PROVIDER_API_KEY: "overload"
      }
    });
    expect(categoryResult.checks[0]).toMatchObject({
      ok: false,
      errorCategory: "unknown"
    });
    expect(JSON.stringify(categoryResult)).not.toContain("overload");
  });

  it("doctors multiple enabled providers in metadata mode without smoking network endpoints", async () => {
    const config = loadConfigFromObject({
      providers: {
        defaultProviderId: "zcode-glm",
        providers: {
          "zcode-glm": {
            enabled: true
          },
          "openai-compatible": {
            enabled: true,
            baseUrl: "https://gateway.example.test/v1",
            model: "review-model",
            authMode: "api-key-env",
            apiKeyEnv: "NEONDIFF_PROVIDER_API_KEY",
            capabilities: {
              review: true,
              jsonOutput: true,
              local: false,
              streaming: false
            }
          }
        }
      }
    });

    const result = await doctorProviderRegistry({ registry: config.providers! });

    expect(result.ok).toBe(true);
    expect(result.checks.map((check) => check.providerId)).toEqual(["zcode-glm", "openai-compatible"]);
    expect(result.checks.every((check) => check.readMode === "metadata_only" && !check.smokeAttempted)).toBe(true);
  });

  it("requires --provider for smoke to avoid unscoped provider fan-out", async () => {
    const config = loadConfigFromObject({
      providers: {
        defaultProviderId: "ollama-local",
        providers: {
          "ollama-local": {
            enabled: true
          },
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
    let fetchCalls = 0;

    const result = await doctorProviderRegistry({
      registry: config.providers!,
      smoke: true,
      fetchImpl: async () => {
        fetchCalls += 1;
        return new Response(JSON.stringify({ data: [] }));
      },
      env: {
        NEONDIFF_PROVIDER_API_KEY: "provider-secret"
      }
    });

    expect(result).toMatchObject({
      ok: false,
      checks: [],
      troubleshooting: ["--smoke true requires --provider to avoid unscoped provider network fan-out."]
    });
    expect(fetchCalls).toBe(0);
  });

  it("does not reflect unsafe unknown provider ids into doctor output", async () => {
    const config = loadConfigFromObject({});

    const result = await doctorProviderRegistry({
      registry: config.providers!,
      providerId: "sk-live-secret-secret"
    });

    expect(result).toMatchObject({
      ok: false,
      providerId: "[invalid-provider-id]",
      checks: [
        expect.objectContaining({
          providerId: "[invalid-provider-id]",
          error: "Provider [invalid-provider-id] is not configured."
        })
      ],
      troubleshooting: ["Add provider [invalid-provider-id] to providers.providers or choose an existing provider id."]
    });
    expect(JSON.stringify(result)).not.toContain("sk-live-secret-secret");
  });

  it("fails smoke checks for unsafe provider targets even when config validation was bypassed", async () => {
    const config = loadConfigFromObject({
      providers: {
        defaultProviderId: "openai-compatible",
        providers: {
          "openai-compatible": {
            enabled: true,
            baseUrl: "https://gateway.example.test/v1",
            model: "review-model",
            authMode: "api-key-env",
            apiKeyEnv: "NEONDIFF_PROVIDER_API_KEY",
            capabilities: {
              review: true,
              jsonOutput: true,
              local: false,
              streaming: false
            }
          }
        }
      }
    });
    let fetchCalls = 0;

    const result = await doctorProviderRegistry({
      registry: {
        ...config.providers!,
        providers: {
          ...config.providers!.providers,
          "openai-compatible": {
            ...config.providers!.providers["openai-compatible"],
            baseUrl: "https://169.254.169.254/latest"
          }
        }
      },
      providerId: "openai-compatible",
      smoke: true,
      fetchImpl: async () => {
        fetchCalls += 1;
        return new Response(JSON.stringify({ data: [] }));
      },
      env: {
        NEONDIFF_PROVIDER_API_KEY: "short-provider-key"
      }
    });

    expect(result.checks[0]).toMatchObject({
      ok: false,
      error: "OpenAI-compatible smoke target must not point to private, link-local, loopback, or cloud metadata hosts."
    });
    expect(fetchCalls).toBe(0);

    for (const unsafeBaseUrl of [
      "https://[::ffff:169.254.169.254]/latest",
      "https://[::ffff:10.0.0.1]/v1",
      "https://127.0.0.2/v1",
      "https://[::ffff:127.0.0.2]/v1",
      "https://[fe90::1]/v1",
      "https://0.0.0.0/v1"
    ]) {
      const unsafeResult = await doctorProviderRegistry({
        registry: {
          ...config.providers!,
          providers: {
            ...config.providers!.providers,
            "openai-compatible": {
              ...config.providers!.providers["openai-compatible"],
              baseUrl: unsafeBaseUrl
            }
          }
        },
        providerId: "openai-compatible",
        smoke: true,
        fetchImpl: async () => {
          fetchCalls += 1;
          return new Response(JSON.stringify({ data: [] }));
        },
        env: {
          NEONDIFF_PROVIDER_API_KEY: "short-provider-key"
        }
      });
      expect(unsafeResult.checks[0]).toMatchObject({
        ok: false,
        error: "OpenAI-compatible smoke target must not point to private, link-local, loopback, or cloud metadata hosts."
      });
    }
    expect(fetchCalls).toBe(0);

    const credentialResult = await doctorProviderRegistry({
      registry: {
        ...config.providers!,
        providers: {
          ...config.providers!.providers,
          "openai-compatible": {
            ...config.providers!.providers["openai-compatible"],
            baseUrl: "https://gateway.example.test/v1?api_key=short-provider-key"
          }
        }
      },
      providerId: "openai-compatible",
      smoke: true,
      fetchImpl: async () => {
        fetchCalls += 1;
        return new Response(JSON.stringify({ data: [] }));
      },
      env: {
        NEONDIFF_PROVIDER_API_KEY: "short-provider-key"
      }
    });
    expect(credentialResult.checks[0]).toMatchObject({
      ok: false,
      error: "OpenAI-compatible smoke target must not include credential query parameters."
    });
    expect(fetchCalls).toBe(0);

    const remoteResult = await doctorProviderRegistry({
      registry: {
        ...config.providers!,
        providers: {
          ...config.providers!.providers,
          "openai-compatible": {
            ...config.providers!.providers["openai-compatible"],
            baseUrl: "https://metadata-proxy.example.test/v1"
          }
        }
      },
      providerId: "openai-compatible",
      smoke: true,
      fetchImpl: async () => {
        fetchCalls += 1;
        return new Response(JSON.stringify({ data: [] }));
      },
      env: {
        NEONDIFF_PROVIDER_API_KEY: "short-provider-key"
      }
    });
    expect(remoteResult.checks[0]).toMatchObject({
      ok: false,
      error: "Remote OpenAI-compatible smoke checks require explicit remote opt-in and --provider <id>."
    });
    expect(fetchCalls).toBe(0);
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
            baseUrl: "http://127.0.0.1:8080/v1",
            capabilities: {
              review: true,
              jsonOutput: true,
              local: true,
              streaming: false
            }
          }
        }
      }
    });

    const result = await doctorProviderRegistry({
      registry: config.providers!,
      providerId: "openai-compatible",
      smoke: true,
      fetchImpl: async () => new Response(JSON.stringify({ data: [{ id: "other-model" }, null, 123, { name: "missing-id" }] }), {
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

    const emptyResult = await doctorProviderRegistry({
      registry: config.providers!,
      providerId: "openai-compatible",
      smoke: true,
      fetchImpl: async () => new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      })
    });
    expect(emptyResult.checks[0]).toMatchObject({
      ok: false,
      modelCount: 0,
      errorCategory: "model_output_schema",
      error: "Models response did not advertise any usable model ids."
    });
  });

  it("builds OpenAI-compatible models URLs without duplicating existing models suffix", () => {
    expect(buildOpenAIModelsUrl("https://gateway.example.test/v1")).toBe("https://gateway.example.test/v1/models");
    expect(buildOpenAIModelsUrl("https://gateway.example.test/v1/")).toBe("https://gateway.example.test/v1/models");
    expect(buildOpenAIModelsUrl("https://gateway.example.test/v1/models")).toBe("https://gateway.example.test/v1/models");
    expect(buildOpenAIModelsUrl("https://gateway.example.test/v1/models/")).toBe("https://gateway.example.test/v1/models");
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

  it("requires api-key-env providers to declare apiKeyEnv before metadata readiness passes", async () => {
    const config = loadConfigFromObject({
      providers: {
        defaultProviderId: "openai-compatible",
        providers: {
          "openai-compatible": {
            enabled: false,
            model: "review-model",
            authMode: "api-key-env",
            apiKeyEnv: undefined
          }
        }
      }
    });

    const providerWithoutKey = {
      ...config.providers!.providers["openai-compatible"],
      enabled: true
    };
    delete providerWithoutKey.apiKeyEnv;
    const result = await doctorProviderRegistry({
      registry: {
        ...config.providers!,
        providers: {
          ...config.providers!.providers,
          "openai-compatible": providerWithoutKey
        }
      },
      providerId: "openai-compatible"
    });

    expect(result).toMatchObject({
      ok: false,
      checks: [
        expect.objectContaining({
          providerId: "openai-compatible",
          ok: false,
          error: "Provider requires apiKeyEnv for api-key-env auth."
        })
      ],
      troubleshooting: [
        "Provider openai-compatible must declare an API key environment variable before it can be selected for review."
      ]
    });
  });

  it("keeps disabled provider metadata errors focused on disabled state", async () => {
    const config = loadConfigFromObject({
      providers: {
        defaultProviderId: "openai-compatible",
        providers: {
          "openai-compatible": {
            enabled: false,
            model: "review-model",
            authMode: "api-key-env",
            capabilities: {
              review: false,
              jsonOutput: false
            }
          }
        }
      }
    });

    const result = await doctorProviderRegistry({
      registry: config.providers!,
      providerId: "openai-compatible"
    });

    expect(result.checks[0]).toMatchObject({
      ok: false,
      enabled: false,
      error: "Provider is disabled."
    });
  });

  it("reports unsupported smoke requests for non-OpenAI-compatible adapters", async () => {
    const config = loadConfigFromObject({});

    const result = await doctorProviderRegistry({
      registry: config.providers!,
      providerId: "zcode-glm",
      smoke: true
    });

    expect(result.checks[0]).toMatchObject({
      providerId: "zcode-glm",
      ok: false,
      smokeAttempted: false,
      error: "Smoke checks are not implemented for zcode providers."
    });
  });

  it("classifies non-JSON successful models responses as output schema failures", async () => {
    const config = loadConfigFromObject({
      providers: {
        defaultProviderId: "openai-compatible",
        providers: {
          "openai-compatible": {
            enabled: true,
            model: "review-model",
            authMode: "none",
            baseUrl: "http://127.0.0.1:8080/v1",
            capabilities: {
              review: true,
              jsonOutput: true,
              local: true,
              streaming: false
            }
          }
        }
      }
    });

    const result = await doctorProviderRegistry({
      registry: config.providers!,
      providerId: "openai-compatible",
      smoke: true,
      fetchImpl: async () => new Response("<html>ok</html>", {
        status: 200,
        headers: { "Content-Type": "text/html" }
      })
    });

    expect(result.checks[0]).toMatchObject({
      ok: false,
      errorCategory: "model_output_schema",
      error: "Models response was not valid JSON."
    });
  });

  it("cancels oversized fetch response bodies immediately", async () => {
    const config = loadConfigFromObject({
      providers: {
        defaultProviderId: "openai-compatible",
        providers: {
          "openai-compatible": {
            enabled: true,
            model: "review-model",
            authMode: "none",
            baseUrl: "http://127.0.0.1:8080/v1",
            capabilities: {
              review: true,
              jsonOutput: true,
              local: true,
              streaming: false
            }
          }
        }
      }
    });
    let canceled = false;
    const body = new ReadableStream({
      cancel() {
        canceled = true;
      }
    });

    const result = await doctorProviderRegistry({
      registry: config.providers!,
      providerId: "openai-compatible",
      smoke: true,
      fetchImpl: async () => new Response(body, {
        status: 200,
        headers: {
          "content-length": String(256 * 1024 + 1)
        }
      })
    });

    expect(result.checks[0]).toMatchObject({
      ok: false,
      errorCategory: "model_output_schema",
      error: "Models response exceeded 262144 byte limit."
    });
    expect(canceled).toBe(true);
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

  it("always binds OpenAI-compatible smoke requests to an abort signal", async () => {
    const config = loadConfigFromObject({
      providers: {
        defaultProviderId: "ollama-local",
        providers: {
          "ollama-local": {
            enabled: true
          }
        }
      }
    });

    const result = await doctorProviderRegistry({
      registry: config.providers!,
      providerId: "ollama-local",
      smoke: true,
      fetchImpl: async (_url, init) => {
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        return new Response(JSON.stringify({ data: [{ id: config.providers!.providers["ollama-local"].model }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
    });

    expect(result.checks[0]).toMatchObject({
      ok: true,
      modelCount: 1
    });
  });

  it("unrefs fallback smoke timeout timers on runtimes without AbortSignal.timeout", async () => {
    const config = loadConfigFromObject({
      providers: {
        defaultProviderId: "ollama-local",
        providers: {
          "ollama-local": {
            enabled: true
          }
        }
      }
    });
    const originalAbortTimeout = AbortSignal.timeout;
    const unref = vi.fn();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation((() => ({ unref })) as unknown as typeof setTimeout);
    Object.defineProperty(AbortSignal, "timeout", {
      configurable: true,
      value: undefined
    });

    try {
      const result = await doctorProviderRegistry({
        registry: config.providers!,
        providerId: "ollama-local",
        smoke: true,
        fetchImpl: async (_url, init) => {
          expect(init?.signal).toBeInstanceOf(AbortSignal);
          return new Response(JSON.stringify({ data: [{ id: config.providers!.providers["ollama-local"].model }] }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          });
        }
      });

      expect(result.checks[0]).toMatchObject({ ok: true });
      expect(unref).toHaveBeenCalledTimes(1);
    } finally {
      setTimeoutSpy.mockRestore();
      Object.defineProperty(AbortSignal, "timeout", {
        configurable: true,
        value: originalAbortTimeout
      });
    }
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
        defaultProviderId: "leaky-path",
        providers: {
          "leaky-path": {
            enabled: true,
            adapter: "openai-compatible",
            baseUrl: "https://gateway.example.test/proxy/sk-fixture/v1#github_pat_fake_token",
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
    })).toThrow(/must not include secret-like path or fragment values/);

    expect(() => loadConfigFromObject({
      providers: {
        defaultProviderId: "metadata-host",
        providers: {
          "metadata-host": {
            enabled: true,
            adapter: "openai-compatible",
            baseUrl: "https://169.254.169.254/latest",
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
    })).toThrow(/must not point to private, link-local, or cloud metadata hosts/);

    expect(() => loadConfigFromObject({
      providers: {
        defaultProviderId: "metadata-name",
        providers: {
          "metadata-name": {
            enabled: true,
            adapter: "openai-compatible",
            baseUrl: "https://metadata.google.internal/computeMetadata/v1",
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
    })).toThrow(/must not point to private, link-local, or cloud metadata hosts/);

    expect(() => loadConfigFromObject({
      providers: {
        defaultProviderId: "ipv4-mapped-metadata",
        providers: {
          "ipv4-mapped-metadata": {
            enabled: true,
            adapter: "openai-compatible",
            baseUrl: "https://[::ffff:169.254.169.254]/latest",
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
    })).toThrow(/must not point to private, link-local, or cloud metadata hosts/);

    expect(() => loadConfigFromObject({
      providers: {
        defaultProviderId: "wildcard-host",
        providers: {
          "wildcard-host": {
            enabled: true,
            adapter: "openai-compatible",
            baseUrl: "https://0.0.0.0/v1",
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
    })).toThrow(/must not point to private, link-local, or cloud metadata hosts/);

    expect(() => loadConfigFromObject({
      providers: {
        defaultProviderId: "ipv6-link-local",
        providers: {
          "ipv6-link-local": {
            enabled: true,
            adapter: "openai-compatible",
            baseUrl: "https://[fe90::1]/v1",
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
    })).toThrow(/must not point to private, link-local, or cloud metadata hosts/);

    expect(() => loadConfigFromObject({
      providers: {
        defaultProviderId: "loopback-range",
        providers: {
          "loopback-range": {
            enabled: true,
            adapter: "openai-compatible",
            baseUrl: "http://127.0.0.2/v1",
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
    })).toThrow(/capabilities\.local must be true for loopback provider baseUrl/);

    expect(() => loadConfigFromObject({
      providers: {
        defaultProviderId: "mapped-loopback",
        providers: {
          "mapped-loopback": {
            enabled: true,
            adapter: "openai-compatible",
            baseUrl: "http://[::ffff:127.0.0.2]/v1",
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
    })).toThrow(/capabilities\.local must be true for loopback provider baseUrl/);

    expect(() => loadConfigFromObject({
      providers: {
        defaultProviderId: "loopback-not-local",
        providers: {
          "loopback-not-local": {
            enabled: true,
            adapter: "openai-compatible",
            baseUrl: "http://localhost:11434/v1",
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
    })).toThrow(/capabilities\.local must be true for loopback provider baseUrl/);

    expect(() => loadConfigFromObject({
      providers: {
        defaultProviderId: "bad-adapter-type",
        providers: {
          "bad-adapter-type": {
            enabled: true,
            adapter: { toString: () => "openai-compatible" },
            baseUrl: "https://gateway.example.test/v1",
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
    })).toThrow(/adapter must be a string/);

    expect(() => loadConfigFromObject({
      providers: {
        defaultProviderId: "bad-auth-type",
        providers: {
          "bad-auth-type": {
            enabled: true,
            adapter: "openai-compatible",
            baseUrl: "https://gateway.example.test/v1",
            model: "review-model",
            authMode: { toString: () => "none" },
            capabilities: {
              review: true,
              jsonOutput: true,
              local: false,
              streaming: false
            }
          }
        }
      }
    })).toThrow(/authMode must be a string/);

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
            apiKeyEnv: "ghp_fake_token",
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
