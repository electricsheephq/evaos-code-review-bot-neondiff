import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseFindings } from "./findings.js";
import type { GitNexusContextPacket } from "./gitnexus-context.js";
import type { GitHubRelatedContextPacket } from "./github-related-context.js";
import type { ProviderRuntimeAdapter } from "./provider-adapters.js";
import type { RepoMemoryPacket } from "./repo-memory.js";
import { buildRepoProfilePromptSection, type ResolvedRepoProfile } from "./repo-policy.js";
import { redactSecrets } from "./secrets.js";
import type { SkillPackContextPacket } from "./skill-packs.js";
import { buildZCodeRuntimeEnv, resolveZCodeProviderEnv } from "./zcode-env.js";
import type { Finding, PullFilePatch, PullRequestSummary } from "./types.js";

export interface ZCodeReviewResult {
  findings: Finding[];
  droppedFromSchema: ReturnType<typeof parseFindings>["dropped"];
  rawResponse: string;
}

export interface ZCodeReviewFixtureAdapterOptions {
  cwd: string;
  cliPath: string;
  appConfigPath: string;
  evidenceDir?: string;
  timeoutMs?: number;
  retryMaxRetries?: number;
  runReview?: (input: {
    cwd: string;
    prompt: string;
    cliPath: string;
    appConfigPath: string;
    model: string;
    providerId?: string;
    evidenceDir?: string;
    timeoutMs?: number;
    retryMaxRetries?: number;
  }) => ZCodeReviewResult;
}

/**
 * Fixture-only wrapper for same-prompt adapter proof. Live review execution
 * continues to call runZCodeReview directly until a separate runtime adapter
 * proves async behavior, transport evidence, and selection policy.
 */
export function createZCodeReviewFixtureAdapter(options: ZCodeReviewFixtureAdapterOptions): ProviderRuntimeAdapter {
  return {
    id: "zcode",
    async execute(input) {
      const runReview = options.runReview ?? runZCodeReview;
      const result = runReview({
        cwd: options.cwd,
        prompt: input.prompt,
        cliPath: options.cliPath,
        appConfigPath: options.appConfigPath,
        model: input.model,
        providerId: input.providerId,
        ...(options.evidenceDir ? { evidenceDir: options.evidenceDir } : {}),
        ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.retryMaxRetries !== undefined ? { retryMaxRetries: options.retryMaxRetries } : {})
      });
      return {
        text: result.rawResponse,
        rawEvidence: {
          providerId: input.providerId,
          adapterId: input.adapterId,
          model: input.model,
          findings: result.findings.length,
          droppedFromSchema: result.droppedFromSchema.length
        }
      };
    }
  };
}

