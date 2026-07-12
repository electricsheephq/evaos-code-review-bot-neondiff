import { createHash } from "node:crypto";
import { isIP } from "node:net";
import validateNpmPackageLicense from "validate-npm-package-license";
import type { EvalScenarioInput } from "./eval-harness.js";
import { containsSecretLikeText } from "./secrets.js";
import type { Severity } from "./types.js";

export type ReviewBenchSplit = "train" | "validation" | "holdout";

export const REVIEW_BENCH_MATCHER_VERSION = "review-bench-matcher/v1" as const;
const REVIEW_BENCH_LEXICAL_THRESHOLDS = { exact: 0.25, nearby: 0.35 } as const;

export interface ReviewBenchSourceVerificationV1 {
  schemaVersion: "review-bench-source-verification/v1";
  provider: "github";
  verifierVersion: "github-public-source-ingest/v1";
  repositoryNodeId: string;
  visibility: "public";
  licenseSpdxId: string;
  repositoryMetadataSha256: string;
  sourceMetadataSha256: string;
  licenseArtifactSha256: string;
  sourceArtifactSha256: string;
  verifiedAt: string;
  bindingSha256: string;
}

export interface ReviewBenchScenarioV1 {
  schemaVersion: "review-bench-scenario/v1";
  scenarioId: string;
  sourceId: string;
  runId: string;
  repository: string;
  sourceRevision: string;
  license: {
    spdxId: string;
    licenseUrl: string;
  };
  provenance: {
    kind: "pull_request" | "commit" | "revert" | "synthetic";
    baseRevision?: string;
    repositoryUrl: string;
    sourceUrl: string;
    sourceArtifactUrl: string;
    sourceArtifactSha256: string;
    visibility: "public";
    visibilityEvidenceUrl: string;
    visibilityVerifiedAt: string;
    verification: ReviewBenchSourceVerificationV1;
  };
  language: string;
  split: ReviewBenchSplit;
  bugFamily: string;
  explicitControl: boolean;
  labels: ReviewBenchGoldFinding[];
  adjudication: {
    status: "independently_adjudicated";
    primaryAdjudicator: string;
    secondaryAdjudicator: string;
    agreement: "agree" | "reconciled";
    method: string;
    rubricVersion: string;
    completedAt: string;
  };
}

export interface ReviewBenchCorpusV1 {
  schemaVersion: "review-bench-corpus/v1";
  corpusVersion: string;
  corpusHash?: string;
  splitPolicy: {
    repositoryGrouped: true;
    holdoutFloor: {
      scenarios: number;
      repositories: number;
      minimumFraction: number;
    };
  };
  scenarios: ReviewBenchScenarioV1[];
}

export interface ReviewBenchFinding {
  id: string;
  path: string;
  line: number;
  severity: Severity;
  confidence?: number;
  title: string;
  body: string;
}

export interface ReviewBenchGoldFinding extends Omit<ReviewBenchFinding, "confidence"> {
  confidence?: never;
}

export interface ReviewBenchMatcherOptions {
  candidateModelId: string;
  candidateTargetFingerprint: string;
  semanticEvaluator: {
    kind: "human" | "model";
    id: string;
    version: string;
    evidenceSha256: string;
    targetFingerprint?: string;
  };
  semanticMatch: (bot: ReviewBenchFinding, label: ReviewBenchGoldFinding) => boolean;
}

export interface ReviewBenchMatcherIdentity {
  matcherVersion: typeof REVIEW_BENCH_MATCHER_VERSION;
  candidateModelId: string;
  candidateTargetFingerprint: string;
  semanticEvaluator: {
    kind: "human" | "model";
    id: string;
    version: string;
    evidenceSha256: string;
    targetFingerprint?: string;
  };
  lexicalThresholds: typeof REVIEW_BENCH_LEXICAL_THRESHOLDS;
  semanticDecisionsSha256: string;
  matcherFingerprint: string;
}

export function computeReviewBenchCorpusHash(corpus: ReviewBenchCorpusV1): string {
  const normalized = {
    schemaVersion: corpus.schemaVersion,
    corpusVersion: corpus.corpusVersion,
    splitPolicy: corpus.splitPolicy,
    scenarios: [...corpus.scenarios]
      .sort((a, b) => compareFixed(a.scenarioId, b.scenarioId) || compareFixed(a.sourceId, b.sourceId))
      .map((scenario) => ({
        schemaVersion: scenario.schemaVersion,
        scenarioId: scenario.scenarioId,
        sourceId: scenario.sourceId,
        repository: normalizeRepositoryIdentity(scenario.repository),
        sourceRevision: scenario.sourceRevision,
        license: scenario.license,
        provenance: {
          kind: scenario.provenance.kind,
          baseRevision: scenario.provenance.baseRevision,
          repositoryUrl: scenario.provenance.repositoryUrl,
          sourceUrl: scenario.provenance.sourceUrl,
          sourceArtifactUrl: scenario.provenance.sourceArtifactUrl,
          sourceArtifactSha256: scenario.provenance.sourceArtifactSha256,
          visibility: scenario.provenance.visibility,
          visibilityEvidenceUrl: scenario.provenance.visibilityEvidenceUrl,
          visibilityVerifiedAt: scenario.provenance.visibilityVerifiedAt,
          verification: {
            schemaVersion: scenario.provenance.verification.schemaVersion,
            provider: scenario.provenance.verification.provider,
            verifierVersion: scenario.provenance.verification.verifierVersion,
            repositoryNodeId: scenario.provenance.verification.repositoryNodeId,
            visibility: scenario.provenance.verification.visibility,
            licenseSpdxId: scenario.provenance.verification.licenseSpdxId,
            repositoryMetadataSha256: scenario.provenance.verification.repositoryMetadataSha256,
            sourceMetadataSha256: scenario.provenance.verification.sourceMetadataSha256,
            licenseArtifactSha256: scenario.provenance.verification.licenseArtifactSha256,
            sourceArtifactSha256: scenario.provenance.verification.sourceArtifactSha256,
            verifiedAt: scenario.provenance.verification.verifiedAt,
            bindingSha256: scenario.provenance.verification.bindingSha256
          }
        },
        language: scenario.language,
        split: scenario.split,
        bugFamily: scenario.bugFamily,
        explicitControl: scenario.explicitControl,
        labels: [...scenario.labels]
          .sort((a, b) => compareFixed(a.id, b.id))
          .map((label) => ({
            id: label.id,
            path: label.path,
            line: label.line,
            severity: label.severity,
            title: label.title,
            body: label.body
          })),
        adjudication: scenario.adjudication
      }))
  };
  return createHash("sha256").update(canonicalJson(normalized)).digest("hex");
}

