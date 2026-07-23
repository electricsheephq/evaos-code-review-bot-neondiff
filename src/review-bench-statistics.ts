import { createHash } from "node:crypto";
import type {
  ReviewBenchArtifactSemantics,
  ReviewBenchLanguage
} from "./review-bench-corpus.js";
import { isRegressionCategory } from "./regression-taxonomy.js";
import type { RegressionCategory } from "./types.js";

export const REVIEW_BENCH_PAIRED_ANALYSIS_VERSION = "review-bench-paired-analysis/v1" as const;
export const REVIEW_BENCH_PAIRED_ANALYSIS_INPUT_VERSION = "review-bench-paired-analysis-input/v1" as const;
export const REVIEW_BENCH_PAIRED_OBSERVATION_VERSION = "review-bench-paired-observation/v1" as const;
export const REVIEW_BENCH_BOOTSTRAP_METHOD = "stratified-paired-pr-cluster-percentile/v1" as const;
export const REVIEW_BENCH_ALPHA_SPENDING_VERSION = "final-only-obf-data-quality-looks/v1" as const;

const NONINFERIORITY_MARGIN = -0.05;
const ABSOLUTE_PRECISION_FLOOR = 0.8;
const ONE_SIDED_ALPHA = 0.025 as const;
const MINIMUM_CONFIRMATION_PR_HEADS = 150;
const MINIMUM_CONFIRMATION_DEFECT_PR_HEADS = 125;
const Z_95_TWO_SIDED = 1.96;
const Z_80_POWER = 0.842;
const POWER_MARGIN = 0.05;
const MAX_OBSERVATIONS = 10_000;
const PROMOTION_CLEAN_CONTROL_FLOOR = 75;
const MINIMUM_FINAL_BOOTSTRAP_STRATUM_PR_HEADS = 4;
const COMPARISON_EPSILON = 1e-12;
const REVIEW_BENCH_LANGUAGES: readonly ReviewBenchLanguage[] = [
  "TypeScript",
  "JavaScript",
  "Python",
  "Go",
  "Rust",
  "Java",
  "C#",
  "C++",
  "Ruby"
];

export interface PairedReviewBenchArmEvidenceV1 {
  evidenceSha256: string;
  findingCount: number;
  truePositive: number;
  falsePositive: number;
  falseNegative: number;
  p0p1FalseNegative: number;
  schemaFailures: number;
  secretFindings: number;
  duplicatePolicyViolations: number;
}

export interface PairedReviewBenchObservationV1 {
  schemaVersion: typeof REVIEW_BENCH_PAIRED_OBSERVATION_VERSION;
  observationId: string;
  corpusScenarioId: string;
  repository: string;
  pullNumber: number;
  headSha: string;
  language: ReviewBenchLanguage;
  bugFamily: RegressionCategory;
  artifactSemantics: ReviewBenchArtifactSemantics;
  adjudication: {
    status: "complete";
    evidenceSha256: string;
    blindedToProviderIdentity: true;
    unresolvedNearMisses: 0;
  };
  candidate: PairedReviewBenchArmEvidenceV1;
  baseline: PairedReviewBenchArmEvidenceV1;
}

export interface PairedReviewBenchAnalysisInputV1 {
  schemaVersion: typeof REVIEW_BENCH_PAIRED_ANALYSIS_INPUT_VERSION;
  analysisVersion: typeof REVIEW_BENCH_PAIRED_ANALYSIS_VERSION;
  corpusHash: string;
  matcherVersion: string;
  candidateTargetFingerprint: string;
  baselineTargetFingerprint: string;
  candidateMatcherFingerprint: string;
  baselineMatcherFingerprint: string;
  adjudicationVersion: string;
  cohortManifestSha256: string;
  expectedCohort: PairedReviewBenchCohortEntryV1[];
  expectedStrata: Array<{
    repository: string;
    language: ReviewBenchLanguage;
    minimumPrHeads: number;
    minimumDefectPrHeads: number;
  }>;
  look:
    | { label: "50_percent"; fraction: 0.5 }
    | { label: "75_percent"; fraction: 0.75 }
    | { label: "final"; fraction: 1 };
  variancePilot: {
    pairedPrHeads: number;
    defectPrHeads: number;
    precisionPairedPrSd: number;
    recallPairedPrSd: number;
    evidenceSha256: string;
  };
  bootstrap: {
    method: typeof REVIEW_BENCH_BOOTSTRAP_METHOD;
    resamples: number;
    seed: number;
  };
  observations: PairedReviewBenchObservationV1[];
}

export interface PairedReviewBenchCohortEntryV1 {
  corpusScenarioId: string;
  analysisOrder: number;
  repository: string;
  pullNumber: number;
  headSha: string;
  language: ReviewBenchLanguage;
  bugFamily: RegressionCategory;
  artifactSemantics: ReviewBenchArtifactSemantics;
}

interface ArmCounts {
  findingCount: number;
  truePositive: number;
  falsePositive: number;
  falseNegative: number;
  p0p1FalseNegative: number;
  schemaFailures: number;
  secretFindings: number;
  duplicatePolicyViolations: number;
}

interface PrCluster {
  key: string;
  repository: string;
  language: ReviewBenchLanguage;
  artifactSemantics: ReviewBenchArtifactSemantics;
  candidate: ArmCounts;
  baseline: ArmCounts;
}

export interface ReviewBenchIntervalV1 {
  lower: number;
  point: number;
  upper: number;
}

export type PairedReviewBenchDecision =
  | "promote"
  | "do_not_promote"
  | "insufficient_evidence"
  | "interim_continue"
  | "stop_for_safety"
  | "stop_for_futility";

