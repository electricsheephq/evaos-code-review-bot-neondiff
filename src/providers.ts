import { isIP } from "node:net";
import { containsSecretLikeText, redactSecrets } from "./secrets.js";

const DEFAULT_PROVIDER_SMOKE_TIMEOUT_MS = 30_000;

export type ProviderAdapter = "zcode" | "openai-compatible" | "anthropic" | "openai" | "gemini";
export type ProviderAuthMode = "zcode-app-config" | "api-key-env" | "none";

export interface ProviderCapabilityFlags {
  review: boolean;
  jsonOutput: boolean;
  local: boolean;
  streaming: boolean;
}

export interface ProviderRegistryEntry {
  enabled: boolean;
  adapter: ProviderAdapter;
  displayName?: string;
  baseUrl?: string;
  model: string;
  authMode: ProviderAuthMode;
  apiKeyEnv?: string;
  contextWindowTokens?: number;
  timeoutMs?: number;
  retryMaxRetries?: number;
  capabilities: ProviderCapabilityFlags;
}

export interface ProviderRegistryConfig {
  defaultProviderId: string;
  providers: Record<string, ProviderRegistryEntry>;
}

export type ProviderErrorCategory =
  | "auth"
  | "quota_or_rate_limit"
  | "transient"
  | "timeout"
  | "context_limit"
  | "model_output_schema"
  | "unknown";

export interface ProviderRegistrySummaryEntry {
  id: string;
  enabled: boolean;
  adapter: ProviderAdapter;
  displayName?: string;
  model: string;
  authMode: ProviderAuthMode;
  apiKeyEnv?: string;
  hasBaseUrl: boolean;
  baseUrl?: string;
  contextWindowTokens?: number;
  timeoutMs?: number;
  retryMaxRetries?: number;
  capabilities: ProviderCapabilityFlags;
  currentRuntime?: boolean;
}

export interface ProviderDoctorResult {
  ok: boolean;
  command: "providers doctor";
  providerId?: string;
  defaultProviderId: string;
  checks: ProviderDoctorCheck[];
  troubleshooting: string[];
}

export interface ProviderDoctorCheck {
  providerId: string;
  ok: boolean;
  adapter: ProviderAdapter;
  enabled: boolean;
  model: string;
  authMode: ProviderAuthMode;
  smokeAttempted: boolean;
  readMode: "metadata_only" | "openai_compatible_models";
  baseUrl?: string;
  apiKeyEnv?: string;
  errorCategory?: ProviderErrorCategory;
  error?: string;
  modelCount?: number;
}

export function buildProviderRegistrySummary(input: {
  registry: ProviderRegistryConfig;
  currentZCode?: { providerId?: string; model?: string };
}): { defaultProviderId: string; providers: ProviderRegistrySummaryEntry[] } {
  const currentZCodeProviderId = input.currentZCode?.providerId;
  const currentZCodeModel = input.currentZCode?.model;
  return {
    defaultProviderId: input.registry.defaultProviderId,
    providers: Object.entries(input.registry.providers).map(([id, provider]) => ({
      id,
      enabled: provider.enabled,
      adapter: provider.adapter,
      ...(provider.displayName ? { displayName: provider.displayName } : {}),
      model: provider.model,
      authMode: provider.authMode,
      ...(provider.apiKeyEnv ? { apiKeyEnv: provider.apiKeyEnv } : {}),
      hasBaseUrl: Boolean(provider.baseUrl),
      ...(provider.baseUrl ? { baseUrl: redactProviderUrl(provider.baseUrl) } : {}),
      ...(provider.contextWindowTokens ? { contextWindowTokens: provider.contextWindowTokens } : {}),
      ...(provider.timeoutMs ? { timeoutMs: provider.timeoutMs } : {}),
      ...(provider.retryMaxRetries !== undefined ? { retryMaxRetries: provider.retryMaxRetries } : {}),
      capabilities: provider.capabilities,
      currentRuntime: provider.adapter === "zcode" && (
        currentZCodeProviderId
          ? id === currentZCodeProviderId
          : Boolean(provider.enabled && currentZCodeModel && provider.model === currentZCodeModel)
      )
    }))
  };
}

