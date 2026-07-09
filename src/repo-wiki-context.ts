import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import {
  formatRepoWikiPacketMarkdown,
  REPO_WIKI_PACKET_VERSION,
  type RepoWikiPacket,
  type RepoWikiSourceStatus
} from "./repo-wiki-packet.js";
import { containsSecretLikeText, redactSecrets } from "./secrets.js";

const PACKET_FILE_OVERHEAD_BYTES = 64_000;
const MAX_PACKET_FILE_READ_BYTES = 1_000_000;

export interface RepoWikiContextConfig {
  enabled: boolean;
  packetPath: string;
  maxPacketBytes: number;
  includeStaleContext: boolean;
}

export interface RepoWikiContextPacket {
  sha256: string;
  byteEstimate: number;
  tokenEstimate: number;
  markdown: string;
  repoWiki: {
    freshness: RepoWikiSourceStatus | "unknown";
    degradedMode: boolean;
    degradedReason?: string;
    sourcePath?: string;
    packetVersion?: string;
  };
}

export type RepoWikiContextOmittedReason =
  "disabled" | "missing_packet" | "stale_packet" | "budget_exceeded" | "secret_detected" | "invalid_packet";

export type RepoWikiContextBuildResult =
  | { packet: RepoWikiContextPacket; omitted?: never }
  | {
      packet?: never;
      omitted: {
        reason: RepoWikiContextOmittedReason;
        detail: string;
        sourcePath?: string;
      };
    };

export function buildRepoWikiContextPacket(input: {
  repo: string;
  worktreePath: string;
  config: RepoWikiContextConfig;
  expectedHeadSha?: string;
}): RepoWikiContextBuildResult {
  if (!input.config.enabled) {
    return {
      omitted: {
        reason: "disabled",
        detail: "repoWikiContext.enabled is false"
      }
    };
  }

  const evidenceSourcePath = formatPacketPathForEvidence(input.config.packetPath);
  const packetPathError = validateRelativePacketPath(input.config.packetPath);
  if (packetPathError) {
    return {
      omitted: {
        reason: "invalid_packet",
        detail: packetPathError,
        sourcePath: evidenceSourcePath
      }
    };
  }

  const sourcePath = resolvePacketPath(input.worktreePath, input.config.packetPath);
  let sourceRealPath: string | undefined;
  try {
    sourceRealPath = resolveExistingPathInsideOrEqual(sourcePath, input.worktreePath);
  } catch (error) {
    if (isMissingPathError(error)) {
      return {
        omitted: {
          reason: "missing_packet",
          detail: "Repo wiki packet not found",
          sourcePath: evidenceSourcePath
        }
      };
    }
    throw error;
  }

  if (!sourceRealPath) {
    return {
      omitted: {
        reason: "invalid_packet",
        detail: "Repo wiki packet path resolved outside the prepared PR worktree",
        sourcePath: evidenceSourcePath
      }
    };
  }

  const maxPacketFileBytes = Math.min(
    input.config.maxPacketBytes + PACKET_FILE_OVERHEAD_BYTES,
    MAX_PACKET_FILE_READ_BYTES
  );
  const packetFile = readBoundedPacketFile(sourceRealPath, evidenceSourcePath, maxPacketFileBytes);
  if (!packetFile.ok) return packetFile.result;
  const raw = packetFile.raw;

  if (containsSecretLikeText(raw)) {
    return {
      omitted: {
        reason: "secret_detected",
        detail: "Repo wiki packet contains secret-like text",
        sourcePath: evidenceSourcePath
      }
    };
  }

  const parsed = parseRepoWikiContextRaw(raw, evidenceSourcePath, input.expectedHeadSha);
  if (!parsed.ok) {
    return {
      omitted: { reason: "invalid_packet", detail: parsed.error, sourcePath: evidenceSourcePath }
    };
  }

  const byteEstimate = Buffer.byteLength(parsed.packet.markdown, "utf8");

  if (containsSecretLikeText(parsed.packet.markdown)) {
    return {
      omitted: {
        reason: "secret_detected",
        detail: "Rendered repo wiki packet contains secret-like text",
        sourcePath: evidenceSourcePath
      }
    };
  }

  const freshness = parsed.packet.repoWiki.freshness;
  if (freshness !== "fresh" && !input.config.includeStaleContext) {
    return {
      omitted: {
        reason: "stale_packet",
        detail: "Repo wiki packet freshness is not fresh and includeStaleContext is false",
        sourcePath: evidenceSourcePath
      }
    };
  }

  if (byteEstimate > input.config.maxPacketBytes) {
    return {
      omitted: {
        reason: "budget_exceeded",
        detail: `Repo wiki packet exceeded maxPacketBytes (${byteEstimate} > ${input.config.maxPacketBytes})`,
        sourcePath: evidenceSourcePath
      }
    };
  }

  return {
    packet: {
      ...parsed.packet,
      byteEstimate,
      tokenEstimate: Math.max(1, Math.ceil(byteEstimate / 4)),
      repoWiki: {
        ...parsed.packet.repoWiki,
        sourcePath: evidenceSourcePath
      }
    }
  };
}

