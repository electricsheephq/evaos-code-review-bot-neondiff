import { redactSecrets } from "./secrets.js";

export const ZCODE_TIMEOUT_ERROR_PREFIX = "zcode_timeout_retryable";
export const ZCODE_TIMEOUT_RETRYABLE_ATTEMPT_LIMIT = 1;

export interface ParsedZCodeTimeoutError {
  reason: string;
  retryAttempt: number;
  retryable: boolean;
  timeoutMs?: number;
  originalError?: string;
}

export interface ZCodeTimeoutCounts {
  total: number;
  retryable: number;
  exhausted: number;
}

export interface ZCodeTimeoutRetryCommandInput {
  configPath: string;
  repo: string;
  pullNumber: number;
  headSha: string;
  dryRun?: boolean;
  zcode?: boolean;
}

export interface ZCodeTimeoutRetryJobInput {
  repo: string;
  pullNumber: number;
  headSha: string;
  state?: string;
  lastError?: string | null;
}

export function isZCodeTimeoutError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  return (
    (normalized.includes("zcode failed before completion") && normalized.includes("etimedout")) ||
    (normalized.includes("zcode failed before completion") && normalized.includes("timed out"))
  );
}

export function formatZCodeTimeoutFailureError(input: {
  error: unknown;
  previousError?: string;
  timeoutMs: number;
}): string | undefined {
  if (!isZCodeTimeoutError(input.error)) return undefined;
  const retryAttempt = nextZCodeTimeoutRetryAttempt(input.previousError);
  const originalError = sanitizeTimeoutError(input.error instanceof Error ? input.error.message : String(input.error));
  return [
    ZCODE_TIMEOUT_ERROR_PREFIX,
    "reason=zcode_hard_timeout",
    `retry_attempt=${retryAttempt}`,
    `timeout_ms=${Math.max(0, Math.floor(input.timeoutMs))}`,
    `original_error=${originalError}`
  ].join("; ");
}

export function parseZCodeTimeoutError(error?: string | null): ParsedZCodeTimeoutError | undefined {
  if (!error || !error.includes(ZCODE_TIMEOUT_ERROR_PREFIX)) return undefined;
  const fields = parseSemicolonFields(error);
  const retryAttempt = parsePositiveInteger(fields.get("retry_attempt"));
  if (retryAttempt === undefined) return undefined;
  const timeoutMs = parseNonNegativeInteger(fields.get("timeout_ms"));
  const parsed: ParsedZCodeTimeoutError = {
    reason: fields.get("reason") ?? "zcode_hard_timeout",
    retryAttempt,
    retryable: retryAttempt <= ZCODE_TIMEOUT_RETRYABLE_ATTEMPT_LIMIT
  };
  if (timeoutMs !== undefined) parsed.timeoutMs = timeoutMs;
  const originalError = fields.get("original_error");
  if (originalError) parsed.originalError = originalError;
  return parsed;
}

export function summarizeZCodeTimeoutErrors(errors: Array<string | null | undefined>): ZCodeTimeoutCounts {
  return errors.reduce<ZCodeTimeoutCounts>(
    (counts, error) => {
      const parsed = parseZCodeTimeoutError(error);
      if (!parsed) return counts;
      counts.total += 1;
      if (parsed.retryable) counts.retryable += 1;
      else counts.exhausted += 1;
      return counts;
    },
    { total: 0, retryable: 0, exhausted: 0 }
  );
}

export function buildZCodeTimeoutRetryCommand(input: ZCodeTimeoutRetryCommandInput): string {
  return [
    "npx tsx src/cli.ts retry-failed",
    `--config ${input.configPath}`,
    `--repo ${input.repo}`,
    `--pr ${input.pullNumber}`,
    `--head-sha ${input.headSha}`,
    `--dry-run ${input.dryRun === true ? "true" : "false"}`,
    `--zcode ${input.zcode === false ? "false" : "true"}`
  ].join(" ");
}

export function buildZCodeTimeoutRetryCommandsForJobs(input: {
  configPath: string;
  jobs: ZCodeTimeoutRetryJobInput[];
}): string[] {
  const seen = new Set<string>();
  const commands: string[] = [];
  for (const job of input.jobs) {
    if (job.state !== "failed") continue;
    if (!parseZCodeTimeoutError(job.lastError)) continue;
    const key = `${job.repo}#${job.pullNumber}@${job.headSha}`;
    if (seen.has(key)) continue;
    seen.add(key);
    commands.push(buildZCodeTimeoutRetryCommand({
      configPath: input.configPath,
      repo: job.repo,
      pullNumber: job.pullNumber,
      headSha: job.headSha
    }));
  }
  return commands;
}

export function buildZCodeTimeoutInspectCommand(configPath: string): string {
  return `npx tsx src/cli.ts queue --config ${configPath} --state failed`;
}

function nextZCodeTimeoutRetryAttempt(previousError?: string): number {
  const previous = parseZCodeTimeoutError(previousError);
  return (previous?.retryAttempt ?? 0) + 1;
}

function sanitizeTimeoutError(message: string): string {
  return redactSecrets(redactSecrets(message)
    .replace(/\s+/g, " ")
    .replace(/;/g, ",")
    .trim()
    .slice(0, 800));
}

function parseSemicolonFields(error: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const rawPart of error.split(";")) {
    const part = rawPart.trim();
    const separatorIndex = part.indexOf("=");
    if (separatorIndex <= 0) continue;
    fields.set(part.slice(0, separatorIndex), part.slice(separatorIndex + 1));
  }
  return fields;
}

function parsePositiveInteger(value?: string): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parseNonNegativeInteger(value?: string): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}
