import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ReviewBenchScenarioV1 } from "../src/review-bench-corpus.js";
import {
  bindReviewBenchLineAgreement,
  computeReviewBenchGoldLabelsSha256,
  computeReviewBenchAdjudicationAgreement,
  computeReviewBenchSemanticEvidenceSha256,
  serializeReviewBenchOracleEvidence,
  verifyReviewBenchOracleEvidence,
  type ReviewBenchOracleEvidenceV1
} from "../src/review-bench-semantic-evidence.js";

const COMPLETED_AT = "2026-07-12T00:00:00.000Z";
const RUBRIC_TEXT = "# review-bench-rubric/v1\nActionability and severity definitions.\n";
const PROTOCOL_TEXT = "# review-bench-adjudication-protocol/v1\nIndependent blinded adjudication.\n";

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function syntheticPemBoundary(): string {
  return ["-----BEGIN PRI", "VATE KEY-----"].join("");
}

function scenario(input: {
  control?: boolean;
  agreement?: "agree" | "reconciled";
} = {}): ReviewBenchScenarioV1 {
  const control = input.control ?? false;
  const agreement = input.agreement ?? "agree";
  const sourceRevision = "a".repeat(40);
  const sourceArtifactSha256 = "b".repeat(64);
  return {
    schemaVersion: "review-bench-scenario/v1",
    taskKind: "review_defect_detection",
    artifactSemantics: control ? "verified_clean" : "defect_present",
    oracle: {
      schemaVersion: "review-bench-oracle/v1",
      kind: control ? "clean_adjudication" : "later_fix",
      sourceUrl: control
        ? "https://github.com/example/alpha/pull/7"
        : `https://github.com/example/alpha/commit/${"c".repeat(40)}`,
      sourceRevision: control ? sourceRevision : "c".repeat(40),
      evidenceSha256: "0".repeat(64),
      defectPresentInReviewedArtifact: !control,
      modelInputExcluded: true
    },
    scenarioId: control ? "clean-alpha" : "defect-alpha",
    sourceId: control ? "source-clean-alpha" : "source-defect-alpha",
    runId: "intake-alpha",
    repository: "example/alpha",
    sourceRevision,
    license: {
      spdxId: "MIT",
      licenseUrl: `https://raw.githubusercontent.com/example/alpha/${sourceRevision}/LICENSE`
    },
    provenance: {
      kind: "pull_request",
      baseRevision: "d".repeat(40),
      repositoryUrl: "https://github.com/example/alpha",
      sourceUrl: "https://github.com/example/alpha/pull/7",
      sourceArtifactUrl: `https://github.com/example/alpha/compare/${"d".repeat(40)}...${sourceRevision}.diff`,
      sourceArtifactSha256,
      visibility: "public",
      visibilityEvidenceUrl: "https://api.github.com/repos/example/alpha",
      visibilityVerifiedAt: COMPLETED_AT,
      verification: {
        schemaVersion: "review-bench-source-verification/v1",
        provider: "github",
        verifierVersion: "github-public-source-ingest/v1",
        repositoryNodeId: "node:alpha",
        visibility: "public",
        licenseSpdxId: "MIT",
        repositoryMetadataSha256: "1".repeat(64),
        sourceMetadataSha256: "2".repeat(64),
        licenseArtifactSha256: "3".repeat(64),
        sourceArtifactSha256,
        verifiedAt: COMPLETED_AT,
        bindingSha256: "4".repeat(64)
      }
    },
    language: "TypeScript",
    split: "train",
    bugFamily: "runtime_correctness",
    explicitControl: control,
    labels: control ? [] : [{
      id: "gold-alpha",
      path: "src/state.ts",
      line: 10,
      severity: "P1",
      title: "State write loses the latest value",
      body: "The stale write overwrites newer state."
    }],
    adjudication: {
      status: "independently_adjudicated",
      primaryAdjudicator: "human:one",
      secondaryAdjudicator: "human:two",
      ...(agreement === "reconciled" ? { resolverAdjudicator: "human:three" } : {}),
      agreement,
      method: "Independent blinded review followed by resolution when needed.",
      rubricVersion: "review-bench-rubric/v1",
      rubricSha256: sha256(RUBRIC_TEXT),
      protocolVersion: "review-bench-adjudication-protocol/v1",
      protocolSha256: sha256(PROTOCOL_TEXT),
      completedAt: COMPLETED_AT
    }
  };
}