export function buildReviewPrompt(input: {
  repo: string;
  pull: PullRequestSummary;
  files: PullFilePatch[];
  repoProfile?: ResolvedRepoProfile;
  repoMemoryPacket?: Pick<RepoMemoryPacket, "sha256" | "byteEstimate" | "tokenEstimate" | "markdown">;
  gitnexusContextPacket?: Pick<GitNexusContextPacket, "sha256" | "byteEstimate" | "tokenEstimate" | "markdown" | "gitnexus">;
  githubRelatedContextPacket?: Pick<GitHubRelatedContextPacket, "sha256" | "byteEstimate" | "tokenEstimate" | "markdown">;
  skillPackContextPacket?: Pick<SkillPackContextPacket, "sha256" | "byteEstimate" | "tokenEstimate" | "markdown">;
  maxPatchBytes?: number;
}): string {
  const fileList = input.files.map((file) => `- ${file.filename}`).join("\n");
  let remainingPatchBytes = input.maxPatchBytes ?? 80_000;
  const patches = input.files
    .map((file) => {
      const rawPatch = file.patch ?? "[binary or too large for GitHub patch]";
      const patch = truncateToBudget(rawPatch, remainingPatchBytes);
      remainingPatchBytes = Math.max(0, remainingPatchBytes - Buffer.byteLength(patch));
      return `### ${file.filename}\n\n\`\`\`diff\n${patch}\n\`\`\``;
    })
    .join("\n\n");

  return [
    "You are evaOS Code Review Bot. Review this pull request aggressively for correctness, security, data loss, CI-breaking behavior, Unity/game regression risk, and missing high-signal tests.",
    "Do not modify files. Do not run project tests, package scripts, builds, app commands, or arbitrary PR code.",
    "Do not call Bash or shell commands. If more context is needed, use read-only file inspection only. If that is impossible, return no findings rather than executing code.",
    "Only inspect the checkout and the diff provided below.",
    "Return JSON only, with shape: {\"findings\":[{\"severity\":\"P0|P1|P2|P3\",\"path\":\"relative/file\",\"line\":123,\"title\":\"short title\",\"body\":\"specific actionable explanation\",\"confidence\":0.0,\"why_this_matters\":\"optional\",\"category\":\"optional enum hint\"}],\"summary\":\"short review summary\"}.",
    "If you include category, use one of: data_loss, auth, ci_build, unity_scene_prefab, security_boundary, migration, api_compatibility, release_regression, flaky_test_risk, proof_gap, runtime_correctness, dependency, docs_only, unknown.",
    "The deterministic wrapper treats category as a hint only; severity, current diff coordinates, redaction, and gate policy decide posting.",
    "Use P0/P1 only for validated correctness, security, data-loss, CI-breaking, or release-regression issues. Prefer no finding over speculative noise.",
    "Every finding must point at a RIGHT-side line in the current diff.",
    "",
    `Repository: ${input.repo}`,
    `Pull request: #${input.pull.number} ${input.pull.title}`,
    `Head SHA: ${input.pull.head.sha}`,
    "",
    ...(input.repoProfile ? [buildRepoProfilePromptSection(input.repoProfile), ""] : []),
    ...(input.skillPackContextPacket ? [buildSkillPackContextPromptSection(input.skillPackContextPacket), ""] : []),
    ...(input.repoMemoryPacket ? [buildRepoMemoryPromptSection(input.repoMemoryPacket), ""] : []),
    ...(input.gitnexusContextPacket ? [buildGitNexusContextPromptSection(input.gitnexusContextPacket), ""] : []),
    ...(input.githubRelatedContextPacket ? [buildGitHubRelatedContextPromptSection(input.githubRelatedContextPacket), ""] : []),
    "Files:",
    fileList,
    "",
    "Diff:",
    patches
  ].join("\n");
}

function buildSkillPackContextPromptSection(
  packet: Pick<SkillPackContextPacket, "sha256" | "byteEstimate" | "tokenEstimate" | "markdown">
): string {
  return [
    "Read-only skill-pack context (advisory; feature-flagged context):",
    `Packet SHA-256: ${packet.sha256}`,
    `Packet budget: ${packet.byteEstimate} bytes; approx ${packet.tokenEstimate} tokens`,
    "Native ZCode skills, tools, MCP, web, shell, memory, and writes remain disabled.",
    "",
    packet.markdown.trim()
  ].join("\n");
}

function buildGitHubRelatedContextPromptSection(
  packet: Pick<GitHubRelatedContextPacket, "sha256" | "byteEstimate" | "tokenEstimate" | "markdown">
): string {
  return [
    "GitHub related-context packet (advisory; feature-flagged context):",
    `Packet SHA-256: ${packet.sha256}`,
    `Packet budget: ${packet.byteEstimate} bytes; approx ${packet.tokenEstimate} tokens`,
    "",
    packet.markdown.trim()
  ].join("\n");
}

function buildGitNexusContextPromptSection(
  packet: Pick<GitNexusContextPacket, "sha256" | "byteEstimate" | "tokenEstimate" | "markdown" | "gitnexus">
): string {
  return [
    "GitNexus context packet (advisory; feature-flagged context):",
    `Packet SHA-256: ${packet.sha256}`,
    `Packet budget: ${packet.byteEstimate} bytes; approx ${packet.tokenEstimate} tokens`,
    `GitNexus freshness: ${packet.gitnexus.freshness}; degraded=${packet.gitnexus.degradedMode ? "true" : "false"}`,
    "",
    packet.markdown.trim()
  ].join("\n");
}

function buildRepoMemoryPromptSection(packet: Pick<RepoMemoryPacket, "sha256" | "byteEstimate" | "tokenEstimate" | "markdown">): string {
  return [
    "Durable repo memory packet (advisory; feature-flagged context):",
    `Packet SHA-256: ${packet.sha256}`,
    `Packet budget: ${packet.byteEstimate} bytes; approx ${packet.tokenEstimate} tokens`,
    "",
    packet.markdown.trim()
  ].join("\n");
}

