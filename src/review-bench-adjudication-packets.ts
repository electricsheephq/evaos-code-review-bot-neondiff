import { createHash, createHmac, randomUUID } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ReviewBenchLanguage } from "./review-bench-corpus.js";
import type { ReviewBenchAnnotationUniverseV1 } from "./review-bench-semantic-evidence.js";
import { containsSecretLikeText } from "./secrets.js";
import type { Severity } from "./types.js";

const MAX_CANDIDATE_BYTES = 512 * 1024;
const MAX_PACKET_BYTES = 2 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_DIFF_BYTES = 16 * 1024 * 1024;
const MAX_MARKDOWN_BYTES = 512 * 1024;
const MAX_RATIONALE_CHARS = 8_000;
const BLINDED_ACTIONABILITY_QUESTION =
  "Does this exact final-side anchor contain an actionable correctness or security defect under the bound rubric?";

const LANGUAGES: readonly ReviewBenchLanguage[] = [
  "TypeScript", "JavaScript", "Python", "Go", "Rust", "Java", "C#", "C++", "Ruby"
];
const LANGUAGE_EXTENSIONS: Readonly<Record<ReviewBenchLanguage, readonly string[]>> = {
  TypeScript: [".ts", ".tsx", ".mts", ".cts"],
  JavaScript: [".js", ".jsx", ".mjs", ".cjs"],
  Python: [".py"],
  Go: [".go"],
  Rust: [".rs"],
  Java: [".java"],
  "C#": [".cs"],
  "C++": [".cc", ".cpp", ".cxx", ".h", ".hh", ".hpp", ".hxx"],
  Ruby: [".rb"]
};
const SEVERITIES: readonly Severity[] = ["P0", "P1", "P2", "P3"];

export interface ReviewBenchAdjudicationCandidateV1 {
  schemaVersion: "review-bench-adjudication-candidate/v1";
  candidateId: string;
  blindingNonce: string;
  sourceArtifactSha256: string;
  language: ReviewBenchLanguage;
  annotationUniverse: ReviewBenchAnnotationUniverseV1;
  rubricVersion: string;
  rubricSha256: string;
  protocolVersion: string;
  protocolSha256: string;
}

export interface ReviewBenchBlindedAnnotationCandidateV1 {
  id: string;
  path: string;
  line: number;
  sourceCandidateCommitmentSha256: string;
  question: typeof BLINDED_ACTIONABILITY_QUESTION;
}

export interface ReviewBenchBlindedAnnotationUniverseV1 {
  schemaVersion: "review-bench-blinded-annotation-universe/v1";
  frozenAt: string;
  methodVersion: string;
  methodSha256: string;
  candidates: ReviewBenchBlindedAnnotationCandidateV1[];
}

export interface ReviewBenchAdjudicationPacketV1 {
  schemaVersion: "review-bench-adjudication-packet/v1";
  packetId: string;
  sourceArtifactSha256: string;
  language: ReviewBenchLanguage;
  annotationUniverse: ReviewBenchBlindedAnnotationUniverseV1;
  rubricVersion: string;
  rubricSha256: string;
  protocolVersion: string;
  protocolSha256: string;
  preparedAt: string;
  declarations: {
    providerIdentityExcluded: true;
    peerDecisionsExcluded: true;
    oracleGoldAnswersExcluded: true;
  };
  packetFingerprint: string;
}

type ReviewBenchAdjudicationPacketBasisV1 = Omit<ReviewBenchAdjudicationPacketV1, "packetFingerprint">;

export interface ReviewBenchAdjudicationDecisionV1 {
  candidateId: string;
  actionability: "actionable" | "not_actionable";
  severity?: Severity;
}

export interface ReviewBenchAdjudicationResponseV1 {
  schemaVersion: "review-bench-adjudication-response/v1";
  packetFingerprint: string;
  adjudicatorId: string;
  verdict: "defect_present" | "verified_clean";
  decisions: ReviewBenchAdjudicationDecisionV1[];
  rationale: string;
  completedAt: string;
  blindedToProviderIdentity: true;
  blindedToPeerDecision: true;
}

export interface ReviewBenchAdjudicationResolverResponseV1 {
  schemaVersion: "review-bench-adjudication-resolver-response/v1";
  packetFingerprint: string;
  adjudicatorId: string;
  verdict: "defect_present" | "verified_clean";
  decisions: ReviewBenchAdjudicationDecisionV1[];
  rationale: string;
  completedAt: string;
  blindedToProviderIdentity: true;
  reviewedDisagreement: true;
}

export interface ReviewBenchAdjudicationDisagreementV1 {
  schemaVersion: "review-bench-adjudication-disagreement/v1";
  verdictDisagreement?: {
    primary: ReviewBenchAdjudicationResponseV1["verdict"];
    secondary: ReviewBenchAdjudicationResponseV1["verdict"];
  };
  candidateDisagreements: Array<{
    candidateId: string;
    primary: ReviewBenchAdjudicationDecisionV1;
    secondary: ReviewBenchAdjudicationDecisionV1;
  }>;
}

export interface ReviewBenchAdjudicationReceiptV1 {
  schemaVersion: "review-bench-adjudication-receipt/v1";
  packetFingerprint: string;
  packetSha256: string;
  primaryResponseSha256: string;
  secondaryResponseSha256: string;
  resolverResponseSha256?: string;
  primaryAdjudicatorId: string;
  secondaryAdjudicatorId: string;
  resolverAdjudicatorId?: string;
  status: "ready" | "needs_resolution";
  artifactBothDefectCount: number;
  artifactPrimaryOnlyDefectCount: number;
  artifactSecondaryOnlyDefectCount: number;
  artifactBothCleanCount: number;
  actionabilityBothActionableCount: number;
  actionabilityPrimaryOnlyCount: number;
  actionabilitySecondaryOnlyCount: number;
  actionabilityNeitherCount: number;
  severityBothActionableCount: number;
  severityWithinOneTierCount: number;
  disagreementCount: number;
  disagreementQueue: ReviewBenchAdjudicationDisagreementV1;
  disagreementQueueSha256: string;
  resolvedDecisionSha256?: string;
  verifiedAt: string;
  receiptSha256: string;
}

export interface ReviewBenchAdjudicationPrepareSummary {
  schemaVersion: "review-bench-adjudication-prepare-summary/v1";
  packetFingerprint: string;
  packetSha256: string;
  sourceArtifactSha256: string;
  rubricSha256: string;
  protocolSha256: string;
}

export interface ReviewBenchAdjudicationVerifySummary {
  schemaVersion: "review-bench-adjudication-verify-summary/v1";
  status: "ready" | "needs_resolution";
  packetFingerprint: string;
  disagreementCount: number;
  resolvedDecisionSha256?: string;
  receiptSha256: string;
}

