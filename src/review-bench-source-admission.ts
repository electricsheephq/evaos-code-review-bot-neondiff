import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  openSync,
  linkSync,
  readSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import {
  serializeReviewBenchCorpus,
  validateReviewBenchCorpus,
  type ReviewBenchCorpusV1,
  type ReviewBenchLanguage,
  type ReviewBenchScenarioV1
} from "./review-bench-corpus.js";
import {
  decodeAndValidateReviewBenchSourceArtifact,
  REVIEW_BENCH_MAX_SOURCE_ARTIFACT_BYTES,
  reverifyReviewBenchCorpusPublicSources
} from "./review-bench-source-verification.js";
import {
  bindReviewBenchLineAgreement,
  computeReviewBenchAdjudicationAgreement,
  computeReviewBenchSemanticEvidenceSha256,
  REVIEW_BENCH_ADJUDICATION_AGREEMENT_VERSION,
  REVIEW_BENCH_MAX_ORACLE_EVIDENCE_BYTES,
  REVIEW_BENCH_ORACLE_EVIDENCE_VERSION,
  REVIEW_BENCH_SEMANTIC_EVIDENCE_VERIFIER_VERSION,
  verifyReviewBenchOracleEvidence,
  type ReviewBenchAnnotationCandidateV1
} from "./review-bench-semantic-evidence.js";
import { containsSecretLikeText } from "./secrets.js";
import {
  reverifyReviewBenchCorpusOracleSources,
  REVIEW_BENCH_ORACLE_SOURCE_VERIFIER_VERSION
} from "./review-bench-oracle-source-verification.js";

const MAX_CORPUS_MANIFEST_BYTES = 32 * 1024 * 1024;
const MAX_ADJUDICATION_ARTIFACT_BYTES = 512 * 1024;
const MAX_UNIFIED_DIFF_LINES = 250_000;

export interface ReviewBenchSourceAdmissionReceiptV1 {
  schemaVersion: "review-bench-source-admission-receipt/v1";
  corpusVersion: string;
  corpusHash: string;
  verificationEvidenceSha256: string;
  semanticEvidenceVersion: typeof REVIEW_BENCH_ORACLE_EVIDENCE_VERSION;
  semanticEvidenceVerifierVersion: typeof REVIEW_BENCH_SEMANTIC_EVIDENCE_VERIFIER_VERSION;
  semanticEvidenceSha256: string;
  oracleSourceVerifierVersion: typeof REVIEW_BENCH_ORACLE_SOURCE_VERIFIER_VERSION;
  oracleSourceVerificationSha256: string;
  adjudicationAgreementVersion: typeof REVIEW_BENCH_ADJUDICATION_AGREEMENT_VERSION;
  adjudicationScenarioCount: number;
  actionabilityItemCount: number;
  actionabilityBothActionableCount: number;
  actionabilityPrimaryOnlyCount: number;
  actionabilitySecondaryOnlyCount: number;
  actionabilityNeitherCount: number;
  actionabilityKappa: number;
  artifactBothDefectCount: number;
  artifactPrimaryOnlyDefectCount: number;
  artifactSecondaryOnlyDefectCount: number;
  artifactBothCleanCount: number;
  artifactSemanticsKappa: number;
  p0p1LabelCount: number;
  severityAgreementLabelCount: number;
  severityWithinOneTierAgreement: number;
  scenarioCount: number;
  defectScenarioCount: number;
  cleanControlCount: number;
  languageCount: number;
  repositoryCount: number;
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
  const receiptDestination = prepareReceiptDestination(input.receiptPath);
  const admittedAt = input.admittedAt ?? new Date().toISOString();
  requireIsoTimestamp(admittedAt, "admittedAt");
  const corpusPath = realpathSync(resolve(input.corpusPath));
  const corpusBytes = readBoundedRegularFile(corpusPath, MAX_CORPUS_MANIFEST_BYTES, "corpus manifest");
  let corpusText: string;
  try {
    corpusText = new TextDecoder("utf-8", { fatal: true }).decode(corpusBytes);
  } catch {
    throw new Error("corpus manifest must be valid UTF-8 JSON");
  }
  let corpus: ReviewBenchCorpusV1;
  try {
    corpus = JSON.parse(corpusText) as ReviewBenchCorpusV1;
  } catch {
    throw new Error("corpus manifest must be valid JSON");
  }
  const canonicalCorpus = serializeReviewBenchCorpus(corpus);
  if (corpusText !== canonicalCorpus && corpusText !== `${canonicalCorpus}\n`) {
    throw new Error("corpus manifest must use canonical JSON without duplicate keys");
  }
  validateReviewBenchCorpus(corpus);

