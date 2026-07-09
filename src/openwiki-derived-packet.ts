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
const SENSITIVE_ENV_NAME_PATTERN =
  /\b[A-Z][A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD|COOKIE|SESSION|PRIVATE_KEY)[A-Z0-9_]*\b/g;

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
  const sections = readOpenWikiSections(input.worktreePath);
  const source = resolveSourceFreshness({
    worktreePath: input.worktreePath,
    generatedAt,
    headSha,
    defaultBranch,
    metadata: readOpenWikiMetadata(input.worktreePath),
    sectionCount: sections.length
  });
  return buildRepoWikiPacket({
    repo: { fullName: input.repo, ...(defaultBranch ? { defaultBranch } : {}) },
    source,
    generatedAt,
    budget: {
      maxBytes: input.maxPacketBytes ?? DEFAULT_MAX_PACKET_BYTES,
      ...(input.maxSectionBytes ? { maxSectionBytes: input.maxSectionBytes } : {})
    },
    sections
  });
}

function resolveSourceFreshness(input: {
  worktreePath: string;
  generatedAt: string;
  headSha?: string;
  defaultBranch?: string;
  metadata: OpenWikiMetadata | undefined;
  sectionCount: number;
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
      status: "missing",
      staleReason: "No OpenWiki Markdown files were found under openwiki/."
    };
  }
  if (readDirtyNonOpenWikiPaths(input.worktreePath).length > 0) {
    return {
      ...base,
      status: "stale",
      staleReason: "Repository has non-openwiki worktree changes; regenerate OpenWiki before building a packet."
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

function readOpenWikiSections(worktreePath: string): RepoWikiSectionInput[] {
  return listMarkdownFiles(join(worktreePath, OPENWIKI_DIR), worktreePath).map((sourcePath, index) => {
    const raw = readFileSync(join(worktreePath, sourcePath), "utf8");
    const body = redactSensitiveEnvNames(raw.trim());
    return {
      id: normalizeSectionId(sourcePath.replace(/^openwiki\//, "").replace(/\.md$/, "")),
      title: readFirstHeading(body) ?? sourcePath,
      body,
      order: index,
      sourceFiles: normalizeSourceFiles([sourcePath, ...readSourceMap(body)]),
      sourceSha: sha256(raw)
    };
  });
}

function listMarkdownFiles(dir: string, worktreePath: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      if (entry.name.startsWith(".")) return [];
      const absolutePath = join(dir, entry.name);
      const sourcePath = relative(worktreePath, absolutePath).replace(/\\/g, "/");
      if (sourcePath === "openwiki/_review" || sourcePath.startsWith("openwiki/_review/")) return [];
      if (entry.isSymbolicLink()) return [];
      if (entry.isDirectory()) return listMarkdownFiles(absolutePath, worktreePath);
      if (!entry.isFile() || !entry.name.endsWith(".md")) return [];
      if (statSync(absolutePath).size > 256_000) return [];
      return [sourcePath];
    }).sort(codeUnitCompare);
  } catch {
    return [];
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
      const cleaned = candidate.replace(/[`"'<>]/g, "").trim();
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

function readDirtyNonOpenWikiPaths(worktreePath: string): string[] {
  const status = readGit(worktreePath, ["status", "--porcelain"]);
  return status
    .split(/\r?\n/)
    .map((line) => line.slice(3).trim())
    .filter(Boolean)
    .filter((changedPath) => changedPath !== OPENWIKI_DIR && !changedPath.startsWith(`${OPENWIKI_DIR}/`));
}

function readDefaultBranch(worktreePath: string): string | undefined {
  const originHead = readGit(worktreePath, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  if (originHead.startsWith("origin/")) return originHead.slice("origin/".length);
  return readGit(worktreePath, ["branch", "--show-current"]) || undefined;
}

function readGit(worktreePath: string, args: string[]): string {
  const result = spawnSync("git", args, {
    cwd: worktreePath,
    encoding: "utf8"
  });
  return result.status === 0 ? result.stdout.trim() : "";
}

function readFirstHeading(markdown: string): string | undefined {
  return markdown
    .split(/\r?\n/)
    .find((line) => /^#\s+\S/.test(line))
    ?.replace(/^#\s+/, "")
    .trim();
}

function redactSensitiveEnvNames(input: string): string {
  return input.replace(SENSITIVE_ENV_NAME_PATTERN, "[redacted-secret]");
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
  return value.includes("/") || value.includes(".");
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function codeUnitCompare(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
