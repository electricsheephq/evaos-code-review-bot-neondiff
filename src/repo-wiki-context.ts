import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { formatRepoWikiPacketMarkdown, type RepoWikiPacket, type RepoWikiSourceStatus } from "./repo-wiki-packet.js";
import { containsSecretLikeText, redactSecrets } from "./secrets.js";

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
}): RepoWikiContextBuildResult {
  if (!input.config.enabled) {
    return {
      omitted: {
        reason: "disabled",
        detail: "repoWikiContext.enabled is false"
      }
    };
  }

  const sourcePath = resolvePacketPath(input.worktreePath, input.config.packetPath);
  const evidenceSourcePath = formatPacketPathForEvidence(input.config.packetPath);
  if (!existsSync(sourcePath)) {
    return {
      omitted: {
        reason: "missing_packet",
        detail: "Repo wiki packet not found",
        sourcePath: evidenceSourcePath
      }
    };
  }

  const raw = readFileSync(sourcePath, "utf8");
  if (containsSecretLikeText(raw)) {
    return {
      omitted: {
        reason: "secret_detected",
        detail: "Repo wiki packet contains secret-like text",
        sourcePath: evidenceSourcePath
      }
    };
  }

  const parsed = parseRepoWikiContextRaw(raw, evidenceSourcePath);
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

function resolvePacketPath(worktreePath: string, packetPath: string): string {
  return isAbsolute(packetPath) ? packetPath : resolve(worktreePath, packetPath);
}

function formatPacketPathForEvidence(packetPath: string): string {
  return isAbsolute(packetPath) ? "[absolute-packet-path]" : packetPath;
}

function parseRepoWikiContextRaw(
  raw: string,
  sourcePath: string
): { ok: true; packet: RepoWikiContextPacket } | { ok: false; error: string } {
  const trimmed = raw.trimStart();
  if (!trimmed) return { ok: false, error: "Repo wiki packet is empty" };
  if (!trimmed.startsWith("{")) return packetFromMarkdown(raw);

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return { ok: false, error: "Repo wiki packet JSON must be an object" };
    if (typeof parsed.markdown === "string") return packetFromGenericJson(parsed);
    if (looksLikeRepoWikiPacket(parsed)) return packetFromRepoWikiPacket(parsed);
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
  const freshness =
    readFreshness(parsed.freshness) ?? readFreshness(readNested(parsed, "repoWiki", "freshness")) ?? "unknown";
  const explicitDegradedMode =
    typeof readNested(parsed, "repoWiki", "degradedMode") === "boolean"
      ? Boolean(readNested(parsed, "repoWiki", "degradedMode"))
      : false;
  const degradedMode = explicitDegradedMode || freshness !== "fresh";

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

function packetFromRepoWikiPacket(packet: RepoWikiPacket): {
  ok: true;
  packet: RepoWikiContextPacket;
} {
  const markdown = formatRepoWikiPacketMarkdown(packet);
  const byteEstimate = Buffer.byteLength(markdown, "utf8");
  return {
    ok: true,
    packet: {
      sha256: sha256(markdown),
      byteEstimate,
      tokenEstimate: Math.max(1, Math.ceil(byteEstimate / 4)),
      markdown,
      repoWiki: {
        freshness: packet.source.status,
        degradedMode: packet.degraded,
        ...(packet.source.staleReason ? { degradedReason: packet.source.staleReason } : {}),
        packetVersion: packet.packetVersion
      }
    }
  };
}

function looksLikeRepoWikiPacket(input: unknown): input is RepoWikiPacket {
  if (!isRecord(input)) return false;
  return (
    isRecord(input.repo) &&
    isRecord(input.source) &&
    typeof input.source.status === "string" &&
    Array.isArray(input.includedSections) &&
    typeof input.packetSha === "string"
  );
}

function readFreshness(value: unknown): RepoWikiSourceStatus | "unknown" | undefined {
  return value === "fresh" || value === "stale" || value === "missing" || value === "unknown" ? value : undefined;
}

function readNested(input: Record<string, unknown>, objectKey: string, valueKey: string): unknown {
  const nested = input[objectKey];
  return isRecord(nested) ? nested[valueKey] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
