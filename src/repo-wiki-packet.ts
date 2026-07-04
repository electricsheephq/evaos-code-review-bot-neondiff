import { createHash } from "node:crypto";
import { redactSecrets } from "./secrets.js";

export const REPO_WIKI_PACKET_VERSION = "repo-wiki-packet-v0.1";
export const REPO_WIKI_ADVISORY_LINE =
  "Repo wiki packet context is advisory. GitHub diff and checkout remain truth.";

export type RepoWikiSourceStatus = "fresh" | "stale" | "missing";

export interface RepoWikiIdentity {
  fullName: string;
  defaultBranch?: string;
  remoteUrl?: string;
}

export interface RepoWikiSourceFreshness {
  ref: string;
  headSha?: string;
  checkedAt?: string;
  status: RepoWikiSourceStatus;
  staleReason?: string;
}

export interface RepoWikiSectionInput {
  id: string;
  title: string;
  body: string;
  order?: number;
  sourceFiles?: string[];
  sourceSha?: string;
}

export interface RepoWikiNormalizedSection {
  id: string;
  title: string;
  body: string;
  order: number;
  sourceFiles: string[];
  sourceSha?: string;
}

export type RepoWikiExcludedSectionReason =
  | "empty"
  | "missing_source"
  | "packet_budget_exceeded";

export interface RepoWikiExcludedSection {
  id: string;
  reason: RepoWikiExcludedSectionReason;
}

export interface RepoWikiIncludedSection {
  id: string;
  title: string;
  body: string;
  order: number;
  sourceFiles: string[];
  sourceSha?: string;
  byteLength: number;
  tokenEstimate: number;
  truncated: boolean;
  redacted: boolean;
}

export interface RepoWikiIncludedFile {
  path: string;
  sections: string[];
}

export interface RepoWikiPacketBudgetInput {
  maxBytes: number;
  maxTokens?: number;
  maxSectionBytes?: number;
}

export interface RepoWikiPacketBudget {
  maxBytes: number;
  usedBytes: number;
}

export interface RepoWikiTokenBudget {
  maxTokens: number;
  usedTokens: number;
}

export interface RepoWikiRedactionResult {
  status: "passed" | "redacted";
  replacementCount: number;
}

export interface RepoWikiPacket {
  packetVersion: string;
  repo: RepoWikiIdentity;
  source: RepoWikiSourceFreshness;
  generatedAt: string;
  advisory: string;
  degraded: boolean;
  byteBudget: RepoWikiPacketBudget;
  tokenBudget: RepoWikiTokenBudget;
  redaction: RepoWikiRedactionResult;
  includedSections: RepoWikiIncludedSection[];
  excludedSections: RepoWikiExcludedSection[];
  includedFiles: RepoWikiIncludedFile[];
  packetSha: string;
}

export interface BuildRepoWikiPacketInput {
  repo: RepoWikiIdentity;
  source: RepoWikiSourceFreshness;
  sections: RepoWikiSectionInput[];
  budget: RepoWikiPacketBudgetInput;
  generatedAt?: string;
  packetVersion?: string;
}

export function normalizeRepoWikiSections(input: RepoWikiSectionInput[]): {
  sections: RepoWikiNormalizedSection[];
  excluded: RepoWikiExcludedSection[];
} {
  const excluded: RepoWikiExcludedSection[] = [];
  const sections = input
    .map((section) => {
      const id = normalizeSectionId(section.id);
      const body = normalizeText(section.body);
      if (!body) {
        excluded.push({ id, reason: "empty" });
        return undefined;
      }
      return {
        id,
        title: normalizeText(section.title) || id,
        body,
        order: Number.isFinite(section.order) ? Number(section.order) : 0,
        sourceFiles: normalizeSourceFiles(section.sourceFiles ?? []),
        ...(section.sourceSha ? { sourceSha: section.sourceSha } : {})
      } satisfies RepoWikiNormalizedSection;
    })
    .filter((section): section is RepoWikiNormalizedSection => section !== undefined)
    .sort(compareSections);

  return { sections, excluded };
}

