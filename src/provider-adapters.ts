import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  REVIEW_FINDINGS_JSON_SCHEMA,
  REVIEW_FINDINGS_JSON_SCHEMA_NAME,
  REVIEW_FINDINGS_JSON_SCHEMA_STRICT
} from "./findings-schema.js";
import { parseFindings } from "./findings.js";
import { openAICompatibleProviderTargetError, type ProviderRegistryEntry, type ProviderStructuredOutputMode } from "./providers.js";
import { containsSecretLikeText, redactSecrets } from "./secrets.js";

const EVIDENCE_PREVIEW_LIMIT = 500;
const REVIEW_JSON_EXTRACTION_CHAR_LIMIT = 200_000;
const REVIEW_JSON_NESTED_OBJECT_MAX_DEPTH = 32;
const EVIDENCE_PREVIEW_TRUNCATED_SENTINEL = "...[truncated]";
const DEFAULT_OPENAI_COMPATIBLE_REVIEW_TIMEOUT_MS = 180_000;
const REDACTION_TOKENS = [
  "[redacted-private-evidence]",
  "[redacted-private-field]",
  "[redacted-secret]",
  "[redacted-sensitive-field]",
  "[redacted-unserializable-evidence]"
] as const;
const SCHEMA_CONSTRAINED_OUTPUT_MODES = new Set<ProviderStructuredOutputMode>([
  "openai-json-schema",
  "llama-cpp-json-schema",
  "vllm-structured-outputs",
  "vllm-guided-json",
  "ollama-format-json-schema",
  "sglang-json-schema"
]);

export type ProviderAdapterErrorClass =
  | "auth"
  | "throttle"
  | "network"
  | "timeout"
  | "model-output"
  | "unknown";

export interface ProviderAdapterFixture {
  id: string;
  providerId: string;
  adapterId: string;
  model: string;
  prompt: string;
  expectJsonObject?: boolean;
  expectReviewJson?: boolean;
}

export interface ProviderAdapterExecutionInput {
  fixtureId: string;
  providerId: string;
  adapterId: string;
  model: string;
  prompt: string;
}

export interface ProviderAdapterExecutionResult {
  text: string;
  rawEvidence?: unknown;
  reviewJsonValidated?: boolean;
}

export interface ProviderRuntimeAdapter {
  id: string;
  execute(input: ProviderAdapterExecutionInput): Promise<ProviderAdapterExecutionResult>;
}

export interface OpenAICompatibleReviewAdapterOptions {
  providerId: string;
  provider: ProviderRegistryEntry;
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
}

export interface ProviderAdapterFixtureEvidence {
  promptSha256: string;
  redactedOutputSha256?: string;
  outputPreview?: string;
  rawEvidencePreview?: string;
}

export interface ProviderAdapterFixtureError {
  class: ProviderAdapterErrorClass;
  message: string;
}

export interface ProviderAdapterFixtureResultBase {
  fixtureId: string;
  providerId: string;
  adapterId: string;
  model: string;
  evidence: ProviderAdapterFixtureEvidence;
}

export interface ProviderAdapterFixtureSuccessResult extends ProviderAdapterFixtureResultBase {
  ok: true;
  error?: never;
}

export interface ProviderAdapterFixtureFailureResult extends ProviderAdapterFixtureResultBase {
  ok: false;
  error: ProviderAdapterFixtureError;
}

export type ProviderAdapterFixtureResult =
  | ProviderAdapterFixtureSuccessResult
  | ProviderAdapterFixtureFailureResult;

export async function runProviderAdapterFixture(input: {
  adapter: ProviderRuntimeAdapter;
  fixture: ProviderAdapterFixture;
}): Promise<ProviderAdapterFixtureResult> {
  const { adapter, fixture } = input;
  const baseResult = {
    fixtureId: fixture.id,
    providerId: fixture.providerId,
    adapterId: fixture.adapterId,
    model: fixture.model,
    evidence: {
      promptSha256: sha256(fixture.prompt)
    }
  };

  try {
    const execution = await adapter.execute({
      fixtureId: fixture.id,
      providerId: fixture.providerId,
      adapterId: fixture.adapterId,
      model: fixture.model,
      prompt: fixture.prompt
    });
    const evidence = buildFixtureEvidence(fixture.prompt, execution);
    const reviewJsonError = fixture.expectReviewJson && !execution.reviewJsonValidated
      ? validateReviewJsonOutput(execution.text)
      : undefined;
    if (reviewJsonError || (fixture.expectJsonObject && !isJsonObject(execution.text))) {
      return {
        ok: false,
        ...baseResult,
        evidence,
        error: {
          class: "model-output",
          message: reviewJsonError ?? "Adapter output was not a JSON object."
        }
      };
    }
    return {
      ok: true,
      ...baseResult,
      evidence
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      ...baseResult,
      error: {
        class: classifyProviderAdapterError(message),
        message: redactPrivateEvidenceText(message, fixture.prompt)
      }
    };
  }
}