export function prepareReviewBenchAdjudicationPacket(input: {
  candidatePath: string;
  artifactsDirectory: string;
  outputDirectory: string;
  preparedAt?: string;
}): ReviewBenchAdjudicationPrepareSummary {
  const preparedAt = input.preparedAt ?? new Date().toISOString();
  requireIsoTimestamp(preparedAt, "preparedAt");
  const candidate = readCanonicalJson<ReviewBenchAdjudicationCandidateV1>(
    input.candidatePath,
    MAX_CANDIDATE_BYTES,
    "candidate manifest"
  );
  validateCandidate(candidate);
  if (Date.parse(candidate.annotationUniverse.frozenAt) > Date.parse(preparedAt)) {
    throw new Error("annotation universe frozenAt must not follow preparedAt");
  }

  const artifactsDirectory = requireRealDirectory(input.artifactsDirectory, "artifacts directory");
  const sourceBytes = readDigestArtifact(
    artifactsDirectory,
    candidate.sourceArtifactSha256,
    ".diff",
    MAX_DIFF_BYTES,
    "source artifact"
  );
  const rubricBytes = readDigestArtifact(
    artifactsDirectory,
    candidate.rubricSha256,
    ".rubric.md",
    MAX_MARKDOWN_BYTES,
    "rubric artifact"
  );
  const protocolBytes = readDigestArtifact(
    artifactsDirectory,
    candidate.protocolSha256,
    ".protocol.md",
    MAX_MARKDOWN_BYTES,
    "protocol artifact"
  );
  const diff = decodeUtf8(sourceBytes, "source artifact");
  const rubric = decodeUtf8(rubricBytes, "rubric artifact");
  const protocol = decodeUtf8(protocolBytes, "protocol artifact");
  rejectSecretText(diff, "source artifact");
  rejectSecretText(rubric, "rubric artifact");
  rejectSecretText(protocol, "protocol artifact");
  validateVersionedMarkdown(rubric, candidate.rubricVersion, "rubric artifact");
  validateVersionedMarkdown(protocol, candidate.protocolVersion, "protocol artifact");
  validateCandidateAnchors(candidate, diff);

  const blindedUniverse = buildBlindedAnnotationUniverse(candidate);
  const packetBasis = buildPacketFingerprintBasis({
    schemaVersion: "review-bench-adjudication-packet/v1" as const,
    packetId: `packet:${sha256(stableJson({
      sourceArtifactSha256: candidate.sourceArtifactSha256,
      annotationUniverse: blindedUniverse
    })).slice(0, 32)}`,
    sourceArtifactSha256: candidate.sourceArtifactSha256,
    language: candidate.language,
    annotationUniverse: blindedUniverse,
    rubricVersion: candidate.rubricVersion,
    rubricSha256: candidate.rubricSha256,
    protocolVersion: candidate.protocolVersion,
    protocolSha256: candidate.protocolSha256,
    preparedAt,
    declarations: {
      providerIdentityExcluded: true as const,
      peerDecisionsExcluded: true as const,
      oracleGoldAnswersExcluded: true as const
    }
  });
  const packet: ReviewBenchAdjudicationPacketV1 = {
    ...packetBasis,
    packetFingerprint: sha256(stableJson(packetBasis))
  };
  const packetBytes = Buffer.from(`${stableJson(packet)}\n`);
  const requestedOutput = resolve(input.outputDirectory);
  const outputParent = captureSafeParent(dirname(requestedOutput), "output directory parent");
  const outputLeaf = requireSinglePathComponent(basename(requestedOutput), "output directory name");
  const outputDirectory = join(outputParent.path, outputLeaf);
  assertSafeParent(outputParent, "output directory parent");
  if (existsSync(outputDirectory)) throw new Error("output directory must be fresh for no-clobber publication");
  let created = false;
  let outputRoot: SafeParent | undefined;
  try {
    mkdirSync(outputDirectory, { mode: 0o700 });
    created = true;
    assertSafeParent(outputParent, "output directory parent");
    outputRoot = captureSafeParent(outputDirectory, "output directory");
    assertSafeParent(outputRoot, "output directory");
    writeExclusive(join(outputDirectory, "packet.json"), packetBytes);
    assertSafeParent(outputRoot, "output directory");
    writeExclusive(join(outputDirectory, `${candidate.sourceArtifactSha256}.diff`), sourceBytes);
    assertSafeParent(outputRoot, "output directory");
    writeExclusive(join(outputDirectory, `${candidate.rubricSha256}.rubric.md`), rubricBytes);
    assertSafeParent(outputRoot, "output directory");
    writeExclusive(join(outputDirectory, `${candidate.protocolSha256}.protocol.md`), protocolBytes);
    assertSafeParent(outputRoot, "output directory");
    assertFinalArtifact(join(outputDirectory, "packet.json"), packetBytes, "packet output");
    assertFinalArtifact(
      join(outputDirectory, `${candidate.sourceArtifactSha256}.diff`), sourceBytes, "source output"
    );
    assertFinalArtifact(
      join(outputDirectory, `${candidate.rubricSha256}.rubric.md`), rubricBytes, "rubric output"
    );
    assertFinalArtifact(
      join(outputDirectory, `${candidate.protocolSha256}.protocol.md`), protocolBytes, "protocol output"
    );
  } catch (error) {
    if (created) removeOwnedDirectory(outputDirectory, outputRoot);
    throw error;
  }
  return {
    schemaVersion: "review-bench-adjudication-prepare-summary/v1",
    packetFingerprint: packet.packetFingerprint,
    packetSha256: sha256(packetBytes),
    sourceArtifactSha256: candidate.sourceArtifactSha256,
    rubricSha256: candidate.rubricSha256,
    protocolSha256: candidate.protocolSha256
  };
}

