import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  openSync,
  mkdirSync,
  linkSync,
  readSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { ReviewBenchCorpusV1, ReviewBenchScenarioV1 } from "./review-bench-corpus.js";
import {
  REVIEW_BENCH_MAX_SOURCE_ARTIFACT_BYTES,
  reverifyReviewBenchCorpusPublicSources
} from "./review-bench-source-verification.js";

const MAX_CORPUS_MANIFEST_BYTES = 32 * 1024 * 1024;
const MAX_UNIFIED_DIFF_LINES = 250_000;

export interface ReviewBenchSourceAdmissionReceiptV1 {
  schemaVersion: "review-bench-source-admission-receipt/v1";
  corpusVersion: string;
  corpusHash: string;
  verificationEvidenceSha256: string;
  scenarioCount: number;
  sourceVerifierVersion: "github-public-source-ingest/v1";
  admittedAt: string;
  receiptSha256: string;
}

export async function runReviewBenchSourceAdmission(input: {
  corpusPath: string;
  artifactsDirectory: string;
  receiptPath: string;
  fetchImpl?: typeof fetch;
  admittedAt?: string;
}): Promise<ReviewBenchSourceAdmissionReceiptV1> {
  const admittedAt = input.admittedAt ?? new Date().toISOString();
  requireIsoTimestamp(admittedAt, "admittedAt");
  const corpusPath = realpathSync(resolve(input.corpusPath));
  const corpusBytes = readBoundedRegularFile(corpusPath, MAX_CORPUS_MANIFEST_BYTES, "corpus manifest");
  let corpus: ReviewBenchCorpusV1;
  try {
    corpus = JSON.parse(new TextDecoder().decode(corpusBytes)) as ReviewBenchCorpusV1;
  } catch {
    throw new Error("corpus manifest must be valid JSON");
  }

  const artifactsDirectory = realpathSync(resolve(input.artifactsDirectory));
  if (!statSync(artifactsDirectory).isDirectory()) throw new Error("artifacts directory must be a directory");
  const sourceArtifactFor = (scenario: ReviewBenchScenarioV1): Uint8Array => {
    const digest = scenario.provenance.sourceArtifactSha256;
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error(`invalid source artifact digest: ${scenario.scenarioId}`);
    const artifactPath = realpathSync(resolve(artifactsDirectory, `${digest}.diff`));
    const relativePath = relative(artifactsDirectory, artifactPath);
    if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
      throw new Error(`source artifact escapes artifacts directory: ${scenario.scenarioId}`);
    }
    const artifact = readBoundedRegularFile(
      artifactPath,
      REVIEW_BENCH_MAX_SOURCE_ARTIFACT_BYTES,
      `source artifact: ${scenario.scenarioId}`
    );
    assertGoldLabelAnchorsInUnifiedDiff(scenario, artifact);
    return artifact;
  };
  const proof = await reverifyReviewBenchCorpusPublicSources({
    corpus,
    sourceArtifactFor,
    fetchImpl: input.fetchImpl ?? buildGitHubFetch()
  });
  const receiptBasis = {
    schemaVersion: "review-bench-source-admission-receipt/v1" as const,
    corpusVersion: corpus.corpusVersion,
    corpusHash: proof.corpusHash,
    verificationEvidenceSha256: proof.verificationEvidenceSha256,
    scenarioCount: corpus.scenarios.length,
    sourceVerifierVersion: "github-public-source-ingest/v1" as const,
    admittedAt
  };
  const receipt: ReviewBenchSourceAdmissionReceiptV1 = {
    ...receiptBasis,
    receiptSha256: sha256(stableJson(receiptBasis))
  };
  writeImmutableReceipt(resolve(input.receiptPath), receipt);
  return receipt;
}

