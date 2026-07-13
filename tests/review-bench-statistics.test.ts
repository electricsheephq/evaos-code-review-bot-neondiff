import { describe, expect, it } from "vitest";
import {
  analyzePairedReviewBench,
  computePairedReviewBenchCohortHash,
  type PairedReviewBenchAnalysisInputV1,
  type PairedReviewBenchObservationV1
} from "../src/review-bench-statistics.js";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const SHA_D = "d".repeat(64);
const LANGUAGES = ["TypeScript", "JavaScript", "Python", "Go", "Rust", "Java"] as const;
const EXPECTED_STRATA = Array.from({ length: 30 }, (_, index) => ({
  repository: `example/repository-${index % 10}`,
  language: LANGUAGES[index % LANGUAGES.length],
  minimumPrHeads: 2,
  minimumDefectPrHeads: 2
}));

function arm(overrides: Partial<PairedReviewBenchObservationV1["candidate"]> = {}) {
  return {
    evidenceSha256: SHA_B,
    findingCount: 1,
    truePositive: 1,
    falsePositive: 0,
    falseNegative: 0,
    p0p1FalseNegative: 0,
    schemaFailures: 0,
    secretFindings: 0,
    duplicatePolicyViolations: 0,
    ...overrides
  };
}

function observation(
  index: number,
  overrides: Partial<PairedReviewBenchObservationV1> = {}
): PairedReviewBenchObservationV1 {
  return {
    schemaVersion: "review-bench-paired-observation/v1",
    observationId: `observation-${index}`,
    corpusScenarioId: `scenario-${index}`,
    repository: `example/repository-${index % 10}`,
    pullNumber: index + 1,
    headSha: index.toString(16).padStart(40, "0"),
    language: LANGUAGES[index % LANGUAGES.length],
    bugFamily: "runtime_correctness",
    artifactSemantics: "defect_present",
    adjudication: {
      status: "complete",
      evidenceSha256: SHA_C,
      blindedToProviderIdentity: true,
      unresolvedNearMisses: 0
    },
    candidate: arm(),
    baseline: arm({ evidenceSha256: SHA_D }),
    ...overrides
  };
}

function input(
  observations: PairedReviewBenchObservationV1[],
  overrides: Partial<PairedReviewBenchAnalysisInputV1> = {}
): PairedReviewBenchAnalysisInputV1 {
  const expectedCohort = overrides.expectedCohort ?? observations.map((item, index) => ({
    corpusScenarioId: item.corpusScenarioId,
    analysisOrder: index + 1,
    repository: item.repository,
    pullNumber: item.pullNumber,
    headSha: item.headSha,
    language: item.language,
    bugFamily: item.bugFamily,
    artifactSemantics: item.artifactSemantics
  }));
  return {
    schemaVersion: "review-bench-paired-analysis-input/v1",
    analysisVersion: "review-bench-paired-analysis/v1",
    corpusHash: SHA_A,
    matcherVersion: "review-bench-matcher/v1",
    candidateTargetFingerprint: SHA_B,
    baselineTargetFingerprint: SHA_C,
    candidateMatcherFingerprint: SHA_C,
    baselineMatcherFingerprint: SHA_D,
    adjudicationVersion: "review-bench-adjudication/v1",
    cohortManifestSha256: overrides.cohortManifestSha256
      ?? computePairedReviewBenchCohortHash(expectedCohort),
    expectedCohort,
    expectedStrata: EXPECTED_STRATA,
    look: { label: "final", fraction: 1 },
    variancePilot: {
      pairedPrHeads: 30,
      defectPrHeads: 25,
      precisionPairedPrSd: 0.2,
      recallPairedPrSd: 0.2,
      evidenceSha256: SHA_B
    },
    bootstrap: {
      method: "stratified-paired-pr-cluster-percentile/v1",
      resamples: 1_000,
      seed: 545
    },
    observations,
    ...overrides
  };
}