export function verifyReviewBenchAdjudicationResponses(input: {
  packetPath: string;
  primaryResponsePath: string;
  secondaryResponsePath: string;
  resolverResponsePath?: string;
  receiptPath: string;
  verifiedAt?: string;
}): ReviewBenchAdjudicationVerifySummary {
  const verifiedAt = input.verifiedAt ?? new Date().toISOString();
  requireIsoTimestamp(verifiedAt, "verifiedAt");
  const packetRead = readCanonicalJsonWithBytes<ReviewBenchAdjudicationPacketV1>(
    input.packetPath, MAX_PACKET_BYTES, "adjudication packet"
  );
  validatePacket(packetRead.value);
  const packet = packetRead.value;
  if (Date.parse(packet.preparedAt) > Date.parse(verifiedAt)) {
    throw new Error("packet preparedAt must not follow verifiedAt");
  }
  reverifyPacketArtifacts(input.packetPath, packet);
  const primaryRead = readCanonicalJsonWithBytes<ReviewBenchAdjudicationResponseV1>(
    input.primaryResponsePath, MAX_RESPONSE_BYTES, "primary response"
  );
  const secondaryRead = readCanonicalJsonWithBytes<ReviewBenchAdjudicationResponseV1>(
    input.secondaryResponsePath, MAX_RESPONSE_BYTES, "secondary response"
  );
  validateResponse(primaryRead.value, packet, "primary response");
  validateResponse(secondaryRead.value, packet, "secondary response");
  const primary = primaryRead.value;
  const secondary = secondaryRead.value;
  if (primary.adjudicatorId === secondary.adjudicatorId) {
    throw new Error("primary and secondary adjudicator identities must be distinct");
  }
  validateResponseChronology(primary.completedAt, packet.preparedAt, verifiedAt, "primary response");
  validateResponseChronology(secondary.completedAt, packet.preparedAt, verifiedAt, "secondary response");

  const primaryById = decisionMap(primary.decisions);
  const secondaryById = decisionMap(secondary.decisions);
  const queue = buildDisagreementQueue(packet, primary, secondary, primaryById, secondaryById);
  const disagreementCount = (queue.verdictDisagreement ? 1 : 0) + queue.candidateDisagreements.length;
  let resolverRead: ReturnType<typeof readCanonicalJsonWithBytes<ReviewBenchAdjudicationResolverResponseV1>> | undefined;
  let resolvedDecisionSha256: string | undefined;
  if (disagreementCount === 0) {
    if (input.resolverResponsePath !== undefined) {
      throw new Error("resolver is unnecessary because there is no disagreement");
    }
    resolvedDecisionSha256 = computeResolvedDecisionSha256(primary.verdict, primary.decisions);
  } else if (input.resolverResponsePath !== undefined) {
    resolverRead = readCanonicalJsonWithBytes<ReviewBenchAdjudicationResolverResponseV1>(
      input.resolverResponsePath, MAX_RESPONSE_BYTES, "resolver response"
    );
    validateResolverResponse(resolverRead.value, packet);
    const resolver = resolverRead.value;
    if (resolver.adjudicatorId === primary.adjudicatorId || resolver.adjudicatorId === secondary.adjudicatorId) {
      throw new Error("resolver adjudicator identity must be distinct from primary and secondary");
    }
    const latestInitial = Math.max(Date.parse(primary.completedAt), Date.parse(secondary.completedAt));
    if (Date.parse(resolver.completedAt) <= latestInitial || Date.parse(resolver.completedAt) > Date.parse(verifiedAt)) {
      throw new Error("resolver chronology requires completion later than both initial responses and not after verifiedAt");
    }
    resolvedDecisionSha256 = resolveDisagreements(
      packet,
      primary,
      secondary,
      resolver,
      queue,
      primaryById,
      secondaryById
    );
  }

  const counts = computeAgreementCounts(packet, primary, secondary, primaryById, secondaryById);
  const status: ReviewBenchAdjudicationReceiptV1["status"] =
    resolvedDecisionSha256 === undefined ? "needs_resolution" : "ready";
  const receiptBasis = {
    schemaVersion: "review-bench-adjudication-receipt/v1" as const,
    packetFingerprint: packet.packetFingerprint,
    packetSha256: sha256(packetRead.bytes),
    primaryResponseSha256: sha256(primaryRead.bytes),
    secondaryResponseSha256: sha256(secondaryRead.bytes),
    ...(resolverRead === undefined ? {} : { resolverResponseSha256: sha256(resolverRead.bytes) }),
    primaryAdjudicatorId: primary.adjudicatorId,
    secondaryAdjudicatorId: secondary.adjudicatorId,
    ...(resolverRead === undefined ? {} : { resolverAdjudicatorId: resolverRead.value.adjudicatorId }),
    status,
    ...counts,
    disagreementCount,
    disagreementQueue: queue,
    disagreementQueueSha256: sha256(stableJson(queue)),
    ...(resolvedDecisionSha256 === undefined ? {} : { resolvedDecisionSha256 }),
    verifiedAt
  };
  const receipt: ReviewBenchAdjudicationReceiptV1 = {
    ...receiptBasis,
    receiptSha256: sha256(stableJson(receiptBasis))
  };
  const requestedReceipt = resolve(input.receiptPath);
  const receiptParent = captureSafeParent(dirname(requestedReceipt), "receipt parent");
  const receiptLeaf = requireSinglePathComponent(basename(requestedReceipt), "receipt name");
  const receiptPath = join(receiptParent.path, receiptLeaf);
  publishImmutableFile(receiptParent, receiptLeaf, Buffer.from(`${stableJson(receipt)}\n`), "receipt");
  assertFinalArtifact(receiptPath, Buffer.from(`${stableJson(receipt)}\n`), "receipt output");
  return {
    schemaVersion: "review-bench-adjudication-verify-summary/v1",
    status,
    packetFingerprint: packet.packetFingerprint,
    disagreementCount,
    ...(resolvedDecisionSha256 === undefined ? {} : { resolvedDecisionSha256 }),
    receiptSha256: receipt.receiptSha256
  };
}

function validateCandidate(candidate: ReviewBenchAdjudicationCandidateV1): void {
  requireExactKeys(candidate, [
    "schemaVersion", "candidateId", "blindingNonce", "sourceArtifactSha256", "language", "annotationUniverse",
    "rubricVersion", "rubricSha256", "protocolVersion", "protocolSha256"
  ], "candidate manifest");
  if (candidate.schemaVersion !== "review-bench-adjudication-candidate/v1") {
    throw new Error("candidate schemaVersion must be review-bench-adjudication-candidate/v1");
  }
  requireBoundedText(candidate.candidateId, 1, 128, "candidateId");
  requireSha256(candidate.blindingNonce, "blindingNonce");
  if (/^0{64}$/.test(candidate.blindingNonce)) {
    throw new Error("blindingNonce must not be the all-zero value; use 32 CSPRNG-generated bytes");
  }
  requireSha256(candidate.sourceArtifactSha256, "sourceArtifactSha256");
  if (!LANGUAGES.includes(candidate.language)) throw new Error("candidate language is unsupported");
  requireVersion(candidate.rubricVersion, "rubricVersion");
  requireSha256(candidate.rubricSha256, "rubricSha256");
  requireVersion(candidate.protocolVersion, "protocolVersion");
  requireSha256(candidate.protocolSha256, "protocolSha256");
  validateAnnotationUniverse(candidate.annotationUniverse);
  if (candidate.annotationUniverse.methodVersion !== candidate.protocolVersion ||
      candidate.annotationUniverse.methodSha256 !== candidate.protocolSha256) {
    throw new Error("annotation universe method must bind the exact adjudication protocol");
  }
}

