import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { basename } from "node:path";
import { containsSecretLikeText, redactSecrets } from "./secrets.js";
import type { PullFilePatch, PullRequestSummary } from "./types.js";

export const GITNEXUS_CONTEXT_PACKET_VERSION = "gitnexus-context-packet-v0.1";
export const GITNEXUS_CONTEXT_ADVISORY_LINE =
  "This GitNexus packet is advisory. Current PR diff, checkout files, and GitHub metadata remain authoritative.";

export interface GitNexusContextConfig {
  enabled: boolean;
  packetVersion: string;
  maxPacketBytes: number;
  maxRelatedItems: number;
  queryLimit: number;
  commandTimeoutMs: number;
  maxCommandOutputBytes: number;
  includeStaleContext: boolean;
  repoAliases?: Record<string, string>;
  generatedPathPatterns: string[];
}

export interface GitNexusIndexRecord {
  alias: string;
  path?: string;
  indexedAt?: string;
  commit?: string;
}

export interface GitNexusChangedFileContext {
  path: string;
  status?: string;
  additions?: number;
  deletions?: number;
  changes?: number;
  generated: boolean;
  symbolHints: string[];
  changedExportedSymbols: string[];
}

export interface GitNexusRelatedContext {
  id: string;
  query: string;
  reason: string;
  command: string[];
  outputPreview: string;
  byteEstimate: number;
}

export interface GitNexusOmittedContext {
  id: string;
  reason: "disabled" | "generated_path" | "budget_exceeded" | "query_failed" | "stale_index" | "missing_index";
  detail: string;
}

export interface GitNexusContextRedactionReport {
  ok: boolean;
  blockedSources: Array<{
    id: string;
    redactedPreview: string;
  }>;
  checkedSources: number;
}

export interface GitNexusContextPacket {
  repo: string;
  pullNumber: number;
  headSha: string;
  baseSha: string;
  packetVersion: string;
  generatedAt: string;
  sha256: string;
  byteEstimate: number;
  tokenEstimate: number;
  advisory: string;
  gitnexus: {
    alias?: string;
    indexCommit?: string;
    indexedAt?: string;
    indexPath?: string;
    freshness: "fresh" | "stale" | "missing" | "unknown";
    degradedMode: boolean;
    degradedReason?: string;
  };
  changedFiles: GitNexusChangedFileContext[];
  relatedContext: GitNexusRelatedContext[];
  omittedContext: GitNexusOmittedContext[];
  markdown: string;
  redactionReportSha256: string;
}

export type GitNexusContextBuildResult =
  | {
      ok: true;
      packet: GitNexusContextPacket;
      redactionReport: GitNexusContextRedactionReport;
    }
  | {
      ok: false;
      error: string;
      redactionReport: GitNexusContextRedactionReport;
      omittedContext: GitNexusOmittedContext[];
    };

export interface BuildGitNexusContextPacketInput {
  repo: string;
  pull: PullRequestSummary;
  files: PullFilePatch[];
  config: GitNexusContextConfig;
  generatedAt?: string;
  commandRunner?: GitNexusCommandRunner;
  gitnexusListText?: string;
}

export interface GitNexusCommandResult {
  ok: boolean;
  stdout: string;
  stderr?: string;
  error?: string;
  timedOut?: boolean;
}

export type GitNexusCommandRunner = (args: string[], options: {
  timeoutMs: number;
  maxOutputBytes: number;
}) => GitNexusCommandResult;