export function classifyProviderAdapterError(message: string): ProviderAdapterErrorClass {
  const normalized = message.toLowerCase();
  if (/\b(unauthorized|forbidden|invalid[ _-]api[ _-]key|missing[ _-]api[ _-]key|401|403)\b/.test(normalized)) return "auth";
  if (/\b(rate[ _-]limit|quota|too many requests|429|insufficient[ _-]quota|throttl(?:e|ed|ing))\b/.test(normalized)) return "throttle";
  // Provider timeout wording wins over network codes in combined messages to keep cooldown evidence deterministic.
  if (/\b(time[ _-]?out|timed[ _-]out|etimedout|abort(?:ed)?|deadline exceeded)\b/.test(normalized)) return "timeout";
  // Strong schema/output tokens win over transport wording; weaker wrapper terms stay below the network branch.
  if (/\b(json|schema|parseable|malformed output|invalid output|review object|review json|findings array|tool call)\b/.test(normalized)) {
    return "model-output";
  }
  if (/\b(econnreset|econnrefused|enotfound|eai_again|socket|dns|fetch failed|service unavailable|temporarily unavailable|overload|connection[ _-]refused|connection[ _-]reset|network[ _-](?:error|failure|failed|unreachable|unavailable|down))\b/.test(normalized)) return "network";
  if (/\b(invalid response|structured output)\b/.test(normalized)) return "model-output";
  return "unknown";
}

export function createOpenAICompatibleReviewAdapter(options: OpenAICompatibleReviewAdapterOptions): ProviderRuntimeAdapter {
  return {
    id: "openai-compatible",
    async execute(input) {
      const provider = options.provider;
      const fetchImpl = options.fetchImpl ?? fetch;
      const env = options.env ?? process.env;
      const baseUrl = provider.baseUrl;
      if (!baseUrl) throw new Error("OpenAI-compatible provider requires baseUrl for review execution.");
      const targetError = openAICompatibleProviderTargetError(baseUrl, provider, "review");
      if (targetError) throw new Error(targetError);

      const apiKey = resolveOpenAICompatibleApiKey(provider, env);
      const timeout = createAbortSignal(provider.timeoutMs);
      const structuredOutput = buildStructuredOutputRequestFields(provider);
      const requestBody = {
        model: input.model,
        stream: false,
        ...(provider.temperature === undefined ? {} : { temperature: provider.temperature }),
        ...structuredOutput.requestFields,
        messages: [
          {
            role: "system",
            content: "Return only the NeonDiff review JSON object. Do not include markdown, prose, tool calls, or raw diff excerpts."
          },
          {
            role: "user",
            content: input.prompt
          }
        ]
      };
      try {
        const response = await fetchImpl(buildOpenAIChatCompletionsUrl(baseUrl), {
          method: "POST",
          signal: timeout.signal,
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
          },
          body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
          const responseErrorText = await readResponseTextWithAbort(response, timeout.signal);
          throw new Error(openAICompatibleStatusErrorMessage(response.status, responseErrorText));
        }

        const responseText = await readResponseTextWithAbort(response, timeout.signal);
        const parsed = parseOpenAICompatibleResponse(responseText);
        const content = extractOpenAICompatibleMessageContent(parsed);
        const reviewOutput = normalizeReviewJsonOutput(content);
        if (!reviewOutput.ok) {
          const finishReason = extractOpenAICompatibleFinishReason(parsed);
          if (finishReason === "length") {
            throw new Error("OpenAI-compatible review output was truncated before a parseable JSON review object (finish_reason=length).");
          }
          throw new Error(reviewOutput.error);
        }

        return {
          text: reviewOutput.text,
          reviewJsonValidated: true,
          rawEvidence: {
            providerId: options.providerId,
            adapterId: input.adapterId,
            model: input.model,
            baseUrl,
            structuredOutputMode: structuredOutput.evidenceMode,
            status: response.status,
            ...(typeof parsed.id === "string" ? { responseId: parsed.id } : {}),
            ...extractOpenAICompatibleChoiceEvidence(parsed),
            ...extractOpenAICompatibleUsageEvidence(parsed)
          }
        };
      } finally {
        timeout.dispose();
      }
    }
  };
}

