import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { accessSync, closeSync, constants, existsSync, fchmodSync, fstatSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { REVIEW_FINDINGS_JSON_SCHEMA } from "./findings-schema.js";
import { LCM_REVIEW_ASSESSMENT_SCHEMA } from "./lcm-review-assessment.js";
import { parseFindings } from "./findings.js";
import { createSourceRefReadBudget, verifySourceRef } from "./issue-analysis.js";
import type { DroppedFinding } from "./types.js";
import { containsSecretLikeText, redactSecrets, secretLikeRuleIds } from "./secrets.js";
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

export interface SecretRedactionReport {
  paths: string[];
  ruleIds: string[];
  locations: Array<{ path: string; ruleIds: string[] }>;
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
  commands: Array<{ command: string; cwd: string | null; exitStatus: number | null; flagged: boolean }>;
  counts: { total: number; flagged: number; blocksSeen: number; blocksRecorded: number };
  truncated: boolean;
  parseNote?: "prompt_echo_not_found";
} {
  const commands: Array<{ command: string; cwd: string | null; exitStatus: number | null; flagged: boolean }> = [];
  const redacted = redactSecrets(stderr).replace(/\r\n/g, "\n");
  const echo = echoedPrompt === undefined ? undefined : `user\n${redactSecrets(echoedPrompt).replace(/\r\n/g, "\n")}`;
  const echoAt = echo === undefined ? -1 : redacted.indexOf(echo);
  const lines = (echo === undefined ? redacted : echoAt < 0 ? "" : redacted.slice(echoAt + echo.length)).split("\n");
  const statusPattern = /^\s*(succeeded|exited (-?\d+)) in .*:/;
  let blocksSeen = 0, flaggedCount = 0, headerTruncated = false;
  let pending: typeof commands = [];
  let statusesStarted = false;
  for (let i = 0; i < lines.length; i++) {
    const status = statusPattern.exec(lines[i]!);
    if (status) {
      statusesStarted = true;
      const record = pending.shift();
      if (record) record.exitStatus = status[1] === "succeeded" ? 0 : Number(status[2]);
      continue;
    }
    if (lines[i] !== "exec") continue;
    // A parallel batch emits all headers first, then its statuses (with output between them).
    if (statusesStarted) { pending = []; statusesStarted = false; }
    let end = i + 1;
    while (end < lines.length && end <= i + 200 && lines[end] !== "exec" && !statusPattern.test(lines[end]!)) end++;
    if (end < lines.length && end > i + 200 && lines[end] !== "exec" && !statusPattern.test(lines[end]!)) headerTruncated = true;
    const header = lines.slice(i + 1, end).join("\n").trimEnd();
    i = end - 1;
    if (!header) continue;
    const lastLine = header.lastIndexOf("\n") + 1;
    const split = header.lastIndexOf(" in /");
    const hasCwd = split >= lastLine;
    const wrapped = hasCwd ? header.slice(0, split) : header.replace(/ in$/, "");
    const cwd = hasCwd ? header.slice(split + 4).slice(0, 300) : null;
    const command = /^(?:\/(?:usr\/)?bin\/)?(?:bash|zsh|sh) -[a-z]*c (['"])([\s\S]*)\1$/.exec(wrapped)?.[2] ?? wrapped;
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
    if (commands.length < 200) {
      const record = { command: command.slice(0, 300), cwd, exitStatus: null as number | null, flagged };
      commands.push(record);
      pending.push(record);
    }
  }
  return { commands, counts: { total: blocksSeen, flagged: flaggedCount, blocksSeen, blocksRecorded: commands.length },
    truncated: headerTruncated || blocksSeen > commands.length,
    ...(echo !== undefined && echoAt < 0 ? { parseNote: "prompt_echo_not_found" as const } : {}) };
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

function canonicalPath(path: string): string {
  const absolute = resolve(path);
  try { return realpathSync(absolute); } catch (error) {
    if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "") || dirname(absolute) === absolute) throw error;
    return join(canonicalPath(dirname(absolute)), basename(absolute));
  }
}
// macOS volumes are case-insensitive by default, so a mis-cased path must still match its root.
function under(path: string, root: string): boolean {
  const [left, right] = process.platform === "darwin" ? [path.toLowerCase(), root.toLowerCase()] : [path, root];
  return left === right || left.startsWith(right.endsWith("/") ? right : right + "/");
}

/** Pin PATH resolution before checkout creation, excluding every work-root alias. */
export function resolveTrustedCodexPath(cliPath: string, workRoot: string, env: NodeJS.ProcessEnv = process.env): string {
  if (isAbsolute(cliPath)) return cliPath;
  const work = canonicalPath(workRoot);
  for (const entry of (env.PATH ?? "").split(delimiter)) {
    if (!entry || !isAbsolute(entry)) continue;
    try {
      // An unreadable or looping PATH entry is skipped like a missing one.
      if (under(canonicalPath(entry), work)) continue;
      const candidate = realpathSync(join(entry, cliPath));
      if (under(candidate, work)) continue;
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch { /* Try the next trusted entry. */ }
  }
  throw new Error("Codex CLI not found on a trusted PATH outside workRoot");
}

/** OS-enforced read roots for a checkout-read review: the shell tool can read only these plus system files. */
export interface CodexReadConfinement {
  /** Real path of the Codex CLI: its sandbox helper re-executes itself and must be readable. */
  command: string;
  readableRoots: string[];
}

const CHECKOUT_READ_PERMISSION_PROFILE = "neondiff_checkout_read";

/**
 * `--sandbox read-only` only blocks writes; it can still read any host file (including the Codex
 * login). Checkout reads use a named permission profile instead, so a hostile PR cannot get the
 * model to read outside the worktree via absolute paths, `../`, or symlinks in the PR tree.
 */
export function resolveCodexReadConfinement(cwd: string, cliPath: string, env: NodeJS.ProcessEnv): CodexReadConfinement {
  const located = isAbsolute(cliPath) ? cliPath : (env.PATH ?? "").split(delimiter)
    .filter((entry) => isAbsolute(entry)).map((entry) => join(entry, cliPath)).find((candidate) => {
      try { accessSync(candidate, constants.X_OK); return statSync(candidate).isFile(); } catch { return false; }
    });
  if (!located) throw new Error("codex_runtime_read_confinement_unavailable: Codex CLI not found");
  const command = realpathSync(located);
  const roots = [realpathSync(cwd), dirname(command)];
  // npm installs run a JS launcher that spawns the native binary from a sibling @openai package.
  const npmScope = /^(.*\/node_modules\/@openai)\//.exec(command)?.[1];
  if (npmScope) roots.push(npmScope);
  // A worktree's .git file points at the mirror; git show/log/blame need to read it.
  const gitDir = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd, env, encoding: "utf8", timeout: 30_000
  });
  if (!gitDir.error && gitDir.status === 0 && gitDir.stdout.trim()) roots.push(realpathSync(gitDir.stdout.trim()));
  const codexHome = env.CODEX_HOME ?? join(env.HOME ?? homedir(), ".codex");
  const codexHomeReal = existsSync(codexHome) ? realpathSync(codexHome) : codexHome;
  if (roots.some((root) => codexHomeReal === root || codexHomeReal.startsWith(`${root}/`))) {
    throw new Error("codex_runtime_read_confinement_unavailable: a readable root would expose CODEX_HOME");
  }
  return { command, readableRoots: [...new Set(roots)] };
}

/** Oldest Codex CLI tested with the named permission profiles that confined checkout reads use. */
export const CODEX_CHECKOUT_READS_MIN_VERSION = "0.163.0";

export type CheckoutReadsStatus = "disabled" | "enabled" | "unavailable:codex_version" | "unavailable:confinement";

/** Parses `codex --version` output such as `codex-cli 0.163.0`. */
export function parseCodexCliVersion(output: string): [number, number, number] | undefined {
  const match = /\b(\d+)\.(\d+)\.(\d+)\b/.exec(output);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

export function codexCliVersionAtLeast(version: [number, number, number], minimum: string): boolean {
  const floor = parseCodexCliVersion(minimum)!;
  for (let index = 0; index < 3; index += 1) {
    if (version[index] !== floor[index]) return version[index] > floor[index];
  }
  return true;
}

// Cache supported versions only, so installation or upgrade is picked up on the next review.
const codexCliVersionCache = new Map<string, string>();

function readCodexCliVersion(cliPath: string, env: NodeJS.ProcessEnv): string | undefined {
  const cached = codexCliVersionCache.get(cliPath);
  if (cached !== undefined) return cached;
  const result = spawnSync(cliPath, ["--version"], { env, encoding: "utf8", timeout: 30_000 });
  if (result.error || result.status !== 0 || !parseCodexCliVersion(result.stdout)) return undefined;
  if (codexCliVersionAtLeast(parseCodexCliVersion(result.stdout)!, CODEX_CHECKOUT_READS_MIN_VERSION)) codexCliVersionCache.set(cliPath, result.stdout);
  return result.stdout;
}

/**
 * Decides once per review whether confined checkout reads can run. When they cannot (an older
 * Codex CLI without permission profiles, or no safe read roots), the review falls back to the
 * diff-only invocation instead of failing under `--strict-config`.
 */
export function resolveCheckoutReadsStatus(input: { checkoutReads?: boolean; cwd: string; cliPath: string; sensitivePaths?: Record<string, string | undefined> }, dependencies: {
  platform?: NodeJS.Platform;
  readVersion?: (cliPath: string, env: NodeJS.ProcessEnv) => string | undefined;
  resolveReadConfinement?: typeof resolveCodexReadConfinement;
} = {}): { status: CheckoutReadsStatus; detail?: string } {
  if (input.checkoutReads !== true) return { status: "disabled" };
  const env = buildCodexRuntimeEnv(process.env);
  const output = (dependencies.readVersion ?? readCodexCliVersion)(input.cliPath, env);
  const version = output === undefined ? undefined : parseCodexCliVersion(output);
  if (!version) return { status: "unavailable:codex_version", detail: "could not read `codex --version`" };
  if (!codexCliVersionAtLeast(version, CODEX_CHECKOUT_READS_MIN_VERSION)) {
    return { status: "unavailable:codex_version", detail: `Codex CLI ${version.join(".")} is older than ${CODEX_CHECKOUT_READS_MIN_VERSION}` };
  }
  try {
    const confinement = (dependencies.resolveReadConfinement ?? resolveCodexReadConfinement)(input.cwd, input.cliPath, env);
    const platform = dependencies.platform ?? process.platform;
    const systemRoots = platform === "darwin" ? ["/etc", "/private/etc", "/usr", "/bin", "/sbin", "/System", "/Library", "/Applications", "/dev"]
      : platform === "linux" ? ["/etc", "/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/opt", "/dev", "/proc", "/sys", "/run", "/snap"] : [];
    const roots = [...systemRoots, input.cwd, dirname(confinement.command), ...confinement.readableRoots].map(canonicalPath);
    for (const [kind, path] of Object.entries(input.sensitivePaths ?? {})) {
      if (!path) continue;
      const real = canonicalPath(path);
      if (roots.some(root => under(real, root)) || (!systemRoots.length && !under(real, canonicalPath(env.HOME ?? homedir())))) {
        return { status: "unavailable:confinement", detail: `${kind} path [redacted] is readable inside the Codex sandbox; move it outside system directories to enable checkout reads` };
      }
    }
  } catch (error) {
    return { status: "unavailable:confinement", detail: redactSecrets(error instanceof Error ? error.message : String(error)) };
  }
  return { status: "enabled" };
}

function checkoutReadPermissionArgs(readableRoots: string[]): string[] {
  const entries = [":minimal", ":workspace_roots", ...readableRoots].map((root) => `${JSON.stringify(root)}="read"`);
  return [
    "-c", 'shell_environment_policy.set={GIT_CONFIG_GLOBAL="/dev/null", GIT_CONFIG_NOSYSTEM="1"}',
    "-c", `default_permissions="${CHECKOUT_READ_PERMISSION_PROFILE}"`,
    "-c", `permissions.${CHECKOUT_READ_PERMISSION_PROFILE}.filesystem={${entries.join(", ")}}`
  ];
}

export function buildCodexExecInvocation(input: {
  cliPath: string;
  cwd: string;
  model: string;
  reasoningEffort: CodexReasoningEffort;
  schemaPath: string;
  outputPath: string;
  readConfinement?: CodexReadConfinement;
}): Pick<CodexExecInvocation, "command" | "args"> {
  return {
    command: input.readConfinement?.command ?? input.cliPath,
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
      // `--sandbox` overrides a permission profile, so the confined variant must omit it.
      ...(input.readConfinement ? checkoutReadPermissionArgs(input.readConfinement.readableRoots) : ["--sandbox", "read-only"]),
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
  resolveReadConfinement?: typeof resolveCodexReadConfinement;
} = {}): Promise<ZCodeReviewResult> {
  const schema = input.checkoutReads ? CODEX_CHECKOUT_REVIEW_FINDINGS_JSON_SCHEMA : CODEX_REVIEW_FINDINGS_JSON_SCHEMA;
  const droppedFromEvidence: DroppedFinding[] = [];
  const redactionReportPath = join(input.evidenceDir, "secret-redactions.json");
  // A retry of the same head reuses this evidence dir; a clean rerun must not inherit an old report.
  rmSync(redactionReportPath, { force: true });
  let secretRedacted = false;
  const result = await runCodexStructuredOutput({
    ...input,
    confineReadsToCheckout: input.checkoutReads === true,
    artifactPrefix: "codex-review",
    onSecretRedaction: (report) => {
      secretRedacted = true;
      writeSecureFileSync(redactionReportPath, `${JSON.stringify({ count: report.locations.length, ...report }, null, 2)}\n`);
    },
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
      const readBudget = createSourceRefReadBudget();
      const verifiedFindings = input.checkoutReads ? findings.filter((finding) => {
        const failure = finding.evidenceMalformed ? "malformed" : (finding.evidence ?? []).map((ref) => verifySourceRef(input.cwd, ref, readBudget)).find(Boolean);
        if (!failure) return true;
        droppedFromEvidence.push({ ...finding, reason: "evidence_unverified", evidenceFailure: failure });
        return false;
      }) : findings.map(({ evidence, evidenceMalformed, ...finding }) => finding);
      const summary = parseReviewModelSummary(parsed, verifiedFindings.length);
      // The summary comes from the same response; a rejected claim must not survive through it.
      return { findings: verifiedFindings, summary: droppedFromEvidence.length > 0 ? {
        changedBehavior: [], invariants: [], evidence: [],
        limitations: [`The model summary was withheld because ${droppedFromEvidence.length} finding(s) cited checkout evidence that did not verify.`],
        noFindingRationale: "The model summary was withheld because some checkout citations did not verify."
      } : summary };
    }
  }, dependencies);
  return {
    findings: result.value.findings,
    summary: result.value.summary,
    droppedFromSchema: [],
    ...(input.checkoutReads ? { droppedFromEvidence } : {}),
    rawResponse: result.rawResponse,
    ...(secretRedacted ? { secretRedacted: true } : {}),
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
  onSecretRedaction?: (report: SecretRedactionReport) => void;
  /** Fail closed on secret-like output instead of redacting it (callers whose gates must see the original text). */
  rejectSecretOutput?: boolean;
  /** Checkout reads: confine the shell tool's file reads to the checkout (fails closed if unavailable). */
  confineReadsToCheckout?: boolean;
}, dependencies: {
  runProcess?: (invocation: CodexExecInvocation) => Promise<CodexProcessResult>;
  captureWorktreeState?: (cwd: string) => string;
  resolveReadConfinement?: typeof resolveCodexReadConfinement;
} = {}): Promise<{ value: T; rawResponse: string }> {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.artifactPrefix)) {
    throw new Error("codex_runtime_invalid_artifact_prefix");
  }
  mkdirSync(input.evidenceDir, { recursive: true });
  const schemaPath = join(input.evidenceDir, `${input.artifactPrefix}-schema.json`);
  const outputPath = join(input.evidenceDir, `${input.artifactPrefix}-result.json`);
  writeSecureFileSync(schemaPath, `${JSON.stringify(input.schema, null, 2)}\n`);
  const env = buildCodexRuntimeEnv(process.env);
  const command = buildCodexExecInvocation({
    cliPath: input.cliPath,
    cwd: input.cwd,
    model: input.model,
    reasoningEffort: input.reasoningEffort,
    schemaPath,
    outputPath,
    ...(input.confineReadsToCheckout ? {
      readConfinement: (dependencies.resolveReadConfinement ?? resolveCodexReadConfinement)(input.cwd, input.cliPath, env)
    } : {})
  });
  const invocation: CodexExecInvocation = {
    ...command,
    cwd: input.cwd,
    stdin: input.prompt,
    env,
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
    const locations: SecretRedactionReport["locations"] = [];
    const redactString = (text: string, path: string): string => {
      const redacted = redactSecrets(text);
      if (redacted !== text) locations.push({ path, ruleIds: secretLikeRuleIds(text) });
      return redacted;
    };
    const walk = (value: unknown, path: string): unknown => {
      if (typeof value === "string") return redactString(value, path);
      if (Array.isArray(value)) return value.map((item, index) => walk(item, `${path}/${index}`));
      if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => {
        const safeKey = redactSecrets(key);
        // Point into the redacted object: original keys may themselves contain credentials.
        const childPath = `${path}/${safeKey.replaceAll("~", "~0").replaceAll("/", "~1")}`;
        redactString(key, childPath);
        return [safeKey, walk(item, childPath)];
      }));
      return value;
    };
    try {
      if (input.rejectSecretOutput) throw new Error("redaction disabled");
      rawResponse = JSON.stringify(walk(JSON.parse(rawResponse), ""));
      if (containsSecretLikeText(rawResponse)) throw new Error("redaction incomplete");
    } catch {
      writeSecureFileSync(outputPath, '{"status":"rejected-secret-like-output"}\n');
      throw new Error("codex_runtime_secret_output: result contained secret-like text");
    }
    writeSecureFileSync(outputPath, rawResponse);
    input.onSecretRedaction?.({ paths: [...new Set(locations.map(({ path }) => path))],
      ruleIds: [...new Set(locations.flatMap(({ ruleIds }) => ruleIds))], locations });
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