export function computeReviewBenchSourceVerificationBinding(scenario: ReviewBenchScenarioV1): string {
  const verification = scenario.provenance.verification;
  return sha256(canonicalJson({
    scenarioId: scenario.scenarioId,
    sourceId: scenario.sourceId,
    repository: normalizeRepositoryIdentity(scenario.repository),
    sourceRevision: scenario.sourceRevision,
    license: scenario.license,
    provenance: {
      kind: scenario.provenance.kind,
      baseRevision: scenario.provenance.baseRevision,
      repositoryUrl: scenario.provenance.repositoryUrl,
      sourceUrl: scenario.provenance.sourceUrl,
      sourceArtifactUrl: scenario.provenance.sourceArtifactUrl,
      sourceArtifactSha256: scenario.provenance.sourceArtifactSha256,
      visibility: scenario.provenance.visibility,
      visibilityEvidenceUrl: scenario.provenance.visibilityEvidenceUrl,
      visibilityVerifiedAt: scenario.provenance.visibilityVerifiedAt
    },
    verification: {
      schemaVersion: verification.schemaVersion,
      provider: verification.provider,
      verifierVersion: verification.verifierVersion,
      repositoryNodeId: verification.repositoryNodeId,
      visibility: verification.visibility,
      licenseSpdxId: verification.licenseSpdxId,
      repositoryMetadataSha256: verification.repositoryMetadataSha256,
      sourceMetadataSha256: verification.sourceMetadataSha256,
      licenseArtifactSha256: verification.licenseArtifactSha256,
      sourceArtifactSha256: verification.sourceArtifactSha256,
      verifiedAt: verification.verifiedAt
    }
  }));
}

export function validateReviewBenchCorpus(corpus: ReviewBenchCorpusV1): void {
  if (!corpus || typeof corpus !== "object") throw new Error("corpus must be an object");
  requireExactKeys(
    corpus,
    ["schemaVersion", "corpusVersion", "corpusHash", "splitPolicy", "scenarios"],
    "corpus"
  );
  if (corpus.schemaVersion !== "review-bench-corpus/v1") {
    throw new Error("schemaVersion must be review-bench-corpus/v1");
  }
  requireNonEmpty(corpus.corpusVersion, "corpusVersion");
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(corpus.corpusVersion)) {
    throw new Error("corpusVersion must be a semantic version");
  }
  if (!Array.isArray(corpus.scenarios)) throw new Error("scenarios must be an array");
  if (!corpus.splitPolicy || corpus.splitPolicy.repositoryGrouped !== true) {
    throw new Error("splitPolicy.repositoryGrouped must be true");
  }
  requireExactKeys(corpus.splitPolicy, ["repositoryGrouped", "holdoutFloor"], "splitPolicy");
  validateHoldoutFloor(corpus.splitPolicy.holdoutFloor);

  const scenarioIds = new Set<string>();
  const sourceIds = new Set<string>();
  const sourceIdentities = new Set<string>();
  const sourceArtifactDigests = new Set<string>();
  const repositorySplits = new Map<string, ReviewBenchSplit>();
  for (const [index, scenario] of corpus.scenarios.entries()) {
    const path = `scenarios[${index}]`;
    validateScenario(scenario, path);
    if (scenarioIds.has(scenario.scenarioId)) throw new Error(`duplicate scenarioId: ${scenario.scenarioId}`);
    if (sourceIds.has(scenario.sourceId)) throw new Error(`duplicate sourceId: ${scenario.sourceId}`);
    const sourceIdentity = computeSourceIdentity(scenario);
    if (sourceIdentities.has(sourceIdentity)) {
      throw new Error(`duplicate source identity: ${sourceIdentity}`);
    }
    if (sourceArtifactDigests.has(scenario.provenance.sourceArtifactSha256)) {
      throw new Error(`duplicate source artifact: ${scenario.provenance.sourceArtifactSha256}`);
    }
    scenarioIds.add(scenario.scenarioId);
    sourceIds.add(scenario.sourceId);
    sourceIdentities.add(sourceIdentity);
    sourceArtifactDigests.add(scenario.provenance.sourceArtifactSha256);

    const normalizedRepository = normalizeRepositoryIdentity(scenario.repository);
    const existingSplit = repositorySplits.get(normalizedRepository);
    if (existingSplit && existingSplit !== scenario.split) {
      throw new Error(
        `repository split leakage: ${scenario.repository} appears in ${existingSplit} and ${scenario.split}`
      );
    }
    repositorySplits.set(normalizedRepository, scenario.split);
  }

  const holdoutScenarios = corpus.scenarios.filter((scenario) => scenario.split === "holdout");
  const holdoutRepositories = new Set(
    holdoutScenarios.map((scenario) => normalizeRepositoryIdentity(scenario.repository))
  );
  const floor = corpus.splitPolicy.holdoutFloor;
  if (holdoutScenarios.length < floor.scenarios || holdoutRepositories.size < floor.repositories) {
    throw new Error(
      `holdout floor unmet: ${holdoutScenarios.length}/${floor.scenarios} scenarios and ` +
      `${holdoutRepositories.size}/${floor.repositories} repositories`
    );
  }
  const holdoutFraction = corpus.scenarios.length === 0 ? 0 : holdoutScenarios.length / corpus.scenarios.length;
  if (holdoutFraction < floor.minimumFraction) {
    throw new Error(
      `holdout fraction unmet: ${holdoutFraction.toFixed(4)} < ${floor.minimumFraction.toFixed(4)}`
    );
  }

  if (corpus.corpusHash !== undefined) {
    if (!/^[a-f0-9]{64}$/.test(corpus.corpusHash)) throw new Error("corpusHash must be a sha256 hex digest");
    const computed = computeReviewBenchCorpusHash(corpus);
    if (corpus.corpusHash !== computed) throw new Error(`corpusHash mismatch: expected ${computed}`);
  }
}