function validatePacket(packet: ReviewBenchAdjudicationPacketV1): void {
  requireExactKeys(packet, [
    "schemaVersion", "packetId", "sourceArtifactSha256", "language", "annotationUniverse",
    "rubricVersion", "rubricSha256", "protocolVersion", "protocolSha256", "preparedAt",
    "declarations", "packetFingerprint"
  ], "adjudication packet");
  if (packet.schemaVersion !== "review-bench-adjudication-packet/v1") {
    throw new Error("packet schemaVersion must be review-bench-adjudication-packet/v1");
  }
  if (!/^packet:[a-f0-9]{32}$/.test(packet.packetId)) throw new Error("packetId must be opaque");
  requireSha256(packet.sourceArtifactSha256, "packet.sourceArtifactSha256");
  if (!LANGUAGES.includes(packet.language)) throw new Error("packet language is unsupported");
  requireVersion(packet.rubricVersion, "packet.rubricVersion");
  requireSha256(packet.rubricSha256, "packet.rubricSha256");
  requireVersion(packet.protocolVersion, "packet.protocolVersion");
  requireSha256(packet.protocolSha256, "packet.protocolSha256");
  validateBlindedAnnotationUniverse(packet.annotationUniverse);
  if (packet.annotationUniverse.methodVersion !== packet.protocolVersion ||
      packet.annotationUniverse.methodSha256 !== packet.protocolSha256) {
    throw new Error("packet annotation universe must bind the exact adjudication protocol");
  }
  requireIsoTimestamp(packet.preparedAt, "packet.preparedAt");
  requireExactKeys(packet.declarations, [
    "providerIdentityExcluded", "peerDecisionsExcluded", "oracleGoldAnswersExcluded"
  ], "packet.declarations");
  if (packet.declarations.providerIdentityExcluded !== true ||
      packet.declarations.peerDecisionsExcluded !== true ||
      packet.declarations.oracleGoldAnswersExcluded !== true) {
    throw new Error("packet exclusion declarations must all be true");
  }
  requireSha256(packet.packetFingerprint, "packetFingerprint");
  const basis = buildPacketFingerprintBasis(packet);
  if (sha256(stableJson(basis)) !== packet.packetFingerprint) {
    throw new Error("packet fingerprint does not match canonical packet bytes");
  }
}

function validateBlindedAnnotationUniverse(universe: ReviewBenchBlindedAnnotationUniverseV1): void {
  requireExactKeys(
    universe,
    ["schemaVersion", "frozenAt", "methodVersion", "methodSha256", "candidates"],
    "packet.annotationUniverse"
  );
  if (universe.schemaVersion !== "review-bench-blinded-annotation-universe/v1") {
    throw new Error("packet annotation universe schemaVersion is invalid");
  }
  requireIsoTimestamp(universe.frozenAt, "packet.annotationUniverse.frozenAt");
  requireVersion(universe.methodVersion, "packet.annotationUniverse.methodVersion");
  requireSha256(universe.methodSha256, "packet.annotationUniverse.methodSha256");
  if (!Array.isArray(universe.candidates) || universe.candidates.length > 100) {
    throw new Error("packet annotation candidates must contain 0-100 entries");
  }
  const ids = new Set<string>();
  for (const [index, item] of universe.candidates.entries()) {
    requireExactKeys(
      item,
      ["id", "path", "line", "sourceCandidateCommitmentSha256", "question"],
      `packet.annotationUniverse.candidates[${index}]`
    );
    if (!/^item:[a-f0-9]{32}$/.test(item.id)) throw new Error("packet candidate id must be opaque");
    if (ids.has(item.id)) throw new Error(`duplicate packet candidate id: ${item.id}`);
    ids.add(item.id);
    requireCanonicalPath(item.path, `packet.annotationUniverse.candidates[${index}].path`);
    if (!Number.isSafeInteger(item.line) || item.line < 1) throw new Error("packet candidate line must be positive");
    requireSha256(item.sourceCandidateCommitmentSha256, `packet candidate ${item.id} commitment`);
    if (item.question !== BLINDED_ACTIONABILITY_QUESTION) {
      throw new Error(`packet candidate ${item.id} must use the fixed blinded actionability question`);
    }
  }
}

function validateAnnotationUniverse(universe: ReviewBenchAnnotationUniverseV1): void {
  requireExactKeys(universe, ["schemaVersion", "frozenAt", "methodVersion", "methodSha256", "candidates"], "annotationUniverse");
  if (universe.schemaVersion !== "review-bench-annotation-universe/v1") {
    throw new Error("annotationUniverse schemaVersion is invalid");
  }
  requireIsoTimestamp(universe.frozenAt, "annotationUniverse.frozenAt");
  requireVersion(universe.methodVersion, "annotationUniverse.methodVersion");
  requireSha256(universe.methodSha256, "annotationUniverse.methodSha256");
  if (!Array.isArray(universe.candidates) || universe.candidates.length > 100) {
    throw new Error("annotationUniverse candidates must contain 0-100 entries");
  }
  const ids = new Set<string>();
  const contentKeys = new Set<string>();
  for (const [index, item] of universe.candidates.entries()) {
    requireExactKeys(item, ["id", "path", "line", "title", "body"], `annotationUniverse.candidates[${index}]`);
    requireBoundedText(item.id, 1, 128, `annotationUniverse.candidates[${index}].id`);
    if (ids.has(item.id)) throw new Error(`duplicate annotation candidate id: ${item.id}`);
    ids.add(item.id);
    requireCanonicalPath(item.path, `annotationUniverse.candidates[${index}].path`);
    if (!Number.isSafeInteger(item.line) || item.line < 1) throw new Error("annotation candidate line must be positive");
    requireBoundedText(item.title, 1, 500, `annotationUniverse.candidates[${index}].title`);
    requireBoundedText(item.body, 1, 4_000, `annotationUniverse.candidates[${index}].body`);
    rejectSecretText(`${item.title}\n${item.body}`, `annotation candidate ${item.id}`);
    const contentKey = stableJson({ path: item.path, line: item.line, title: item.title, body: item.body });
    if (contentKeys.has(contentKey)) throw new Error("annotationUniverse candidates contain duplicate candidate content");
    contentKeys.add(contentKey);
  }
}

function buildBlindedAnnotationUniverse(
  candidate: ReviewBenchAdjudicationCandidateV1
): ReviewBenchBlindedAnnotationUniverseV1 {
  return {
    schemaVersion: "review-bench-blinded-annotation-universe/v1",
    frozenAt: candidate.annotationUniverse.frozenAt,
    methodVersion: candidate.annotationUniverse.methodVersion,
    methodSha256: candidate.annotationUniverse.methodSha256,
    candidates: [...candidate.annotationUniverse.candidates]
      .sort((a, b) => compareFixed(a.path, b.path) || a.line - b.line || compareFixed(a.id, b.id))
      .map((item) => {
        const sourceCandidateCommitmentSha256 = createHmac(
          "sha256",
          Buffer.from(candidate.blindingNonce, "hex")
        ).update(stableJson({
          path: item.path,
          line: item.line,
          title: item.title,
          body: item.body
        })).digest("hex");
        return {
          id: `item:${sha256(stableJson({
            sourceArtifactSha256: candidate.sourceArtifactSha256,
            path: item.path,
            line: item.line,
            sourceCandidateCommitmentSha256
          })).slice(0, 32)}`,
          path: item.path,
          line: item.line,
          sourceCandidateCommitmentSha256,
          question: BLINDED_ACTIONABILITY_QUESTION
        };
      })
  };
}

