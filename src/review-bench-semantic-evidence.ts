import { createHash } from "node:crypto";
import type {
  ReviewBenchArtifactSemantics,
  ReviewBenchOracleKind,
  ReviewBenchScenarioV1
} from "./review-bench-corpus.js";
import { containsSecretLikeText } from "./secrets.js";
import type { Severity } from "./types.js";

export const REVIEW_BENCH_ORACLE_EVIDENCE_VERSION = "review-bench-oracle-evidence/v2" as const;
export const REVIEW_BENCH_SEMANTIC_EVIDENCE_VERIFIER_VERSION =
  "review-bench-semantic-admission/v2" as const;
export const REVIEW_BENCH_ADJUDICATION_AGREEMENT_VERSION =
  "review-bench-adjudication-agreement/v2" as const;
export const REVIEW_BENCH_CANDIDATE_ACTIONABILITY_VERSION =
  "review-bench-candidate-actionability/v1" as const;
export const REVIEW_BENCH_MAX_ORACLE_EVIDENCE_BYTES = 1024 * 1024;

export type ReviewBenchEvidenceRelation =
  | "defect_present_in_reviewed_artifact"
  | "verified_clean_exact_artifact";

export interface ReviewBenchOracleLabelEvidenceV1 {
  labelId: string;
  sourceEvidenceSha256: string;
  sourcePath: string;
  sourceLine: number | null;
  rationale: string;
}

export interface ReviewBenchCleanObservationV1 {
  schemaVersion: "review-bench-clean-observation/v1";
  sourceUrl: string;
  sourceRevision: string;
  sourceEvidenceSha256: string;
  observedThrough: string;
  minimumCleanDays: number;
  checkedSignals: ["hotfix", "linked_defect", "revert"];
  evidenceSummary: string;
}

export interface ReviewBenchLabelDecisionV1 {
  labelId: string;
  actionability: "actionable" | "not_actionable";
  severity?: Severity;
}

export interface ReviewBenchAnnotationCandidateV1 {
  id: string;
  path: string;
  line: number;
  title: string;
  body: string;
}

export interface ReviewBenchAnnotationUniverseV1 {
  schemaVersion: "review-bench-annotation-universe/v1";
  frozenAt: string;
  methodVersion: string;
  methodSha256: string;
  candidates: ReviewBenchAnnotationCandidateV1[];
}

export interface ReviewBenchPrimaryDecisionV1 {
  adjudicatorId: string;
  verdict: ReviewBenchArtifactSemantics;
  labels: ReviewBenchLabelDecisionV1[];
  rationale: string;
  completedAt: string;
  blindedToProviderIdentity: true;
  blindedToPeerDecision: true;
}

export interface ReviewBenchResolverDecisionV1 {
  adjudicatorId: string;
  verdict: ReviewBenchArtifactSemantics;
  labels: ReviewBenchLabelDecisionV1[];
  rationale: string;
  completedAt: string;
  blindedToProviderIdentity: true;
  reviewedDisagreement: true;
}

export interface ReviewBenchOracleEvidenceV1 {
  schemaVersion: typeof REVIEW_BENCH_ORACLE_EVIDENCE_VERSION;
  scenarioId: string;
  repository: string;
  reviewedSourceRevision: string;
  reviewedSourceArtifactSha256: string;
  artifactSemantics: ReviewBenchArtifactSemantics;
  annotationUniverse: ReviewBenchAnnotationUniverseV1;
  oracle: {
    kind: ReviewBenchOracleKind;
    sourceUrl: string;
    sourceRevision: string;
    relation: ReviewBenchEvidenceRelation;
    sourceEvidenceSha256: string;
    labelEvidence: ReviewBenchOracleLabelEvidenceV1[];
    evidenceSummary: string;
    observedAt: string;
  };
  cleanObservation?: ReviewBenchCleanObservationV1;
  rubricVersion: string;
  rubricSha256: string;
  protocolVersion: string;
  protocolSha256: string;
  adjudicationMethod: string;
  adjudicationCompletedAt: string;
  coveredLabelIds: string[];
  goldLabelsSha256: string;
  primary: ReviewBenchPrimaryDecisionV1;
  secondary: ReviewBenchPrimaryDecisionV1;
  resolver?: ReviewBenchResolverDecisionV1;
}

export interface ReviewBenchSemanticEvidenceRecord {
  scenarioId: string;
  evidenceSha256: string;
  oracleObservedAt: string;
  oracleSourceEvidenceSha256: string;
  oracleLabelEvidence: ReviewBenchOracleLabelEvidenceV1[];
  annotationUniverse: ReviewBenchAnnotationUniverseV1;
  cleanObservation?: ReviewBenchCleanObservationV1;
  primaryVerdict: ReviewBenchArtifactSemantics;
  secondaryVerdict: ReviewBenchArtifactSemantics;
  candidateAgreement?: ReviewBenchCandidateAgreementV1;
  labelAgreement: Array<{
    labelId: string;
    primaryActionability: ReviewBenchLabelDecisionV1["actionability"];
    secondaryActionability: ReviewBenchLabelDecisionV1["actionability"];
    primarySeverity?: Severity;
    secondarySeverity?: Severity;
  }>;
}

export interface ReviewBenchCandidateAgreementV1 {
  version: typeof REVIEW_BENCH_CANDIDATE_ACTIONABILITY_VERSION;
  candidateUniverseSha256: string;
  candidateUnitCount: number;
  bothActionableCount: number;
  primaryOnlyCount: number;
  secondaryOnlyCount: number;
  neitherCount: number;
}