export interface PairedReviewBenchAnalysisResultV1 {
  schemaVersion: typeof REVIEW_BENCH_PAIRED_ANALYSIS_VERSION;
  decision: PairedReviewBenchDecision;
  inputSha256: string;
  analysisSha256: string;
  bindings: {
    corpusHash: string;
    matcherVersion: string;
    candidateTargetFingerprint: string;
    baselineTargetFingerprint: string;
    candidateMatcherFingerprint: string;
    baselineMatcherFingerprint: string;
    adjudicationVersion: string;
    cohortManifestSha256: string;
  };
  hypotheses: {
    precision: string;
    recall: string;
    absolutePrecision: string;
  };
  margins: {
    precisionNoninferiority: number;
    recallNoninferiority: number;
    candidateAbsolutePrecision: number;
  };
  method: {
    confidenceLevel: 0.95;
    oneSidedAlpha: 0.025;
    alphaSpendingVersion: typeof REVIEW_BENCH_ALPHA_SPENDING_VERSION;
    multiplicity: "intersection-union-co-primary/v1";
    bootstrapMethod: typeof REVIEW_BENCH_BOOTSTRAP_METHOD;
    bootstrapResamples: number;
    bootstrapSeed: number;
    promotionEndpoint: "macro_pr";
    cleanControlRecall: "excluded";
  };
  sampleSize: {
    observations: number;
    uniquePrHeads: number;
    defectPrHeads: number;
    cleanPrHeads: number;
    plannedCohortObservations: number;
    repositories: number;
    languages: number;
    repositoryLanguageStrata: number;
    variancePilotPrHeads: number;
    variancePilotDefectPrHeads: number;
    poweredPrecisionN: number;
    poweredRecallN: number;
    requiredUniquePrHeads: number;
    requiredDefectPrHeads: number;
    requiredObservationsAtPlannedLook: number;
  };
  counts: {
    candidate: ArmCounts;
    baseline: ArmCounts;
  };
  metrics: {
    pooledFinding: {
      candidatePrecision: number;
      baselinePrecision: number;
      precisionDifference: number;
      candidateRecall: number;
      baselineRecall: number;
      recallDifference: number;
    };
    macroPr: {
      candidatePrecision: number;
      baselinePrecision: number;
      precisionDifference: number;
      candidateRecall: number;
      baselineRecall: number;
      recallDifference: number;
    };
  };
  intervals: {
    candidatePrecision: ReviewBenchIntervalV1;
    precisionDifference: ReviewBenchIntervalV1;
    candidateRecall: ReviewBenchIntervalV1;
    recallDifference: ReviewBenchIntervalV1;
  };
  gates: Array<{ name: string; passed: boolean; detail: string }>;
  proofBoundary: string;
}