export function matchReviewBenchFindings(
  botFindings: ReviewBenchFinding[],
  labels: ReviewBenchGoldFinding[],
  options: ReviewBenchMatcherOptions
): {
  matcherVersion: typeof REVIEW_BENCH_MATCHER_VERSION;
  matcherIdentity: ReviewBenchMatcherIdentity;
  candidates: Array<{ botFindingId: string; labelId: string; classification: "exact" | "nearby" }>;
  matches: Array<{ botFindingId: string; labelId: string; classification: "exact" | "nearby" }>;
  adjudicationQueue: Array<{
    botFindingId: string;
    labelId: string;
    classification: "exact" | "nearby";
    reason: "semantic_near_miss" | "lexical_near_miss";
  }>;
} {
  validateMatcherOptions(options);
  validateMatcherFindingIds(botFindings, "bot");
  validateMatcherFindingIds(labels, "label");

  const sortedBots = [...botFindings].sort((a, b) => compareFixed(a.id, b.id));
  const sortedLabels = [...labels].sort((a, b) => compareFixed(a.id, b.id));
  const candidates: ReviewBenchMatchCandidate[] = sortedLabels.flatMap((label) => sortedBots.flatMap((bot) => {
    if (bot.path !== label.path) return [];
    const severityDelta = Math.abs(severityRank(bot.severity) - severityRank(label.severity));
    if (severityDelta > 1) return [];
    const lineDelta = Math.abs(bot.line - label.line);
    if (lineDelta > 3) return [];
    return [{
      bot,
      label,
      classification: (lineDelta === 0 ? "exact" : "nearby") as "exact" | "nearby",
      lineDelta,
      severityDelta,
      tokenOverlap: tokenOverlap(bot, label),
      semanticMatch: options.semanticMatch(bot, label)
    }];
  }));

  candidates.sort(compareMatchCandidate);
  const eligibleCandidates = candidates.filter((candidate) =>
    candidate.semanticMatch && candidate.tokenOverlap >= lexicalFloor(candidate.classification)
  );
  const selectedMatches = maximumCardinalityMatches(eligibleCandidates);
  const adjudicationQueue: Array<{
    botFindingId: string;
    labelId: string;
    classification: "exact" | "nearby";
    reason: "semantic_near_miss" | "lexical_near_miss";
  }> = [];
  const nearMisses: ReviewBenchNearMiss[] = [];
  for (const candidate of candidates) {
    const lexicalMatch = candidate.tokenOverlap >= lexicalFloor(candidate.classification);
    if (!candidate.semanticMatch && candidate.tokenOverlap >= 0.2) {
      nearMisses.push({ candidate, reason: "semantic_near_miss" });
    } else if (candidate.semanticMatch && !lexicalMatch) {
      nearMisses.push({ candidate, reason: "lexical_near_miss" });
    }
  }
  const queueableNearMisses = findAugmentingNearMisses(eligibleCandidates, nearMisses);
  for (const nearMiss of nearMisses) {
    if (!queueableNearMisses.has(nearMiss.candidate)) continue;
    adjudicationQueue.push(toAdjudicationItem(nearMiss.candidate, nearMiss.reason));
  }

  const semanticDecisionsSha256 = sha256(canonicalJson(candidates
    .map((candidate) => ({
      botFindingId: candidate.bot.id,
      labelId: candidate.label.id,
      semanticMatch: candidate.semanticMatch
    }))
    .sort((a, b) => compareFixed(a.botFindingId, b.botFindingId) || compareFixed(a.labelId, b.labelId))));
  const matcherBasis = {
    matcherVersion: REVIEW_BENCH_MATCHER_VERSION,
    candidateModelId: options.candidateModelId,
    candidateTargetFingerprint: options.candidateTargetFingerprint,
    semanticEvaluator: options.semanticEvaluator,
    lexicalThresholds: REVIEW_BENCH_LEXICAL_THRESHOLDS
  };
  const matcherIdentity: ReviewBenchMatcherIdentity = {
    ...matcherBasis,
    semanticDecisionsSha256,
    matcherFingerprint: sha256(canonicalJson(matcherBasis))
  };

  const matches = selectedMatches
    .map((candidate) => ({
      botFindingId: candidate.bot.id,
      labelId: candidate.label.id,
      classification: candidate.classification
    }))
    .sort((a, b) => compareFixed(a.labelId, b.labelId) || compareFixed(a.botFindingId, b.botFindingId));

  return {
    matcherVersion: REVIEW_BENCH_MATCHER_VERSION,
    matcherIdentity,
    candidates: candidates.map((candidate) => ({
      botFindingId: candidate.bot.id,
      labelId: candidate.label.id,
      classification: candidate.classification
    })),
    matches,
    adjudicationQueue: adjudicationQueue.sort((a, b) =>
      compareFixed(a.labelId, b.labelId) || compareFixed(a.botFindingId, b.botFindingId)
    )
  };
}