export function buildGitNexusContextPacket(input: BuildGitNexusContextPacketInput): GitNexusContextBuildResult {
  validateConfig(input.config);
  parseRepoName(input.repo);
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const generatedAtMs = Date.parse(generatedAt);
  if (!Number.isFinite(generatedAtMs)) throw new Error("generatedAt must be an ISO timestamp");

  const redactionSources: Array<{ id: string; text: string }> = [];
  const omittedContext: GitNexusOmittedContext[] = [];
  const changedFiles = input.files
    .map((file) => mapChangedFile(file, input.config.generatedPathPatterns))
    .sort((left, right) => left.path.localeCompare(right.path));
  for (const file of changedFiles.filter((file) => file.generated)) {
    omittedContext.push({
      id: `file:${file.path}`,
      reason: "generated_path",
      detail: "Generated/build artifact path excluded from GitNexus query selection."
    });
  }

  // Production entrypoints gate this earlier; this keeps the packet builder's
  // inner contract offline for future direct callers.
  if (!input.config.enabled) {
    omittedContext.push({
      id: "gitnexus:disabled",
      reason: "disabled",
      detail: "GitNexus context is disabled by configuration."
    });
    return buildRenderedPacketResult({
      repo: input.repo,
      pull: input.pull,
      packetVersion: input.config.packetVersion,
      generatedAt,
      maxPacketBytes: input.config.maxPacketBytes,
      advisory: GITNEXUS_CONTEXT_ADVISORY_LINE,
      gitnexus: {
        freshness: "missing",
        degradedMode: true,
        degradedReason: "GitNexus context is disabled by configuration."
      },
      changedFiles,
      relatedContext: [],
      omittedContext,
      redactionSources
    });
  }

  const commandRunner = input.commandRunner ?? runGitNexusCommand;
  const listResult = input.gitnexusListText !== undefined
    ? { ok: true, stdout: input.gitnexusListText }
    : commandRunner(["list"], {
      timeoutMs: input.config.commandTimeoutMs,
      maxOutputBytes: input.config.maxCommandOutputBytes
    });

  let indexes: GitNexusIndexRecord[] = [];
  let alias: string | undefined;
  let index: GitNexusIndexRecord | undefined;
  let freshness: GitNexusContextPacket["gitnexus"]["freshness"] = "unknown";
  let degradedReason: string | undefined;

  if (!listResult.ok) {
    degradedReason = describeCommandFailure("gitnexus list", listResult);
    freshness = "unknown";
  } else {
    redactionSources.push({ id: "gitnexus:list", text: listResult.stdout });
    indexes = parseGitNexusList(listResult.stdout);
    alias = resolveGitNexusAlias(input.repo, indexes, input.config.repoAliases);
    index = alias ? indexes.find((candidate) => candidate.alias === alias) : undefined;
    if (!index) {
      freshness = "missing";
      degradedReason = "No matching GitNexus index alias was found for this repository.";
      omittedContext.push({ id: "gitnexus:index", reason: "missing_index", detail: degradedReason });
    } else {
      freshness = classifyIndexFreshness(index.commit, input.pull);
      if (freshness === "stale") {
        degradedReason = `GitNexus index commit ${index.commit ?? "unknown"} does not match PR base/head.`;
        omittedContext.push({ id: `gitnexus:${index.alias}`, reason: "stale_index", detail: degradedReason });
      }
    }
  }

  const relatedContext: GitNexusRelatedContext[] = [];
  const canQuery = Boolean(alias) && (freshness === "fresh" || input.config.includeStaleContext);
  if (canQuery) {
    const queryFiles = changedFiles.filter((file) => !file.generated).slice(0, input.config.maxRelatedItems);
    for (const file of queryFiles) {
      const query = buildFileQuery(file);
      const args = [
        "query",
        query,
        "--repo",
        alias!,
        "--limit",
        String(input.config.queryLimit),
        "--max-tokens",
        String(Math.max(200, Math.floor(input.config.maxCommandOutputBytes / 4)))
      ];
      const result = commandRunner(args, {
        timeoutMs: input.config.commandTimeoutMs,
        maxOutputBytes: input.config.maxCommandOutputBytes
      });
      if (!result.ok) {
        omittedContext.push({
          id: `query:${file.path}`,
          reason: "query_failed",
          detail: describeCommandFailure(args.join(" "), result)
        });
        continue;
      }
      redactionSources.push({ id: `query:${file.path}`, text: result.stdout });
      const outputPreview = truncateByBytes(redactSecrets(result.stdout).trim(), input.config.maxCommandOutputBytes);
      if (outputPreview) {
        relatedContext.push({
          id: `query:${file.path}`,
          query,
          reason: `Related GitNexus flows for changed file ${file.path}.`,
          command: ["gitnexus", ...args],
          outputPreview,
          byteEstimate: Buffer.byteLength(outputPreview, "utf8")
        });
      }
    }
  }

  return buildRenderedPacketResult({
    repo: input.repo,
    pull: input.pull,
    packetVersion: input.config.packetVersion,
    generatedAt,
    maxPacketBytes: input.config.maxPacketBytes,
    advisory: GITNEXUS_CONTEXT_ADVISORY_LINE,
    gitnexus: {
      ...(alias ? { alias } : {}),
      ...(index?.commit ? { indexCommit: index.commit } : {}),
      ...(index?.indexedAt ? { indexedAt: index.indexedAt } : {}),
      ...(index?.path ? { indexPath: index.path } : {}),
      freshness,
      degradedMode: freshness !== "fresh",
      ...(degradedReason ? { degradedReason } : {})
    },
    changedFiles,
    relatedContext,
    omittedContext,
    redactionSources
  });
}