export function analyzePairedReviewBench(
  input: PairedReviewBenchAnalysisInputV1
): PairedReviewBenchAnalysisResultV1 {
  validateAnalysisInput(input);
  const inputSha256 = sha256(canonicalJson(input));
  const clusters = buildPrClusters(input.observations);
  const candidateCounts = sumArmCounts(clusters.map((cluster) => cluster.candidate));
  const baselineCounts = sumArmCounts(clusters.map((cluster) => cluster.baseline));
  const defectClusters = clusters.filter((cluster) => cluster.artifactSemantics === "defect_present");

  const candidatePrecisionByPr = clusters.map((cluster) => precision(cluster.candidate));
  const baselinePrecisionByPr = clusters.map((cluster) => precision(cluster.baseline));
  const candidateRecallByPr = defectClusters.map((cluster) => recall(cluster.candidate));
  const baselineRecallByPr = defectClusters.map((cluster) => recall(cluster.baseline));

  const macro = {
    candidatePrecision: mean(candidatePrecisionByPr),
    baselinePrecision: mean(baselinePrecisionByPr),
    precisionDifference: mean(candidatePrecisionByPr.map((value, index) => value - baselinePrecisionByPr[index]!)),
    candidateRecall: mean(candidateRecallByPr),
    baselineRecall: mean(baselineRecallByPr),
    recallDifference: mean(candidateRecallByPr.map((value, index) => value - baselineRecallByPr[index]!))
  };
  const pooled = {
    candidatePrecision: precision(candidateCounts),
    baselinePrecision: precision(baselineCounts),
    precisionDifference: precision(candidateCounts) - precision(baselineCounts),
    candidateRecall: recall(candidateCounts),
    baselineRecall: recall(baselineCounts),
    recallDifference: recall(candidateCounts) - recall(baselineCounts)
  };

  const bootstrap = bootstrapIntervals(clusters, input.bootstrap.resamples, input.bootstrap.seed, macro);
  const poweredPrecisionN = poweredSampleSize(input.variancePilot.precisionPairedPrSd);
  const poweredRecallN = poweredSampleSize(input.variancePilot.recallPairedPrSd);
  const requiredUniquePrHeads = Math.max(
    MINIMUM_CONFIRMATION_PR_HEADS,
    poweredPrecisionN,
    poweredRecallN
  );
  const requiredDefectPrHeads = Math.max(MINIMUM_CONFIRMATION_DEFECT_PR_HEADS, poweredRecallN);
  const requiredObservationsAtPlannedLook = Math.ceil(input.expectedCohort.length * input.look.fraction);
  const bootstrapStrata = groupStrata(clusters);
  const minimumBootstrapStratumPrHeads = Math.min(...bootstrapStrata.map((stratum) => stratum.length));
  const minimumBootstrapRecallStratumPrHeads = Math.min(
    ...bootstrapStrata.map((stratum) => stratum.filter((cluster) => cluster.artifactSemantics === "defect_present").length)
  );
  const safetyFailures = [
    ["candidate.secretFindings", candidateCounts.secretFindings],
    ["candidate.schemaFailures", candidateCounts.schemaFailures],
    ["candidate.duplicatePolicyViolations", candidateCounts.duplicatePolicyViolations],
    ["candidate.p0p1FalseNegative", candidateCounts.p0p1FalseNegative],
    ["baseline.secretFindings", baselineCounts.secretFindings],
    ["baseline.schemaFailures", baselineCounts.schemaFailures],
    ["baseline.duplicatePolicyViolations", baselineCounts.duplicatePolicyViolations]
  ] as const;
  const failedSafetyFields = safetyFailures.filter(([, count]) => count > 0);

  const gates = [
    {
      name: "planned_look_sample",
      passed: input.observations.length >= requiredObservationsAtPlannedLook,
      detail: `${input.observations.length} sealed observations >= ${requiredObservationsAtPlannedLook}`
    },
    {
      name: "final_look",
      passed: input.look.fraction === 1,
      detail: `${input.look.label}; interim looks cannot promote`
    },
    {
      name: "bootstrap_stratum_support",
      passed: input.look.fraction !== 1 || (
        minimumBootstrapStratumPrHeads >= MINIMUM_FINAL_BOOTSTRAP_STRATUM_PR_HEADS
        && minimumBootstrapRecallStratumPrHeads >= MINIMUM_FINAL_BOOTSTRAP_STRATUM_PR_HEADS
      ),
      detail: `minimum final stratum support ${minimumBootstrapStratumPrHeads} total / ${minimumBootstrapRecallStratumPrHeads} defect PR heads >= ${MINIMUM_FINAL_BOOTSTRAP_STRATUM_PR_HEADS}`
    },
    {
      name: "powered_unique_pr_heads",
      passed: clusters.length >= requiredUniquePrHeads,
      detail: `${clusters.length} >= ${requiredUniquePrHeads}`
    },
    {
      name: "powered_defect_pr_heads",
      passed: defectClusters.length >= requiredDefectPrHeads,
      detail: `${defectClusters.length} >= ${requiredDefectPrHeads}; clean controls are excluded from recall power`
    },
    {
      name: "promotion_clean_controls",
      passed: clusters.length - defectClusters.length >= PROMOTION_CLEAN_CONTROL_FLOOR,
      detail: `${clusters.length - defectClusters.length} >= ${PROMOTION_CLEAN_CONTROL_FLOOR}`
    },
    {
      name: "precision_noninferiority",
      passed: bootstrap.precisionDifference.lower > NONINFERIORITY_MARGIN + COMPARISON_EPSILON,
      detail: `${bootstrap.precisionDifference.lower} > ${NONINFERIORITY_MARGIN}`
    },
    {
      name: "recall_noninferiority",
      passed: bootstrap.recallDifference.lower > NONINFERIORITY_MARGIN + COMPARISON_EPSILON,
      detail: `${bootstrap.recallDifference.lower} > ${NONINFERIORITY_MARGIN}`
    },
    {
      name: "candidate_absolute_precision",
      passed: bootstrap.candidatePrecision.lower + COMPARISON_EPSILON >= ABSOLUTE_PRECISION_FLOOR,
      detail: `${bootstrap.candidatePrecision.lower} >= ${ABSOLUTE_PRECISION_FLOOR}`
    },
    {
      name: "acceptance_set_safety",
      passed: failedSafetyFields.length === 0,
      detail: failedSafetyFields.length === 0
        ? "zero candidate secret/schema/duplicate/P0-P1 false-negative and baseline secret/schema/duplicate failures"
        : `nonzero safety fields: ${failedSafetyFields.map(([name]) => name).join(", ")}`
    }
  ];

  const plannedLookSamplePassed = gatePassed(gates, "planned_look_sample");
  const poweredSamplePassed = gatePassed(gates, "powered_unique_pr_heads")
    && gatePassed(gates, "powered_defect_pr_heads")
    && gatePassed(gates, "bootstrap_stratum_support");
  const promotionPassed = [
    "final_look",
    "bootstrap_stratum_support",
    "powered_unique_pr_heads",
    "powered_defect_pr_heads",
    "promotion_clean_controls",
    "precision_noninferiority",
    "recall_noninferiority",
    "candidate_absolute_precision",
    "acceptance_set_safety"
  ].every((name) => gatePassed(gates, name));

  let decision: PairedReviewBenchDecision;
  if (!gatePassed(gates, "acceptance_set_safety")) {
    decision = "stop_for_safety";
  } else if (!plannedLookSamplePassed) {
    decision = "insufficient_evidence";
  } else if (input.look.fraction === 1 && !poweredSamplePassed) {
    decision = "insufficient_evidence";
  } else if (input.look.fraction < 1) {
    decision = macro.precisionDifference <= -0.1 || macro.recallDifference <= -0.1
      ? "stop_for_futility"
      : "interim_continue";
  } else {
    decision = promotionPassed ? "promote" : "do_not_promote";
  }

  const withoutAnalysisHash = {
    schemaVersion: REVIEW_BENCH_PAIRED_ANALYSIS_VERSION,
    decision,
    inputSha256,
    bindings: {
      corpusHash: input.corpusHash,
      matcherVersion: input.matcherVersion,
      candidateTargetFingerprint: input.candidateTargetFingerprint,
      baselineTargetFingerprint: input.baselineTargetFingerprint,
      candidateMatcherFingerprint: input.candidateMatcherFingerprint,
      baselineMatcherFingerprint: input.baselineMatcherFingerprint,
      adjudicationVersion: input.adjudicationVersion,
      cohortManifestSha256: input.cohortManifestSha256
    },
    hypotheses: {
      precision: "H0: candidate - baseline <= -0.05; H1: candidate - baseline > -0.05",
      recall: "H0: candidate - baseline <= -0.05; H1: candidate - baseline > -0.05",
      absolutePrecision: "candidate macro-PR precision lower bound >= 0.80"
    },
    margins: {
      precisionNoninferiority: NONINFERIORITY_MARGIN,
      recallNoninferiority: NONINFERIORITY_MARGIN,
      candidateAbsolutePrecision: ABSOLUTE_PRECISION_FLOOR
    },
    method: {
      confidenceLevel: 0.95 as const,
      oneSidedAlpha: ONE_SIDED_ALPHA,
      alphaSpendingVersion: REVIEW_BENCH_ALPHA_SPENDING_VERSION,
      multiplicity: "intersection-union-co-primary/v1" as const,
      bootstrapMethod: REVIEW_BENCH_BOOTSTRAP_METHOD,
      bootstrapResamples: input.bootstrap.resamples,
      bootstrapSeed: input.bootstrap.seed,
      promotionEndpoint: "macro_pr" as const,
      cleanControlRecall: "excluded" as const
    },
    sampleSize: {
      observations: input.observations.length,
      uniquePrHeads: clusters.length,
      defectPrHeads: defectClusters.length,
      cleanPrHeads: clusters.length - defectClusters.length,
      plannedCohortObservations: input.expectedCohort.length,
      repositories: new Set(clusters.map((cluster) => cluster.repository)).size,
      languages: new Set(clusters.map((cluster) => cluster.language)).size,
      repositoryLanguageStrata: groupStrata(clusters).length,
      variancePilotPrHeads: input.variancePilot.pairedPrHeads,
      variancePilotDefectPrHeads: input.variancePilot.defectPrHeads,
      poweredPrecisionN,
      poweredRecallN,
      requiredUniquePrHeads,
      requiredDefectPrHeads,
      requiredObservationsAtPlannedLook
    },
    counts: { candidate: candidateCounts, baseline: baselineCounts },
    metrics: { pooledFinding: pooled, macroPr: macro },
    intervals: bootstrap,
    gates,
    proofBoundary: "Internal paired Review Bench role evidence only for the exact corpus, matcher, adjudication, and analysis identities. It is not a public precision, parity, production-readiness, or arbitrary-repository model-quality claim."
  };

  return {
    ...withoutAnalysisHash,
    analysisSha256: sha256(canonicalJson(withoutAnalysisHash))
  };
}