interface ReviewBenchMatchCandidate {
  bot: ReviewBenchFinding;
  label: ReviewBenchGoldFinding;
  classification: "exact" | "nearby";
  lineDelta: number;
  severityDelta: number;
  tokenOverlap: number;
  semanticMatch: boolean;
}

interface ReviewBenchNearMiss {
  candidate: ReviewBenchMatchCandidate;
  reason: "semantic_near_miss" | "lexical_near_miss";
}

function maximumCardinalityMatches(candidates: ReviewBenchMatchCandidate[]): ReviewBenchMatchCandidate[] {
  if (candidates.length === 0) return [];
  const botIds = [...new Set(candidates.map((candidate) => candidate.bot.id))].sort(compareFixed);
  const labelIds = [...new Set(candidates.map((candidate) => candidate.label.id))].sort(compareFixed);
  const source = 0;
  const firstBot = 1;
  const firstLabel = firstBot + botIds.length;
  const sink = firstLabel + labelIds.length;
  const graph: ReviewBenchFlowEdge[][] = Array.from({ length: sink + 1 }, () => []);
  const botNodes = new Map(botIds.map((id, index) => [id, firstBot + index]));
  const labelNodes = new Map(labelIds.map((id, index) => [id, firstLabel + index]));
  for (const botId of botIds) addFlowEdge(graph, source, botNodes.get(botId)!, 1, 0);
  for (const labelId of labelIds) addFlowEdge(graph, labelNodes.get(labelId)!, sink, 1, 0);

  const stableCandidates = [...candidates].sort((a, b) =>
    compareFixed(a.bot.id, b.bot.id) || compareFixed(a.label.id, b.label.id)
  );
  const maximumMatches = Math.min(botIds.length, labelIds.length);
  const stableBudget = maximumMatches * Math.max(stableCandidates.length - 1, 0);
  const severityWeight = stableBudget + 1;
  const lineWeight = maximumMatches * severityWeight + stableBudget + 1;
  const nearbyWeight = 3 * maximumMatches * lineWeight +
    maximumMatches * severityWeight + stableBudget + 1;
  const candidateEdges: Array<{ edge: ReviewBenchFlowEdge; candidate: ReviewBenchMatchCandidate }> = [];
  stableCandidates.forEach((candidate, stableRank) => {
    const cost = (candidate.classification === "nearby" ? nearbyWeight : 0) +
      candidate.lineDelta * lineWeight +
      candidate.severityDelta * severityWeight +
      stableRank;
    const edge = addFlowEdge(
      graph,
      botNodes.get(candidate.bot.id)!,
      labelNodes.get(candidate.label.id)!,
      1,
      cost
    );
    candidateEdges.push({ edge, candidate });
  });

  while (augmentMinimumCostPath(graph, source, sink)) {
    // Unit capacities mean each successful path adds exactly one match.
  }
  return candidateEdges.filter(({ edge }) => edge.capacity === 0).map(({ candidate }) => candidate);
}

interface ReviewBenchFlowEdge {
  to: number;
  reverseIndex: number;
  capacity: number;
  cost: number;
}

function addFlowEdge(
  graph: ReviewBenchFlowEdge[][],
  from: number,
  to: number,
  capacity: number,
  cost: number
): ReviewBenchFlowEdge {
  const forward: ReviewBenchFlowEdge = { to, reverseIndex: graph[to].length, capacity, cost };
  const reverse: ReviewBenchFlowEdge = { to: from, reverseIndex: graph[from].length, capacity: 0, cost: -cost };
  graph[from].push(forward);
  graph[to].push(reverse);
  return forward;
}

function augmentMinimumCostPath(graph: ReviewBenchFlowEdge[][], source: number, sink: number): boolean {
  const distances = Array<number>(graph.length).fill(Number.POSITIVE_INFINITY);
  const previousNode = Array<number>(graph.length).fill(-1);
  const previousEdge = Array<number>(graph.length).fill(-1);
  distances[source] = 0;

  for (let iteration = 0; iteration < graph.length - 1; iteration += 1) {
    let changed = false;
    for (let node = 0; node < graph.length; node += 1) {
      if (!Number.isFinite(distances[node])) continue;
      for (let edgeIndex = 0; edgeIndex < graph[node].length; edgeIndex += 1) {
        const edge = graph[node][edgeIndex];
        if (edge.capacity <= 0) continue;
        const nextDistance = distances[node] + edge.cost;
        if (nextDistance >= distances[edge.to]) continue;
        distances[edge.to] = nextDistance;
        previousNode[edge.to] = node;
        previousEdge[edge.to] = edgeIndex;
        changed = true;
      }
    }
    if (!changed) break;
  }
  if (!Number.isFinite(distances[sink])) return false;
  for (let node = sink; node !== source; node = previousNode[node]) {
    const from = previousNode[node];
    const edge = graph[from][previousEdge[node]];
    edge.capacity -= 1;
    graph[node][edge.reverseIndex].capacity += 1;
  }
  return true;
}

