export type IssueEnrichmentScoreDimensionId =
  | "related_context_precision"
  | "planning_value"
  | "acceptance_criteria"
  | "ownership_routing"
  | "proof_boundary"
  | "lifecycle_state"
  | "noise_control"
  | "idempotency"
  | "safety"
  | "throttling";

export type IssueEnrichmentFixtureCoverageId =
  | "duplicate_same_head_comments"
  | "stale_head_posts"
  | "invalid_inline_coordinates"
  | "issue_enrichment_permission_failure"
  | "launchd_config_head_ambiguity"
  | "docs_only_fast_negative_control"
  | "old_backlog_negative_control"
  | "external_precedent_required_issue"
  | "stale_irrelevant_web_result"
  | "provider_failure_burst_30_prs";

export interface IssueEnrichmentMetricContract {
  denominator: string;
  dataSource: string;
  scoringRule: string;
  unmeasurableState: string;
  pilotThreshold: {
    advisoryMin: number;
    promotionMin: number;
  };
}

export interface IssueEnrichmentScoreDimension {
  id: IssueEnrichmentScoreDimensionId;
  label: string;
  weight: number;
  metricContract: IssueEnrichmentMetricContract;
}

export interface IssueEnrichmentDimensionFixtureScore {
  score?: number;
  evidenceLinks?: string[];
  notes?: string;
  unmeasurable?: boolean;
  unmeasurableReason?: string;
}

export interface IssueEnrichmentFixtureCase {
  id: string;
  title: string;
  coverage: IssueEnrichmentFixtureCoverageId;
  fixtureSource?: string;
  dimensions: Record<IssueEnrichmentScoreDimensionId, IssueEnrichmentDimensionFixtureScore>;
}

export interface IssueEnrichmentFixturePacket {
  fixtureVersion: "0.1";
  proofBoundary: string;
  knownLimitations: string[];
  metricContracts?: Partial<Record<IssueEnrichmentScoreDimensionId, IssueEnrichmentMetricContract>>;
  cases: IssueEnrichmentFixtureCase[];
}

export interface IssueEnrichmentDimensionScore {
  id: IssueEnrichmentScoreDimensionId;
  label: string;
  score: number;
  weight: number;
  rawScore: number;
  weightedContribution: number;
  measuredCases: number;
  unmeasurableCases: string[];
  pilotThresholdMisses: string[];
  evidenceLinks: string[];
}

export interface IssueEnrichmentScorecardResult {
  rawScore: number;
  weightedScore: number;
  publicClaim: "no_public_claim";
  calibration: "uncalibrated";
  dimensionScores: IssueEnrichmentDimensionScore[];
  unmeasurableStates: string[];
  pilotThresholdMisses: string[];
  proofBoundary: string;
  knownLimitations: string[];
}

export interface IssueEnrichmentFixtureValidation {
  ok: boolean;
  errors: string[];
  coveredScenarioIds: IssueEnrichmentFixtureCoverageId[];
}

export const ISSUE_ENRICHMENT_REQUIRED_FIXTURE_COVERAGE: IssueEnrichmentFixtureCoverageId[] = [
  "duplicate_same_head_comments",
  "stale_head_posts",
  "invalid_inline_coordinates",
  "issue_enrichment_permission_failure",
  "launchd_config_head_ambiguity",
  "docs_only_fast_negative_control",
  "old_backlog_negative_control",
  "external_precedent_required_issue",
  "stale_irrelevant_web_result",
  "provider_failure_burst_30_prs"
];

