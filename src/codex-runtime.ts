import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { REVIEW_FINDINGS_JSON_SCHEMA } from "./findings-schema.js";
import { parseFindings } from "./findings.js";
import { containsSecretLikeText, redactSecrets } from "./secrets.js";
import { writeSecureFileSync } from "./temp-files.js";
import type { ZCodeReviewResult } from "./zcode.js";

export type CodexReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";

export interface CodexExecInvocation {
  command: string;
  args: string[];
  cwd: string;
  stdin: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxOutputBytes: number;
  outputPath: string;
}

export interface CodexProcessResult {
  stdout: string;
  stderr: string;
  status: number | null;
  signal: NodeJS.Signals | null;
  error?: Error & { code?: string };
}

const CODEX_ENV_ALLOWLIST = [
  "HOME",
  "USER",
  "LOGNAME",
  "PATH",
  "SHELL",
  "CODEX_HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS"
] as const;

export const CODEX_REVIEW_FINDINGS_JSON_SCHEMA = {
  ...REVIEW_FINDINGS_JSON_SCHEMA,
  properties: {
    findings: {
      ...REVIEW_FINDINGS_JSON_SCHEMA.properties.findings,
      items: {
        ...REVIEW_FINDINGS_JSON_SCHEMA.properties.findings.items,
        required: [
          "severity",
          "path",
          "line",
          "title",
          "body",
          "confidence",
          "category",
          "why_this_matters"
        ],
        properties: {
          ...REVIEW_FINDINGS_JSON_SCHEMA.properties.findings.items.properties,
          category: {
            type: ["string", "null"],
            enum: [...REVIEW_FINDINGS_JSON_SCHEMA.properties.findings.items.properties.category.enum, null]
          },
          why_this_matters: { type: ["string", "null"] }
        }
      }
    }
  }
} as const;

export function buildCodexRuntimeEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of CODEX_ENV_ALLOWLIST) {
    const value = source[key];
    if (typeof value === "string" && value.length > 0) env[key] = value;
  }
  return env;
}

export function buildCodexExecInvocation(input: {
  cliPath: string;
  cwd: string;
  model: string;
  reasoningEffort: CodexReasoningEffort;
  schemaPath: string;
  outputPath: string;
}): Pick<CodexExecInvocation, "command" | "args"> {
  return {
    command: input.cliPath,
    args: [
      "exec",
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--strict-config",
      "--disable", "apps",
      "--disable", "multi_agent",
      "--disable", "multi_agent_v2",
      "-c", "approval_policy=\"never\"",
      "-c", `model_reasoning_effort=\"${input.reasoningEffort}\"`,
      "--model", input.model,
      "--sandbox", "read-only",
      "--cd", input.cwd,
      "--output-schema", input.schemaPath,
      "--output-last-message", input.outputPath,
      "--color", "never",
      "-"
    ]
  };
}

