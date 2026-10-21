import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { REVIEW_FINDINGS_JSON_SCHEMA } from "./findings-schema.js";
import { LCM_REVIEW_ASSESSMENT_SCHEMA } from "./lcm-review-assessment.js";
import { parseFindings } from "./findings.js";
import { verifySourceRef } from "./issue-analysis.js";
import type { DroppedFinding } from "./types.js";
import { containsSecretLikeText, redactSecrets } from "./secrets.js";
import { writeSecureFileSync } from "./temp-files.js";
import { parseReviewModelSummary, type ZCodeReviewResult } from "./zcode.js";

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
  "CODEX_API_KEY",
  "OPENAI_API_KEY",
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
  required: ["findings", "summary"],
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
    },
    summary: {
      type: "object",
      additionalProperties: false,
      required: ["changedBehavior", "invariants", "evidence", "limitations", "noFindingRationale"],
      properties: {
        changedBehavior: { type: "array", maxItems: 12, items: { type: "string", minLength: 1, maxLength: 1_000 } },
        invariants: { type: "array", maxItems: 12, items: { type: "string", minLength: 1, maxLength: 1_000 } },
        evidence: { type: "array", maxItems: 12, items: { type: "string", minLength: 1, maxLength: 1_000 } },
        limitations: { type: "array", minItems: 1, maxItems: 12, items: { type: "string", minLength: 1, maxLength: 1_000 } },
        noFindingRationale: { type: "string", minLength: 1, maxLength: 1_000 }
      }
    }
  }
} as const;

export const CODEX_CHECKOUT_REVIEW_FINDINGS_JSON_SCHEMA = {
  ...CODEX_REVIEW_FINDINGS_JSON_SCHEMA,
  properties: { ...CODEX_REVIEW_FINDINGS_JSON_SCHEMA.properties,
    findings: { ...CODEX_REVIEW_FINDINGS_JSON_SCHEMA.properties.findings,
      items: { ...CODEX_REVIEW_FINDINGS_JSON_SCHEMA.properties.findings.items,
        required: [...CODEX_REVIEW_FINDINGS_JSON_SCHEMA.properties.findings.items.required, "evidence"],
        properties: { ...CODEX_REVIEW_FINDINGS_JSON_SCHEMA.properties.findings.items.properties,
          evidence: { type: "array", maxItems: 5, items: {
            type: "object", additionalProperties: false, required: ["path", "startLine", "endLine", "excerpt"],
            properties: { path: { type: "string", minLength: 1 }, startLine: { type: "integer", minimum: 1 },
              endLine: { type: "integer", minimum: 1 }, excerpt: { type: "string", minLength: 1, maxLength: 1_000 } }
          } }
        }
      }
    }
  }
} as const;