function readBoundedRegularFile(path: string, maximumBytes: number, label: string): Uint8Array {
  const descriptor = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.size === 0 || before.size > maximumBytes) {
      throw new Error(`${label} must contain 1-${maximumBytes} bytes`);
    }
    const buffer = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const bytesRead = readSync(descriptor, buffer, offset, buffer.byteLength - offset, offset);
      if (bytesRead === 0) throw new Error(`${label} changed while being read`);
      offset += bytesRead;
    }
    const after = fstatSync(descriptor);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
      throw new Error(`${label} changed while being read`);
    }
    return buffer;
  } finally {
    closeSync(descriptor);
  }
}

/**
 * Corpus v1 label lines are final-revision (new-side) unified-diff anchors.
 * Context and added lines are eligible; deletion-only lines are not because the
 * finding schema intentionally has no old-side coordinate.
 */
function assertGoldLabelAnchorsInUnifiedDiff(
  scenario: ReviewBenchScenarioV1,
  sourceArtifact: Uint8Array
): void {
  let diff: string;
  try {
    diff = new TextDecoder("utf-8", { fatal: true }).decode(sourceArtifact);
  } catch {
    throw new Error(`source artifact must be valid UTF-8 unified diff: ${scenario.scenarioId}`);
  }
  const requiredAnchors = new Map<string, Set<number>>();
  for (const label of scenario.labels) {
    const path = requireCanonicalDiffPath(label.path, `gold label path: ${label.id}`);
    const lines = requiredAnchors.get(path) ?? new Set<number>();
    lines.add(label.line);
    requiredAnchors.set(path, lines);
  }
  const matchedAnchors = parseNewSideUnifiedDiffAnchors(diff, scenario.scenarioId, requiredAnchors);
  for (const label of scenario.labels) {
    const path = label.path;
    if (!matchedAnchors.get(path)?.has(label.line)) {
      throw new Error(
        `gold label anchor is not a new-side context/addition line in the verified diff: ` +
        `${scenario.scenarioId}:${label.id}:${path}:${label.line}`
      );
    }
  }
}

function parseNewSideUnifiedDiffAnchors(
  diff: string,
  scenarioId: string,
  requiredAnchors: ReadonlyMap<string, ReadonlySet<number>>
): Map<string, Set<number>> {
  const matchedAnchors = new Map<string, Set<number>>();
  let sawFileHeader = false;
  let currentPath: string | null | undefined;
  let hunk: {
    oldLine: number;
    newLine: number;
    oldRemaining: number;
    newRemaining: number;
  } | undefined;

  const finishHunk = (): void => {
    if (hunk && (hunk.oldRemaining !== 0 || hunk.newRemaining !== 0)) {
      throw new Error(`malformed unified diff hunk counts: ${scenarioId}`);
    }
    hunk = undefined;
  };

  forEachDiffLine(diff, (rawLine) => {
    const metadataLine = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (hunk) {
      const prefix = rawLine[0];
      if (prefix === "\\" && rawLine.startsWith("\\ No newline at end of file")) return;
      if (prefix === " ") {
        if (hunk.oldRemaining < 1 || hunk.newRemaining < 1) {
          throw new Error(`malformed unified diff context line: ${scenarioId}`);
        }
        if (typeof currentPath !== "string") {
          throw new Error(`deletion-only unified diff hunk contains new-side context: ${scenarioId}`);
        }
        recordRequiredAnchor(matchedAnchors, requiredAnchors, currentPath, hunk.newLine);
        hunk.oldLine += 1;
        hunk.newLine += 1;
        hunk.oldRemaining -= 1;
        hunk.newRemaining -= 1;
      } else if (prefix === "+") {
        if (hunk.newRemaining < 1) throw new Error(`malformed unified diff addition: ${scenarioId}`);
        if (typeof currentPath !== "string") {
          throw new Error(`deletion-only unified diff hunk contains an addition: ${scenarioId}`);
        }
        recordRequiredAnchor(matchedAnchors, requiredAnchors, currentPath, hunk.newLine);
        hunk.newLine += 1;
        hunk.newRemaining -= 1;
      } else if (prefix === "-") {
        if (hunk.oldRemaining < 1) throw new Error(`malformed unified diff deletion: ${scenarioId}`);
        hunk.oldLine += 1;
        hunk.oldRemaining -= 1;
      } else {
        throw new Error(`malformed unified diff hunk line: ${scenarioId}`);
      }
      if (hunk.oldRemaining === 0 && hunk.newRemaining === 0) hunk = undefined;
      return;
    }

    if (metadataLine.startsWith("diff --git ")) {
      finishHunk();
      sawFileHeader = true;
      currentPath = undefined;
      return;
    }
    if (metadataLine.startsWith("+++ ")) {
      const rawPath = metadataLine.slice(4).split("\t", 1)[0];
      if (rawPath === "/dev/null") {
        currentPath = null;
        return;
      }
      if (!rawPath.startsWith("b/")) {
        throw new Error(`unsupported unified diff new-side path: ${scenarioId}`);
      }
      currentPath = requireCanonicalDiffPath(rawPath.slice(2), `unified diff path: ${scenarioId}`);
      return;
    }
    if (metadataLine.startsWith("@@")) {
      if (currentPath === undefined) throw new Error(`unified diff hunk has no new-side path: ${scenarioId}`);
      const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/.exec(metadataLine);
      if (!match) throw new Error(`malformed unified diff hunk header: ${scenarioId}`);
      const oldLine = Number(match[1]);
      const oldRemaining = Number(match[2] ?? "1");
      const newLine = Number(match[3]);
      const newRemaining = Number(match[4] ?? "1");
      if (![oldLine, oldRemaining, newLine, newRemaining].every(Number.isSafeInteger) ||
          oldLine < 0 || newLine < 0 || oldRemaining < 0 || newRemaining < 0) {
        throw new Error(`unified diff hunk coordinates are invalid: ${scenarioId}`);
      }
      if (currentPath === null && newRemaining !== 0) {
        throw new Error(`deletion-only unified diff hunk has new-side lines: ${scenarioId}`);
      }
      hunk = { oldLine, newLine, oldRemaining, newRemaining };
      if (oldRemaining === 0 && newRemaining === 0) hunk = undefined;
      return;
    }
  });
  finishHunk();
  if (!sawFileHeader) throw new Error(`source artifact is not a git unified diff: ${scenarioId}`);
  return matchedAnchors;
}

