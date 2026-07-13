import { createHash, randomBytes } from "node:crypto";
import {
  constants,
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { TextDecoder } from "node:util";
import { containsSecretLikeText } from "./secrets.js";

const BUCKETS = ["16k", "32k", "64k", "128k"] as const;
type Phase1Bucket = typeof BUCKETS[number];
type BucketCounts = Record<Phase1Bucket, number>;
export type Phase1SelectionProfile = "stratified_transport" | "natural_quality";
const MAX_CANDIDATE_POOL_BYTES = 16 * 1024 * 1024;
const MAX_POLICY_BYTES = 256 * 1024;
const MAX_CANDIDATE_POOL_SIZE = 64;
const MIN_CANONICAL_SEARCH_STATES = 100_000;
const MAX_CANONICAL_SEARCH_STATES = 5_000_000;
export const PHASE1_COHORT_PROOF_BOUNDARY = "This may prove only that a metadata-only 14-case advisory cohort is selected and immutably sealed under the named workload and privacy contracts. It does not admit Corpus v1 scenarios, prove labels, review quality, noninferiority, production routing, runtime safety, customer readiness, or public claims. No model run may begin until separate hidden outcomes, blinded adjudication, and restricted identity sidecars pass their own gates.";
export const PHASE1_COHORT_LANGUAGES = Object.freeze([
  "typescript", "javascript", "swift", "python", "go", "rust", "java", "kotlin",
  "csharp", "cpp", "ruby", "php", "shell", "sql"
] as const);
export const PHASE1_COHORT_RISK_TAGS = Object.freeze([
  "security", "auth", "release", "state-machine", "concurrency", "migration", "architecture",
  "simplification", "correctness", "config", "debugging", "ci", "state", "privacy", "licensing",
  "performance", "reliability"
] as const);
const PHASE1_COHORT_LANGUAGE_SET = new Set<string>(PHASE1_COHORT_LANGUAGES);
const PHASE1_COHORT_RISK_TAG_SET = new Set<string>(PHASE1_COHORT_RISK_TAGS);

export interface Phase1Candidate {
  candidateId: string;
  sourceIdentitySha256: string;
  inputArtifactSha256: string;
  admissionEstimatedPromptTokens: number;
  bucket: Phase1Bucket;
  repositoryGroup: string;
  lineageGroup: string;
  language: string;
  riskTags: string[];
  caseKind: "defect_candidate" | "clean_control_candidate";
  eligibility: {
    currentHead: boolean;
    redactionPassed: boolean;
    secretScanPassed: boolean;
    immutableInput: boolean;
    sourcePolicyPassed: boolean;
  };
}

interface Phase1CohortPolicyBase {
  selectionProfile: Phase1SelectionProfile;
  cohortSize: number;
  outputTokens: number;
  maximumFindings: number;
  minimumCleanControls: number;
  minimumRepositoryGroups: number;
  minimumLanguages: number;
  minimumHighRisk: number;
  maximumPerRepositoryGroup: number;
  maximumCandidatePoolSize: number;
  maximumCanonicalSearchStates: number;
  selectionSeed: string;
  admissionEstimatorFingerprint: string;
  promptBuilderFingerprint: string;
  parserFingerprint: string;
  gateFingerprint: string;
  redactorFingerprint: string;
  secretScannerFingerprint: string;
  sourcePolicyFingerprint: string;
  safeOutputRoot: string;
  proofBoundary: string;
}

export interface Phase1StratifiedTransportPolicy extends Phase1CohortPolicyBase {
  selectionProfile: "stratified_transport";
  bucketQuotas: BucketCounts;
  firstFiveBucketQuotas: BucketCounts;
}

export interface Phase1NaturalQualityPolicy extends Phase1CohortPolicyBase {
  selectionProfile: "natural_quality";
}

export type Phase1CohortPolicy = Phase1StratifiedTransportPolicy | Phase1NaturalQualityPolicy;

export interface Phase1CohortSelectionOptions {
  candidatePoolPath: string;
  candidatePoolSha256: string;
  policyPath: string;
  policySha256: string;
  outputDir: string;
  allowedOutputRoot: string;
}

export interface Phase1SelectionManifest {
  schemaVersion: "neondiff-phase1-selection-manifest/v2";
  selectionProfile: Phase1SelectionProfile;
  candidatePoolSha256: string;
  policySha256: string;
  selectionSeed: string;
  fingerprints: {
    admissionEstimator: string;
    promptBuilder: string;
    parser: string;
    gate: string;
    redactor: string;
    secretScanner: string;
    sourcePolicy: string;
  };
  contract: {
    cohortSize: 14;
    bucketQuotas?: BucketCounts;
    firstFiveBucketQuotas?: BucketCounts;
    outputTokens: 2048;
    maximumFindings: 5;
    maximumCandidatePoolSize: 64;
    maximumCanonicalSearchStates: number;
  };
  selectedCandidateIds: string[];
  strata: {
    admissionEstimatedPromptBucketCounts: BucketCounts;
    caseKindCounts: Record<Phase1Candidate["caseKind"], number>;
  };
  diversity: {
    repositoryGroupCount: number;
    languageCount: number;
    highRiskCount: number;
    cleanControlCount: number;
    maximumRepositoryGroupCount: number;
    repositoryGroupCounts: Record<string, number>;
    languageCounts: Record<string, number>;
  };
  firstFive?: {
    candidateIds: string[];
    bucketCounts: BucketCounts;
    cleanControlCount: number;
  };
  proofBoundary: string;
  outcomeVisibility: "not_present";
  qualityReady: false;
}

export type Phase1SelectionResult = Phase1SelectionManifest & { manifestSha256: string };

const CANDIDATE_KEYS = [
  "candidateId", "sourceIdentitySha256", "inputArtifactSha256", "admissionEstimatedPromptTokens", "bucket",
  "repositoryGroup", "lineageGroup", "language", "riskTags", "caseKind", "eligibility"
] as const;
const ELIGIBILITY_KEYS = [
  "currentHead", "redactionPassed", "secretScanPassed", "immutableInput", "sourcePolicyPassed"
] as const;
const COMMON_POLICY_KEYS = [
  "selectionProfile", "cohortSize", "outputTokens", "maximumFindings",
  "minimumCleanControls", "minimumRepositoryGroups", "minimumLanguages", "minimumHighRisk",
  "maximumPerRepositoryGroup", "maximumCandidatePoolSize", "maximumCanonicalSearchStates",
  "selectionSeed", "admissionEstimatorFingerprint", "promptBuilderFingerprint",
  "parserFingerprint", "gateFingerprint", "redactorFingerprint", "secretScannerFingerprint",
  "sourcePolicyFingerprint", "safeOutputRoot", "proofBoundary"
] as const;
const TRANSPORT_POLICY_KEYS = [...COMMON_POLICY_KEYS, "bucketQuotas", "firstFiveBucketQuotas"] as const;
const FORBIDDEN_INPUT_KEYS = new Set([
  "reponame", "repositoryname", "pr", "prnumber", "pullrequest", "pullrequestnumber",
  "headsha", "headsha256", "prompt", "prompttext", "code", "codecontent", "content", "path",
  "filepath", "outcome", "outcomes", "verdict", "verdicts", "label", "labels", "goldanswer",
  "goldanswers", "answer", "answers", "adjudication", "adjudications", "finding", "findings",
  "provideroutput", "credential", "credentials", "reviewer", "revieweridentity"
]);

export function selectAndSealPhase1Cohort(options: Phase1CohortSelectionOptions): Phase1SelectionResult {
  const inputs = loadAndValidate(options);
  const sealed = buildSealedArtifacts(inputs);
  if (existsSync(options.outputDir)) {
    verifyArtifactBytes(options.outputDir, sealed.artifacts);
    return { ...sealed.manifest, manifestSha256: sealed.manifestSha256 };
  }
  finalizeNewArtifacts(options.outputDir, sealed.artifacts);
  verifyArtifactBytes(options.outputDir, sealed.artifacts);
  return { ...sealed.manifest, manifestSha256: sealed.manifestSha256 };
}

export function verifyPhase1CohortSeal(options: Phase1CohortSelectionOptions): {
  ok: true;
  selectionProfile: Phase1SelectionProfile;
  manifestSha256: string;
} {
  const inputs = loadAndValidate(options);
  const sealed = buildSealedArtifacts(inputs);
  verifyArtifactBytes(options.outputDir, sealed.artifacts);
  return {
    ok: true,
    selectionProfile: sealed.manifest.selectionProfile,
    manifestSha256: sealed.manifestSha256
  };
}

function buildSealedArtifacts(inputs: {
  candidates: Phase1Candidate[];
  policy: Phase1CohortPolicy;
  candidatePoolSha256: string;
  policySha256: string;
}): { manifest: Phase1SelectionManifest; manifestSha256: string; artifacts: Map<string, string> } {
  const manifest = buildSelectionManifest(inputs.candidates, inputs.policy, inputs.candidatePoolSha256, inputs.policySha256);
  const manifestBytes = jsonBytes(manifest);
  const manifestSha256 = sha256(manifestBytes);
  const runtimeBytes = jsonBytes(buildRuntimeInputManifest(inputs.candidates, manifest, manifestSha256));
  const receiptBytes = jsonBytes({
    schemaVersion: "neondiff-phase1-selection-receipt/v2",
    selectionProfile: inputs.policy.selectionProfile,
    selectionManifestSha256: manifestSha256,
    runtimeInputManifestSha256: sha256(runtimeBytes),
    candidatePoolSha256: inputs.candidatePoolSha256,
    policySha256: inputs.policySha256,
    outcomeVisibility: "not_present",
    hiddenOutcomeReceipt: "not_bound",
    qualityReady: false,
    proofBoundary: inputs.policy.proofBoundary
  });
  return { manifest, manifestSha256, artifacts: new Map([
    ["selection-manifest.json", manifestBytes],
    ["runtime-input-manifest.json", runtimeBytes],
    ["selection-receipt.json", receiptBytes],
    ["SEALED", `${manifestSha256}\n`]
  ]) };
}

function loadAndValidate(options: Phase1CohortSelectionOptions): {
  candidates: Phase1Candidate[];
  policy: Phase1CohortPolicy;
  candidatePoolSha256: string;
  policySha256: string;
} {
  assertSha256(options.candidatePoolSha256, "declared candidate pool SHA-256");
  assertSha256(options.policySha256, "declared policy SHA-256");
  const candidateBytes = readBoundedFile(options.candidatePoolPath, MAX_CANDIDATE_POOL_BYTES, "candidate pool");
  const policyBytes = readBoundedFile(options.policyPath, MAX_POLICY_BYTES, "policy");
  const candidatePoolSha256 = sha256(candidateBytes);
  const policySha256 = sha256(policyBytes);
  if (candidatePoolSha256 !== options.candidatePoolSha256) throw new Error("candidate pool SHA-256 does not match the independently supplied trust pin");
  if (policySha256 !== options.policySha256) throw new Error("policy SHA-256 does not match the independently supplied trust pin");
  const candidateValue = parseJson(candidateBytes, "candidate pool");
  const policyValue = parseJson(policyBytes, "cohort policy");
  assertNoForbiddenKeys(candidateValue);
  assertNoForbiddenKeys(policyValue);
  assertSecretSafe(candidateValue, "candidate pool");
  assertSecretSafe(policyValue, "cohort policy");
  const policy = validatePolicy(policyValue);
  const candidates = validateCandidates(candidateValue, policy.selectionProfile);
  if (candidates.length > policy.maximumCandidatePoolSize) {
    throw new Error(`candidate pool exceeds the frozen maximum of ${policy.maximumCandidatePoolSize} rows`);
  }
  const allowedOutputRoot = validateAllowedOutputRoot(options.allowedOutputRoot, policy.safeOutputRoot);
  validateOutputBoundary(options.outputDir, allowedOutputRoot);
  return {
    candidates,
    policy,
    candidatePoolSha256,
    policySha256
  };
}

function validateCandidates(value: unknown, profile: Phase1SelectionProfile): Phase1Candidate[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("candidate pool must be a non-empty JSON array");
  const candidates = value.map((item, index) => {
    assertRecord(item, `candidate ${index}`);
    assertExactKeys(item, CANDIDATE_KEYS, `candidate ${index}`);
    assertRecord(item.eligibility, `candidate ${index} eligibility`);
    assertExactKeys(item.eligibility, ELIGIBILITY_KEYS, `candidate ${index} eligibility`);
    assertOpaqueIdentifier(item.candidateId, "candidate", `candidate ${index} ID`);
    assertSha256(item.sourceIdentitySha256, `candidate ${index} source identity SHA-256`);
    assertSha256(item.inputArtifactSha256, `candidate ${index} input artifact SHA-256`);
    const estimatedTokens = item.admissionEstimatedPromptTokens;
    if (!Number.isInteger(estimatedTokens)) throw new Error(`candidate ${index} admission estimated prompt token count must be an integer`);
    const expectedBucket = admissionEstimatedBucket(estimatedTokens as number);
    if (profile === "stratified_transport" && (estimatedTokens as number) < 8_193) {
      throw new Error(`candidate ${index} admission estimated prompt token count is below the stratified transport floor`);
    }
    if (item.bucket !== expectedBucket) throw new Error(`candidate ${index} bucket does not match the admission estimated prompt token range`);
    assertOpaqueIdentifier(item.repositoryGroup, "repo", `candidate ${index} repository group`);
    assertOpaqueIdentifier(item.lineageGroup, "lineage", `candidate ${index} lineage group`);
    if (typeof item.language !== "string" || !PHASE1_COHORT_LANGUAGE_SET.has(item.language)) {
      throw new Error(`candidate ${index} language must use the frozen language allowlist`);
    }
    if (!Array.isArray(item.riskTags) || item.riskTags.some((tag) => typeof tag !== "string" || !PHASE1_COHORT_RISK_TAG_SET.has(tag))) {
      throw new Error(`candidate ${index} risk tags must use the frozen allowlist of safe normalized tokens`);
    }
    if (new Set(item.riskTags as string[]).size !== item.riskTags.length) throw new Error(`candidate ${index} risk tags must be unique`);
    if (item.caseKind !== "defect_candidate" && item.caseKind !== "clean_control_candidate") {
      throw new Error(`candidate ${index} case kind is invalid`);
    }
    for (const key of ELIGIBILITY_KEYS) {
      if (typeof item.eligibility[key] !== "boolean") throw new Error(`candidate ${index} eligibility ${key} must be boolean`);
      if (!item.eligibility[key]) throw new Error(`candidate ${index} is ineligible: ${key}`);
    }
    return item as unknown as Phase1Candidate;
  });
  assertUnique(candidates.map((row) => row.candidateId), "candidate ID");
  assertUnique(candidates.map((row) => row.sourceIdentitySha256), "source identity");
  assertUnique(candidates.map((row) => row.lineageGroup), "lineage group");
  return candidates;
}

function validatePolicy(value: unknown): Phase1CohortPolicy {
  assertRecord(value, "cohort policy");
  if (value.selectionProfile !== "stratified_transport" && value.selectionProfile !== "natural_quality") {
    throw new Error("cohort policy selectionProfile must be stratified_transport or natural_quality");
  }
  const profile = value.selectionProfile;
  assertExactKeys(value, profile === "stratified_transport" ? TRANSPORT_POLICY_KEYS : COMMON_POLICY_KEYS, "cohort policy");
  if (value.cohortSize !== 14) throw new Error("cohort policy must pin exact advisory cohort size 14");
  if (profile === "stratified_transport") {
    validateBucketCounts(value.bucketQuotas, { "16k": 2, "32k": 5, "64k": 5, "128k": 2 }, "bucket quotas");
    validateBucketCounts(value.firstFiveBucketQuotas, { "16k": 1, "32k": 2, "64k": 1, "128k": 1 }, "first-five bucket quotas");
  }
  if (value.outputTokens !== 2_048) throw new Error("cohort policy must pin 2,048 output tokens");
  if (value.maximumFindings !== 5) throw new Error("cohort policy must pin maximum five findings");
  for (const [name, expected] of [
    ["minimumCleanControls", 4], ["minimumRepositoryGroups", 6], ["minimumLanguages", 5],
    ["minimumHighRisk", 5], ["maximumPerRepositoryGroup", 3],
    ["maximumCandidatePoolSize", MAX_CANDIDATE_POOL_SIZE]
  ] as const) if (value[name] !== expected) throw new Error(`cohort policy must pin ${name}=${expected}`);
  if (!Number.isInteger(value.maximumCanonicalSearchStates)
    || (value.maximumCanonicalSearchStates as number) < MIN_CANONICAL_SEARCH_STATES
    || (value.maximumCanonicalSearchStates as number) > MAX_CANONICAL_SEARCH_STATES) {
    throw new Error(`cohort policy maximumCanonicalSearchStates must be an integer from ${MIN_CANONICAL_SEARCH_STATES} through ${MAX_CANONICAL_SEARCH_STATES}`);
  }
  for (const name of [
    "selectionSeed", "admissionEstimatorFingerprint", "promptBuilderFingerprint", "parserFingerprint", "gateFingerprint",
    "redactorFingerprint", "secretScannerFingerprint", "sourcePolicyFingerprint"
  ] as const) assertSha256(value[name], `policy ${name}`);
  assertNonEmptyString(value.proofBoundary, "policy proof boundary");
  if (value.proofBoundary !== PHASE1_COHORT_PROOF_BOUNDARY) throw new Error("cohort policy proof boundary must match the canonical exported proof boundary exactly");
  if (typeof value.safeOutputRoot !== "string" || resolve(value.safeOutputRoot) !== value.safeOutputRoot) {
    throw new Error("policy safe output root must be absolute");
  }
  return value as unknown as Phase1CohortPolicy;
}

function buildSelectionManifest(
  candidates: Phase1Candidate[],
  policy: Phase1CohortPolicy,
  candidatePoolSha256: string,
  policySha256: string
): Phase1SelectionManifest {
  const selected = policy.selectionProfile === "stratified_transport"
    ? selectCandidates(candidates, policy)
    : selectNaturalQualityCandidates(candidates, policy);
  const repositoryGroupCounts = countBy(selected, (row) => row.repositoryGroup);
  const languageCounts = countBy(selected, (row) => row.language);
  const bucketCounts = countBuckets(selected);
  const cleanControlCount = selected.filter(isCleanControl).length;
  const highRiskCount = selected.filter(isHighRisk).length;
  if (policy.selectionProfile === "stratified_transport" && !sameBucketCounts(bucketCounts, policy.bucketQuotas)) {
    throw new Error("selected cohort bucket quotas are not exact");
  }
  if (policy.selectionProfile === "natural_quality" && cleanControlCount !== 4) {
    throw new Error("natural-quality cohort must contain exactly four clean controls");
  }
  if (cleanControlCount < policy.minimumCleanControls) throw new Error("selected cohort misses the clean-control floor");
  if (Object.keys(repositoryGroupCounts).length < policy.minimumRepositoryGroups) throw new Error("selected cohort misses the repository diversity floor");
  if (Object.keys(languageCounts).length < policy.minimumLanguages) throw new Error("selected cohort misses the language diversity floor");
  if (highRiskCount < policy.minimumHighRisk) throw new Error("selected cohort misses the high-risk floor");
  const maximumRepositoryGroupCount = Math.max(0, ...Object.values(repositoryGroupCounts));
  if (maximumRepositoryGroupCount > policy.maximumPerRepositoryGroup) throw new Error("selected cohort exceeds the repository group cap");
  const base: Phase1SelectionManifest = {
    schemaVersion: "neondiff-phase1-selection-manifest/v2",
    selectionProfile: policy.selectionProfile,
    candidatePoolSha256,
    policySha256,
    selectionSeed: policy.selectionSeed,
    fingerprints: {
      admissionEstimator: policy.admissionEstimatorFingerprint,
      promptBuilder: policy.promptBuilderFingerprint,
      parser: policy.parserFingerprint,
      gate: policy.gateFingerprint,
      redactor: policy.redactorFingerprint,
      secretScanner: policy.secretScannerFingerprint,
      sourcePolicy: policy.sourcePolicyFingerprint
    },
    contract: {
      cohortSize: 14,
      outputTokens: 2_048,
      maximumFindings: 5,
      maximumCandidatePoolSize: 64,
      maximumCanonicalSearchStates: policy.maximumCanonicalSearchStates
    },
    selectedCandidateIds: selected.map((row) => row.candidateId),
    strata: {
      admissionEstimatedPromptBucketCounts: bucketCounts,
      caseKindCounts: {
        defect_candidate: selected.length - cleanControlCount,
        clean_control_candidate: cleanControlCount
      }
    },
    diversity: {
      repositoryGroupCount: Object.keys(repositoryGroupCounts).length,
      languageCount: Object.keys(languageCounts).length,
      highRiskCount,
      cleanControlCount,
      maximumRepositoryGroupCount,
      repositoryGroupCounts,
      languageCounts
    },
    proofBoundary: policy.proofBoundary,
    outcomeVisibility: "not_present",
    qualityReady: false
  };
  if (policy.selectionProfile === "natural_quality") return base;
  const firstFive = selectFirstFive(selected, policy);
  return {
    ...base,
    contract: {
      ...base.contract,
      bucketQuotas: { ...policy.bucketQuotas },
      firstFiveBucketQuotas: { ...policy.firstFiveBucketQuotas }
    },
    firstFive: {
      candidateIds: firstFive.map((row) => row.candidateId),
      bucketCounts: countBuckets(firstFive),
      cleanControlCount: firstFive.filter(isCleanControl).length
    }
  };
}

function selectNaturalQualityCandidates(
  candidates: Phase1Candidate[],
  policy: Phase1NaturalQualityPolicy
): Phase1Candidate[] {
  if (candidates.length !== policy.cohortSize) {
    throw new Error("natural-quality candidate pool must contain exactly 14 rows");
  }
  const cleanControlCount = candidates.filter(isCleanControl).length;
  if (cleanControlCount !== 4) {
    throw new Error("natural-quality candidate pool must contain exactly four clean controls");
  }
  return [...candidates].sort((left, right) =>
    compareCodeUnits(seededRank(left, policy.selectionSeed), seededRank(right, policy.selectionSeed))
      || compareCodeUnits(left.candidateId, right.candidateId));
}

function selectCandidates(candidates: Phase1Candidate[], policy: Phase1StratifiedTransportPolicy): Phase1Candidate[] {
  assertPoolCanMeetFloors(candidates, policy);
  const repositoryFrequencies = countBy(candidates, (row) => row.repositoryGroup);
  const languageFrequencies = countBy(candidates, (row) => row.language);
  const ordered = [...candidates].sort((left, right) => {
    const leftPriority = Number(isHighRisk(left)) * 2 + Number(isCleanControl(left));
    const rightPriority = Number(isHighRisk(right)) * 2 + Number(isCleanControl(right));
    if (leftPriority !== rightPriority) return rightPriority - leftPriority;
    if (repositoryFrequencies[left.repositoryGroup] !== repositoryFrequencies[right.repositoryGroup]) {
      return repositoryFrequencies[left.repositoryGroup] - repositoryFrequencies[right.repositoryGroup];
    }
    if (languageFrequencies[left.language] !== languageFrequencies[right.language]) {
      return languageFrequencies[left.language] - languageFrequencies[right.language];
    }
    return compareCodeUnits(seededRank(left, policy.selectionSeed), seededRank(right, policy.selectionSeed));
  });
  const selected: Phase1Candidate[] = [];
  const remaining = { ...policy.bucketQuotas };
  const repoCounts: Record<string, number> = {};
  const languageCounts: Record<string, number> = {};
  let cleanCount = 0;
  let riskCount = 0;
  let canonicalStates = 0;
  const impossibleStates = new Set<string>();

  const search = (index: number): Phase1Candidate[] | undefined => {
    const key = canonicalSelectionState(index, remaining, repoCounts, languageCounts, cleanCount, riskCount);
    if (impossibleStates.has(key)) return undefined;
    canonicalStates += 1;
    if (canonicalStates > policy.maximumCanonicalSearchStates) {
      throw new Error("bounded deterministic cohort search exhausted its canonical combination-state budget");
    }
    const available = ordered.slice(index);
    if (!canStillSatisfyCanonicalSelection(available, selected, remaining, repoCounts, languageCounts, cleanCount, riskCount, policy)) {
      impossibleStates.add(key);
      return undefined;
    }
    if (selected.length === policy.cohortSize) return [...selected];
    if (index >= ordered.length) {
      impossibleStates.add(key);
      return undefined;
    }

    const next = ordered[index];
    if (remaining[next.bucket] > 0 && (repoCounts[next.repositoryGroup] ?? 0) < policy.maximumPerRepositoryGroup) {
      selected.push(next);
      remaining[next.bucket] -= 1;
      repoCounts[next.repositoryGroup] = (repoCounts[next.repositoryGroup] ?? 0) + 1;
      languageCounts[next.language] = (languageCounts[next.language] ?? 0) + 1;
      if (isCleanControl(next)) cleanCount += 1;
      if (isHighRisk(next)) riskCount += 1;
      const included = search(index + 1);
      if (included) return included;
      if (isHighRisk(next)) riskCount -= 1;
      if (isCleanControl(next)) cleanCount -= 1;
      decrementCount(languageCounts, next.language);
      decrementCount(repoCounts, next.repositoryGroup);
      remaining[next.bucket] += 1;
      selected.pop();
    }

    const excluded = search(index + 1);
    if (excluded) return excluded;
    impossibleStates.add(key);
    return undefined;
  };

  const result = search(0);
  if (!result) throw new Error("candidate pool cannot satisfy exact quotas, diversity floors, and repository caps");
  return result;
}

function canStillSatisfyCanonicalSelection(
  available: Phase1Candidate[],
  selected: Phase1Candidate[],
  remaining: BucketCounts,
  repoCounts: Record<string, number>,
  languageCounts: Record<string, number>,
  cleanCount: number,
  riskCount: number,
  policy: Phase1StratifiedTransportPolicy
): boolean {
  const eligible = available.filter((row) => remaining[row.bucket] > 0 && (repoCounts[row.repositoryGroup] ?? 0) < policy.maximumPerRepositoryGroup);
  const remainingSlots = Object.values(remaining).reduce((sum, count) => sum + count, 0);
  if (remainingSlots !== policy.cohortSize - selected.length) return false;
  if (eligible.length < remainingSlots) return false;
  for (const bucket of BUCKETS) {
    if (eligible.filter((row) => row.bucket === bucket).length < remaining[bucket]) return false;
  }
  if (maxSelectableWithQuotas(eligible, remaining, repoCounts, policy, () => true, remainingSlots) < remainingSlots) return false;
  const possibleRepositories = new Set([...Object.keys(repoCounts), ...eligible.map((row) => row.repositoryGroup)]);
  if (possibleRepositories.size < policy.minimumRepositoryGroups) return false;
  const possibleLanguages = new Set([...Object.keys(languageCounts), ...eligible.map((row) => row.language)]);
  if (possibleLanguages.size < policy.minimumLanguages) return false;
  const requiredClean = Math.max(0, policy.minimumCleanControls - cleanCount);
  if (requiredClean > 0
    && maxSelectableWithQuotas(eligible, remaining, repoCounts, policy, isCleanControl, requiredClean) < requiredClean) return false;
  const requiredRisk = Math.max(0, policy.minimumHighRisk - riskCount);
  if (requiredRisk > 0
    && maxSelectableWithQuotas(eligible, remaining, repoCounts, policy, isHighRisk, requiredRisk) < requiredRisk) return false;
  if (selected.length === policy.cohortSize) {
    return cleanCount >= policy.minimumCleanControls
      && riskCount >= policy.minimumHighRisk
      && new Set(selected.map((row) => row.repositoryGroup)).size >= policy.minimumRepositoryGroups
      && new Set(selected.map((row) => row.language)).size >= policy.minimumLanguages;
  }
  return true;
}

function canonicalSelectionState(
  index: number,
  remaining: BucketCounts,
  repoCounts: Record<string, number>,
  languageCounts: Record<string, number>,
  cleanCount: number,
  riskCount: number
): string {
  const counts = (value: Record<string, number>) => Object.entries(value).sort(([left], [right]) => compareCodeUnits(left, right));
  return canonicalJson([index, BUCKETS.map((bucket) => remaining[bucket]), counts(repoCounts), counts(languageCounts), cleanCount, riskCount]);
}

function decrementCount(counts: Record<string, number>, key: string): void {
  counts[key] -= 1;
  if (counts[key] === 0) delete counts[key];
}

function maxSelectableWithQuotas(
  candidates: Phase1Candidate[],
  remaining: BucketCounts,
  repoCounts: Record<string, number>,
  policy: Phase1StratifiedTransportPolicy,
  predicate: (candidate: Phase1Candidate) => boolean,
  requiredFlow: number
): number {
  if (requiredFlow <= 0) return 0;
  const rows = candidates.filter(predicate);
  const repositories = [...new Set(rows.map((row) => row.repositoryGroup))].sort();
  const source = 0;
  const bucketOffset = 1;
  const repositoryOffset = bucketOffset + BUCKETS.length;
  const sink = repositoryOffset + repositories.length;
  const graph = Array.from({ length: sink + 1 }, () => [] as FlowEdge[]);
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = `${row.bucket}:${row.repositoryGroup}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (let bucketIndex = 0; bucketIndex < BUCKETS.length; bucketIndex += 1) {
    const bucket = BUCKETS[bucketIndex];
    addFlowEdge(graph, source, bucketOffset + bucketIndex, remaining[bucket]);
    for (let repositoryIndex = 0; repositoryIndex < repositories.length; repositoryIndex += 1) {
      const repository = repositories[repositoryIndex];
      const capacity = counts.get(`${bucket}:${repository}`) ?? 0;
      if (capacity > 0) addFlowEdge(graph, bucketOffset + bucketIndex, repositoryOffset + repositoryIndex, capacity);
    }
  }
  for (let repositoryIndex = 0; repositoryIndex < repositories.length; repositoryIndex += 1) {
    const repository = repositories[repositoryIndex];
    const capacity = Math.max(
      0,
      policy.maximumPerRepositoryGroup - (repoCounts[repository] ?? 0)
    );
    if (capacity > 0) addFlowEdge(graph, repositoryOffset + repositoryIndex, sink, capacity);
  }
  return maximumFlow(graph, source, sink, requiredFlow);
}

interface FlowEdge {
  to: number;
  reverse: number;
  capacity: number;
}

function addFlowEdge(graph: FlowEdge[][], from: number, to: number, capacity: number): void {
  const forward: FlowEdge = { to, reverse: graph[to].length, capacity };
  const reverse: FlowEdge = { to: from, reverse: graph[from].length, capacity: 0 };
  graph[from].push(forward);
  graph[to].push(reverse);
}

function maximumFlow(graph: FlowEdge[][], source: number, sink: number, requiredFlow: number): number {
  let total = 0;
  while (total < requiredFlow) {
    const parentNode = Array<number>(graph.length).fill(-1);
    const parentEdge = Array<number>(graph.length).fill(-1);
    parentNode[source] = source;
    const queue = [source];
    for (let cursor = 0; cursor < queue.length && parentNode[sink] === -1; cursor += 1) {
      const node = queue[cursor];
      for (let edgeIndex = 0; edgeIndex < graph[node].length; edgeIndex += 1) {
        const edge = graph[node][edgeIndex];
        if (parentNode[edge.to] === -1 && edge.capacity > 0) {
          parentNode[edge.to] = node;
          parentEdge[edge.to] = edgeIndex;
          queue.push(edge.to);
        }
      }
    }
    if (parentNode[sink] === -1) return total;
    let increment = requiredFlow - total;
    for (let node = sink; node !== source; node = parentNode[node]) {
      increment = Math.min(increment, graph[parentNode[node]][parentEdge[node]].capacity);
    }
    for (let node = sink; node !== source; node = parentNode[node]) {
      const edge = graph[parentNode[node]][parentEdge[node]];
      edge.capacity -= increment;
      graph[node][edge.reverse].capacity += increment;
    }
    total += increment;
  }
  return total;
}

function assertPoolCanMeetFloors(candidates: Phase1Candidate[], policy: Phase1StratifiedTransportPolicy): void {
  const bucketCounts = countBuckets(candidates);
  for (const bucket of BUCKETS) {
    if (bucketCounts[bucket] < policy.bucketQuotas[bucket]) throw new Error(`candidate pool cannot satisfy the ${bucket} bucket quota`);
  }
  if (candidates.filter(isCleanControl).length < policy.minimumCleanControls) {
    throw new Error("candidate pool cannot satisfy the clean-control floor");
  }
  if (new Set(candidates.map((row) => row.repositoryGroup)).size < policy.minimumRepositoryGroups) {
    throw new Error("candidate pool cannot satisfy the repository diversity floor");
  }
  if (new Set(candidates.map((row) => row.language)).size < policy.minimumLanguages) {
    throw new Error("candidate pool cannot satisfy the language diversity floor");
  }
  if (candidates.filter(isHighRisk).length < policy.minimumHighRisk) {
    throw new Error("candidate pool cannot satisfy the high-risk floor");
  }
  const repositoryCounts = countBy(candidates, (row) => row.repositoryGroup);
  const capacity = Object.values(repositoryCounts).reduce(
    (sum, count) => sum + Math.min(count, policy.maximumPerRepositoryGroup),
    0
  );
  if (capacity < policy.cohortSize) throw new Error("candidate pool cannot satisfy the repository cap");
}

function selectFirstFive(selected: Phase1Candidate[], policy: Phase1StratifiedTransportPolicy): Phase1Candidate[] {
  const first: Phase1Candidate[] = [];
  for (const bucket of BUCKETS) {
    const quota = policy.firstFiveBucketQuotas[bucket];
    const preferCleanControl = first.every((row) => !isCleanControl(row));
    const ranked = selected.filter((row) => row.bucket === bucket).sort((left, right) => {
      if (isCleanControl(left) !== isCleanControl(right) && preferCleanControl) {
        return isCleanControl(left) ? -1 : 1;
      }
      return compareCodeUnits(
        seededRank(left, `${policy.selectionSeed}:first-five`),
        seededRank(right, `${policy.selectionSeed}:first-five`)
      );
    });
    first.push(...ranked.slice(0, quota));
  }
  if (first.length !== 5 || !sameBucketCounts(countBuckets(first), policy.firstFiveBucketQuotas)) {
    throw new Error("selected cohort cannot satisfy exact first-five bucket quotas");
  }
  if (!first.some(isCleanControl)) throw new Error("first-five cohort requires a clean-control candidate");
  return first.sort((left, right) => compareCodeUnits(
    seededRank(left, `${policy.selectionSeed}:first-five-order`),
    seededRank(right, `${policy.selectionSeed}:first-five-order`)
  ));
}

function buildRuntimeInputManifest(
  candidates: Phase1Candidate[],
  manifest: Phase1SelectionManifest,
  manifestSha256: string
): Record<string, unknown> {
  const byId = new Map(candidates.map((row) => [row.candidateId, row]));
  return {
    schemaVersion: "neondiff-phase1-runtime-input-manifest/v2",
    selectionProfile: manifest.selectionProfile,
    selectionManifestSha256: manifestSha256,
    candidates: manifest.selectedCandidateIds.map((candidateId) => {
      const row = byId.get(candidateId);
      if (!row) throw new Error("selected candidate is missing from the validated candidate pool");
      return {
        candidateId: row.candidateId,
        inputArtifactSha256: row.inputArtifactSha256,
        admissionEstimatedPromptTokens: row.admissionEstimatedPromptTokens,
        bucket: row.bucket
      };
    })
  };
}

function finalizeNewArtifacts(outputDir: string, artifacts: Map<string, string>): void {
  mkdirSync(outputDir, { mode: 0o700 });
  for (const [name, expected] of artifacts) {
    atomicCreatePrivateFile(join(outputDir, name), expected);
  }
}

function verifyArtifactBytes(outputDir: string, artifacts: Map<string, string>): void {
  const output = lstatSync(outputDir);
  if (output.isSymbolicLink() || !output.isDirectory()) throw new Error("sealed output path must be a regular directory, not a symlink");
  if ((output.mode & 0o777) !== 0o700) throw new Error("sealed output directory mode must be exactly 0700");
  assertArtifactSet(outputDir, artifacts, true);
  for (const [name, expected] of artifacts) {
    const path = join(outputDir, name);
    if (!existsSync(path)) throw new Error(`sealed artifact is missing: ${name}`);
    if (readFileSync(path, "utf8") !== expected) throw new Error(`sealed artifact tamper or fingerprint mismatch: ${name}`);
    if (readFileMode(path) !== 0o600) throw new Error(`sealed artifact permissions must be exactly 0600: ${name}`);
  }
}

function atomicCreatePrivateFile(path: string, value: string): void {
  const temp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(12).toString("hex")}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temp, "wx", 0o600);
    writeFileSync(descriptor, value, { encoding: "utf8" });
    chmodSync(temp, 0o600);
    closeSync(descriptor);
    descriptor = undefined;
    linkSync(temp, path);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temp, { force: true });
  }
}

function assertArtifactSet(outputDir: string, artifacts: Map<string, string>, requireComplete: boolean): void {
  if (!existsSync(outputDir)) {
    if (requireComplete) throw new Error("sealed artifact set is missing");
    return;
  }
  const entries = readdirSync(outputDir);
  for (const name of entries) {
    if (!artifacts.has(name)) throw new Error(`undeclared entry in sealed artifact set: ${name}`);
    const entry = lstatSync(join(outputDir, name));
    if (entry.isSymbolicLink()) throw new Error(`symlinked sealed artifact is forbidden: ${name}`);
    if (!entry.isFile()) throw new Error(`sealed artifact entry must be a regular file: ${name}`);
  }
  if (requireComplete && (entries.length !== artifacts.size || [...artifacts.keys()].some((name) => !entries.includes(name)))) {
    throw new Error("sealed artifact set is incomplete");
  }
}

function readFileMode(path: string): number {
  return statSync(path).mode & 0o777;
}

function validateAllowedOutputRoot(allowedOutputRoot: string, policyOutputRoot: string): string {
  if (resolve(allowedOutputRoot) !== allowedOutputRoot) throw new Error("independently allowed output root must be absolute");
  if (resolve(policyOutputRoot) !== policyOutputRoot) throw new Error("policy safe output root must be absolute");
  if (allowedOutputRoot === "/" || policyOutputRoot === "/") throw new Error("filesystem root cannot be used as the allowed output root");
  if (!existsSync(allowedOutputRoot)) throw new Error("independently allowed output root must already exist");
  const allowedEntry = lstatSync(allowedOutputRoot);
  if (allowedEntry.isSymbolicLink() || !allowedEntry.isDirectory()) throw new Error("independently allowed output root must be a real directory");
  const allowed = resolve(realpathSync(allowedOutputRoot));
  const policy = canonicalProspectivePath(policyOutputRoot);
  if (allowed !== policy) throw new Error("independently allowed output root does not canonically match the policy safe output root");
  return allowed;
}

function validateOutputBoundary(outputDir: string, safeOutputRoot: string): void {
  if (resolve(outputDir) !== outputDir) throw new Error("output directory must be absolute");
  const output = canonicalProspectivePath(outputDir);
  const safeRoot = canonicalProspectivePath(safeOutputRoot);
  if (output === safeRoot || !output.startsWith(`${safeRoot}${sep}`)) {
    throw new Error("output directory must resolve beneath the policy safe output root");
  }
}

function readBoundedFile(path: string, maximumBytes: number, label: string): Buffer {
  const pathEntry = lstatSync(path);
  if (pathEntry.isSymbolicLink()) throw new Error(`${label} must be a regular file, not a symlink`);
  if (!pathEntry.isFile()) throw new Error(`${label} must be a regular file`);
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const input = fstatSync(descriptor);
    if (!input.isFile()) throw new Error(`${label} must be a regular file`);
    const declaredSize = input.size;
    if (declaredSize > maximumBytes) throw new Error(`${label} exceeds its bounded input byte limit`);
    const bytes = readFileSync(descriptor);
    if (bytes.byteLength > maximumBytes) throw new Error(`${label} exceeds its bounded input byte limit`);
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

function canonicalProspectivePath(path: string): string {
  let cursor = resolve(path);
  const suffix: string[] = [];
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) break;
    suffix.unshift(basename(cursor));
    cursor = parent;
  }
  return resolve(realpathSync(cursor), ...suffix);
}

function admissionEstimatedBucket(tokens: number): Phase1Bucket {
  if (tokens < 1 || tokens > 131_072) {
    throw new Error("admission estimated prompt token count is outside the 1..128k admission range");
  }
  if (tokens <= 16_384) return "16k";
  if (tokens <= 32_768) return "32k";
  if (tokens <= 65_536) return "64k";
  return "128k";
}

function validateBucketCounts(value: unknown, expected: BucketCounts, label: string): void {
  assertRecord(value, label);
  assertExactKeys(value, BUCKETS, label);
  for (const bucket of BUCKETS) if (value[bucket] !== expected[bucket]) throw new Error(`${label} must pin the frozen workload contract`);
}

function countBuckets(rows: Phase1Candidate[]): BucketCounts {
  const counts: BucketCounts = { "16k": 0, "32k": 0, "64k": 0, "128k": 0 };
  for (const row of rows) counts[row.bucket] += 1;
  return counts;
}

function sameBucketCounts(left: BucketCounts, right: BucketCounts): boolean {
  return BUCKETS.every((bucket) => left[bucket] === right[bucket]);
}

function countBy(rows: Phase1Candidate[], key: (row: Phase1Candidate) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) counts[key(row)] = (counts[key(row)] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => compareCodeUnits(left, right)));
}

function isCleanControl(row: Phase1Candidate): boolean {
  return row.caseKind === "clean_control_candidate";
}

function isHighRisk(row: Phase1Candidate): boolean {
  return row.riskTags.length > 0;
}

function seededRank(row: Phase1Candidate, seed: string): string {
  return sha256(`${seed}:${row.candidateId}:${row.sourceIdentitySha256}:${row.lineageGroup}`);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertNoForbiddenKeys(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) assertNoForbiddenKeys(item);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN_INPUT_KEYS.has(key.toLowerCase().replace(/[^a-z0-9]/g, ""))) {
      throw new Error(`forbidden private or outcome-bearing key in cohort input: ${key}`);
    }
    assertNoForbiddenKeys(item);
  }
}

function assertSecretSafe(value: unknown, label: string): void {
  const visit = (item: unknown): boolean => {
    if (typeof item === "string") return containsSecretLikeText(item);
    if (Array.isArray(item)) return item.some(visit);
    if (item && typeof item === "object") return Object.entries(item).some(([key, nested]) => containsSecretLikeText(key) || visit(nested));
    return false;
  };
  if (visit(value)) throw new Error(`${label} contains secret-like text`);
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be a JSON object`);
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} must use the exact schema keys`);
  }
}

function assertSha256(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`${label} must be a lowercase 64-character SHA-256`);
}

function assertOpaqueIdentifier(value: unknown, prefix: "candidate" | "repo" | "lineage", label: string): asserts value is string {
  if (typeof value !== "string" || !new RegExp(`^${prefix}_[a-f0-9]{32}$`).test(value)) {
    throw new Error(`${label} must be a neutral opaque ${prefix} identifier`);
  }
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
}

function assertUnique(values: string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`duplicate ${label} values are forbidden`);
}

function parseJson(bytes: Buffer, label: string): unknown {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label} must contain valid UTF-8`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${label} must contain valid JSON`);
  }
}

function jsonBytes(value: unknown): string {
  return `${JSON.stringify(sortJson(value), null, 2)}\n`;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([key, item]) => [key, sortJson(item)]));
  }
  return value;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
