import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildOpenAIChatCompletionsUrl,
  classifyProviderAdapterError,
  createOpenAICompatibleReviewAdapter,
  runProviderAdapterFixture,
  type ProviderRuntimeAdapter
} from "../src/provider-adapters.js";
import type { ProviderRegistryEntry } from "../src/providers.js";
import { createZCodeReviewFixtureAdapter } from "../src/zcode.js";

describe("provider adapter fixtures", () => {
  it("runs one shared review fixture through mocked ZCode and local OpenAI-compatible adapters", async () => {
    const reviewJson = '{"findings":[],"summary":"No validated current-diff findings."}';
    const sharedFixture = makeFixture({
      id: "shared-review-fixture",
      prompt: [
        "Review this private patch content before posting a comment.",
        "diff --git a/private.ts b/private.ts",
        "@@ -1 +1 @@",
        "-secret",
        "+fixed"
      ].join("\n"),
      expectReviewJson: true
    });
    const zcodeAdapter = createZCodeReviewFixtureAdapter({
      cwd: "/repo",
      cliPath: "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs",
      appConfigPath: "/Users/example/.zcode/app-config.json",
      runReview(input) {
        expect(input.prompt).toBe(sharedFixture.prompt);
        expect(input.model).toBe("GLM-5.2");
        expect(input.providerId).toBe("zcode-glm");
        return {
          findings: [],
          droppedFromSchema: [],
          rawResponse: reviewJson
        };
      }
    });
    const localAdapter = createOpenAICompatibleReviewAdapter({
      providerId: "ollama-local",
      provider: makeOpenAICompatibleProvider({
        baseUrl: "http://127.0.0.1:11434/v1",
        model: "qwen2.5-coder:7b",
        authMode: "none",
        capabilities: {
          review: true,
          jsonOutput: true,
          local: true,
          streaming: false
        }
      }),
      fetchImpl: async (url, init) => {
        expect(String(url)).toBe("http://127.0.0.1:11434/v1/chat/completions");
        expect(new Headers(init?.headers).has("authorization")).toBe(false);
        const body = JSON.parse(String(init?.body)) as {
          model?: string;
          stream?: boolean;
          messages?: Array<{ role?: string; content?: string }>;
          response_format?: { type?: string };
        };
        expect(body).toMatchObject({
          model: "qwen2.5-coder:7b",
          stream: false,
          response_format: { type: "json_object" }
        });
        expect(body.messages?.at(-1)).toEqual({ role: "user", content: sharedFixture.prompt });
        return jsonResponse({
          id: "chatcmpl-local-fixture",
          choices: [
            {
              message: {
                content: reviewJson
              }
            }
          ],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 5
          }
        });
      }
    });

    const zcode = await runProviderAdapterFixture({
      adapter: zcodeAdapter,
      fixture: {
        ...sharedFixture,
        providerId: "zcode-glm",
        adapterId: "zcode",
        model: "GLM-5.2"
      }
    });
    const local = await runProviderAdapterFixture({
      adapter: localAdapter,
      fixture: {
        ...sharedFixture,
        providerId: "ollama-local",
        adapterId: "openai-compatible",
        model: "qwen2.5-coder:7b"
      }
    });

    expect(zcode.ok).toBe(true);
    expect(local.ok).toBe(true);
    expect(zcode.fixtureId).toBe(local.fixtureId);
    expect(zcode.evidence.promptSha256).toBe(local.evidence.promptSha256);
    expect(zcode.evidence.outputPreview).toBe(reviewJson);
    expect(local.evidence.outputPreview).toBe(reviewJson);
    expect(JSON.stringify([zcode, local])).not.toContain("private patch content");
    expect(JSON.stringify([zcode, local])).not.toContain("diff --git");
    expect(local.evidence.rawEvidencePreview).toContain('"providerId":"ollama-local"');
    expect(local.evidence.rawEvidencePreview).not.toContain(sharedFixture.prompt);
  });

  it("executes OpenAI-compatible chat-completions reviews with env-backed bearer auth and redacted evidence", async () => {
    const providerKey = "sk-live-openai-compatible-secret";
    const adapter = createOpenAICompatibleReviewAdapter({
      providerId: "openai-compatible",
      provider: makeOpenAICompatibleProvider({
        baseUrl: "http://localhost:1234/v1",
        model: "lm-studio-review-model",
        authMode: "api-key-env",
        apiKeyEnv: "NEONDIFF_PROVIDER_API_KEY",
        capabilities: {
          review: true,
          jsonOutput: true,
          local: true,
          streaming: false
        }
      }),
      env: {
        NEONDIFF_PROVIDER_API_KEY: providerKey
      },
      fetchImpl: async (url, init) => {
        expect(String(url)).toBe("http://localhost:1234/v1/chat/completions");
        expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${providerKey}`);
        return jsonResponse({
          id: "chatcmpl-env-auth-fixture",
          choices: [
            {
              message: {
                content: '{"findings":[{"severity":"P2","path":"src/app.ts","line":12,"title":"Bug","body":"Fix the regression.","confidence":0.91}],"summary":"One finding."}'
              }
            }
          ]
        });
      }
    });

    const result = await runProviderAdapterFixture({
      adapter,
      fixture: makeFixture({
        id: "env-auth-openai-compatible-fixture",
        providerId: "openai-compatible",
        adapterId: "openai-compatible",
        model: "lm-studio-review-model",
        expectReviewJson: true
      })
    });

    expect(result.ok).toBe(true);
    expect(result.evidence.outputPreview).toContain('"findings"');
    expect(result.evidence.rawEvidencePreview).toContain('"status":200');
    expect(result.evidence.rawEvidencePreview).not.toContain(providerKey);
    expect(JSON.stringify(result)).not.toContain(providerKey);
  });

  it("blocks unsafe OpenAI-compatible review targets before fetching private prompts", async () => {
    let fetched = false;
    const result = await runProviderAdapterFixture({
      adapter: createOpenAICompatibleReviewAdapter({
        providerId: "unsafe-openai-compatible",
        provider: makeOpenAICompatibleProvider({
          baseUrl: "http://169.254.169.254/latest/meta-data",
          capabilities: {
            review: true,
            jsonOutput: true,
            local: false,
            streaming: false
          }
        }),
        fetchImpl: async () => {
          fetched = true;
          return jsonResponse({ unreachable: true });
        }
      }),
      fixture: makeFixture({
        id: "unsafe-openai-compatible-fixture",
        providerId: "unsafe-openai-compatible",
        adapterId: "openai-compatible",
        expectReviewJson: true
      })
    });

    expect(fetched).toBe(false);
    expect(result).toMatchObject({
      ok: false,
      error: {
        class: "unknown",
        message: "OpenAI-compatible review target must not point to private, link-local, loopback, or cloud metadata hosts."
      }
    });
  });

  it("omits strict response_format when provider capabilities do not declare JSON mode", async () => {
    const result = await runProviderAdapterFixture({
      adapter: createOpenAICompatibleReviewAdapter({
        providerId: "json-parser-only-local",
        provider: makeOpenAICompatibleProvider({
          baseUrl: "http://127.0.0.1:8080/v1",
          capabilities: {
            review: true,
            jsonOutput: false,
            local: true,
            streaming: false
          }
        }),
        fetchImpl: async (_url, init) => {
          const body = JSON.parse(String(init?.body)) as { response_format?: unknown };
          expect(body).not.toHaveProperty("response_format");
          return jsonResponse({
            choices: [
              {
                message: {
                  content: '{"findings":[],"summary":"Parsed without provider-side JSON mode."}'
                }
              }
            ]
          });
        }
      }),
      fixture: makeFixture({
        id: "json-parser-only-local-fixture",
        providerId: "json-parser-only-local",
        adapterId: "openai-compatible",
        expectReviewJson: true
      })
    });

    expect(result.ok).toBe(true);
  });

  it("times out OpenAI-compatible responses that stall after headers", async () => {
    let bodyCancelled = false;
    const result = await runProviderAdapterFixture({
      adapter: createOpenAICompatibleReviewAdapter({
        providerId: "slow-body-local",
        provider: makeOpenAICompatibleProvider({
          baseUrl: "http://127.0.0.1:8080/v1",
          timeoutMs: 1
        }),
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          text: async () => new Promise<string>(() => undefined),
          body: {
            cancel: async () => {
              bodyCancelled = true;
            }
          }
        }) as Response
      }),
      fixture: makeFixture({
        id: "slow-body-openai-compatible-fixture",
        providerId: "slow-body-local",
        adapterId: "openai-compatible",
        expectReviewJson: true
      })
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        class: "timeout",
        message: "deadline exceeded"
      }
    });
    expect(bodyCancelled).toBe(true);
  });

  it.each([
    {
      expectedClass: "auth",
      provider: makeOpenAICompatibleProvider({
        authMode: "api-key-env",
        apiKeyEnv: "NEONDIFF_PROVIDER_API_KEY"
      }),
      env: {},
      fetchImpl: async () => jsonResponse({ unreachable: true })
    },
    {
      expectedClass: "throttle",
      fetchImpl: async () => new Response("too many requests with sk-live-secret-secret", { status: 429 })
    },
    {
      expectedClass: "network",
      fetchImpl: async () => new Response("service unavailable with sk-live-secret-secret", { status: 503 })
    },
    {
      expectedClass: "timeout",
      fetchImpl: async () => {
        throw new Error("deadline exceeded");
      }
    },
    {
      expectedClass: "model-output",
      fetchImpl: async () => jsonResponse({
        choices: [
          {
            message: {
              content: "not json with sk-live-secret-secret"
            }
          }
        ]
      })
    },
    {
      expectedClass: "unknown",
      fetchImpl: async () => new Response("provider returned a teapot with sk-live-secret-secret", { status: 418 })
    }
  ] as const)(
    "bounds OpenAI-compatible adapter failures as $expectedClass",
    async ({ expectedClass, provider, env, fetchImpl }) => {
      const result = await runProviderAdapterFixture({
        adapter: createOpenAICompatibleReviewAdapter({
          providerId: "openai-compatible",
          provider: provider ?? makeOpenAICompatibleProvider(),
          env,
          fetchImpl
        }),
        fixture: makeFixture({
          id: `${expectedClass}-openai-compatible-fixture`,
          providerId: "openai-compatible",
          adapterId: "openai-compatible",
          expectReviewJson: true
        })
      });

      expect(result).toMatchObject({
        ok: false,
        error: {
          class: expectedClass
        }
      });
      expect(JSON.stringify(result)).not.toContain("sk-live-secret-secret");
    }
  );

  it("keeps model-output wording ahead of generic HTTP status tokens", () => {
    expect(classifyProviderAdapterError("500 invalid output from provider")).toBe("model-output");
    expect(classifyProviderAdapterError("500 network failure from provider")).toBe("network");
    expect(classifyProviderAdapterError("OpenAI-compatible chat completions endpoint returned 418.")).toBe("unknown");
  });

  it("builds OpenAI-compatible chat-completions URLs for Ollama, LM Studio, vLLM, and gateway shapes", () => {
    expect(buildOpenAIChatCompletionsUrl("http://localhost:11434/v1")).toBe("http://localhost:11434/v1/chat/completions");
    expect(buildOpenAIChatCompletionsUrl("http://127.0.0.1:1234/v1/")).toBe("http://127.0.0.1:1234/v1/chat/completions");
    expect(buildOpenAIChatCompletionsUrl("http://localhost:8000/v1/chat/completions")).toBe("http://localhost:8000/v1/chat/completions");
    expect(buildOpenAIChatCompletionsUrl("http://localhost:8000/v1/chat/completions/")).toBe("http://localhost:8000/v1/chat/completions");
    expect(buildOpenAIChatCompletionsUrl("http://localhost:8000/v1//chat/completions?x=1")).toBe("http://localhost:8000/v1/chat/completions?x=1");
    expect(buildOpenAIChatCompletionsUrl("https://gateway.example.test/openai/v1")).toBe("https://gateway.example.test/openai/v1/chat/completions");
  });

  it("bounds review JSON extraction work for large malformed local-model responses", async () => {
    const noisyPrefix = Array.from({ length: 5_000 }, (_, index) => `{noise-${index}}`).join("");
    const result = await runProviderAdapterFixture({
      adapter: createOpenAICompatibleReviewAdapter({
        providerId: "noisy-local-model",
        provider: makeOpenAICompatibleProvider({
          baseUrl: "http://localhost:8080/v1"
        }),
        fetchImpl: async () => jsonResponse({
          choices: [
            {
              message: {
                content: `${noisyPrefix} {"findings":[],"summary":"Found after noisy braces."}`
              }
            }
          ]
        })
      }),
      fixture: makeFixture({
        id: "noisy-local-model-fixture",
        providerId: "noisy-local-model",
        adapterId: "openai-compatible",
        expectReviewJson: true
      })
    });

    expect(result.ok).toBe(true);
    expect(result.evidence.outputPreview).toContain('"findings":[]');
  });

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
    const anthropicToken = "sk-ant-fixture-token";
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
  expectReviewJson: boolean;
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

function makeOpenAICompatibleProvider(overrides: Partial<ProviderRegistryEntry> = {}): ProviderRegistryEntry {
  return {
    enabled: true,
    adapter: "openai-compatible",
    displayName: "OpenAI-compatible fixture endpoint",
    baseUrl: "http://127.0.0.1:8080/v1",
    model: "review-model",
    authMode: "none",
    timeoutMs: 1_000,
    retryMaxRetries: 0,
    capabilities: {
      review: true,
      jsonOutput: true,
      local: true,
      streaming: false
    },
    ...overrides
  };
}

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init
  });
}