function validateAnalysisInput(input: PairedReviewBenchAnalysisInputV1): void {
  requireObject(input, "analysis input");
  requireExactKeys(input, [
    "schemaVersion",
    "analysisVersion",
    "corpusHash",
    "matcherVersion",
    "candidateTargetFingerprint",
    "baselineTargetFingerprint",
    "candidateMatcherFingerprint",
    "baselineMatcherFingerprint",
    "adjudicationVersion",
    "cohortManifestSha256",
    "expectedCohort",
    "expectedStrata",
    "look",
    "variancePilot",
    "bootstrap",
    "observations"
  ], "analysis input");
  if (input.schemaVersion !== REVIEW_BENCH_PAIRED_ANALYSIS_INPUT_VERSION) {
    throw new Error(`schemaVersion must be ${REVIEW_BENCH_PAIRED_ANALYSIS_INPUT_VERSION}`);
  }
  if (input.analysisVersion !== REVIEW_BENCH_PAIRED_ANALYSIS_VERSION) {
    throw new Error(`analysisVersion must be ${REVIEW_BENCH_PAIRED_ANALYSIS_VERSION}`);
  }
  requireSha256(input.corpusHash, "corpusHash");
  requireVersionIdentity(input.matcherVersion, "matcherVersion");
  requireSha256(input.candidateTargetFingerprint, "candidateTargetFingerprint");
  requireSha256(input.baselineTargetFingerprint, "baselineTargetFingerprint");
  requireSha256(input.candidateMatcherFingerprint, "candidateMatcherFingerprint");
  requireSha256(input.baselineMatcherFingerprint, "baselineMatcherFingerprint");
  if (input.candidateTargetFingerprint === input.baselineTargetFingerprint) {
    throw new Error("candidateTargetFingerprint and baselineTargetFingerprint must differ");
  }
  if (input.candidateMatcherFingerprint === input.baselineMatcherFingerprint) {
    throw new Error("candidateMatcherFingerprint and baselineMatcherFingerprint must differ");
  }
  requireVersionIdentity(input.adjudicationVersion, "adjudicationVersion");
  requireSha256(input.cohortManifestSha256, "cohortManifestSha256");
  validateExpectedCohort(input.expectedCohort);
  if (computePairedReviewBenchCohortHash(input.expectedCohort) !== input.cohortManifestSha256) {
    throw new Error("cohortManifestSha256 does not match the canonical expected cohort");
  }
  const expectedStrata = validateExpectedStrata(input.expectedStrata);
  validateLook(input.look);
  validateVariancePilot(input.variancePilot);
  validateBootstrap(input.bootstrap);
  if (!Array.isArray(input.observations) || input.observations.length === 0) {
    throw new Error("observations must be a non-empty array");
  }
  if (input.observations.length > MAX_OBSERVATIONS) {
    throw new Error(`observations exceeds ${MAX_OBSERVATIONS}`);
  }

  const duplicateKeys = new Set<string>();
  const observationIds = new Set<string>();
  const corpusScenarioIds = new Set<string>();
  for (const [index, observation] of input.observations.entries()) {
    validateObservation(observation, index);
    if (observationIds.has(observation.observationId)) throw new Error("duplicate observationId");
    if (corpusScenarioIds.has(observation.corpusScenarioId)) throw new Error("duplicate corpusScenarioId");
    observationIds.add(observation.observationId);
    corpusScenarioIds.add(observation.corpusScenarioId);
    const duplicateKey = [
      observation.repository,
      observation.pullNumber,
      observation.headSha,
      observation.bugFamily
    ].join("\u0000");
    if (duplicateKeys.has(duplicateKey)) {
      throw new Error("duplicate repository/PR/head/bug-family observation");
    }
    duplicateKeys.add(duplicateKey);
  }
  validateSealedCohort(input.observations, input.expectedCohort, input.look.fraction);
  validateObservedStrata(input.observations, expectedStrata);
}

export function computePairedReviewBenchCohortHash(entries: PairedReviewBenchCohortEntryV1[]): string {
  return sha256(canonicalJson({
    schemaVersion: "review-bench-paired-cohort/v1",
    scenarios: [...entries].sort((a, b) => compareFixed(a.corpusScenarioId, b.corpusScenarioId))
  }));
}