function buildStructuredOutputRequestFields(provider: ProviderRegistryEntry): {
  requestFields: Record<string, unknown>;
  evidenceMode: string;
} {
  const mode = resolveStructuredOutputMode(provider);
  const evidenceMode = SCHEMA_CONSTRAINED_OUTPUT_MODES.has(mode)
    ? `constrained:${mode}`
    : "recovery";

  switch (mode) {
    case "none":
      return { requestFields: {}, evidenceMode };
    case "json-object":
      return { requestFields: { response_format: { type: "json_object" } }, evidenceMode };
    case "openai-json-schema":
    case "sglang-json-schema":
      return {
        requestFields: {
          response_format: {
            type: "json_schema",
            json_schema: {
              name: REVIEW_FINDINGS_JSON_SCHEMA_NAME,
              strict: REVIEW_FINDINGS_JSON_SCHEMA_STRICT,
              schema: REVIEW_FINDINGS_JSON_SCHEMA
            }
          }
        },
        evidenceMode
      };
    case "llama-cpp-json-schema":
      return {
        requestFields: {
          response_format: {
            type: "json_schema",
            schema: REVIEW_FINDINGS_JSON_SCHEMA
          }
        },
        evidenceMode
      };
    case "vllm-structured-outputs":
      return {
        requestFields: {
          structured_outputs: {
            json: REVIEW_FINDINGS_JSON_SCHEMA
          }
        },
        evidenceMode
      };
    case "vllm-guided-json":
      return {
        requestFields: {
          guided_json: REVIEW_FINDINGS_JSON_SCHEMA
        },
        evidenceMode
      };
    case "ollama-format-json-schema":
      return {
        requestFields: {
          format: REVIEW_FINDINGS_JSON_SCHEMA
        },
        evidenceMode
      };
  }
}

function resolveStructuredOutputMode(provider: ProviderRegistryEntry): ProviderStructuredOutputMode {
  if (provider.structuredOutputMode) return provider.structuredOutputMode;
  if (provider.capabilities.jsonOutput && provider.jsonObjectResponseFormat !== false) return "json-object";
  return "none";
}

export function buildOpenAIChatCompletionsUrl(baseUrl: string): string {
  const parsed = new URL(baseUrl);
  const pathname = parsed.pathname.replace(/\/{2,}/g, "/").replace(/\/+$/, "");
  parsed.pathname = pathname.endsWith("/chat/completions") ? pathname : `${pathname}/chat/completions`;
  return parsed.toString();
}

function buildFixtureEvidence(
  prompt: string,
  execution: ProviderAdapterExecutionResult
): ProviderAdapterFixtureEvidence {
  const redactedOutput = redactPrivateEvidenceText(execution.text, prompt);
  return {
    promptSha256: sha256(prompt),
    redactedOutputSha256: sha256(redactedOutput),
    outputPreview: previewEvidenceText(redactedOutput),
    ...(execution.rawEvidence === undefined
      ? {}
      : { rawEvidencePreview: previewEvidenceText(stableStringify(redactPrivateEvidenceValue(execution.rawEvidence, prompt))) })
  };
}

function isJsonObject(value: string): boolean {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Boolean(parsed && typeof parsed === "object" && !Array.isArray(parsed));
  } catch {
    return false;
  }
}

function validateReviewJsonOutput(value: string): string | undefined {
  const result = normalizeReviewJsonOutput(value);
  return result.ok ? undefined : result.error;
}

function normalizeReviewJsonOutput(value: string): { ok: true; text: string } | { ok: false; error: string } {
  let parsed: unknown;
  let reviewJson = value.trim();
  try {
    parsed = JSON.parse(reviewJson) as unknown;
  } catch {
    try {
      reviewJson = extractReviewJsonObject(value);
      parsed = JSON.parse(reviewJson) as unknown;
    } catch {
      return { ok: false, error: "Adapter output was not a parseable JSON review object." };
    }
  }
  const reviewObject = findReviewJsonObject(parsed);
  if (!reviewObject) {
    return { ok: false, error: "Adapter output did not contain a review findings array." };
  }
  // Nested provider envelopes are canonicalized; top-level review JSON keeps the adapter's original text.
  if (reviewObject !== parsed) reviewJson = JSON.stringify(reviewObject);
  const { dropped } = parseFindings(reviewObject);
  if (dropped.length > 0) return { ok: false, error: "Adapter output contained invalid review findings." };
  return { ok: true, text: reviewJson };
}