function validateResponse(
  response: ReviewBenchAdjudicationResponseV1,
  packet: ReviewBenchAdjudicationPacketV1,
  label: string
): void {
  requireExactKeys(response, [
    "schemaVersion", "packetFingerprint", "adjudicatorId", "verdict", "decisions", "rationale",
    "completedAt", "blindedToProviderIdentity", "blindedToPeerDecision"
  ], label);
  if (response.schemaVersion !== "review-bench-adjudication-response/v1") throw new Error(`${label} schemaVersion is invalid`);
  validateResponseCommon(response, packet, label);
  if (response.blindedToPeerDecision !== true) throw new Error(`${label} must declare peer-decision blinding`);
}

function validateResolverResponse(
  response: ReviewBenchAdjudicationResolverResponseV1,
  packet: ReviewBenchAdjudicationPacketV1
): void {
  requireExactKeys(response, [
    "schemaVersion", "packetFingerprint", "adjudicatorId", "verdict", "decisions", "rationale",
    "completedAt", "blindedToProviderIdentity", "reviewedDisagreement"
  ], "resolver response");
  if (response.schemaVersion !== "review-bench-adjudication-resolver-response/v1") {
    throw new Error("resolver response schemaVersion is invalid");
  }
  validateResponseCommon(response, packet, "resolver response");
  if (response.reviewedDisagreement !== true) throw new Error("resolver must declare reviewedDisagreement");
}

function validateResponseCommon(
  response: Omit<ReviewBenchAdjudicationResponseV1, "schemaVersion" | "blindedToPeerDecision"> |
    Omit<ReviewBenchAdjudicationResolverResponseV1, "schemaVersion" | "reviewedDisagreement">,
  packet: ReviewBenchAdjudicationPacketV1,
  label: string
): void {
  if (response.packetFingerprint !== packet.packetFingerprint) throw new Error(`${label} packet fingerprint mismatch`);
  if (!/^human:[a-z0-9][a-z0-9._-]{1,63}$/.test(response.adjudicatorId)) {
    throw new Error(`${label} adjudicator identity must be canonical ASCII human:*`);
  }
  if (response.verdict !== "defect_present" && response.verdict !== "verified_clean") {
    throw new Error(`${label} verdict is invalid`);
  }
  requireBoundedText(response.rationale, 1, MAX_RATIONALE_CHARS, `${label}.rationale`);
  rejectSecretText(response.rationale, `${label}.rationale`);
  requireIsoTimestamp(response.completedAt, `${label}.completedAt`);
  if (response.blindedToProviderIdentity !== true) throw new Error(`${label} must declare provider-identity blinding`);
  validateDecisions(response.decisions, packet, label);
  const actionableCount = response.decisions.filter((decision) => decision.actionability === "actionable").length;
  if ((response.verdict === "defect_present") !== (actionableCount > 0)) {
    throw new Error(`${label} verdict must be defect_present iff at least one candidate is actionable`);
  }
}

function validateDecisions(
  decisions: ReviewBenchAdjudicationDecisionV1[],
  packet: ReviewBenchAdjudicationPacketV1,
  label: string
): void {
  if (!Array.isArray(decisions)) throw new Error(`${label} decisions must be an array`);
  const expected = new Set(packet.annotationUniverse.candidates.map((candidate) => candidate.id));
  const seen = new Set<string>();
  for (const [index, decision] of decisions.entries()) {
    requireExactKeys(
      decision,
      ["candidateId", "actionability", "severity"],
      `${label}.decisions[${index}]`,
      ["severity"]
    );
    if (!expected.has(decision.candidateId)) throw new Error(`${label} contains an extra candidate decision`);
    if (seen.has(decision.candidateId)) throw new Error(`${label} contains a duplicate candidate decision`);
    seen.add(decision.candidateId);
    if (decision.actionability !== "actionable" && decision.actionability !== "not_actionable") {
      throw new Error(`${label} actionability is invalid`);
    }
    if (decision.severity !== undefined && !SEVERITIES.includes(decision.severity)) {
      throw new Error(`${label} severity is invalid`);
    }
    if (decision.actionability === "actionable" && decision.severity === undefined) {
      throw new Error(`${label} severity is required for actionable decisions`);
    }
    if (decision.actionability === "not_actionable" && decision.severity !== undefined) {
      throw new Error(`${label} severity is forbidden for not_actionable decisions`);
    }
  }
  if (seen.size !== expected.size) throw new Error(`${label} must contain a complete candidate decision set`);
}

function buildDisagreementQueue(
  packet: ReviewBenchAdjudicationPacketV1,
  primary: ReviewBenchAdjudicationResponseV1,
  secondary: ReviewBenchAdjudicationResponseV1,
  primaryById: Map<string, ReviewBenchAdjudicationDecisionV1>,
  secondaryById: Map<string, ReviewBenchAdjudicationDecisionV1>
): ReviewBenchAdjudicationDisagreementV1 {
  const candidateDisagreements = packet.annotationUniverse.candidates
    .map((candidate) => {
      const one = primaryById.get(candidate.id)!;
      const two = secondaryById.get(candidate.id)!;
      const severityDisagreement = one.actionability === "actionable" && two.actionability === "actionable" &&
        one.severity !== two.severity;
      if (one.actionability === two.actionability && !severityDisagreement) return undefined;
      return { candidateId: candidate.id, primary: normalizeDecision(one), secondary: normalizeDecision(two) };
    })
    .filter((item): item is NonNullable<typeof item> => item !== undefined)
    .sort((a, b) => compareFixed(a.candidateId, b.candidateId));
  return {
    schemaVersion: "review-bench-adjudication-disagreement/v1",
    ...(primary.verdict === secondary.verdict ? {} : {
      verdictDisagreement: { primary: primary.verdict, secondary: secondary.verdict }
    }),
    candidateDisagreements
  };
}

function resolveDisagreements(
  packet: ReviewBenchAdjudicationPacketV1,
  primary: ReviewBenchAdjudicationResponseV1,
  secondary: ReviewBenchAdjudicationResponseV1,
  resolver: ReviewBenchAdjudicationResolverResponseV1,
  queue: ReviewBenchAdjudicationDisagreementV1,
  primaryById: Map<string, ReviewBenchAdjudicationDecisionV1>,
  secondaryById: Map<string, ReviewBenchAdjudicationDecisionV1>
): string {
  const resolverById = decisionMap(resolver.decisions);
  const disputed = new Set(queue.candidateDisagreements.map((item) => item.candidateId));
  const decisions = packet.annotationUniverse.candidates.map((candidate) => {
    const one = primaryById.get(candidate.id)!;
    const two = secondaryById.get(candidate.id)!;
    const resolved = resolverById.get(candidate.id)!;
    if (!disputed.has(candidate.id)) {
      if (stableJson(normalizeDecision(resolved)) !== stableJson(normalizeDecision(one)) ||
          stableJson(normalizeDecision(one)) !== stableJson(normalizeDecision(two))) {
        throw new Error(`resolver changed an undisputed candidate unit: ${candidate.id}`);
      }
      return normalizeDecision(one);
    }
    return normalizeDecision(resolved);
  });
  if (queue.verdictDisagreement === undefined && resolver.verdict !== primary.verdict) {
    throw new Error("resolver changed an undisputed artifact verdict");
  }
  const verdict = queue.verdictDisagreement === undefined ? primary.verdict : resolver.verdict;
  return computeResolvedDecisionSha256(verdict, decisions);
}

