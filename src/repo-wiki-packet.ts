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
  preRedactionReplacementCount?: number;
}

export interface RepoWikiNormalizedSection {
  id: string;
  title: string;
  body: string;
  order: number;
  sourceFiles: string[];
  sourceSha?: string;
  preRedactionReplacementCount?: number;
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

export type SupportedAddonKind = "openwiki-compatible-repo-wiki" | "gitnexus-context";
export type SupportedAddonStatus = "fresh" | "stale" | "missing" | "unknown";

export interface GitNexusContextPacketSummary {
  packetVersion: string;
  sha256: string;
  byteEstimate: number;
  tokenEstimate: number;
  freshness: SupportedAddonStatus;
  degradedMode: boolean;
  degradedReason?: string;
  relatedContextCount: number;
  omittedContextCount: number;
  redactionStatus?: "passed" | "redacted" | "unknown";
  redactionReportSha256: string;
}

export interface SupportedAddonDryRunInput {
  repo: string;
  generatedAt?: string;
  maxBytes: number;
  maxTokens?: number;
  repoWikiPacket?: RepoWikiPacket;
  gitnexusPacket?: GitNexusContextPacketSummary;
}

export interface SupportedAddonDryRunAddon {
  kind: SupportedAddonKind;
  status: SupportedAddonStatus;
  packetVersion?: string;
  packetSha?: string;
  byteEstimate: number;
  tokenEstimate: number;
  advisory: boolean;
  degradedMode: boolean;
  degradedReason?: string;
  redactionStatus: "passed" | "redacted" | "unknown";
  redactionReportSha256?: string;
  relatedContextCount?: number;
  omittedContextCount?: number;
}

export interface SupportedAddonDryRunPacket {
  packetVersion: "supported-addons-dry-run-v0.1";
  repo: string;
  generatedAt: string;
  advisory: string;
  runtimePromotion: false;
  nativeToolExpansion: false;
  degradedMode: boolean;
  byteBudget: RepoWikiPacketBudget;
  tokenBudget: RepoWikiTokenBudget;
  addons: SupportedAddonDryRunAddon[];
  packetSha: string;
}

export function normalizeRepoWikiSections(input: RepoWikiSectionInput[]): {
  sections: RepoWikiNormalizedSection[];
  excluded: RepoWikiExcludedSection[];
} {
  const excluded: RepoWikiExcludedSection[] = [];
  const sortedSections = input
    .map((section) => {
      const baseId = normalizeSectionId(section.id);
      const body = normalizeText(section.body);
      const preRedactionReplacementCount = readPreRedactionReplacementCount(section.preRedactionReplacementCount);
      if (!body) {
        excluded.push({ id: baseId, reason: "empty" });
        return undefined;
      }
      return {
        id: baseId,
        title: normalizeText(section.title) || baseId,
        body,
        order: Number.isFinite(section.order) ? Number(section.order) : 0,
        sourceFiles: normalizeSourceFiles(section.sourceFiles ?? []),
        ...(section.sourceSha ? { sourceSha: section.sourceSha } : {}),
        ...(preRedactionReplacementCount > 0 ? { preRedactionReplacementCount } : {})
      } satisfies RepoWikiNormalizedSection;
    })
    .filter((section): section is RepoWikiNormalizedSection => section !== undefined)
    .sort(compareSections);

  return { sections: makeSectionIdsUnique(sortedSections), excluded };
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

  const baseRedactionCounter = { count: 0 };
  const includedSectionRedactionCounts = new Map<string, number>();
  const includedSections: RepoWikiIncludedSection[] = [];
  for (const section of normalized.sections) {
    const preRedactionReplacementCount = section.preRedactionReplacementCount ?? 0;
    const sectionRedactionCounter = { count: preRedactionReplacementCount };
    const redactedTitle = redactAndCount(section.title, sectionRedactionCounter);
    const redactedBody = redactAndCount(section.body, sectionRedactionCounter);
    const redactedSourceFileResults = section.sourceFiles.map((file) => redactAndCount(file, sectionRedactionCounter));
    const redactedSourceFiles = normalizeSourceFiles(redactedSourceFileResults.map((file) => file.text));
    const redactedSourceShaResult = section.sourceSha ? redactAndCount(section.sourceSha, sectionRedactionCounter) : undefined;
    const redactedSourceSha = redactedSourceShaResult?.text;
    const cappedBody = truncateUtf8Bytes(redactedBody.text, maxSectionBytes);
    const included: RepoWikiIncludedSection = {
      id: section.id,
      title: redactedTitle.text,
      body: cappedBody,
      order: section.order,
      sourceFiles: redactedSourceFiles,
      ...(redactedSourceSha ? { sourceSha: redactedSourceSha } : {}),
      byteLength: Buffer.byteLength(cappedBody, "utf8"),
      tokenEstimate: tokenEstimateForBytes(Buffer.byteLength(cappedBody, "utf8")),
      truncated: cappedBody !== redactedBody.text,
      redacted: sectionRedactionCounter.count > 0
    };
    includedSectionRedactionCounts.set(included.id, sectionRedactionCounter.count);
    includedSections.push(included);
  }

  const packetBase = {
    packetVersion: input.packetVersion ?? REPO_WIKI_PACKET_VERSION,
    repo: normalizeRepo(input.repo, baseRedactionCounter),
    source: normalizeSource(input.source, baseRedactionCounter),
    generatedAt,
    advisory: REPO_WIKI_ADVISORY_LINE,
    degraded: input.source.status !== "fresh",
    byteBudget: { maxBytes, usedBytes: 0 },
    tokenBudget: { maxTokens, usedTokens: 0 },
    redaction: {
      status: baseRedactionCounter.count > 0 ? "redacted" : "passed",
      replacementCount: baseRedactionCounter.count
    } satisfies RepoWikiRedactionResult
  };

  let acceptedSections = [...includedSections];
  let acceptedExcluded = [...excluded];
  while (acceptedSections.length > 0) {
    const tentative = finalizePacket(packetBase, acceptedSections, acceptedExcluded, includedSectionRedactionCounts);
    if (tentative.byteBudget.usedBytes <= maxBytes && tentative.tokenBudget.usedTokens <= maxTokens) {
      return tentative;
    }
    const dropped = acceptedSections.pop();
    if (dropped) acceptedExcluded = [{ id: dropped.id, reason: "packet_budget_exceeded" }, ...acceptedExcluded];
  }

  const emptyPacket = finalizePacket(packetBase, acceptedSections, acceptedExcluded, includedSectionRedactionCounts);
  if (emptyPacket.byteBudget.usedBytes > maxBytes || emptyPacket.tokenBudget.usedTokens > maxTokens) {
    throw new Error(
      `fixed packet header exceeds budget (${emptyPacket.byteBudget.usedBytes}/${maxBytes} bytes, ${emptyPacket.tokenBudget.usedTokens}/${maxTokens} token-ish)`
    );
  }
  return emptyPacket;
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

export function buildSupportedAddonDryRunPacket(input: SupportedAddonDryRunInput): SupportedAddonDryRunPacket {
  assertRepoName(input.repo);
  assertBudget({ maxBytes: input.maxBytes, maxTokens: input.maxTokens });
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  assertIsoTimestamp(generatedAt, "generatedAt");
  const maxTokens = input.maxTokens ?? tokenEstimateForBytes(input.maxBytes);
  const addons = [
    summarizeRepoWikiAddon(input.repoWikiPacket),
    summarizeGitNexusAddon(input.gitnexusPacket)
  ];
  const degradedMode = addons.some((addon) => addon.degradedMode);
  const base = {
    packetVersion: "supported-addons-dry-run-v0.1",
    repo: input.repo,
    generatedAt,
    advisory: "Supported addon packets are advisory. GitHub PR diff, checkout files, and GitHub metadata remain authoritative.",
    runtimePromotion: false,
    nativeToolExpansion: false,
    degradedMode,
    byteBudget: { maxBytes: input.maxBytes, usedBytes: 0 },
    tokenBudget: { maxTokens, usedTokens: 0 },
    addons
  } satisfies Omit<SupportedAddonDryRunPacket, "packetSha">;

  let withoutSha = base;
  let packetSha = sha256(canonicalStringify(withoutSha));
  assertPacketSha(packetSha);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const packet = { ...withoutSha, packetSha } satisfies SupportedAddonDryRunPacket;
    const usedBytes = Buffer.byteLength(formatSupportedAddonDryRunPacketMarkdown(packet), "utf8");
    const usedTokens = tokenEstimateForBytes(usedBytes);
    const nextWithoutSha = {
      ...withoutSha,
      byteBudget: { ...withoutSha.byteBudget, usedBytes },
      tokenBudget: { ...withoutSha.tokenBudget, usedTokens }
    };
    const nextSha = sha256(canonicalStringify(nextWithoutSha));
    assertPacketSha(nextSha);
    if (usedBytes === withoutSha.byteBudget.usedBytes && usedTokens === withoutSha.tokenBudget.usedTokens) {
      return assertSupportedAddonDryRunBudget({ ...nextWithoutSha, packetSha: nextSha });
    }
    withoutSha = nextWithoutSha;
    packetSha = nextSha;
  }

  return assertSupportedAddonDryRunBudget({ ...withoutSha, packetSha });
}

export function formatSupportedAddonDryRunPacketMarkdown(packet: SupportedAddonDryRunPacket): string {
  const lines = [
    "# Supported Addons Dry-Run Packet",
    "",
    `Repository: ${packet.repo}`,
    `Generated at: ${packet.generatedAt}`,
    `Packet version: ${packet.packetVersion}`,
    `Packet SHA: ${packet.packetSha}`,
    `Budget: ${packet.byteBudget.usedBytes}/${packet.byteBudget.maxBytes} bytes; ${packet.tokenBudget.usedTokens}/${packet.tokenBudget.maxTokens} token-ish`,
    `Runtime promotion: ${packet.runtimePromotion}`,
    `Native tool expansion: ${packet.nativeToolExpansion}`,
    `Degraded mode: ${packet.degradedMode}`,
    "",
    packet.advisory,
    "",
    "## Addons"
  ];

  for (const addon of packet.addons) {
    lines.push(
      "",
      `### ${addon.kind}`,
      "",
      `Status: ${addon.status}`,
      `Advisory: ${addon.advisory}`,
      `Degraded mode: ${addon.degradedMode}`,
      ...(addon.degradedReason ? [`Degraded reason: ${addon.degradedReason}`] : []),
      ...(addon.packetVersion ? [`Packet version: ${addon.packetVersion}`] : []),
      ...(addon.packetSha ? [`Packet SHA: ${addon.packetSha}`] : []),
      `Budget: ${addon.byteEstimate} bytes; ${addon.tokenEstimate} token-ish`,
      `Redaction: ${addon.redactionStatus}`,
      ...(addon.redactionReportSha256 ? [`Redaction report SHA: ${addon.redactionReportSha256}`] : []),
      ...(addon.relatedContextCount !== undefined ? [`Related context count: ${addon.relatedContextCount}`] : []),
      ...(addon.omittedContextCount !== undefined ? [`Omitted context count: ${addon.omittedContextCount}`] : [])
    );
  }

  return `${lines.join("\n").trim()}\n`;
}

export function redactRepoWikiText(input: string): { text: string; replacementCount: number } {
  const marker = "[redacted-secret]";
  const sentinel = chooseRedactionSentinel(input);
  const shieldedInput = input.split(marker).join(sentinel);
  const shieldedText = redactSecrets(shieldedInput);
  const replacementCount = Math.max(0, countNeedles(shieldedText, marker) - countNeedles(shieldedInput, marker));
  return {
    text: shieldedText.split(sentinel).join(marker),
    replacementCount
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
  excludedSections: RepoWikiExcludedSection[],
  includedSectionRedactionCounts: Map<string, number>
): RepoWikiPacket {
  const includedFiles = buildIncludedFiles(includedSections);
  const replacementCount = base.redaction.replacementCount +
    includedSections.reduce((count, section) => count + (includedSectionRedactionCounts.get(section.id) ?? 0), 0);
  let withoutSha: Omit<RepoWikiPacket, "packetSha"> = {
    ...base,
    redaction: {
      status: replacementCount > 0 ? "redacted" : "passed",
      replacementCount
    },
    includedSections,
    excludedSections: [...excludedSections].sort(compareExcluded),
    includedFiles
  };
  let packetSha = sha256(canonicalStringify(withoutSha));
  assertPacketSha(packetSha);

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const packet: RepoWikiPacket = { ...withoutSha, packetSha };
    const usedBytes = Buffer.byteLength(formatRepoWikiPacketMarkdown(packet), "utf8");
    const usedTokens = tokenEstimateForBytes(usedBytes);
    const nextWithoutSha: Omit<RepoWikiPacket, "packetSha"> = {
      ...withoutSha,
      byteBudget: { ...withoutSha.byteBudget, usedBytes },
      tokenBudget: { ...withoutSha.tokenBudget, usedTokens }
    };
    const nextSha = sha256(canonicalStringify(nextWithoutSha));
    assertPacketSha(nextSha);
    if (usedBytes === withoutSha.byteBudget.usedBytes && usedTokens === withoutSha.tokenBudget.usedTokens) {
      return assertFinalPacketSize({ ...nextWithoutSha, packetSha: nextSha });
    }
    withoutSha = nextWithoutSha;
    packetSha = nextSha;
  }

  return assertFinalPacketSize({ ...withoutSha, packetSha });
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
    .sort(([left], [right]) => codeUnitCompare(left, right))
    .map(([path, sectionIds]) => ({ path, sections: [...sectionIds].sort(codeUnitCompare) }));
}

function normalizeRepo(repo: RepoWikiIdentity, counter: { count: number }): RepoWikiIdentity {
  const fullName = redactAndCount(repo.fullName, counter).text;
  const defaultBranch = repo.defaultBranch ? redactAndCount(repo.defaultBranch, counter).text : undefined;
  const remoteUrl = repo.remoteUrl ? redactAndCount(repo.remoteUrl, counter).text : undefined;
  return {
    fullName,
    ...(defaultBranch ? { defaultBranch } : {}),
    ...(remoteUrl ? { remoteUrl } : {})
  };
}

function normalizeSource(
  source: RepoWikiSourceFreshness,
  counter: { count: number }
): RepoWikiSourceFreshness {
  const ref = redactAndCount(source.ref, counter).text;
  const headSha = source.headSha ? redactAndCount(source.headSha, counter).text : undefined;
  const checkedAt = source.checkedAt ? redactAndCount(source.checkedAt, counter).text : undefined;
  const staleReason = source.staleReason ? redactAndCount(source.staleReason, counter).text : undefined;
  return {
    ref,
    ...(headSha ? { headSha } : {}),
    ...(checkedAt ? { checkedAt } : {}),
    status: source.status,
    ...(staleReason ? { staleReason } : {})
  };
}

function redactAndCount(input: string, counter: { count: number }): { text: string; replacementCount: number } {
  const result = redactRepoWikiText(input);
  counter.count += result.replacementCount;
  return result;
}

function readPreRedactionReplacementCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

function normalizeSectionId(id: string): string {
  const normalized = id.trim().toLowerCase().replace(/[^a-z0-9.-]+/g, "-").replace(/^-+|-+$/g, "");
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
  const id = codeUnitCompare(left.id, right.id);
  if (id !== 0) return id;
  const title = codeUnitCompare(left.title, right.title);
  if (title !== 0) return title;
  const body = codeUnitCompare(left.body, right.body);
  if (body !== 0) return body;
  const sourceFiles = codeUnitCompare(left.sourceFiles.join("\0"), right.sourceFiles.join("\0"));
  if (sourceFiles !== 0) return sourceFiles;
  return codeUnitCompare(left.sourceSha ?? "", right.sourceSha ?? "");
}

function makeSectionIdsUnique(sections: RepoWikiNormalizedSection[]): RepoWikiNormalizedSection[] {
  const seen = new Map<string, number>();
  return sections.map((section) => {
    const count = (seen.get(section.id) ?? 0) + 1;
    seen.set(section.id, count);
    if (count === 1) return section;
    return { ...section, id: `${section.id}-${count}` };
  });
}

function compareExcluded(left: RepoWikiExcludedSection, right: RepoWikiExcludedSection): number {
  const id = codeUnitCompare(left.id, right.id);
  return id !== 0 ? id : codeUnitCompare(left.reason, right.reason);
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

function chooseRedactionSentinel(input: string): string {
  let sentinel = "__repo_wiki_existing_redaction_marker__";
  while (input.includes(sentinel)) sentinel = `_${sentinel}`;
  return sentinel;
}

function countNeedles(input: string, needle: string): number {
  return input.split(needle).length - 1;
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function assertPacketSha(packetSha: string): void {
  if (!/^[a-f0-9]{64}$/.test(packetSha)) {
    throw new Error("repo wiki packet SHA must be a fixed 64-character hex digest");
  }
}

function canonicalStringify(input: unknown): string {
  return JSON.stringify(sortJson(input));
}

function sortJson(input: unknown): unknown {
  if (Array.isArray(input)) return input.map((item) => sortJson(item));
  if (input && typeof input === "object") {
    return Object.fromEntries(
      Object.entries(input)
        .sort(([left], [right]) => codeUnitCompare(left, right))
        .map(([key, value]) => [key, sortJson(value)])
    );
  }
  return input;
}

function assertFinalPacketSize(packet: RepoWikiPacket): RepoWikiPacket {
  const usedBytes = Buffer.byteLength(formatRepoWikiPacketMarkdown(packet), "utf8");
  const usedTokens = tokenEstimateForBytes(usedBytes);
  if (usedBytes !== packet.byteBudget.usedBytes || usedTokens !== packet.tokenBudget.usedTokens) {
    throw new Error(
      `repo wiki packet size invariant failed (${usedBytes}/${packet.byteBudget.usedBytes} bytes, ${usedTokens}/${packet.tokenBudget.usedTokens} token-ish)`
    );
  }
  return packet;
}

function summarizeRepoWikiAddon(packet: RepoWikiPacket | undefined): SupportedAddonDryRunAddon {
  if (!packet) {
    return {
      kind: "openwiki-compatible-repo-wiki",
      status: "missing",
      byteEstimate: 0,
      tokenEstimate: 0,
      advisory: true,
      degradedMode: true,
      degradedReason: "OpenWiki-compatible repo wiki packet was not supplied for this dry run.",
      redactionStatus: "unknown"
    };
  }
  return {
    kind: "openwiki-compatible-repo-wiki",
    status: packet.source.status,
    packetVersion: packet.packetVersion,
    packetSha: packet.packetSha,
    byteEstimate: packet.byteBudget.usedBytes,
    tokenEstimate: packet.tokenBudget.usedTokens,
    advisory: true,
    degradedMode: packet.degraded,
    ...(packet.source.staleReason ? { degradedReason: packet.source.staleReason } : {}),
    redactionStatus: packet.redaction.status,
    redactionReportSha256: sha256(canonicalStringify(packet.redaction))
  };
}

function summarizeGitNexusAddon(packet: GitNexusContextPacketSummary | undefined): SupportedAddonDryRunAddon {
  if (!packet) {
    return {
      kind: "gitnexus-context",
      status: "missing",
      byteEstimate: 0,
      tokenEstimate: 0,
      advisory: true,
      degradedMode: true,
      degradedReason: "GitNexus context packet was not supplied for this dry run.",
      redactionStatus: "unknown",
      relatedContextCount: 0,
      omittedContextCount: 0
    };
  }
  assertPacketSha(packet.sha256);
  assertPacketSha(packet.redactionReportSha256);
  return {
    kind: "gitnexus-context",
    status: packet.freshness,
    packetVersion: packet.packetVersion,
    packetSha: packet.sha256,
    byteEstimate: packet.byteEstimate,
    tokenEstimate: packet.tokenEstimate,
    advisory: true,
    degradedMode: packet.degradedMode,
    ...(packet.degradedReason ? { degradedReason: packet.degradedReason } : {}),
    redactionStatus: packet.redactionStatus ?? "unknown",
    redactionReportSha256: packet.redactionReportSha256,
    relatedContextCount: packet.relatedContextCount,
    omittedContextCount: packet.omittedContextCount
  };
}

function assertSupportedAddonDryRunBudget(packet: SupportedAddonDryRunPacket): SupportedAddonDryRunPacket {
  const usedBytes = Buffer.byteLength(formatSupportedAddonDryRunPacketMarkdown(packet), "utf8");
  const usedTokens = tokenEstimateForBytes(usedBytes);
  if (
    usedBytes !== packet.byteBudget.usedBytes ||
    usedTokens !== packet.tokenBudget.usedTokens ||
    usedBytes > packet.byteBudget.maxBytes ||
    usedTokens > packet.tokenBudget.maxTokens
  ) {
    throw new Error(
      `supported addon dry-run packet exceeds budget (${usedBytes}/${packet.byteBudget.maxBytes} bytes, ${usedTokens}/${packet.tokenBudget.maxTokens} token-ish)`
    );
  }
  return packet;
}

export function codeUnitCompare(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