export interface ReviewBenchAdjudicationAgreementV1 {
  version: typeof REVIEW_BENCH_ADJUDICATION_AGREEMENT_VERSION;
  scenarioCount: number;
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
  severityLabelCount: number;
  severityWithinOneTierAgreement: number;
}

export function computeReviewBenchAdjudicationAgreement(
  records: ReadonlyArray<ReviewBenchSemanticEvidenceRecord>
): ReviewBenchAdjudicationAgreementV1 {
  if (records.length < 2) throw new Error("adjudication agreement requires at least two scenarios");
  let actionabilityItemCount = 0;
  let actionabilityBothActionableCount = 0;
  let actionabilityPrimaryOnlyCount = 0;
  let actionabilitySecondaryOnlyCount = 0;
  let actionabilityNeitherCount = 0;
  let artifactBothDefectCount = 0;
  let artifactPrimaryOnlyDefectCount = 0;
  let artifactSecondaryOnlyDefectCount = 0;
  let artifactBothCleanCount = 0;
  let severityAgreements = 0;
  let severityLabelCount = 0;
  for (const record of records) {
    const primaryDefect = record.primaryVerdict === "defect_present";
    const secondaryDefect = record.secondaryVerdict === "defect_present";
    if (primaryDefect && secondaryDefect) artifactBothDefectCount += 1;
    else if (primaryDefect) artifactPrimaryOnlyDefectCount += 1;
    else if (secondaryDefect) artifactSecondaryOnlyDefectCount += 1;
    else artifactBothCleanCount += 1;
    const candidateAgreement = record.candidateAgreement;
    if (!candidateAgreement || candidateAgreement.version !== REVIEW_BENCH_CANDIDATE_ACTIONABILITY_VERSION) {
      throw new Error(`missing candidate-actionability evidence: ${record.scenarioId}`);
    }
    actionabilityItemCount += candidateAgreement.candidateUnitCount;
    actionabilityBothActionableCount += candidateAgreement.bothActionableCount;
    actionabilityPrimaryOnlyCount += candidateAgreement.primaryOnlyCount;
    actionabilitySecondaryOnlyCount += candidateAgreement.secondaryOnlyCount;
    actionabilityNeitherCount += candidateAgreement.neitherCount;
    for (const label of record.labelAgreement) {
      if (label.primaryActionability === "actionable" &&
          label.secondaryActionability === "actionable" &&
          label.primarySeverity !== undefined && label.secondarySeverity !== undefined) {
        severityLabelCount += 1;
        if (Math.abs(severityRank(label.primarySeverity) - severityRank(label.secondarySeverity)) <= 1) {
          severityAgreements += 1;
        }
      }
    }
  }
  if (actionabilityItemCount === 0) throw new Error("actionability kappa requires annotation candidates");
  if (severityLabelCount === 0) {
    throw new Error("severity agreement requires at least one adjudicated defect label");
  }
  const summary: ReviewBenchAdjudicationAgreementV1 = {
    version: REVIEW_BENCH_ADJUDICATION_AGREEMENT_VERSION,
    scenarioCount: records.length,
    actionabilityItemCount,
    actionabilityBothActionableCount,
    actionabilityPrimaryOnlyCount,
    actionabilitySecondaryOnlyCount,
    actionabilityNeitherCount,
    actionabilityKappa: computeBinaryKappa({
      bothPositive: actionabilityBothActionableCount,
      primaryOnly: actionabilityPrimaryOnlyCount,
      secondaryOnly: actionabilitySecondaryOnlyCount,
      bothNegative: actionabilityNeitherCount
    }, "actionability"),
    artifactBothDefectCount,
    artifactPrimaryOnlyDefectCount,
    artifactSecondaryOnlyDefectCount,
    artifactBothCleanCount,
    artifactSemanticsKappa: computeBinaryKappa({
      bothPositive: artifactBothDefectCount,
      primaryOnly: artifactPrimaryOnlyDefectCount,
      secondaryOnly: artifactSecondaryOnlyDefectCount,
      bothNegative: artifactBothCleanCount
    }, "artifact-semantics"),
    severityLabelCount,
    severityWithinOneTierAgreement: roundMetric(severityAgreements / severityLabelCount)
  };
  if (summary.actionabilityKappa < 0.70) {
    throw new Error(`actionability kappa ${summary.actionabilityKappa} is below 0.70`);
  }
  if (summary.artifactSemanticsKappa < 0.70) {
    throw new Error(`artifact-semantics kappa ${summary.artifactSemanticsKappa} is below 0.70`);
  }
  if (summary.severityWithinOneTierAgreement < 0.85) {
    throw new Error(
      `severity-within-one-tier agreement ${summary.severityWithinOneTierAgreement} is below 0.85`
    );
  }
  return summary;
}

export function serializeReviewBenchOracleEvidence(packet: ReviewBenchOracleEvidenceV1): Uint8Array {
  return new TextEncoder().encode(stableJson(packet));
}

export function computeReviewBenchGoldLabelsSha256(
  labels: ReviewBenchScenarioV1["labels"]
): string {
  const projected = [...labels]
    .sort((a, b) => compareFixed(a.id, b.id))
    .map((label) => ({
      id: label.id,
      path: label.path,
      line: label.line,
      severity: label.severity,
      title: label.title,
      body: label.body
    }));
  return sha256(new TextEncoder().encode(stableJson(projected)));
}