function findAugmentingNearMisses(
  eligibleCandidates: ReviewBenchMatchCandidate[],
  nearMisses: ReviewBenchNearMiss[]
): Set<ReviewBenchMatchCandidate> {
  const queueable = new Set<ReviewBenchMatchCandidate>();
  if (nearMisses.length === 0) return queueable;
  const allCandidates = [...eligibleCandidates, ...nearMisses.map(({ candidate }) => candidate)];
  const adjacency = new Map<string, Set<string>>();
  const nodeForBot = (id: string) => `bot:${id}`;
  const nodeForLabel = (id: string) => `label:${id}`;
  for (const candidate of allCandidates) {
    const botNode = nodeForBot(candidate.bot.id);
    const labelNode = nodeForLabel(candidate.label.id);
    if (!adjacency.has(botNode)) adjacency.set(botNode, new Set<string>());
    if (!adjacency.has(labelNode)) adjacency.set(labelNode, new Set<string>());
    adjacency.get(botNode)!.add(labelNode);
    adjacency.get(labelNode)!.add(botNode);
  }

  const visited = new Set<string>();
  for (const start of [...adjacency.keys()].sort(compareFixed)) {
    if (visited.has(start)) continue;
    const component = new Set<string>();
    const pending = [start];
    visited.add(start);
    while (pending.length > 0) {
      const node = pending.shift()!;
      component.add(node);
      for (const neighbor of [...(adjacency.get(node) ?? [])].sort(compareFixed)) {
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);
        pending.push(neighbor);
      }
    }
    const inComponent = (candidate: ReviewBenchMatchCandidate) =>
      component.has(nodeForBot(candidate.bot.id)) && component.has(nodeForLabel(candidate.label.id));
    const componentEligible = eligibleCandidates.filter(inComponent);
    const componentNearMisses = nearMisses.filter(({ candidate }) => inComponent(candidate));
    if (componentNearMisses.length === 0) continue;
    const baseline = maximumCardinalityMatches(componentEligible).length;
    const potential = maximumCardinalityMatches([
      ...componentEligible,
      ...componentNearMisses.map(({ candidate }) => candidate)
    ]).length;
    if (potential <= baseline) continue;
    for (const nearMiss of componentNearMisses) queueable.add(nearMiss.candidate);
  }
  return queueable;
}

function compareMatchCandidate(a: ReviewBenchMatchCandidate, b: ReviewBenchMatchCandidate): number {
  return classificationRank(a.classification) - classificationRank(b.classification) ||
    a.lineDelta - b.lineDelta ||
    a.severityDelta - b.severityDelta ||
    (b.bot.confidence ?? 0) - (a.bot.confidence ?? 0) ||
    compareFixed(a.label.id, b.label.id) ||
    compareFixed(a.bot.id, b.bot.id);
}

function lexicalFloor(classification: "exact" | "nearby"): number {
  return REVIEW_BENCH_LEXICAL_THRESHOLDS[classification];
}

function validateMatcherOptions(options: ReviewBenchMatcherOptions): void {
  if (!options || typeof options !== "object") throw new Error("matcher options are required");
  requireNonEmpty(options.candidateModelId, "matcher candidateModelId");
  requireSha256(options.candidateTargetFingerprint, "matcher candidateTargetFingerprint");
  if (!options.semanticEvaluator || typeof options.semanticEvaluator !== "object") {
    throw new Error("matcher semanticEvaluator is required");
  }
  if (!(options.semanticEvaluator.kind === "human" || options.semanticEvaluator.kind === "model")) {
    throw new Error("matcher semanticEvaluator.kind must be human or model");
  }
  requireNonEmpty(options.semanticEvaluator.id, "matcher semanticEvaluator.id");
  requireNonEmpty(options.semanticEvaluator.version, "matcher semanticEvaluator.version");
  requireSha256(options.semanticEvaluator.evidenceSha256, "matcher semanticEvaluator.evidenceSha256");
  if (normalizeIdentity(options.candidateModelId) === normalizeIdentity(options.semanticEvaluator.id)) {
    throw new Error("matcher requires an independent semantic evaluator");
  }
  if (options.semanticEvaluator.kind === "model") {
    requireSha256(options.semanticEvaluator.targetFingerprint, "matcher semanticEvaluator.targetFingerprint");
    if (options.candidateTargetFingerprint === options.semanticEvaluator.targetFingerprint) {
      throw new Error("matcher requires an independent semantic evaluator target fingerprint");
    }
  } else if (options.semanticEvaluator.targetFingerprint !== undefined) {
    throw new Error("human semantic evaluator must not declare a model target fingerprint");
  }
  if (typeof options.semanticMatch !== "function") throw new Error("matcher semanticMatch callback is required");
}

function validateMatcherFindingIds(
  findings: Array<ReviewBenchFinding | ReviewBenchGoldFinding>,
  kind: "bot" | "label"
): void {
  if (!Array.isArray(findings)) throw new Error(`${kind} findings must be an array`);
  const ids = new Set<string>();
  for (const [index, finding] of findings.entries()) {
    validateFinding(finding, `${kind}Findings[${index}]`);
    if (ids.has(finding.id)) {
      const duplicateKind = kind === "label" ? "label id" : "bot finding id";
      throw new Error(`duplicate ${duplicateKind}: ${finding.id}`);
    }
    ids.add(finding.id);
  }
}

function normalizeIdentity(value: string): string {
  return value.trim().toLowerCase();
}

export function adaptLegacyEvalScenario(input: EvalScenarioInput): {
  identity: { scenarioId: string; sourceId: string };
  matching: { severityTolerance: 0; requireSemanticCallback: false };
  evalScenario: EvalScenarioInput;
} {
  const sourceIdentity = `legacy:${input.repo}#${input.pullNumber}@${input.headSha}`;
  return {
    identity: {
      scenarioId: `${sourceIdentity}:${input.suite}`,
      sourceId: sourceIdentity
    },
    matching: { severityTolerance: 0, requireSemanticCallback: false },
    evalScenario: input
  };
}