export function buildRepoWikiPacket(input: BuildRepoWikiPacketInput): RepoWikiPacket {
  assertRepoName(input.repo.fullName);
  assertBudget(input.budget);
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  assertIsoTimestamp(generatedAt, "generatedAt");
  if (input.source.checkedAt) assertIsoTimestamp(input.source.checkedAt, "source.checkedAt");

  const maxBytes = input.budget.maxBytes;
  const maxTokens = input.budget.maxTokens ?? tokenEstimateForBytes(maxBytes);
  const maxSectionBytes = input.budget.maxSectionBytes ?? maxBytes;
  const normalized = normalizeRepoWikiSections(input.sections);
  const excluded = [...normalized.excluded];
  if (input.source.status === "missing" && normalized.sections.length === 0) {
    excluded.push({ id: "packet:sections", reason: "missing_source" });
  }

  const redactionCounter = { count: 0 };
  const includedSections: RepoWikiIncludedSection[] = [];
  for (const section of normalized.sections) {
    const redactedTitle = redactAndCount(section.title, redactionCounter);
    const redactedBody = redactAndCount(section.body, redactionCounter);
    const cappedBody = truncateUtf8Bytes(redactedBody.text, maxSectionBytes);
    const included: RepoWikiIncludedSection = {
      id: section.id,
      title: redactedTitle.text,
      body: cappedBody,
      order: section.order,
      sourceFiles: section.sourceFiles,
      ...(section.sourceSha ? { sourceSha: section.sourceSha } : {}),
      byteLength: Buffer.byteLength(cappedBody, "utf8"),
      tokenEstimate: tokenEstimateForBytes(Buffer.byteLength(cappedBody, "utf8")),
      truncated: cappedBody !== redactedBody.text,
      redacted: redactedTitle.replacementCount + redactedBody.replacementCount > 0
    };
    includedSections.push(included);
  }

  const packetBase = {
    packetVersion: input.packetVersion ?? REPO_WIKI_PACKET_VERSION,
    repo: normalizeRepo(input.repo),
    source: normalizeSource(input.source, redactionCounter),
    generatedAt,
    advisory: REPO_WIKI_ADVISORY_LINE,
    degraded: input.source.status !== "fresh",
    byteBudget: { maxBytes, usedBytes: 0 },
    tokenBudget: { maxTokens, usedTokens: 0 },
    redaction: {
      status: redactionCounter.count > 0 ? "redacted" : "passed",
      replacementCount: redactionCounter.count
    } satisfies RepoWikiRedactionResult
  };

  let acceptedSections = [...includedSections];
  let acceptedExcluded = [...excluded];
  while (acceptedSections.length > 0) {
    const tentative = finalizePacket(packetBase, acceptedSections, acceptedExcluded);
    if (tentative.byteBudget.usedBytes <= maxBytes && tentative.tokenBudget.usedTokens <= maxTokens) {
      return tentative;
    }
    const dropped = acceptedSections.pop();
    if (dropped) acceptedExcluded = [{ id: dropped.id, reason: "packet_budget_exceeded" }, ...acceptedExcluded];
  }

  return finalizePacket(packetBase, acceptedSections, acceptedExcluded);
}

