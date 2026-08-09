import { describe, expect, it } from "vitest";
import { loadConfigFromObject } from "../src/config.js";
import { classifyReviewRuntimeAuthority } from "../src/review-runtime-authority.js";

describe("review runtime authority", () => {
  it("classifies the default matching ZCode route as legacy-authoritative", () => {
    const authority = classifyReviewRuntimeAuthority(loadConfigFromObject({}));

    expect(authority).toMatchObject({
      ok: true,
      state: "legacy_authoritative",
      reason: "legacy_zcode_enabled",
      execution: {
        adapter: "zcode",
        providerId: "zcode-app-selected",
        model: "GLM-5.2",
        auth: "zcode-app-config",
        willAttempt: true
      },
      automaticFallback: {
        configured: false,
        reachable: false,
        target: null
      }
    });
  });

  it("keeps configured legacy metadata visible but non-authoritative under Codex", () => {
    const authority = classifyReviewRuntimeAuthority(loadConfigFromObject({
      codexRuntime: {
        enabled: true,
        cliPath: "/Users/test/.local/bin/codex",
        model: "gpt-5.6-luna",
        reasoningEffort: "xhigh",
        timeoutMs: 600_000,
        maxOutputBytes: 20 * 1024 * 1024,
        contextWindowTokens: 128_000
      }
    }));

    expect(authority).toMatchObject({
      ok: true,
      state: "codex_authoritative",
      reason: "codex_enabled",
      execution: {
        adapter: "codex-cli",
        providerId: "codex-cli-oauth",
        model: "gpt-5.6-luna",
        auth: "existing-codex-session",
        willAttempt: true
      },
      legacyProviderMetadata: {
        registryDefaultProviderId: "zcode-glm",
        providerId: "zcode-glm",
        selectionSource: "providers.defaultProviderId",
        authoritative: false
      },
      automaticFallback: {
        configured: false,
        reachable: false,
        target: null
      }
    });
  });

  it("reports an enabled non-ZCode registry default as invalid without changing the executor", () => {
    const authority = classifyReviewRuntimeAuthority(loadConfigFromObject({
      providers: {
        defaultProviderId: "openai-compatible",
        providers: {
          "openai-compatible": {
            enabled: true,
            capabilities: { review: true, jsonOutput: true }
          }
        }
      }
    }));

    expect(authority).toMatchObject({
      ok: false,
      state: "invalid_authoritative",
      reason: "legacy_registry_mismatch",
      execution: {
        adapter: "zcode",
        providerId: "zcode-app-selected",
        willAttempt: true
      },
      legacyProviderMetadata: {
        providerId: "openai-compatible",
        adapter: "openai-compatible",
        authoritative: false,
        matchesExecution: false
      }
    });
  });

  it("makes an explicit zcode provider id take precedence over registry default metadata", () => {
    const authority = classifyReviewRuntimeAuthority(loadConfigFromObject({
      zcode: { providerId: "zcode-glm" },
      providers: {
        defaultProviderId: "openai-compatible",
        providers: {
          "openai-compatible": { enabled: true }
        }
      }
    }));

    expect(authority).toMatchObject({
      ok: true,
      state: "legacy_authoritative",
      execution: {
        providerId: "zcode-glm",
        adapter: "zcode"
      },
      legacyProviderMetadata: {
        registryDefaultProviderId: "openai-compatible",
        providerId: "zcode-glm",
        selectionSource: "zcode.providerId",
        matchesExecution: true
      }
    });
  });

  it("reports Codex-disabled plus legacy-disabled as invalid while preserving current attempt truth", () => {
    const authority = classifyReviewRuntimeAuthority(loadConfigFromObject({
      providers: {
        providers: {
          "zcode-glm": { enabled: false }
        }
      }
    }));

    expect(authority).toMatchObject({
      ok: false,
      state: "invalid_authoritative",
      reason: "both_disabled",
      execution: {
        adapter: "zcode",
        willAttempt: true
      },
      legacyProviderMetadata: {
        providerId: "zcode-glm",
        enabled: false,
        authoritative: false
      }
    });
  });

  it("reports per-invocation execution suppression without inventing a fallback", () => {
    const authority = classifyReviewRuntimeAuthority(loadConfigFromObject({}), {
      executionRequested: false
    });

    expect(authority.execution.willAttempt).toBe(false);
    expect(authority.automaticFallback).toEqual(expect.objectContaining({
      configured: false,
      reachable: false,
      target: null
    }));
  });
});