function computeAgreementCounts(
  packet: ReviewBenchAdjudicationPacketV1,
  primary: ReviewBenchAdjudicationResponseV1,
  secondary: ReviewBenchAdjudicationResponseV1,
  primaryById: Map<string, ReviewBenchAdjudicationDecisionV1>,
  secondaryById: Map<string, ReviewBenchAdjudicationDecisionV1>
): Omit<ReviewBenchAdjudicationReceiptV1,
  "schemaVersion" | "packetFingerprint" | "packetSha256" | "primaryResponseSha256" |
  "secondaryResponseSha256" | "primaryAdjudicatorId" | "secondaryAdjudicatorId" | "status" |
  "disagreementCount" | "disagreementQueue" | "disagreementQueueSha256" | "verifiedAt" | "receiptSha256" |
  "resolverResponseSha256" | "resolverAdjudicatorId" | "resolvedDecisionSha256"> {
  let both = 0;
  let primaryOnly = 0;
  let secondaryOnly = 0;
  let neither = 0;
  let severityBoth = 0;
  let severityWithinOne = 0;
  for (const candidate of packet.annotationUniverse.candidates) {
    const one = primaryById.get(candidate.id)!;
    const two = secondaryById.get(candidate.id)!;
    const oneActionable = one.actionability === "actionable";
    const twoActionable = two.actionability === "actionable";
    if (oneActionable && twoActionable) {
      both += 1;
      if (one.severity !== undefined && two.severity !== undefined) {
        severityBoth += 1;
        if (Math.abs(SEVERITIES.indexOf(one.severity) - SEVERITIES.indexOf(two.severity)) <= 1) {
          severityWithinOne += 1;
        }
      }
    } else if (oneActionable) primaryOnly += 1;
    else if (twoActionable) secondaryOnly += 1;
    else neither += 1;
  }
  return {
    artifactBothDefectCount: primary.verdict === "defect_present" && secondary.verdict === "defect_present" ? 1 : 0,
    artifactPrimaryOnlyDefectCount: primary.verdict === "defect_present" && secondary.verdict === "verified_clean" ? 1 : 0,
    artifactSecondaryOnlyDefectCount: primary.verdict === "verified_clean" && secondary.verdict === "defect_present" ? 1 : 0,
    artifactBothCleanCount: primary.verdict === "verified_clean" && secondary.verdict === "verified_clean" ? 1 : 0,
    actionabilityBothActionableCount: both,
    actionabilityPrimaryOnlyCount: primaryOnly,
    actionabilitySecondaryOnlyCount: secondaryOnly,
    actionabilityNeitherCount: neither,
    severityBothActionableCount: severityBoth,
    severityWithinOneTierCount: severityWithinOne
  };
}

function reverifyPacketArtifacts(packetPath: string, packet: ReviewBenchAdjudicationPacketV1): void {
  const directory = requireRealDirectory(dirname(realpathSync(resolve(packetPath))), "packet directory");
  const source = readDigestArtifact(directory, packet.sourceArtifactSha256, ".diff", MAX_DIFF_BYTES, "packet source artifact");
  const rubric = readDigestArtifact(directory, packet.rubricSha256, ".rubric.md", MAX_MARKDOWN_BYTES, "packet rubric artifact");
  const protocol = readDigestArtifact(directory, packet.protocolSha256, ".protocol.md", MAX_MARKDOWN_BYTES, "packet protocol artifact");
  const sourceText = decodeUtf8(source, "packet source artifact");
  const rubricText = decodeUtf8(rubric, "packet rubric artifact");
  const protocolText = decodeUtf8(protocol, "packet protocol artifact");
  rejectSecretText(sourceText, "packet source artifact");
  rejectSecretText(rubricText, "packet rubric artifact");
  rejectSecretText(protocolText, "packet protocol artifact");
  validateVersionedMarkdown(rubricText, packet.rubricVersion, "packet rubric artifact");
  validateVersionedMarkdown(protocolText, packet.protocolVersion, "packet protocol artifact");
  validateCandidateAnchors(packet, sourceText);
}

function validateCandidateAnchors(
  candidate: {
    language: ReviewBenchLanguage;
    annotationUniverse: { candidates: ReadonlyArray<{ id: string; path: string; line: number }> };
  },
  diff: string
): void {
  const { anchors, changedPaths } = parseDiffAnchors(diff);
  if (![...changedPaths].some((path) => LANGUAGE_EXTENSIONS[candidate.language].includes(extname(path).toLowerCase()))) {
    throw new Error("candidate language must match a changed source-file path");
  }
  for (const annotation of candidate.annotationUniverse.candidates) {
    if (!anchors.get(annotation.path)?.has(annotation.line)) {
      throw new Error(`annotation candidate is not a final-side diff anchor: ${annotation.id}`);
    }
  }
}

