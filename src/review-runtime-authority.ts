import type { BotConfig } from "./config.js";
import type { ProviderAdapter, ProviderAuthMode } from "./providers.js";

export type ReviewRuntimeAuthorityState =
  | "codex_authoritative"
  | "legacy_authoritative"
  | "invalid_authoritative";

export type ReviewRuntimeAuthorityReason =
  | "codex_enabled"
  | "legacy_zcode_enabled"
  | "legacy_registry_mismatch"
  | "both_disabled";

export interface ReviewRuntimeAuthority {
  ok: boolean;
  state: ReviewRuntimeAuthorityState;
  reason: ReviewRuntimeAuthorityReason;
  execution: {
    providerId: string;
    adapter: "codex-cli" | "zcode";
    model: string;
    auth: "existing-codex-session" | "zcode-app-config";
    willAttempt: boolean;
  };
  legacyProviderMetadata: {
    registryDefaultProviderId: string | null;
    providerId: string | null;
    selectionSource: "zcode.providerId" | "providers.defaultProviderId" | "none";
    exists: boolean;
    enabled: boolean;
    adapter: ProviderAdapter | null;
    model: string | null;
    authMode: ProviderAuthMode | null;
    reviewCapable: boolean;
    jsonOutputCapable: boolean;
    matchesExecution: boolean;
    authoritative: false;
    role: "diagnostic_metadata_only";
  };
  automaticFallback: {
    configured: false;
    reachable: false;
    target: null;
    reason: string;
  };
  proofBoundary: string;
}

const DYNAMIC_ZCODE_PROVIDER_ID = "zcode-app-selected";

export function classifyReviewRuntimeAuthority(
  config: BotConfig,
  options: { executionRequested?: boolean } = {}
): ReviewRuntimeAuthority {
  const executionRequested = options.executionRequested ?? true;
  const registry = config.providers;
  const explicitProviderId = config.zcode.providerId;
  const registryDefaultProviderId = registry?.defaultProviderId ?? null;
  const registryProviderId = explicitProviderId ?? registryDefaultProviderId;
  const registryProvider = registryProviderId ? registry?.providers[registryProviderId] : undefined;
  const registryMatchesZCode = Boolean(
    registryProvider?.enabled
    && registryProvider.adapter === "zcode"
    && registryProvider.model === config.zcode.model
    && registryProvider.authMode === "zcode-app-config"
    && registryProvider.capabilities.review
    && registryProvider.capabilities.jsonOutput
  );
  const legacyProviderMetadata: ReviewRuntimeAuthority["legacyProviderMetadata"] = {
    registryDefaultProviderId,
    providerId: registryProviderId,
    selectionSource: explicitProviderId
      ? "zcode.providerId"
      : registryDefaultProviderId ? "providers.defaultProviderId" : "none",
    exists: Boolean(registryProvider),
    enabled: Boolean(registryProvider?.enabled),
    adapter: registryProvider?.adapter ?? null,
    model: registryProvider?.model ?? null,
    authMode: registryProvider?.authMode ?? null,
    reviewCapable: Boolean(registryProvider?.capabilities.review),
    jsonOutputCapable: Boolean(registryProvider?.capabilities.jsonOutput),
    matchesExecution: registryMatchesZCode,
    authoritative: false,
    role: "diagnostic_metadata_only"
  };
  const automaticFallback = {
    configured: false as const,
    reachable: false as const,
    target: null,
    reason: "No automatic cross-runtime fallback exists: Codex failures are terminal and ZCode retries stay on ZCode."
  };

  if (config.codexRuntime?.enabled === true) {
    return {
      ok: true,
      state: "codex_authoritative",
      reason: "codex_enabled",
      execution: {
        providerId: "codex-cli-oauth",
        adapter: "codex-cli",
        model: config.codexRuntime.model,
        auth: "existing-codex-session",
        willAttempt: executionRequested
      },
      legacyProviderMetadata,
      automaticFallback,
      proofBoundary: "Configuration authority only; this does not prove Codex CLI login, an installed review, GitHub posting, release, or runtime adoption."
    };
  }

  const execution = {
    providerId: config.zcode.providerId ?? DYNAMIC_ZCODE_PROVIDER_ID,
    adapter: "zcode" as const,
    model: config.zcode.model,
    auth: "zcode-app-config" as const,
    willAttempt: executionRequested
  };
  if (explicitProviderId && registryProvider && !registryProvider.enabled) {
    return {
      ok: false,
      state: "invalid_authoritative",
      reason: "both_disabled",
      execution,
      legacyProviderMetadata,
      automaticFallback,
      proofBoundary: "Configuration authority is invalid: Codex and the selected legacy registry metadata are disabled, although current worker code would still attempt ZCode."
    };
  }
  if (explicitProviderId && !registryMatchesZCode) {
    return {
      ok: false,
      state: "invalid_authoritative",
      reason: "legacy_registry_mismatch",
      execution,
      legacyProviderMetadata,
      automaticFallback,
      proofBoundary: "Configuration authority is invalid: registry metadata does not match the ZCode executor that current worker code would attempt."
    };
  }
  return {
    ok: true,
    state: "legacy_authoritative",
    reason: "legacy_zcode_enabled",
    execution,
    legacyProviderMetadata,
    automaticFallback,
    proofBoundary: "Configuration authority only; this does not prove ZCode credentials, provider reachability, an installed review, GitHub posting, release, or runtime adoption."
  };
}
