import { createHash } from "node:crypto";
import { redactSecrets } from "./secrets.js";

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

export interface ProviderAdapterFixtureResult {
  ok: boolean;
  fixtureId: string;
  providerId: string;
  adapterId: string;
  model: string;
  evidence: ProviderAdapterFixtureEvidence;
  error?: ProviderAdapterFixtureError;
}

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
        message: redactAdapterEvidenceText(message)
      }
    };
  }
}

export function classifyProviderAdapterError(message: string): ProviderAdapterErrorClass {
  const normalized = message.toLowerCase();
  if (/\b(unauthorized|forbidden|invalid api key|invalid_api_key|401|403)\b/.test(normalized)) return "auth";
  if (/\b(rate limit|rate_limit|quota|too many requests|429|insufficient_quota|throttl(?:e|ed|ing))\b/.test(normalized)) return "throttle";
  if (/\b(timeout|timed out|etimedout|abort(?:ed)?|deadline exceeded)\b/.test(normalized)) return "timeout";
  if (/\b(econnreset|econnrefused|enotfound|eai_again|network|socket|dns|connection refused|connection reset)\b/.test(normalized)) return "network";
  if (/\b(json|schema|parseable|malformed output|invalid response|invalid output|tool call|structured output)\b/.test(normalized)) {
    return "model-output";
  }
  return "unknown";
}

function buildFixtureEvidence(
  prompt: string,
  execution: ProviderAdapterExecutionResult
): ProviderAdapterFixtureEvidence {
  return {
    promptSha256: sha256(prompt),
    outputSha256: sha256(execution.text),
    outputPreview: previewEvidenceText(execution.text),
    ...(execution.rawEvidence === undefined
      ? {}
      : { rawEvidencePreview: previewEvidenceText(stableStringify(stripPrivateEvidenceFields(execution.rawEvidence))) })
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
  return redactAdapterEvidenceText(value).slice(0, 500);
}

function redactAdapterEvidenceText(value: string): string {
  return redactSecrets(
    value
      .replace(/\bsk-[A-Za-z0-9._-]{8,}\b/g, "[redacted-secret]")
      .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, "[redacted-secret]")
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => sortJsonValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entryValue]) => [key, sortJsonValue(entryValue)])
    );
  }
  return value;
}

function stripPrivateEvidenceFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => stripPrivateEvidenceFields(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !/(prompt|diff|patch|content)/i.test(key))
        .map(([key, entryValue]) => [key, stripPrivateEvidenceFields(entryValue)])
    );
  }
  return value;
}
