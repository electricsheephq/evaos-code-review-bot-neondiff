import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { parseFindings } from "./findings.js";
import { openAICompatibleProviderTargetError, type ProviderRegistryEntry } from "./providers.js";
import { containsSecretLikeText, redactSecrets } from "./secrets.js";

const EVIDENCE_PREVIEW_LIMIT = 500;
const REVIEW_JSON_EXTRACTION_CHAR_LIMIT = 200_000;
const EVIDENCE_PREVIEW_TRUNCATED_SENTINEL = "...[truncated]";
const REDACTION_TOKENS = [
  "[redacted-private-evidence]",
  "[redacted-private-field]",
  "[redacted-secret]",
  "[redacted-sensitive-field]",
  "[redacted-unserializable-evidence]"
] as const;

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
    const reviewJsonError = fixture.expectReviewJson ? validateReviewJsonOutput(execution.text) : undefined;
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
  if (/\b(econnreset|econnrefused|enotfound|eai_again|socket|dns|fetch failed|service unavailable|temporarily unavailable|overload|connection[ _-]refused|connection[ _-]reset|network[ _-](?:error|failure|failed|unreachable|unavailable|down))\b/.test(normalized)) return "network";
  if (/\b(json|schema|parseable|malformed output|invalid response|invalid output|review object|review json|tool call|structured output)\b/.test(normalized)) {
    return "model-output";
  }
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
      const requestBody = {
        model: input.model,
        temperature: 0,
        stream: false,
        ...(provider.capabilities.jsonOutput ? { response_format: { type: "json_object" } } : {}),
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
          throw new Error(openAICompatibleStatusErrorMessage(response.status));
        }

        const responseText = await readResponseTextWithAbort(response, timeout.signal);
        const parsed = parseOpenAICompatibleResponse(responseText);
        const content = extractOpenAICompatibleMessageContent(parsed);
        const reviewOutput = normalizeReviewJsonOutput(content);
        if (!reviewOutput.ok) throw new Error(reviewOutput.error);

        return {
          text: reviewOutput.text,
          rawEvidence: {
            providerId: options.providerId,
            adapterId: input.adapterId,
            model: input.model,
            baseUrl,
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
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !Array.isArray((parsed as { findings?: unknown }).findings)) {
    return { ok: false, error: "Adapter output did not contain a review findings array." };
  }
  const { dropped } = parseFindings(parsed);
  if (dropped.length > 0) return { ok: false, error: "Adapter output contained invalid review findings." };
  return { ok: true, text: reviewJson };
}

function extractReviewJsonObject(text: string): string {
  const boundedText = text.slice(0, REVIEW_JSON_EXTRACTION_CHAR_LIMIT);
  const fencedMatches = [...boundedText.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
  for (const fenced of fencedMatches) {
    const candidate = fenced[1]!.trim();
    if (isReviewJsonObject(candidate)) return candidate;
  }

  const starts: number[] = [];
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
      starts.push(index);
      continue;
    }
    if (char === "}") {
      const start = starts.pop();
      if (start === undefined) continue;
      const candidate = boundedText.slice(start, index + 1).trim();
      if (candidate.includes("\"findings\"") && isReviewJsonObject(candidate)) return candidate;
    }
  }
  throw new Error("Adapter output did not contain a parseable JSON review object.");
}

function isReviewJsonObject(candidate: string): boolean {
  try {
    const parsed = JSON.parse(candidate) as { findings?: unknown };
    return typeof parsed === "object" && parsed !== null && Array.isArray(parsed.findings);
  } catch {
    return false;
  }
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

function openAICompatibleStatusErrorMessage(status: number): string {
  if (status === 401 || status === 403) return `OpenAI-compatible chat completions endpoint returned ${status} auth failure.`;
  if (status === 429) return "OpenAI-compatible chat completions endpoint returned 429 throttle failure.";
  if (status === 408 || status === 504) return `OpenAI-compatible chat completions endpoint returned ${status} timeout failure.`;
  if (status >= 500) return `OpenAI-compatible chat completions endpoint returned ${status} network failure.`;
  // Non-auth/non-throttle 4xx statuses stay unknown until runtime wiring needs a distinct operator action.
  return `OpenAI-compatible chat completions endpoint returned ${status}.`;
}

async function readResponseTextWithAbort(response: Response, signal: AbortSignal): Promise<string> {
  if (signal.aborted) throw new Error("deadline exceeded");
  let abortHandler: ((event: Event) => void) | undefined;
  const abortPromise = new Promise<never>((_resolve, reject) => {
    abortHandler = () => {
      void response.body?.cancel().catch(() => undefined);
      reject(new Error("deadline exceeded"));
    };
    signal.addEventListener("abort", abortHandler, { once: true });
  });
  try {
    return await Promise.race([response.text(), abortPromise]);
  } finally {
    if (abortHandler) signal.removeEventListener("abort", abortHandler);
  }
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
    throw new Error("OpenAI-compatible chat completions response had invalid response schema.");
  }
  return content;
}

function extractOpenAICompatibleChoiceEvidence(parsed: Record<string, unknown>): Record<string, unknown> {
  const firstChoice = Array.isArray(parsed.choices) ? parsed.choices[0] : undefined;
  if (!firstChoice || typeof firstChoice !== "object" || Array.isArray(firstChoice)) return {};
  const finishReason = (firstChoice as { finish_reason?: unknown }).finish_reason;
  return typeof finishReason === "string" ? { finishReason } : {};
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
  const timeout = timeoutMs && timeoutMs > 0 ? timeoutMs : 30_000;
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
