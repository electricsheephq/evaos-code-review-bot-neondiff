import { lookup as defaultDnsLookup } from "node:dns/promises";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { containsSecretLikeText, redactSecrets } from "./secrets.js";

const DEFAULT_PROVIDER_SMOKE_TIMEOUT_MS = 30_000;
const MAX_PROVIDER_SMOKE_RESPONSE_BYTES = 256 * 1024;
const REMOTE_SMOKE_OPT_IN_ERROR = "Remote OpenAI-compatible smoke checks require explicit remote opt-in and --provider <id>.";
const REMOTE_SMOKE_ENV_OPT_IN = "NEONDIFF_ALLOW_REMOTE_SMOKE";

type DnsLookupAddress = { address: string; family: number };
type DnsLookupImpl = (
  hostname: string,
  options: { all: true; verbatim?: boolean }
) => Promise<DnsLookupAddress[]>;

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
  temperature?: number;
  jsonObjectResponseFormat?: boolean;
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
  allowRemoteSmoke?: boolean;
  fetchImpl?: typeof fetch;
  dnsLookupImpl?: DnsLookupImpl;
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
      const smokeUnsupportedError = input.smoke && provider.adapter !== "openai-compatible"
        ? `Smoke checks are not implemented for ${provider.adapter} providers.`
        : undefined;
      const error = provider.enabled
        ? smokeUnsupportedError ?? capabilityError ?? authError
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
      if (!provider.enabled) troubleshooting.push(`Enable provider ${safeProviderId} before selecting it for review.`);
      if (capabilityError) troubleshooting.push(`Provider ${safeProviderId} must support review and JSON output before it can be selected for review.`);
      if (authError) troubleshooting.push(`Provider ${safeProviderId} must declare an API key environment variable before it can be selected for review.`);
      continue;
    }

    checks.push(await smokeOpenAICompatibleProvider({
      providerId,
      provider,
      fetchImpl,
      dnsLookupImpl: input.dnsLookupImpl ?? defaultDnsLookup,
      env,
      allowRemoteSmoke: input.allowRemoteSmoke === true || isRemoteSmokeEnvOptIn(env)
    }));
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
  dnsLookupImpl: DnsLookupImpl;
  env: Record<string, string | undefined>;
  allowRemoteSmoke: boolean;
}): Promise<ProviderDoctorCheck> {
  const safeProviderId = safeProviderIdForOutput(input.providerId);
  const baseCheck = {
    providerId: safeProviderId,
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
  const target = await resolveProviderSmokeTarget({
    baseUrl: input.provider.baseUrl,
    provider: input.provider,
    env: input.env,
    allowRemoteSmoke: input.allowRemoteSmoke,
    dnsLookupImpl: input.dnsLookupImpl
  });
  if (target.error) return { ...baseCheck, ok: false, error: target.error };
  if (input.provider.authMode === "api-key-env" && input.provider.apiKeyEnv && !input.env[input.provider.apiKeyEnv]) {
    return { ...baseCheck, ok: false, error: `Missing API key environment variable ${input.provider.apiKeyEnv}.` };
  }

  try {
    const requestUrl = buildOpenAIModelsUrl(input.provider.baseUrl);
    const requestInit: RequestInit = {
      method: "GET",
      signal: signalWithTimeout(input.provider.timeoutMs),
      redirect: "manual",
      headers: {
        Accept: "application/json",
        ...(input.provider.authMode === "api-key-env" && input.provider.apiKeyEnv
          ? { Authorization: `Bearer ${input.env[input.provider.apiKeyEnv]}` }
          : {})
      }
    };
    const response = input.fetchImpl === fetch
      ? await fetchProviderModels(requestUrl, requestInit, target.target, input.provider.timeoutMs)
      : await input.fetchImpl(requestUrl, requestInit);
    let text: string;
    try {
      text = await readResponseTextBounded(response);
    } catch (error) {
      if (error instanceof ProviderSmokeResponseTooLargeError) {
        return {
          ...baseCheck,
          ok: false,
          errorCategory: "model_output_schema",
          error: error.message
        };
      }
      throw error;
    }
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
    if (error instanceof ProviderSmokeResponseTooLargeError) {
      return {
        ...baseCheck,
        ok: false,
        errorCategory: "model_output_schema",
        error: error.message
      };
    }
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

function isRemoteSmokeEnvOptIn(env: Record<string, string | undefined>): boolean {
  return /^(?:1|true|yes)$/i.test(env[REMOTE_SMOKE_ENV_OPT_IN] ?? "");
}

function signalWithTimeout(timeoutMs: number | undefined): AbortSignal | undefined {
  const timeout = timeoutMs && timeoutMs > 0 ? timeoutMs : DEFAULT_PROVIDER_SMOKE_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const maybeUnref = timer as { unref?: () => void };
  if (typeof maybeUnref.unref === "function") maybeUnref.unref();
  return controller.signal;
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

type OpenAICompatibleTargetPurpose = "smoke" | "review";

export function openAICompatibleProviderTargetError(
  baseUrl: string,
  provider: ProviderRegistryEntry,
  purpose: OpenAICompatibleTargetPurpose
): string | undefined {
  const targetLabel = purpose === "review" ? "review target" : "smoke target";
  const operationLabel = purpose === "review" ? "review execution" : "smoke checks";
  const disabledVerb = purpose === "review" ? "is" : "are";
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return `OpenAI-compatible provider baseUrl must be a valid URL for ${operationLabel}.`;
  }
  if (parsed.username || parsed.password) {
    return `OpenAI-compatible ${targetLabel} must not include username or password credentials.`;
  }
  if (containsSecretLikeText(decodeURIComponent(`${parsed.pathname}${parsed.hash}`))) {
    return `OpenAI-compatible ${targetLabel} must not include secret-like path or fragment values.`;
  }
  for (const key of parsed.searchParams.keys()) {
    if (/(key|token|secret|password|session|cookie)/i.test(key)) {
      return `OpenAI-compatible ${targetLabel} must not include credential query parameters.`;
    }
  }
  const loopback = isLoopbackHost(parsed.hostname);
  if (loopback && provider.capabilities.local) return undefined;
  if (isUnsafeSmokeHost(parsed.hostname)) {
    return `OpenAI-compatible ${targetLabel} must not point to private, link-local, loopback, or cloud metadata hosts.`;
  }
  if (!loopback) {
    return `Remote OpenAI-compatible ${operationLabel} ${disabledVerb} disabled until the transport can pin the validated DNS result.`;
  }
  return undefined;
}

interface ProviderSmokeTarget {
  remote: boolean;
  pinnedAddress?: DnsLookupAddress;
}

async function resolveProviderSmokeTarget(input: {
  baseUrl: string;
  provider: ProviderRegistryEntry;
  env: Record<string, string | undefined>;
  allowRemoteSmoke: boolean;
  dnsLookupImpl: DnsLookupImpl;
}): Promise<{ target?: ProviderSmokeTarget; error?: string }> {
  let parsed: URL;
  try {
    parsed = new URL(input.baseUrl);
  } catch {
    return { error: "OpenAI-compatible provider baseUrl must be a valid URL for smoke checks." };
  }
  if (parsed.username || parsed.password) {
    return { error: "OpenAI-compatible smoke target must not include username or password credentials." };
  }
  if (containsSecretLikeText(decodeURIComponent(`${parsed.pathname}${parsed.hash}`))) {
    return { error: "OpenAI-compatible smoke target must not include secret-like path or fragment values." };
  }
  for (const key of parsed.searchParams.keys()) {
    if (/(key|token|secret|password|session|cookie)/i.test(key)) {
      return { error: "OpenAI-compatible smoke target must not include credential query parameters." };
    }
  }
  const loopback = isLoopbackHost(parsed.hostname);
  if (loopback && input.provider.capabilities.local) return { target: { remote: false } };
  if (isUnsafeSmokeHost(parsed.hostname)) {
    return { error: "OpenAI-compatible smoke target must not point to private, link-local, loopback, or cloud metadata hosts." };
  }
  if (parsed.protocol !== "https:") {
    return { error: "Remote OpenAI-compatible smoke target must use HTTPS." };
  }
  if (!input.allowRemoteSmoke) return { error: REMOTE_SMOKE_OPT_IN_ERROR };
  if (input.provider.authMode !== "api-key-env" || !input.provider.apiKeyEnv) {
    return { error: "Hosted remote smoke requires authMode api-key-env and apiKeyEnv." };
  }
  if (!input.env[input.provider.apiKeyEnv]) {
    return { error: `Missing API key environment variable ${input.provider.apiKeyEnv}.` };
  }
  const pinnedAddress = await resolvePinnedRemoteSmokeAddress(parsed.hostname, input.dnsLookupImpl);
  if (pinnedAddress.error) return { error: pinnedAddress.error };
  return { target: { remote: true, pinnedAddress: pinnedAddress.address } };
}

async function resolvePinnedRemoteSmokeAddress(
  hostname: string,
  dnsLookupImpl: DnsLookupImpl
): Promise<{ address?: DnsLookupAddress; error?: string }> {
  let addresses: DnsLookupAddress[];
  try {
    addresses = await dnsLookupImpl(hostname, { all: true, verbatim: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { error: `Remote OpenAI-compatible smoke DNS lookup failed: ${redactSecrets(message)}` };
  }
  if (addresses.length === 0) {
    return { error: "Remote OpenAI-compatible smoke DNS lookup returned no addresses." };
  }
  if (addresses.some((entry) => isUnsafeSmokeHost(entry.address))) {
    return { error: "Remote OpenAI-compatible smoke DNS resolved to an unsafe private, link-local, loopback, or metadata address." };
  }
  const address = addresses.find((entry) => entry.family === 4 || entry.family === 6);
  if (!address) {
    return { error: "Remote OpenAI-compatible smoke DNS lookup returned no IPv4 or IPv6 addresses." };
  }
  return { address };
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1");
  if (normalized === "localhost" || normalized === "::1") return true;
  if (isIP(normalized) === 4) return normalized.split(".")[0] === "127";
  const mappedIpv4 = ipv4MappedIpv6Address(normalized);
  return mappedIpv4 ? isLoopbackHost(mappedIpv4) : false;
}

function isUnsafeSmokeHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1");
  if (
    isLoopbackHost(hostname) ||
    normalized === "metadata" ||
    normalized === "metadata.google.internal" ||
    normalized === "metadata.azure.internal" ||
    normalized === "0.0.0.0" ||
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
  const mappedIpv4 = ipv4MappedIpv6Address(value);
  if (mappedIpv4) return isPrivateOrLinkLocalIpv4(mappedIpv4);
  const firstHextet = Number.parseInt(value.split(":")[0] ?? "", 16);
  return value === "::" ||
    value.startsWith("fc") ||
    value.startsWith("fd") ||
    (Number.isInteger(firstHextet) && firstHextet >= 0xfe80 && firstHextet <= 0xfebf);
}

function ipv4MappedIpv6Address(value: string): string | undefined {
  const normalized = value.toLowerCase();
  if (!normalized.startsWith("::ffff:")) return undefined;
  const suffix = normalized.slice("::ffff:".length);
  if (isIP(suffix) === 4) return suffix;
  const parts = suffix.split(":");
  if (parts.length !== 2) return undefined;
  const high = Number.parseInt(parts[0], 16);
  const low = Number.parseInt(parts[1], 16);
  if ([high, low].some((part) => !Number.isInteger(part) || part < 0 || part > 0xffff)) return undefined;
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

class ProviderSmokeResponseTooLargeError extends Error {
  constructor() {
    super(`Models response exceeded ${MAX_PROVIDER_SMOKE_RESPONSE_BYTES} byte limit.`);
  }
}

async function fetchProviderModels(
  url: string,
  init: RequestInit,
  target: ProviderSmokeTarget | undefined,
  timeoutMs: number | undefined
): Promise<Response> {
  const parsed = new URL(url);
  const requestFn = parsed.protocol === "https:" ? httpsRequest : httpRequest;
  const headers = new Headers(init.headers);
  const headerObject = Object.fromEntries(headers.entries());
  return new Promise((resolve, reject) => {
    let settled = false;
    const request = requestFn({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port,
      path: `${parsed.pathname}${parsed.search}`,
      method: "GET",
      headers: headerObject,
      timeout: timeoutMs && timeoutMs > 0 ? timeoutMs : DEFAULT_PROVIDER_SMOKE_TIMEOUT_MS,
      ...(target?.remote && target.pinnedAddress
        ? {
            servername: parsed.hostname,
            lookup: (_hostname, _options, callback) => {
              callback(null, target.pinnedAddress!.address, target.pinnedAddress!.family);
            }
          }
        : {})
    }, (response) => {
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      response.on("data", (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        totalBytes += buffer.byteLength;
        if (totalBytes > MAX_PROVIDER_SMOKE_RESPONSE_BYTES) {
          request.destroy(new ProviderSmokeResponseTooLargeError());
          return;
        }
        chunks.push(buffer);
      });
      response.on("end", () => {
        if (settled) return;
        settled = true;
        init.signal?.removeEventListener("abort", abort);
        resolve(new Response(Buffer.concat(chunks), {
          status: response.statusCode ?? 0,
          statusText: response.statusMessage,
          headers: responseHeadersToHeaders(response.headers)
        }));
      });
    });
    const abort = () => request.destroy(new Error("Provider smoke request aborted."));
    init.signal?.addEventListener("abort", abort, { once: true });
    request.on("timeout", () => request.destroy(new Error("Provider smoke request timed out.")));
    request.on("error", (error) => {
      if (settled) return;
      settled = true;
      init.signal?.removeEventListener("abort", abort);
      reject(error);
    });
    request.end();
  });
}

function responseHeadersToHeaders(headers: IncomingHttpHeaders): Headers {
  const output = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const entry of value) output.append(key, entry);
    } else {
      output.set(key, String(value));
    }
  }
  return output;
}

async function readResponseTextBounded(response: Response): Promise<string> {
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_PROVIDER_SMOKE_RESPONSE_BYTES) {
    throw new ProviderSmokeResponseTooLargeError();
  }
  if (!response.body) return response.text();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_PROVIDER_SMOKE_RESPONSE_BYTES) {
        throw new ProviderSmokeResponseTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(output);
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
  const pathname = parsed.pathname.replace(/\/+$/, "");
  parsed.pathname = pathname.endsWith("/models") ? pathname : `${pathname}/models`;
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