export function verifyReviewBenchOracleEvidence(
  scenario: ReviewBenchScenarioV1,
  bytes: Uint8Array
): ReviewBenchSemanticEvidenceRecord {
  if (bytes.byteLength === 0 || bytes.byteLength > REVIEW_BENCH_MAX_ORACLE_EVIDENCE_BYTES) {
    throw new Error(
      `oracle evidence must contain 1-${REVIEW_BENCH_MAX_ORACLE_EVIDENCE_BYTES} bytes: ${scenario.scenarioId}`
    );
  }
  const evidenceSha256 = sha256(bytes);
  if (evidenceSha256 !== scenario.oracle.evidenceSha256) {
    throw new Error(`oracle evidence sha256 does not match the scenario: ${scenario.scenarioId}`);
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`oracle evidence must be valid UTF-8 JSON: ${scenario.scenarioId}`);
  }
  if (containsSecretLikeText(text)) {
    throw new Error(`oracle evidence contains secret-like text: ${scenario.scenarioId}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`oracle evidence must be valid JSON: ${scenario.scenarioId}`);
  }
  if (text !== stableJson(parsed)) {
    throw new Error(`oracle evidence must use canonical JSON without duplicate keys: ${scenario.scenarioId}`);
  }
  validateOracleEvidencePacket(scenario, parsed);
  const primaryById = new Map(parsed.primary.labels.map((label) => [label.labelId, label]));
  const secondaryById = new Map(parsed.secondary.labels.map((label) => [label.labelId, label]));
  const labelAgreement = parsed.annotationUniverse.candidates.map((candidate) => {
    const primary = primaryById.get(candidate.id);
    const secondary = secondaryById.get(candidate.id);
    if (!primary || !secondary) {
      throw new Error(`validated annotation decision is missing candidate ${candidate.id}`);
    }
    return {
      labelId: candidate.id,
      primaryActionability: primary.actionability,
      secondaryActionability: secondary.actionability,
      ...(primary?.severity === undefined ? {} : { primarySeverity: primary.severity }),
      ...(secondary?.severity === undefined ? {} : { secondarySeverity: secondary.severity })
    };
  });
  return {
    scenarioId: scenario.scenarioId,
    evidenceSha256,
    oracleObservedAt: parsed.oracle.observedAt,
    oracleSourceEvidenceSha256: parsed.oracle.sourceEvidenceSha256,
    oracleLabelEvidence: parsed.oracle.labelEvidence,
    annotationUniverse: parsed.annotationUniverse,
    ...(parsed.cleanObservation === undefined ? {} : { cleanObservation: parsed.cleanObservation }),
    primaryVerdict: parsed.primary.verdict,
    secondaryVerdict: parsed.secondary.verdict,
    labelAgreement
  };
}

export function computeReviewBenchSemanticEvidenceSha256(
  records: ReadonlyArray<ReviewBenchSemanticEvidenceRecord>
): string {
  const sorted = [...records].sort((a, b) => compareFixed(a.scenarioId, b.scenarioId));
  const scenarioIds = new Set<string>();
  for (const [index, record] of sorted.entries()) {
    requireNonEmpty(record.scenarioId, `semantic evidence records[${index}].scenarioId`);
    requireSha256(record.evidenceSha256, `semantic evidence records[${index}].evidenceSha256`);
    if (scenarioIds.has(record.scenarioId)) {
      throw new Error(`duplicate semantic evidence scenarioId: ${record.scenarioId}`);
    }
    scenarioIds.add(record.scenarioId);
  }
  return sha256(new TextEncoder().encode(stableJson(sorted)));
}

export function bindReviewBenchCandidateAgreement(
  record: ReviewBenchSemanticEvidenceRecord,
  eligibleLines: ReadonlyArray<{ path: string; line: number }>
): ReviewBenchSemanticEvidenceRecord {
  if (record.candidateAgreement !== undefined) {
    throw new Error(`candidate-actionability evidence is already bound: ${record.scenarioId}`);
  }
  const lines = eligibleLines.map((item, index) => {
    requireCanonicalPath(item.path, `eligibleLines[${index}].path`);
    if (!Number.isSafeInteger(item.line) || item.line < 1) {
      throw new Error(`eligibleLines[${index}].line must be a positive integer`);
    }
    return { path: item.path, line: item.line };
  }).sort((a, b) => compareFixed(a.path, b.path) || a.line - b.line);
  if (lines.length === 0) throw new Error(`line-actionability universe is empty: ${record.scenarioId}`);
  const lineKeys = new Set<string>();
  for (const line of lines) {
    const key = stableJson(line);
    if (lineKeys.has(key)) throw new Error(`duplicate line-actionability unit: ${record.scenarioId}:${key}`);
    lineKeys.add(key);
  }
  const candidateById = new Map(
    record.annotationUniverse.candidates.map((candidate) => [candidate.id, candidate])
  );
  const primaryActionable = new Set<string>();
  const secondaryActionable = new Set<string>();
  const candidateUnits: string[] = [];
  for (const agreement of record.labelAgreement) {
    const candidate = candidateById.get(agreement.labelId);
    if (!candidate) throw new Error(`annotation candidate is missing from its universe: ${agreement.labelId}`);
    const key = stableJson({ path: candidate.path, line: candidate.line });
    if (!lineKeys.has(key)) {
      throw new Error(`annotation candidate is outside the line-actionability universe: ${agreement.labelId}`);
    }
    candidateUnits.push(agreement.labelId);
    if (agreement.primaryActionability === "actionable") primaryActionable.add(agreement.labelId);
    if (agreement.secondaryActionability === "actionable") secondaryActionable.add(agreement.labelId);
  }
  let bothActionableCount = 0;
  let primaryOnlyCount = 0;
  let secondaryOnlyCount = 0;
  let neitherCount = 0;
  for (const candidateId of candidateUnits) {
    const primary = primaryActionable.has(candidateId);
    const secondary = secondaryActionable.has(candidateId);
    if (primary && secondary) bothActionableCount += 1;
    else if (primary) primaryOnlyCount += 1;
    else if (secondary) secondaryOnlyCount += 1;
    else neitherCount += 1;
  }
  return {
    ...record,
    candidateAgreement: {
      version: REVIEW_BENCH_CANDIDATE_ACTIONABILITY_VERSION,
      candidateUniverseSha256: sha256(new TextEncoder().encode(stableJson(record.annotationUniverse.candidates))),
      candidateUnitCount: candidateUnits.length,
      bothActionableCount,
      primaryOnlyCount,
      secondaryOnlyCount,
      neitherCount
    }
  };
}

function validateOracleEvidencePacket(
  scenario: ReviewBenchScenarioV1,
  input: unknown
): asserts input is ReviewBenchOracleEvidenceV1 {
  const path = `oracle evidence: ${scenario.scenarioId}`;
  const packet = requireRecord(input, path);
  requireExactKeys(packet, [
    "schemaVersion",
    "scenarioId",
    "repository",
    "reviewedSourceRevision",
    "reviewedSourceArtifactSha256",
    "artifactSemantics",
    "annotationUniverse",
    "oracle",
    "cleanObservation",
    "rubricVersion",
    "rubricSha256",
    "protocolVersion",
    "protocolSha256",
    "adjudicationMethod",
    "adjudicationCompletedAt",
    "coveredLabelIds",
    "goldLabelsSha256",
    "primary",
    "secondary",
    "resolver"
  ], path);
  if (packet.schemaVersion !== REVIEW_BENCH_ORACLE_EVIDENCE_VERSION) {
    throw new Error(`${path}.schemaVersion is invalid`);
  }
  requireMatches(packet.scenarioId, scenario.scenarioId, `${path}.scenarioId`);
  requireMatches(packet.repository, scenario.repository, `${path}.repository`);
  requireMatches(
    packet.reviewedSourceRevision,
    scenario.sourceRevision,
    `${path}.reviewedSourceRevision`
  );
  requireMatches(
    packet.reviewedSourceArtifactSha256,
    scenario.provenance.sourceArtifactSha256,
    `${path}.reviewedSourceArtifactSha256`
  );
  requireMatches(packet.artifactSemantics, scenario.artifactSemantics, `${path}.artifactSemantics`);
  const annotationUniverse = validateAnnotationUniverse(packet.annotationUniverse, scenario, path);

  const oracle = requireRecord(packet.oracle, `${path}.oracle`);
  requireExactKeys(oracle, [
    "kind",
    "sourceUrl",
    "sourceRevision",
    "relation",
    "sourceEvidenceSha256",
    "labelEvidence",
    "evidenceSummary",
    "observedAt"
  ], `${path}.oracle`);
  requireMatches(oracle.kind, scenario.oracle.kind, `${path}.oracle.kind`);
  requireMatches(oracle.sourceUrl, scenario.oracle.sourceUrl, `${path}.oracle.sourceUrl`);
  requireMatches(oracle.sourceRevision, scenario.oracle.sourceRevision, `${path}.oracle.sourceRevision`);
  const expectedRelation: ReviewBenchEvidenceRelation = scenario.artifactSemantics === "verified_clean"
    ? "verified_clean_exact_artifact"
    : "defect_present_in_reviewed_artifact";
  requireMatches(oracle.relation, expectedRelation, `${path}.oracle.relation`);
  requireSha256(oracle.sourceEvidenceSha256, `${path}.oracle.sourceEvidenceSha256`);
  validateOracleLabelEvidence(
    oracle.labelEvidence,
    scenario,
    oracle.sourceEvidenceSha256,
    `${path}.oracle.labelEvidence`
  );
  requireNonEmpty(oracle.evidenceSummary, `${path}.oracle.evidenceSummary`);
  requireIsoDate(oracle.observedAt, `${path}.oracle.observedAt`);

  requireMatches(packet.rubricVersion, scenario.adjudication.rubricVersion, `${path}.rubricVersion`);
  requireMatches(packet.rubricSha256, scenario.adjudication.rubricSha256, `${path}.rubricSha256`);
  requireMatches(packet.protocolVersion, scenario.adjudication.protocolVersion, `${path}.protocolVersion`);
  requireMatches(packet.protocolSha256, scenario.adjudication.protocolSha256, `${path}.protocolSha256`);
  requireMatches(packet.adjudicationMethod, scenario.adjudication.method, `${path}.adjudicationMethod`);
  requireMatches(
    packet.adjudicationCompletedAt,
    scenario.adjudication.completedAt,
    `${path}.adjudicationCompletedAt`
  );
  requireIsoDate(packet.adjudicationCompletedAt, `${path}.adjudicationCompletedAt`);
  if (Date.parse(String(oracle.observedAt)) > Date.parse(String(packet.adjudicationCompletedAt))) {
    throw new Error(`${path}.oracle.observedAt must not follow adjudication completion`);
  }
  const cleanObservation = validateCleanObservation(packet.cleanObservation, scenario, path);

  const expectedLabelIds = [...scenario.labels.map((label) => label.id)].sort(compareFixed);
  const coveredLabelIds = requireSortedUniqueStrings(packet.coveredLabelIds, `${path}.coveredLabelIds`);
  if (stableJson(coveredLabelIds) !== stableJson(expectedLabelIds)) {
    throw new Error(`${path}.coveredLabelIds does not match scenario labels`);
  }
  requireMatches(
    packet.goldLabelsSha256,
    computeReviewBenchGoldLabelsSha256(scenario.labels),
    `${path}.goldLabelsSha256`
  );

  const primary = validatePrimaryDecision(
    packet.primary,
    scenario,
    annotationUniverse,
    scenario.adjudication.primaryAdjudicator,
    `${path}.primary`
  );
  const secondary = validatePrimaryDecision(
    packet.secondary,
    scenario,
    annotationUniverse,
    scenario.adjudication.secondaryAdjudicator,
    `${path}.secondary`
  );
  if (normalizeIdentity(primary.adjudicatorId) === normalizeIdentity(secondary.adjudicatorId)) {
    throw new Error(`${path} requires distinct adjudicators`);
  }
  if (Date.parse(annotationUniverse.frozenAt) > Date.parse(primary.completedAt) ||
      Date.parse(annotationUniverse.frozenAt) > Date.parse(secondary.completedAt)) {
    throw new Error(`${path}.annotationUniverse must be frozen before both independent decisions`);
  }
  const oracleObservedAt = Date.parse(String(oracle.observedAt));
  if (Date.parse(primary.completedAt) < oracleObservedAt ||
      Date.parse(secondary.completedAt) < oracleObservedAt) {
    throw new Error(`${path} adjudicator decisions must not precede observed oracle evidence`);
  }
  if (cleanObservation &&
      (Date.parse(primary.completedAt) < Date.parse(cleanObservation.observedThrough) ||
       Date.parse(secondary.completedAt) < Date.parse(cleanObservation.observedThrough))) {
    throw new Error(`${path} clean adjudicator decisions must not precede the clean observation`);
  }

  if (scenario.adjudication.agreement === "agree") {
    if (packet.resolver !== undefined) {
      throw new Error(`${path}.resolver is only allowed for reconciled adjudication`);
    }
    requireFinalDecision(primary, scenario, annotationUniverse, `${path}.primary`);
    requireFinalDecision(secondary, scenario, annotationUniverse, `${path}.secondary`);
    if (!materiallyEqual(primary, secondary)) {
      throw new Error(`${path} agreed adjudicators must record the same material decision`);
    }
  } else {
    if (materiallyEqual(primary, secondary)) {
      throw new Error(`${path} reconciled adjudicators must materially disagree`);
    }
    const resolver = validateResolverDecision(
      packet.resolver,
      scenario,
      annotationUniverse,
      `${path}.resolver`
    );
    requireMatches(
      resolver.adjudicatorId,
      scenario.adjudication.resolverAdjudicator,
      `${path}.resolver.adjudicatorId`
    );
    const identities = new Set([
      normalizeIdentity(primary.adjudicatorId),
      normalizeIdentity(secondary.adjudicatorId),
      normalizeIdentity(resolver.adjudicatorId)
    ]);
    if (identities.size !== 3) throw new Error(`${path} requires a distinct resolver`);
    if (Date.parse(resolver.completedAt) <
        Math.max(Date.parse(primary.completedAt), Date.parse(secondary.completedAt))) {
      throw new Error(`${path}.resolver.completedAt must not precede the independent decisions`);
    }
    requireFinalDecision(resolver, scenario, annotationUniverse, `${path}.resolver`);
  }
}

function validateAnnotationUniverse(
  input: unknown,
  scenario: ReviewBenchScenarioV1,
  parentPath: string
): ReviewBenchAnnotationUniverseV1 {
  const path = `${parentPath}.annotationUniverse`;
  const universe = requireRecord(input, path);
  requireExactKeys(
    universe,
    ["schemaVersion", "frozenAt", "methodVersion", "methodSha256", "candidates"],
    path
  );
  if (universe.schemaVersion !== "review-bench-annotation-universe/v1") {
    throw new Error(`${path}.schemaVersion is invalid`);
  }
  requireIsoDate(universe.frozenAt, `${path}.frozenAt`);
  requireMatches(universe.methodVersion, scenario.adjudication.protocolVersion, `${path}.methodVersion`);
  requireMatches(universe.methodSha256, scenario.adjudication.protocolSha256, `${path}.methodSha256`);
  if (!Array.isArray(universe.candidates) || universe.candidates.length > 100) {
    throw new Error(`${path}.candidates must be an array of at most 100 items`);
  }
  const candidates = universe.candidates.map((item, index) => {
    const candidatePath = `${path}.candidates[${index}]`;
    const candidate = requireRecord(item, candidatePath);
    requireExactKeys(candidate, ["id", "path", "line", "title", "body"], candidatePath);
    requireNonEmpty(candidate.id, `${candidatePath}.id`);
    requireCanonicalPath(candidate.path, `${candidatePath}.path`);
    if (!Number.isSafeInteger(candidate.line) || Number(candidate.line) < 1) {
      throw new Error(`${candidatePath}.line must be a positive integer`);
    }
    requireNonEmpty(candidate.title, `${candidatePath}.title`);
    requireNonEmpty(candidate.body, `${candidatePath}.body`);
    return {
      id: candidate.id,
      path: candidate.path,
      line: Number(candidate.line),
      title: candidate.title,
      body: candidate.body
    };
  });
  requireSortedUniqueStrings(candidates.map((candidate) => candidate.id), `${path}.candidates`);
  const contentKeys = new Set<string>();
  for (const candidate of candidates) {
    const contentKey = stableJson({
      path: candidate.path,
      line: candidate.line,
      title: candidate.title.trim(),
      body: candidate.body.trim()
    });
    if (contentKeys.has(contentKey)) throw new Error(`${path}.candidates contains duplicate candidate content`);
    contentKeys.add(contentKey);
  }
  const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  for (const gold of scenario.labels) {
    const candidate = candidateById.get(gold.id);
    const expected = {
      id: gold.id,
      path: gold.path,
      line: gold.line,
      title: gold.title,
      body: gold.body
    };
    if (!candidate || stableJson(candidate) !== stableJson(expected)) {
      throw new Error(`${path} must contain every final gold label with identical content`);
    }
  }
  return {
    schemaVersion: "review-bench-annotation-universe/v1",
    frozenAt: universe.frozenAt,
    methodVersion: universe.methodVersion as string,
    methodSha256: universe.methodSha256 as string,
    candidates
  };
}

function validatePrimaryDecision(
  input: unknown,
  scenario: ReviewBenchScenarioV1,
  annotationUniverse: ReviewBenchAnnotationUniverseV1,
  expectedAdjudicator: string,
  path: string
): ReviewBenchPrimaryDecisionV1 {
  const decision = requireRecord(input, path);
  requireExactKeys(decision, [
    "adjudicatorId",
    "verdict",
    "labels",
    "rationale",
    "completedAt",
    "blindedToProviderIdentity",
    "blindedToPeerDecision"
  ], path);
  requireMatches(decision.adjudicatorId, expectedAdjudicator, `${path}.adjudicatorId`);
  requireCanonicalAdjudicatorId(decision.adjudicatorId as string, `${path}.adjudicatorId`);
  const common = validateDecisionCommon(decision, scenario, annotationUniverse, path);
  requireCanonicalAdjudicatorId(common.adjudicatorId, `${path}.adjudicatorId`);
  if (decision.blindedToProviderIdentity !== true) {
    throw new Error(`${path}.blindedToProviderIdentity must be true`);
  }
  if (decision.blindedToPeerDecision !== true) {
    throw new Error(`${path}.blindedToPeerDecision must be true`);
  }
  return {
    ...common,
    blindedToProviderIdentity: true,
    blindedToPeerDecision: true
  };
}

function validateOracleLabelEvidence(
  input: unknown,
  scenario: ReviewBenchScenarioV1,
  sourceEvidenceSha256: unknown,
  path: string
): void {
  if (!Array.isArray(input)) throw new Error(`${path} must be an array`);
  const labelIds: string[] = [];
  for (const [index, item] of input.entries()) {
    const itemPath = `${path}[${index}]`;
    const evidence = requireRecord(item, itemPath);
    requireExactKeys(
      evidence,
      ["labelId", "sourceEvidenceSha256", "sourcePath", "sourceLine", "rationale"],
      itemPath
    );
    requireNonEmpty(evidence.labelId, `${itemPath}.labelId`);
    requireMatches(
      evidence.sourceEvidenceSha256,
      sourceEvidenceSha256,
      `${itemPath}.sourceEvidenceSha256`
    );
    requireCanonicalPath(evidence.sourcePath, `${itemPath}.sourcePath`);
    if (evidence.sourceLine !== null &&
        (!Number.isSafeInteger(evidence.sourceLine) || Number(evidence.sourceLine) < 1)) {
      throw new Error(`${itemPath}.sourceLine must be null or a positive integer`);
    }
    if (scenario.oracle.kind === "review_comment" && evidence.sourceLine === null) {
      throw new Error(`${itemPath}.sourceLine is required for review-comment evidence`);
    }
    if (scenario.oracle.kind !== "review_comment" && evidence.sourceLine !== null) {
      throw new Error(`${itemPath}.sourceLine is only allowed for review-comment evidence`);
    }
    requireNonEmpty(evidence.rationale, `${itemPath}.rationale`);
    labelIds.push(evidence.labelId);
  }
  requireSortedUniqueStrings(labelIds, path);
  const expected = scenario.explicitControl
    ? []
    : scenario.labels.map((label) => label.id).sort(compareFixed);
  if (stableJson(labelIds) !== stableJson(expected)) {
    throw new Error(`${path} does not match the scenario labels`);
  }
  if (scenario.explicitControl && sourceEvidenceSha256 !== scenario.provenance.sourceArtifactSha256) {
    throw new Error(`${path} clean evidence must use the exact reviewed source artifact digest`);
  }
  if (scenario.oracle.kind === "review_comment") {
    if (scenario.provenance.kind !== "pull_request" || scenario.labels.length !== 1) {
      throw new Error(`${path} review-comment evidence requires one-label pull-request provenance`);
    }
    const mapped = input[0] as Record<string, unknown>;
    const gold = scenario.labels[0]!;
    if (mapped.sourcePath !== gold.path || mapped.sourceLine !== gold.line) {
      throw new Error(`${path} review-comment location must equal the gold-label location`);
    }
  }
}

function validateCleanObservation(
  input: unknown,
  scenario: ReviewBenchScenarioV1,
  parentPath: string
): ReviewBenchCleanObservationV1 | undefined {
  const path = `${parentPath}.cleanObservation`;
  if (!scenario.explicitControl) {
    if (input !== undefined) throw new Error(`${path} is only allowed for verified-clean controls`);
    return undefined;
  }
  const observation = requireRecord(input, path);
  requireExactKeys(observation, [
    "schemaVersion",
    "sourceUrl",
    "sourceRevision",
    "sourceEvidenceSha256",
    "observedThrough",
    "minimumCleanDays",
    "checkedSignals",
    "evidenceSummary"
  ], path);
  if (observation.schemaVersion !== "review-bench-clean-observation/v1") {
    throw new Error(`${path}.schemaVersion is invalid`);
  }
  requireNonEmpty(observation.sourceRevision, `${path}.sourceRevision`);
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(observation.sourceRevision)) {
    throw new Error(`${path}.sourceRevision must be an immutable commit digest`);
  }
  requireNonEmpty(observation.sourceUrl, `${path}.sourceUrl`);
  const repository = scenario.repository.toLowerCase();
  let sourceUrl: URL;
  try {
    sourceUrl = new URL(observation.sourceUrl);
  } catch {
    throw new Error(`${path}.sourceUrl must be a canonical GitHub pull-request URL`);
  }
  if (sourceUrl.origin !== "https://github.com" || sourceUrl.username || sourceUrl.password ||
      sourceUrl.search || sourceUrl.hash ||
      !new RegExp(`^/${repository.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/pull/[1-9][0-9]*/?$`, "i")
        .test(sourceUrl.pathname)) {
    throw new Error(`${path}.sourceUrl must be a canonical repository-bound GitHub pull-request URL`);
  }
  requireSha256(observation.sourceEvidenceSha256, `${path}.sourceEvidenceSha256`);
  requireIsoDate(observation.observedThrough, `${path}.observedThrough`);
  if (typeof observation.minimumCleanDays !== "number" ||
      !Number.isSafeInteger(observation.minimumCleanDays) || observation.minimumCleanDays < 30) {
    throw new Error(`${path}.minimumCleanDays must be an integer of at least 30`);
  }
  if (stableJson(observation.checkedSignals) !== stableJson(["hotfix", "linked_defect", "revert"])) {
    throw new Error(`${path}.checkedSignals must cover hotfix, linked_defect, and revert`);
  }
  requireNonEmpty(observation.evidenceSummary, `${path}.evidenceSummary`);
  if (Date.parse(observation.observedThrough) > Date.parse(scenario.adjudication.completedAt)) {
    throw new Error(`${path}.observedThrough must not follow adjudication completion`);
  }
  return observation as unknown as ReviewBenchCleanObservationV1;
}

function validateResolverDecision(
  input: unknown,
  scenario: ReviewBenchScenarioV1,
  annotationUniverse: ReviewBenchAnnotationUniverseV1,
  path: string
): ReviewBenchResolverDecisionV1 {
  const decision = requireRecord(input, path);
  requireExactKeys(decision, [
    "adjudicatorId",
    "verdict",
    "labels",
    "rationale",
    "completedAt",
    "blindedToProviderIdentity",
    "reviewedDisagreement"
  ], path);
  const common = validateDecisionCommon(decision, scenario, annotationUniverse, path);
  if (decision.blindedToProviderIdentity !== true) {
    throw new Error(`${path}.blindedToProviderIdentity must be true`);
  }
  if (decision.reviewedDisagreement !== true) {
    throw new Error(`${path}.reviewedDisagreement must be true`);
  }
  return {
    ...common,
    blindedToProviderIdentity: true,
    reviewedDisagreement: true
  };
}

function validateDecisionCommon(
  decision: Record<string, unknown>,
  scenario: ReviewBenchScenarioV1,
  annotationUniverse: ReviewBenchAnnotationUniverseV1,
  path: string
): Omit<ReviewBenchPrimaryDecisionV1, "blindedToProviderIdentity" | "blindedToPeerDecision"> {
  requireNonEmpty(decision.adjudicatorId, `${path}.adjudicatorId`);
  if (!(decision.verdict === "defect_present" || decision.verdict === "verified_clean")) {
    throw new Error(`${path}.verdict is invalid`);
  }
  requireNonEmpty(decision.rationale, `${path}.rationale`);
  requireIsoDate(decision.completedAt, `${path}.completedAt`);
  if (Date.parse(decision.completedAt) > Date.parse(scenario.adjudication.completedAt)) {
    throw new Error(`${path}.completedAt must not follow adjudication completion`);
  }
  const labels = validateLabelDecisions(
    decision.labels,
    annotationUniverse,
    decision.verdict,
    `${path}.labels`
  );
  return {
    adjudicatorId: decision.adjudicatorId,
    verdict: decision.verdict,
    labels,
    rationale: decision.rationale,
    completedAt: decision.completedAt
  };
}

function validateLabelDecisions(
  input: unknown,
  annotationUniverse: ReviewBenchAnnotationUniverseV1,
  verdict: ReviewBenchArtifactSemantics,
  path: string
): ReviewBenchLabelDecisionV1[] {
  if (!Array.isArray(input)) throw new Error(`${path} must be an array`);
  const decisions = input.map((item, index) => {
    const itemPath = `${path}[${index}]`;
    const decision = requireRecord(item, itemPath);
    requireExactKeys(decision, ["labelId", "actionability", "severity"], itemPath);
    requireNonEmpty(decision.labelId, `${itemPath}.labelId`);
    if (!(decision.actionability === "actionable" || decision.actionability === "not_actionable")) {
      throw new Error(`${itemPath}.actionability is invalid`);
    }
    const actionability: ReviewBenchLabelDecisionV1["actionability"] = decision.actionability;
    if (actionability === "actionable") {
      requireSeverity(decision.severity, `${itemPath}.severity`);
    } else if (decision.severity !== undefined) {
      throw new Error(`${itemPath}.severity must be omitted for a non-actionable label`);
    }
    return {
      labelId: decision.labelId,
      actionability,
      ...(decision.severity === undefined ? {} : { severity: decision.severity as Severity })
    };
  });
  requireSortedUniqueStrings(decisions.map((decision) => decision.labelId), path);
  const expectedIds = annotationUniverse.candidates.map((candidate) => candidate.id);
  if (stableJson(decisions.map((decision) => decision.labelId)) !== stableJson(expectedIds)) {
    throw new Error(`${path} must rate every frozen annotation candidate exactly once`);
  }
  const actionableCount = decisions.filter((decision) => decision.actionability === "actionable").length;
  if ((verdict === "defect_present") !== (actionableCount > 0)) {
    throw new Error(`${path} verdict must agree with whether any frozen candidate is actionable`);
  }
  return decisions;
}

function requireFinalDecision(
  decision: Pick<ReviewBenchPrimaryDecisionV1, "verdict" | "labels">,
  scenario: ReviewBenchScenarioV1,
  annotationUniverse: ReviewBenchAnnotationUniverseV1,
  path: string
): void {
  if (decision.verdict !== scenario.artifactSemantics) {
    throw new Error(`${path} does not support the final artifact semantics`);
  }
  const goldById = new Map(scenario.labels.map((label) => [label.id, label]));
  const candidateById = new Map(annotationUniverse.candidates.map((candidate) => [candidate.id, candidate]));
  for (const gold of scenario.labels) {
    const candidate = candidateById.get(gold.id);
    if (!candidate || stableJson(candidate) !== stableJson({
      id: gold.id,
      path: gold.path,
      line: gold.line,
      title: gold.title,
      body: gold.body
    })) {
      throw new Error(`${path} final gold labels must be an identity-preserving subset of the annotation universe`);
    }
  }
  for (const labelDecision of decision.labels) {
    const gold = goldById.get(labelDecision.labelId);
    if (gold) {
      if (labelDecision.actionability !== "actionable" || labelDecision.severity === undefined) {
        throw new Error(`${path} does not support every final gold label`);
      }
      if (labelDecision.severity !== gold.severity) {
        throw new Error(`${path} label severity must equal the final gold severity`);
      }
    } else if (labelDecision.actionability !== "not_actionable" || labelDecision.severity !== undefined) {
      throw new Error(`${path} must reject every non-gold annotation candidate`);
    }
  }
}

function materiallyEqual(
  a: Pick<ReviewBenchPrimaryDecisionV1, "verdict" | "labels">,
  b: Pick<ReviewBenchPrimaryDecisionV1, "verdict" | "labels">
): boolean {
  return stableJson({ verdict: a.verdict, labels: a.labels }) ===
    stableJson({ verdict: b.verdict, labels: b.labels });
}

function requireSortedUniqueStrings(input: unknown, path: string): string[] {
  if (!Array.isArray(input)) throw new Error(`${path} must be an array`);
  const values = input.map((value, index) => {
    requireNonEmpty(value, `${path}[${index}]`);
    return value;
  });
  for (let index = 0; index < values.length; index += 1) {
    if (index > 0 && compareFixed(values[index - 1]!, values[index]!) >= 0) {
      throw new Error(`${path} must be sorted and unique`);
    }
  }
  return values;
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireCanonicalPath(value: unknown, path: string): asserts value is string {
  requireNonEmpty(value, path);
  if (value.startsWith("/") || value.startsWith("./") || value.includes("\\") ||
      value.includes("\0") || value.includes("\r") || value.includes("\n") ||
      value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`${path} must be a canonical repository-relative path`);
  }
}

function requireExactKeys(value: Record<string, unknown>, allowedKeys: string[], path: string): void {
  const allowed = new Set(allowedKeys);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key)).sort(compareFixed);
  if (unknown.length > 0) throw new Error(`${path} has unknown keys: ${unknown.join(", ")}`);
}

function requireMatches(actual: unknown, expected: unknown, path: string): void {
  if (actual !== expected) throw new Error(`${path} does not match the scenario`);
}

function requireSha256(value: unknown, path: string): asserts value is string {
  requireNonEmpty(value, path);
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`${path} must be a sha256 hex digest`);
}

function requireSeverity(value: unknown, path: string): asserts value is Severity {
  if (!(value === "P0" || value === "P1" || value === "P2" || value === "P3")) {
    throw new Error(`${path} must be P0, P1, P2, or P3`);
  }
}

function requireNonEmpty(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }
}

function requireCanonicalAdjudicatorId(value: string, path: string): void {
  if (!/^human:[a-z0-9](?:[a-z0-9._-]{0,63})$/.test(value)) {
    throw new Error(`${path} must be a canonical lowercase ASCII human adjudicator identity`);
  }
}

function requireIsoDate(value: unknown, path: string): asserts value is string {
  requireNonEmpty(value, path);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(`${path} must be an ISO-8601 UTC timestamp`);
  }
}

function normalizeIdentity(value: string): string {
  return value.trim().toLowerCase();
}

function severityRank(severity: Severity): number {
  return ({ P0: 0, P1: 1, P2: 2, P3: 3 })[severity];
}

function roundMetric(value: number): number {
  return Math.round(value * 1_000_000_000_000) / 1_000_000_000_000;
}

function computeBinaryKappa(
  counts: {
    bothPositive: number;
    primaryOnly: number;
    secondaryOnly: number;
    bothNegative: number;
  },
  label: string
): number {
  const total = counts.bothPositive + counts.primaryOnly + counts.secondaryOnly + counts.bothNegative;
  if (total < 2) throw new Error(`${label} kappa requires at least two frozen items`);
  const observed = (counts.bothPositive + counts.bothNegative) / total;
  const primaryPositiveRate = (counts.bothPositive + counts.primaryOnly) / total;
  const secondaryPositiveRate = (counts.bothPositive + counts.secondaryOnly) / total;
  const expected = primaryPositiveRate * secondaryPositiveRate +
    (1 - primaryPositiveRate) * (1 - secondaryPositiveRate);
  if (1 - expected <= 1e-12) {
    throw new Error(`${label} kappa requires both positive and negative frozen items`);
  }
  return roundMetric((observed - expected) / (1 - expected));
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => compareFixed(a, b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function compareFixed(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
