import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { containsSecretLikeText, redactSecrets } from "./secrets.js";

export const REPO_MEMORY_PACKET_VERSION = "repo-memory-packet-v0.1";
export const REPO_MEMORY_ADVISORY_LINE =
  "This memory is advisory. Current PR diff and current repository files override memory.";

export type RepoMemoryNoteKind =
  | "policy_note"
  | "machine_fact"
  | "false_positive"
  | "review_outcome"
  | "proof_preference";

export interface RepoMemoryNote {
  noteId: string;
  repo: string;
  kind: RepoMemoryNoteKind;
  title: string;
  body: string;
  source: string;
  confidence?: number;
  fingerprint?: string;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
}

export interface RepoMemoryPacketSource {
  id: string;
  type: "human" | "sqlite_note";
  sha256: string;
  stale: boolean;
}

export interface RepoMemoryPacket {
  repo: string;
  packetVersion: string;
  generatedAt: string;
  sha256: string;
  byteEstimate: number;
  tokenEstimate: number;
  advisory: string;
  sources: RepoMemoryPacketSource[];
  markdown: string;
  redactionReportSha256: string;
}

export interface RepoMemoryExcludedSource {
  id: string;
  reason: "stale" | "false_positive_fingerprint_mismatch" | "empty" | "budget_exceeded";
}

export interface RepoMemoryRedactionReport {
  ok: boolean;
  blockedSources: Array<{
    id: string;
    redactedPreview: string;
  }>;
  checkedSources: number;
}

export type RepoMemoryBuildResult =
  | {
      ok: true;
      packet: RepoMemoryPacket;
      excluded: RepoMemoryExcludedSource[];
      redactionReport: RepoMemoryRedactionReport;
    }
  | {
      ok: false;
      error: string;
      excluded: RepoMemoryExcludedSource[];
      redactionReport: RepoMemoryRedactionReport;
    };

export interface BuildRepoMemoryPacketInput {
  repo: string;
  humanMarkdown?: string;
  stateNotes: RepoMemoryNote[];
  findingFingerprints?: string[];
  generatedAt?: string;
  packetVersion?: string;
  maxPacketBytes: number;
  includeStaleNotes?: boolean;
}

interface IncludedNote {
  note: RepoMemoryNote;
  stale: boolean;
}

export function readRepoMemoryMarkdown(memoryRoot: string, repo: string): string | undefined {
  const [owner, name] = parseRepoName(repo);
  const memoryPath = join(memoryRoot, owner, name, "repo-memory.md");
  return existsSync(memoryPath) ? readFileSync(memoryPath, "utf8") : undefined;
}

export function buildRepoMemoryPacket(input: BuildRepoMemoryPacketInput): RepoMemoryBuildResult {
  parseRepoName(input.repo);
  if (!Number.isInteger(input.maxPacketBytes) || input.maxPacketBytes < 1) {
    throw new Error("maxPacketBytes must be a positive integer");
  }

  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const generatedAtMs = Date.parse(generatedAt);
  if (!Number.isFinite(generatedAtMs)) throw new Error("generatedAt must be an ISO timestamp");
  const packetVersion = input.packetVersion ?? REPO_MEMORY_PACKET_VERSION;
  const fingerprintSet = new Set(input.findingFingerprints ?? []);
  const excluded: RepoMemoryExcludedSource[] = [];
  const rawSources = collectRawSources(input.humanMarkdown, input.stateNotes);
  const redactionReport = buildRedactionReport(rawSources);
  if (!redactionReport.ok) {
    return {
      ok: false,
      error: "Repo memory packet blocked: secret-like text detected in memory source.",
      excluded,
      redactionReport
    };
  }

  const humanMarkdown = normalizeBlock(input.humanMarkdown);
  if (input.humanMarkdown !== undefined && !humanMarkdown) {
    excluded.push({ id: "human:repo-memory.md", reason: "empty" });
  }
  const includedNotes: IncludedNote[] = [];
  for (const note of [...input.stateNotes].sort(compareNotes)) {
    const stale = isNoteStale(note, generatedAtMs);
    if (stale && input.includeStaleNotes !== true) {
      excluded.push({ id: note.noteId, reason: "stale" });
      continue;
    }
    if (note.kind === "false_positive" && (!note.fingerprint || !fingerprintSet.has(note.fingerprint))) {
      excluded.push({ id: note.noteId, reason: "false_positive_fingerprint_mismatch" });
      continue;
    }
    includedNotes.push({ note, stale });
  }

  const sources = buildSources(humanMarkdown, includedNotes);
  const markdown = renderPacketMarkdown({
    repo: input.repo,
    generatedAt,
    packetVersion,
    humanMarkdown,
    includedNotes
  });
  const postRenderRedaction = buildRedactionReport([{ id: "packet:markdown", text: markdown }]);
  if (!postRenderRedaction.ok) {
    return {
      ok: false,
      error: "Repo memory packet blocked: secret-like text survived packet rendering.",
      excluded,
      redactionReport: mergeRedactionReports(redactionReport, postRenderRedaction)
    };
  }
  const byteEstimate = Buffer.byteLength(markdown, "utf8");
  if (byteEstimate > input.maxPacketBytes) {
    return {
      ok: false,
      error: `Repo memory packet exceeded maxPacketBytes (${byteEstimate} > ${input.maxPacketBytes}).`,
      excluded: [...excluded, { id: "packet:markdown", reason: "budget_exceeded" }],
      redactionReport
    };
  }

  const redactionReportSha256 = sha256(JSON.stringify(redactionReport));
  const packet: RepoMemoryPacket = {
    repo: input.repo,
    packetVersion,
    generatedAt,
    sha256: sha256(markdown),
    byteEstimate,
    tokenEstimate: Math.max(1, Math.ceil(byteEstimate / 4)),
    advisory: REPO_MEMORY_ADVISORY_LINE,
    sources,
    markdown,
    redactionReportSha256
  };
  return { ok: true, packet, excluded, redactionReport };
}