function readBoundedPacketFile(
  sourceRealPath: string,
  evidenceSourcePath: string,
  maxPacketFileBytes: number
): { ok: true; raw: string } | { ok: false; result: RepoWikiContextBuildResult } {
  let fd: number | undefined;
  try {
    fd = openSync(sourceRealPath, "r");
    const sourceStats = fstatSync(fd);
    if (!sourceStats.isFile()) {
      return {
        ok: false,
        result: {
          omitted: {
            reason: "invalid_packet",
            detail: "Repo wiki packet path did not resolve to a file",
            sourcePath: evidenceSourcePath
          }
        }
      };
    }
    if (sourceStats.size > maxPacketFileBytes) {
      return {
        ok: false,
        result: {
          omitted: {
            reason: "budget_exceeded",
            detail: `Repo wiki packet file exceeded safe read limit (${sourceStats.size} > ${maxPacketFileBytes})`,
            sourcePath: evidenceSourcePath
          }
        }
      };
    }
    const raw = readFileSync(fd, "utf8");
    const rawPacketFileBytes = Buffer.byteLength(raw, "utf8");
    if (rawPacketFileBytes > maxPacketFileBytes) {
      return {
        ok: false,
        result: {
          omitted: {
            reason: "budget_exceeded",
            detail: `Repo wiki packet file exceeded safe read limit (${rawPacketFileBytes} > ${maxPacketFileBytes})`,
            sourcePath: evidenceSourcePath
          }
        }
      };
    }
    return { ok: true, raw };
  } catch (error) {
    if (isMissingPathError(error)) {
      return {
        ok: false,
        result: {
          omitted: {
            reason: "missing_packet",
            detail: "Repo wiki packet not found",
            sourcePath: evidenceSourcePath
          }
        }
      };
    }
    return {
      ok: false,
      result: {
        omitted: {
          reason: "invalid_packet",
          detail: "Repo wiki packet could not be read",
          sourcePath: evidenceSourcePath
        }
      }
    };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function resolvePacketPath(worktreePath: string, packetPath: string): string {
  return resolve(worktreePath, packetPath);
}

function formatPacketPathForEvidence(packetPath: string): string {
  return validateRelativePacketPath(packetPath) ? "[invalid-packet-path]" : packetPath;
}

export function validateRelativePacketPath(packetPath: string): string | undefined {
  const trimmed = packetPath.trim();
  if (!trimmed) return "Repo wiki packetPath must be a non-empty relative path";
  if (isAbsoluteLike(trimmed)) return "Repo wiki packetPath must be relative to the prepared PR worktree";
  if (trimmed.split(/[\\/]+/).includes("..")) {
    return "Repo wiki packetPath must not contain parent-directory segments";
  }
  return undefined;
}

function isAbsoluteLike(packetPath: string): boolean {
  return isAbsolute(packetPath) || /^[A-Za-z]:[\\/]/.test(packetPath) || packetPath.startsWith("\\\\");
}

function resolveExistingPathInsideOrEqual(candidatePath: string, rootPath: string): string | undefined {
  const rootRealPath = realpathSync.native(rootPath);
  const candidateRealPath = realpathSync.native(candidatePath);
  const rel = relative(rootRealPath, candidateRealPath);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)) ? candidateRealPath : undefined;
}