export const ISSUE_ENRICHMENT_SCORE_DIMENSIONS: IssueEnrichmentScoreDimension[] = [
  dimension("related_context_precision", "Related-context precision", 12, {
    denominator: "Issue-enrichment comments that cite related repos, PRs, issues, docs, or web precedents.",
    dataSource: "Sampled enrichment fixture cases plus linked GitHub evidence.",
    scoringRule: "0 means unrelated or stale context; 3 means useful but incomplete; 5 means all cited context is directly relevant and current. The validator enforces evidence-link presence for high scores; fixture authors remain responsible for relevance review.",
    unmeasurableState: "No external or internal precedent is available to judge related-context quality.",
    pilotThreshold: { advisoryMin: 3.5, promotionMin: 4.2 }
  }),
  dimension("planning_value", "Planning value", 11, {
    denominator: "Issue-enrichment comments that propose next work.",
    dataSource: "Generated issue-enrichment body and fixture expectation notes.",
    scoringRule: "Score practical decomposition, sequencing, and handoff value without claiming implementation readiness.",
    unmeasurableState: "Issue lacks enough product or engineering detail to evaluate plan usefulness.",
    pilotThreshold: { advisoryMin: 3.5, promotionMin: 4.2 }
  }),
  dimension("acceptance_criteria", "Acceptance criteria", 12, {
    denominator: "Issue-enrichment comments for issues with testable or reviewable outcomes.",
    dataSource: "Issue body, generated enrichment, and regression fixture labels.",
    scoringRule: "Score explicit pass/fail criteria, negative controls, and validation commands or CI gates.",
    unmeasurableState: "Issue is intentionally exploratory and has no accepted outcome contract yet.",
    pilotThreshold: { advisoryMin: 3.5, promotionMin: 4.2 }
  }),
  dimension("ownership_routing", "Ownership/routing", 9, {
    denominator: "Issue-enrichment comments that name owners, repos, lanes, or reviewer routes.",
    dataSource: "Issue labels, repo ownership metadata, and generated routing suggestions.",
    scoringRule: "Score whether ownership suggestions are specific, bounded, and do not mutate labels or assignees.",
    unmeasurableState: "No owner, repo, or lane data is available in the fixture source.",
    pilotThreshold: { advisoryMin: 3.5, promotionMin: 4.2 }
  }),
  dimension("proof_boundary", "Proof boundary", 13, {
    denominator: "Issue-enrichment comments that make any evidence, readiness, or verification statement.",
    dataSource: "Generated body, fixture proof-boundary notes, and linked evidence URLs.",
    scoringRule: "Score explicit separation between advisory scoring, local evidence, CI proof, runtime proof, and release proof.",
    unmeasurableState: "No proof claim is present.",
    pilotThreshold: { advisoryMin: 4, promotionMin: 4.5 }
  }),
  dimension("lifecycle_state", "Lifecycle state", 8, {
    denominator: "Issue-enrichment comments for open, closed, stale, backlog, or head-specific cases.",
    dataSource: "GitHub issue/PR state, head SHA metadata, and fixture lifecycle labels.",
    scoringRule: "Score correct handling of open/closed/stale/head-mismatch state and refusal to post on stale heads.",
    unmeasurableState: "Lifecycle state is absent from the fixture source.",
    pilotThreshold: { advisoryMin: 3.5, promotionMin: 4.2 }
  }),
  dimension("noise_control", "Noise control", 10, {
    denominator: "Potential enrichment comments across selected and backlog issues.",
    dataSource: "Fixture cases for duplicates, old backlog, docs-only negatives, and provider bursts.",
    scoringRule: "Score duplicate suppression, negative controls, and comment avoidance when enrichment would add noise.",
    unmeasurableState: "No comparable noisy or negative-control path is present.",
    pilotThreshold: { advisoryMin: 3.5, promotionMin: 4.2 }
  }),
  dimension("idempotency", "Idempotency", 9, {
    denominator: "Repeated issue-enrichment attempts against the same issue/head/comment marker.",
    dataSource: "Same-head duplicate fixtures, sticky marker expectations, and state records.",
    scoringRule: "Score stable upsert behavior and no duplicate same-head comments.",
    unmeasurableState: "Only a single attempted enrichment exists.",
    pilotThreshold: { advisoryMin: 3.5, promotionMin: 4.2 }
  }),
  dimension("safety", "Safety", 11, {
    denominator: "Issue-enrichment comments that handle permissions, config, launchd, safety, or external references.",
    dataSource: "Permission-failure, launchd/config ambiguity, and external-precedent fixtures.",
    scoringRule: "Score fail-closed behavior, explicit non-mutation, and safe refusal when evidence is ambiguous.",
    unmeasurableState: "No safety-sensitive operation is represented.",
    pilotThreshold: { advisoryMin: 3.8, promotionMin: 4.5 }
  }),
  dimension("throttling", "Throttling", 15, {
    denominator: "Issue-enrichment attempts that consume GitHub API, provider, or comment budget.",
    dataSource: "Throttle config, burst simulation fixtures, provider failure records, and issue-run status.",
    scoringRule: "Score budget-aware deferral, provider-failure containment, and cap enforcement across bursts.",
    unmeasurableState: "No request, provider, or posting budget data is available.",
    pilotThreshold: { advisoryMin: 2, promotionMin: 4 }
  })
];