export function formatRepoMemoryPacketMarkdown(packet: RepoMemoryPacket): string {
  return packet.markdown;
}

function renderPacketMarkdown(input: {
  repo: string;
  generatedAt: string;
  packetVersion: string;
  humanMarkdown?: string;
  includedNotes: IncludedNote[];
}): string {
  const parts = [
    "# Durable repo memory packet",
    "",
    `Repository: ${input.repo}`,
    `Packet version: ${input.packetVersion}`,
    `Generated at: ${input.generatedAt}`,
    "",
    REPO_MEMORY_ADVISORY_LINE
  ];

  if (input.humanMarkdown) {
    parts.push("", "## Human repo-memory.md", "", input.humanMarkdown);
  }

  if (input.includedNotes.length) {
    parts.push("", "## SQLite memory notes");
    for (const { note, stale } of input.includedNotes) {
      const metadata = [
        `id=${note.noteId}`,
        `kind=${note.kind}`,
        `source=${note.source}`,
        `confidence=${note.confidence ?? "unknown"}`,
        `updated_at=${note.updatedAt}`,
        stale ? "stale=true" : undefined,
        note.fingerprint ? `fingerprint=${note.fingerprint}` : undefined
      ].filter(Boolean);
      parts.push("", `### ${note.title}`, "", metadata.join("; "), "", note.body);
    }
  }

  return `${parts.join("\n").trim()}\n`;
}

function buildSources(humanMarkdown: string | undefined, includedNotes: IncludedNote[]): RepoMemoryPacketSource[] {
  const sources: RepoMemoryPacketSource[] = [];
  if (humanMarkdown) {
    sources.push({
      id: "human:repo-memory.md",
      type: "human",
      sha256: sha256(humanMarkdown),
      stale: false
    });
  }
  for (const { note, stale } of includedNotes) {
    sources.push({
      id: note.noteId,
      type: "sqlite_note",
      sha256: sha256(`${note.kind}\n${note.title}\n${note.body}\n${note.source}\n${note.fingerprint ?? ""}`),
      stale
    });
  }
  return sources;
}

function collectRawSources(humanMarkdown: string | undefined, notes: RepoMemoryNote[]): Array<{ id: string; text: string }> {
  return [
    ...(humanMarkdown !== undefined ? [{ id: "human:repo-memory.md", text: humanMarkdown }] : []),
    ...notes.map((note) => ({
      id: note.noteId,
      text: [note.noteId, note.title, note.body, note.source, note.fingerprint ?? ""].join("\n")
    }))
  ];
}

function buildRedactionReport(sources: Array<{ id: string; text: string }>): RepoMemoryRedactionReport {
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
  first: RepoMemoryRedactionReport,
  second: RepoMemoryRedactionReport
): RepoMemoryRedactionReport {
  return {
    ok: first.ok && second.ok,
    blockedSources: [...first.blockedSources, ...second.blockedSources],
    checkedSources: first.checkedSources + second.checkedSources
  };
}

function compareNotes(left: RepoMemoryNote, right: RepoMemoryNote): number {
  const leftPriority = notePriority(left.kind);
  const rightPriority = notePriority(right.kind);
  if (leftPriority !== rightPriority) return leftPriority - rightPriority;
  const leftUpdated = Date.parse(left.updatedAt);
  const rightUpdated = Date.parse(right.updatedAt);
  if (leftUpdated !== rightUpdated) return leftUpdated - rightUpdated;
  return left.noteId.localeCompare(right.noteId);
}

function notePriority(kind: RepoMemoryNoteKind): number {
  switch (kind) {
    case "policy_note":
      return 0;
    case "proof_preference":
      return 1;
    case "false_positive":
      return 2;
    case "machine_fact":
      return 3;
    case "review_outcome":
      return 4;
  }
}

function isNoteStale(note: RepoMemoryNote, generatedAtMs: number): boolean {
  if (!note.expiresAt) return false;
  const expiresAtMs = Date.parse(note.expiresAt);
  return !Number.isFinite(expiresAtMs) || expiresAtMs <= generatedAtMs;
}

function normalizeBlock(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parseRepoName(repo: string): [string, string] {
  const [owner, name, extra] = repo.split("/");
  if (extra !== undefined || !owner || !name) throw new Error("repo must be an owner/repo name");
  if (
    owner === "." ||
    owner === ".." ||
    name === "." ||
    name === ".." ||
    !/^[A-Za-z0-9_.-]+$/.test(owner) ||
    !/^[A-Za-z0-9_.-]+$/.test(name)
  ) {
    throw new Error("repo must be an owner/repo name");
  }
  return [owner, name];
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