function parseDiffAnchors(diff: string): {
  anchors: Map<string, Set<number>>;
  changedPaths: Set<string>;
} {
  const lines = diff.split("\n");
  const anchors = new Map<string, Set<number>>();
  const changedPaths = new Set<string>();
  let path: string | undefined;
  let newLine = 0;
  let inHunk = false;
  let hasFinalSide = true;
  let hasOldSide = true;
  let oldHeaderSeen = false;
  let newHeaderSeen = false;
  let sectionHasHunk = false;
  let oldRemaining = 0;
  let newRemaining = 0;
  const requireBalancedHunk = (): void => {
    if (inHunk && (oldRemaining !== 0 || newRemaining !== 0)) {
      throw new Error("source diff hunk body does not match its declared line counts");
    }
  };
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      requireBalancedHunk();
      if (path !== undefined && !sectionHasHunk) {
        throw new Error("source diff section must contain at least one validated hunk");
      }
      const match = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
      if (!match || match[1] !== match[2]) throw new Error("source diff has unsafe or unsupported paths");
      path = match[2];
      requireCanonicalPath(path, "source diff path");
      inHunk = false;
      hasFinalSide = true;
      hasOldSide = true;
      oldHeaderSeen = false;
      newHeaderSeen = false;
      sectionHasHunk = false;
      continue;
    }
    if (!inHunk && line.startsWith("--- ")) {
      if (path === undefined) throw new Error("source diff old-side header lacks a diff --git path");
      if (oldHeaderSeen || newHeaderSeen) throw new Error("source diff old-side header is duplicated or out of order");
      if (line === "--- /dev/null") {
        hasOldSide = false;
      } else {
        const match = /^--- a\/(\S+)$/.exec(line);
        if (!match || match[1] !== path) throw new Error("source diff old-side header path must match diff --git");
        requireCanonicalPath(match[1], "source diff old-side path");
      }
      oldHeaderSeen = true;
      continue;
    }
    if (!inHunk && line.startsWith("+++ ")) {
      if (path === undefined) throw new Error("source diff final-side header lacks a diff --git path");
      if (!oldHeaderSeen || newHeaderSeen) {
        throw new Error("source diff final-side header requires one preceding old-side header");
      }
      if (line === "+++ /dev/null") {
        hasFinalSide = false;
      } else {
        const match = /^\+\+\+ b\/(\S+)$/.exec(line);
        if (!match || match[1] !== path) throw new Error("source diff final-side header path must match diff --git");
        requireCanonicalPath(match[1], "source diff final-side path");
      }
      if (!hasOldSide && !hasFinalSide) {
        throw new Error("source diff cannot have both old and final sides set to /dev/null");
      }
      newHeaderSeen = true;
      continue;
    }
    if (line.startsWith("@@ ")) {
      requireBalancedHunk();
      if (!oldHeaderSeen || !newHeaderSeen) {
        throw new Error("source diff hunk requires matching old-side and final-side headers");
      }
      const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/.exec(line);
      if (!match || path === undefined) throw new Error("source diff hunk is malformed or lacks a final-side path");
      const oldStart = Number(match[1]);
      oldRemaining = match[2] === undefined ? 1 : Number(match[2]);
      newLine = Number(match[3]);
      newRemaining = match[4] === undefined ? 1 : Number(match[4]);
      if (![oldStart, oldRemaining, newLine, newRemaining].every(Number.isSafeInteger) ||
          oldStart < 0 || oldRemaining < 0 || newLine < 0 || newRemaining < 0 ||
          (oldRemaining > 0 && oldStart < 1) ||
          (newRemaining > 0 && newLine < 1)) {
        throw new Error("source diff hunk has invalid line coordinates or counts");
      }
      if ((!hasOldSide && oldRemaining !== 0) || (!hasFinalSide && newRemaining !== 0)) {
        throw new Error("source diff /dev/null side must have a zero hunk line count");
      }
      if (oldRemaining === 0 && newRemaining === 0) {
        throw new Error("source diff hunk cannot be empty on both sides");
      }
      inHunk = true;
      sectionHasHunk = true;
      changedPaths.add(path);
      continue;
    }
    if (!inHunk || path === undefined || line === "\\ No newline at end of file") continue;
    if (line === "" && oldRemaining === 0 && newRemaining === 0) {
      inHunk = false;
      continue;
    }
    if (line.startsWith("-")) {
      oldRemaining -= 1;
    } else if (line.startsWith("+") || line.startsWith(" ")) {
      if (line.startsWith(" ")) oldRemaining -= 1;
      newRemaining -= 1;
      if (hasFinalSide) {
      const set = anchors.get(path) ?? new Set<number>();
      set.add(newLine);
      anchors.set(path, set);
      }
      newLine += 1;
    } else {
      throw new Error("source diff contains a malformed hunk line");
    }
    if (oldRemaining < 0 || newRemaining < 0) {
      throw new Error("source diff hunk body exceeds its declared line counts");
    }
  }
  requireBalancedHunk();
  if (path !== undefined && !sectionHasHunk) {
    throw new Error("source diff section must contain at least one validated hunk");
  }
  if (changedPaths.size === 0) throw new Error("source diff contains no changed paths");
  return { anchors, changedPaths };
}

function readCanonicalJson<T>(path: string, maximumBytes: number, label: string): T {
  return readCanonicalJsonWithBytes<T>(path, maximumBytes, label).value;
}