function validateScenario(scenario: ReviewBenchScenarioV1, path: string): void {
  if (!scenario || typeof scenario !== "object") throw new Error(`${path} must be an object`);
  requireExactKeys(scenario, [
    "schemaVersion",
    "scenarioId",
    "sourceId",
    "runId",
    "repository",
    "sourceRevision",
    "license",
    "provenance",
    "language",
    "split",
    "bugFamily",
    "explicitControl",
    "labels",
    "adjudication"
  ], path);
  if (scenario.schemaVersion !== "review-bench-scenario/v1") {
    throw new Error(`${path}.schemaVersion must be review-bench-scenario/v1`);
  }
  for (const field of ["scenarioId", "sourceId", "runId", "repository", "sourceRevision", "language", "bugFamily"] as const) {
    requireNonEmpty(scenario[field], `${path}.${field}`);
  }
  if (scenario.repository !== scenario.repository.trim() ||
      !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/.test(scenario.repository) ||
      scenario.repository.endsWith(".git")) {
    throw new Error(`${path}.repository must be a canonical repository identity`);
  }
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(scenario.sourceRevision)) {
    throw new Error(`${path}.sourceRevision must be an immutable commit digest`);
  }
  if (!scenario.license || typeof scenario.license !== "object") throw new Error(`${path}.license is required`);
  requireExactKeys(scenario.license, ["spdxId", "licenseUrl"], `${path}.license`);
  requireNonEmpty(scenario.license.spdxId, `${path}.license.spdxId`);
  const licenseValidation = validateNpmPackageLicense(scenario.license.spdxId);
  if (!licenseValidation.validForNewPackages ||
      !/^[A-Za-z0-9][A-Za-z0-9.+-]*$/.test(scenario.license.spdxId) ||
      ["NONE", "NOASSERTION", "UNLICENSED"].includes(scenario.license.spdxId.toUpperCase())) {
    throw new Error(
      `${path}.license.spdxId must be a verified SPDX identifier and a single SPDX identifier`
    );
  }
  requirePublicHttpsUrl(scenario.license.licenseUrl, `${path}.license.licenseUrl`);
  if (!scenario.provenance || typeof scenario.provenance !== "object") {
    throw new Error(`${path}.provenance is required`);
  }
  requireExactKeys(scenario.provenance, [
    "kind",
    "baseRevision",
    "repositoryUrl",
    "sourceUrl",
    "sourceArtifactUrl",
    "sourceArtifactSha256",
    "visibility",
    "visibilityEvidenceUrl",
    "visibilityVerifiedAt",
    "verification"
  ], `${path}.provenance`);
  if (!(["pull_request", "commit", "revert", "synthetic"] as unknown[]).includes(scenario.provenance.kind)) {
    throw new Error(`${path}.provenance.kind must be pull_request, commit, revert, or synthetic`);
  }
  if (scenario.provenance.kind === "pull_request") {
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(scenario.provenance.baseRevision ?? "") ||
        scenario.provenance.baseRevision === scenario.sourceRevision) {
      throw new Error(`${path}.provenance.baseRevision must be a distinct immutable commit digest for pull requests`);
    }
  } else if (scenario.provenance.baseRevision !== undefined) {
    throw new Error(`${path}.provenance.baseRevision is only allowed for pull requests`);
  }
  requirePublicHttpsUrl(scenario.provenance.repositoryUrl, `${path}.provenance.repositoryUrl`);
  requirePublicHttpsUrl(scenario.provenance.sourceUrl, `${path}.provenance.sourceUrl`);
  requirePublicHttpsUrl(scenario.provenance.sourceArtifactUrl, `${path}.provenance.sourceArtifactUrl`);
  requireSha256(scenario.provenance.sourceArtifactSha256, `${path}.provenance.sourceArtifactSha256`);
  if (scenario.provenance.visibility !== "public") {
    throw new Error(`${path}.provenance.visibility must be public`);
  }
  requirePublicHttpsUrl(
    scenario.provenance.visibilityEvidenceUrl,
    `${path}.provenance.visibilityEvidenceUrl`
  );
  requireIsoDate(scenario.provenance.visibilityVerifiedAt, `${path}.provenance.visibilityVerifiedAt`);
  validateRepositoryBinding(scenario, path);
  validateEvidenceBindings(scenario, path);
  validateSourceVerification(scenario, path);
  if (!(["train", "validation", "holdout"] as unknown[]).includes(scenario.split)) {
    throw new Error(`${path}.split must be train, validation, or holdout`);
  }
  if (typeof scenario.explicitControl !== "boolean") throw new Error(`${path}.explicitControl must be a boolean`);
  if (!Array.isArray(scenario.labels)) throw new Error(`${path}.labels must be an array`);
  const labelIds = new Set<string>();
  scenario.labels.forEach((label, labelIndex) => {
    const labelPath = `${path}.labels[${labelIndex}]`;
    validateFinding(label, labelPath);
    if (label.confidence !== undefined) throw new Error(`${labelPath} gold label confidence is not allowed`);
    if (labelIds.has(label.id)) throw new Error(`${path} duplicate label id: ${label.id}`);
    labelIds.add(label.id);
  });
  if (scenario.explicitControl && scenario.labels.length > 0) {
    throw new Error(`${path} explicit control must not contain gold defect labels`);
  }
  if (!scenario.explicitControl && scenario.labels.length === 0) {
    throw new Error(`${path} defect scenario must contain at least one gold label`);
  }
  if (!scenario.adjudication || typeof scenario.adjudication !== "object") {
    throw new Error(`${path}.adjudication is required`);
  }
  requireExactKeys(scenario.adjudication, [
    "status",
    "primaryAdjudicator",
    "secondaryAdjudicator",
    "agreement",
    "method",
    "rubricVersion",
    "completedAt"
  ], `${path}.adjudication`);
  if (scenario.adjudication.status !== "independently_adjudicated") {
    throw new Error(`${path}.adjudication.status must be independently_adjudicated`);
  }
  for (const field of ["primaryAdjudicator", "secondaryAdjudicator", "method"] as const) {
    requireNonEmpty(scenario.adjudication[field], `${path}.adjudication.${field}`);
  }
  if (scenario.adjudication.primaryAdjudicator.trim().toLowerCase() ===
      scenario.adjudication.secondaryAdjudicator.trim().toLowerCase()) {
    throw new Error(`${path}.adjudication requires two distinct adjudicators`);
  }
  if (!(["agree", "reconciled"] as unknown[]).includes(scenario.adjudication.agreement)) {
    throw new Error(`${path}.adjudication has unresolved adjudication disagreement`);
  }
  requireNonEmpty(scenario.adjudication.rubricVersion, `${path}.adjudication.rubricVersion`);
  requireIsoDate(scenario.adjudication.completedAt, `${path}.adjudication.completedAt`);
  rejectSecretLikeText(scenario, path);
}

