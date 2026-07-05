import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ISSUE_ENRICHMENT_REQUIRED_FIXTURE_COVERAGE,
  ISSUE_ENRICHMENT_SCORE_DIMENSIONS,
  scoreIssueEnrichment,
  summarizeIssueEnrichmentScorecard,
  validateIssueEnrichmentFixture,
  type IssueEnrichmentDimensionFixtureScore,
  type IssueEnrichmentFixturePacket
} from "../src/issue-enrichment-scorecard.js";

const fixturePath = join("tests", "fixtures", "issue-enrichment-scorecard", "sampled-regression-packet.json");

function loadFixture(): IssueEnrichmentFixturePacket {
  return JSON.parse(readFileSync(fixturePath, "utf8")) as IssueEnrichmentFixturePacket;
}

function expectedTopLevelScores(fixture: IssueEnrichmentFixturePacket): { rawScore: number; weightedScore: number } {
  const measuredDimensions = ISSUE_ENRICHMENT_SCORE_DIMENSIONS.flatMap((dimension) => {
    const scores = fixture.cases
      .map((fixtureCase) => fixtureCase.dimensions?.[dimension.id])
      .filter((score): score is IssueEnrichmentDimensionFixtureScore => Boolean(score) && !score.unmeasurable)
      .map((score) => score.score ?? 0);

    if (!scores.length) return [];
    const averageScore = scores.reduce((sum, score) => sum + score, 0) / scores.length;
    return [
      {
        rawScore: averageScore,
        weightedContribution: averageScore * dimension.weight,
        maxWeightedScore: dimension.weight * 5
      }
    ];
  });

  return {
    rawScore: Math.round(
      (measuredDimensions.reduce((sum, dimension) => sum + dimension.rawScore, 0) / (measuredDimensions.length * 5)) *
        100
    ),
    weightedScore: Math.round(
      (measuredDimensions.reduce((sum, dimension) => sum + dimension.weightedContribution, 0) /
        measuredDimensions.reduce((sum, dimension) => sum + dimension.maxWeightedScore, 0)) *
        100
    )
  };
}

