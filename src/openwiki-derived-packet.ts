import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import {
  buildRepoWikiPacket,
  type RepoWikiPacket,
  type RepoWikiSectionInput,
  type RepoWikiSourceStatus
} from "./repo-wiki-packet.js";

const OPENWIKI_DIR = "openwiki";
const OPENWIKI_METADATA_PATH = "openwiki/.last-update.json";
const DEFAULT_MAX_PACKET_BYTES = 12_000;
const GIT_COMMAND_TIMEOUT_MS = 5_000;
const REPO_PATH_EXTENSION_PATTERN = /\.(?:[cm]?[jt]sx?|mdx?|json|ya?ml|toml|lock|css|scss|html?|sh|bash|zsh|py|go|rs|swift|kt|java|rb|php|sql|txt)$/i;
const ENV_NAME_TOKEN_PATTERN = /\b[A-Za-z][A-Za-z0-9_-]{1,80}\b/g;
const ENV_ASSIGNMENT_PATTERN = /\b([A-Za-z][A-Za-z0-9_-]{1,80})\b\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{8,}["']?/g;
const SENSITIVE_SEGMENTS = new Set(["token", "secret", "password", "cookie", "session"]);
const SENSITIVE_PAIR_SUFFIXES = new Set([
  "api_key",
  "private_key",
  "access_token",
  "auth_token",
  "refresh_token",
  "id_token",
  "session_cookie"
]);
const SENSITIVE_CAMEL_SUFFIXES = [
  "ApiKey",
  "PrivateKey",
  "AccessToken",
  "AuthToken",
  "RefreshToken",
  "IdToken",
  "SessionCookie"
];

export interface BuildOpenWikiDerivedRepoWikiPacketInput {
  repo: string;
  worktreePath: string;
  generatedAt?: string;
  headSha?: string;
  defaultBranch?: string;
  maxPacketBytes?: number;
  maxSectionBytes?: number;
}

interface OpenWikiMetadata {
  gitHead?: string;
}

export function buildOpenWikiDerivedRepoWikiPacket(input: BuildOpenWikiDerivedRepoWikiPacketInput): RepoWikiPacket {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const headSha = input.headSha ?? readGit(input.worktreePath, ["rev-parse", "HEAD"]);
  const defaultBranch = input.defaultBranch ?? readDefaultBranch(input.worktreePath);
  const openWiki = readOpenWikiSections(input.worktreePath);
  const source = resolveSourceFreshness({
    worktreePath: input.worktreePath,
    generatedAt,
    headSha,
    defaultBranch,
    metadata: readOpenWikiMetadata(input.worktreePath),
    sectionCount: openWiki.sections.length,
    skippedOversizedCount: openWiki.skippedOversizedCount
  });
  return buildRepoWikiPacket({
    repo: { fullName: input.repo, ...(defaultBranch ? { defaultBranch } : {}) },
    source,
    generatedAt,
    budget: {
      maxBytes: input.maxPacketBytes ?? DEFAULT_MAX_PACKET_BYTES,
      ...(input.maxSectionBytes ? { maxSectionBytes: input.maxSectionBytes } : {})
    },
    sections: openWiki.sections
  });
}

function resolveSourceFreshness(input: {
  worktreePath: string;
  generatedAt: string;
  headSha?: string;
  defaultBranch?: string;
  metadata: OpenWikiMetadata | undefined;
  sectionCount: number;
  skippedOversizedCount: number;
}): {
  ref: string;
  headSha?: string;
  checkedAt: string;
  status: RepoWikiSourceStatus;
  staleReason?: string;
} {
  const base = {
    ref: input.defaultBranch ?? "HEAD",
    ...(input.headSha ? { headSha: input.headSha } : {}),
    checkedAt: input.generatedAt
  };
  if (input.sectionCount === 0) {
    return {
      ...base,
      status: input.skippedOversizedCount > 0 ? "stale" : "missing",
      staleReason: input.skippedOversizedCount > 0
        ? "OpenWiki Markdown files exceeded the safe read limit and were omitted."
        : "No OpenWiki Markdown files were found under openwiki/."
    };
  }
  if (input.skippedOversizedCount > 0) {
    return {
      ...base,
      status: "stale",
      staleReason: "Some OpenWiki Markdown files exceeded the safe read limit and were omitted."
    };
  }
  const dirtyStatus = readDirtyWorktreePaths(input.worktreePath);
  if (!dirtyStatus.ok) {
    return {
      ...base,
      status: "stale",
      staleReason: "Unable to read git worktree status; regenerate OpenWiki before building a packet."
    };
  }
  if (dirtyStatus.nonOpenWikiPaths.length > 0) {
    return {
      ...base,
      status: "stale",
      staleReason: "Repository has non-openwiki worktree changes; regenerate OpenWiki before building a packet."
    };
  }
  if (dirtyStatus.openWikiPaths.length > 0) {
    return {
      ...base,
      status: "stale",
      staleReason: "OpenWiki files have uncommitted changes; regenerate OpenWiki before building a fresh packet."
    };
  }
  if (!input.metadata?.gitHead) {
    return {
      ...base,
      status: "stale",
      staleReason: "openwiki/.last-update.json does not record a gitHead."
    };
  }
  if (input.headSha && input.metadata.gitHead === input.headSha) {
    return { ...base, status: "fresh" };
  }
  return {
    ...base,
    status: "stale",
    staleReason: "OpenWiki metadata gitHead does not match the current repository head."
  };
}

function readOpenWikiSections(worktreePath: string): {
  sections: RepoWikiSectionInput[];
  skippedOversizedCount: number;
} {
  const listing = listMarkdownFiles(join(worktreePath, OPENWIKI_DIR), worktreePath);
  return {
    skippedOversizedCount: listing.skippedOversizedCount,
    sections: listing.files.map((sourcePath, index) => {
      const raw = readFileSync(join(worktreePath, sourcePath), "utf8");
      const rawBody = raw.trim();
      const body = redactSensitiveEnvNames(rawBody);
      return {
        id: normalizeSectionId(sourcePath.replace(/^openwiki\//, "").replace(/\.md$/, "")),
        title: readFirstHeading(body.text) ?? sourcePath,
        body: body.text,
        order: readDeclaredSectionOrder(body.text) ?? index,
        sourceFiles: normalizeSourceFiles([sourcePath, ...readSourceMap(body.text)]),
        sourceSha: sha256(rawBody),
        preRedactionReplacementCount: body.replacementCount
      };
    })
  };
}

function listMarkdownFiles(dir: string, worktreePath: string): { files: string[]; skippedOversizedCount: number } {
  try {
    const files: string[] = [];
    let skippedOversizedCount = 0;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const absolutePath = join(dir, entry.name);
      const sourcePath = relative(worktreePath, absolutePath).replace(/\\/g, "/");
      if (sourcePath === "openwiki/_review" || sourcePath.startsWith("openwiki/_review/")) continue;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        const nested = listMarkdownFiles(absolutePath, worktreePath);
        files.push(...nested.files);
        skippedOversizedCount += nested.skippedOversizedCount;
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      if (statSync(absolutePath).size > 256_000) {
        skippedOversizedCount += 1;
        continue;
      }
      files.push(sourcePath);
    }
    return { files: files.sort(codeUnitCompare), skippedOversizedCount };
  } catch {
    return { files: [], skippedOversizedCount: 0 };
  }
}

function readSourceMap(markdown: string): string[] {
  const paths: string[] = [];
  let inSourceMap = false;
  for (const line of markdown.split(/\r?\n/)) {
    if (/^##\s+Source map\s*$/i.test(line.trim())) {
      inSourceMap = true;
      continue;
    }
    if (inSourceMap && /^##\s+/.test(line.trim())) break;
    if (!inSourceMap) continue;
    const match = line.match(/^\s*-\s+(.+)$/);
    if (!match) continue;
    const item = match[1]?.trim() ?? "";
    if (/^Git evidence:/i.test(item)) continue;
    for (const candidate of item.split(/,\s*/)) {
      const cleaned = candidate.replace(/[`"'<>]/g, "").replace(/[),.;:]+$/g, "").trim();
      if (isLikelyRepoPath(cleaned)) paths.push(cleaned);
    }
  }
  return normalizeSourceFiles(paths);
}

function readOpenWikiMetadata(worktreePath: string): OpenWikiMetadata | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(worktreePath, OPENWIKI_METADATA_PATH), "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return undefined;
    const gitHead = (parsed as { gitHead?: unknown }).gitHead;
    return typeof gitHead === "string" ? { gitHead } : {};
  } catch {
    return undefined;
  }
}

function readDirtyWorktreePaths(worktreePath: string): {
  ok: boolean;
  nonOpenWikiPaths: string[];
  openWikiPaths: string[];
} {
  const status = readGitResult(worktreePath, ["status", "--porcelain=v1", "-z"]);
  if (!status.ok) return { ok: false, nonOpenWikiPaths: [], openWikiPaths: [] };
  const paths = parsePorcelainStatusPaths(status.stdout)
    .filter(Boolean)
    .filter((changedPath) => changedPath !== ".neondiff" && !changedPath.startsWith(".neondiff/"));
  return {
    ok: true,
    nonOpenWikiPaths: paths.filter((changedPath) => changedPath !== OPENWIKI_DIR && !changedPath.startsWith(`${OPENWIKI_DIR}/`)),
    openWikiPaths: paths.filter((changedPath) => changedPath === OPENWIKI_DIR || changedPath.startsWith(`${OPENWIKI_DIR}/`))
  };
}

function parsePorcelainStatusPaths(status: string): string[] {
  const paths: string[] = [];
  const records = status.split("\0").filter(Boolean);
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] ?? "";
    const statusCode = record.slice(0, 2);
    const changedPath = record.slice(3);
    if (changedPath) paths.push(changedPath);
    if (/[RC]/.test(statusCode) && records[index + 1]) {
      index += 1;
      paths.push(records[index] ?? "");
    }
  }
  return paths;
}

function readDefaultBranch(worktreePath: string): string | undefined {
  const originHead = readGit(worktreePath, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  if (originHead.startsWith("origin/")) return originHead.slice("origin/".length);
  return readGit(worktreePath, ["branch", "--show-current"]) || undefined;
}

function readGit(worktreePath: string, args: string[]): string {
  const result = readGitResult(worktreePath, args);
  return result.ok ? result.stdout.trim() : "";
}

function readGitResult(worktreePath: string, args: string[]): { ok: boolean; stdout: string } {
  const result = spawnSync("git", args, {
    cwd: worktreePath,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    timeout: GIT_COMMAND_TIMEOUT_MS
  });
  if (result.error || result.status !== 0) return { ok: false, stdout: result.stdout ?? "" };
  return { ok: true, stdout: result.stdout ?? "" };
}

function readFirstHeading(markdown: string): string | undefined {
  return markdown
    .split(/\r?\n/)
    .find((line) => /^#\s+\S/.test(line))
    ?.replace(/^#\s+/, "")
    .trim();
}

function redactSensitiveEnvNames(input: string): { text: string; replacementCount: number } {
  let replacementCount = 0;
  const withAssignmentsRedacted = input.replace(ENV_ASSIGNMENT_PATTERN, (match, envName: string) => {
    if (!isSensitiveEnvName(envName)) return match;
    replacementCount += 1;
    return "[redacted-secret]";
  });
  const text = withAssignmentsRedacted.replace(ENV_NAME_TOKEN_PATTERN, (match) => {
    if (!isSensitiveEnvName(match)) return match;
    replacementCount += 1;
    return "[redacted-secret]";
  });
  return {
    text,
    replacementCount
  };
}

function isSensitiveEnvName(name: string): boolean {
  if (name.length > 80) return false;
  if (SENSITIVE_CAMEL_SUFFIXES.some((suffix) => name === lowerFirst(suffix) || name.endsWith(suffix))) {
    return true;
  }
  const parts = name.toLowerCase().replace(/-/g, "_").split("_").filter(Boolean);
  if (parts.length < 2) return false;
  if (SENSITIVE_PAIR_SUFFIXES.has(parts.slice(-2).join("_"))) return true;
  return parts.some((part) => SENSITIVE_SEGMENTS.has(part));
}

function lowerFirst(input: string): string {
  return `${input.slice(0, 1).toLowerCase()}${input.slice(1)}`;
}

function readDeclaredSectionOrder(markdown: string): number | undefined {
  const normalized = markdown.replace(/\r\n?/g, "\n");
  const frontMatter = normalized.match(/^---\n([\s\S]*?)\n---/);
  const orderLine = frontMatter?.[1]?.match(/^order:\s*(-?\d+)\s*$/m) ?? normalized.match(/<!--\s*openwiki-order:\s*(-?\d+)\s*-->/i);
  if (!orderLine?.[1]) return undefined;
  const order = Number(orderLine[1]);
  return Number.isSafeInteger(order) ? order : undefined;
}

function normalizeSourceFiles(files: string[]): string[] {
  return [...new Set(files.map((file) => file.trim()).filter(Boolean))].sort(codeUnitCompare);
}

function normalizeSectionId(input: string): string {
  const normalized = input.trim().toLowerCase().replace(/[^a-z0-9.-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || "section";
}

function isLikelyRepoPath(value: string): boolean {
  if (!value || /\s/.test(value)) return false;
  if (/^[a-f0-9]{7,40}$/i.test(value)) return false;
  if (/^[a-z]+:\/\//i.test(value)) return false;
  if (/^v?\d+(?:\.\d+)+(?:[-+][A-Za-z0-9.-]+)?$/i.test(value)) return false;
  if (value.includes("/")) return true;
  return REPO_PATH_EXTENSION_PATTERN.test(value);
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function codeUnitCompare(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