function validateExpectedCohort(entries: PairedReviewBenchCohortEntryV1[]): void {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error("expectedCohort must be a non-empty array");
  }
  if (entries.length > MAX_OBSERVATIONS) throw new Error(`expectedCohort exceeds ${MAX_OBSERVATIONS}`);
  const scenarioIds = new Set<string>();
  const analysisOrders = new Set<number>();
  const duplicateKeys = new Set<string>();
  const clusterMetadata = new Map<string, {
    language: ReviewBenchLanguage;
    artifactSemantics: ReviewBenchArtifactSemantics;
  }>();
  for (const [index, entry] of entries.entries()) {
    const path = `expectedCohort[${index}]`;
    requireObject(entry, path);
    requireExactKeys(entry, [
      "corpusScenarioId",
      "analysisOrder",
      "repository",
      "pullNumber",
      "headSha",
      "language",
      "bugFamily",
      "artifactSemantics"
    ], path);
    requireSafeIdentity(entry.corpusScenarioId, `${path}.corpusScenarioId`);
    if (scenarioIds.has(entry.corpusScenarioId)) throw new Error("duplicate corpusScenarioId in expectedCohort");
    scenarioIds.add(entry.corpusScenarioId);
    requireInteger(entry.analysisOrder, `${path}.analysisOrder`, 1, entries.length);
    if (analysisOrders.has(entry.analysisOrder)) throw new Error("duplicate analysisOrder in expectedCohort");
    analysisOrders.add(entry.analysisOrder);
    validateCohortIdentity(entry, path);
    const duplicateKey = [entry.repository, entry.pullNumber, entry.headSha, entry.bugFamily].join("\u0000");
    if (duplicateKeys.has(duplicateKey)) {
      throw new Error("duplicate repository/PR/head/bug-family in expectedCohort");
    }
    duplicateKeys.add(duplicateKey);
    const clusterKey = [entry.repository, entry.pullNumber, entry.headSha].join("\u0000");
    const prior = clusterMetadata.get(clusterKey);
    if (prior && (prior.language !== entry.language || prior.artifactSemantics !== entry.artifactSemantics)) {
      throw new Error("expectedCohort PR-head cluster has inconsistent language or artifact semantics");
    }
    clusterMetadata.set(clusterKey, {
      language: entry.language,
      artifactSemantics: entry.artifactSemantics
    });
  }
  if (analysisOrders.size !== entries.length) {
    throw new Error("expectedCohort analysisOrder must be contiguous from 1 through cohort size");
  }
}

function validateSealedCohort(
  observations: PairedReviewBenchObservationV1[],
  expectedCohort: PairedReviewBenchCohortEntryV1[],
  lookFraction: 0.5 | 0.75 | 1
): void {
  const plannedLookSize = Math.ceil(expectedCohort.length * lookFraction);
  if (lookFraction === 1 && observations.length !== expectedCohort.length) {
    throw new Error("final look must contain the complete frozen cohort");
  }
  if (observations.length > plannedLookSize) {
    throw new Error("planned look must use one frozen final cohort and its registered prefix");
  }
  const expectedPrefix = [...expectedCohort]
    .sort((a, b) => a.analysisOrder - b.analysisOrder)
    .slice(0, observations.length);
  const expected = new Map(expectedPrefix.map((entry) => [entry.corpusScenarioId, entry]));
  for (const observation of observations) {
    const entry = expected.get(observation.corpusScenarioId);
    if (!entry) throw new Error("observation is not present in the sealed cohort");
    const observedIdentity: PairedReviewBenchCohortEntryV1 = {
      corpusScenarioId: observation.corpusScenarioId,
      analysisOrder: entry.analysisOrder,
      repository: observation.repository,
      pullNumber: observation.pullNumber,
      headSha: observation.headSha,
      language: observation.language,
      bugFamily: observation.bugFamily,
      artifactSemantics: observation.artifactSemantics
    };
    if (canonicalJson(observedIdentity) !== canonicalJson(entry)) {
      throw new Error(`observation ${observation.corpusScenarioId} does not match its sealed cohort identity`);
    }
  }
}

function validateCohortIdentity(entry: PairedReviewBenchCohortEntryV1, path: string): void {
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(entry.repository)) {
    throw new Error(`${path}.repository must be a canonical lowercase owner/repository identity`);
  }
  requireInteger(entry.pullNumber, `${path}.pullNumber`, 1);
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(entry.headSha)) {
    throw new Error(`${path}.headSha must be a lowercase 40- or 64-character hexadecimal digest`);
  }
  if (!REVIEW_BENCH_LANGUAGES.includes(entry.language)) {
    throw new Error(`${path}.language must be a supported Review Bench language`);
  }
  if (!isRegressionCategory(entry.bugFamily)) {
    throw new Error(`${path}.bugFamily must be a Review Bench regression category`);
  }
  if (entry.artifactSemantics !== "defect_present" && entry.artifactSemantics !== "verified_clean") {
    throw new Error(`${path}.artifactSemantics must be defect_present or verified_clean`);
  }
}

function validateExpectedStrata(
  strata: PairedReviewBenchAnalysisInputV1["expectedStrata"]
): Map<string, { minimumPrHeads: number; minimumDefectPrHeads: number }> {
  if (!Array.isArray(strata) || strata.length === 0) {
    throw new Error("expectedStrata must be a non-empty array");
  }
  if (strata.length > 1_000) throw new Error("expectedStrata exceeds 1000 entries");
  const expected = new Map<string, number>();
  const expectedDefects = new Map<string, number>();
  const repositories = new Set<string>();
  const languages = new Set<ReviewBenchLanguage>();
  for (const [index, stratum] of strata.entries()) {
    const path = `expectedStrata[${index}]`;
    requireObject(stratum, path);
    requireExactKeys(stratum, [
      "repository",
      "language",
      "minimumPrHeads",
      "minimumDefectPrHeads"
    ], path);
    if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(stratum.repository)) {
      throw new Error(`${path}.repository must be a canonical lowercase owner/repository identity`);
    }
    if (!REVIEW_BENCH_LANGUAGES.includes(stratum.language)) {
      throw new Error(`${path}.language must be a supported Review Bench language`);
    }
    if (!Number.isSafeInteger(stratum.minimumPrHeads) || stratum.minimumPrHeads < 2) {
      throw new Error(`${path}.minimumPrHeads must be at least 2`);
    }
    if (!Number.isSafeInteger(stratum.minimumDefectPrHeads) || stratum.minimumDefectPrHeads < 2) {
      throw new Error(`${path}.minimumDefectPrHeads must be at least 2`);
    }
    if (stratum.minimumDefectPrHeads > stratum.minimumPrHeads) {
      throw new Error(`${path}.minimumDefectPrHeads cannot exceed minimumPrHeads`);
    }
    const key = `${stratum.repository}\u0000${stratum.language}`;
    if (expected.has(key)) throw new Error("duplicate expected repository/language stratum");
    expected.set(key, stratum.minimumPrHeads);
    expectedDefects.set(key, stratum.minimumDefectPrHeads);
    repositories.add(stratum.repository);
    languages.add(stratum.language);
  }
  if (repositories.size < 10) throw new Error("expectedStrata must cover at least 10 repositories");
  if (languages.size < 6) throw new Error("expectedStrata must cover at least 6 languages");
  return new Map([...expected].map(([key, minimumPrHeads]) => [
    key,
    { minimumPrHeads, minimumDefectPrHeads: expectedDefects.get(key)! }
  ]));
}