export async function runCodexReview(input: {
  cwd: string;
  prompt: string;
  cliPath: string;
  model: string;
  reasoningEffort: CodexReasoningEffort;
  evidenceDir: string;
  timeoutMs: number;
  maxOutputBytes: number;
}, dependencies: {
  runProcess?: (invocation: CodexExecInvocation) => Promise<CodexProcessResult>;
  captureWorktreeState?: (cwd: string) => string;
} = {}): Promise<ZCodeReviewResult> {
  mkdirSync(input.evidenceDir, { recursive: true });
  const schemaPath = join(input.evidenceDir, "codex-review-schema.json");
  const outputPath = join(input.evidenceDir, "codex-review-result.json");
  writeSecureFileSync(schemaPath, `${JSON.stringify(CODEX_REVIEW_FINDINGS_JSON_SCHEMA, null, 2)}\n`);
  const command = buildCodexExecInvocation({
    cliPath: input.cliPath,
    cwd: input.cwd,
    model: input.model,
    reasoningEffort: input.reasoningEffort,
    schemaPath,
    outputPath
  });
  const invocation: CodexExecInvocation = {
    ...command,
    cwd: input.cwd,
    stdin: input.prompt,
    env: buildCodexRuntimeEnv(process.env),
    timeoutMs: input.timeoutMs,
    maxOutputBytes: input.maxOutputBytes,
    outputPath
  };
  const captureWorktreeState = dependencies.captureWorktreeState ?? captureGitWorktreeState;
  const before = captureWorktreeState(input.cwd);
  const result = await (dependencies.runProcess ?? runCodexProcess)(invocation);
  const after = captureWorktreeState(input.cwd);
  const stdout = redactSecrets(result.stdout);
  const stderr = redactSecrets(result.stderr);
  writeSecureFileSync(join(input.evidenceDir, "codex-stdout.txt"), stdout);
  writeSecureFileSync(join(input.evidenceDir, "codex-stderr.txt"), stderr);

  if (before !== after) {
    throw new Error("codex_runtime_unsafe_write_attempt: checkout state changed during read-only review");
  }
  if (result.error) {
    const code = result.error.code ? ` code=${result.error.code}` : "";
    throw new Error(`codex_runtime_process_failure:${code} ${redactSecrets(result.error.message)}`);
  }
  if (result.status !== 0) {
    throw new Error(`codex_runtime_nonzero_exit: status=${result.status} ${stderr.slice(0, 1000)}`);
  }

  let rawResponse: string;
  try {
    const outputStat = statSync(outputPath);
    if (!outputStat.isFile() || outputStat.size > input.maxOutputBytes) {
      throw new Error("result file is missing, invalid, or over the output limit");
    }
    chmodSync(outputPath, 0o600);
    rawResponse = readFileSync(outputPath, "utf8");
  } catch (error) {
    throw new Error(`codex_runtime_schema_invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (containsSecretLikeText(rawResponse)) {
    writeSecureFileSync(outputPath, '{"status":"rejected-secret-like-output"}\n');
    throw new Error("codex_runtime_secret_output: result contained secret-like text");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawResponse);
  } catch (error) {
    throw new Error(`codex_runtime_schema_invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  const { findings, dropped } = parseFindings(parsed);
  if (dropped.length > 0) {
    throw new Error(`codex_runtime_schema_invalid: ${dropped.length} finding(s) failed NeonDiff validation`);
  }
  return {
    findings,
    droppedFromSchema: [],
    rawResponse,
    attempts: 1,
    degradedRecovery: false
  };
}

function captureGitWorktreeState(cwd: string): string {
  const result = spawnSync("git", [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "--ignored=matching"
  ], {
    cwd,
    encoding: "utf8",
    env: buildCodexRuntimeEnv(process.env),
    timeout: 30_000,
    maxBuffer: 10 * 1024 * 1024
  });
  if (result.error || result.status !== 0) {
    throw new Error(`codex_runtime_worktree_probe_failed: ${redactSecrets(result.error?.message ?? result.stderr ?? "unknown error")}`);
  }
  return result.stdout;
}

function runCodexProcess(invocation: CodexExecInvocation): Promise<CodexProcessResult> {
  return new Promise((resolve) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      env: invocation.env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let spawnError: (Error & { code?: string }) | undefined;
    let terminalError: (Error & { code?: string }) | undefined;
    let closed = false;
    let killTimer: NodeJS.Timeout | undefined;

    const terminate = () => {
      if (closed) return;
      child.kill("SIGTERM");
      killTimer ??= setTimeout(() => {
        if (!closed) child.kill("SIGKILL");
      }, 250);
      killTimer.unref();
    };
    const timeout = setTimeout(() => {
      const error = new Error(`spawn ${invocation.command} ETIMEDOUT`) as Error & { code?: string };
      error.code = "ETIMEDOUT";
      terminalError = error;
      terminate();
    }, invocation.timeoutMs);
    timeout.unref();

    const capture = (target: Buffer[], chunk: Buffer, stream: "stdout" | "stderr") => {
      if (terminalError) return;
      if (stream === "stdout") stdoutBytes += chunk.length;
      else stderrBytes += chunk.length;
      if (stdoutBytes > invocation.maxOutputBytes || stderrBytes > invocation.maxOutputBytes) {
        const error = new Error(`spawn ${invocation.command} ENOBUFS`) as Error & { code?: string };
        error.code = "ENOBUFS";
        terminalError = error;
        terminate();
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => capture(stdout, chunk, "stdout"));
    child.stderr.on("data", (chunk: Buffer) => capture(stderr, chunk, "stderr"));
    child.on("error", (error: Error & { code?: string }) => {
      spawnError = error;
    });
    child.on("close", (status, signal) => {
      closed = true;
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        status,
        signal,
        ...((terminalError ?? spawnError) ? { error: terminalError ?? spawnError } : {})
      });
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(invocation.stdin);
  });
}