function extractReviewJsonObject(text: string): string {
  const boundedText = text.slice(0, REVIEW_JSON_EXTRACTION_CHAR_LIMIT);
  const fencedMatches = [...boundedText.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
  for (const fenced of fencedMatches) {
    const candidate = fenced[1]!.trim();
    const reviewJson = reviewJsonObjectText(candidate);
    if (reviewJson) return reviewJson;
  }

  let depth = 0;
  let candidateStart: number | undefined;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < boundedText.length; index += 1) {
    const char = boundedText[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }
    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") {
      if (depth === 0) candidateStart = index;
      depth += 1;
      continue;
    }
    if (char === "}") {
      if (depth === 0 || candidateStart === undefined) continue;
      depth -= 1;
      if (depth !== 0) continue;
      const candidate = boundedText.slice(candidateStart, index + 1).trim();
      candidateStart = undefined;
      if (!candidate.includes("\"findings\"")) continue;
      const reviewJson = reviewJsonObjectText(candidate);
      if (reviewJson) return reviewJson;
    }
  }
  throw new Error("Adapter output did not contain a parseable JSON review object.");
}

function reviewJsonObjectText(candidate: string): string | undefined {
  try {
    const parsed = JSON.parse(candidate) as unknown;
    const reviewObject = findReviewJsonObject(parsed);
    if (!reviewObject) return undefined;
    return reviewObject === parsed ? candidate : JSON.stringify(reviewObject);
  } catch {
    return undefined;
  }
}

function findReviewJsonObject(value: unknown, depth = 0): Record<string, unknown> | undefined {
  if (depth > REVIEW_JSON_NESTED_OBJECT_MAX_DEPTH) return undefined;
  if (!value || typeof value !== "object") return undefined;
  if (!Array.isArray(value) && Array.isArray((value as { findings?: unknown }).findings)) {
    return value as Record<string, unknown>;
  }
  const children = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
  for (const child of children) {
    const reviewObject = findReviewJsonObject(child, depth + 1);
    if (reviewObject) return reviewObject;
  }
  return undefined;
}

function resolveOpenAICompatibleApiKey(
  provider: ProviderRegistryEntry,
  env: Record<string, string | undefined>
): string | undefined {
  if (provider.authMode !== "api-key-env") return undefined;
  if (!provider.apiKeyEnv) throw new Error("Missing api key environment variable name for OpenAI-compatible provider.");
  const value = env[provider.apiKeyEnv];
  if (!value) throw new Error(`Missing api key environment variable ${provider.apiKeyEnv}.`);
  return value;
}

function openAICompatibleStatusErrorMessage(status: number, responseText = ""): string {
  const detail = previewEvidenceText(responseText).trim();
  const suffix = detail ? `: ${detail}` : ".";
  if (status === 401 || status === 403) return `OpenAI-compatible chat completions endpoint returned ${status} auth failure${suffix}`;
  if (status === 429) return `OpenAI-compatible chat completions endpoint returned 429 throttle failure${suffix}`;
  if (status === 408 || status === 504) return `OpenAI-compatible chat completions endpoint returned ${status} timeout failure${suffix}`;
  if (status >= 500) return `OpenAI-compatible chat completions endpoint returned ${status} network failure${suffix}`;
  // Non-special 4xx statuses keep a redacted body hint so adapter-specific auth/model-output wording can classify safely.
  return `OpenAI-compatible chat completions endpoint returned ${status}${suffix}`;
}

async function readResponseTextWithAbort(response: Response, signal: AbortSignal): Promise<string> {
  if (signal.aborted) throw new Error("deadline exceeded");
  return await new Promise<string>((resolve, reject) => {
    let settled = false;
    const abortHandler = () => {
      settle(() => {
        void response.body?.cancel().catch(() => undefined);
        reject(new Error("deadline exceeded"));
      });
    };
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abortHandler);
      fn();
    };
    signal.addEventListener("abort", abortHandler, { once: true });
    response.text().then(
      (text) => settle(() => resolve(text)),
      (error: unknown) => settle(() => reject(error))
    );
  });
}

function parseOpenAICompatibleResponse(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // Fall through to the normalized schema error below.
  }
  throw new Error("OpenAI-compatible chat completions response was not valid JSON.");
}