export function formatRepoWikiPacketMarkdown(packet: RepoWikiPacket): string {
  const lines = [
    "# Repo Wiki Packet",
    "",
    `Repository: ${packet.repo.fullName}`,
    packet.repo.defaultBranch ? `Default branch: ${packet.repo.defaultBranch}` : undefined,
    `Source ref: ${packet.source.ref}`,
    packet.source.headSha ? `Source head: ${packet.source.headSha}` : undefined,
    `Source status: ${packet.source.status}`,
    packet.source.staleReason ? `Source note: ${packet.source.staleReason}` : undefined,
    `Generated at: ${packet.generatedAt}`,
    `Packet SHA: ${packet.packetSha}`,
    `Budget: ${packet.byteBudget.usedBytes}/${packet.byteBudget.maxBytes} bytes; ${packet.tokenBudget.usedTokens}/${packet.tokenBudget.maxTokens} token-ish`,
    `Redaction: ${packet.redaction.status} (${packet.redaction.replacementCount} replacements)`,
    packet.degraded ? "Degraded: true" : "Degraded: false",
    "",
    packet.advisory,
    ""
  ].filter((line): line is string => line !== undefined);

  if (packet.includedSections.length === 0) {
    lines.push("## Sections", "", "No repo wiki sections were included.");
  } else {
    lines.push("## Sections");
    for (const section of packet.includedSections) {
      lines.push(
        "",
        `### ${section.title}`,
        "",
        [
          `id=${section.id}`,
          `bytes=${section.byteLength}`,
          `tokens=${section.tokenEstimate}`,
          section.truncated ? "truncated=true" : "truncated=false",
          section.redacted ? "redacted=true" : "redacted=false",
          section.sourceSha ? `source_sha=${section.sourceSha}` : undefined,
          section.sourceFiles.length ? `files=${section.sourceFiles.join(", ")}` : undefined
        ].filter(Boolean).join("; "),
        "",
        section.body
      );
    }
  }

  if (packet.excludedSections.length) {
    lines.push("", "## Excluded Sections");
    for (const section of packet.excludedSections) {
      lines.push("", `- ${section.id}: ${section.reason}`);
    }
  }

  return `${lines.join("\n").trim()}\n`;
}

export function formatRepoWikiPacketJson(packet: RepoWikiPacket): string {
  return `${canonicalStringify(packet)}\n`;
}

export function redactRepoWikiText(input: string): { text: string; replacementCount: number } {
  const text = redactSecrets(input);
  const replacementCount = countNeedles(text, "[redacted-secret]") - countNeedles(input, "[redacted-secret]");
  return {
    text,
    replacementCount: Math.max(0, replacementCount)
  };
}

export function truncateUtf8Bytes(input: string, maxBytes: number): string {
  if (!Number.isInteger(maxBytes) || maxBytes < 0) throw new Error("maxBytes must be a non-negative integer");
  if (Buffer.byteLength(input, "utf8") <= maxBytes) return input;
  let output = "";
  let used = 0;
  for (const char of input) {
    const size = Buffer.byteLength(char, "utf8");
    if (used + size > maxBytes) break;
    output += char;
    used += size;
  }
  return output;
}

function finalizePacket(
  base: Omit<RepoWikiPacket, "includedSections" | "excludedSections" | "includedFiles" | "packetSha">,
  includedSections: RepoWikiIncludedSection[],
  excludedSections: RepoWikiExcludedSection[]
): RepoWikiPacket {
  const includedFiles = buildIncludedFiles(includedSections);
  const withoutSha: Omit<RepoWikiPacket, "packetSha"> = {
    ...base,
    includedSections,
    excludedSections: [...excludedSections].sort(compareExcluded),
    includedFiles
  };
  const packetSha = sha256(canonicalStringify(withoutSha));
  const packet: RepoWikiPacket = { ...withoutSha, packetSha };
  const usedBytes = Buffer.byteLength(formatRepoWikiPacketMarkdown(packet), "utf8");
  const usedTokens = tokenEstimateForBytes(usedBytes);
  const measuredWithoutSha: Omit<RepoWikiPacket, "packetSha"> = {
    ...withoutSha,
    byteBudget: { ...withoutSha.byteBudget, usedBytes },
    tokenBudget: { ...withoutSha.tokenBudget, usedTokens }
  };
  return {
    ...measuredWithoutSha,
    packetSha: sha256(canonicalStringify(measuredWithoutSha))
  };
}