const DIMENSIONS_BY_ID = new Map(ISSUE_ENRICHMENT_SCORE_DIMENSIONS.map((item) => [item.id, item]));

export function scoreIssueEnrichment(packet: IssueEnrichmentFixturePacket): IssueEnrichmentScorecardResult {
  const dimensionScores = ISSUE_ENRICHMENT_SCORE_DIMENSIONS.map((dimension) => scoreDimension(packet, dimension));
  const rawTotal = dimensionScores.reduce((sum, dimension) => sum + dimension.rawScore, 0);
  const weightedTotal = dimensionScores.reduce((sum, dimension) => sum + dimension.weightedContribution, 0);
  const maxRaw = ISSUE_ENRICHMENT_SCORE_DIMENSIONS.length * 5;
  const maxWeighted = ISSUE_ENRICHMENT_SCORE_DIMENSIONS.reduce((sum, dimension) => sum + dimension.weight * 5, 0);
  const unmeasurableStates = dimensionScores.flatMap((dimension) =>
    dimension.unmeasurableCases.map((caseId) => `${caseId}:${dimension.id}`)
  );
  const pilotThresholdMisses = dimensionScores.flatMap((dimension) =>
    dimension.pilotThresholdMisses.map((caseId) => `${caseId}:${dimension.id}`)
  );

  return {
    rawScore: percent(rawTotal, maxRaw),
    weightedScore: percent(weightedTotal, maxWeighted),
    publicClaim: "no_public_claim",
    calibration: "uncalibrated",
    dimensionScores,
    unmeasurableStates,
    pilotThresholdMisses,
    proofBoundary: packet.proofBoundary,
    knownLimitations: [...packet.knownLimitations]
  };
}

export function validateIssueEnrichmentFixture(packet: IssueEnrichmentFixturePacket): IssueEnrichmentFixtureValidation {
  const errors: string[] = [];
  const coveredScenarioIds = ISSUE_ENRICHMENT_REQUIRED_FIXTURE_COVERAGE.filter((coverage) =>
    packet.cases.some((item) => item.coverage === coverage)
  );
  const seenCaseIds = new Set<string>();
  const duplicateCaseIds = new Set<string>();
  const seenCoverageIds = new Set<IssueEnrichmentFixtureCoverageId>();
  const duplicateCoverageIds = new Set<IssueEnrichmentFixtureCoverageId>();

  if (!packet.proofBoundary?.trim()) errors.push("fixture proofBoundary is required");
  if (!Array.isArray(packet.knownLimitations) || packet.knownLimitations.length === 0) {
    errors.push("fixture knownLimitations are required");
  }

  for (const coverage of ISSUE_ENRICHMENT_REQUIRED_FIXTURE_COVERAGE) {
    if (!coveredScenarioIds.includes(coverage)) errors.push(`missing required fixture coverage ${coverage}`);
  }

  for (const dimension of ISSUE_ENRICHMENT_SCORE_DIMENSIONS) {
    const contract = packet.metricContracts?.[dimension.id] ?? dimension.metricContract;
    for (const key of ["denominator", "dataSource", "scoringRule", "unmeasurableState"] as const) {
      if (!contract[key]?.trim()) errors.push(`dimension ${dimension.id} metric contract missing ${key}`);
    }
    if (!Number.isFinite(contract.pilotThreshold?.advisoryMin)) {
      errors.push(`dimension ${dimension.id} metric contract missing pilotThreshold.advisoryMin`);
    }
    if (!Number.isFinite(contract.pilotThreshold?.promotionMin)) {
      errors.push(`dimension ${dimension.id} metric contract missing pilotThreshold.promotionMin`);
    }
  }

  for (const fixtureCase of packet.cases) {
    if (seenCaseIds.has(fixtureCase.id)) duplicateCaseIds.add(fixtureCase.id);
    seenCaseIds.add(fixtureCase.id);
    if (seenCoverageIds.has(fixtureCase.coverage)) duplicateCoverageIds.add(fixtureCase.coverage);
    seenCoverageIds.add(fixtureCase.coverage);

    for (const dimension of ISSUE_ENRICHMENT_SCORE_DIMENSIONS) {
      const score = fixtureCase.dimensions[dimension.id];
      if (!score) {
        errors.push(`case ${fixtureCase.id} missing dimension ${dimension.id}`);
        continue;
      }
      if (score.unmeasurable) {
        if (!score.unmeasurableReason?.trim()) {
          errors.push(`case ${fixtureCase.id} dimension ${dimension.id} missing unmeasurableReason`);
        }
        continue;
      }
      if (!Number.isFinite(score.score) || score.score! < 0 || score.score! > 5) {
        errors.push(`case ${fixtureCase.id} dimension ${dimension.id} score must be between 0 and 5`);
      }
      if ((score.score ?? 0) > 3 && !hasDirectEvidenceLink(score.evidenceLinks, fixtureCase, dimension.id)) {
        errors.push(`case ${fixtureCase.id} dimension ${dimension.id} scored ${score.score} without direct evidence links`);
      }
    }
  }

  for (const caseId of [...duplicateCaseIds].sort()) {
    errors.push(`duplicate fixture case id ${caseId}`);
  }

  for (const coverageId of [...duplicateCoverageIds].sort()) {
    errors.push(`duplicate fixture coverage ${coverageId}`);
  }

  return { ok: errors.length === 0, errors, coveredScenarioIds };
}