function readCanonicalJsonWithBytes<T>(
  path: string,
  maximumBytes: number,
  label: string
): { value: T; bytes: Uint8Array } {
  const bytes = readBoundedRegularFile(resolve(path), maximumBytes, label);
  const text = decodeUtf8(bytes, label);
  rejectSecretText(text, label);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${label} must be valid JSON`);
  }
  const canonical = stableJson(value);
  if (text !== canonical && text !== `${canonical}\n`) {
    throw new Error(`${label} must use canonical JSON without duplicate keys`);
  }
  return { value: value as T, bytes };
}

function readDigestArtifact(
  directory: string,
  digest: string,
  suffix: string,
  maximumBytes: number,
  label: string
): Uint8Array {
  requireSha256(digest, `${label} digest`);
  const expectedPath = resolve(directory, `${digest}${suffix}`);
  const expectedStat = lstatSync(expectedPath);
  if (expectedStat.isSymbolicLink() || !expectedStat.isFile()) {
    throw new Error(`${label} must be a regular non-symbolic artifact`);
  }
  const real = realpathSync(expectedPath);
  const rel = relative(directory, real);
  if (rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) throw new Error(`${label} path escapes artifacts directory`);
  const bytes = readBoundedRegularFile(real, maximumBytes, label);
  if (sha256(bytes) !== digest) throw new Error(`${label} sha256 digest mismatch`);
  return bytes;
}

function readBoundedRegularFile(path: string, maximumBytes: number, label: string): Uint8Array {
  const descriptor = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.size < 1 || before.size > maximumBytes) {
      throw new Error(`${label} must be a regular file containing 1-${maximumBytes} bytes`);
    }
    const buffer = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const count = readSync(descriptor, buffer, offset, buffer.byteLength - offset, offset);
      if (count === 0) throw new Error(`${label} changed while being read`);
      offset += count;
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

function writeExclusive(path: string, bytes: Uint8Array): void {
  const descriptor = openSync(
    path,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0),
    0o600
  );
  try {
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function assertFinalArtifact(path: string, expected: Uint8Array, label: string): void {
  const actual = readBoundedRegularFile(path, Math.max(expected.byteLength, 1), label);
  if (actual.byteLength !== expected.byteLength || sha256(actual) !== sha256(expected)) {
    throw new Error(`${label} changed after publication`);
  }
}

interface SafeParent {
  path: string;
  device: number;
  inode: number;
}

function captureSafeParent(path: string, label: string): SafeParent {
  const real = realpathSync(resolve(path));
  const stats = statSync(real);
  if (!stats.isDirectory()) throw new Error(`${label} must be an existing directory`);
  if ((stats.mode & 0o022) !== 0) {
    throw new Error(`${label} must not be writable by group or other users`);
  }
  if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
    throw new Error(`${label} must be owned by the current user`);
  }
  requireOutsideGitPath(real, label);
  return { path: real, device: stats.dev, inode: stats.ino };
}

function assertSafeParent(parent: SafeParent, label: string): void {
  const real = realpathSync(parent.path);
  const stats = statSync(real);
  if (real !== parent.path || !stats.isDirectory() || stats.dev !== parent.device || stats.ino !== parent.inode) {
    throw new Error(`${label} changed during publication`);
  }
  if ((stats.mode & 0o022) !== 0 ||
      (typeof process.getuid === "function" && stats.uid !== process.getuid())) {
    throw new Error(`${label} lost its private ownership boundary during publication`);
  }
  requireOutsideGitPath(real, label);
}

function requireOutsideGitPath(path: string, label: string): void {
  let current = path;
  while (true) {
    if (existsSync(join(current, ".git"))) throw new Error(`${label} must be outside a Git checkout`);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function requireSinglePathComponent(value: string, label: string): string {
  if (value.length === 0 || Buffer.byteLength(value, "utf8") > 128 || value === "." || value === ".." ||
      value.includes("/") || value.includes("\\") || value.includes("\0")) {
    throw new Error(`${label} must be one safe path component of at most 128 UTF-8 bytes`);
  }
  return value;
}

function publishImmutableFile(parent: SafeParent, leaf: string, bytes: Uint8Array, label: string): void {
  assertSafeParent(parent, `${label} parent`);
  const finalPath = join(parent.path, leaf);
  if (existsSync(finalPath)) throw new Error(`${label} destination already exists; no-clobber publication refused`);
  const temporaryPath = join(parent.path, `.${leaf}.${randomUUID()}.tmp`);
  let installed = false;
  try {
    writeExclusive(temporaryPath, bytes);
    assertFinalArtifact(temporaryPath, bytes, `${label} temporary output`);
    assertSafeParent(parent, `${label} parent`);
    linkSync(temporaryPath, finalPath);
    installed = true;
    assertFinalArtifact(finalPath, bytes, `${label} output`);
    assertSafeParent(parent, `${label} parent`);
  } catch (error) {
    if (installed) {
      try {
        unlinkSync(finalPath);
      } catch {
        // Preserve the original publication failure; the caller still fails closed.
      }
    }
    throw error;
  } finally {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // The temporary path may not have been created or may already be gone.
    }
  }
}

function removeOwnedDirectory(path: string, identity: SafeParent | undefined): void {
  try {
    if (identity !== undefined) {
      assertSafeParent(identity, "owned output directory");
      if (realpathSync(path) !== identity.path) return;
    } else if (lstatSync(path).isSymbolicLink()) {
      return;
    }
    rmSync(path, { recursive: true, force: true });
  } catch {
    // Never broaden cleanup after a failed security check.
  }
}

function requireRealDirectory(path: string, label: string): string {
  const resolved = realpathSync(resolve(path));
  if (!statSync(resolved).isDirectory()) throw new Error(`${label} must be a directory`);
  return resolved;
}

function decodeUtf8(bytes: Uint8Array, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label} must be valid UTF-8`);
  }
}

function rejectSecretText(text: string, label: string): void {
  if (containsSecretLikeText(text)) throw new Error(`${label} contains secret-like text`);
}

function validateVersionedMarkdown(text: string, version: string, label: string): void {
  if (!text.startsWith(`# ${version}\n`)) throw new Error(`${label} must declare its exact version in the first heading`);
}

function requireExactKeys(
  value: unknown,
  allowed: readonly string[],
  label: string,
  optional: readonly string[] = []
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const extras = Object.keys(value).filter((key) => !allowed.includes(key)).sort(compareFixed);
  if (extras.length > 0) throw new Error(`${label} has unknown keys: ${extras.join(", ")}`);
  const missing = allowed.filter((key) => !optional.includes(key) && !(key in value));
  if (missing.length > 0) throw new Error(`${label} is missing keys: ${missing.join(", ")}`);
}

function buildPacketFingerprintBasis(
  packet: ReviewBenchAdjudicationPacketBasisV1 | ReviewBenchAdjudicationPacketV1
): ReviewBenchAdjudicationPacketBasisV1 {
  return {
    schemaVersion: packet.schemaVersion,
    packetId: packet.packetId,
    sourceArtifactSha256: packet.sourceArtifactSha256,
    language: packet.language,
    annotationUniverse: packet.annotationUniverse,
    rubricVersion: packet.rubricVersion,
    rubricSha256: packet.rubricSha256,
    protocolVersion: packet.protocolVersion,
    protocolSha256: packet.protocolSha256,
    preparedAt: packet.preparedAt,
    declarations: packet.declarations
  };
}

function requireCanonicalPath(path: string, label: string): void {
  if (typeof path !== "string" || path.length === 0 || path.length > 1_000 || isAbsolute(path) ||
      path.includes("\\") || path.includes("\0") || path.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`${label} must be a canonical repository-relative path`);
  }
}

function requireBoundedText(value: string, minimum: number, maximum: number, label: string): void {
  if (typeof value !== "string" || value.trim() !== value || value.length < minimum || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${label} must contain ${minimum}-${maximum} bounded printable characters`);
  }
}

function requireVersion(value: string, label: string): void {
  requireBoundedText(value, 3, 128, label);
  if (!/^[a-z0-9][a-z0-9._/-]*\/v[1-9][0-9]*$/.test(value)) throw new Error(`${label} must be a versioned identifier ending in /vN`);
}

function requireSha256(value: string, label: string): void {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`${label} must be a lowercase SHA-256 digest`);
}

function requireIsoTimestamp(value: string, label: string): void {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
      !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error(`${label} must be a canonical UTC ISO timestamp`);
  }
}

function validateResponseChronology(completedAt: string, preparedAt: string, verifiedAt: string, label: string): void {
  if (Date.parse(completedAt) < Date.parse(preparedAt) || Date.parse(completedAt) > Date.parse(verifiedAt)) {
    throw new Error(`${label} chronology must fall between preparedAt and verifiedAt`);
  }
}

function decisionMap(decisions: readonly ReviewBenchAdjudicationDecisionV1[]): Map<string, ReviewBenchAdjudicationDecisionV1> {
  return new Map(decisions.map((decision) => [decision.candidateId, decision]));
}

function normalizeDecision(decision: ReviewBenchAdjudicationDecisionV1): ReviewBenchAdjudicationDecisionV1 {
  return {
    candidateId: decision.candidateId,
    actionability: decision.actionability,
    ...(decision.severity === undefined ? {} : { severity: decision.severity })
  };
}

function computeResolvedDecisionSha256(
  verdict: ReviewBenchAdjudicationResponseV1["verdict"],
  decisions: readonly ReviewBenchAdjudicationDecisionV1[]
): string {
  return sha256(stableJson({
    verdict,
    decisions: [...decisions].map(normalizeDecision).sort((a, b) => compareFixed(a.candidateId, b.candidateId))
  }));
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => compareFixed(a, b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function compareFixed(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
