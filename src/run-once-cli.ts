import { redactSecrets } from "./secrets.js";
import { runOnce, type RunOnceOptions, type RunOnceResult } from "./worker.js";

const STRUCTURED_SECRET_VALUE_PATTERN =
  /(\b(?:api[_-]?key|token|secret|password|cookie|session)\b["']?\s*[:=]\s*["']?)[A-Za-z0-9._~+/=-]{16,}/gi;

export interface RunOnceCliReportBase {
  ok: boolean;
  command: "run-once" | "review-pr";
  dryRun: boolean;
  useZCode: boolean;
  scope: {
    repo?: string;
    pullNumber?: number;
    headSha?: string;
    url?: string;
  };
}

export interface RunOnceCliSuccessReport extends RunOnceCliReportBase {
  result: RunOnceResult;
  error?: never;
}

export interface RunOnceCliErrorReport extends RunOnceCliReportBase {
  ok: false;
  result?: never;
  error: {
    message: string;
  };
}

export type RunOnceCliReport = RunOnceCliSuccessReport | RunOnceCliErrorReport;

export interface RunOnceCliCommandResult {
  report: RunOnceCliReport;
  output: string;
  exitCode: 0 | 1;
}

export function buildRunOnceCliReport(input: {
  result: RunOnceResult;
  dryRun: boolean;
  useZCode: boolean;
  repo?: string;
  pullNumber?: number;
  commandName?: "run-once" | "review-pr";
}): RunOnceCliReport {
  return {
    ok: runOnceCliExitCode(input.result) === 0,
    command: input.commandName ?? "run-once",
    dryRun: input.dryRun,
    useZCode: input.useZCode,
    scope: {
      ...(input.repo ? { repo: input.repo } : {}),
      ...(input.pullNumber !== undefined ? { pullNumber: input.pullNumber } : {}),
      ...(input.result.scopedPull?.headSha ? { headSha: input.result.scopedPull.headSha } : {}),
      ...(input.result.scopedPull?.url ? { url: input.result.scopedPull.url } : {})
    },
    result: input.result
  };
}

export function runOnceCliExitCode(result: RunOnceResult): 0 | 1 {
  return result.failed > 0 || (Boolean(result.scopedPull) && (result.skippedLicenseGate ?? 0) > 0) ? 1 : 0;
}

export function serializeRunOnceCliReport(report: RunOnceCliReport): string {
  return JSON.stringify(redactJsonStrings(report), null, 2);
}

export async function runOnceCliCommand(input: {
  options: RunOnceOptions;
  runOnceImpl?: (options: RunOnceOptions) => Promise<RunOnceResult>;
  commandName?: "run-once" | "review-pr";
}): Promise<RunOnceCliCommandResult> {
  let result: RunOnceResult;
  try {
    result = await (input.runOnceImpl ?? runOnce)(input.options);
  } catch (error) {
    const report = buildRunOnceCliErrorReport({
      error,
      dryRun: input.options.dryRun,
      useZCode: input.options.useZCode ?? true,
      repo: input.options.repo,
      pullNumber: input.options.pullNumber,
      commandName: input.commandName
    });
    return {
      report,
      output: serializeRunOnceCliReport(report),
      exitCode: 1
    };
  }
  const report = buildRunOnceCliReport({
    result,
    dryRun: input.options.dryRun,
    useZCode: input.options.useZCode ?? true,
    repo: input.options.repo,
    pullNumber: input.options.pullNumber,
    commandName: input.commandName
  });
  return {
    report,
    output: serializeRunOnceCliReport(report),
    exitCode: runOnceCliExitCode(result)
  };
}

function buildRunOnceCliErrorReport(input: {
  error: unknown;
  dryRun: boolean;
  useZCode: boolean;
  repo?: string;
  pullNumber?: number;
  commandName?: "run-once" | "review-pr";
}): RunOnceCliErrorReport {
  return {
    ok: false,
    command: input.commandName ?? "run-once",
    dryRun: input.dryRun,
    useZCode: input.useZCode,
    scope: {
      ...(input.repo ? { repo: input.repo } : {}),
      ...(input.pullNumber !== undefined ? { pullNumber: input.pullNumber } : {})
    },
    error: {
      message: input.error instanceof Error ? input.error.message : String(input.error)
    }
  };
}

function redactJsonStrings(value: unknown): unknown {
  if (typeof value === "string") return redactSecrets(redactStructuredSecretValues(value));
  if (Array.isArray(value)) return value.map((item) => redactJsonStrings(item));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, redactJsonStrings(entry)])
  );
}

function redactStructuredSecretValues(value: string): string {
  return value.replace(STRUCTURED_SECRET_VALUE_PATTERN, "$1[redacted-secret]");
}