  const artifactsDirectory = realpathSync(resolve(input.artifactsDirectory));
  if (!statSync(artifactsDirectory).isDirectory()) throw new Error("artifacts directory must be a directory");
  const semanticRecords = [];
  const verifiedLanguages = new Set<ReviewBenchLanguage>();
  const verifiedAdjudicationArtifacts = new Set<string>();
  const scenarios = [...corpus.scenarios].sort((a, b) => compareFixed(a.scenarioId, b.scenarioId));
  for (const scenario of scenarios) {
    if (Date.parse(scenario.provenance.visibilityVerifiedAt) > Date.parse(admittedAt) ||
        Date.parse(scenario.adjudication.completedAt) > Date.parse(admittedAt)) {
      throw new Error(`scenario evidence timestamps must not follow admittedAt: ${scenario.scenarioId}`);
    }
    const digest = scenario.provenance.sourceArtifactSha256;
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error(`invalid source artifact digest: ${scenario.scenarioId}`);
    const artifact = readDigestNamedArtifact(
      artifactsDirectory,
      digest,
      ".diff",
      REVIEW_BENCH_MAX_SOURCE_ARTIFACT_BYTES,
      `source artifact: ${scenario.scenarioId}`
    );
    if (sha256(artifact) !== digest) {
      throw new Error(`source artifact sha256 does not match its declared digest: ${scenario.scenarioId}`);
    }
    const diff = decodeAndValidateReviewBenchSourceArtifact(
      artifact,
      `source artifact: ${scenario.scenarioId}`
    );
    assertGoldLabelAnchorsInUnifiedDiff(scenario, diff);
    assertScenarioLanguageInUnifiedDiff(scenario, diff);
    if (!scenario.explicitControl) verifiedLanguages.add(scenario.language);

    const evidence = readDigestNamedArtifact(
      artifactsDirectory,
      scenario.oracle.evidenceSha256,
      ".oracle.json",
      REVIEW_BENCH_MAX_ORACLE_EVIDENCE_BYTES,
      `oracle evidence: ${scenario.scenarioId}`
    );
    const semanticRecord = verifyReviewBenchOracleEvidence(scenario, evidence);
    const eligibleLines = assertAnnotationCandidateAnchorsInUnifiedDiff(
      scenario,
      semanticRecord.annotationUniverse.candidates,
      diff
    );
    semanticRecords.push(bindReviewBenchLineAgreement(semanticRecord, eligibleLines));

    for (const [kind, version, digest, suffix] of [
      [
        "rubric",
        scenario.adjudication.rubricVersion,
        scenario.adjudication.rubricSha256,
        ".rubric.md"
      ],
      [
        "protocol",
        scenario.adjudication.protocolVersion,
        scenario.adjudication.protocolSha256,
        ".protocol.md"
      ]
    ] as const) {
      const artifactIdentity = `${kind}:${version}:${digest}`;
      if (verifiedAdjudicationArtifacts.has(artifactIdentity)) continue;
      const artifact = readDigestNamedArtifact(
        artifactsDirectory,
        digest,
        suffix,
        MAX_ADJUDICATION_ARTIFACT_BYTES,
        `${kind} artifact: ${scenario.scenarioId}`
      );
      validateAdjudicationArtifact(artifact, digest, version, `${kind} artifact: ${scenario.scenarioId}`);
      verifiedAdjudicationArtifacts.add(artifactIdentity);
    }
  }
  const semanticEvidenceSha256 = computeReviewBenchSemanticEvidenceSha256(semanticRecords);
  const adjudicationAgreement = computeReviewBenchAdjudicationAgreement(semanticRecords);
  const sourceArtifactFor = (scenario: ReviewBenchScenarioV1): Uint8Array => {
    const artifact = readDigestNamedArtifact(
      artifactsDirectory,
      scenario.provenance.sourceArtifactSha256,
      ".diff",
      REVIEW_BENCH_MAX_SOURCE_ARTIFACT_BYTES,
      `source artifact: ${scenario.scenarioId}`
    );
    const diff = decodeAndValidateReviewBenchSourceArtifact(
      artifact,
      `source artifact: ${scenario.scenarioId}`
    );
    assertGoldLabelAnchorsInUnifiedDiff(scenario, diff);
    return artifact;
  };
  const fetchImpl = input.fetchImpl ?? buildReviewBenchGitHubFetch();
  const oracleSourceProof = await reverifyReviewBenchCorpusOracleSources({
    corpus,
    semanticEvidenceRecords: semanticRecords,
    admittedAt,
    fetchImpl
  });
  const proof = await reverifyReviewBenchCorpusPublicSources({
    corpus,
    sourceArtifactFor,
    fetchImpl
  });
  const receiptBasis = {
    schemaVersion: "review-bench-source-admission-receipt/v1" as const,
    corpusVersion: corpus.corpusVersion,
    corpusHash: proof.corpusHash,
    verificationEvidenceSha256: proof.verificationEvidenceSha256,
    semanticEvidenceVersion: REVIEW_BENCH_ORACLE_EVIDENCE_VERSION,
    semanticEvidenceVerifierVersion: REVIEW_BENCH_SEMANTIC_EVIDENCE_VERIFIER_VERSION,
    semanticEvidenceSha256,
    oracleSourceVerifierVersion: REVIEW_BENCH_ORACLE_SOURCE_VERIFIER_VERSION,
    oracleSourceVerificationSha256: oracleSourceProof.oracleSourceVerificationSha256,
    adjudicationAgreementVersion: adjudicationAgreement.version,
    adjudicationScenarioCount: adjudicationAgreement.scenarioCount,
    actionabilityItemCount: adjudicationAgreement.actionabilityItemCount,
    actionabilityBothActionableCount: adjudicationAgreement.actionabilityBothActionableCount,
    actionabilityPrimaryOnlyCount: adjudicationAgreement.actionabilityPrimaryOnlyCount,
    actionabilitySecondaryOnlyCount: adjudicationAgreement.actionabilitySecondaryOnlyCount,
    actionabilityNeitherCount: adjudicationAgreement.actionabilityNeitherCount,
    actionabilityKappa: adjudicationAgreement.actionabilityKappa,
    artifactBothDefectCount: adjudicationAgreement.artifactBothDefectCount,
    artifactPrimaryOnlyDefectCount: adjudicationAgreement.artifactPrimaryOnlyDefectCount,
    artifactSecondaryOnlyDefectCount: adjudicationAgreement.artifactSecondaryOnlyDefectCount,
    artifactBothCleanCount: adjudicationAgreement.artifactBothCleanCount,
    artifactSemanticsKappa: adjudicationAgreement.artifactSemanticsKappa,
    p0p1LabelCount: corpus.scenarios.reduce(
      (count, scenario) => count + scenario.labels.filter((label) => label.severity === "P0" || label.severity === "P1").length,
      0
    ),
    severityAgreementLabelCount: adjudicationAgreement.severityLabelCount,
    severityWithinOneTierAgreement: adjudicationAgreement.severityWithinOneTierAgreement,
    scenarioCount: corpus.scenarios.length,
    defectScenarioCount: corpus.scenarios.filter((scenario) => !scenario.explicitControl).length,
    cleanControlCount: corpus.scenarios.filter((scenario) => scenario.explicitControl).length,
    languageCount: verifiedLanguages.size,
    repositoryCount: new Set(corpus.scenarios.map((scenario) => scenario.repository.toLowerCase())).size,
    sourceVerifierVersion: "github-public-source-ingest/v1" as const,
    admittedAt
  };
  const receipt: ReviewBenchSourceAdmissionReceiptV1 = {
    ...receiptBasis,
    receiptSha256: sha256(stableJson(receiptBasis))
  };
  writeImmutableReceipt(receiptDestination, receipt);
  return receipt;
}