function validateObservedStrata(
  observations: PairedReviewBenchObservationV1[],
  expected: Map<string, { minimumPrHeads: number; minimumDefectPrHeads: number }>
): void {
  const observed = new Map<string, Set<string>>();
  const observedDefects = new Map<string, Set<string>>();
  for (const observation of observations) {
    const stratumKey = `${observation.repository}\u0000${observation.language}`;
    if (!expected.has(stratumKey)) throw new Error("unexpected repository/language stratum");
    const clusters = observed.get(stratumKey) ?? new Set<string>();
    clusters.add(`${observation.repository}\u0000${observation.pullNumber}\u0000${observation.headSha}`);
    observed.set(stratumKey, clusters);
    if (observation.artifactSemantics === "defect_present") {
      const defectClusters = observedDefects.get(stratumKey) ?? new Set<string>();
      defectClusters.add(`${observation.repository}\u0000${observation.pullNumber}\u0000${observation.headSha}`);
      observedDefects.set(stratumKey, defectClusters);
    }
  }
  for (const [key, minimums] of expected) {
    const count = observed.get(key)?.size ?? 0;
    if (count < minimums.minimumPrHeads) {
      throw new Error(`expected repository/language stratum has ${count} PR heads; minimum is ${minimums.minimumPrHeads}`);
    }
    const defectCount = observedDefects.get(key)?.size ?? 0;
    if (defectCount < minimums.minimumDefectPrHeads) {
      throw new Error(`expected repository/language recall stratum has ${defectCount} defect PR heads; minimum is ${minimums.minimumDefectPrHeads}`);
    }
  }
}

function validateLook(look: PairedReviewBenchAnalysisInputV1["look"]): void {
  requireObject(look, "look");
  requireExactKeys(look, ["label", "fraction"], "look");
  const valid = (look.label === "50_percent" && look.fraction === 0.5)
    || (look.label === "75_percent" && look.fraction === 0.75)
    || (look.label === "final" && look.fraction === 1);
  if (!valid) throw new Error("look must be the preregistered 50%, 75%, or final look");
}

function validateVariancePilot(pilot: PairedReviewBenchAnalysisInputV1["variancePilot"]): void {
  requireObject(pilot, "variancePilot");
  requireExactKeys(pilot, [
    "pairedPrHeads",
    "defectPrHeads",
    "precisionPairedPrSd",
    "recallPairedPrSd",
    "evidenceSha256"
  ], "variancePilot");
  requireInteger(pilot.pairedPrHeads, "variancePilot.pairedPrHeads", 30);
  requireInteger(pilot.defectPrHeads, "variancePilot.defectPrHeads", 1);
  if (pilot.defectPrHeads > pilot.pairedPrHeads) {
    throw new Error("variancePilot.defectPrHeads cannot exceed pairedPrHeads");
  }
  requireFiniteRange(pilot.precisionPairedPrSd, "variancePilot.precisionPairedPrSd", 0, 1);
  requireFiniteRange(pilot.recallPairedPrSd, "variancePilot.recallPairedPrSd", 0, 1);
  requireSha256(pilot.evidenceSha256, "variancePilot.evidenceSha256");
}

function validateBootstrap(bootstrap: PairedReviewBenchAnalysisInputV1["bootstrap"]): void {
  requireObject(bootstrap, "bootstrap");
  requireExactKeys(bootstrap, ["method", "resamples", "seed"], "bootstrap");
  if (bootstrap.method !== REVIEW_BENCH_BOOTSTRAP_METHOD) {
    throw new Error(`bootstrap.method must be ${REVIEW_BENCH_BOOTSTRAP_METHOD}`);
  }
  requireInteger(bootstrap.resamples, "bootstrap.resamples", 1_000, 100_000);
  requireInteger(bootstrap.seed, "bootstrap.seed", 0, 0xffff_ffff);
}