function buildRenderedPacketResult(input: {
  repo: string;
  pull: PullRequestSummary;
  packetVersion: string;
  generatedAt: string;
  maxPacketBytes: number;
  advisory: string;
  gitnexus: GitNexusContextPacket["gitnexus"];
  changedFiles: GitNexusChangedFileContext[];
  relatedContext: GitNexusRelatedContext[];
  omittedContext: GitNexusOmittedContext[];
  redactionSources: Array<{ id: string; text: string }>;
}): GitNexusContextBuildResult {
  const packetBase = {
    repo: input.repo,
    pullNumber: input.pull.number,
    headSha: input.pull.head.sha,
    baseSha: input.pull.base.sha,
    packetVersion: input.packetVersion,
    generatedAt: input.generatedAt,
    advisory: input.advisory,
    gitnexus: input.gitnexus,
    changedFiles: input.changedFiles,
    omittedContext: input.omittedContext
  };
  const preRenderReport = buildRedactionReport(input.redactionSources);
  if (!preRenderReport.ok) {
    return {
      ok: false,
      error: "GitNexus context packet blocked: secret-like text detected in GitNexus output.",
      redactionReport: preRenderReport,
      omittedContext: input.omittedContext
    };
  }

  const budgeted = renderWithinBudget({
    ...packetBase,
    relatedContext: input.relatedContext
  }, input.maxPacketBytes);
  const postRenderReport = buildRedactionReport([{ id: "packet:markdown", text: budgeted.markdown }]);
  const redactionReport = mergeRedactionReports(preRenderReport, postRenderReport);
  if (!postRenderReport.ok) {
    return {
      ok: false,
      error: "GitNexus context packet blocked: secret-like text survived packet rendering.",
      redactionReport,
      omittedContext: budgeted.omittedContext
    };
  }
  if (Buffer.byteLength(budgeted.markdown, "utf8") > input.maxPacketBytes) {
    const budgetExceeded: GitNexusOmittedContext = {
      id: "packet:markdown",
      reason: "budget_exceeded",
      detail: "Base GitNexus context packet exceeded the configured byte budget."
    };
    return {
      ok: false,
      error: `GitNexus context packet exceeded maxPacketBytes (${Buffer.byteLength(budgeted.markdown, "utf8")} > ${input.maxPacketBytes}).`,
      redactionReport,
      omittedContext: [...budgeted.omittedContext, budgetExceeded].sort(compareOmittedContext)
    };
  }

  const packet: GitNexusContextPacket = {
    ...packetBase,
    relatedContext: budgeted.relatedContext,
    omittedContext: budgeted.omittedContext,
    markdown: budgeted.markdown,
    sha256: sha256(budgeted.markdown),
    byteEstimate: Buffer.byteLength(budgeted.markdown, "utf8"),
    tokenEstimate: Math.max(1, Math.ceil(Buffer.byteLength(budgeted.markdown, "utf8") / 4)),
    redactionReportSha256: sha256(JSON.stringify(redactionReport))
  };
  return { ok: true, packet, redactionReport };
}

export function formatGitNexusContextPacketMarkdown(packet: GitNexusContextPacket): string {
  return packet.markdown;
}

export function parseGitNexusList(text: string): GitNexusIndexRecord[] {
  const records: GitNexusIndexRecord[] = [];
  let current: GitNexusIndexRecord | undefined;
  for (const rawLine of text.split(/\r?\n/)) {
    const aliasMatch = rawLine.match(/^  ([^\s].*?)(?:\s{2,}\(.+\))?\s*$/);
    if (aliasMatch && !rawLine.includes(":")) {
      if (aliasMatch[1]!.trim().startsWith("Indexed Repositories")) continue;
      current = { alias: aliasMatch[1]!.trim() };
      records.push(current);
      continue;
    }
    if (!current) continue;
    const pathMatch = rawLine.match(/^\s+Path:\s+(.+?)\s*$/);
    if (pathMatch) current.path = pathMatch[1]!;
    const indexedMatch = rawLine.match(/^\s+Indexed:\s+(.+?)\s*$/);
    if (indexedMatch) current.indexedAt = indexedMatch[1]!;
    const commitMatch = rawLine.match(/^\s+Commit:\s+([A-Fa-f0-9]+)\s*$/);
    if (commitMatch) current.commit = commitMatch[1]!.toLowerCase();
  }
  return records.sort((left, right) => left.alias.localeCompare(right.alias));
}