function validateHoldoutFloor(floor: ReviewBenchCorpusV1["splitPolicy"]["holdoutFloor"]): void {
  if (!floor || typeof floor !== "object") throw new Error("splitPolicy.holdoutFloor is required");
  requireExactKeys(floor, ["scenarios", "repositories", "minimumFraction"], "splitPolicy.holdoutFloor");
  for (const field of ["scenarios", "repositories"] as const) {
    if (!Number.isSafeInteger(floor[field]) || floor[field] < 1) {
      throw new Error(`splitPolicy.holdoutFloor.${field} must be a positive integer`);
    }
  }
  if (typeof floor.minimumFraction !== "number" || !Number.isFinite(floor.minimumFraction) ||
      floor.minimumFraction <= 0 || floor.minimumFraction > 1) {
    throw new Error("splitPolicy.holdoutFloor.minimumFraction must be greater than 0 and at most 1");
  }
}

function computeSourceIdentity(scenario: ReviewBenchScenarioV1): string {
  return [
    normalizeRepositoryIdentity(scenario.repository),
    scenario.sourceRevision.trim().toLowerCase(),
    scenario.bugFamily.trim().toLowerCase()
  ].join("@");
}

function validateFinding(finding: ReviewBenchFinding, path: string): void {
  if (!finding || typeof finding !== "object") throw new Error(`${path} must be an object`);
  requireExactKeys(finding, ["id", "path", "line", "severity", "confidence", "title", "body"], path);
  for (const field of ["id", "path", "title", "body"] as const) {
    requireNonEmpty(finding[field], `${path}.${field}`);
  }
  if (!Number.isSafeInteger(finding.line) || finding.line < 1) {
    throw new Error(`${path}.line must be a positive integer`);
  }
  if (!(["P0", "P1", "P2", "P3"] as unknown[]).includes(finding.severity)) {
    throw new Error(`${path}.severity must be P0, P1, P2, or P3`);
  }
  if (finding.confidence !== undefined &&
      (typeof finding.confidence !== "number" || !Number.isFinite(finding.confidence) ||
       finding.confidence < 0 || finding.confidence > 1)) {
    throw new Error(`${path}.confidence must be between 0 and 1`);
  }
}

function validateRepositoryBinding(scenario: ReviewBenchScenarioV1, path: string): void {
  const repositoryUrl = new URL(scenario.provenance.repositoryUrl);
  const sourceUrl = new URL(scenario.provenance.sourceUrl);
  const sourceArtifactUrl = new URL(scenario.provenance.sourceArtifactUrl);
  const repositoryPath = normalizeRepositoryUrlPath(repositoryUrl.pathname);
  const expectedRepository = normalizeRepositoryIdentity(scenario.repository);
  const sourcePath = normalizeRepositoryUrlPath(sourceUrl.pathname);
  const expectedArtifactPath = scenario.provenance.kind === "pull_request"
    ? `${expectedRepository}/compare/${scenario.provenance.baseRevision!.toLowerCase()}...${scenario.sourceRevision.toLowerCase()}.diff`
    : `${expectedRepository}/commit/${scenario.sourceRevision.toLowerCase()}.diff`;
  if (repositoryPath !== expectedRepository || sourceUrl.origin !== repositoryUrl.origin ||
      (sourcePath !== repositoryPath && !sourcePath.startsWith(`${repositoryPath}/`)) ||
      sourceArtifactUrl.origin !== repositoryUrl.origin ||
      normalizeRepositoryUrlPath(sourceArtifactUrl.pathname) !== expectedArtifactPath) {
    throw new Error(`${path}.provenance URLs must be bound to repository ${scenario.repository}`);
  }
}

function validateEvidenceBindings(scenario: ReviewBenchScenarioV1, path: string): void {
  const repositoryUrl = new URL(scenario.provenance.repositoryUrl);
  const repository = normalizeRepositoryIdentity(scenario.repository);
  const licenseUrl = new URL(scenario.license.licenseUrl);
  const visibilityEvidenceUrl = new URL(scenario.provenance.visibilityEvidenceUrl);
  const expectedLicensePrefix = `${repository}/${scenario.sourceRevision.toLowerCase()}/`;
  if (licenseUrl.origin !== "https://raw.githubusercontent.com" ||
      !normalizeRepositoryUrlPath(licenseUrl.pathname).startsWith(expectedLicensePrefix)) {
    throw new Error(`${path}.license.licenseUrl must be bound to repository and sourceRevision`);
  }
  const expectedVisibilityPath = `repos/${repository}`;
  if (repositoryUrl.hostname.toLowerCase() !== "github.com" ||
      visibilityEvidenceUrl.origin !== "https://api.github.com" ||
      normalizeRepositoryUrlPath(visibilityEvidenceUrl.pathname) !== expectedVisibilityPath) {
    throw new Error(`${path}.provenance.visibilityEvidenceUrl must be bound to repository`);
  }
}

