import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  adaptLegacyEvalScenario,
  buildReviewBenchModelInput,
  computeReviewBenchCorpusHash,
  computeReviewBenchSourceVerificationBinding,
  matchReviewBenchFindings,
  REVIEW_BENCH_MATCHER_VERSION,
  validateReviewBenchCorpus,
  type ReviewBenchCorpusV1,
  type ReviewBenchScenarioV1
} from "../src/review-bench-corpus.js";

const SHA_ALPHA = "a".repeat(40);
const SHA_BETA = "b".repeat(40);
const SHA_HOLDOUT = "d".repeat(40);
const CANDIDATE_FINGERPRINT = "c".repeat(64);
const EVALUATOR_EVIDENCE_SHA256 = "e".repeat(64);
const RUBRIC_TEXT = "# review-bench-rubric/v1\nActionability and severity definitions.\n";
const PROTOCOL_TEXT = "# review-bench-adjudication-protocol/v1\nIndependent blinded adjudication.\n";

function scenario(overrides: Partial<ReviewBenchScenarioV1> = {}): ReviewBenchScenarioV1 {
  const repository = overrides.repository ?? "example/alpha";
  const sourceRevision = overrides.sourceRevision ?? SHA_ALPHA;
  const explicitControl = overrides.explicitControl === true;
  const oracleRevision = sourceRevision === "f".repeat(40) ? "e".repeat(40) : "f".repeat(40);
  const baseRevision = overrides.provenance?.baseRevision ?? "0".repeat(40);
  const sourceArtifactSha256 = createHash("sha256")
    .update(`${repository.toLowerCase()}@${sourceRevision}`)
    .digest("hex");
  const hasProvenanceOverride = Object.prototype.hasOwnProperty.call(overrides, "provenance");
  const resolvedProvenance = hasProvenanceOverride && overrides.provenance === undefined
    ? undefined
    : {
        kind: "pull_request" as const,
        baseRevision,
        repositoryUrl: `https://github.com/${repository}`,
        sourceUrl: `https://github.com/${repository}/pull/7`,
        sourceArtifactUrl: `https://github.com/${repository}/compare/${baseRevision}...${sourceRevision}.diff`,
        sourceArtifactSha256,
        visibility: "public" as const,
        visibilityEvidenceUrl: `https://api.github.com/repos/${repository}`,
        visibilityVerifiedAt: "2026-07-12T00:00:00.000Z",
        ...overrides.provenance
      };
  const built = {
    schemaVersion: "review-bench-scenario/v1",
    taskKind: "review_defect_detection",
    artifactSemantics: explicitControl ? "verified_clean" : "defect_present",
    oracle: explicitControl ? {
      schemaVersion: "review-bench-oracle/v1",
      kind: "clean_adjudication",
      sourceUrl: `https://github.com/${repository}/pull/7`,
      sourceRevision,
      evidenceSha256: sha256(`clean-oracle:${repository.toLowerCase()}@${sourceRevision}`),
      defectPresentInReviewedArtifact: false,
      modelInputExcluded: true
    } : {
      schemaVersion: "review-bench-oracle/v1",
      kind: "later_fix",
      sourceUrl: `https://github.com/${repository}/commit/${oracleRevision}`,
      sourceRevision: oracleRevision,
      evidenceSha256: sha256(`defect-oracle:${repository.toLowerCase()}@${sourceRevision}`),
      defectPresentInReviewedArtifact: true,
      modelInputExcluded: true
    },
    scenarioId: "scenario-alpha",
    sourceId: "github:example/alpha:pull/7@abc123",
    runId: "run-alpha",
    repository,
    sourceRevision,
    license: {
      spdxId: "MIT",
      licenseUrl: `https://raw.githubusercontent.com/${repository}/${sourceRevision}/LICENSE`
    },
    language: "TypeScript",
    split: "train",
    bugFamily: overrides.bugFamily ??
      (overrides.split === "holdout" ? "security_boundary" : "runtime_correctness"),
    explicitControl: false,
    labels: [{
      id: "gold-alpha",
      path: "src/cache.ts",
      line: 40,
      severity: "P1",
      title: "Cache invalidation loses the latest value",
      body: "The stale write replaces a newer cached value."
    }],
    adjudication: {
      status: "independently_adjudicated",
      primaryAdjudicator: "human:reviewer-a",
      secondaryAdjudicator: "human:reviewer-b",
      agreement: "agree",
      method: "Independent review followed by reconciliation.",
      rubricVersion: "review-bench-rubric/v1",
      rubricSha256: sha256(RUBRIC_TEXT),
      protocolVersion: "review-bench-adjudication-protocol/v1",
      protocolSha256: sha256(PROTOCOL_TEXT),
      completedAt: "2026-07-12T00:00:00.000Z"
    },
    ...overrides,
    provenance: resolvedProvenance
  } as ReviewBenchScenarioV1;
  if (built.provenance) {
    const verification = {
      schemaVersion: "review-bench-source-verification/v1" as const,
      provider: "github" as const,
      verifierVersion: "github-public-source-ingest/v1" as const,
      repositoryNodeId: `node:${repository.toLowerCase()}`,
      visibility: "public" as const,
      licenseSpdxId: built.license?.spdxId ?? "invalid",
      repositoryMetadataSha256: sha256(`metadata:${repository.toLowerCase()}`),
      sourceMetadataSha256: sha256(`source-metadata:${repository.toLowerCase()}@${sourceRevision}`),
      licenseArtifactSha256: sha256(`license:${built.license?.licenseUrl ?? "missing"}`),
      sourceArtifactSha256: built.provenance.sourceArtifactSha256,
      verifiedAt: built.provenance.visibilityVerifiedAt,
      bindingSha256: "0".repeat(64)
    };
    built.provenance = { ...built.provenance, verification };
    verification.bindingSha256 = computeReviewBenchSourceVerificationBinding(built);
  }
  return built;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function corpus(scenarios: ReviewBenchScenarioV1[]): ReviewBenchCorpusV1 {
  return {
    schemaVersion: "review-bench-corpus/v1",
    corpusVersion: "1.0.0",
    splitPolicy: {
      repositoryGrouped: true,
      holdoutFloor: { scenarios: 1, repositories: 1, minimumFraction: 0.3 }
    },
    scenarios
  };
}

function matcherOptions(
  semanticMatch: (bot: ReviewBenchScenarioV1["labels"][number], label: ReviewBenchScenarioV1["labels"][number]) => boolean,
  overrides: Partial<{
    candidateModelId: string;
    candidateTargetFingerprint: string;
    semanticEvaluator: {
      kind: "human" | "model";
      id: string;
      version: string;
      evidenceSha256: string;
      targetFingerprint?: string;
    };
  }> = {}
) {
  return {
    candidateModelId: "model:qwen3-coder-next-q4_k_m",
    candidateTargetFingerprint: CANDIDATE_FINGERPRINT,
    semanticEvaluator: {
      kind: "human" as const,
      id: "evaluator:blinded-human-pair",
      version: "review-bench-semantic/v1",
      evidenceSha256: EVALUATOR_EVIDENCE_SHA256
    },
    semanticMatch,
    ...overrides
  };
}

describe("Review Bench Corpus v1 contract", () => {
  it("computes a deterministic hash independent of scenario and object-key order", () => {
    const alpha = scenario();
    const beta = scenario({
      scenarioId: "scenario-beta",
      sourceId: "github:example/beta:pull/8@def456",
      runId: "run-beta",
      repository: "example/beta",
      sourceRevision: SHA_BETA,
      split: "holdout",
      language: "Python"
    });

    const first = corpus([alpha, beta]);
    const second = {
      ...corpus([
        { ...beta, runId: "different-execution-beta" },
        { ...alpha, runId: "different-execution-alpha" }
      ]),
      corpusHash: "stale-value"
    };

    expect(computeReviewBenchCorpusHash(first)).toMatch(/^[a-f0-9]{64}$/);
    expect(computeReviewBenchCorpusHash(second)).toBe(computeReviewBenchCorpusHash(first));
  });

  it("admits only review-defect scenarios whose oracle attests the defect exists in the reviewed artifact", () => {
    const semanticContract = {
      taskKind: "review_defect_detection",
      artifactSemantics: "defect_present",
      oracle: {
        schemaVersion: "review-bench-oracle/v1",
        kind: "later_fix",
        sourceUrl: `https://github.com/example/alpha/commit/${"c".repeat(40)}`,
        sourceRevision: "c".repeat(40),
        evidenceSha256: "f".repeat(64),
        defectPresentInReviewedArtifact: true,
        modelInputExcluded: true
      }
    };
    const train = { ...scenario(), ...semanticContract } as unknown as ReviewBenchScenarioV1;
    const holdout = {
      ...scenario({
        scenarioId: "holdout-semantic",
        sourceId: "github:example/holdout:pull/1@deadbeef",
        repository: "example/holdout",
        sourceRevision: SHA_HOLDOUT,
        split: "holdout"
      }),
      ...semanticContract,
      oracle: {
        ...semanticContract.oracle,
        sourceUrl: `https://github.com/example/holdout/commit/${"e".repeat(40)}`,
        sourceRevision: "e".repeat(40)
      }
    } as unknown as ReviewBenchScenarioV1;

    expect(() => validateReviewBenchCorpus(corpus([train, holdout]))).not.toThrow();
  });

  it("rejects repair evidence from the reviewed revision and oracle material exposed to the model", () => {
    const defect = scenario();
    const holdout = scenario({
      scenarioId: "holdout-oracle",
      sourceId: "github:example/holdout:pull/1@deadbeef",
      repository: "example/holdout",
      sourceRevision: SHA_HOLDOUT,
      split: "holdout"
    });
    const selfFix = {
      ...defect,
      oracle: {
        ...defect.oracle,
        sourceUrl: defect.provenance.sourceUrl,
        sourceRevision: defect.sourceRevision
      }
    } as ReviewBenchScenarioV1;
    expect(() => validateReviewBenchCorpus(corpus([selfFix, holdout])))
      .toThrow("repair evidence must not be the reviewed source revision");

    const leakedOracle = {
      ...defect,
      oracle: { ...defect.oracle, modelInputExcluded: false }
    } as unknown as ReviewBenchScenarioV1;
    expect(() => validateReviewBenchCorpus(corpus([leakedOracle, holdout])))
      .toThrow("modelInputExcluded must be true");
  });

  it("requires verified-clean controls to use an exact-revision clean-adjudication oracle", () => {
    const control = scenario({
      scenarioId: "holdout-clean",
      sourceId: "github:example/clean:pull/1@deadbeef",
      repository: "example/clean",
      sourceRevision: SHA_HOLDOUT,
      split: "holdout",
      explicitControl: true,
      labels: []
    });
    expect(() => validateReviewBenchCorpus(corpus([scenario(), control]))).not.toThrow();

    const wrongRevision = {
      ...control,
      oracle: { ...control.oracle, sourceRevision: "e".repeat(40) }
    } as ReviewBenchScenarioV1;
    expect(() => validateReviewBenchCorpus(corpus([scenario(), wrongRevision])))
      .toThrow("must equal the verified-clean source revision");

    const contradictory = {
      ...control,
      artifactSemantics: "defect_present"
    } as ReviewBenchScenarioV1;
    expect(() => validateReviewBenchCorpus(corpus([scenario(), contradictory])))
      .toThrow("explicitControl and artifactSemantics");

    const commitControl = {
      ...control,
      provenance: {
        ...control.provenance,
        kind: "commit" as const,
        baseRevision: undefined,
        sourceUrl: `https://github.com/${control.repository}/commit/${control.sourceRevision}`,
        sourceArtifactUrl: `https://github.com/${control.repository}/commit/${control.sourceRevision}.diff`
      },
      oracle: {
        ...control.oracle,
        sourceUrl: `https://github.com/${control.repository}/commit/${control.sourceRevision}`
      }
    } as ReviewBenchScenarioV1;
    commitControl.provenance.verification.bindingSha256 =
      computeReviewBenchSourceVerificationBinding(commitControl);
    expect(() => validateReviewBenchCorpus(corpus([scenario(), commitControl])))
      .toThrow("clean controls require pull-request provenance");
  });

  it("binds review-comment evidence to the exact reviewed head", () => {
    const reviewed = scenario();
    const withReviewComment = {
      ...reviewed,
      oracle: {
        ...reviewed.oracle,
        kind: "review_comment",
        sourceUrl: "https://api.github.com/repos/example/alpha/pulls/comments/12345",
        sourceRevision: reviewed.sourceRevision
      }
    } as ReviewBenchScenarioV1;
    const holdout = scenario({
      scenarioId: "holdout-review-comment",
      sourceId: "github:example/holdout:pull/1@deadbeef",
      repository: "example/holdout",
      sourceRevision: SHA_HOLDOUT,
      split: "holdout"
    });
    expect(() => validateReviewBenchCorpus(corpus([withReviewComment, holdout]))).not.toThrow();

    const multipleLabels = {
      ...withReviewComment,
      labels: [
        ...withReviewComment.labels,
        { ...withReviewComment.labels[0], id: "gold-second", line: withReviewComment.labels[0]!.line + 1 }
      ]
    } as ReviewBenchScenarioV1;
    expect(() => validateReviewBenchCorpus(corpus([multipleLabels, holdout])))
      .toThrow("one-label pull-request provenance");

    const wrongHead = {
      ...withReviewComment,
      oracle: { ...withReviewComment.oracle, sourceRevision: "c".repeat(40) }
    } as ReviewBenchScenarioV1;
    expect(() => validateReviewBenchCorpus(corpus([wrongHead, holdout])))
      .toThrow("exact reviewed source revision");
  });

  it("rejects synthetic provenance until a derived-artifact contract exists", () => {
    const synthetic = scenario({
      provenance: {
        ...scenario().provenance,
        kind: "synthetic"
      } as unknown as ReviewBenchScenarioV1["provenance"]
    });
    const holdout = scenario({
      scenarioId: "holdout-synthetic",
      sourceId: "github:example/holdout:pull/1@deadbeef",
      repository: "example/holdout",
      sourceRevision: SHA_HOLDOUT,
      split: "holdout"
    });
    expect(() => validateReviewBenchCorpus(corpus([synthetic, holdout])))
      .toThrow("provenance.kind must be pull_request, commit, or revert");
  });

  it("binds artifact semantics and oracle evidence into the corpus hash", () => {
    const train = scenario();
    const holdout = scenario({
      scenarioId: "holdout-oracle-hash",
      sourceId: "github:example/holdout:pull/1@deadbeef",
      repository: "example/holdout",
      sourceRevision: SHA_HOLDOUT,
      split: "holdout"
    });
    const changed = {
      ...train,
      oracle: { ...train.oracle, evidenceSha256: "9".repeat(64) }
    } as ReviewBenchScenarioV1;
    expect(computeReviewBenchCorpusHash(corpus([train, holdout])))
      .not.toBe(computeReviewBenchCorpusHash(corpus([changed, holdout])));
  });

  it.each([
    ["schema version", { schemaVersion: "review-bench-oracle/v0" }, "schemaVersion"],
    ["kind", { kind: "self_reported_fix" }, "kind is unsupported"],
    ["unbound kind", { kind: "fault_report" }, "kind is unsupported"],
    ["source URL", { sourceUrl: "https://127.0.0.1/oracle" }, "public HTTPS"],
    ["unbound source URL", {
      sourceUrl: `https://github.com/example/other/commit/${"f".repeat(40)}`
    }, "bound to repository"],
    ["source revision", { sourceRevision: "mutable" }, "immutable commit digest"],
    ["evidence digest", { evidenceSha256: "not-a-digest" }, "sha256"],
    ["defect attestation", { defectPresentInReviewedArtifact: false }, "must attest"]
  ])("rejects invalid oracle %s", (_name, oracleOverride, message) => {
    const train = scenario();
    const invalid = {
      ...train,
      oracle: { ...train.oracle, ...oracleOverride }
    } as unknown as ReviewBenchScenarioV1;
    const holdout = scenario({
      scenarioId: "holdout-invalid-oracle",
      sourceId: "github:example/holdout:pull/1@deadbeef",
      repository: "example/holdout",
      sourceRevision: SHA_HOLDOUT,
      split: "holdout"
    });
    expect(() => validateReviewBenchCorpus(corpus([invalid, holdout]))).toThrow(message);
  });

  it("rejects unknown oracle fields", () => {
    const train = scenario();
    const invalid = {
      ...train,
      oracle: { ...train.oracle, generatedAnswer: "do not publish" }
    } as unknown as ReviewBenchScenarioV1;
    const holdout = scenario({
      scenarioId: "holdout-oracle-keys",
      sourceId: "github:example/holdout:pull/1@deadbeef",
      repository: "example/holdout",
      sourceRevision: SHA_HOLDOUT,
      split: "holdout"
    });
    expect(() => validateReviewBenchCorpus(corpus([invalid, holdout])))
      .toThrow("oracle has unknown keys");
    expect(computeReviewBenchCorpusHash(corpus([invalid, holdout])))
      .toBe(computeReviewBenchCorpusHash(corpus([train, holdout])));
  });

  it("projects a prompt-safe model input without answer-bearing scenario metadata", () => {
    const contaminated = {
      ...scenario(),
      scenarioId: "ANSWER-scenario",
      sourceId: "ANSWER-source",
      runId: "ANSWER-run",
      artifactSemantics: "defect_present",
      bugFamily: "auth",
      split: "holdout",
      explicitControl: false,
      oracle: {
        ...scenario().oracle,
        sourceUrl: "https://github.com/example/alpha/issues/ANSWER-oracle"
      },
      labels: [{
        ...scenario().labels[0],
        title: "ANSWER-label",
        body: "ANSWER-body"
      }],
      adjudication: {
        ...scenario().adjudication,
        method: "ANSWER-adjudication"
      }
    } as unknown as ReviewBenchScenarioV1;

    const modelInput = buildReviewBenchModelInput(contaminated);
    expect(modelInput).toEqual({
      schemaVersion: "review-bench-model-input/v1",
      language: contaminated.language
    });
    expect(Object.keys(modelInput).sort()).toEqual([
      "language",
      "schemaVersion"
    ]);
    expect(JSON.stringify(modelInput)).not.toContain("ANSWER");

    expect(() => buildReviewBenchModelInput({
      ...contaminated,
      language: "TypeScript-ANSWER"
    } as unknown as ReviewBenchScenarioV1)).toThrow("supported Review Bench language");
  });

  it("requires a distinct resolver identity only for reconciled adjudication", () => {
    const holdout = scenario({
      scenarioId: "holdout-resolver",
      sourceId: "github:example/holdout:pull/1@deadbeef",
      repository: "example/holdout",
      sourceRevision: SHA_HOLDOUT,
      split: "holdout"
    });
    const reconciledWithoutResolver = {
      ...scenario(),
      adjudication: { ...scenario().adjudication, agreement: "reconciled" }
    } as ReviewBenchScenarioV1;
    expect(() => validateReviewBenchCorpus(corpus([reconciledWithoutResolver, holdout])))
      .toThrow("resolverAdjudicator");

    const reconciled = {
      ...scenario(),
      adjudication: {
        ...scenario().adjudication,
        agreement: "reconciled",
        resolverAdjudicator: "human:reviewer-c"
      }
    } as unknown as ReviewBenchScenarioV1;
    expect(() => validateReviewBenchCorpus(corpus([reconciled, holdout]))).not.toThrow();

    const resolverOnAgreement = {
      ...scenario(),
      adjudication: {
        ...scenario().adjudication,
        resolverAdjudicator: "human:reviewer-c"
      }
    } as unknown as ReviewBenchScenarioV1;
    expect(() => validateReviewBenchCorpus(corpus([resolverOnAgreement, holdout])))
      .toThrow("resolverAdjudicator is only allowed");
  });

  it("uses locale-independent ordering for the corpus hash", () => {
    const localeCompare = vi.spyOn(String.prototype, "localeCompare").mockImplementation(() => {
      throw new Error("locale-sensitive ordering must not be used");
    });
    try {
      const result = computeReviewBenchCorpusHash(corpus([
        scenario({ scenarioId: "scenario-é" }),
        scenario({
          scenarioId: "scenario-z",
          sourceId: "github:example/zeta:pull/1@deadbeef",
          repository: "example/zeta",
          sourceRevision: SHA_HOLDOUT,
          split: "holdout"
        })
      ]));
      expect(result).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      localeCompare.mockRestore();
    }
  });

  it("requires immutable source revision and artifact identities bound to the repository", () => {
    const holdout = scenario({
      scenarioId: "holdout",
      sourceId: "github:example/holdout:pull/1@deadbeef",
      repository: "example/holdout",
      sourceRevision: SHA_HOLDOUT,
      split: "holdout"
    });

    expect(() => validateReviewBenchCorpus(corpus([
      scenario({ sourceRevision: "main" }),
      holdout
    ]))).toThrow("immutable commit digest");
    expect(() => validateReviewBenchCorpus(corpus([
      scenario({ repository: "example/alpha " }),
      holdout
    ]))).toThrow("canonical repository identity");
    expect(() => validateReviewBenchCorpus(corpus([
      scenario({
        provenance: {
          ...scenario().provenance,
          repositoryUrl: "https://github.com/example/unrelated",
          sourceUrl: "https://github.com/example/unrelated/pull/7"
        }
      }),
      holdout
    ]))).toThrow("bound to repository");
    expect(() => validateReviewBenchCorpus(corpus([
      scenario({
        license: {
          spdxId: "MIT",
          licenseUrl: `https://github.com/example/unrelated/blob/${SHA_ALPHA}/LICENSE`
        }
      }),
      holdout
    ]))).toThrow("licenseUrl must be bound");
    expect(() => validateReviewBenchCorpus(corpus([
      scenario({
        license: {
          spdxId: "MIT",
          licenseUrl: "https://github.com/example/alpha/blob/main/LICENSE"
        }
      }),
      holdout
    ]))).toThrow("licenseUrl must be bound");
    expect(() => validateReviewBenchCorpus(corpus([
      scenario({
        provenance: {
          ...scenario().provenance,
          visibilityEvidenceUrl: "https://example.org/public"
        }
      }),
      holdout
    ]))).toThrow("visibilityEvidenceUrl must be bound");
  });

  it("rejects gold-label confidence and excludes it from the canonical corpus hash", () => {
    const holdout = scenario({
      scenarioId: "holdout",
      sourceId: "github:example/holdout:pull/1@deadbeef",
      repository: "example/holdout",
      sourceRevision: SHA_HOLDOUT,
      split: "holdout"
    });
    const clean = corpus([scenario(), holdout]);
    const labelWithConfidence = {
      ...scenario().labels[0],
      confidence: 0.99
    } as unknown as ReviewBenchScenarioV1["labels"][number];
    const contaminated = corpus([scenario({ labels: [labelWithConfidence] }), holdout]);

    expect(() => validateReviewBenchCorpus(contaminated)).toThrow("gold label confidence");
    expect(computeReviewBenchCorpusHash(contaminated)).toBe(computeReviewBenchCorpusHash(clean));
  });

  it("rejects unknown nested fields and keeps them out of corpus identity", () => {
    const holdout = scenario({
      scenarioId: "holdout",
      sourceId: "github:example/holdout:pull/1@deadbeef",
      repository: "example/holdout",
      sourceRevision: SHA_HOLDOUT,
      split: "holdout"
    });
    const clean = corpus([scenario(), holdout]);
    const contaminatedScenario = scenario();
    const verificationWithOutput = {
      ...contaminatedScenario.provenance.verification,
      modelOutput: "candidate-generated text must not enter source evidence"
    };
    const contaminated = corpus([{
      ...contaminatedScenario,
      provenance: {
        ...contaminatedScenario.provenance,
        verification: verificationWithOutput
      }
    } as ReviewBenchScenarioV1, holdout]);

    expect(() => validateReviewBenchCorpus(contaminated)).toThrow("unknown keys");
    expect(computeReviewBenchCorpusHash(contaminated)).toBe(computeReviewBenchCorpusHash(clean));
  });

  it.each([
    ["taskKind", { taskKind: undefined }],
    ["artifactSemantics", { artifactSemantics: undefined }],
    ["oracle", { oracle: undefined }],
    ["license", { license: undefined }],
    ["license.spdxId", { license: { spdxId: "", licenseUrl: "https://example.test/license" } }],
    ["license.licenseUrl", { license: { spdxId: "MIT", licenseUrl: "" } }],
    ["provenance", { provenance: undefined }],
    ["provenance.sourceUrl", { provenance: { ...scenario().provenance, sourceUrl: "" } }],
    ["provenance.sourceArtifactUrl", {
      provenance: { ...scenario().provenance, sourceArtifactUrl: "" }
    }],
    ["provenance.repositoryUrl", { provenance: { ...scenario().provenance, repositoryUrl: "" } }],
    ["provenance.sourceArtifactSha256", {
      provenance: { ...scenario().provenance, sourceArtifactSha256: "not-a-digest" }
    }],
    ["provenance.baseRevision", {
      provenance: { ...scenario().provenance, baseRevision: undefined }
    }],
    ["provenance.visibility", { provenance: { ...scenario().provenance, visibility: "private" } }],
    ["provenance.visibilityEvidenceUrl", {
      provenance: { ...scenario().provenance, visibilityEvidenceUrl: "" }
    }],
    ["provenance.visibilityVerifiedAt", {
      provenance: { ...scenario().provenance, visibilityVerifiedAt: "not-a-date" }
    }],
    ["language", { language: "" }],
    ["language", { language: "TypeScript-ANSWER" }],
    ["split", { split: "other" }],
    ["bugFamily", { bugFamily: "" }],
    ["explicitControl", { explicitControl: undefined }],
    ["labels", { labels: undefined }],
    ["adjudication", { adjudication: undefined }],
    ["adjudication.secondaryAdjudicator", {
      adjudication: {
        status: "independently_adjudicated",
        primaryAdjudicator: "human:a",
        secondaryAdjudicator: "",
        agreement: "agree",
        method: "Independent review.",
        rubricVersion: "review-bench-rubric/v1",
        rubricSha256: sha256(RUBRIC_TEXT),
        protocolVersion: "review-bench-adjudication-protocol/v1",
        protocolSha256: sha256(PROTOCOL_TEXT),
        completedAt: "2026-07-12T00:00:00.000Z"
      }
    }]
  ])("rejects missing or invalid %s metadata", (field, override) => {
    const invalid = corpus([
      scenario(override as Partial<ReviewBenchScenarioV1>),
      scenario({
        scenarioId: "holdout",
        sourceId: "github:example/holdout:pull/1@deadbeef",
        repository: "example/holdout",
        split: "holdout"
      })
    ]);

    expect(() => validateReviewBenchCorpus(invalid)).toThrow(String(field));
  });

  it("rejects duplicate scenario and source identities even when runId differs", () => {
    const holdout = scenario({
      scenarioId: "holdout",
      sourceId: "github:example/holdout:pull/1@deadbeef",
      repository: "example/holdout",
      split: "holdout"
    });

    expect(() => validateReviewBenchCorpus(corpus([
      scenario(),
      scenario({ runId: "rerun-alpha" }),
      holdout
    ]))).toThrow("duplicate scenarioId");

    expect(() => validateReviewBenchCorpus(corpus([
      scenario(),
      scenario({
        scenarioId: "scenario-copy",
        runId: "rerun-copy",
        split: "holdout"
      })
    ]))).toThrow("duplicate sourceId");

    expect(() => validateReviewBenchCorpus(corpus([
      scenario(),
      scenario({
        scenarioId: "scenario-reidentified",
        sourceId: "attacker-controlled-distinct-id",
        runId: "rerun-reidentified"
      }),
      holdout
    ]))).toThrow("duplicate source identity");
  });

  it("rejects duplicate source artifacts across distinct metadata and splits", () => {
    expect(() => validateReviewBenchCorpus(corpus([
      scenario(),
      scenario({
        scenarioId: "cross-split-copy",
        sourceId: "github:example/fork:pull/99@bbbb",
        repository: "example/fork",
        sourceRevision: SHA_BETA,
        bugFamily: "auth",
        split: "holdout",
        provenance: {
          ...scenario({ repository: "example/fork", sourceRevision: SHA_BETA }).provenance,
          sourceArtifactSha256: scenario().provenance.sourceArtifactSha256
        }
      })
    ]))).toThrow("duplicate source artifact");
  });

  it("rejects repository split leakage and unmet holdout floors", () => {
    expect(() => validateReviewBenchCorpus(corpus([
      scenario(),
      scenario({
        scenarioId: "scenario-alpha-holdout",
        sourceId: "github:example/alpha:pull/8@def456",
        repository: "Example/Alpha",
        sourceRevision: SHA_BETA,
        split: "holdout"
      })
    ]))).toThrow("repository split leakage");

    expect(() => validateReviewBenchCorpus({
      ...corpus([scenario()]),
      splitPolicy: {
        repositoryGrouped: true,
        holdoutFloor: { scenarios: 2, repositories: 2, minimumFraction: 0.3 }
      }
    })).toThrow("holdout floor");

    expect(() => validateReviewBenchCorpus({
      ...corpus([
        scenario(),
        scenario({
          scenarioId: "train-two",
          sourceId: "github:example/two:pull/2@beef",
          repository: "example/two",
          sourceRevision: "2".repeat(40)
        }),
        scenario({
          scenarioId: "holdout",
          sourceId: "github:example/holdout:pull/1@deadbeef",
          repository: "example/holdout",
          sourceRevision: SHA_HOLDOUT,
          split: "holdout"
        }),
        scenario({
          scenarioId: "train-three",
          sourceId: "github:example/three:pull/3@cafe",
          repository: "example/three",
          sourceRevision: "3".repeat(40)
        })
      ]),
      splitPolicy: {
        repositoryGrouped: true,
        holdoutFloor: { scenarios: 1, repositories: 1, minimumFraction: 0.3 }
      }
    })).toThrow("holdout fraction");
  });

  it("rejects bug-family split leakage across different repositories", () => {
    expect(() => validateReviewBenchCorpus(corpus([
      scenario({
        scenarioId: "train-family",
        sourceId: "github:example/train-family:pull/1@abc",
        repository: "example/train-family",
        sourceRevision: "4".repeat(40),
        bugFamily: "runtime_correctness",
        split: "train"
      }),
      scenario({
        scenarioId: "holdout-family",
        sourceId: "github:example/holdout-family:pull/2@def",
        repository: "example/holdout-family",
        sourceRevision: "5".repeat(40),
        bugFamily: "runtime_correctness",
        split: "holdout"
      })
    ]))).toThrow("bug-family split leakage");
  });

  it("rejects bug families outside the canonical regression taxonomy", () => {
    expect(() => validateReviewBenchCorpus(corpus([
      scenario({ bugFamily: "state_consistency_alias" }),
      scenario({
        scenarioId: "holdout-canonical-family",
        sourceId: "github:example/holdout-canonical:pull/2@def",
        repository: "example/holdout-canonical",
        sourceRevision: "6".repeat(40),
        bugFamily: "security_boundary",
        split: "holdout"
      })
    ]))).toThrow("canonical regression taxonomy category");
  });

  it("requires explicit controls to have no gold defects and defect scenarios to have labels", () => {
    const holdout = scenario({
      scenarioId: "holdout-control",
      sourceId: "github:example/holdout:pull/1@deadbeef",
      repository: "example/holdout",
      sourceRevision: SHA_HOLDOUT,
      split: "holdout",
      explicitControl: true,
      labels: []
    });

    expect(() => validateReviewBenchCorpus(corpus([
      scenario({ explicitControl: true }),
      holdout
    ]))).toThrow("explicit control");

    expect(() => validateReviewBenchCorpus(corpus([
      scenario({ labels: [] }),
      holdout
    ]))).toThrow("defect scenario");
  });

  it("rejects duplicate gold label identifiers within a scenario", () => {
    const label = scenario().labels[0];
    expect(() => validateReviewBenchCorpus(corpus([
      scenario({ labels: [label, { ...label }] }),
      scenario({
        scenarioId: "holdout",
        sourceId: "github:example/holdout:pull/1@deadbeef",
        repository: "example/holdout",
        sourceRevision: SHA_HOLDOUT,
        split: "holdout"
      })
    ]))).toThrow("duplicate label id");
  });

  it("rejects secret-like text in publishable corpus fields", () => {
    const secret = ["super", "secret", "token"].join("-");
    const label = scenario().labels[0];
    const holdout = scenario({
      scenarioId: "holdout",
      sourceId: "github:example/holdout:pull/1@deadbeef",
      repository: "example/holdout",
      sourceRevision: SHA_HOLDOUT,
      split: "holdout"
    });

    expect(() => validateReviewBenchCorpus(corpus([
      scenario({ labels: [{ ...label, body: `Unsafe fixture ${secret}` }] }),
      holdout
    ]))).toThrow("secret-like text");
    expect(() => validateReviewBenchCorpus(corpus([
      scenario({ runId: `run-${secret}` }),
      holdout
    ]))).toThrow("secret-like text");
  });

  it("rejects unresolved adjudication disagreement and unverified license identifiers", () => {
    const holdout = scenario({
      scenarioId: "holdout",
      sourceId: "github:example/holdout:pull/1@deadbeef",
      repository: "example/holdout",
      sourceRevision: SHA_HOLDOUT,
      split: "holdout"
    });

    expect(() => validateReviewBenchCorpus(corpus([
      scenario({
        adjudication: {
          ...scenario().adjudication,
          agreement: "disagree"
        }
      }),
      holdout
    ]))).toThrow("unresolved adjudication");

    expect(() => validateReviewBenchCorpus(corpus([
      scenario({ license: { spdxId: "NOASSERTION", licenseUrl: "https://example.test/license" } }),
      holdout
    ]))).toThrow("verified SPDX");

    expect(() => validateReviewBenchCorpus(corpus([
      scenario({ license: { spdxId: "Fictional-9.9", licenseUrl: "https://example.test/license" } }),
      holdout
    ]))).toThrow("verified SPDX");

    expect(() => validateReviewBenchCorpus(corpus([
      scenario({ license: { spdxId: "MIT OR Apache-2.0", licenseUrl: scenario().license.licenseUrl } }),
      holdout
    ]))).toThrow("single SPDX identifier");
  });

  it("rejects whitespace and case aliases for the same adjudicator", () => {
    const holdout = scenario({
      scenarioId: "holdout",
      sourceId: "github:example/holdout:pull/1@deadbeef",
      repository: "example/holdout",
      sourceRevision: SHA_HOLDOUT,
      split: "holdout"
    });

    expect(() => validateReviewBenchCorpus(corpus([
      scenario({
        adjudication: {
          ...scenario().adjudication,
          primaryAdjudicator: "human:alice",
          secondaryAdjudicator: " HUMAN:ALICE "
        }
      }),
      holdout
    ]))).toThrow("canonical lowercase ASCII human adjudicator identity");
  });

  it("rejects Unicode-confusable and unnamespaced adjudicator identities", () => {
    const holdout = scenario({
      scenarioId: "holdout-adjudicator-identity",
      sourceId: "github:example/holdout:pull/1@deadbeef",
      repository: "example/holdout",
      sourceRevision: SHA_HOLDOUT,
      split: "holdout"
    });
    expect(() => validateReviewBenchCorpus(corpus([
      scenario({
        adjudication: {
          ...scenario().adjudication,
          secondaryAdjudicator: "human:аlice"
        }
      }),
      holdout
    ]))).toThrow("lowercase ASCII human adjudicator identity");
    expect(() => validateReviewBenchCorpus(corpus([
      scenario({
        adjudication: {
          ...scenario().adjudication,
          secondaryAdjudicator: "alice"
        }
      }),
      holdout
    ]))).toThrow("lowercase ASCII human adjudicator identity");
    expect(() => validateReviewBenchCorpus(corpus([
      scenario({
        adjudication: {
          ...scenario().adjudication,
          secondaryAdjudicator: "agent:alice"
        }
      }),
      holdout
    ]))).toThrow("lowercase ASCII human adjudicator identity");
  });

  it.each([
    "http://github.com/example/alpha/LICENSE",
    "https://user:password@github.com/example/alpha/LICENSE",
    "https://github.com/example/alpha/LICENSE?token=secret",
    "https://localhost/example/alpha/LICENSE",
    "https://127.0.0.1/example/alpha/LICENSE",
    "https://192.168.1.10/example/alpha/LICENSE",
    "https://[::1]/example/alpha/LICENSE"
  ])("rejects non-public or credential-bearing corpus URL %s", (unsafeUrl) => {
    const holdout = scenario({
      scenarioId: "holdout",
      sourceId: "github:example/holdout:pull/1@deadbeef",
      repository: "example/holdout",
      sourceRevision: SHA_HOLDOUT,
      split: "holdout"
    });

    expect(() => validateReviewBenchCorpus(corpus([
      scenario({ license: { spdxId: "MIT", licenseUrl: unsafeUrl } }),
      holdout
    ]))).toThrow("public HTTPS URL");

    expect(() => validateReviewBenchCorpus(corpus([
      scenario({ provenance: { ...scenario().provenance, sourceUrl: unsafeUrl } }),
      holdout
    ]))).toThrow("public HTTPS URL");
  });
});

describe("Review Bench matcher", () => {
  const labels = [{
    id: "label-a",
    path: "src/cache.ts",
    line: 40,
    severity: "P1" as const,
    title: "Cache invalidation loses the latest value",
    body: "The stale write replaces a newer cached value."
  }];

  it("matches within one severity tier and classifies exact and nearby candidates deterministically", () => {
    const result = matchReviewBenchFindings([
      {
        id: "bot-nearby",
        path: "src/cache.ts",
        line: 42,
        severity: "P2",
        confidence: 0.99,
        title: "Stale cache write loses latest value",
        body: "A stale write replaces the newer cached value."
      },
      {
        id: "bot-exact",
        path: "src/cache.ts",
        line: 40,
        severity: "P2",
        confidence: 0.5,
        title: "Cache invalidation loses latest value",
        body: "The stale write replaces a newer cached value."
      }
    ], labels, matcherOptions(() => true));

    expect(result.matches).toEqual([{
      botFindingId: "bot-exact",
      labelId: "label-a",
      classification: "exact"
    }]);
    expect(result.candidates.map((candidate) => [candidate.botFindingId, candidate.classification])).toEqual([
      ["bot-exact", "exact"],
      ["bot-nearby", "nearby"]
    ]);
    expect(result.matcherVersion).toBe(REVIEW_BENCH_MATCHER_VERSION);
    expect(result.matcherIdentity).toEqual(expect.objectContaining({
      matcherVersion: REVIEW_BENCH_MATCHER_VERSION,
      candidateModelId: "model:qwen3-coder-next-q4_k_m",
      candidateTargetFingerprint: CANDIDATE_FINGERPRINT,
      semanticEvaluator: {
        kind: "human",
        id: "evaluator:blinded-human-pair",
        version: "review-bench-semantic/v1",
        evidenceSha256: EVALUATOR_EVIDENCE_SHA256
      },
      lexicalThresholds: { exact: 0.25, nearby: 0.35 },
      semanticDecisionsSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      matcherFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/)
    }));
  });

  it("queues semantic near-misses for human adjudication instead of counting them as matches", () => {
    const result = matchReviewBenchFindings([{
      id: "bot-near-miss",
      path: "src/cache.ts",
      line: 41,
      severity: "P0",
      confidence: 0.8,
      title: "Cache invalidation may lose the latest value",
      body: "A stale write could replace the newer cached value."
    }], labels, matcherOptions(() => false));

    expect(result.matches).toEqual([]);
    expect(result.adjudicationQueue).toEqual([expect.objectContaining({
      botFindingId: "bot-near-miss",
      labelId: "label-a",
      classification: "nearby",
      reason: "semantic_near_miss"
    })]);
  });

  it("does not consider candidates more than one severity tier apart", () => {
    const result = matchReviewBenchFindings([{
      id: "bot-too-severe",
      path: "src/cache.ts",
      line: 40,
      severity: "P3",
      confidence: 1,
      title: "Cache invalidation loses latest value",
      body: "The stale write replaces the newer cached value."
    }], labels, matcherOptions(() => true));

    expect(result.candidates).toEqual([]);
    expect(result.matches).toEqual([]);
  });

  it("does not queue a lower-ranked near miss after the label already matched", () => {
    const result = matchReviewBenchFindings([
      {
        id: "bot-exact",
        path: "src/cache.ts",
        line: 40,
        severity: "P1",
        confidence: 1,
        title: "Cache invalidation loses the latest value",
        body: "The stale write replaces a newer cached value."
      },
      {
        id: "bot-late-near-miss",
        path: "src/cache.ts",
        line: 41,
        severity: "P2",
        confidence: 0.9,
        title: "Cache invalidation might lose latest value",
        body: "A stale write could replace the newer cached value."
      }
    ], labels, matcherOptions((bot) => bot.id === "bot-exact"));

    expect(result.matches).toEqual([{
      botFindingId: "bot-exact",
      labelId: "label-a",
      classification: "exact"
    }]);
    expect(result.adjudicationQueue).toEqual([]);
  });

  it("removes an earlier near-miss from the queue when a later eligible candidate matches the label", () => {
    const result = matchReviewBenchFindings([
      {
        id: "bot-a-near-miss",
        path: "src/cache.ts",
        line: 40,
        severity: "P1",
        confidence: 1,
        title: "Cache invalidation may lose the latest value",
        body: "A stale write could replace the newer cached value."
      },
      {
        id: "bot-z-match",
        path: "src/cache.ts",
        line: 41,
        severity: "P1",
        confidence: 0.5,
        title: "Cache invalidation loses the latest value",
        body: "The stale write replaces a newer cached value."
      }
    ], labels, matcherOptions((bot) => bot.id === "bot-z-match"));

    expect(result.matches).toEqual([{
      botFindingId: "bot-z-match",
      labelId: "label-a",
      classification: "nearby"
    }]);
    expect(result.adjudicationQueue).toEqual([]);
  });

  it("finds a deterministic maximum-cardinality assignment instead of a greedy local optimum", () => {
    const sharedText = {
      path: "src/state.ts",
      severity: "P1" as const,
      title: "State update loses the latest value",
      body: "The stale write replaces the newer state value."
    };
    const twoLabels = [
      { id: "label-one", line: 10, ...sharedText },
      { id: "label-two", line: 12, ...sharedText }
    ];
    const bots = [
      { id: "bot-flexible", line: 10, confidence: 1, ...sharedText },
      { id: "bot-constrained", line: 11, confidence: 0.5, ...sharedText }
    ];
    const options = matcherOptions((bot, label) =>
      bot.id === "bot-flexible" || label.id === "label-one"
    );

    const first = matchReviewBenchFindings(bots, twoLabels, options);
    const permuted = matchReviewBenchFindings([...bots].reverse(), [...twoLabels].reverse(), options);

    expect(first.matches).toEqual([
      { botFindingId: "bot-constrained", labelId: "label-one", classification: "nearby" },
      { botFindingId: "bot-flexible", labelId: "label-two", classification: "nearby" }
    ]);
    expect(permuted.matches).toEqual(first.matches);
    expect(permuted.matcherIdentity).toEqual(first.matcherIdentity);
  });

  it("queues a near-miss when accepting it would unlock a larger matching", () => {
    const sharedText = {
      path: "src/state.ts",
      severity: "P1" as const,
      title: "State update loses the latest value",
      body: "The stale write replaces the newer state value."
    };
    const twoLabels = [
      { id: "label-one", line: 10, ...sharedText },
      { id: "label-two", line: 13, ...sharedText }
    ];
    const bots = [
      { id: "bot-flexible", line: 10, ...sharedText },
      { id: "bot-only-label-one", line: 7, ...sharedText }
    ];

    const result = matchReviewBenchFindings(bots, twoLabels, matcherOptions((bot, label) =>
      !(bot.id === "bot-flexible" && label.id === "label-two")
    ));

    expect(result.matches).toHaveLength(1);
    expect(result.adjudicationQueue).toContainEqual({
      botFindingId: "bot-flexible",
      labelId: "label-two",
      classification: "nearby",
      reason: "semantic_near_miss"
    });
  });

  it("queues a jointly augmenting near-miss cluster even when neither edge augments alone", () => {
    const sharedText = {
      path: "src/state.ts",
      severity: "P1" as const,
      title: "State update loses the latest value",
      body: "The stale write replaces the newer state value."
    };
    const result = matchReviewBenchFindings([
      { id: "bot-one", line: 10, ...sharedText },
      { id: "bot-two", line: 7, ...sharedText }
    ], [
      { id: "label-one", line: 10, ...sharedText },
      { id: "label-two", line: 13, ...sharedText }
    ], matcherOptions((bot, label) => bot.id === "bot-one" && label.id === "label-one"));

    expect(result.matches).toHaveLength(1);
    expect(result.adjudicationQueue).toEqual([
      {
        botFindingId: "bot-two",
        labelId: "label-one",
        classification: "nearby",
        reason: "semantic_near_miss"
      },
      {
        botFindingId: "bot-one",
        labelId: "label-two",
        classification: "nearby",
        reason: "semantic_near_miss"
      }
    ]);
  });

  it("globally optimizes exactness and location after maximizing cardinality", () => {
    const sharedText = {
      path: "src/state.ts",
      severity: "P1" as const,
      title: "State update loses the latest value",
      body: "The stale write replaces the newer state value."
    };
    const result = matchReviewBenchFindings([
      { id: "bot-one", line: 10, confidence: 0.1, ...sharedText },
      { id: "bot-two", line: 11, confidence: 0.2, ...sharedText }
    ], [
      { id: "label-one", line: 10, ...sharedText },
      { id: "label-two", line: 12, ...sharedText }
    ], matcherOptions(() => true));

    expect(result.matches).toEqual([
      { botFindingId: "bot-one", labelId: "label-one", classification: "exact" },
      { botFindingId: "bot-two", labelId: "label-two", classification: "nearby" }
    ]);
  });

  it("rejects duplicate matcher finding identifiers", () => {
    const duplicateBot = {
      id: "duplicate",
      path: "src/cache.ts",
      line: 40,
      severity: "P1" as const,
      title: "Cache invalidation loses the latest value",
      body: "The stale write replaces a newer cached value."
    };
    expect(() => matchReviewBenchFindings(
      [duplicateBot, { ...duplicateBot }],
      labels,
      matcherOptions(() => true)
    )).toThrow("duplicate bot finding id");
    expect(() => matchReviewBenchFindings(
      [duplicateBot],
      [labels[0], { ...labels[0] }],
      matcherOptions(() => true)
    )).toThrow("duplicate label id");
  });

  it("requires an independently identified semantic evaluator", () => {
    expect(() => matchReviewBenchFindings(
      [],
      labels,
      matcherOptions(() => true, {
        candidateModelId: "model:self-judge",
        candidateTargetFingerprint: "f".repeat(64),
        semanticEvaluator: {
          kind: "model",
          id: "evaluator:model:self-judge",
          version: "v1",
          evidenceSha256: EVALUATOR_EVIDENCE_SHA256,
          targetFingerprint: "f".repeat(64)
        }
      })
    )).toThrow("independent semantic evaluator");
  });

  it("rejects model-evaluator aliases that share the candidate target fingerprint", () => {
    expect(() => matchReviewBenchFindings(
      [],
      labels,
      matcherOptions(() => true, {
        candidateModelId: "model:qwen@sha256:abc",
        candidateTargetFingerprint: "9".repeat(64),
        semanticEvaluator: {
          kind: "model",
          id: "evaluator:model:qwen@sha256:abc",
          version: "same-model-alias/v1",
          evidenceSha256: EVALUATOR_EVIDENCE_SHA256,
          targetFingerprint: "9".repeat(64)
        }
      })
    )).toThrow("independent semantic evaluator");
  });
});

describe("legacy eval compatibility", () => {
  it("adapts existing eval inputs without weakening their strict matching behavior", () => {
    const adapted = adaptLegacyEvalScenario({
      runId: "legacy-run",
      repo: "example/legacy",
      pullNumber: 9,
      headSha: "abc123",
      suite: "canary_shadow",
      botFindings: { findings: [] },
      labels: []
    });

    expect(adapted.identity).toEqual({
      scenarioId: "legacy:example/legacy#9@abc123:canary_shadow",
      sourceId: "legacy:example/legacy#9@abc123"
    });
    expect(adapted.matching.severityTolerance).toBe(0);
    expect(adapted.matching.requireSemanticCallback).toBe(false);
  });
});