describe("issue enrichment scorecard", () => {
  it("defines every required issue-enrichment dimension with executable metric contracts", () => {
    expect(ISSUE_ENRICHMENT_SCORE_DIMENSIONS.map((dimension) => dimension.id)).toEqual([
      "related_context_precision",
      "planning_value",
      "acceptance_criteria",
      "ownership_routing",
      "proof_boundary",
      "lifecycle_state",
      "noise_control",
      "idempotency",
      "safety",
      "throttling"
    ]);
    expect(ISSUE_ENRICHMENT_SCORE_DIMENSIONS.map(({ id, weight }) => ({ id, weight }))).toEqual([
      { id: "related_context_precision", weight: 12 },
      { id: "planning_value", weight: 11 },
      { id: "acceptance_criteria", weight: 12 },
      { id: "ownership_routing", weight: 9 },
      { id: "proof_boundary", weight: 13 },
      { id: "lifecycle_state", weight: 8 },
      { id: "noise_control", weight: 10 },
      { id: "idempotency", weight: 9 },
      { id: "safety", weight: 11 },
      { id: "throttling", weight: 15 }
    ]);
    expect(new Set(ISSUE_ENRICHMENT_SCORE_DIMENSIONS.map((dimension) => dimension.weight)).size).toBeGreaterThan(1);

    for (const dimension of ISSUE_ENRICHMENT_SCORE_DIMENSIONS) {
      expect(dimension.metricContract).toMatchObject({
        denominator: expect.any(String),
        dataSource: expect.any(String),
        scoringRule: expect.any(String),
        unmeasurableState: expect.any(String),
        pilotThreshold: {
          advisoryMin: expect.any(Number),
          promotionMin: expect.any(Number)
        }
      });
    }
  });

  it("scores fixture packets with separate raw and weighted scores without public parity or calibrated-confidence claims", () => {
    const fixture = loadFixture();
    const result = scoreIssueEnrichment(fixture);
    const expectedScores = expectedTopLevelScores(fixture);

    expect(result.rawScore).toBe(expectedScores.rawScore);
    expect(result.weightedScore).toBe(expectedScores.weightedScore);
    expect(result.weightedScore).not.toBe(result.rawScore);
    expect(result.publicClaim).toBe("no_public_claim");
    expect(result.calibration).toBe("uncalibrated");
    expect(result).not.toHaveProperty("publicParity");
    expect(result).not.toHaveProperty("calibratedConfidence");
    const proofBoundary = result.dimensionScores.find((dimension) => dimension.id === "proof_boundary");
    expect(proofBoundary).toMatchObject({
      score: 5,
      weightedContribution: expect.any(Number)
    });
    expect(proofBoundary?.evidenceLinks).toHaveLength(fixture.cases.length);
    for (const link of proofBoundary?.evidenceLinks ?? []) {
      expect(link).toMatch(
        /^https:\/\/github\.com\/electricsheephq\/evaos-code-review-bot-neondiff\/issues\/264#direct-evidence-[a-z0-9-]+-proof-boundary$/
      );
    }
    const proofBoundaryConfig = ISSUE_ENRICHMENT_SCORE_DIMENSIONS.find((dimension) => dimension.id === "proof_boundary");
    expect(proofBoundary?.weightedContribution).toBeCloseTo(
      (proofBoundary?.score ?? 0) * (proofBoundaryConfig?.weight ?? 0),
      2
    );
  });

  it("requires direct evidence links for every dimension score above 3", () => {
    const fixture = loadFixture();
    fixture.cases[0].dimensions.proof_boundary = {
      score: 4,
      notes: "High score without a direct link must fail validation."
    };

    expect(validateIssueEnrichmentFixture(fixture)).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        "case duplicate-same-head-comments dimension proof_boundary scored 4 without direct evidence links"
      ])
    });
  });

  it("documents the strict high-score evidence boundary at scores above 3", () => {
    const exactlyThree = loadFixture();
    exactlyThree.cases[0].dimensions.proof_boundary = {
      score: 3,
      notes: "Exactly 3 is useful but incomplete and does not require direct evidence."
    };

    expect(validateIssueEnrichmentFixture(exactlyThree).ok).toBe(true);

    const aboveThree = loadFixture();
    aboveThree.cases[0].dimensions.proof_boundary = {
      score: 3.01,
      notes: "Scores above 3 require a direct evidence link."
    };

    expect(validateIssueEnrichmentFixture(aboveThree)).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        "case duplicate-same-head-comments dimension proof_boundary scored 3.01 without direct evidence links"
      ])
    });
  });

  it("rejects generic parent issue URLs for high scores even when they are valid http links", () => {
    const fixture = loadFixture();
    fixture.cases[0].dimensions.proof_boundary = {
      score: 4,
      evidenceLinks: ["https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/264"]
    };

    expect(validateIssueEnrichmentFixture(fixture)).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        "case duplicate-same-head-comments dimension proof_boundary scored 4 without direct evidence links"
      ])
    });
  });

  it("rejects direct-evidence anchors that do not point at the fixture source issue", () => {
    const fixture = loadFixture();
    fixture.cases[0].dimensions.proof_boundary = {
      score: 4,
      evidenceLinks: ["https://example.com/evidence#direct-evidence-duplicate-same-head-comments-proof-boundary"]
    };

    expect(validateIssueEnrichmentFixture(fixture)).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        "case duplicate-same-head-comments dimension proof_boundary scored 4 without direct evidence links"
      ])
    });
  });

  it("rejects direct-evidence anchors with a query string that differs from the fixture source issue", () => {
    const fixture = loadFixture();
    fixture.cases[0].dimensions.proof_boundary = {
      score: 4,
      evidenceLinks: [
        "https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/264?query=x#direct-evidence-duplicate-same-head-comments-proof-boundary"
      ]
    };

    expect(validateIssueEnrichmentFixture(fixture)).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        "case duplicate-same-head-comments dimension proof_boundary scored 4 without direct evidence links"
      ])
    });
  });

  it("does not emit a redundant missing-evidence error for an out-of-range high score", () => {
    const fixture = loadFixture();
    fixture.cases[0].dimensions.proof_boundary = {
      score: 6,
      evidenceLinks: ["https://example.com/evidence#direct-evidence-duplicate-same-head-comments-proof-boundary"]
    };

    const validation = validateIssueEnrichmentFixture(fixture);

    expect(validation.ok).toBe(false);
    expect(validation.errors).toContain("case duplicate-same-head-comments dimension proof_boundary score must be between 0 and 5");
    expect(validation.errors).not.toContain(
      "case duplicate-same-head-comments dimension proof_boundary scored 6 without direct evidence links"
    );
  });

  it("refuses to score invalid fixture packets instead of silently clamping invalid scores", () => {
    const fixture = loadFixture();
    fixture.cases[0].dimensions.proof_boundary = {
      score: 99,
      evidenceLinks: [
        "https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/264#direct-evidence-duplicate-same-head-comments-proof-boundary"
      ]
    };

    expect(() => scoreIssueEnrichment(fixture)).toThrow(
      "Cannot score invalid issue-enrichment fixture: case duplicate-same-head-comments dimension proof_boundary score must be between 0 and 5"
    );
  });

  it("rejects duplicate fixture case ids and duplicate coverage ids", () => {
    const fixture = loadFixture();
    fixture.cases.push({
      ...fixture.cases[0],
      title: "Duplicate coverage and id"
    });

    expect(validateIssueEnrichmentFixture(fixture)).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        "duplicate fixture case id duplicate-same-head-comments",
        "duplicate fixture coverage duplicate_same_head_comments"
      ])
    });
  });

  it("validates proof boundary, known limitations, and the required sampled regression coverage", () => {
    const fixture = loadFixture();
    const validation = validateIssueEnrichmentFixture(fixture);

    expect(validation.ok).toBe(true);
    expect(validation.coveredScenarioIds).toEqual(ISSUE_ENRICHMENT_REQUIRED_FIXTURE_COVERAGE);
    expect(fixture.proofBoundary).toContain("advisory fixture scoring only");
    expect(fixture.knownLimitations.length).toBeGreaterThanOrEqual(3);
  });

  it("uses packet metric-contract threshold overrides when scoring pilot misses", () => {
    const fixture = loadFixture();
    const throttlingContract = ISSUE_ENRICHMENT_SCORE_DIMENSIONS.find((dimension) => dimension.id === "throttling")
      ?.metricContract;
    expect(throttlingContract).toBeDefined();

    expect(scoreIssueEnrichment(fixture).pilotThresholdMisses).not.toContain(
      "duplicate-same-head-comments:throttling"
    );

    fixture.metricContracts = {
      throttling: {
        ...throttlingContract!,
        pilotThreshold: {
          advisoryMin: 3,
          promotionMin: throttlingContract!.pilotThreshold.promotionMin
        }
      }
    };

    expect(scoreIssueEnrichment(fixture).pilotThresholdMisses).toContain("duplicate-same-head-comments:throttling");
  });

  it("excludes fully unmeasurable dimensions from top-level score denominators", () => {
    const fixture = loadFixture();
    const baseline = scoreIssueEnrichment(fixture);
    const throttlingConfig = ISSUE_ENRICHMENT_SCORE_DIMENSIONS.find((dimension) => dimension.id === "throttling");
    expect(throttlingConfig).toBeDefined();

    for (const fixtureCase of fixture.cases) {
      fixtureCase.dimensions.throttling = {
        unmeasurable: true,
        evidenceLinks: [
          `https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/264#direct-evidence-${fixtureCase.id}-throttling`
        ],
        unmeasurableReason: "Throttle budget data intentionally unavailable for denominator regression."
      };
    }

    const result = scoreIssueEnrichment(fixture);
    const measuredDimensions = result.dimensionScores.filter((dimension) => dimension.measuredCases > 0);
    const expectedRawScore = Math.round(
      (measuredDimensions.reduce((sum, dimension) => sum + dimension.rawScore, 0) / (measuredDimensions.length * 5)) *
        100
    );
    const expectedWeightedScore = Math.round(
      (measuredDimensions.reduce((sum, dimension) => sum + dimension.weightedContribution, 0) /
        measuredDimensions.reduce((sum, dimension) => sum + dimension.weight * 5, 0)) *
        100
    );

    const throttlingScore = result.dimensionScores.find((dimension) => dimension.id === "throttling");
    expect(throttlingScore).toMatchObject({
      measuredCases: 0,
      unmeasurableCases: fixture.cases.map((fixtureCase) => fixtureCase.id),
      evidenceLinks: []
    });
    expect(result.rawScore).toBe(expectedRawScore);
    expect(result.weightedScore).toBe(expectedWeightedScore);
    expect(result.weightedScore).toBeGreaterThanOrEqual(baseline.weightedScore);
    expect(result.pilotThresholdMisses.some((miss) => miss.endsWith(":throttling"))).toBe(false);
  });

  it("summarizes scorecard results with unmeasurable states and pilot threshold misses", () => {
    const summary = summarizeIssueEnrichmentScorecard(scoreIssueEnrichment(loadFixture()));
    const unmeasurableLine = summary
      .split("\n")
      .find((line) => line.startsWith("Unmeasurable dimensions:"));
    const pilotThresholdMissesLine = summary
      .split("\n")
      .find((line) => line.startsWith("Pilot threshold misses:"));

    expect(summary).toMatch(/Issue enrichment scorecard: raw \d+\/100, weighted \d+\/100/);
    expect(summary).toContain("Public claim: no_public_claim");
    expect(unmeasurableLine).toBe("Unmeasurable dimensions: external_precedent_required_issue:related_context_precision");
    expect(pilotThresholdMissesLine).toContain("stale_irrelevant_web_result:related_context_precision");
    expect(pilotThresholdMissesLine).toContain("provider_failure_burst_30_prs:throttling");
    expect(summary).not.toMatch(/parity|calibrated confidence|95/i);
  });

  it.each([
    {
      name: "unknown fixture version",
      mutate: (fixture: IssueEnrichmentFixturePacket) => {
        fixture.fixtureVersion = "9.9" as IssueEnrichmentFixturePacket["fixtureVersion"];
      },
      error: "fixture fixtureVersion must be 0.1"
    },
    {
      name: "empty proof boundary",
      mutate: (fixture: IssueEnrichmentFixturePacket) => {
        fixture.proofBoundary = "";
      },
      error: "fixture proofBoundary is required"
    },
    {
      name: "empty known limitations",
      mutate: (fixture: IssueEnrichmentFixturePacket) => {
        fixture.knownLimitations = [];
      },
      error: "fixture knownLimitations are required"
    },
    {
      name: "missing coverage",
      mutate: (fixture: IssueEnrichmentFixturePacket) => {
        fixture.cases = fixture.cases.filter((item) => item.coverage !== "stale_head_posts");
      },
      error: "missing required fixture coverage stale_head_posts"
    },
    {
      name: "missing case title",
      mutate: (fixture: IssueEnrichmentFixturePacket) => {
        fixture.cases[0].title = "";
      },
      error: "case duplicate-same-head-comments title is required"
    },
    {
      name: "missing fixture source",
      mutate: (fixture: IssueEnrichmentFixturePacket) => {
        fixture.cases[0].fixtureSource = undefined;
      },
      error: "case duplicate-same-head-comments fixtureSource must be an https URL"
    },
    {
      name: "non-https fixture source",
      mutate: (fixture: IssueEnrichmentFixturePacket) => {
        fixture.cases[0].fixtureSource = "http://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/264";
      },
      error: "case duplicate-same-head-comments fixtureSource must be an https URL"
    },
    {
      name: "unknown coverage",
      mutate: (fixture: IssueEnrichmentFixturePacket) => {
        fixture.cases[0].coverage = "typo_coverage" as IssueEnrichmentFixturePacket["cases"][number]["coverage"];
      },
      error: "case duplicate-same-head-comments has unknown coverage typo_coverage"
    },
    {
      name: "out-of-range score",
      mutate: (fixture: IssueEnrichmentFixturePacket) => {
        fixture.cases[0].dimensions.proof_boundary = {
          score: 6,
          evidenceLinks: ["https://example.com/evidence#direct-evidence-duplicate-same-head-comments-proof-boundary"]
        };
      },
      error: "case duplicate-same-head-comments dimension proof_boundary score must be between 0 and 5"
    },
    {
      name: "unmeasurable without reason",
      mutate: (fixture: IssueEnrichmentFixturePacket) => {
        fixture.cases[0].dimensions.proof_boundary = { unmeasurable: true };
      },
      error: "case duplicate-same-head-comments dimension proof_boundary missing unmeasurableReason"
    },
    {
      name: "missing dimension",
      mutate: (fixture: IssueEnrichmentFixturePacket) => {
        const { proof_boundary: _proofBoundary, ...dimensions } = fixture.cases[0].dimensions;
        fixture.cases[0].dimensions = dimensions as IssueEnrichmentFixturePacket["cases"][number]["dimensions"];
      },
      error: "case duplicate-same-head-comments missing dimension proof_boundary"
    },
    {
      name: "missing dimensions object",
      mutate: (fixture: IssueEnrichmentFixturePacket) => {
        fixture.cases[0].dimensions = undefined as unknown as IssueEnrichmentFixturePacket["cases"][number]["dimensions"];
      },
      error: "case duplicate-same-head-comments missing dimensions"
    },
    {
      name: "missing measured score",
      mutate: (fixture: IssueEnrichmentFixturePacket) => {
        fixture.cases[0].dimensions.proof_boundary = {
          notes: "Measured score omitted by fixture author."
        };
      },
      error: "case duplicate-same-head-comments dimension proof_boundary score is required"
    },
    {
      name: "missing metric threshold",
      mutate: (fixture: IssueEnrichmentFixturePacket) => {
        fixture.metricContracts = {
          proof_boundary: {
            denominator: "proof claims",
            dataSource: "fixture",
            scoringRule: "score proof boundary clarity",
            unmeasurableState: "no proof claim",
            pilotThreshold: {
              advisoryMin: Number.NaN,
              promotionMin: Number.NaN
            }
          }
        };
      },
      error: "dimension proof_boundary metric contract missing pilotThreshold.advisoryMin"
    },
    {
      name: "missing promotion threshold",
      mutate: (fixture: IssueEnrichmentFixturePacket) => {
        fixture.metricContracts = {
          proof_boundary: {
            denominator: "proof claims",
            dataSource: "fixture",
            scoringRule: "score proof boundary clarity",
            unmeasurableState: "no proof claim",
            pilotThreshold: {
              advisoryMin: 4,
              promotionMin: Number.NaN
            }
          }
        };
      },
      error: "dimension proof_boundary metric contract missing pilotThreshold.promotionMin"
    }
  ])("fails closed for invalid fixture packets: $name", ({ mutate, error }) => {
    const fixture = loadFixture();

    mutate(fixture);

    expect(validateIssueEnrichmentFixture(fixture)).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([error])
    });
  });
});