function validateSourceVerification(scenario: ReviewBenchScenarioV1, path: string): void {
  const verification = scenario.provenance.verification;
  if (!verification || typeof verification !== "object") {
    throw new Error(`${path}.provenance.verification is required`);
  }
  requireExactKeys(verification, [
    "schemaVersion",
    "provider",
    "verifierVersion",
    "repositoryNodeId",
    "visibility",
    "licenseSpdxId",
    "repositoryMetadataSha256",
    "sourceMetadataSha256",
    "licenseArtifactSha256",
    "sourceArtifactSha256",
    "verifiedAt",
    "bindingSha256"
  ], `${path}.provenance.verification`);
  if (verification.schemaVersion !== "review-bench-source-verification/v1") {
    throw new Error(`${path}.provenance.verification.schemaVersion is invalid`);
  }
  if (verification.provider !== "github" ||
      verification.verifierVersion !== "github-public-source-ingest/v1") {
    throw new Error(`${path}.provenance.verification verifier identity is invalid`);
  }
  requireNonEmpty(verification.repositoryNodeId, `${path}.provenance.verification.repositoryNodeId`);
  if (verification.visibility !== "public") {
    throw new Error(`${path}.provenance.verification.visibility must be public`);
  }
  if (verification.licenseSpdxId !== scenario.license.spdxId) {
    throw new Error(`${path}.provenance.verification license SPDX mismatch`);
  }
  requireSha256(
    verification.repositoryMetadataSha256,
    `${path}.provenance.verification.repositoryMetadataSha256`
  );
  requireSha256(
    verification.sourceMetadataSha256,
    `${path}.provenance.verification.sourceMetadataSha256`
  );
  requireSha256(
    verification.licenseArtifactSha256,
    `${path}.provenance.verification.licenseArtifactSha256`
  );
  requireSha256(
    verification.sourceArtifactSha256,
    `${path}.provenance.verification.sourceArtifactSha256`
  );
  if (verification.sourceArtifactSha256 !== scenario.provenance.sourceArtifactSha256) {
    throw new Error(`${path}.provenance.verification source artifact sha256 mismatch`);
  }
  requireIsoDate(verification.verifiedAt, `${path}.provenance.verification.verifiedAt`);
  if (verification.verifiedAt !== scenario.provenance.visibilityVerifiedAt) {
    throw new Error(`${path}.provenance.verification verifiedAt mismatch`);
  }
  requireSha256(verification.bindingSha256, `${path}.provenance.verification.bindingSha256`);
  const expectedBinding = computeReviewBenchSourceVerificationBinding(scenario);
  if (verification.bindingSha256 !== expectedBinding) {
    throw new Error(`${path}.provenance verification binding mismatch`);
  }
}

function normalizeRepositoryUrlPath(pathname: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    decoded = pathname;
  }
  return decoded.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "").toLowerCase();
}

function normalizeRepositoryIdentity(repository: string): string {
  return repository.trim().replace(/\.git$/i, "").toLowerCase();
}

function requireSha256(value: unknown, path: string): asserts value is string {
  requireNonEmpty(value, path);
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`${path} must be a sha256 hex digest`);
}

function rejectSecretLikeText(value: unknown, path: string): void {
  if (typeof value === "string") {
    if (containsSecretLikeText(value)) throw new Error(`${path} contains secret-like text`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectSecretLikeText(item, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) rejectSecretLikeText(item, `${path}.${key}`);
  }
}

function requirePublicHttpsUrl(value: unknown, path: string): void {
  requireNonEmpty(value, path);
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
        !isPublicHostname(url.hostname)) {
      throw new Error("unsafe public URL");
    }
  } catch {
    throw new Error(`${path} must be a public HTTPS URL without credentials, query, or fragment`);
  }
}

function isPublicHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!normalized || normalized === "localhost" || normalized.endsWith(".localhost") ||
      normalized.endsWith(".local") || normalized.endsWith(".internal")) {
    return false;
  }
  const ipVersion = isIP(normalized);
  if (ipVersion === 4) return isPublicIpv4(normalized);
  if (ipVersion === 6) return isPublicIpv6(normalized);
  return true;
}

function isPublicIpv4(address: string): boolean {
  const [a, b] = address.split(".").map(Number);
  return !(a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224);
}

function isPublicIpv6(address: string): boolean {
  const normalized = address.toLowerCase();
  return normalized !== "::" && normalized !== "::1" &&
    !normalized.startsWith("fc") && !normalized.startsWith("fd") &&
    !normalized.startsWith("fe8") && !normalized.startsWith("fe9") &&
    !normalized.startsWith("fea") && !normalized.startsWith("feb");
}

function requireIsoDate(value: unknown, path: string): void {
  requireNonEmpty(value, path);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new Error(`${path} must be an ISO-8601 UTC timestamp`);
  }
}

function requireNonEmpty(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${path} must be a non-empty string`);
}

function requireExactKeys(value: object, allowedKeys: string[], path: string): void {
  const allowed = new Set(allowedKeys);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key)).sort(compareFixed);
  if (unknown.length > 0) throw new Error(`${path} has unknown keys: ${unknown.join(", ")}`);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => compareFixed(a, b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function compareFixed(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function severityRank(severity: Severity): number {
  return ({ P0: 0, P1: 1, P2: 2, P3: 3 })[severity];
}

function classificationRank(classification: "exact" | "nearby"): number {
  return classification === "exact" ? 0 : 1;
}

function tokenOverlap(a: Pick<ReviewBenchFinding, "title" | "body">, b: Pick<ReviewBenchFinding, "title" | "body">): number {
  const aTokens = tokenize(`${a.title} ${a.body}`);
  const bTokens = tokenize(`${b.title} ${b.body}`);
  if (aTokens.size === 0 || bTokens.size === 0) return 0;
  const intersection = [...aTokens].filter((token) => bTokens.has(token)).length;
  return intersection / Math.min(aTokens.size, bTokens.size);
}

function tokenize(value: string): Set<string> {
  return new Set(value.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length >= 4));
}

function toAdjudicationItem(
  candidate: {
    bot: ReviewBenchFinding;
    label: ReviewBenchFinding;
    classification: "exact" | "nearby";
  },
  reason: "semantic_near_miss" | "lexical_near_miss"
): {
  botFindingId: string;
  labelId: string;
  classification: "exact" | "nearby";
  reason: "semantic_near_miss" | "lexical_near_miss";
} {
  return {
    botFindingId: candidate.bot.id,
    labelId: candidate.label.id,
    classification: candidate.classification,
    reason
  };
}