describe("paired Review Bench promotion statistics", () => {
  it("promotes only from complete powered macro-PR evidence and emits immutable method identity", () => {
    const result = analyzePairedReviewBench(input(
      Array.from({ length: 201 }, (_, index) => index < 126
        ? observation(index)
        : observation(index, {
            artifactSemantics: "verified_clean",
            candidate: arm({ findingCount: 0, truePositive: 0 }),
            baseline: arm({ evidenceSha256: SHA_D, findingCount: 0, truePositive: 0 })
          }))
    ));

    expect(result.decision).toBe("promote");
    expect(result.sampleSize).toMatchObject({
      uniquePrHeads: 201,
      defectPrHeads: 126,
      cleanPrHeads: 75,
      requiredUniquePrHeads: 150,
      poweredPrecisionN: 126,
      poweredRecallN: 126
    });
    expect(result.metrics.macroPr).toMatchObject({
      candidatePrecision: 1,
      baselinePrecision: 1,
      precisionDifference: 0,
      candidateRecall: 1,
      baselineRecall: 1,
      recallDifference: 0
    });
    expect(result.intervals.precisionDifference.lower).toBe(0);
    expect(result.intervals.candidatePrecision.lower).toBe(1);
    expect(result.method).toMatchObject({
      confidenceLevel: 0.95,
      oneSidedAlpha: 0.025,
      alphaSpendingVersion: "final-only-obf-data-quality-looks/v1",
      bootstrapMethod: "stratified-paired-pr-cluster-percentile/v1"
    });
    expect(result.bindings).toEqual({
      corpusHash: SHA_A,
      matcherVersion: "review-bench-matcher/v1",
      candidateTargetFingerprint: SHA_B,
      baselineTargetFingerprint: SHA_C,
      candidateMatcherFingerprint: SHA_C,
      baselineMatcherFingerprint: SHA_D,
      adjudicationVersion: "review-bench-adjudication/v1",
      cohortManifestSha256: expect.stringMatching(/^[a-f0-9]{64}$/)
    });
    expect(result.sampleSize).toMatchObject({ repositories: 10, languages: 6, repositoryLanguageStrata: 30 });
    expect(result.inputSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.analysisSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("excludes verified-clean PRs from recall so silence cannot win through precision", () => {
    const observations = Array.from({ length: 150 }, (_, index) => observation(index, index < 60
      ? {
          candidate: arm({ findingCount: 0, truePositive: 0, falseNegative: 1 }),
          baseline: arm()
        }
      : {
          artifactSemantics: "verified_clean",
          candidate: arm({ findingCount: 0, truePositive: 0, falseNegative: 0 }),
          baseline: arm({ evidenceSha256: SHA_D, findingCount: 0, truePositive: 0, falseNegative: 0 })
        }
    ));

    const result = analyzePairedReviewBench(input(observations, {
      variancePilot: {
        pairedPrHeads: 30,
        defectPrHeads: 25,
        precisionPairedPrSd: 0,
        recallPairedPrSd: 0,
        evidenceSha256: SHA_B
      }
    }));

    expect(result.metrics.macroPr.candidatePrecision).toBe(1);
    expect(result.metrics.macroPr.candidateRecall).toBe(0);
    expect(result.metrics.macroPr.baselineRecall).toBe(1);
    expect(result.sampleSize.defectPrHeads).toBe(60);
    expect(result.sampleSize.requiredDefectPrHeads).toBe(125);
    expect(result.gates).toContainEqual(expect.objectContaining({ name: "recall_noninferiority", passed: false }));
    expect(result.decision).not.toBe("promote");
  });

  it("weights PR clusters rather than allowing a large correlated finding cluster to dominate recall", () => {
    const observations = Array.from({ length: 150 }, (_, index) => observation(index, index === 0
      ? {
          candidate: arm({ findingCount: 1_000, truePositive: 1_000 }),
          baseline: arm({ evidenceSha256: SHA_D, findingCount: 1_000, truePositive: 1_000 })
        }
      : {
          candidate: arm({ findingCount: 0, truePositive: 0, falseNegative: 1 }),
          baseline: arm()
        }
    ));

    const result = analyzePairedReviewBench(input(observations));

    expect(result.metrics.pooledFinding.candidateRecall).toBeGreaterThan(0.85);
    expect(result.metrics.macroPr.candidateRecall).toBeCloseTo(1 / 150, 8);
    expect(result.decision).toBe("do_not_promote");
  });

  it("measures planned-look completion in sealed observations while keeping power at unique PR heads", () => {
    const observations = Array.from({ length: 75 }, (_, index) => {
      const base = observation(index);
      return [
        {
          ...base,
          observationId: `observation-${index}-runtime`,
          corpusScenarioId: `scenario-${index}-runtime`
        },
        {
          ...base,
          observationId: `observation-${index}-auth`,
          corpusScenarioId: `scenario-${index}-auth`,
          bugFamily: "auth" as const
        }
      ];
    }).flat();

    const result = analyzePairedReviewBench(input(observations));
    expect(result.gates).toContainEqual(expect.objectContaining({ name: "planned_look_sample", passed: true }));
    expect(result.gates).toContainEqual(expect.objectContaining({ name: "powered_unique_pr_heads", passed: false }));
    expect(result.decision).toBe("insufficient_evidence");
  });

  it("uses strict noninferiority bounds but an inclusive absolute precision floor", () => {
    const onMargin = analyzePairedReviewBench(input(Array.from(
      { length: 150 },
      (_, index) => observation(index, {
        candidate: arm({ findingCount: 19, truePositive: 19, falseNegative: 1 }),
        baseline: arm({ evidenceSha256: SHA_D, findingCount: 20, truePositive: 20 })
      })
    )));
    expect(onMargin.intervals.recallDifference.lower).toBeCloseTo(-0.05, 12);
    expect(onMargin.gates).toContainEqual(expect.objectContaining({ name: "recall_noninferiority", passed: false }));
    expect(onMargin.decision).toBe("do_not_promote");

    const onAbsoluteFloor = analyzePairedReviewBench(input(Array.from(
      { length: 150 },
      (_, index) => observation(index, {
        candidate: arm({ findingCount: 5, truePositive: 4, falsePositive: 1 }),
        baseline: arm({ evidenceSha256: SHA_D, findingCount: 5, truePositive: 4, falsePositive: 1 })
      })
    )));
    expect(onAbsoluteFloor.intervals.candidatePrecision.lower).toBeCloseTo(0.8, 12);
    expect(onAbsoluteFloor.gates).toContainEqual(expect.objectContaining({ name: "candidate_absolute_precision", passed: true }));
  });

  it("rejects duplicate repository, PR, head, and bug-family observations even when IDs differ", () => {
    const first = observation(0);
    expect(() => analyzePairedReviewBench(input([
      first,
      { ...first, observationId: "different-run-like-id", corpusScenarioId: "different-scenario" }
    ]))).toThrow("duplicate repository/PR/head/bug-family");

    expect(() => analyzePairedReviewBench(input([
      observation(0),
      observation(1, { observationId: observation(0).observationId })
    ]))).toThrow("duplicate observationId");

    expect(() => analyzePairedReviewBench(input([
      observation(0),
      observation(1, { corpusScenarioId: observation(0).corpusScenarioId })
    ]))).toThrow("duplicate corpusScenarioId");
  });

  it("rejects missing strata, partial adjudication, and provider or confidence-bin metadata", () => {
    expect(() => analyzePairedReviewBench(input([
      { ...observation(0), language: "" as PairedReviewBenchObservationV1["language"] }
    ]))).toThrow("language");

    expect(() => analyzePairedReviewBench(input([
      {
        ...observation(0),
        adjudication: {
          ...observation(0).adjudication,
          status: "partial" as "complete"
        }
      }
    ]))).toThrow("adjudication status");

    expect(() => analyzePairedReviewBench(input([{
      ...observation(0),
      adjudication: {
        ...observation(0).adjudication,
        blindedToProviderIdentity: false as true
      }
    }]))).toThrow("blindedToProviderIdentity");

    expect(() => analyzePairedReviewBench(input([{
      ...observation(0),
      adjudication: {
        ...observation(0).adjudication,
        unresolvedNearMisses: 1 as 0
      }
    }]))).toThrow("unresolvedNearMisses");

    expect(() => analyzePairedReviewBench({
      ...input([observation(0)]),
      providerId: "hidden-model-provider"
    } as PairedReviewBenchAnalysisInputV1)).toThrow("unknown analysis input field");

    expect(() => analyzePairedReviewBench({
      ...input([observation(0)]),
      confidenceBins: [{ precision: 1 }]
    } as PairedReviewBenchAnalysisInputV1)).toThrow("unknown analysis input field");

    expect(() => analyzePairedReviewBench(input([observation(0)], {
      baselineTargetFingerprint: SHA_B
    }))).toThrow("must differ");

    expect(() => analyzePairedReviewBench(input([observation(0)], {
      baselineMatcherFingerprint: SHA_C
    }))).toThrow("must differ");
  });

  it("never promotes at the 50% or 75% data-quality looks", () => {
    const finalCohort = Array.from({ length: 150 }, (_, index) => observation(index));
    const sealed = input(finalCohort);
    for (const look of [
      { label: "50_percent" as const, fraction: 0.5 as const },
      { label: "75_percent" as const, fraction: 0.75 as const }
    ]) {
      const count = look.fraction === 0.5 ? 75 : 113;
      const result = analyzePairedReviewBench(input(
        finalCohort.slice(0, count),
        {
          look,
          expectedCohort: sealed.expectedCohort,
          cohortManifestSha256: sealed.cohortManifestSha256
        }
      ));
      expect(result.decision).toBe("interim_continue");
      expect(result.gates).toContainEqual(expect.objectContaining({ name: "final_look", passed: false }));
    }
  });

  it("stops an interim lane immediately on an acceptance-set safety failure", () => {
    const finalCohort = Array.from({ length: 150 }, (_, index) => observation(index));
    const sealed = input(finalCohort);
    const observations = finalCohort.slice(0, 75);
    observations[0] = observation(0, { candidate: arm({ schemaFailures: 1 }) });
    const result = analyzePairedReviewBench(input(observations, {
      look: { label: "50_percent", fraction: 0.5 },
      expectedCohort: sealed.expectedCohort,
      cohortManifestSha256: sealed.cohortManifestSha256
    }));

    expect(result.decision).toBe("stop_for_safety");

    const belowLook = finalCohort.slice(0, 60);
    belowLook[0] = observation(0, { candidate: arm({ secretFindings: 1 }) });
    expect(analyzePairedReviewBench(input(belowLook, {
      look: { label: "50_percent", fraction: 0.5 },
      expectedCohort: sealed.expectedCohort,
      cohortManifestSha256: sealed.cohortManifestSha256
    })).decision).toBe("stop_for_safety");
  });

  it("requires the frozen expected strata and at least two PR clusters per stratum", () => {
    const observations = Array.from({ length: 150 }, (_, index) => observation(index));
    expect(() => analyzePairedReviewBench(input(observations, {
      expectedStrata: EXPECTED_STRATA.slice(1)
    }))).toThrow("unexpected repository/language stratum");

    expect(() => analyzePairedReviewBench(input(observations, {
      expectedStrata: EXPECTED_STRATA.map((stratum, index) => index === 0
        ? { ...stratum, minimumPrHeads: 1 }
        : stratum)
    }))).toThrow("minimumPrHeads must be at least 2");

    expect(() => analyzePairedReviewBench(input(observations, {
      expectedStrata: EXPECTED_STRATA.map((stratum, index) => index === 0
        ? { ...stratum, minimumDefectPrHeads: 1 }
        : stratum)
    }))).toThrow("minimumDefectPrHeads must be at least 2");
  });

  it("requires the exact sealed cohort rather than accepting a powered outcome-selected subset", () => {
    const complete = Array.from({ length: 150 }, (_, index) => observation(index));
    const completeInput = input(complete);
    expect(analyzePairedReviewBench(input(complete.slice(0, 149), {
      expectedCohort: completeInput.expectedCohort,
      cohortManifestSha256: completeInput.cohortManifestSha256
    })).decision).toBe("insufficient_evidence");

    expect(() => analyzePairedReviewBench(input(complete.slice(0, 75), {
      look: { label: "50_percent", fraction: 0.5 }
    }))).toThrow("planned look must use one frozen final cohort");

    const futureDuplicate = completeInput.expectedCohort.map((entry, index) => index === 149
      ? {
          ...entry,
          repository: completeInput.expectedCohort[0]!.repository,
          pullNumber: completeInput.expectedCohort[0]!.pullNumber,
          headSha: completeInput.expectedCohort[0]!.headSha,
          language: completeInput.expectedCohort[0]!.language,
          bugFamily: completeInput.expectedCohort[0]!.bugFamily,
          artifactSemantics: completeInput.expectedCohort[0]!.artifactSemantics
        }
      : entry);
    expect(() => analyzePairedReviewBench(input(complete.slice(0, 75), {
      look: { label: "50_percent", fraction: 0.5 },
      expectedCohort: futureDuplicate,
      cohortManifestSha256: computePairedReviewBenchCohortHash(futureDuplicate)
    }))).toThrow("duplicate repository/PR/head/bug-family in expectedCohort");

    expect(() => analyzePairedReviewBench(input(complete, {
      cohortManifestSha256: SHA_D
    }))).toThrow("cohortManifestSha256");
  });

  it("fails closed below powered sample size and on acceptance-set safety failures", () => {
    const insufficient = analyzePairedReviewBench(input(
      Array.from({ length: 149 }, (_, index) => observation(index))
    ));
    expect(insufficient.decision).toBe("insufficient_evidence");

    const unsafe = Array.from({ length: 150 }, (_, index) => observation(index));
    unsafe[0] = observation(0, {
      candidate: arm({ secretFindings: 1 })
    });
    const unsafeResult = analyzePairedReviewBench(input(unsafe));
    expect(unsafeResult.decision).toBe("stop_for_safety");
    expect(unsafeResult.gates).toContainEqual(expect.objectContaining({ name: "acceptance_set_safety", passed: false }));

    const invalidBaseline = Array.from({ length: 150 }, (_, index) => observation(index));
    invalidBaseline[0] = observation(0, {
      baseline: arm({ evidenceSha256: SHA_D, schemaFailures: 1 })
    });
    expect(analyzePairedReviewBench(input(invalidBaseline)).decision).toBe("stop_for_safety");
  });

  it("rejects aggregate count overflow instead of silently rounding immutable evidence", () => {
    const observations = Array.from({ length: 150 }, (_, index) => observation(index));
    for (const index of [0, 30]) {
      observations[index] = observation(index, {
        candidate: arm({ findingCount: Number.MAX_SAFE_INTEGER, truePositive: Number.MAX_SAFE_INTEGER }),
        baseline: arm({
          evidenceSha256: SHA_D,
          findingCount: Number.MAX_SAFE_INTEGER,
          truePositive: Number.MAX_SAFE_INTEGER
        })
      });
    }
    expect(() => analyzePairedReviewBench(input(observations))).toThrow("aggregate count exceeds safe integer range");
  });
});