function validateObservation(observation: PairedReviewBenchObservationV1, index: number): void {
  const path = `observations[${index}]`;
  requireObject(observation, path);
  requireExactKeys(observation, [
    "schemaVersion",
    "observationId",
    "corpusScenarioId",
    "repository",
    "pullNumber",
    "headSha",
    "language",
    "bugFamily",
    "artifactSemantics",
    "adjudication",
    "candidate",
    "baseline"
  ], path);
  if (observation.schemaVersion !== REVIEW_BENCH_PAIRED_OBSERVATION_VERSION) {
    throw new Error(`${path}.schemaVersion must be ${REVIEW_BENCH_PAIRED_OBSERVATION_VERSION}`);
  }
  requireSafeIdentity(observation.observationId, `${path}.observationId`);
  requireSafeIdentity(observation.corpusScenarioId, `${path}.corpusScenarioId`);
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(observation.repository)) {
    throw new Error(`${path}.repository must be a canonical lowercase owner/repository identity`);
  }
  requireInteger(observation.pullNumber, `${path}.pullNumber`, 1);
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(observation.headSha)) {
    throw new Error(`${path}.headSha must be a lowercase 40- or 64-character hexadecimal digest`);
  }
  if (!REVIEW_BENCH_LANGUAGES.includes(observation.language)) {
    throw new Error(`${path}.language must be a supported Review Bench language`);
  }
  if (!isRegressionCategory(observation.bugFamily)) {
    throw new Error(`${path}.bugFamily must be a Review Bench regression category`);
  }
  if (observation.artifactSemantics !== "defect_present" && observation.artifactSemantics !== "verified_clean") {
    throw new Error(`${path}.artifactSemantics must be defect_present or verified_clean`);
  }
  validateAdjudication(observation.adjudication, `${path}.adjudication`);
  validateArm(observation.candidate, `${path}.candidate`);
  validateArm(observation.baseline, `${path}.baseline`);

  const candidateLabels = checkedCountAdd(observation.candidate.truePositive, observation.candidate.falseNegative);
  const baselineLabels = checkedCountAdd(observation.baseline.truePositive, observation.baseline.falseNegative);
  if (candidateLabels !== baselineLabels) {
    throw new Error(`${path} candidate and baseline must bind the same adjudicated gold-label count`);
  }
  if (observation.artifactSemantics === "defect_present" && candidateLabels === 0) {
    throw new Error(`${path} defect_present observation must have at least one adjudicated gold label`);
  }
  if (observation.artifactSemantics === "verified_clean" && candidateLabels !== 0) {
    throw new Error(`${path} verified_clean observation must have zero adjudicated gold labels`);
  }
}

function validateAdjudication(
  adjudication: PairedReviewBenchObservationV1["adjudication"],
  path: string
): void {
  requireObject(adjudication, path);
  requireExactKeys(adjudication, [
    "status",
    "evidenceSha256",
    "blindedToProviderIdentity",
    "unresolvedNearMisses"
  ], path);
  if (adjudication.status !== "complete") throw new Error(`${path} adjudication status must be complete`);
  requireSha256(adjudication.evidenceSha256, `${path}.evidenceSha256`);
  if (adjudication.blindedToProviderIdentity !== true) {
    throw new Error(`${path}.blindedToProviderIdentity must be true`);
  }
  if (adjudication.unresolvedNearMisses !== 0) {
    throw new Error(`${path}.unresolvedNearMisses must be zero`);
  }
}

function validateArm(arm: PairedReviewBenchArmEvidenceV1, path: string): void {
  requireObject(arm, path);
  requireExactKeys(arm, [
    "evidenceSha256",
    "findingCount",
    "truePositive",
    "falsePositive",
    "falseNegative",
    "p0p1FalseNegative",
    "schemaFailures",
    "secretFindings",
    "duplicatePolicyViolations"
  ], path);
  requireSha256(arm.evidenceSha256, `${path}.evidenceSha256`);
  for (const field of [
    "findingCount",
    "truePositive",
    "falsePositive",
    "falseNegative",
    "p0p1FalseNegative",
    "schemaFailures",
    "secretFindings",
    "duplicatePolicyViolations"
  ] as const) {
    requireInteger(arm[field], `${path}.${field}`, 0);
  }
  if (arm.findingCount !== arm.truePositive + arm.falsePositive) {
    throw new Error(`${path}.findingCount must equal truePositive + falsePositive`);
  }
  if (arm.p0p1FalseNegative > arm.falseNegative) {
    throw new Error(`${path}.p0p1FalseNegative cannot exceed falseNegative`);
  }
}

function buildPrClusters(observations: PairedReviewBenchObservationV1[]): PrCluster[] {
  const clusters = new Map<string, PrCluster>();
  for (const observation of observations) {
    const key = [observation.repository, observation.pullNumber, observation.headSha].join("\u0000");
    const existing = clusters.get(key);
    if (!existing) {
      clusters.set(key, {
        key,
        repository: observation.repository,
        language: observation.language,
        artifactSemantics: observation.artifactSemantics,
        candidate: copyArmCounts(observation.candidate),
        baseline: copyArmCounts(observation.baseline)
      });
      continue;
    }
    if (existing.language !== observation.language) {
      throw new Error("all bug-family observations in one PR-head cluster must use the same language stratum");
    }
    if (existing.artifactSemantics !== observation.artifactSemantics) {
      throw new Error("all bug-family observations in one PR-head cluster must use the same artifact semantics");
    }
    addArmCounts(existing.candidate, observation.candidate);
    addArmCounts(existing.baseline, observation.baseline);
  }
  return [...clusters.values()].sort((a, b) => compareFixed(a.key, b.key));
}

function bootstrapIntervals(
  clusters: PrCluster[],
  resamples: number,
  seed: number,
  point: PairedReviewBenchAnalysisResultV1["metrics"]["macroPr"]
): PairedReviewBenchAnalysisResultV1["intervals"] {
  const random = seededRandom(seed);
  const allStrata = groupStrata(clusters);
  const defectStrata = groupStrata(clusters.filter((cluster) => cluster.artifactSemantics === "defect_present"));
  const candidatePrecisions: number[] = [];
  const precisionDifferences: number[] = [];
  const candidateRecalls: number[] = [];
  const recallDifferences: number[] = [];

  for (let iteration = 0; iteration < resamples; iteration += 1) {
    const precisionSample = sampleStrata(allStrata, random);
    const recallSample = sampleStrata(defectStrata, random);
    const candidatePrecision = mean(precisionSample.map((cluster) => precision(cluster.candidate)));
    const baselinePrecision = mean(precisionSample.map((cluster) => precision(cluster.baseline)));
    const candidateRecall = mean(recallSample.map((cluster) => recall(cluster.candidate)));
    const baselineRecall = mean(recallSample.map((cluster) => recall(cluster.baseline)));
    candidatePrecisions.push(candidatePrecision);
    precisionDifferences.push(candidatePrecision - baselinePrecision);
    candidateRecalls.push(candidateRecall);
    recallDifferences.push(candidateRecall - baselineRecall);
  }

  return {
    candidatePrecision: interval(candidatePrecisions, point.candidatePrecision),
    precisionDifference: interval(precisionDifferences, point.precisionDifference),
    candidateRecall: interval(candidateRecalls, point.candidateRecall),
    recallDifference: interval(recallDifferences, point.recallDifference)
  };
}