/** Detect-only: human-format output can imitate exec blocks; this is not execution proof. */
export function parseCodexCommands(stderr: string, echoedPrompt?: string): {
  commands: Array<{ command: string; cwd: string; exitStatus: number | null; flagged: boolean }>;
  counts: { total: number; flagged: number; blocksSeen: number; blocksRecorded: number };
  truncated: boolean;
} {
  const commands: Array<{ command: string; cwd: string; exitStatus: number | null; flagged: boolean }> = [];
  const redacted = redactSecrets(stderr).replace(/\r\n/g, "\n");
  const echo = echoedPrompt === undefined ? undefined : `user\n${redactSecrets(echoedPrompt).replace(/\r\n/g, "\n")}`;
  const echoAt = echo === undefined ? -1 : redacted.indexOf(echo);
  const lines = (echo === undefined ? redacted : echoAt < 0 ? "" : redacted.slice(echoAt + echo.length)).split("\n");
  let blocksSeen = 0, flaggedCount = 0;
  for (let i = 0; i + 2 < lines.length; i++) {
    if (lines[i] !== "exec") continue;
    const header = lines[i + 1]!;
    const split = header.lastIndexOf(" in /");
    const status = /^[ \t]*(succeeded|exited (-?\d+)) in [^\n]*:/.exec(lines[i + 2]!);
    if (split <= 0 || !status) continue;
    const wrapped = header.slice(0, split);
    const command = /^(?:\/(?:usr\/)?bin\/)?(?:bash|zsh|sh) -[a-z]*c (['"])(.*)\1$/.exec(wrapped)?.[2] ?? wrapped;
    const flagged = /[>`]|\$\(|[<>=]\(|(^|[^&])&([^&]|$)/.test(command) || command.split(/&&|\|\||[;|\n]/).some((part) => {
      const [program, ...args] = (part.trim().match(/"(?:\\.|[^"\\])*"|'[^']*'|[^\s]+/g) ?? [])
        .map(arg => arg.replace(/^(['"])(.*)\1$/, "$2"));
      if (!["cat", "sed", "nl", "head", "tail", "wc", "ls", "find", "rg", "grep", "git"].includes(program ?? "")) return true;
      if (program === "git") return args.some(arg => /^(?:-c|--exec-path|--upload-pack)/.test(arg)) ||
        !["show", "diff", "log", "blame", "grep", "ls-files", "rev-parse", "status"].includes(args[0] ?? "") ||
        (args[0] === "grep" && args.some(arg => /^(?:-O|--open-files-in-pager)/.test(arg)));
      if (program === "rg") return args.some(arg => /^--(?:pre|pre-glob|hostname-bin)(?:=|$)/.test(arg));
      if (program === "sed") {
        const scriptIndex = args[1] === "-e" ? 2 : 1;
        return args[0] !== "-n" || !/^(?:\d+|\$)?(?:,(?:\d+|\$))?p$/.test(args[scriptIndex] ?? "") ||
          args.slice(scriptIndex + 1).some(arg => arg.startsWith("-"));
      }
      return program === "find" && args.some(arg => /^-(?:exec|execdir|ok|okdir|delete|fprint.*|fprintf|fls)(?:$|[+;])/.test(arg));
    });
    blocksSeen++;
    if (flagged) flaggedCount++;
    if (commands.length < 200) commands.push({ command: command.slice(0, 300), cwd: header.slice(split + 4).slice(0, 300),
      exitStatus: status[1] === "succeeded" ? 0 : Number(status[2]), flagged });
    i += 2;
  }
  return { commands, counts: { total: blocksSeen, flagged: flaggedCount, blocksSeen, blocksRecorded: commands.length },
    truncated: blocksSeen > commands.length };
}

export function parseCodexUsage(
  stderr: string, fallback: { model: string; reasoningEffort: CodexReasoningEffort }, durationMs: number
): { model: string; reasoningEffort: CodexReasoningEffort; tokensUsed: number | null; durationMs: number } {
  const model = /^model:[ \t]*(gpt-[a-z0-9._-]+)[ \t]*$/m.exec(stderr)?.[1];
  const effort = /^reasoning effort:[ \t]*(low|medium|high|xhigh|max)[ \t]*$/m.exec(stderr)?.[1];
  // Codex groups thousands with a locale separator: a space, U+00A0, U+202F or a comma.
  // The footer is printed last; an echoed prompt can contain an earlier token-shaped stanza.
  const rawTokens = [...stderr.matchAll(/^tokens used[ \t]*\r?\n([0-9][0-9 \u00a0\u202f,]*)[ \t]*\r?$/gm)].at(-1)?.[1]?.trim();
  const tokens = rawTokens && /^(?:[0-9]+|[0-9]{1,3}(?:[ \u00a0\u202f,][0-9]{3})+)$/.test(rawTokens)
    ? Number(rawTokens.replace(/[ \u00a0\u202f,]/g, "")) : NaN;
  return {
    model: model && !containsSecretLikeText(model) ? model : redactSecrets(fallback.model),
    reasoningEffort: (effort ?? fallback.reasoningEffort) as CodexReasoningEffort,
    tokensUsed: Number.isSafeInteger(tokens) && tokens >= 0 ? tokens : null,
    durationMs
  };
}

export function buildCodexRuntimeEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of CODEX_ENV_ALLOWLIST) {
    const value = source[key];
    if (typeof value === "string" && value.length > 0) env[key] = value;
  }
  if (!env.CODEX_API_KEY && env.OPENAI_API_KEY) env.CODEX_API_KEY = env.OPENAI_API_KEY;
  // The bare `codex` command resolves through PATH from the PR worktree cwd; relative or empty
  // entries would resolve a PR-controlled binary.
  if (env.PATH) {
    const safePath = env.PATH.split(delimiter).filter((entry) => entry.length > 0 && isAbsolute(entry)).join(delimiter);
    if (safePath) env.PATH = safePath; else delete env.PATH;
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
      "-c", 'shell_environment_policy.inherit="core"',
      "-c", 'shell_environment_policy.exclude=["*KEY*","*SECRET*","*TOKEN*","*PASSWORD*","*CREDENTIAL*","*AUTH*"]',
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
  lcmReviewAssessment?: boolean;
  checkoutReads?: boolean;
}, dependencies: {
  runProcess?: (invocation: CodexExecInvocation) => Promise<CodexProcessResult>;
  captureWorktreeState?: (cwd: string) => string;
} = {}): Promise<ZCodeReviewResult> {
  const schema = input.checkoutReads ? CODEX_CHECKOUT_REVIEW_FINDINGS_JSON_SCHEMA : CODEX_REVIEW_FINDINGS_JSON_SCHEMA;
  const droppedFromEvidence: DroppedFinding[] = [];
  const result = await runCodexStructuredOutput({
    ...input,
    artifactPrefix: "codex-review",
    schema: input.lcmReviewAssessment ? {
      ...schema,
      required: [...schema.required, "review_assessment"],
      properties: { ...schema.properties,
        review_assessment: { anyOf: [LCM_REVIEW_ASSESSMENT_SCHEMA, { type: "null" }] } }
    } : schema,
    parse: (parsed) => {
      const { findings, dropped } = parseFindings(parsed);
      if (dropped.length > 0) {
        throw new Error(`${dropped.length} finding(s) failed NeonDiff validation`);
      }
      const verifiedFindings = input.checkoutReads ? findings.filter((finding) => {
        const failure = finding.evidenceMalformed ? "malformed" : (finding.evidence ?? []).map((ref) => verifySourceRef(input.cwd, ref)).find(Boolean);
        if (!failure) return true;
        droppedFromEvidence.push({ ...finding, reason: "evidence_unverified", evidenceFailure: failure });
        return false;
      }) : findings.map(({ evidence, evidenceMalformed, ...finding }) => finding);
      return { findings: verifiedFindings, summary: parseReviewModelSummary(parsed, verifiedFindings.length) };
    }
  }, dependencies);
  return {
    findings: result.value.findings,
    summary: result.value.summary,
    droppedFromSchema: [],
    ...(input.checkoutReads ? { droppedFromEvidence } : {}),
    rawResponse: result.rawResponse,
    attempts: 1,
    degradedRecovery: false
  };
}

export async function runCodexStructuredOutput<T>(input: {
  cwd: string;
  prompt: string;
  cliPath: string;
  model: string;
  reasoningEffort: CodexReasoningEffort;
  evidenceDir: string;
  timeoutMs: number;
  maxOutputBytes: number;
  artifactPrefix: string;
  schema: unknown;
  parse: (value: unknown) => T;
  /** Where this call's usage file goes when its own evidence dir is scratch (defaults to evidenceDir). */
  usageEvidenceDir?: string;
}, dependencies: {
  runProcess?: (invocation: CodexExecInvocation) => Promise<CodexProcessResult>;
  captureWorktreeState?: (cwd: string) => string;
} = {}): Promise<{ value: T; rawResponse: string }> {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.artifactPrefix)) {
    throw new Error("codex_runtime_invalid_artifact_prefix");
  }
  mkdirSync(input.evidenceDir, { recursive: true });
  const schemaPath = join(input.evidenceDir, `${input.artifactPrefix}-schema.json`);
  const outputPath = join(input.evidenceDir, `${input.artifactPrefix}-result.json`);
  writeSecureFileSync(schemaPath, `${JSON.stringify(input.schema, null, 2)}\n`);
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
  const startedAt = Date.now();
  const result = await (dependencies.runProcess ?? runCodexProcess)(invocation);
  // Every Codex call records its usage, so a review's cost is the sum of its codex-usage*.json files.
  const usageDir = input.usageEvidenceDir ?? input.evidenceDir;
  mkdirSync(usageDir, { recursive: true });
  const usageFile = input.artifactPrefix === "codex-review"
    ? "codex-usage.json"
    : `codex-usage-${input.artifactPrefix}-${randomBytes(4).toString("hex")}.json`;
  writeSecureFileSync(join(usageDir, usageFile),
    `${JSON.stringify(parseCodexUsage(result.stderr, input, Date.now() - startedAt), null, 2)}\n`);
  const after = captureWorktreeState(input.cwd);
  const stdout = redactSecrets(result.stdout);
  const stderr = redactSecrets(result.stderr);
  writeSecureFileSync(join(input.evidenceDir, `${input.artifactPrefix}-stdout.txt`), stdout);
  writeSecureFileSync(join(input.evidenceDir, `${input.artifactPrefix}-stderr.txt`), stderr);
  if (input.artifactPrefix === "codex-review") {
    try {
      writeSecureFileSync(join(input.evidenceDir, "codex-commands.json"), `${JSON.stringify(parseCodexCommands(stderr, input.prompt), null, 2)}\n`);
    } catch { /* Audit is detect-only and must never fail a review. */ }
  }

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
  let outputFd: number | undefined;
  try {
    const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
    outputFd = openSync(outputPath, constants.O_RDONLY | noFollow);
    const outputStat = fstatSync(outputFd);
    if (!outputStat.isFile() || outputStat.size > input.maxOutputBytes) {
      throw new Error("result file is missing, invalid, or over the output limit");
    }
    fchmodSync(outputFd, 0o600);
    rawResponse = readFileSync(outputFd, "utf8");
    if (Buffer.byteLength(rawResponse, "utf8") > input.maxOutputBytes) {
      throw new Error("result file grew over the output limit while being read");
    }
  } catch (error) {
    throw new Error(`codex_runtime_schema_invalid: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (outputFd !== undefined) closeSync(outputFd);
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
  let value: T;
  try {
    value = input.parse(parsed);
  } catch (error) {
    throw new Error(`codex_runtime_schema_invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { value, rawResponse };
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
