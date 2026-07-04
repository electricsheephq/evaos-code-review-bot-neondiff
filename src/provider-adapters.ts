import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { containsSecretLikeText, redactSecrets } from "./secrets.js";

const EVIDENCE_PREVIEW_LIMIT = 500;
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

export interface ProviderAdapterFixtureEvidence {
  promptSha256: string;
  outputSha256?: string;
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
    if (fixture.expectJsonObject && !isJsonObject(execution.text)) {
      return {
        ok: false,
        ...baseResult,
        evidence,
        error: {
          class: "model-output",
          message: "Adapter output was not a JSON object."
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
  if (/\b(unauthorized|forbidden|invalid[ _-]api[ _-]key|401|403)\b/.test(normalized)) return "auth";
  if (/\b(rate[ _-]limit|quota|too many requests|429|insufficient[ _-]quota|throttl(?:e|ed|ing))\b/.test(normalized)) return "throttle";
  // Provider timeout wording wins over network codes in combined messages to keep cooldown evidence deterministic.
  if (/\b(time[ _-]?out|timed[ _-]out|etimedout|abort(?:ed)?|deadline exceeded)\b/.test(normalized)) return "timeout";
  if (/\b(econnreset|econnrefused|enotfound|eai_again|socket|dns|connection[ _-]refused|connection[ _-]reset|network[ _-](?:error|failure|failed|unreachable|unavailable|down))\b/.test(normalized)) return "network";
  if (/\b(json|schema|parseable|malformed output|invalid response|invalid output|tool call|structured output)\b/.test(normalized)) {
    return "model-output";
  }
  return "unknown";
}

function buildFixtureEvidence(
  prompt: string,
  execution: ProviderAdapterExecutionResult
): ProviderAdapterFixtureEvidence {
  const redactedOutput = redactPrivateEvidenceText(execution.text, prompt);
  return {
    promptSha256: sha256(prompt),
    outputSha256: sha256(redactedOutput),
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
      .replace(/(?:[A-Za-z0-9+/]{48,}={0,2}|[A-Za-z0-9_-]{48,})/g, REDACTION_TOKENS[2])
  );
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