function recordRequiredAnchor(
  matched: Map<string, Set<number>>,
  required: ReadonlyMap<string, ReadonlySet<number>>,
  path: string,
  line: number
): void {
  if (!required.get(path)?.has(line)) return;
  const lines = matched.get(path) ?? new Set<number>();
  lines.add(line);
  matched.set(path, lines);
}

function forEachDiffLine(diff: string, visit: (line: string) => void): void {
  let start = 0;
  let lineCount = 0;
  while (start <= diff.length) {
    lineCount += 1;
    if (lineCount > MAX_UNIFIED_DIFF_LINES) {
      throw new Error(`unified diff exceeds ${MAX_UNIFIED_DIFF_LINES} lines`);
    }
    const end = diff.indexOf("\n", start);
    if (end === -1) {
      visit(diff.slice(start));
      return;
    }
    visit(diff.slice(start, end));
    start = end + 1;
  }
}

function requireCanonicalDiffPath(value: string, label: string): string {
  if (value.length === 0 || value.startsWith("/") || value.startsWith("./") ||
      value.includes("\\") || value.includes("\0") || value.includes("\r") || value.includes("\n") ||
      value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`${label} must be a canonical repository-relative path`);
  }
  return value;
}

function writeImmutableReceipt(path: string, receipt: ReviewBenchSourceAdmissionReceiptV1): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    // A same-directory hard link publishes atomically and fails with EEXIST instead of replacing a raced receipt.
    linkSync(temporaryPath, path);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

function buildGitHubFetch(): typeof fetch {
  const token = process.env.GITHUB_TOKEN?.trim();
  return (async (request, init) => {
    const headers = new Headers(init?.headers);
    if (token) headers.set("authorization", `Bearer ${token}`);
    return fetch(request, { ...init, headers });
  }) as typeof fetch;
}

function requireIsoTimestamp(value: string, label: string): void {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(`${label} must be an ISO-8601 UTC timestamp`);
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