export function runZCodeReview(input: {
  cwd: string;
  prompt: string;
  cliPath: string;
  appConfigPath: string;
  model: string;
  providerId?: string;
  evidenceDir?: string;
  timeoutMs?: number;
  retryMaxRetries?: number;
}): ZCodeReviewResult {
  const zcodeEnv = resolveZCodeProviderEnv({
    appConfigPath: input.appConfigPath,
    model: input.model,
    providerId: input.providerId
  });

  const prompts = [
    input.prompt,
    buildStrictJsonRetryPrompt(input.prompt)
  ];
  let lastParseError: unknown;

  for (let attempt = 1; attempt <= prompts.length; attempt += 1) {
    const result = withTemporaryZCodeReviewPolicy(input.cwd, input.evidenceDir, () =>
      spawnSync(process.execPath, [
        input.cliPath,
        "--cwd",
        input.cwd,
        "--mode",
        "plan",
        "--json",
        "--no-browser",
        "--prompt",
        prompts[attempt - 1]!
      ], {
        env: buildZCodeRuntimeEnv({
          baseEnv: process.env,
          providerEnv: zcodeEnv,
          retryMaxRetries: input.retryMaxRetries ?? 0
        }),
        encoding: "utf8",
        maxBuffer: 20 * 1024 * 1024,
        timeout: input.timeoutMs ?? 180_000
      })
    );

    const stdout = redactSecrets(result.stdout.replaceAll(zcodeEnv.ZCODE_API_KEY, "[redacted-secret]"));
    const stderr = redactSecrets(result.stderr.replaceAll(zcodeEnv.ZCODE_API_KEY, "[redacted-secret]"));
    if (input.evidenceDir) {
      mkdirSync(input.evidenceDir, { recursive: true });
      writeFileSync(join(input.evidenceDir, `zcode-attempt-${attempt}-stdout.jsonl`), stdout);
      writeFileSync(join(input.evidenceDir, `zcode-attempt-${attempt}-stderr.txt`), stderr);
      writeFileSync(join(input.evidenceDir, "zcode-last-stdout.jsonl"), stdout);
      writeFileSync(join(input.evidenceDir, "zcode-last-stderr.txt"), stderr);
    }

    if (result.status !== 0) {
      if (result.error) {
        throw enrichZCodeProcessError({
          error: new Error(`ZCode failed before completion: ${result.error.message}`),
          originalError: result.error,
          signal: result.signal,
          status: result.status
        });
      }
      throw new Error(`ZCode failed with status ${result.status}: ${stderr || stdout.slice(0, 1000)}`);
    }

    try {
      const rawResponse = extractZCodeResponse(result.stdout);
      const parsed = JSON.parse(extractJsonObject(rawResponse));
      const { findings, dropped } = parseFindings(parsed);
      return { findings, droppedFromSchema: dropped, rawResponse };
    } catch (error) {
      lastParseError = error;
    }
  }

  throw new Error(
    `ZCode response did not contain a parseable JSON review after ${prompts.length} attempts: ${
      lastParseError instanceof Error ? lastParseError.message : String(lastParseError)
    }`
  );
}

function buildStrictJsonRetryPrompt(originalPrompt: string): string {
  return [
    "Your previous review output was rejected because it was not valid JSON.",
    "Repeat the review and return ONLY the required JSON object. Do not include markdown, prose, analysis, confidence narration, or code fences.",
    "The response must parse with JSON.parse and must have this exact top-level shape:",
    "{\"findings\":[{\"severity\":\"P0|P1|P2|P3\",\"path\":\"relative/file\",\"line\":123,\"title\":\"short title\",\"body\":\"specific actionable explanation\",\"confidence\":0.0,\"why_this_matters\":\"optional\",\"category\":\"optional enum hint\"}],\"summary\":\"short review summary\"}",
    "If you cannot produce a finding with a current RIGHT-side diff line, return {\"findings\":[],\"summary\":\"No validated current-diff findings.\"}.",
    "",
    originalPrompt
  ].join("\n");
}