function renderWithinBudget(input: {
  repo: string;
  pullNumber: number;
  headSha: string;
  baseSha: string;
  packetVersion: string;
  generatedAt: string;
  advisory: string;
  gitnexus: GitNexusContextPacket["gitnexus"];
  changedFiles: GitNexusChangedFileContext[];
  relatedContext: GitNexusRelatedContext[];
  omittedContext: GitNexusOmittedContext[];
}, maxPacketBytes: number): {
  markdown: string;
  relatedContext: GitNexusRelatedContext[];
  omittedContext: GitNexusOmittedContext[];
} {
  const relatedContext = [...input.relatedContext].sort((left, right) => left.id.localeCompare(right.id));
  const omittedContext = [...input.omittedContext].sort(compareOmittedContext);
  for (;;) {
    const markdown = renderMarkdown({ ...input, relatedContext, omittedContext });
    if (Buffer.byteLength(markdown, "utf8") <= maxPacketBytes || relatedContext.length === 0) {
      return { markdown, relatedContext, omittedContext };
    }
    const omitted = relatedContext.pop()!;
    omittedContext.push({
      id: omitted.id,
      reason: "budget_exceeded",
      detail: `Dropped related GitNexus output to keep packet under ${maxPacketBytes} bytes.`
    });
    omittedContext.sort(compareOmittedContext);
  }
}

function renderMarkdown(input: {
  repo: string;
  pullNumber: number;
  headSha: string;
  baseSha: string;
  packetVersion: string;
  generatedAt: string;
  advisory: string;
  gitnexus: GitNexusContextPacket["gitnexus"];
  changedFiles: GitNexusChangedFileContext[];
  relatedContext: GitNexusRelatedContext[];
  omittedContext: GitNexusOmittedContext[];
}): string {
  const parts = [
    "# GitNexus context packet",
    "",
    `Repository: ${input.repo}`,
    `Pull request: #${input.pullNumber}`,
    `Head SHA: ${input.headSha}`,
    `Base SHA: ${input.baseSha}`,
    `Packet version: ${input.packetVersion}`,
    `Generated at: ${input.generatedAt}`,
    "",
    input.advisory,
    "",
    "## GitNexus index",
    "",
    `Alias: ${input.gitnexus.alias ?? "not-found"}`,
    `Freshness: ${input.gitnexus.freshness}`,
    `Degraded mode: ${input.gitnexus.degradedMode ? "true" : "false"}`,
    ...(input.gitnexus.indexCommit ? [`Index commit: ${input.gitnexus.indexCommit}`] : []),
    ...(input.gitnexus.indexedAt ? [`Indexed at: ${input.gitnexus.indexedAt}`] : []),
    ...(input.gitnexus.indexPath ? [`Index path: ${input.gitnexus.indexPath}`] : []),
    ...(input.gitnexus.degradedReason ? [`Degraded reason: ${input.gitnexus.degradedReason}`] : []),
    "",
    "## Changed files",
    "",
    ...input.changedFiles.map((file) =>
      [
        `- ${file.path}${file.status ? ` (${file.status})` : ""}${file.generated ? " [generated excluded]" : ""}`,
        file.changedExportedSymbols.length ? `changed exports: ${file.changedExportedSymbols.join(", ")}` : undefined,
        file.symbolHints.length ? `symbol hints: ${file.symbolHints.join(", ")}` : undefined
      ].filter(Boolean).join("; ")
    )
  ];

  if (input.relatedContext.length) {
    parts.push("", "## Related GitNexus context");
    for (const context of input.relatedContext) {
      parts.push(
        "",
        `### ${context.id}`,
        "",
        `Query: ${context.query}`,
        `Reason: ${context.reason}`,
        "",
        "```text",
        context.outputPreview,
        "```"
      );
    }
  }

  if (input.omittedContext.length) {
    parts.push("", "## Omitted context");
    for (const omitted of input.omittedContext) {
      parts.push("", `- ${omitted.id}: ${omitted.reason}; ${omitted.detail}`);
    }
  }

  return `${parts.join("\n").trim()}\n`;
}