export async function doctorProviderRegistry(input: {
  registry: ProviderRegistryConfig;
  providerId?: string;
  smoke?: boolean;
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
}): Promise<ProviderDoctorResult> {
  if (input.smoke && !input.providerId) {
    return {
      ok: false,
      command: "providers doctor",
      defaultProviderId: input.registry.defaultProviderId,
      checks: [],
      troubleshooting: ["--smoke true requires --provider to avoid unscoped provider network fan-out."]
    };
  }
  const providerIds = input.providerId
    ? [input.providerId]
    : Object.entries(input.registry.providers)
      .filter(([id, provider]) => provider.enabled || id === input.registry.defaultProviderId)
      .map(([id]) => id);
  const checks: ProviderDoctorCheck[] = [];
  const troubleshooting: string[] = [];
  const fetchImpl = input.fetchImpl ?? fetch;
  const env = input.env ?? process.env;

  for (const providerId of providerIds) {
    const provider = input.registry.providers[providerId];
    const safeProviderId = safeProviderIdForOutput(providerId);
    if (!provider) {
      checks.push({
        providerId: safeProviderId,
        ok: false,
        adapter: "openai-compatible",
        enabled: false,
        model: "",
        authMode: "none",
        smokeAttempted: false,
        readMode: "metadata_only",
        error: `Provider ${safeProviderId} is not configured.`
      });
      troubleshooting.push(`Add provider ${safeProviderId} to providers.providers or choose an existing provider id.`);
      continue;
    }

    if (provider.adapter !== "openai-compatible" || !input.smoke) {
      const capabilityError = providerReadinessCapabilityError(provider);
      const authError = providerAuthMetadataError(provider);
      const error = provider.enabled
        ? capabilityError ?? authError
        : "Provider is disabled.";
      checks.push({
        providerId,
        ok: !error,
        adapter: provider.adapter,
        enabled: provider.enabled,
        model: provider.model,
        authMode: provider.authMode,
        smokeAttempted: false,
        readMode: "metadata_only",
        ...(provider.baseUrl ? { baseUrl: redactProviderUrl(provider.baseUrl) } : {}),
        ...(provider.apiKeyEnv ? { apiKeyEnv: provider.apiKeyEnv } : {}),
        ...(error ? { error } : {})
      });
      if (!provider.enabled) troubleshooting.push(`Enable provider ${providerId} before selecting it for review.`);
      if (capabilityError) troubleshooting.push(`Provider ${providerId} must support review and JSON output before it can be selected for review.`);
      if (authError) troubleshooting.push(`Provider ${providerId} must declare an API key environment variable before it can be selected for review.`);
      continue;
    }

    checks.push(await smokeOpenAICompatibleProvider({ providerId, provider, fetchImpl, env }));
  }

  return {
    ok: checks.every((check) => check.ok),
    command: "providers doctor",
    ...(input.providerId ? { providerId: safeProviderIdForOutput(input.providerId) } : {}),
    defaultProviderId: input.registry.defaultProviderId,
    checks,
    troubleshooting
  };
}