function isMissingPathError(error: unknown): boolean {
  return isNodeError(error) && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function parseRepoWikiContextRaw(
  raw: string,
  sourcePath: string,
  expectedHeadSha?: string
): { ok: true; packet: RepoWikiContextPacket } | { ok: false; error: string } {
  const trimmed = raw.trimStart();
  if (!trimmed) return { ok: false, error: "Repo wiki packet is empty" };
  if (!trimmed.startsWith("{")) return packetFromMarkdown(raw);

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return { ok: false, error: "Repo wiki packet JSON must be an object" };
    if (typeof parsed.markdown === "string") return packetFromGenericJson(parsed);
    const repoWikiPacketError = validateRepoWikiPacketShape(parsed);
    if (!repoWikiPacketError && isRepoWikiPacketShape(parsed)) {
      return packetFromRepoWikiPacket(parsed, expectedHeadSha);
    }
    if (looksLikeRepoWikiPacketEnvelope(parsed)) {
      return {
        ok: false,
        error: `Invalid repo wiki packet shape at ${redactSecrets(sourcePath)}: ${repoWikiPacketError}`
      };
    }
    return {
      ok: false,
      error: `Unsupported repo wiki packet shape at ${redactSecrets(sourcePath)}`
    };
  } catch (error) {
    return {
      ok: false,
      error: `Repo wiki packet JSON did not parse: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

function packetFromMarkdown(markdown: string): {
  ok: true;
  packet: RepoWikiContextPacket;
} {
  const byteEstimate = Buffer.byteLength(markdown, "utf8");
  return {
    ok: true,
    packet: {
      sha256: sha256(markdown),
      byteEstimate,
      tokenEstimate: Math.max(1, Math.ceil(byteEstimate / 4)),
      markdown,
      repoWiki: {
        freshness: "unknown",
        degradedMode: true
      }
    }
  };
}

function packetFromGenericJson(parsed: Record<string, unknown>): {
  ok: true;
  packet: RepoWikiContextPacket;
} {
  const markdown = String(parsed.markdown);
  const byteEstimate = Buffer.byteLength(markdown, "utf8");
  const freshness = "unknown";
  const degradedMode = true;

  return {
    ok: true,
    packet: {
      sha256: sha256(markdown),
      byteEstimate,
      tokenEstimate: Math.max(1, Math.ceil(byteEstimate / 4)),
      markdown,
      repoWiki: {
        freshness,
        degradedMode,
        ...(typeof parsed.packetVersion === "string" ? { packetVersion: parsed.packetVersion } : {})
      }
    }
  };
}

function packetFromRepoWikiPacket(packet: RepoWikiPacket, expectedHeadSha?: string): {
  ok: true;
  packet: RepoWikiContextPacket;
} {
  const packetVersion = readSafePacketVersion(packet.packetVersion);
  const staleReason = readSafeMetadataLine(packet.source.staleReason);
  const safePacket: RepoWikiPacket = {
    ...packet,
    packetVersion: packetVersion ?? REPO_WIKI_PACKET_VERSION,
    source: {
      ...packet.source,
      ...(staleReason ? { staleReason } : {})
    }
  };
  if (!staleReason) delete safePacket.source.staleReason;
  const markdown = formatRepoWikiPacketMarkdown(safePacket);
  const byteEstimate = Buffer.byteLength(markdown, "utf8");
  const sourceStatus = readFreshness(safePacket.source.status) ?? "unknown";
  const sourceHeadMatches = headShaMatches(safePacket.source.headSha, expectedHeadSha);
  const freshness = sourceStatus === "fresh" && !sourceHeadMatches ? "unknown" : sourceStatus;
  return {
    ok: true,
    packet: {
      sha256: sha256(markdown),
      byteEstimate,
      tokenEstimate: Math.max(1, Math.ceil(byteEstimate / 4)),
      markdown,
      repoWiki: {
        freshness,
        degradedMode: safePacket.degraded || freshness !== "fresh",
        ...(staleReason ? { degradedReason: staleReason } : {}),
        ...(packetVersion ? { packetVersion } : {})
      }
    }
  };
}

function headShaMatches(packetHeadSha: string | undefined, expectedHeadSha: string | undefined): boolean {
  const packetSha = packetHeadSha?.trim().toLowerCase();
  const expectedSha = expectedHeadSha?.trim().toLowerCase();
  if (!packetSha || !expectedSha) return false;
  const gitSha = /^[a-f0-9]{8,40}$/;
  if (!gitSha.test(packetSha) || !gitSha.test(expectedSha)) return packetSha === expectedSha;
  return packetSha.startsWith(expectedSha) || expectedSha.startsWith(packetSha);
}

function looksLikeRepoWikiPacketEnvelope(input: unknown): boolean {
  if (!isRecord(input)) return false;
  return (
    isRecord(input.repo) &&
    isRecord(input.source) &&
    typeof input.source.status === "string" &&
    Array.isArray(input.includedSections) &&
    typeof input.packetSha === "string"
  );
}

function validateRepoWikiPacketShape(input: unknown): string | undefined {
  if (!isRecord(input)) return "Repo wiki packet JSON must be an object";
  if (!looksLikeRepoWikiPacketEnvelope(input)) return "missing repo/source/sections/packetSha envelope";
  if (!isRecord(input.repo) || typeof input.repo.fullName !== "string") return "repo.fullName must be a string";
  if (!isRecord(input.source)) return "source must be an object";
  if (typeof input.source.ref !== "string") return "source.ref must be a string";
  if (!readFreshness(input.source.status)) return "source.status must be fresh, stale, missing, or unknown";
  if (typeof input.generatedAt !== "string") return "generatedAt must be a string";
  if (typeof input.advisory !== "string") return "advisory must be a string";
  if (typeof input.degraded !== "boolean") return "degraded must be a boolean";
  if (!isBudget(input.byteBudget)) return "byteBudget must include numeric maxBytes and usedBytes";
  if (!isTokenBudget(input.tokenBudget)) return "tokenBudget must include numeric maxTokens and usedTokens";
  if (!isRecord(input.redaction)) return "redaction must be an object";
  if (input.redaction.status !== "passed" && input.redaction.status !== "redacted") {
    return "redaction.status must be passed or redacted";
  }
  if (typeof input.redaction.replacementCount !== "number") return "redaction.replacementCount must be a number";
  const includedSections = input.includedSections;
  if (!Array.isArray(includedSections)) return "includedSections must be an array";
  if (!Array.isArray(input.excludedSections)) return "excludedSections must be an array";
  if (!Array.isArray(input.includedFiles)) return "includedFiles must be an array";
  for (const section of includedSections) {
    if (!isRenderableIncludedSection(section)) return "includedSections entries must include renderable section fields";
  }
  return undefined;
}

function isRepoWikiPacketShape(input: unknown): input is RepoWikiPacket {
  return validateRepoWikiPacketShape(input) === undefined;
}

function isBudget(value: unknown): value is { maxBytes: number; usedBytes: number } {
  return isRecord(value) && typeof value.maxBytes === "number" && typeof value.usedBytes === "number";
}

function isTokenBudget(value: unknown): value is { maxTokens: number; usedTokens: number } {
  return isRecord(value) && typeof value.maxTokens === "number" && typeof value.usedTokens === "number";
}

function isRenderableIncludedSection(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.title === "string" &&
    typeof value.body === "string" &&
    typeof value.order === "number" &&
    Array.isArray(value.sourceFiles) &&
    value.sourceFiles.every((sourceFile) => typeof sourceFile === "string") &&
    typeof value.byteLength === "number" &&
    typeof value.tokenEstimate === "number" &&
    typeof value.truncated === "boolean" &&
    typeof value.redacted === "boolean"
  );
}

function readSafePacketVersion(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return /^[A-Za-z0-9._-]{1,80}$/.test(trimmed) ? trimmed : undefined;
}

function readSafeMetadataLine(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = redactSecrets(value).replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  return normalized.length > 240 ? `${normalized.slice(0, 237)}...` : normalized;
}

function readFreshness(value: unknown): RepoWikiSourceStatus | "unknown" | undefined {
  return value === "fresh" || value === "stale" || value === "missing" || value === "unknown" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