function validateAdjudicationArtifact(
  bytes: Uint8Array,
  expectedSha256: string,
  version: string,
  label: string
): void {
  if (sha256(bytes) !== expectedSha256) throw new Error(`${label} sha256 does not match its declared digest`);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label} must be valid UTF-8`);
  }
  if (containsSecretLikeText(text)) throw new Error(`${label} contains secret-like text`);
  if (!text.startsWith(`# ${version}\n`)) throw new Error(`${label} must declare its exact version in the first heading`);
}

function readDigestNamedArtifact(
  artifactsDirectory: string,
  digest: string,
  suffix: string,
  maximumBytes: number,
  label: string
): Uint8Array {
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error(`${label} has an invalid digest`);
  const artifactPath = realpathSync(resolve(artifactsDirectory, `${digest}${suffix}`));
  const relativePath = relative(artifactsDirectory, artifactPath);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error(`${label} escapes artifacts directory`);
  }
  return readBoundedRegularFile(artifactPath, maximumBytes, label);
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
  diff: string
): void {
  const requiredAnchors = new Map<string, Set<number>>();
  for (const label of scenario.labels) {
    const path = requireCanonicalDiffPath(label.path, `gold label path: ${label.id}`);
    const lines = requiredAnchors.get(path) ?? new Set<number>();
    lines.add(label.line);
    requiredAnchors.set(path, lines);
  }
  const { matchedAnchors } = parseNewSideUnifiedDiffAnchors(diff, scenario.scenarioId, requiredAnchors);
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

function assertAnnotationCandidateAnchorsInUnifiedDiff(
  scenario: ReviewBenchScenarioV1,
  candidates: ReadonlyArray<ReviewBenchAnnotationCandidateV1>,
  diff: string
): Array<{ path: string; line: number }> {
  const requiredAnchors = new Map<string, Set<number>>();
  for (const candidate of candidates) {
    const path = requireCanonicalDiffPath(candidate.path, `annotation candidate path: ${candidate.id}`);
    const lines = requiredAnchors.get(path) ?? new Set<number>();
    lines.add(candidate.line);
    requiredAnchors.set(path, lines);
  }
  const { matchedAnchors, allAnchors } = parseNewSideUnifiedDiffAnchors(
    diff,
    scenario.scenarioId,
    requiredAnchors
  );
  for (const candidate of candidates) {
    if (!matchedAnchors.get(candidate.path)?.has(candidate.line)) {
      throw new Error(
        `annotation candidate anchor is not a new-side context/addition line in the verified diff: ` +
        `${scenario.scenarioId}:${candidate.id}:${candidate.path}:${candidate.line}`
      );
    }
  }
  return [...allAnchors.entries()]
    .flatMap(([path, lines]) => [...lines].map((line) => ({ path, line })))
    .sort((a, b) => compareFixed(a.path, b.path) || a.line - b.line);
}

const REVIEW_BENCH_LANGUAGE_EXTENSIONS: Readonly<Record<ReviewBenchLanguage, readonly string[]>> = {
  TypeScript: [".ts", ".tsx", ".mts", ".cts"],
  JavaScript: [".js", ".jsx", ".mjs", ".cjs"],
  Python: [".py"],
  Go: [".go"],
  Rust: [".rs"],
  Java: [".java"],
  "C#": [".cs"],
  "C++": [".cc", ".cpp", ".cxx", ".c++", ".hh", ".hpp", ".hxx", ".h++"],
  Ruby: [".rb"]
};

function assertScenarioLanguageInUnifiedDiff(
  scenario: ReviewBenchScenarioV1,
  diff: string
): void {
  const { allAnchors } = parseNewSideUnifiedDiffAnchors(diff, scenario.scenarioId, new Map());
  const extensions = REVIEW_BENCH_LANGUAGE_EXTENSIONS[scenario.language];
  const matchingPath = [...allAnchors.keys()].some((path) => {
    const normalizedPath = path.toLowerCase();
    return extensions.some((extension) => normalizedPath.endsWith(extension));
  });
  if (!matchingPath) {
    throw new Error(
      `declared language ${scenario.language} has no changed source path in the verified diff: ` +
      scenario.scenarioId
    );
  }
}

function parseNewSideUnifiedDiffAnchors(
  diff: string,
  scenarioId: string,
  requiredAnchors: ReadonlyMap<string, ReadonlySet<number>>
): { matchedAnchors: Map<string, Set<number>>; allAnchors: Map<string, Set<number>> } {
  const matchedAnchors = new Map<string, Set<number>>();
  const allAnchors = new Map<string, Set<number>>();
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
        recordAllAnchor(allAnchors, currentPath, hunk.newLine);
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
        recordAllAnchor(allAnchors, currentPath, hunk.newLine);
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
  return { matchedAnchors, allAnchors };
}

function recordAllAnchor(anchors: Map<string, Set<number>>, path: string, line: number): void {
  const lines = anchors.get(path) ?? new Set<number>();
  lines.add(line);
  anchors.set(path, lines);
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

interface PreparedReceiptDestination {
  path: string;
  parentRealPath: string;
  parentDevice: number;
  parentInode: number;
}

function prepareReceiptDestination(path: string): PreparedReceiptDestination {
  const resolvedPath = resolve(path);
  const parentPath = dirname(resolvedPath);
  if (!existsSync(parentPath) || !statSync(parentPath).isDirectory()) {
    throw new Error("receipt parent directory must already exist outside a git checkout");
  }
  const parentRealPath = realpathSync(parentPath);
  if (findContainingGitRoot(parentRealPath)) {
    throw new Error("receipt path must be outside every git checkout");
  }
  const parent = statSync(parentRealPath);
  return {
    path: resolvedPath,
    parentRealPath,
    parentDevice: parent.dev,
    parentInode: parent.ino
  };
}

function revalidateReceiptDestination(destination: PreparedReceiptDestination): void {
  const parentPath = dirname(destination.path);
  if (!existsSync(parentPath)) throw new Error("receipt parent directory changed during admission");
  const parentRealPath = realpathSync(parentPath);
  const parent = statSync(parentRealPath);
  if (parentRealPath !== destination.parentRealPath || parent.dev !== destination.parentDevice ||
      parent.ino !== destination.parentInode || findContainingGitRoot(parentRealPath)) {
    throw new Error("receipt parent directory changed or entered a git checkout during admission");
  }
}

function findContainingGitRoot(path: string): string | undefined {
  let cursor = path;
  while (true) {
    if (existsSync(resolve(cursor, ".git"))) return cursor;
    const parent = dirname(cursor);
    if (parent === cursor) return undefined;
    cursor = parent;
  }
}

function writeImmutableReceipt(
  destination: PreparedReceiptDestination,
  receipt: ReviewBenchSourceAdmissionReceiptV1
): void {
  revalidateReceiptDestination(destination);
  const path = destination.path;
  const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(temporaryPath, `${stableJson(receipt)}\n`, { mode: 0o600, flag: "wx" });
    // A same-directory hard link publishes atomically and fails with EEXIST instead of replacing a raced receipt.
    linkSync(temporaryPath, path);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

export function buildReviewBenchGitHubFetch(input: {
  fetchImpl?: typeof fetch;
  token?: string;
  timeoutMs?: number;
  attempts?: number;
} = {}): typeof fetch {
  const fetchImpl = input.fetchImpl ?? fetch;
  const token = (input.token ?? process.env.GITHUB_TOKEN)?.trim();
  const timeoutMs = input.timeoutMs ?? 30_000;
  const attempts = input.attempts ?? 2;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new Error("GitHub fetch timeoutMs must be an integer from 1 through 60000");
  }
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 2) {
    throw new Error("GitHub fetch attempts must be 1 or 2");
  }
  return (async (request, init) => {
    const requestUrl = new URL(request instanceof Request ? request.url : String(request));
    const headers = new Headers(request instanceof Request ? request.headers : undefined);
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
    if (requestUrl.origin === "https://api.github.com" && token) {
      headers.set("authorization", `Bearer ${token}`);
    } else {
      headers.delete("authorization");
    }
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const inheritedSignal = init?.signal ?? (request instanceof Request ? request.signal : undefined);
      const signal = inheritedSignal
        ? AbortSignal.any([inheritedSignal, timeoutSignal])
        : timeoutSignal;
      try {
        const response = await fetchImpl(request, { ...init, headers, signal });
        if (attempt < attempts && (response.status === 502 || response.status === 503 || response.status === 504)) {
          await response.body?.cancel();
          continue;
        }
        return response;
      } catch (error) {
        if (attempt >= attempts || inheritedSignal?.aborted) throw error;
      }
    }
    throw new Error("bounded GitHub fetch attempts exhausted");
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

function compareFixed(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