export function withTemporaryZCodeReviewPolicy<T>(cwd: string, evidenceDir: string | undefined, run: () => T): T {
  const configDir = join(cwd, ".zcode");
  const configPath = join(configDir, "config.json");
  const hadConfigDir = existsSync(configDir);
  const originalConfig = existsSync(configPath)
    ? { contents: readFileSync(configPath, "utf8"), mode: statSync(configPath).mode }
    : null;
  const policy = buildZCodeReviewPolicy();

  mkdirSync(configDir, { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(policy, null, 2)}\n`, { mode: 0o600 });
  if (evidenceDir) {
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(join(evidenceDir, "zcode-review-policy.json"), `${JSON.stringify(policy, null, 2)}\n`);
  }

  try {
    return run();
  } finally {
    if (originalConfig) {
      mkdirSync(configDir, { recursive: true });
      writeFileSync(configPath, originalConfig.contents, { mode: originalConfig.mode });
    } else {
      rmSync(configPath, { force: true });
      if (!hadConfigDir) {
        try {
          rmdirSync(configDir);
        } catch {
          // Leave a non-empty directory in place; the clean-worktree guard will catch it.
        }
      }
    }
  }
}

function buildZCodeReviewPolicy(): unknown {
  return {
    permission: {
      mode: "build",
      allowedTools: ["Read", "Grep", "Glob", "LS"],
      disallowedTools: [
        "Bash",
        "Shell",
        "Edit",
        "Write",
        "MultiEdit",
        "NotebookEdit",
        "WebFetch",
        "WebSearch",
        "Task",
        "Agent",
        "Workflow",
        "SendMessage"
      ],
      autoApproveHighRisk: false,
      allowMediumRiskInAuto: false
    },
    features: {
      subagent: false,
      mcp: false,
      memory: false,
      skill: false
    },
    memory: {
      use: false,
      write: false,
      autoConsolidate: false
    },
    toolConcurrency: {
      maxConcurrency: 1
    }
  };
}

function truncateToBudget(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "[patch omitted: prompt budget exhausted]";
  const bytes = Buffer.byteLength(text);
  if (bytes <= maxBytes) return text;
  return `${text.slice(0, maxBytes)}\n[patch truncated to fit prompt budget]`;
}

function enrichZCodeProcessError(input: {
  error: Error;
  originalError: Error;
  signal: NodeJS.Signals | null;
  status: number | null;
}): Error {
  const original = input.originalError as Error & { code?: unknown };
  const enriched = input.error as Error & {
    code?: unknown;
    signal?: NodeJS.Signals | null;
    status?: number | null;
  };
  if (original.code !== undefined) enriched.code = original.code;
  enriched.signal = input.signal;
  enriched.status = input.status;
  return enriched;
}

export function extractZCodeResponse(stdout: string): string {
  try {
    const parsed = JSON.parse(stdout) as { response?: unknown };
    if (typeof parsed.response === "string") return parsed.response;
  } catch {
    // Fall through to JSONL parsing for older ZCode CLI builds.
  }

  const candidates = stdout
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as { response?: unknown };
      } catch {
        return null;
      }
    })
    .filter((value): value is { response?: unknown } => Boolean(value));

  const response = [...candidates].reverse().find((value) => typeof value.response === "string")?.response;
  if (typeof response !== "string") throw new Error("ZCode JSON output did not include a string response.");
  return response;
}

export function extractJsonObject(text: string): string {
  const fencedMatches = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
  for (const fenced of fencedMatches) {
    const candidate = fenced[1]!.trim();
    if (isReviewJsonObject(candidate)) return candidate;
  }

  const starts = [...text.matchAll(/\{/g)].map((match) => match.index).filter((index): index is number => index !== undefined);
  const ends = [...text.matchAll(/\}/g)].map((match) => match.index).filter((index): index is number => index !== undefined);
  for (const start of starts.reverse()) {
    for (const end of ends.filter((index) => index > start).reverse()) {
      const candidate = text.slice(start, end + 1).trim();
      if (isReviewJsonObject(candidate)) return candidate;
    }
  }
  throw new Error("ZCode response did not contain a parseable JSON review object.");
}

function isReviewJsonObject(candidate: string): boolean {
  try {
    const parsed = JSON.parse(candidate) as { findings?: unknown };
    return typeof parsed === "object" && parsed !== null && Array.isArray(parsed.findings);
  } catch {
    return false;
  }
}