function mapChangedFile(file: PullFilePatch, generatedPathPatterns: string[]): GitNexusChangedFileContext {
  const changedExportedSymbols = extractChangedExportedSymbols(file.patch);
  const fallbackHint = symbolHintForPath(file.filename);
  const symbolHints = [...new Set([...changedExportedSymbols, ...(fallbackHint ? [fallbackHint] : [])])].sort();
  return {
    path: file.filename,
    ...(file.status ? { status: file.status } : {}),
    ...(file.additions !== undefined ? { additions: file.additions } : {}),
    ...(file.deletions !== undefined ? { deletions: file.deletions } : {}),
    ...(file.changes !== undefined ? { changes: file.changes } : {}),
    generated: isGeneratedPath(file.filename, generatedPathPatterns),
    symbolHints,
    changedExportedSymbols
  };
}

function buildFileQuery(file: GitNexusChangedFileContext): string {
  return file.symbolHints.length ? `${file.path} ${file.symbolHints.join(" ")}` : file.path;
}

export function extractChangedExportedSymbols(patch: string | null | undefined): string[] {
  if (!patch) return [];
  const symbols = new Set<string>();
  for (const rawLine of patch.split(/\r?\n/)) {
    if (!rawLine.startsWith("+") || rawLine.startsWith("+++")) continue;
    const line = rawLine.slice(1).trim();
    const symbol = matchExportedSymbol(line);
    if (symbol) symbols.add(symbol);
  }
  return [...symbols].sort();
}

function matchExportedSymbol(line: string): string | undefined {
  const patterns = [
    /^export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\b/,
    /^export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)\b/,
    /^export\s+(?:class|interface|type|enum)\s+([A-Za-z_$][\w$]*)\b/,
    /^export\s*\{\s*([^}]+)\s*\}/
  ];
  const direct = patterns.slice(0, 3).map((pattern) => line.match(pattern)).find(Boolean);
  if (direct?.[1]) return direct[1];
  const named = line.match(patterns[3]!);
  if (!named?.[1]) return undefined;
  return named[1]
    .split(",")
    .map((part) => part.trim().split(/\s+as\s+/i)[0]?.trim())
    .find((part) => part && /^[A-Za-z_$][\w$]*$/.test(part));
}

function symbolHintForPath(path: string): string | undefined {
  const name = basename(path).replace(/\.[^.]+$/, "");
  const cleaned = name.replace(/[^A-Za-z0-9_ -]/g, " ").replace(/\s+/g, " ").trim();
  return cleaned || undefined;
}

function resolveGitNexusAlias(
  repo: string,
  indexes: GitNexusIndexRecord[],
  repoAliases: Record<string, string> | undefined
): string | undefined {
  const explicit = repoAliases?.[repo];
  if (explicit && indexes.some((index) => index.alias === explicit)) return explicit;
  const [, repoName] = parseRepoName(repo);
  const normalizedRepoName = normalizeName(repoName);
  const normalizedFullName = normalizeName(repo);
  const candidates = indexes.filter((index) => {
    const normalizedAlias = normalizeName(index.alias);
    const normalizedPath = index.path ? normalizeName(basename(index.path)) : "";
    return normalizedAlias === normalizedRepoName ||
      normalizedAlias === normalizedFullName ||
      normalizedPath === normalizedRepoName ||
      normalizedPath === normalizedFullName;
  });
  return candidates.sort((left, right) => scoreAlias(repoName, left) - scoreAlias(repoName, right) || left.alias.localeCompare(right.alias))[0]?.alias;
}

function scoreAlias(repoName: string, index: GitNexusIndexRecord): number {
  if (index.alias === repoName) return 0;
  if (index.alias.toLowerCase() === repoName.toLowerCase()) return 1;
  if (normalizeName(index.alias) === normalizeName(repoName)) return 2;
  return 3;
}

function classifyIndexFreshness(commit: string | undefined, pull: PullRequestSummary): GitNexusContextPacket["gitnexus"]["freshness"] {
  if (!commit) return "unknown";
  if (commitMatches(commit, pull.base.sha) || commitMatches(commit, pull.head.sha)) return "fresh";
  return "stale";
}