async function smokeOpenAICompatibleProvider(input: {
  providerId: string;
  provider: ProviderRegistryEntry;
  fetchImpl: typeof fetch;
  env: Record<string, string | undefined>;
}): Promise<ProviderDoctorCheck> {
  const baseCheck = {
    providerId: input.providerId,
    adapter: input.provider.adapter,
    enabled: input.provider.enabled,
    model: input.provider.model,
    authMode: input.provider.authMode,
    smokeAttempted: true,
    readMode: "openai_compatible_models" as const,
    ...(input.provider.baseUrl ? { baseUrl: redactProviderUrl(input.provider.baseUrl) } : {}),
    ...(input.provider.apiKeyEnv ? { apiKeyEnv: input.provider.apiKeyEnv } : {})
  };
  if (!input.provider.enabled) return { ...baseCheck, ok: false, error: "Provider is disabled." };
  const capabilityError = providerReadinessCapabilityError(input.provider);
  if (capabilityError) return { ...baseCheck, ok: false, error: capabilityError };
  const authError = providerAuthMetadataError(input.provider);
  if (authError) return { ...baseCheck, ok: false, error: authError };
  if (!input.provider.baseUrl) return { ...baseCheck, ok: false, error: "OpenAI-compatible provider requires baseUrl for smoke checks." };
  const targetError = providerSmokeTargetError(input.provider.baseUrl, input.provider);
  if (targetError) return { ...baseCheck, ok: false, error: targetError };
  if (input.provider.authMode === "api-key-env" && input.provider.apiKeyEnv && !input.env[input.provider.apiKeyEnv]) {
    return { ...baseCheck, ok: false, error: `Missing API key environment variable ${input.provider.apiKeyEnv}.` };
  }

  try {
    const response = await input.fetchImpl(buildOpenAIModelsUrl(input.provider.baseUrl), {
      signal: signalWithTimeout(input.provider.timeoutMs),
      headers: {
        Accept: "application/json",
        ...(input.provider.authMode === "api-key-env" && input.provider.apiKeyEnv
          ? { Authorization: `Bearer ${input.env[input.provider.apiKeyEnv]}` }
          : {})
      }
    });
    const text = await response.text();
    if (!response.ok) {
      const redactedText = redactProviderSmokeText(text, input.provider, input.env);
      const error = `OpenAI-compatible models endpoint returned ${response.status}: ${redactedText.slice(0, 300)}`;
      return {
        ...baseCheck,
        ok: false,
        errorCategory: classifyProviderError(`${response.status} ${redactedText}`),
        error
      };
    }
    let parsed: { data?: unknown[] };
    try {
      parsed = JSON.parse(text) as { data?: unknown[] };
    } catch {
      return {
        ...baseCheck,
        ok: false,
        errorCategory: "model_output_schema",
        error: "Models response was not valid JSON."
      };
    }
    const modelIds = Array.isArray(parsed.data) ? extractModelIds(parsed.data) : [];
    const missingModelError = modelIds.length === 0
      ? "Models response did not advertise any usable model ids."
      : `Models response did not advertise configured model ${input.provider.model}.`;
    return {
      ...baseCheck,
      ok: Array.isArray(parsed.data) && modelIds.includes(input.provider.model),
      ...(Array.isArray(parsed.data) ? { modelCount: modelIds.length } : { errorCategory: "model_output_schema" as const, error: "Models response did not contain a data array." }),
      ...(Array.isArray(parsed.data) && !modelIds.includes(input.provider.model)
        ? {
            errorCategory: "model_output_schema" as const,
            error: missingModelError
          }
        : {})
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const errorCategory = classifyProviderError(message);
    const redactedMessage = redactProviderSmokeText(message, input.provider, input.env);
    return {
      ...baseCheck,
      ok: false,
      errorCategory,
      error: `${errorCategory}: ${redactedMessage}`
    };
  }
}

function signalWithTimeout(timeoutMs: number | undefined): AbortSignal | undefined {
  return AbortSignal.timeout(timeoutMs && timeoutMs > 0 ? timeoutMs : DEFAULT_PROVIDER_SMOKE_TIMEOUT_MS);
}

function providerReadinessCapabilityError(provider: ProviderRegistryEntry): string | undefined {
  if (!provider.capabilities.review) return "Provider is not review-capable.";
  if (!provider.capabilities.jsonOutput) return "Provider does not declare JSON output support.";
  return undefined;
}

function providerAuthMetadataError(provider: ProviderRegistryEntry): string | undefined {
  if (provider.authMode === "api-key-env" && !provider.apiKeyEnv) return "Provider requires apiKeyEnv for api-key-env auth.";
  return undefined;
}

function redactProviderSmokeText(
  value: string,
  provider: ProviderRegistryEntry,
  env: Record<string, string | undefined>
): string {
  let redacted = redactSecrets(value);
  const providerKey = provider.authMode === "api-key-env" && provider.apiKeyEnv
    ? env[provider.apiKeyEnv]
    : undefined;
  if (providerKey) redacted = redacted.split(providerKey).join("[redacted-provider-key]");
  return redacted;
}

function safeProviderIdForOutput(value: string): string {
  return isProviderId(value) ? value : "[invalid-provider-id]";
}

function providerSmokeTargetError(baseUrl: string, provider: ProviderRegistryEntry): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return "OpenAI-compatible provider baseUrl must be a valid URL for smoke checks.";
  }
  const loopback = isLoopbackHost(parsed.hostname);
  if (loopback && provider.capabilities.local) return undefined;
  if (isUnsafeSmokeHost(parsed.hostname)) {
    return "OpenAI-compatible smoke target must not point to private, link-local, loopback, or cloud metadata hosts.";
  }
  return undefined;
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1" || normalized === "[::1]";
}

function isUnsafeSmokeHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1");
  if (
    isLoopbackHost(hostname) ||
    normalized === "metadata" ||
    normalized === "metadata.google.internal" ||
    normalized === "metadata.azure.internal" ||
    normalized === "169.254.169.254" ||
    normalized === "100.100.100.200"
  ) {
    return true;
  }
  const ipVersion = isIP(normalized);
  if (ipVersion === 4) return isPrivateOrLinkLocalIpv4(normalized);
  if (ipVersion === 6) return isPrivateOrLinkLocalIpv6(normalized);
  return false;
}

function isPrivateOrLinkLocalIpv4(value: string): boolean {
  const parts = value.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts;
  return a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127);
}

function isPrivateOrLinkLocalIpv6(value: string): boolean {
  return value === "::" ||
    value.startsWith("fc") ||
    value.startsWith("fd") ||
    value.startsWith("fe80:");
}

function extractModelIds(data: unknown[]): string[] {
  return data.flatMap((entry) => {
    if (typeof entry === "string") return [entry];
    if (entry && typeof entry === "object" && typeof (entry as { id?: unknown }).id === "string") {
      return [(entry as { id: string }).id];
    }
    return [];
  });
}

export function buildOpenAIModelsUrl(baseUrl: string): string {
  const parsed = new URL(baseUrl);
  parsed.pathname = `${parsed.pathname.replace(/\/+$/, "")}/models`;
  return parsed.toString();
}

export function classifyProviderError(message: string): ProviderErrorCategory {
  const normalized = message.toLowerCase();
  if (/\b(unauthorized|forbidden|invalid api key|401|403)\b/.test(normalized)) return "auth";
  if (/\b(rate limit|quota|too many requests|429|insufficient_quota)\b/.test(normalized)) return "quota_or_rate_limit";
  if (/\b(timeout|timed out|etimedout|abort(?:ed)?)\b/.test(normalized)) return "timeout";
  if (/\b(context length|context window|maximum context|token limit|too many tokens)\b/.test(normalized)) return "context_limit";
  if (/\b(json|schema|parseable|malformed output|invalid response)\b/.test(normalized)) return "model_output_schema";
  if (/\b(econnreset|econnrefused|refused|5\d\d|temporarily|unavailable|overload)\b/.test(normalized)) return "transient";
  return "unknown";
}

export function isProviderId(value: string): boolean {
  return /^[A-Za-z0-9_.:-]+$/.test(value) && value !== "." && value !== ".." && !containsSecretLikeText(value);
}

export function isApiKeyEnvName(value: string): boolean {
  return /^[A-Z_][A-Z0-9_]*$/.test(value) && !/^(?:gh[pousr]_|github_pat_|sk-|xox[baprs]-)/i.test(value);
}

export function redactProviderUrl(value: string): string {
  try {
    const url = new URL(value);
    for (const key of [...url.searchParams.keys()]) {
      if (/(key|token|secret|password|session)/i.test(key)) url.searchParams.set(key, "[redacted-secret]");
    }
    if (url.username) url.username = "[redacted]";
    if (url.password) url.password = "[redacted-secret]";
    return url.toString();
  } catch {
    return redactSecrets(value);
  }
}