function extractOpenAICompatibleMessageContent(parsed: Record<string, unknown>): string {
  const choices = parsed.choices;
  if (!Array.isArray(choices)) throw new Error("OpenAI-compatible chat completions response had invalid response schema.");
  const firstChoice = choices[0];
  if (!firstChoice || typeof firstChoice !== "object" || Array.isArray(firstChoice)) {
    throw new Error("OpenAI-compatible chat completions response had invalid response schema.");
  }
  const message = (firstChoice as { message?: unknown }).message;
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    throw new Error("OpenAI-compatible chat completions response had invalid response schema.");
  }
  const content = (message as { content?: unknown }).content;
  if (typeof content !== "string" || content.trim().length === 0) {
    const textPart = extractOpenAICompatibleTextPart(content);
    if (textPart) return textPart;
    throw new Error("OpenAI-compatible chat completions response had invalid response schema.");
  }
  return content;
}

function extractOpenAICompatibleTextPart(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const textParts = content
    .map((part) => {
      if (!part || typeof part !== "object" || Array.isArray(part)) return undefined;
      const typedPart = part as { type?: unknown; text?: unknown };
      if (typedPart.type !== "text" || typeof typedPart.text !== "string") return undefined;
      const text = typedPart.text.trim();
      return text.length > 0 ? text : undefined;
    })
    .filter((text): text is string => Boolean(text));
  return textParts.length === 1 ? textParts[0] : undefined;
}

function extractOpenAICompatibleChoiceEvidence(parsed: Record<string, unknown>): Record<string, unknown> {
  const finishReason = extractOpenAICompatibleFinishReason(parsed);
  return finishReason === undefined ? {} : { finishReason };
}

function extractOpenAICompatibleFinishReason(parsed: Record<string, unknown>): string | undefined {
  const firstChoice = Array.isArray(parsed.choices) ? parsed.choices[0] : undefined;
  if (!firstChoice || typeof firstChoice !== "object" || Array.isArray(firstChoice)) return undefined;
  const finishReason = (firstChoice as { finish_reason?: unknown }).finish_reason;
  return typeof finishReason === "string" ? finishReason : undefined;
}

function extractOpenAICompatibleUsageEvidence(parsed: Record<string, unknown>): Record<string, unknown> {
  const usage = parsed.usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return {};
  return {
    usage: Object.fromEntries(
      Object.entries(usage)
        .filter(([, value]) => typeof value === "number" && Number.isFinite(value))
        .map(([key, value]) => [key, value])
    )
  };
}

function createAbortSignal(timeoutMs: number | undefined): { signal: AbortSignal; dispose: () => void } {
  const timeout = timeoutMs && timeoutMs > 0 ? timeoutMs : DEFAULT_OPENAI_COMPATIBLE_REVIEW_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const maybeUnref = timer as { unref?: () => void };
  if (typeof maybeUnref.unref === "function") maybeUnref.unref();
  return {
    signal: controller.signal,
    dispose: () => clearTimeout(timer)
  };
}

function previewEvidenceText(value: string): string {
  const redacted = redactAdapterEvidenceText(value);
  if (redacted.length <= EVIDENCE_PREVIEW_LIMIT) return redacted;

  const targetLength = EVIDENCE_PREVIEW_LIMIT - EVIDENCE_PREVIEW_TRUNCATED_SENTINEL.length;
  const preview = trimDanglingRedactionToken(redacted.slice(0, targetLength));
  return `${preview}${EVIDENCE_PREVIEW_TRUNCATED_SENTINEL}`;
}

function trimDanglingRedactionToken(value: string): string {
  const danglingStart = findDanglingRedactionTokenStart(value);
  return danglingStart === undefined ? value : value.slice(0, danglingStart);
}

function findDanglingRedactionTokenStart(value: string): number | undefined {
  for (const token of REDACTION_TOKENS) {
    for (let length = 1; length < token.length; length += 1) {
      const prefix = token.slice(0, length);
      if (value.endsWith(prefix)) return value.length - prefix.length;
    }
  }
  return undefined;
}