function annotationCandidates(scenario: ReviewBenchScenarioV1) {
  return [
    ...scenario.labels.map((label) => ({
      id: label.id,
      path: label.path,
      line: label.line,
      title: label.title,
      body: label.body
    })),
    ...(scenario.explicitControl ? [{
      id: "candidate-clean-noise",
      path: "src/state.ts",
      line: 10,
      title: "Potential redundant state write",
      body: "The reviewed line might duplicate an earlier state update."
    }] : [])
  ].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function finalLabels(scenario: ReviewBenchScenarioV1, candidates = annotationCandidates(scenario)) {
  const goldById = new Map(scenario.labels.map((label) => [label.id, label]));
  return candidates.map((candidate) => {
    const gold = goldById.get(candidate.id);
    return gold ? {
      labelId: candidate.id,
      actionability: "actionable" as const,
      severity: gold.severity
    } : {
      labelId: candidate.id,
      actionability: "not_actionable" as const
    };
  });
}

function evidence(scenario: ReviewBenchScenarioV1): ReviewBenchOracleEvidenceV1 {
  const sourceEvidenceSha256 = scenario.explicitControl
    ? scenario.provenance.sourceArtifactSha256
    : "9".repeat(64);
  const candidates = annotationCandidates(scenario);
  const finalDecision = {
    verdict: scenario.artifactSemantics,
    labels: finalLabels(scenario, candidates)
  };
  const primary = {
    adjudicatorId: scenario.adjudication.primaryAdjudicator,
    ...finalDecision,
    rationale: "The exact reviewed artifact and every proposed label were inspected.",
    completedAt: COMPLETED_AT,
    blindedToProviderIdentity: true as const,
    blindedToPeerDecision: true as const
  };
  const secondary = {
    adjudicatorId: scenario.adjudication.secondaryAdjudicator,
    ...finalDecision,
    rationale: "The source state independently supports the recorded verdict.",
    completedAt: COMPLETED_AT,
    blindedToProviderIdentity: true as const,
    blindedToPeerDecision: true as const
  };
  return {
    schemaVersion: "review-bench-oracle-evidence/v2",
    scenarioId: scenario.scenarioId,
    repository: scenario.repository,
    reviewedSourceRevision: scenario.sourceRevision,
    reviewedSourceArtifactSha256: scenario.provenance.sourceArtifactSha256,
    artifactSemantics: scenario.artifactSemantics,
    annotationUniverse: {
      schemaVersion: "review-bench-annotation-universe/v1",
      frozenAt: COMPLETED_AT,
      methodVersion: scenario.adjudication.protocolVersion,
      methodSha256: scenario.adjudication.protocolSha256,
      candidates
    },
    oracle: {
      kind: scenario.oracle.kind,
      sourceUrl: scenario.oracle.sourceUrl,
      sourceRevision: scenario.oracle.sourceRevision,
      relation: scenario.explicitControl
        ? "verified_clean_exact_artifact"
        : "defect_present_in_reviewed_artifact",
      sourceEvidenceSha256,
      labelEvidence: scenario.labels.map((label) => ({
        labelId: label.id,
        sourceEvidenceSha256,
        sourcePath: label.path,
        sourceLine: scenario.oracle.kind === "review_comment" ? label.line : null,
        rationale: "The verified oracle source supports this exact gold label."
      })),
      evidenceSummary: scenario.explicitControl
        ? "Two independent reviews found no actionable defect in the exact change."
        : "Later evidence and source inspection establish the defect in the reviewed state.",
      observedAt: COMPLETED_AT
    },
    ...(scenario.explicitControl ? {
      cleanObservation: {
        schemaVersion: "review-bench-clean-observation/v1" as const,
        sourceUrl: `https://github.com/${scenario.repository}/pull/8`,
        sourceRevision: "e".repeat(40),
        sourceEvidenceSha256: "8".repeat(64),
        observedThrough: COMPLETED_AT,
        minimumCleanDays: 30,
        checkedSignals: ["hotfix", "linked_defect", "revert"] as ["hotfix", "linked_defect", "revert"],
        evidenceSummary: "No linked defect, revert, or hotfix signal appeared during the clean window."
      }
    } : {}),
    rubricVersion: scenario.adjudication.rubricVersion,
    rubricSha256: scenario.adjudication.rubricSha256,
    protocolVersion: scenario.adjudication.protocolVersion,
    protocolSha256: scenario.adjudication.protocolSha256,
    adjudicationMethod: scenario.adjudication.method,
    adjudicationCompletedAt: scenario.adjudication.completedAt,
    coveredLabelIds: scenario.labels.map((label) => label.id).sort(),
    goldLabelsSha256: computeReviewBenchGoldLabelsSha256(scenario.labels),
    primary,
    secondary,
    ...(scenario.adjudication.agreement === "reconciled" ? {
      primary: {
        ...primary,
        verdict: "verified_clean" as const,
        labels: candidates.map((candidate) => ({
          labelId: candidate.id,
          actionability: "not_actionable" as const
        }))
      },
      resolver: {
        adjudicatorId: scenario.adjudication.resolverAdjudicator!,
        ...finalDecision,
        rationale: "The disagreement was reviewed against the exact pinned artifact.",
        completedAt: COMPLETED_AT,
        blindedToProviderIdentity: true as const,
        reviewedDisagreement: true as const
      }
    } : {})
  };
}

function bindEvidence(
  unbound: ReviewBenchScenarioV1,
  packet: ReviewBenchOracleEvidenceV1 = evidence(unbound)
): { scenario: ReviewBenchScenarioV1; packet: ReviewBenchOracleEvidenceV1; bytes: Uint8Array } {
  const bytes = serializeReviewBenchOracleEvidence(packet);
  return {
    scenario: {
      ...unbound,
      oracle: { ...unbound.oracle, evidenceSha256: sha256(bytes) }
    },
    packet,
    bytes
  };
}

describe("Review Bench oracle evidence v2", () => {
  it("binds agreed defect and verified-clean decisions to exact scenario bytes", () => {
    const defect = bindEvidence(scenario());
    const clean = bindEvidence(scenario({ control: true }));

    expect(verifyReviewBenchOracleEvidence(defect.scenario, defect.bytes)).toEqual(expect.objectContaining({
      scenarioId: defect.scenario.scenarioId,
      evidenceSha256: defect.scenario.oracle.evidenceSha256
    }));
    expect(verifyReviewBenchOracleEvidence(clean.scenario, clean.bytes)).toEqual(expect.objectContaining({
      scenarioId: clean.scenario.scenarioId,
      evidenceSha256: clean.scenario.oracle.evidenceSha256
    }));
  });

  it("requires a third distinct resolver for material disagreement", () => {
    const reconciled = bindEvidence(scenario({ agreement: "reconciled" }));
    expect(() => verifyReviewBenchOracleEvidence(reconciled.scenario, reconciled.bytes)).not.toThrow();

    const missingResolver = evidence(reconciled.scenario);
    delete missingResolver.resolver;
    const rebound = bindEvidence(reconciled.scenario, missingResolver);
    expect(() => verifyReviewBenchOracleEvidence(rebound.scenario, rebound.bytes))
      .toThrow("resolver");

    const noDisagreement = evidence(reconciled.scenario);
    noDisagreement.primary = {
      ...noDisagreement.secondary,
      adjudicatorId: noDisagreement.primary.adjudicatorId
    };
    const noDisagreementBound = bindEvidence(reconciled.scenario, noDisagreement);
    expect(() => verifyReviewBenchOracleEvidence(noDisagreementBound.scenario, noDisagreementBound.bytes))
      .toThrow("materially disagree");
  });

  it("requires per-label oracle mapping and a versioned long-window clean observation", () => {
    const defectScenario = scenario();
    const missingLabelEvidence = evidence(defectScenario);
    missingLabelEvidence.oracle.labelEvidence = [];
    const defectBound = bindEvidence(defectScenario, missingLabelEvidence);
    expect(() => verifyReviewBenchOracleEvidence(defectBound.scenario, defectBound.bytes))
      .toThrow("labelEvidence does not match");

    const cleanScenario = scenario({ control: true });
    const missingCleanObservation = evidence(cleanScenario);
    delete missingCleanObservation.cleanObservation;
    const cleanBound = bindEvidence(cleanScenario, missingCleanObservation);
    expect(() => verifyReviewBenchOracleEvidence(cleanBound.scenario, cleanBound.bytes))
      .toThrow("cleanObservation must be an object");

    const shortObservation = evidence(cleanScenario);
    shortObservation.cleanObservation!.minimumCleanDays = 29;
    const shortBound = bindEvidence(cleanScenario, shortObservation);
    expect(() => verifyReviewBenchOracleEvidence(shortBound.scenario, shortBound.bytes))
      .toThrow("at least 30");
  });

  it.each([
    ["repository", (packet: ReviewBenchOracleEvidenceV1) => { packet.repository = "example/other"; }],
    ["reviewed source revision", (packet: ReviewBenchOracleEvidenceV1) => { packet.reviewedSourceRevision = "e".repeat(40); }],
    ["reviewed source artifact", (packet: ReviewBenchOracleEvidenceV1) => { packet.reviewedSourceArtifactSha256 = "e".repeat(64); }],
    ["oracle source", (packet: ReviewBenchOracleEvidenceV1) => { packet.oracle.sourceRevision = "e".repeat(40); }],
    ["covered labels", (packet: ReviewBenchOracleEvidenceV1) => { packet.coveredLabelIds = ["other-label"]; }],
    ["rubric", (packet: ReviewBenchOracleEvidenceV1) => { packet.rubricVersion = "other-rubric/v1"; }]
  ])("rejects a packet with mismatched %s binding", (_name, mutate) => {
    const input = scenario();
    const packet = evidence(input);
    mutate(packet);
    const bound = bindEvidence(input, packet);
    expect(() => verifyReviewBenchOracleEvidence(bound.scenario, bound.bytes)).toThrow("does not match");
  });

  it("rejects tampered bytes even when the packet remains valid JSON", () => {
    const bound = bindEvidence(scenario());
    const tampered = new TextEncoder().encode(
      new TextDecoder().decode(bound.bytes).replace("source state", "changed source state")
    );
    expect(() => verifyReviewBenchOracleEvidence(bound.scenario, tampered))
      .toThrow("evidence sha256");
  });

  it("rejects duplicate-key and noncanonical oracle evidence JSON", () => {
    const input = scenario();
    const packet = evidence(input);
    const canonical = new TextDecoder().decode(serializeReviewBenchOracleEvidence(packet));
    const duplicated = new TextEncoder().encode(
      `{"schemaVersion":"review-bench-oracle-evidence/v0",${canonical.slice(1)}`
    );
    const bound = {
      ...input,
      oracle: { ...input.oracle, evidenceSha256: sha256(duplicated) }
    };
    expect(() => verifyReviewBenchOracleEvidence(bound, duplicated))
      .toThrow("canonical JSON without duplicate keys");
  });

  it("binds the complete canonical gold-label content, not only label IDs", () => {
    const original = scenario();
    const bound = bindEvidence(original);
    for (const [changedLabel, expectedError] of [
      [{ ...original.labels[0], path: "src/other.ts" }, "annotationUniverse"],
      [{ ...original.labels[0], line: 11 }, "annotationUniverse"],
      [{ ...original.labels[0], severity: "P2" as const }, "goldLabelsSha256"],
      [{ ...original.labels[0], title: "Changed title" }, "annotationUniverse"],
      [{ ...original.labels[0], body: "Changed body" }, "annotationUniverse"]
    ] as const) {
      const changedScenario = { ...bound.scenario, labels: [changedLabel] };
      expect(() => verifyReviewBenchOracleEvidence(changedScenario, bound.bytes))
        .toThrow(expectedError);
    }
  });

  it("requires sorted unique coverage and independent blinded decisions", () => {
    const input = scenario();
    const packet = evidence(input);
    packet.coveredLabelIds = ["gold-alpha", "gold-alpha"];
    const duplicate = bindEvidence(input, packet);
    expect(() => verifyReviewBenchOracleEvidence(duplicate.scenario, duplicate.bytes))
      .toThrow("sorted and unique");

    const unblindedPacket = evidence(input);
    unblindedPacket.primary.blindedToPeerDecision = false as true;
    const unblinded = bindEvidence(input, unblindedPacket);
    expect(() => verifyReviewBenchOracleEvidence(unblinded.scenario, unblinded.bytes))
      .toThrow("blindedToPeerDecision");

    const sameIdentityScenario = {
      ...input,
      adjudication: {
        ...input.adjudication,
        secondaryAdjudicator: input.adjudication.primaryAdjudicator
      }
    };
    const sameIdentityPacket = evidence(sameIdentityScenario);
    const sameIdentity = bindEvidence(sameIdentityScenario, sameIdentityPacket);
    expect(() => verifyReviewBenchOracleEvidence(sameIdentity.scenario, sameIdentity.bytes))
      .toThrow("distinct adjudicators");

    const confusableScenario = {
      ...input,
      adjudication: {
        ...input.adjudication,
        secondaryAdjudicator: "human:аlice"
      }
    };
    const confusablePacket = evidence(confusableScenario);
    const confusable = bindEvidence(confusableScenario, confusablePacket);
    expect(() => verifyReviewBenchOracleEvidence(confusable.scenario, confusable.bytes))
      .toThrow("lowercase ASCII human adjudicator identity");
  });

  it("freezes a unique annotation universe before both complete decision sets", () => {
    const input = scenario();
    const missingCandidateDecision = evidence(input);
    missingCandidateDecision.secondary.labels = [];
    const missing = bindEvidence(input, missingCandidateDecision);
    expect(() => verifyReviewBenchOracleEvidence(missing.scenario, missing.bytes))
      .toThrow("must rate every frozen annotation candidate exactly once");

    const lateUniverse = evidence(input);
    lateUniverse.annotationUniverse.frozenAt = "2026-07-12T00:01:00.000Z";
    const late = bindEvidence(input, lateUniverse);
    expect(() => verifyReviewBenchOracleEvidence(late.scenario, late.bytes))
      .toThrow("must be frozen before both independent decisions");

    const duplicateUniverse = evidence(input);
    duplicateUniverse.annotationUniverse.candidates.push({
      ...duplicateUniverse.annotationUniverse.candidates[0]!,
      id: "gold-duplicate"
    });
    duplicateUniverse.primary.labels.push({
      labelId: "gold-duplicate",
      actionability: "not_actionable"
    });
    duplicateUniverse.secondary.labels.push({
      labelId: "gold-duplicate",
      actionability: "not_actionable"
    });
    const duplicate = bindEvidence(input, duplicateUniverse);
    expect(() => verifyReviewBenchOracleEvidence(duplicate.scenario, duplicate.bytes))
      .toThrow("duplicate candidate content");
  });

  it("requires final actionability and severity support for every gold label", () => {
    const input = scenario();
    const packet = evidence(input);
    packet.secondary.labels[0] = {
      ...packet.secondary.labels[0],
      actionability: "not_actionable",
      severity: undefined
    };
    const nonActionable = bindEvidence(input, packet);
    expect(() => verifyReviewBenchOracleEvidence(nonActionable.scenario, nonActionable.bytes))
      .toThrow("verdict must agree with whether any frozen candidate is actionable");

    const severityPacket = evidence(input);
    severityPacket.primary.labels[0] = { ...severityPacket.primary.labels[0], severity: "P2" };
    severityPacket.secondary.labels[0] = { ...severityPacket.secondary.labels[0], severity: "P2" };
    const severity = bindEvidence(input, severityPacket);
    expect(() => verifyReviewBenchOracleEvidence(severity.scenario, severity.bytes))
      .toThrow("must equal the final gold severity");
  });

  it("rejects secret-like material in oracle evidence", () => {
    const input = scenario();
    const packet = evidence(input);
    packet.primary.rationale = syntheticPemBoundary();
    const bound = bindEvidence(input, packet);
    expect(() => verifyReviewBenchOracleEvidence(bound.scenario, bound.bytes))
      .toThrow("secret-like text");
  });

  it("requires adjudicator decisions to follow the observed oracle evidence", () => {
    const input = scenario();
    input.adjudication.completedAt = "2026-07-12T00:02:00.000Z";
    const packet = evidence(input);
    packet.oracle.observedAt = "2026-07-12T00:01:00.000Z";
    const bound = bindEvidence(input, packet);
    expect(() => verifyReviewBenchOracleEvidence(bound.scenario, bound.bytes))
      .toThrow("must not precede observed oracle evidence");
  });

  it("requires clean-control decisions to follow the clean observation window", () => {
    const input = scenario({ control: true });
    input.adjudication.completedAt = "2026-07-12T00:02:00.000Z";
    const packet = evidence(input);
    packet.cleanObservation!.observedThrough = "2026-07-12T00:01:00.000Z";
    const bound = bindEvidence(input, packet);
    expect(() => verifyReviewBenchOracleEvidence(bound.scenario, bound.bytes))
      .toThrow("must not precede the clean observation");
  });

  it("computes a deterministic corpus-level semantic evidence digest", () => {
    const records = [
      { scenarioId: "z", evidenceSha256: "a".repeat(64) },
      { scenarioId: "a", evidenceSha256: "b".repeat(64) }
    ];
    expect(computeReviewBenchSemanticEvidenceSha256(records))
      .toBe(computeReviewBenchSemanticEvidenceSha256([...records].reverse()));
    expect(computeReviewBenchSemanticEvidenceSha256(records)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("computes and enforces the preregistered adjudication agreement floors", () => {
    const defect = bindEvidence(scenario());
    const clean = bindEvidence(scenario({ control: true }));
    const defectRecord = bindReviewBenchLineAgreement(
      verifyReviewBenchOracleEvidence(defect.scenario, defect.bytes),
      [{ path: "src/state.ts", line: 10 }]
    );
    const cleanRecord = bindReviewBenchLineAgreement(
      verifyReviewBenchOracleEvidence(clean.scenario, clean.bytes),
      [{ path: "src/state.ts", line: 10 }]
    );
    expect(computeReviewBenchAdjudicationAgreement([defectRecord, cleanRecord])).toEqual({
      version: "review-bench-adjudication-agreement/v2",
      scenarioCount: 2,
      actionabilityItemCount: 2,
      actionabilityBothActionableCount: 1,
      actionabilityPrimaryOnlyCount: 0,
      actionabilitySecondaryOnlyCount: 0,
      actionabilityNeitherCount: 1,
      actionabilityKappa: 1,
      artifactBothDefectCount: 1,
      artifactPrimaryOnlyDefectCount: 0,
      artifactSecondaryOnlyDefectCount: 0,
      artifactBothCleanCount: 1,
      artifactSemanticsKappa: 1,
      severityLabelCount: 1,
      severityWithinOneTierAgreement: 1
    });

    expect(() => computeReviewBenchAdjudicationAgreement([
      defectRecord,
      { ...cleanRecord, secondaryVerdict: "defect_present" }
    ])).toThrow("artifact-semantics kappa");
    expect(() => computeReviewBenchAdjudicationAgreement([
      {
        ...defectRecord,
        labelAgreement: [{
          ...defectRecord.labelAgreement[0],
          secondarySeverity: "P3"
        }]
      },
      cleanRecord
    ])).toThrow("severity-within-one-tier agreement");

    expect(() => computeReviewBenchAdjudicationAgreement([
      {
        ...defectRecord,
        lineAgreement: {
          ...defectRecord.lineAgreement!,
          lineUnitCount: 10,
          bothActionableCount: 9,
          primaryOnlyCount: 1,
          secondaryOnlyCount: 0,
          neitherCount: 0
        }
      },
      cleanRecord
    ])).toThrow("actionability kappa");
  });
});
