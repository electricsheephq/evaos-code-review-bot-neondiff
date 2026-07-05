import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ISSUE_ENRICHMENT_REQUIRED_FIXTURE_COVERAGE,
  ISSUE_ENRICHMENT_SCORE_DIMENSIONS,
  scoreIssueEnrichment,
  summarizeIssueEnrichmentScorecard,
  validateIssueEnrichmentFixture,
  type IssueEnrichmentFixturePacket
} from "../src/issue-enrichment-scorecard.js";

const fixturePath = join("tests", "fixtures", "issue-enrichment-scorecard", "sampled-regression-packet.json");

function loadFixture(): IssueEnrichmentFixturePacket {
  return JSON.parse(readFileSync(fixturePath, "utf8")) as IssueEnrichmentFixturePacket;
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

    expect(result.rawScore).toBeGreaterThanOrEqual(75);
    expect(result.rawScore).toBeLessThanOrEqual(85);
    expect(result.weightedScore).toBeGreaterThanOrEqual(75);
    expect(result.weightedScore).toBeLessThanOrEqual(85);
    expect(result.weightedScore).not.toBe(result.rawScore);
    expect(result.publicClaim).toBe("no_public_claim");
    expect(result.calibration).toBe("uncalibrated");
    expect(result).not.toHaveProperty("publicParity");
    expect(result).not.toHaveProperty("calibratedConfidence");
    expect(result.dimensionScores.find((dimension) => dimension.id === "proof_boundary")).toMatchObject({
      score: 5,
      weightedContribution: expect.any(Number),
      evidenceLinks: [
        "https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/264#direct-evidence-docs-only-fast-negative-control-proof-boundary",
        "https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/264#direct-evidence-duplicate-same-head-comments-proof-boundary",
        "https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/264#direct-evidence-external-precedent-required-issue-proof-boundary",
        "https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/264#direct-evidence-invalid-inline-coordinates-proof-boundary",
        "https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/264#direct-evidence-issue-enrichment-permission-failure-proof-boundary",
        "https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/264#direct-evidence-launchd-config-head-ambiguity-proof-boundary",
        "https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/264#direct-evidence-old-backlog-negative-control-proof-boundary",
        "https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/264#direct-evidence-provider-failure-burst-30-prs-proof-boundary",
        "https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/264#direct-evidence-stale-head-posts-proof-boundary",
        "https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/264#direct-evidence-stale-irrelevant-web-result-proof-boundary"
      ]
    });

    const proofBoundary = result.dimensionScores.find((dimension) => dimension.id === "proof_boundary");
    expect(proofBoundary?.weightedContribution).toBeGreaterThan(proofBoundary?.score ?? 0);
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

  it("summarizes scorecard results with unmeasurable states and pilot threshold misses", () => {
    const summary = summarizeIssueEnrichmentScorecard(scoreIssueEnrichment(loadFixture()));

    expect(summary).toMatch(/Issue enrichment scorecard: raw \d+\/100, weighted \d+\/100/);
    expect(summary).toContain("Public claim: no_public_claim");
    expect(summary).toContain("Unmeasurable dimensions: external_precedent_required_issue:related_context_precision");
    expect(summary).toContain("stale_irrelevant_web_result:related_context_precision");
    expect(summary).toContain("provider_failure_burst_30_prs:throttling");
    expect(summary).not.toMatch(/parity|calibrated confidence|95/i);
  });

  it.each([
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