function redactAdapterEvidenceText(value: string): string {
  return redactSecrets(
    value
      .replace(
        /(["']?(?:x-)?api[-_]?key["']?\s*[:=]\s*["']?)[A-Za-z0-9._~+/=-]{8,}(["']?)/gi,
        `$1${REDACTION_TOKENS[2]}$2`
      )
      .replace(/\bsk-[A-Za-z0-9._-]{8,}\b/g, REDACTION_TOKENS[2])
      .replace(/\bsk-ant-[A-Za-z0-9._-]{8,}\b/g, REDACTION_TOKENS[2])
      .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, REDACTION_TOKENS[2])
      .replace(/\bya29\.[A-Za-z0-9._-]{16,}\b/g, REDACTION_TOKENS[2])
      .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, REDACTION_TOKENS[2])
      .replace(/-----BEGIN\s*$/g, REDACTION_TOKENS[2])
      .replace(/(?:[A-Z ]*PRIVATE KEY-----|-----END [A-Z ]*PRIVATE KEY-----)/g, REDACTION_TOKENS[2])
      .replace(/[A-Za-z0-9][A-Za-z0-9_+/=-]{47,}/g, (candidate) =>
        isHighRiskLongEvidenceToken(candidate) ? REDACTION_TOKENS[2] : candidate
      )
  );
}

function isHighRiskLongEvidenceToken(candidate: string): boolean {
  if (/^[a-f0-9]{40,128}$/i.test(candidate)) return false;
  if (/^(?:req|request|trace|span|run|job|evt|msg|resp|thread|file|batch)_[A-Za-z0-9_-]{16,}$/i.test(candidate)) {
    return false;
  }
  if (/[+/=]/.test(candidate)) return true;
  return candidate.length >= 64 && /[a-z]/.test(candidate) && /[A-Z]/.test(candidate) && /\d/.test(candidate);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableStringify(value: unknown): string {
  try {
    return JSON.stringify(sortJsonValue(value)) ?? REDACTION_TOKENS[4];
  } catch {
    return REDACTION_TOKENS[4];
  }
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => sortJsonValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => compareStableJsonKey(left, right))
        .map(([key, entryValue]) => [key, sortJsonValue(entryValue)])
    );
  }
  return value;
}

function compareStableJsonKey(left: string, right: string): number {
  // UTF-8 byte order keeps evidence output and hashing deterministic across locales and Node ICU builds.
  if (left === right) return 0;
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function redactPrivateEvidenceValue(value: unknown, prompt: string): unknown {
  if (typeof value === "string") return redactPrivateEvidenceText(value, prompt);
  if (Array.isArray(value)) return value.map((item) => redactPrivateEvidenceValue(item, prompt));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .map(([key, entryValue]) => {
          if (isPrivateEvidenceKey(key)) return [key, REDACTION_TOKENS[1]];
          if (isSensitiveEvidenceKey(key)) return [key, REDACTION_TOKENS[3]];
          return [key, redactPrivateEvidenceValue(entryValue, prompt)];
        })
    );
  }
  return value;
}

function redactPrivateEvidenceText(value: string, prompt: string): string {
  if (containsPrivateEvidenceLikeText(value, prompt)) return REDACTION_TOKENS[0];
  return redactAdapterEvidenceText(value);
}

function isPrivateEvidenceKey(key: string): boolean {
  const tokens = evidenceKeyTokens(key);
  const normalized = tokens.join("");
  const hasToken = (token: string) => tokens.includes(token);
  const hasAnyToken = (candidates: readonly string[]) => candidates.some((candidate) => hasToken(candidate));

  if (hasAnyToken(["prompt", "diff", "patch", "completion", "stdout", "stderr", "transcript"])) return true;
  if (["body", "source", "code", "log"].includes(normalized)) return true;
  if (hasToken("code") && hasAnyToken(["raw", "source", "generated", "original", "full", "unredacted"])) return true;
  if (hasToken("log") && !hasToken("level")) return true;
  if (
    hasAnyToken(["raw", "original", "full", "unredacted"])
    && hasAnyToken(["body", "content", "message", "output", "request", "response", "result"])
  ) {
    return true;
  }
  if (hasToken("text") && hasAnyToken(["body", "content", "message", "output", "request", "response", "result"])) {
    return true;
  }
  return false;
}

function isSensitiveEvidenceKey(key: string): boolean {
  return /(api[ _-]?key|authorization|auth|bearer|cookie|credential|password|secret|session|token)/i.test(key);
}

function evidenceKeyTokens(key: string): string[] {
  return key
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function containsPrivateEvidenceLikeText(value: string, prompt: string): boolean {
  return (
    containsSecretLikeText(value)
    || /(^|\n|\s)(diff --git|@@ |--- |\+\+\+ )/m.test(value)
    || (prompt.length > 0 && value.includes(prompt))
  );
}