function groupStrata(clusters: PrCluster[]): PrCluster[][] {
  const grouped = new Map<string, PrCluster[]>();
  for (const cluster of clusters) {
    const key = `${cluster.repository}\u0000${cluster.language}`;
    const stratum = grouped.get(key) ?? [];
    stratum.push(cluster);
    grouped.set(key, stratum);
  }
  return [...grouped.entries()]
    .sort(([a], [b]) => compareFixed(a, b))
    .map(([, stratum]) => stratum);
}

function sampleStrata(strata: PrCluster[][], random: () => number): PrCluster[] {
  const sampled: PrCluster[] = [];
  for (const stratum of strata) {
    for (let index = 0; index < stratum.length; index += 1) {
      sampled.push(stratum[Math.floor(random() * stratum.length)]!);
    }
  }
  return sampled;
}

function interval(samples: number[], point: number): ReviewBenchIntervalV1 {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    lower: quantile(sorted, ONE_SIDED_ALPHA),
    point,
    upper: quantile(sorted, 1 - ONE_SIDED_ALPHA)
  };
}

function quantile(sorted: number[], probability: number): number {
  if (sorted.length === 0) throw new Error("cannot compute an interval without samples");
  const position = (sorted.length - 1) * probability;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const lower = sorted[lowerIndex]!;
  const upper = sorted[upperIndex]!;
  return lower + (upper - lower) * (position - lowerIndex);
}

function poweredSampleSize(pairedPrSd: number): number {
  return Math.ceil((((Z_95_TWO_SIDED + Z_80_POWER) * pairedPrSd) / POWER_MARGIN) ** 2);
}

function precision(counts: Pick<ArmCounts, "truePositive" | "falsePositive">): number {
  return 1 - counts.falsePositive / Math.max(1, counts.truePositive + counts.falsePositive);
}

function recall(counts: Pick<ArmCounts, "truePositive" | "falseNegative">): number {
  const labels = checkedCountAdd(counts.truePositive, counts.falseNegative);
  if (labels === 0) throw new Error("recall is undefined for verified-clean evidence");
  return counts.truePositive / labels;
}

function mean(values: number[]): number {
  if (values.length === 0) throw new Error("cannot compute a macro endpoint without eligible PR clusters");
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function copyArmCounts(arm: PairedReviewBenchArmEvidenceV1): ArmCounts {
  return {
    findingCount: arm.findingCount,
    truePositive: arm.truePositive,
    falsePositive: arm.falsePositive,
    falseNegative: arm.falseNegative,
    p0p1FalseNegative: arm.p0p1FalseNegative,
    schemaFailures: arm.schemaFailures,
    secretFindings: arm.secretFindings,
    duplicatePolicyViolations: arm.duplicatePolicyViolations
  };
}

function addArmCounts(target: ArmCounts, source: PairedReviewBenchArmEvidenceV1): void {
  target.findingCount = checkedCountAdd(target.findingCount, source.findingCount);
  target.truePositive = checkedCountAdd(target.truePositive, source.truePositive);
  target.falsePositive = checkedCountAdd(target.falsePositive, source.falsePositive);
  target.falseNegative = checkedCountAdd(target.falseNegative, source.falseNegative);
  target.p0p1FalseNegative = checkedCountAdd(target.p0p1FalseNegative, source.p0p1FalseNegative);
  target.schemaFailures = checkedCountAdd(target.schemaFailures, source.schemaFailures);
  target.secretFindings = checkedCountAdd(target.secretFindings, source.secretFindings);
  target.duplicatePolicyViolations = checkedCountAdd(
    target.duplicatePolicyViolations,
    source.duplicatePolicyViolations
  );
}

function checkedCountAdd(left: number, right: number): number {
  const total = left + right;
  if (!Number.isSafeInteger(total)) throw new Error("aggregate count exceeds safe integer range");
  return total;
}

function sumArmCounts(arms: ArmCounts[]): ArmCounts {
  const total: ArmCounts = {
    findingCount: 0,
    truePositive: 0,
    falsePositive: 0,
    falseNegative: 0,
    p0p1FalseNegative: 0,
    schemaFailures: 0,
    secretFindings: 0,
    duplicatePolicyViolations: 0
  };
  for (const arm of arms) addArmCounts(total, { evidenceSha256: "0".repeat(64), ...arm });
  return total;
}

function gatePassed(gates: Array<{ name: string; passed: boolean }>, name: string): boolean {
  return gates.find((gate) => gate.name === name)?.passed === true;
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function requireObject(value: unknown, path: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
}

function requireExactKeys(value: object, allowed: readonly string[], path: string): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) throw new Error(`unknown ${path} field: ${key}`);
  }
  for (const key of allowed) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) throw new Error(`${path}.${key} is required`);
  }
}

function requireSha256(value: string, path: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`${path} must be a lowercase SHA-256 digest`);
}

function requireVersionIdentity(value: string, path: string): void {
  if (!/^[a-z0-9][a-z0-9_.-]*\/v[1-9][0-9]*$/.test(value)) {
    throw new Error(`${path} must be a versioned lowercase identity`);
  }
}

function requireSafeIdentity(value: string, path: string): void {
  if (!/^[a-z0-9][a-z0-9_.:-]{0,127}$/.test(value)) {
    throw new Error(`${path} must be a bounded lowercase ASCII identity`);
  }
}

function requireInteger(value: number, path: string, minimum: number, maximum = Number.MAX_SAFE_INTEGER): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${path} must be an integer from ${minimum} through ${maximum}`);
  }
}

function requireFiniteRange(value: number, path: string, minimum: number, maximum: number): void {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${path} must be finite and between ${minimum} and ${maximum}`);
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort(compareFixed)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function compareFixed(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