function commitMatches(indexCommit: string, sha: string): boolean {
  const normalizedIndex = indexCommit.toLowerCase();
  const normalizedSha = sha.toLowerCase();
  return normalizedSha.startsWith(normalizedIndex) || normalizedIndex.startsWith(normalizedSha);
}

function isGeneratedPath(path: string, patterns: string[]): boolean {
  return patterns.some((pattern) => matchesPathPattern(path, pattern));
}

function matchesPathPattern(path: string, pattern: string): boolean {
  const normalizedPath = path.replaceAll("\\", "/");
  const normalizedPattern = pattern.replaceAll("\\", "/");
  if (normalizedPattern.endsWith("/**")) {
    return normalizedPath.startsWith(normalizedPattern.slice(0, -3));
  }
  if (normalizedPattern.startsWith("**/*.")) {
    return normalizedPath.endsWith(normalizedPattern.slice(4));
  }
  if (normalizedPattern.startsWith("*.")) {
    return basename(normalizedPath).endsWith(normalizedPattern.slice(1));
  }
  if (normalizedPattern.includes("*")) {
    const regex = new RegExp(`^${escapeRegex(normalizedPattern).replaceAll("\\*", ".*")}$`);
    return regex.test(normalizedPath);
  }
  return normalizedPath === normalizedPattern;
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function runGitNexusCommand(args: string[], options: { timeoutMs: number; maxOutputBytes: number }): GitNexusCommandResult {
  const result = spawnSync("gitnexus", args, {
    encoding: "utf8",
    timeout: options.timeoutMs,
    maxBuffer: options.maxOutputBytes
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  return {
    ok: result.status === 0 && !result.error,
    stdout: truncateByBytes(stdout, options.maxOutputBytes),
    stderr: truncateByBytes(stderr, options.maxOutputBytes),
    ...(result.error ? { error: result.error.message } : {}),
    ...(result.signal === "SIGTERM" || result.error?.name === "TimeoutError" ? { timedOut: true } : {})
  };
}

function describeCommandFailure(command: string, result: GitNexusCommandResult): string {
  if (result.timedOut) return `${command} timed out.`;
  if (result.error) return `${command} failed: ${redactSecrets(result.error)}`;
  const stderr = redactSecrets(result.stderr ?? "").trim();
  return stderr ? `${command} failed: ${stderr.slice(0, 300)}` : `${command} failed.`;
}

function buildRedactionReport(sources: Array<{ id: string; text: string }>): GitNexusContextRedactionReport {
  const blockedSources = sources
    .filter((source) => containsSecretLikeText(source.text))
    .map((source) => ({
      id: redactSecrets(source.id),
      redactedPreview: redactSecrets(source.text).slice(0, 500)
    }));
  return {
    ok: blockedSources.length === 0,
    blockedSources,
    checkedSources: sources.length
  };
}

function mergeRedactionReports(
  first: GitNexusContextRedactionReport,
  second: GitNexusContextRedactionReport
): GitNexusContextRedactionReport {
  return {
    ok: first.ok && second.ok,
    blockedSources: [...first.blockedSources, ...second.blockedSources],
    checkedSources: first.checkedSources + second.checkedSources
  };
}

function compareOmittedContext(left: GitNexusOmittedContext, right: GitNexusOmittedContext): number {
  return left.id.localeCompare(right.id) || left.reason.localeCompare(right.reason);
}

function truncateByBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let output = text;
  while (Buffer.byteLength(output, "utf8") > maxBytes) output = output.slice(0, -1);
  return `${output}\n[truncated]`;
}

function normalizeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function parseRepoName(repo: string): [string, string] {
  const [owner, name, extra] = repo.split("/");
  if (extra !== undefined || !owner || !name) throw new Error("repo must be an owner/repo name");
  return [owner, name];
}

function validateConfig(config: GitNexusContextConfig): void {
  if (!Number.isInteger(config.maxPacketBytes) || config.maxPacketBytes < 1) {
    throw new Error("maxPacketBytes must be a positive integer");
  }
  for (const field of ["maxRelatedItems", "queryLimit", "commandTimeoutMs", "maxCommandOutputBytes"] as const) {
    if (!Number.isInteger(config[field]) || config[field] < 1) throw new Error(`${field} must be a positive integer`);
  }
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