export function summarizeIssueEnrichmentScorecard(result: IssueEnrichmentScorecardResult): string {
  const lines = [
    `Issue enrichment scorecard: raw ${result.rawScore}/100, weighted ${result.weightedScore}/100`,
    `Public claim: ${result.publicClaim}`,
    `Calibration: ${result.calibration}`,
    `Unmeasurable dimensions: ${result.unmeasurableStates.length ? result.unmeasurableStates.join(", ") : "none"}`,
    `Pilot threshold misses: ${result.pilotThresholdMisses.length ? result.pilotThresholdMisses.join(", ") : "none"}`
  ];
  return `${lines.join("\n")}\n`;
}

function dimension(
  id: IssueEnrichmentScoreDimensionId,
  label: string,
  weight: number,
  metricContract: IssueEnrichmentMetricContract
): IssueEnrichmentScoreDimension {
  return { id, label, weight, metricContract };
}

function scoreDimension(
  packet: IssueEnrichmentFixturePacket,
  dimension: IssueEnrichmentScoreDimension
): IssueEnrichmentDimensionScore {
  const measuredScores: number[] = [];
  const unmeasurableCases: string[] = [];
  const pilotThresholdMisses: string[] = [];
  const evidenceLinks = new Set<string>();
  const threshold = DIMENSIONS_BY_ID.get(dimension.id)?.metricContract.pilotThreshold.advisoryMin ?? 0;

  for (const fixtureCase of packet.cases) {
    const score = fixtureCase.dimensions[dimension.id];
    if (!score) continue;
    for (const link of score.evidenceLinks ?? []) evidenceLinks.add(link);
    if (score.unmeasurable) {
      unmeasurableCases.push(fixtureCase.id);
      continue;
    }
    const numericScore = normalizeScore(score.score);
    measuredScores.push(numericScore);
    if (numericScore < threshold) pilotThresholdMisses.push(fixtureCase.id);
  }

  const averageScore = measuredScores.length
    ? measuredScores.reduce((sum, score) => sum + score, 0) / measuredScores.length
    : 0;

  return {
    id: dimension.id,
    label: dimension.label,
    score: round(averageScore, 2),
    weight: dimension.weight,
    rawScore: averageScore,
    weightedContribution: round(averageScore * dimension.weight, 2),
    measuredCases: measuredScores.length,
    unmeasurableCases,
    pilotThresholdMisses,
    evidenceLinks: [...evidenceLinks].sort()
  };
}

function normalizeScore(score: number | undefined): number {
  if (score === undefined || !Number.isFinite(score)) return 0;
  return Math.min(5, Math.max(0, score));
}

function hasDirectEvidenceLink(
  links: string[] | undefined,
  fixtureCase: IssueEnrichmentFixtureCase,
  dimensionId: IssueEnrichmentScoreDimensionId
): boolean {
  const expectedAnchor = `direct-evidence-${fixtureCase.id.replaceAll("_", "-")}-${dimensionId.replaceAll("_", "-")}`;
  const source = parseHttpsUrl(fixtureCase.fixtureSource);
  if (!source) return false;

  return (links ?? []).some((link) => {
    const url = parseHttpsUrl(link);
    if (!url) return false;
    return url.host === source.host && url.pathname === source.pathname && url.hash.slice(1) === expectedAnchor;
  });
}

function parseHttpsUrl(value: string | undefined): URL | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

function percent(value: number, max: number): number {
  return Math.round((value / max) * 100);
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}