function buildIncludedFiles(sections: RepoWikiIncludedSection[]): RepoWikiIncludedFile[] {
  const byPath = new Map<string, Set<string>>();
  for (const section of sections) {
    for (const path of section.sourceFiles) {
      const ids = byPath.get(path) ?? new Set<string>();
      ids.add(section.id);
      byPath.set(path, ids);
    }
  }
  return [...byPath.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, sectionIds]) => ({ path, sections: [...sectionIds].sort() }));
}

function normalizeRepo(repo: RepoWikiIdentity): RepoWikiIdentity {
  return {
    fullName: repo.fullName,
    ...(repo.defaultBranch ? { defaultBranch: repo.defaultBranch } : {}),
    ...(repo.remoteUrl ? { remoteUrl: repo.remoteUrl } : {})
  };
}

function normalizeSource(
  source: RepoWikiSourceFreshness,
  counter: { count: number }
): RepoWikiSourceFreshness {
  const staleReason = source.staleReason ? redactAndCount(source.staleReason, counter).text : undefined;
  return {
    ref: source.ref,
    ...(source.headSha ? { headSha: source.headSha } : {}),
    ...(source.checkedAt ? { checkedAt: source.checkedAt } : {}),
    status: source.status,
    ...(staleReason ? { staleReason } : {})
  };
}

function redactAndCount(input: string, counter: { count: number }): { text: string; replacementCount: number } {
  const result = redactRepoWikiText(input);
  counter.count += result.replacementCount;
  return result;
}

function normalizeSectionId(id: string): string {
  const normalized = id.trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || "section";
}

function normalizeText(value: string): string {
  return value.replace(/\r\n?/g, "\n").trim();
}

function normalizeSourceFiles(files: string[]): string[] {
  return [...new Set(files.map((file) => file.trim()).filter(Boolean))].sort();
}

function compareSections(left: RepoWikiNormalizedSection, right: RepoWikiNormalizedSection): number {
  if (left.order !== right.order) return left.order - right.order;
  return left.id.localeCompare(right.id);
}

function compareExcluded(left: RepoWikiExcludedSection, right: RepoWikiExcludedSection): number {
  const id = left.id.localeCompare(right.id);
  return id !== 0 ? id : left.reason.localeCompare(right.reason);
}

function assertRepoName(repo: string): void {
  const [owner, name, extra] = repo.split("/");
  if (extra !== undefined || !owner || !name) throw new Error("repo.fullName must be an owner/repo name");
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(name)) {
    throw new Error("repo.fullName must be an owner/repo name");
  }
}

function assertBudget(budget: RepoWikiPacketBudgetInput): void {
  if (!Number.isInteger(budget.maxBytes) || budget.maxBytes < 1) {
    throw new Error("budget.maxBytes must be a positive integer");
  }
  if (budget.maxTokens !== undefined && (!Number.isInteger(budget.maxTokens) || budget.maxTokens < 1)) {
    throw new Error("budget.maxTokens must be a positive integer");
  }
  if (budget.maxSectionBytes !== undefined && (!Number.isInteger(budget.maxSectionBytes) || budget.maxSectionBytes < 1)) {
    throw new Error("budget.maxSectionBytes must be a positive integer");
  }
}

function assertIsoTimestamp(value: string, fieldName: string): void {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(`${fieldName} must be a canonical ISO timestamp`);
  }
}

function tokenEstimateForBytes(bytes: number): number {
  return Math.max(1, Math.ceil(bytes / 4));
}

function countNeedles(input: string, needle: string): number {
  return input.split(needle).length - 1;
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function canonicalStringify(input: unknown): string {
  return JSON.stringify(sortJson(input));
}

function sortJson(input: unknown): unknown {
  if (Array.isArray(input)) return input.map((item) => sortJson(item));
  if (input && typeof input === "object") {
    return Object.fromEntries(
      Object.entries(input)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => [key, sortJson(value)])
    );
  }
  return input;
}
