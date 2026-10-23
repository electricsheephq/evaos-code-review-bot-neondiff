import { redactSecrets } from "./secrets.js";
import type { ProductionLicenseAdmission } from "./license-admission.js";
import { runOnce, type RunOnceOptions, type RunOnceResult } from "./worker.js";

// Not skipped_processed: outside Actions the CI state can persist and record a failed attempt. A head
// CI already reviewed exits 0 before the run, from its GitHub review receipt.
const NORMAL_CI_SKIP_STATUSES = new Set<RunOnceResult["scopedStatus"]>([
  "skipped_draft", "skipped_stale_head", "skipped_closed",
  "skipped_base_merge_only", "skipped_finishing_touch_draft",
  "untrusted_author_provider_unavailable", "untrusted_author_restricted_unavailable", "untrusted_author_public_repo",
  "skipped_command_stop", "skipped_command_explain"
]);

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
  ci?: boolean;
}): RunOnceCliReport {
  const commandName = input.commandName ?? "run-once";
  return {
    ok: runOnceCliExitCode(input.result, {
      dryRun: input.dryRun,
      commandName,
      ci: input.ci
    }) === 0,
    command: commandName,
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

export function runOnceCliExitCode(
  result: RunOnceResult,
  input: {
    dryRun?: boolean;
    commandName?: "run-once" | "review-pr";
    ci?: boolean;
  } = {}
): 0 | 1 {
  const scopedLiveDidNotPost =
    input.commandName === "review-pr" &&
    !input.dryRun &&
    Boolean(result.scopedPull) &&
    result.reviewed !== 1;
  const normalCiSkip = input.ci === true &&
    result.failed === 0 &&
    (result.skippedLicenseGate ?? 0) === 0 &&
    NORMAL_CI_SKIP_STATUSES.has(result.scopedStatus);
  return result.failed > 0 ||
    (scopedLiveDidNotPost && !normalCiSkip) ||
    (!input.dryRun && Boolean(result.scopedPull) && (result.skippedLicenseGate ?? 0) > 0)
    ? 1
    : 0;
}

export function serializeRunOnceCliReport(report: RunOnceCliReport): string {
  return JSON.stringify(redactJsonStrings(report), null, 2);
}

export async function runOnceCliCommand(input: {
  options: RunOnceOptions;
  runOnceImpl?: (options: RunOnceOptions) => Promise<RunOnceResult>;
  admitImpl?: () => Promise<ProductionLicenseAdmission>;
  commandName?: "run-once" | "review-pr";
  ci?: boolean;
}): Promise<RunOnceCliCommandResult> {
  let result: RunOnceResult;
  try {
    const explicitRepo = input.options.repo;
    const explicitPullNumber = input.options.pullNumber;
    const explicitPullReview =
      input.commandName === "review-pr" &&
      typeof explicitRepo === "string" &&
      explicitRepo.trim().length > 0 &&
      typeof explicitPullNumber === "number" &&
      Number.isInteger(explicitPullNumber) &&
      explicitPullNumber > 0
        ? {
            repo: explicitRepo,
            pullNumber: explicitPullNumber
          }
        : undefined;
    const licenseAdmission = input.admitImpl
      ? await input.admitImpl()
      : input.options.licenseAdmission;
    result = await (input.runOnceImpl ?? runOnce)({
      ...input.options,
      // `review-pr` is already scoped to one explicit repo/PR. Keep
      // canaryPulls as the broad daemon/run-once rollout boundary.
      ...(explicitPullReview
        ? { explicitPullReview }
        : {}),
      ...(licenseAdmission ? { licenseAdmission } : {})
    });
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
    commandName: input.commandName,
    ci: input.ci
  });
  return {
    report,
    output: serializeRunOnceCliReport(report),
    exitCode: runOnceCliExitCode(result, {
      dryRun: input.options.dryRun,
      commandName: input.commandName ?? "run-once",
      ci: input.ci
    })
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
