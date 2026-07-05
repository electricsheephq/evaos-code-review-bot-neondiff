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

    expect(result.rawScore).toBe(81);
    expect(result.weightedScore).toBe(81);
    expect(result.publicClaim).toBe("no_public_claim");
    expect(result.calibration).toBe("uncalibrated");
    expect(result).not.toHaveProperty("publicParity");
    expect(result).not.toHaveProperty("calibratedConfidence");
    expect(result.dimensionScores.find((dimension) => dimension.id === "proof_boundary")).toMatchObject({
      score: 5,
      weightedScore: 50,
      evidenceLinks: ["https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/264"]
    });
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

  it("validates proof boundary, known limitations, and the required sampled regression coverage", () => {
    const fixture = loadFixture();
    const validation = validateIssueEnrichmentFixture(fixture);

    expect(validation.ok).toBe(true);
    expect(validation.coveredScenarioIds).toEqual(ISSUE_ENRICHMENT_REQUIRED_FIXTURE_COVERAGE);
    expect(fixture.proofBoundary).toContain("advisory fixture scoring only");
    expect(fixture.knownLimitations.length).toBeGreaterThanOrEqual(3);
  });

  it("summarizes scorecard results with unmeasurable states and pilot threshold misses", () => {
    const summary = summarizeIssueEnrichmentScorecard(scoreIssueEnrichment(loadFixture()));

    expect(summary).toContain("Issue enrichment scorecard: raw 81/100, weighted 81/100");
    expect(summary).toContain("Public claim: no_public_claim");
    expect(summary).toContain("Unmeasurable dimensions: external_precedent_required_issue:related_context_precision");
    expect(summary).toContain("Pilot threshold misses: stale_irrelevant_web_result:related_context_precision");
    expect(summary).not.toMatch(/parity|calibrated confidence|95/i);
  });
});
