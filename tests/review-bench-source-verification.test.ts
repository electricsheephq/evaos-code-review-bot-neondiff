import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  computeReviewBenchSourceVerificationBinding,
  serializeReviewBenchCorpus,
  validateReviewBenchCorpus,
  type ReviewBenchCorpusV1,
  type ReviewBenchScenarioV1
} from "../src/review-bench-corpus.js";
import {
  reverifyReviewBenchCorpusPublicSources,
  verifyGitHubReviewBenchSource
} from "../src/review-bench-source-verification.js";
import {
  buildReviewBenchGitHubFetch,
  runReviewBenchSourceAdmission
} from "../src/review-bench-source-admission.js";
import type { ReviewBenchOracleEvidenceV1 } from "../src/review-bench-semantic-evidence.js";
import {
  computeReviewBenchGoldLabelsSha256,
  serializeReviewBenchOracleEvidence
} from "../src/review-bench-semantic-evidence.js";

const VERIFIED_AT = "2026-07-12T00:00:00.000Z";
const RUBRIC_TEXT = "# review-bench-rubric/v1\nActionability and severity definitions.\n";
const PROTOCOL_TEXT = "# review-bench-adjudication-protocol/v1\nIndependent blinded adjudication.\n";

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function syntheticPemBoundary(): string {
  return ["-----BEGIN PRI", "VATE KEY-----"].join("");
}

function jsonWithInvalidUtf8(prefix: string, suffix = '"}'): Uint8Array {
  const before = new TextEncoder().encode(prefix);
  const after = new TextEncoder().encode(suffix);
  const bytes = new Uint8Array(before.byteLength + 1 + after.byteLength);
  bytes.set(before, 0);
  bytes[before.byteLength] = 0xff;
  bytes.set(after, before.byteLength + 1);
  return bytes;
}

function sourceDiff(marker: string, path = "src/state.ts"): Uint8Array {
  return new TextEncoder().encode([
    `diff --git a/${path} b/${path}`,
    "index 1111111..2222222 100644",
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -9,2 +9,2 @@",
    " const current = readState();",
    `-writeState(\"old-${marker}\");`,
    `+writeState(\"new-${marker}\");`,
    ""
  ].join("\n"));
}

function sourceDiffWithUnrelatedDeletion(marker: string): Uint8Array {
  return new TextEncoder().encode([
    "diff --git a/src/obsolete.ts b/src/obsolete.ts",
    "deleted file mode 100644",
    "index 3333333..0000000",
    "--- a/src/obsolete.ts",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-obsolete();",
    new TextDecoder().decode(sourceDiff(marker))
  ].join("\n"));
}

function pureDeletionDiff(path: string): Uint8Array {
  return new TextEncoder().encode([
    `diff --git a/${path} b/${path}`,
    "deleted file mode 100644",
    "index 3333333..0000000",
    `--- a/${path}`,
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-obsolete();"
  ].join("\n"));
}

function oracleSourceArtifact(scenario: ReviewBenchScenarioV1): Uint8Array {
  return sourceDiff(`oracle-${scenario.repository.replace("/", "-")}`);
}

function cleanObservationArtifact(scenario: ReviewBenchScenarioV1): Uint8Array {
  return new TextEncoder().encode(`clean-observation:${scenario.repository}@${scenario.sourceRevision}\n`);
}

function annotationCandidates(scenario: ReviewBenchScenarioV1) {
  const controlPath = scenario.language === "Go" ? "src/state.go" : "src/state.ts";
  return [
    ...scenario.labels.map((label) => ({
      id: label.id,
      path: label.path,
      line: label.line,
      title: label.title,
      body: label.body
    })),
    ...(scenario.explicitControl ? [{
      id: `candidate-clean:${scenario.repository}`,
      path: controlPath,
      line: 10,
      title: "Potential redundant state update",
      body: "The changed state write might duplicate an earlier update."
    }] : [])
  ].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function draftScenario(input: {
  repository: string;
  revision: string;
  artifact: Uint8Array;
  split: "train" | "holdout";
  control?: boolean;
  language?: ReviewBenchScenarioV1["language"];
}): ReviewBenchScenarioV1 {
  const { repository, revision, artifact, split } = input;
  const control = input.control ?? false;
  const baseRevision = "0".repeat(40);
  const oracleRevision = revision === "f".repeat(40) ? "e".repeat(40) : "f".repeat(40);
  const built = {
    schemaVersion: "review-bench-scenario/v1",
    taskKind: "review_defect_detection",
    artifactSemantics: control ? "verified_clean" : "defect_present",
    oracle: {
      schemaVersion: "review-bench-oracle/v1",
      kind: control ? "clean_adjudication" : "later_fix",
      sourceUrl: control
        ? `https://github.com/${repository}/pull/7`
        : `https://github.com/${repository}/commit/${oracleRevision}`,
      sourceRevision: control ? revision : oracleRevision,
      evidenceSha256: "0".repeat(64),
      defectPresentInReviewedArtifact: !control,
      modelInputExcluded: true
    },
    scenarioId: `${repository}:${split}`,
    sourceId: control
      ? `github:${repository}:pull/7@${revision}`
      : `github:${repository}:commit/${revision}`,
    runId: `ingest:${repository}:${revision}`,
    repository,
    sourceRevision: revision,
    license: {
      spdxId: "MIT",
      licenseUrl: `https://raw.githubusercontent.com/${repository}/${revision}/LICENSE`
    },
    provenance: {
      kind: control ? "pull_request" : "commit",
      repositoryUrl: `https://github.com/${repository}`,
      sourceUrl: control
        ? `https://github.com/${repository}/pull/7`
        : `https://github.com/${repository}/commit/${revision}`,
      sourceArtifactUrl: control
        ? `https://github.com/${repository}/compare/${baseRevision}...${revision}.diff`
        : `https://github.com/${repository}/commit/${revision}.diff`,
      ...(control ? { baseRevision } : {}),
      sourceArtifactSha256: sha256(artifact),
      visibility: "public",
      visibilityEvidenceUrl: `https://api.github.com/repos/${repository}`,
      visibilityVerifiedAt: VERIFIED_AT
    },
    language: input.language ?? "TypeScript",
    split,
    bugFamily: split === "holdout" ? "security_boundary" : "runtime_correctness",
    explicitControl: control,
    labels: control ? [] : [{
      id: `gold:${repository}`,
      path: "src/state.ts",
      line: 10,
      severity: "P1",
      title: "State update loses the latest value",
      body: "A stale write replaces the newer state value."
    }],
    adjudication: {
      status: "independently_adjudicated",
      primaryAdjudicator: "human:one",
      secondaryAdjudicator: "human:two",
      agreement: "agree",
      method: "Independent blinded review.",
      rubricVersion: "review-bench-rubric/v1",
      rubricSha256: sha256(RUBRIC_TEXT),
      protocolVersion: "review-bench-adjudication-protocol/v1",
      protocolSha256: sha256(PROTOCOL_TEXT),
      completedAt: VERIFIED_AT
    }
  } as ReviewBenchScenarioV1;
  built.oracle.evidenceSha256 = sha256(oracleEvidenceBytes(built));
  return built;
}

function oracleEvidence(scenario: ReviewBenchScenarioV1): ReviewBenchOracleEvidenceV1 {
  const sourceEvidenceSha256 = scenario.explicitControl
    ? scenario.provenance.sourceArtifactSha256
    : sha256(oracleSourceArtifact(scenario));
  const candidates = annotationCandidates(scenario);
  const goldById = new Map(scenario.labels.map((label) => [label.id, label]));
  const labels = candidates.map((candidate) => {
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
  const decision = {
    verdict: scenario.artifactSemantics,
    labels,
    rationale: "The exact reviewed artifact and proposed labels were independently inspected.",
    completedAt: VERIFIED_AT,
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
      frozenAt: VERIFIED_AT,
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
        ? "Independent review found no actionable defect in the exact artifact."
        : "Later evidence and source inspection establish the defect in the reviewed artifact.",
      observedAt: VERIFIED_AT
    },
    ...(scenario.explicitControl ? {
      cleanObservation: {
        schemaVersion: "review-bench-clean-observation/v1" as const,
        sourceUrl: `https://github.com/${scenario.repository}/pull/8`,
        sourceRevision: "e".repeat(40),
        sourceEvidenceSha256: sha256(cleanObservationArtifact(scenario)),
        observedThrough: VERIFIED_AT,
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
    primary: {
      adjudicatorId: scenario.adjudication.primaryAdjudicator,
      ...decision
    },
    secondary: {
      adjudicatorId: scenario.adjudication.secondaryAdjudicator,
      ...decision,
      rationale: "A separate blinded pass supports the recorded verdict."
    }
  };
}

function oracleEvidenceBytes(scenario: ReviewBenchScenarioV1): Uint8Array {
  return serializeReviewBenchOracleEvidence(oracleEvidence(scenario));
}

function writeOracleEvidence(artifactsDirectory: string, scenario: ReviewBenchScenarioV1): void {
  const bytes = oracleEvidenceBytes(scenario);
  expect(sha256(bytes)).toBe(scenario.oracle.evidenceSha256);
  writeFileSync(join(artifactsDirectory, `${scenario.oracle.evidenceSha256}.oracle.json`), bytes);
  expect(sha256(RUBRIC_TEXT)).toBe(scenario.adjudication.rubricSha256);
  expect(sha256(PROTOCOL_TEXT)).toBe(scenario.adjudication.protocolSha256);
  writeFileSync(
    join(artifactsDirectory, `${scenario.adjudication.rubricSha256}.rubric.md`),
    RUBRIC_TEXT
  );
  writeFileSync(
    join(artifactsDirectory, `${scenario.adjudication.protocolSha256}.protocol.md`),
    PROTOCOL_TEXT
  );
}

function githubFetch(options: {
  privateRepository?: boolean;
  omitVisibility?: boolean;
  licenseSpdxId?: string;
  sourceArtifact?: Uint8Array;
  sourceArtifactRevision?: string;
  oracleSourceArtifact?: Uint8Array;
  oracleSourceRevision?: string;
  cleanObservationArtifact?: Uint8Array;
  cleanObservationRevision?: string;
  licenseArtifact?: Uint8Array;
  pullHeadSha?: string;
  pullBaseSha?: string;
  pullCommitShas?: string[];
  pullCommitsPaginated?: boolean;
  pullState?: string;
  pullMerged?: boolean;
  pullMergedAt?: string | null;
  pullBaseRef?: string;
  pullMergeCommitSha?: string;
  pullTitle?: string;
  defaultBranch?: string;
  currentDefaultHead?: string;
  serverDate?: string;
  timeline?: unknown[];
  comments?: unknown[];
  reviewComments?: unknown[];
  reviews?: unknown[];
  compareStatus?: string;
  compareBaseRevision?: string;
  oracleCommitDate?: string;
  baselineCommitDate?: string;
} = {}): typeof fetch {
  return vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.hostname === "api.github.com") {
      const parts = url.pathname.replace(/^\/repos\//, "").split("/");
      const repository = `${parts[0]}/${parts[1]}`;
      if (parts[2] === "compare") {
        const [declaredBase, declaredHead] = decodeURIComponent(parts[3] ?? "").split("...");
        const baseRevision = options.compareBaseRevision ?? declaredBase;
        return new Response(JSON.stringify({
          status: options.compareStatus ?? "ahead",
          ahead_by: 1,
          base_commit: {
            sha: baseRevision,
            commit: { committer: { date: options.baselineCommitDate ?? "2026-05-01T00:00:00Z" } }
          },
          merge_base_commit: { sha: baseRevision },
          commits: [{ sha: declaredHead, commit: { message: "Routine maintenance" } }]
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (parts[2] === "pulls" && parts[4] === "commits") {
        return new Response(JSON.stringify(
          (options.pullCommitShas ?? [options.pullHeadSha ?? "a".repeat(40)])
            .map((sha) => ({ sha }))
        ), {
          status: 200,
          headers: {
            "content-type": "application/json",
            ...(options.pullCommitsPaginated ? {
              link: `<https://api.github.com/repos/${repository}/pulls/${parts[3]}/commits?per_page=100&page=2>; rel="next"`
            } : {})
          }
        });
      }
      if (parts[2] === "pulls" && parts[4] === "comments") {
        return Response.json(options.reviewComments ?? []);
      }
      if (parts[2] === "pulls" && parts[4] === "reviews") {
        return Response.json(options.reviews ?? []);
      }
      if (parts[2] === "pulls") {
        const pullNumber = Number(parts[3]);
        const observationPull = pullNumber === 8 && options.cleanObservationRevision !== undefined;
        return new Response(JSON.stringify({
          number: pullNumber,
          state: options.pullState ?? "closed",
          merged: options.pullMerged ?? true,
          merged_at: observationPull
            ? VERIFIED_AT
            : options.pullMergedAt === undefined ? "2026-07-12T00:00:00Z" : options.pullMergedAt,
          merge_commit_sha: observationPull
            ? options.cleanObservationRevision
            : options.pullMergeCommitSha ?? "d".repeat(40),
          title: observationPull ? "Routine observation checkpoint" : options.pullTitle ?? "Make state transitions atomic",
          head: { sha: options.pullHeadSha ?? "a".repeat(40) },
          base: {
            sha: options.pullBaseSha ?? "0".repeat(40),
            ref: options.pullBaseRef ?? "main",
            repo: { full_name: repository }
          }
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (parts[2] === "branches") {
        return Response.json({
          name: decodeURIComponent(parts.slice(3).join("/")),
          commit: { sha: options.currentDefaultHead ?? "e".repeat(40) }
        });
      }
      if (parts[2] === "issues" && parts[4] === "timeline") {
        return Response.json(options.timeline ?? []);
      }
      if (parts[2] === "issues" && parts[4] === "comments") {
        return Response.json(options.comments ?? []);
      }
      if (parts[2] === "commits") {
        return new Response(JSON.stringify({
          sha: parts[3],
          commit: { committer: { date: options.oracleCommitDate ?? VERIFIED_AT } },
          parents: [{ sha: "1".repeat(40) }]
        }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      if (parts[2] === "license") {
        const licenseArtifact = options.licenseArtifact ??
          new TextEncoder().encode("MIT License\nPermission is hereby granted.");
        return new Response(JSON.stringify({
          path: "LICENSE",
          encoding: "base64",
          content: Buffer.from(licenseArtifact).toString("base64"),
          license: { spdx_id: options.licenseSpdxId ?? "MIT" }
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({
        full_name: repository,
        node_id: `node:${repository}`,
        default_branch: options.defaultBranch ?? "main",
        private: options.privateRepository ?? false,
        ...(options.omitVisibility
          ? {}
          : { visibility: options.privateRepository ? "private" : "public" })
      }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          date: options.serverDate ?? "Sun, 12 Jul 2026 00:00:00 GMT"
        }
      });
    }
    if (url.hostname === "raw.githubusercontent.com") {
      return new Response(options.licenseArtifact ?? "MIT License\nPermission is hereby granted.", {
        status: 200,
        headers: { "content-type": "text/plain" }
      });
    }
    if (url.hostname === "github.com" && url.pathname.endsWith(".diff")) {
      const revision = /\/commit\/([a-f0-9]{40,64})\.diff$/.exec(url.pathname)?.[1];
      const artifact = options.oracleSourceRevision !== undefined && revision === options.oracleSourceRevision
        ? options.oracleSourceArtifact
        : options.cleanObservationRevision !== undefined && revision === options.cleanObservationRevision
          ? options.cleanObservationArtifact
          : options.sourceArtifact;
      return new Response(artifact ?? new TextEncoder().encode("unexpected artifact"), {
        status: 200,
        headers: { "content-type": "text/plain" }
      });
    }
    throw new Error(`unexpected URL: ${url.origin}`);
  }) as typeof fetch;
}

function githubFetchForScenario(
  scenario: ReviewBenchScenarioV1,
  sourceArtifact: Uint8Array
): typeof fetch {
  const packet = oracleEvidence(scenario);
  return githubFetch({
    sourceArtifact,
    sourceArtifactRevision: scenario.sourceRevision,
    ...(scenario.provenance.kind === "pull_request" ? {
      pullHeadSha: scenario.sourceRevision,
      pullBaseSha: scenario.provenance.baseRevision,
      pullBaseRef: "main",
      pullMergedAt: "2026-05-01T00:00:00Z",
      pullMergeCommitSha: "d".repeat(40),
      currentDefaultHead: "e".repeat(40)
    } : {}),
    ...(scenario.explicitControl ? {
      cleanObservationRevision: packet.cleanObservation!.sourceRevision,
      cleanObservationArtifact: cleanObservationArtifact(scenario)
    } : {
      oracleSourceRevision: scenario.oracle.sourceRevision,
      oracleSourceArtifact: oracleSourceArtifact(scenario)
    })
  });
}

async function verifiedScenario(input: {
  repository: string;
  revision: string;
  artifact: Uint8Array;
  split: "train" | "holdout";
  control?: boolean;
  language?: ReviewBenchScenarioV1["language"];
}): Promise<ReviewBenchScenarioV1> {
  const draft = draftScenario(input);
  const verification = await verifyGitHubReviewBenchSource({
    scenario: draft,
    sourceArtifact: input.artifact,
    fetchImpl: githubFetch({
      sourceArtifact: input.artifact,
      ...(draft.provenance.kind === "pull_request" ? {
        pullHeadSha: draft.sourceRevision,
        pullBaseSha: draft.provenance.baseRevision,
        pullBaseRef: "main",
        pullMergedAt: "2026-05-01T00:00:00Z"
      } : {})
    }),
    verifiedAt: VERIFIED_AT
  });
  return {
    ...draft,
    provenance: { ...draft.provenance, verification }
  } as ReviewBenchScenarioV1;
}

describe("Review Bench public-source verification", () => {
  it("binds public GitHub metadata, immutable license bytes, and source artifact bytes", async () => {
    const train = await verifiedScenario({
      repository: "example/alpha",
      revision: "a".repeat(40),
      artifact: new TextEncoder().encode("alpha diff"),
      split: "train"
    });
    const holdout = await verifiedScenario({
      repository: "example/beta",
      revision: "b".repeat(40),
      artifact: new TextEncoder().encode("beta diff"),
      split: "holdout"
    });
    const corpus: ReviewBenchCorpusV1 = {
      schemaVersion: "review-bench-corpus/v1",
      corpusVersion: "1.0.0",
      splitPolicy: {
        repositoryGrouped: true,
        holdoutFloor: { scenarios: 1, repositories: 1, minimumFraction: 0.3 }
      },
      scenarios: [train, holdout]
    };

    expect(train.provenance.verification).toEqual(expect.objectContaining({
      schemaVersion: "review-bench-source-verification/v1",
      provider: "github",
      verifierVersion: "github-public-source-ingest/v1",
      repositoryNodeId: "node:example/alpha",
      visibility: "public",
      licenseSpdxId: "MIT",
      repositoryMetadataSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      licenseArtifactSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      bindingSha256: expect.stringMatching(/^[a-f0-9]{64}$/)
    }));
    expect(() => validateReviewBenchCorpus(corpus)).not.toThrow();
  });

  it("binds commit source metadata to the verified repository identity", async () => {
    const artifact = sourceDiff("shared-commit");
    const revision = "a".repeat(40);
    const alpha = draftScenario({
      repository: "example/alpha",
      revision,
      artifact,
      split: "train"
    });
    const beta = draftScenario({
      repository: "example/beta",
      revision,
      artifact,
      split: "train"
    });
    const alphaRecord = await verifyGitHubReviewBenchSource({
      scenario: alpha,
      sourceArtifact: artifact,
      fetchImpl: githubFetch({ sourceArtifact: artifact }),
      verifiedAt: VERIFIED_AT
    });
    const betaRecord = await verifyGitHubReviewBenchSource({
      scenario: beta,
      sourceArtifact: artifact,
      fetchImpl: githubFetch({ sourceArtifact: artifact }),
      verifiedAt: VERIFIED_AT
    });
    expect(alphaRecord.sourceMetadataSha256).not.toBe(betaRecord.sourceMetadataSha256);
  });

  it("rejects private repositories, license mismatches, and artifact hash mismatches", async () => {
    const artifact = new TextEncoder().encode("alpha diff");
    const draft = draftScenario({
      repository: "example/alpha",
      revision: "a".repeat(40),
      artifact,
      split: "train"
    });

    await expect(verifyGitHubReviewBenchSource({
      scenario: draft,
      sourceArtifact: artifact,
      fetchImpl: githubFetch({ privateRepository: true }),
      verifiedAt: VERIFIED_AT
    })).rejects.toThrow("public repository");
    await expect(verifyGitHubReviewBenchSource({
      scenario: draft,
      sourceArtifact: artifact,
      fetchImpl: githubFetch({ omitVisibility: true, sourceArtifact: artifact }),
      verifiedAt: VERIFIED_AT
    })).rejects.toThrow("public repository");
    await expect(verifyGitHubReviewBenchSource({
      scenario: draft,
      sourceArtifact: artifact,
      fetchImpl: githubFetch({ licenseSpdxId: "Apache-2.0", sourceArtifact: artifact }),
      verifiedAt: VERIFIED_AT
    })).rejects.toThrow("license SPDX");
    await expect(verifyGitHubReviewBenchSource({
      scenario: draft,
      sourceArtifact: new TextEncoder().encode("different artifact"),
      fetchImpl: githubFetch(),
      verifiedAt: VERIFIED_AT
    })).rejects.toThrow("source artifact sha256");
    await expect(verifyGitHubReviewBenchSource({
      scenario: draft,
      sourceArtifact: artifact,
      fetchImpl: githubFetch({ sourceArtifact: new TextEncoder().encode("remote mismatch") }),
      verifiedAt: VERIFIED_AT
    })).rejects.toThrow("fetched source artifact sha256");
    await expect(verifyGitHubReviewBenchSource({
      scenario: {
        ...draft,
        provenance: {
          ...draft.provenance,
          sourceUrl: `https://github.com/example/alpha/commit/${"b".repeat(40)}`
        }
      },
      sourceArtifact: artifact,
      fetchImpl: githubFetch({ sourceArtifact: artifact }),
      verifiedAt: VERIFIED_AT
    })).rejects.toThrow("sourceUrl commit revision");
    await expect(verifyGitHubReviewBenchSource({
      scenario: {
        ...draft,
        license: {
          ...draft.license,
          licenseUrl: `https://raw.githubusercontent.com/example/alpha/${"a".repeat(40)}/README.md`
        }
      },
      sourceArtifact: artifact,
      fetchImpl: githubFetch({ sourceArtifact: artifact }),
      verifiedAt: VERIFIED_AT
    })).rejects.toThrow("revision-specific GitHub license path");
  });

  it("rejects malformed UTF-8 in repository and PR JSON metadata", async () => {
    const artifact = sourceDiff("utf8");
    const commitDraft = draftScenario({
      repository: "example/alpha",
      revision: "a".repeat(40),
      artifact,
      split: "train"
    });
    const normalCommitFetch = githubFetch({ sourceArtifact: artifact });
    const malformedRepositoryFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/repos/example/alpha") {
        return new Response(jsonWithInvalidUtf8(
          '{"full_name":"example/alpha","node_id":"node","private":false,"visibility":"public","ignored":"'
        ));
      }
      return normalCommitFetch(input, init);
    }) as typeof fetch;
    await expect(verifyGitHubReviewBenchSource({
      scenario: commitDraft,
      sourceArtifact: artifact,
      fetchImpl: malformedRepositoryFetch,
      verifiedAt: VERIFIED_AT
    })).rejects.toThrow("valid UTF-8 JSON");

    const pullDraft = draftScenario({
      repository: "example/beta",
      revision: "b".repeat(40),
      artifact,
      split: "holdout",
      control: true
    });
    const normalPullFetch = githubFetch({
      sourceArtifact: artifact,
      pullHeadSha: pullDraft.sourceRevision,
      pullBaseSha: pullDraft.provenance.baseRevision,
      pullMergedAt: "2026-05-01T00:00:00Z"
    });
    const malformedPullFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/repos/example/beta/pulls/7") {
        return new Response(jsonWithInvalidUtf8(
          `{"number":7,"state":"closed","merged":true,"merged_at":"2026-05-01T00:00:00Z",` +
          `"head":{"sha":"${pullDraft.sourceRevision}"},` +
          `"base":{"sha":"${pullDraft.provenance.baseRevision}","repo":{"full_name":"example/beta"}},` +
          '"ignored":"'
        ));
      }
      return normalPullFetch(input, init);
    }) as typeof fetch;
    await expect(verifyGitHubReviewBenchSource({
      scenario: pullDraft,
      sourceArtifact: artifact,
      fetchImpl: malformedPullFetch,
      verifiedAt: VERIFIED_AT
    })).rejects.toThrow("valid UTF-8 JSON");
  });

  it("rejects secret-like source diff bytes before any network request", async () => {
    const artifact = new TextEncoder().encode([
      "diff --git a/key.txt b/key.txt",
      "--- a/key.txt",
      "+++ b/key.txt",
      "@@ -0,0 +1 @@",
      `+${syntheticPemBoundary()}`,
      ""
    ].join("\n"));
    const draft = draftScenario({
      repository: "example/alpha",
      revision: "a".repeat(40),
      artifact,
      split: "train"
    });
    const fetchImpl = vi.fn() as unknown as typeof fetch;

    await expect(verifyGitHubReviewBenchSource({
      scenario: draft,
      sourceArtifact: artifact,
      fetchImpl,
      verifiedAt: VERIFIED_AT
    })).rejects.toThrow("secret-like text");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("binds pull-request provenance to the merged PR commit set without mutable branch tips", async () => {
    const artifact = new TextEncoder().encode("first commit change\nsecond commit change");
    const revision = "a".repeat(40);
    const baseRevision = "0".repeat(40);
    const commitDraft = draftScenario({
      repository: "example/alpha",
      revision,
      artifact,
      split: "train"
    });
    const pullDraft = {
      ...commitDraft,
      provenance: {
        ...commitDraft.provenance,
        kind: "pull_request" as const,
        baseRevision,
        sourceUrl: "https://github.com/example/alpha/pull/7",
        sourceArtifactUrl: `https://github.com/example/alpha/compare/${baseRevision}...${revision}.diff`
      }
    } as ReviewBenchScenarioV1;

    const successfulFetch = githubFetch({
      sourceArtifact: artifact,
      pullHeadSha: "b".repeat(40),
      pullBaseSha: "f".repeat(40),
      pullCommitShas: ["1".repeat(40), revision]
    });
    const stableRecord = await verifyGitHubReviewBenchSource({
      scenario: pullDraft,
      sourceArtifact: artifact,
      fetchImpl: successfulFetch,
      verifiedAt: VERIFIED_AT
    });
    expect(stableRecord).toEqual(expect.objectContaining({
      sourceMetadataSha256: expect.stringMatching(/^[a-f0-9]{64}$/)
    }));
    expect(vi.mocked(successfulFetch).mock.calls.map(([url]) => String(url))).toContain(
      `https://github.com/example/alpha/compare/${baseRevision}...${revision}.diff`
    );
    await expect(verifyGitHubReviewBenchSource({
      scenario: pullDraft,
      sourceArtifact: artifact,
      fetchImpl: githubFetch({
        sourceArtifact: artifact,
        pullHeadSha: "b".repeat(40),
        pullBaseSha: "f".repeat(40),
        pullCommitShas: ["1".repeat(40), "b".repeat(40)]
      }),
      verifiedAt: VERIFIED_AT
    })).rejects.toThrow("final PR commit");
    await expect(verifyGitHubReviewBenchSource({
      scenario: pullDraft,
      sourceArtifact: artifact,
      fetchImpl: githubFetch({
        sourceArtifact: artifact,
        pullCommitShas: ["1".repeat(41), revision]
      }),
      verifiedAt: VERIFIED_AT
    })).rejects.toThrow("immutable revision");
    await expect(verifyGitHubReviewBenchSource({
      scenario: pullDraft,
      sourceArtifact: artifact,
      fetchImpl: githubFetch({
        sourceArtifact: artifact,
        pullHeadSha: "b".repeat(40),
        pullBaseSha: "f".repeat(40),
        pullCommitShas: [revision],
        pullCommitsPaginated: true
      }),
      verifiedAt: VERIFIED_AT
    })).rejects.toThrow("bounded exhaustive page");
    await expect(verifyGitHubReviewBenchSource({
      scenario: pullDraft,
      sourceArtifact: artifact,
      fetchImpl: githubFetch({
        sourceArtifact: artifact,
        pullHeadSha: revision,
        pullBaseSha: baseRevision,
        pullState: "open",
        pullMerged: false,
        pullMergedAt: null
      }),
      verifiedAt: VERIFIED_AT
    })).rejects.toThrow("closed and merged");
    await expect(verifyGitHubReviewBenchSource({
      scenario: pullDraft,
      sourceArtifact: artifact,
      fetchImpl: githubFetch({
        sourceArtifact: artifact,
        pullHeadSha: revision,
        pullBaseSha: baseRevision,
        pullMergedAt: "not-a-date"
      }),
      verifiedAt: VERIFIED_AT
    })).rejects.toThrow("merged_at");
  });

  it("rejects tampering with a stored source-verification record", async () => {
    const train = await verifiedScenario({
      repository: "example/alpha",
      revision: "a".repeat(40),
      artifact: new TextEncoder().encode("alpha diff"),
      split: "train"
    });
    const tampered = {
      ...train,
      provenance: {
        ...train.provenance,
        verification: {
          ...train.provenance.verification,
          repositoryNodeId: "node:unrelated"
        }
      }
    } as ReviewBenchScenarioV1;
    const holdout = await verifiedScenario({
      repository: "example/beta",
      revision: "b".repeat(40),
      artifact: new TextEncoder().encode("beta diff"),
      split: "holdout"
    });

    expect(() => validateReviewBenchCorpus({
      schemaVersion: "review-bench-corpus/v1",
      corpusVersion: "1.0.0",
      splitPolicy: {
        repositoryGrouped: true,
        holdoutFloor: { scenarios: 1, repositories: 1, minimumFraction: 0.3 }
      },
      scenarios: [tampered, holdout]
    })).toThrow("verification binding");
  });

  it("re-fetches every source and rejects a forged but internally recomputed record", async () => {
    const artifact = new TextEncoder().encode("alpha diff");
    const train = await verifiedScenario({
      repository: "example/alpha",
      revision: "a".repeat(40),
      artifact,
      split: "train"
    });
    const holdoutArtifact = new TextEncoder().encode("beta diff");
    const holdout = await verifiedScenario({
      repository: "example/beta",
      revision: "b".repeat(40),
      artifact: holdoutArtifact,
      split: "holdout"
    });
    const forged = {
      ...train,
      provenance: {
        ...train.provenance,
        verification: {
          ...train.provenance.verification,
          repositoryNodeId: "node:forged",
          bindingSha256: "0".repeat(64)
        }
      }
    } as ReviewBenchScenarioV1;
    forged.provenance.verification.bindingSha256 = computeReviewBenchSourceVerificationBinding(forged);
    const corpus: ReviewBenchCorpusV1 = {
      schemaVersion: "review-bench-corpus/v1",
      corpusVersion: "1.0.0",
      splitPolicy: {
        repositoryGrouped: true,
        holdoutFloor: { scenarios: 1, repositories: 1, minimumFraction: 0.3 }
      },
      scenarios: [forged, holdout]
    };

    expect(() => validateReviewBenchCorpus(corpus)).not.toThrow();
    await expect(reverifyReviewBenchCorpusPublicSources({
      corpus,
      sourceArtifactFor: (scenario) => scenario.repository === "example/alpha" ? artifact : holdoutArtifact,
      fetchImpl: vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        const repository = url.pathname.includes("example/beta") ? "example/beta" : "example/alpha";
        const sourceArtifact = repository === "example/beta" ? holdoutArtifact : artifact;
        return githubFetch({ sourceArtifact })(input, init);
      }) as typeof fetch
    })).rejects.toThrow("stored source verification differs");
  });

  it("makes live re-verification mandatory in the corpus admission command and persists its receipt", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-review-bench-admission-"));
    try {
      const artifactsDirectory = join(root, "artifacts");
      mkdirSync(artifactsDirectory);
      const alphaArtifact = sourceDiffWithUnrelatedDeletion("alpha");
      const betaArtifact = sourceDiff("beta", "src/state.go");
      const train = await verifiedScenario({
        repository: "example/alpha",
        revision: "a".repeat(40),
        artifact: alphaArtifact,
        split: "train"
      });
      const holdout = await verifiedScenario({
        repository: "example/beta",
        revision: "b".repeat(40),
        artifact: betaArtifact,
        split: "holdout",
        control: true,
        language: "Go"
      });
      const corpus: ReviewBenchCorpusV1 = {
        schemaVersion: "review-bench-corpus/v1",
        corpusVersion: "1.0.0",
        splitPolicy: {
          repositoryGrouped: true,
          holdoutFloor: { scenarios: 1, repositories: 1, minimumFraction: 0.3 }
        },
        scenarios: [train, holdout]
      };
      const corpusPath = join(root, "corpus.json");
      const receiptPath = join(root, "receipt.json");
      writeFileSync(corpusPath, `${serializeReviewBenchCorpus(corpus)}\n`);
      writeFileSync(join(artifactsDirectory, `${train.provenance.sourceArtifactSha256}.diff`), alphaArtifact);
      writeFileSync(join(artifactsDirectory, `${holdout.provenance.sourceArtifactSha256}.diff`), betaArtifact);
      writeOracleEvidence(artifactsDirectory, train);
      writeOracleEvidence(artifactsDirectory, holdout);
      let oracleCallsBeforeVisibility = 0;
      const privateFetchBase = githubFetch({ privateRepository: true, sourceArtifact: alphaArtifact });
      const privateFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        if (url.pathname !== "/repos/example/alpha") oracleCallsBeforeVisibility += 1;
        return privateFetchBase(input, init);
      }) as typeof fetch;
      await expect(runReviewBenchSourceAdmission({
        corpusPath,
        artifactsDirectory,
        receiptPath: join(root, "private-repository-receipt.json"),
        fetchImpl: privateFetch,
        admittedAt: VERIFIED_AT
      })).rejects.toThrow("public repository");
      expect(oracleCallsBeforeVisibility).toBe(0);
      const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const selectedScenario = new URL(String(input)).pathname.includes("example/beta")
          ? holdout
          : train;
        const sourceArtifact = selectedScenario === holdout ? betaArtifact : alphaArtifact;
        return githubFetchForScenario(selectedScenario, sourceArtifact)(input, init);
      }) as typeof fetch;

      const receipt = await runReviewBenchSourceAdmission({
        corpusPath,
        artifactsDirectory,
        receiptPath,
        fetchImpl,
        admittedAt: VERIFIED_AT
      });
      expect(JSON.parse(readFileSync(receiptPath, "utf8"))).toEqual(receipt);
      expect(receipt).toEqual(expect.objectContaining({
        schemaVersion: "review-bench-source-admission-receipt/v1",
        corpusHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        verificationEvidenceSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        semanticEvidenceVersion: "review-bench-oracle-evidence/v2",
        semanticEvidenceVerifierVersion: "review-bench-semantic-admission/v3",
        semanticEvidenceSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        oracleSourceVerifierVersion: "github-oracle-source-verifier/v2",
        oracleSourceVerificationSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        adjudicationAgreementVersion: "review-bench-adjudication-agreement/v3",
        adjudicationScenarioCount: 2,
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
        p0p1LabelCount: 1,
        severityAgreementLabelCount: 1,
        severityWithinOneTierAgreement: 1,
        scenarioCount: 2,
        defectScenarioCount: 1,
        cleanControlCount: 1,
        languageCount: 1,
        repositoryCount: 2,
        admittedAt: VERIFIED_AT
      }));
      const generatedReceiptGate = spawnSync("node", [
        "scripts/check-review-bench-admission-receipt.mjs",
        "--live",
        receiptPath,
        "--committed",
        receiptPath
      ], { cwd: process.cwd(), encoding: "utf8" });
      expect(generatedReceiptGate.status).not.toBe(0);
      expect(`${generatedReceiptGate.stdout}\n${generatedReceiptGate.stderr}`).toContain("invalid fields");
      const originalReceipt = readFileSync(receiptPath, "utf8");
      await expect(runReviewBenchSourceAdmission({
        corpusPath,
        artifactsDirectory,
        receiptPath,
        fetchImpl,
        admittedAt: VERIFIED_AT
      })).rejects.toMatchObject({ code: "EEXIST" });
      expect(readFileSync(receiptPath, "utf8")).toBe(originalReceipt);

      const languageMismatch = {
        ...train,
        language: "Go"
      } as ReviewBenchScenarioV1;
      writeFileSync(
        corpusPath,
        `${serializeReviewBenchCorpus({ ...corpus, scenarios: [languageMismatch, holdout] })}\n`
      );
      const languageMismatchReceipt = join(root, "language-mismatch-receipt.json");
      await expect(runReviewBenchSourceAdmission({
        corpusPath,
        artifactsDirectory,
        receiptPath: languageMismatchReceipt,
        fetchImpl,
        admittedAt: VERIFIED_AT
      })).rejects.toThrow("declared language Go");
      expect(existsSync(languageMismatchReceipt)).toBe(false);
      writeFileSync(corpusPath, `${serializeReviewBenchCorpus(corpus)}\n`);

      const deletionArtifact = pureDeletionDiff("src/obsolete.go");
      const deletionDraft = await verifiedScenario({
        repository: "example/gamma",
        revision: "c".repeat(40),
        artifact: deletionArtifact,
        split: "train",
        control: true,
        language: "Go"
      });
      const deletionPacket = oracleEvidence(deletionDraft);
      deletionPacket.annotationUniverse.candidates = [];
      deletionPacket.primary.labels = [];
      deletionPacket.secondary.labels = [];
      const deletionEvidence = serializeReviewBenchOracleEvidence(deletionPacket);
      const deletionControl = {
        ...deletionDraft,
        oracle: { ...deletionDraft.oracle, evidenceSha256: sha256(deletionEvidence) }
      } as ReviewBenchScenarioV1;
      const deletionCorpus = { ...corpus, scenarios: [train, deletionControl, holdout] };
      writeFileSync(corpusPath, `${serializeReviewBenchCorpus(deletionCorpus)}\n`);
      writeFileSync(
        join(artifactsDirectory, `${deletionControl.provenance.sourceArtifactSha256}.diff`),
        deletionArtifact
      );
      writeFileSync(
        join(artifactsDirectory, `${deletionControl.oracle.evidenceSha256}.oracle.json`),
        deletionEvidence
      );
      const deletionFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const path = new URL(String(input)).pathname;
        const selectedScenario = path.includes("example/gamma")
          ? deletionControl
          : path.includes("example/beta") ? holdout : train;
        const sourceArtifact = selectedScenario === deletionControl
          ? deletionArtifact
          : selectedScenario === holdout ? betaArtifact : alphaArtifact;
        return githubFetchForScenario(selectedScenario, sourceArtifact)(input, init);
      }) as typeof fetch;
      await expect(runReviewBenchSourceAdmission({
        corpusPath,
        artifactsDirectory,
        receiptPath: join(root, "deletion-only-language-receipt.json"),
        fetchImpl: deletionFetch,
        admittedAt: VERIFIED_AT
      })).resolves.toEqual(expect.objectContaining({ cleanControlCount: 2 }));
      writeFileSync(corpusPath, `${serializeReviewBenchCorpus(corpus)}\n`);

      const racedParent = join(root, "receipt-parent");
      const movedParent = join(root, "receipt-parent-original");
      const replacementParent = join(root, "receipt-parent-replacement");
      mkdirSync(racedParent);
      mkdirSync(replacementParent);
      let replaced = false;
      const racedFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (!replaced) {
          replaced = true;
          renameSync(racedParent, movedParent);
          symlinkSync(replacementParent, racedParent, "dir");
        }
        return fetchImpl(input, init);
      }) as typeof fetch;
      await expect(runReviewBenchSourceAdmission({
        corpusPath,
        artifactsDirectory,
        receiptPath: join(racedParent, "receipt.json"),
        fetchImpl: racedFetch,
        admittedAt: VERIFIED_AT
      })).rejects.toThrow("receipt parent directory changed");
      expect(existsSync(join(replacementParent, "receipt.json"))).toBe(false);

      const nonexistentOracleFetch = vi.fn(async (
        input: string | URL | Request,
        init?: RequestInit
      ) => {
        const url = new URL(String(input));
        if (url.pathname === `/repos/${train.repository}/commits/${train.oracle.sourceRevision}`) {
          return new Response("not found", { status: 404 });
        }
        return fetchImpl(input, init);
      }) as typeof fetch;
      const nonexistentOracleReceiptPath = join(root, "nonexistent-oracle-receipt.json");
      await expect(runReviewBenchSourceAdmission({
        corpusPath,
        artifactsDirectory,
        receiptPath: nonexistentOracleReceiptPath,
        fetchImpl: nonexistentOracleFetch,
        admittedAt: VERIFIED_AT
      })).rejects.toThrow("oracle commit metadata");
      expect(nonexistentOracleFetch).toHaveBeenCalledWith(
        new URL(`https://api.github.com/repos/${train.repository}/commits/${train.oracle.sourceRevision}`),
        expect.objectContaining({ redirect: "error" })
      );
      expect(existsSync(nonexistentOracleReceiptPath)).toBe(false);

      const rubricPath = join(
        artifactsDirectory,
        `${train.adjudication.rubricSha256}.rubric.md`
      );
      writeFileSync(rubricPath, "# review-bench-rubric/v1\nTampered rubric.\n");
      const rubricReceiptPath = join(root, "tampered-rubric-receipt.json");
      const rubricFetch = vi.fn() as unknown as typeof fetch;
      await expect(runReviewBenchSourceAdmission({
        corpusPath,
        artifactsDirectory,
        receiptPath: rubricReceiptPath,
        fetchImpl: rubricFetch,
        admittedAt: VERIFIED_AT
      })).rejects.toThrow("rubric artifact");
      expect(rubricFetch).not.toHaveBeenCalled();
      expect(existsSync(rubricReceiptPath)).toBe(false);
      writeFileSync(rubricPath, RUBRIC_TEXT);

      const canonicalCorpusBytes = Buffer.from(`${serializeReviewBenchCorpus(corpus)}\n`);
      const runIdBytes = Buffer.from(train.runId);
      const runIdOffset = canonicalCorpusBytes.indexOf(runIdBytes);
      expect(runIdOffset).toBeGreaterThanOrEqual(0);
      const invalidUtf8Corpus = Buffer.concat([
        canonicalCorpusBytes.subarray(0, runIdOffset),
        Buffer.from([0xff]),
        canonicalCorpusBytes.subarray(runIdOffset + 1)
      ]);
      writeFileSync(corpusPath, invalidUtf8Corpus);
      const utf8ReceiptPath = join(root, "invalid-utf8-receipt.json");
      const utf8Fetch = vi.fn() as unknown as typeof fetch;
      await expect(runReviewBenchSourceAdmission({
        corpusPath,
        artifactsDirectory,
        receiptPath: utf8ReceiptPath,
        fetchImpl: utf8Fetch,
        admittedAt: VERIFIED_AT
      })).rejects.toThrow("valid UTF-8 JSON");
      expect(utf8Fetch).not.toHaveBeenCalled();
      expect(existsSync(utf8ReceiptPath)).toBe(false);

      const canonicalCorpus = serializeReviewBenchCorpus(corpus);
      writeFileSync(
        corpusPath,
        `{"schemaVersion":"review-bench-corpus/v0",${canonicalCorpus.slice(1)}`
      );
      const duplicateKeyReceiptPath = join(root, "duplicate-key-receipt.json");
      const duplicateKeyFetch = vi.fn() as unknown as typeof fetch;
      await expect(runReviewBenchSourceAdmission({
        corpusPath,
        artifactsDirectory,
        receiptPath: duplicateKeyReceiptPath,
        fetchImpl: duplicateKeyFetch,
        admittedAt: VERIFIED_AT
      })).rejects.toThrow("canonical JSON without duplicate keys");
      expect(duplicateKeyFetch).not.toHaveBeenCalled();
      expect(existsSync(duplicateKeyReceiptPath)).toBe(false);

      writeFileSync(corpusPath, `${canonicalCorpus}\n`);
      writeFileSync(
        join(artifactsDirectory, `${holdout.provenance.sourceArtifactSha256}.diff`),
        sourceDiff("wrong-digest")
      );
      const digestReceiptPath = join(root, "bad-digest-receipt.json");
      const digestFetch = vi.fn() as unknown as typeof fetch;
      await expect(runReviewBenchSourceAdmission({
        corpusPath,
        artifactsDirectory,
        receiptPath: digestReceiptPath,
        fetchImpl: digestFetch,
        admittedAt: VERIFIED_AT
      })).rejects.toThrow("source artifact sha256 does not match its declared digest");
      expect(digestFetch).not.toHaveBeenCalled();
      expect(existsSync(digestReceiptPath)).toBe(false);
      writeFileSync(
        join(artifactsDirectory, `${holdout.provenance.sourceArtifactSha256}.diff`),
        betaArtifact
      );

      const poisonedPacket = {
        ...oracleEvidence(holdout),
        scenarioId: "unrelated-scenario"
      };
      const poisonedBytes = serializeReviewBenchOracleEvidence(poisonedPacket);
      const poisonedHoldout = {
        ...holdout,
        oracle: { ...holdout.oracle, evidenceSha256: sha256(poisonedBytes) }
      } as ReviewBenchScenarioV1;
      writeFileSync(
        join(artifactsDirectory, `${poisonedHoldout.oracle.evidenceSha256}.oracle.json`),
        poisonedBytes
      );
      writeFileSync(
        corpusPath,
        `${serializeReviewBenchCorpus({ ...corpus, scenarios: [train, poisonedHoldout] })}\n`
      );
      const semanticReceiptPath = join(root, "poisoned-semantic-receipt.json");
      const semanticFetch = vi.fn() as unknown as typeof fetch;
      await expect(runReviewBenchSourceAdmission({
        corpusPath,
        artifactsDirectory,
        receiptPath: semanticReceiptPath,
        fetchImpl: semanticFetch,
        admittedAt: VERIFIED_AT
      })).rejects.toThrow("scenarioId does not match");
      expect(semanticFetch).not.toHaveBeenCalled();
      expect(existsSync(semanticReceiptPath)).toBe(false);

      const secretArtifact = sourceDiff(syntheticPemBoundary());
      const secretVerification = {
        ...train.provenance.verification,
        sourceArtifactSha256: sha256(secretArtifact),
        bindingSha256: "0".repeat(64)
      };
      let secretTrain = {
        ...train,
        provenance: {
          ...train.provenance,
          sourceArtifactSha256: sha256(secretArtifact),
          verification: secretVerification
        }
      } as ReviewBenchScenarioV1;
      secretVerification.bindingSha256 = computeReviewBenchSourceVerificationBinding(secretTrain);
      const secretEvidenceBytes = oracleEvidenceBytes(secretTrain);
      secretTrain = {
        ...secretTrain,
        oracle: { ...secretTrain.oracle, evidenceSha256: sha256(secretEvidenceBytes) }
      };
      writeFileSync(
        join(artifactsDirectory, `${secretTrain.provenance.sourceArtifactSha256}.diff`),
        secretArtifact
      );
      writeFileSync(
        join(artifactsDirectory, `${secretTrain.oracle.evidenceSha256}.oracle.json`),
        secretEvidenceBytes
      );
      writeFileSync(
        corpusPath,
        `${serializeReviewBenchCorpus({ ...corpus, scenarios: [secretTrain, holdout] })}\n`
      );
      const secretReceiptPath = join(root, "secret-source-receipt.json");
      const secretFetch = vi.fn() as unknown as typeof fetch;
      await expect(runReviewBenchSourceAdmission({
        corpusPath,
        artifactsDirectory,
        receiptPath: secretReceiptPath,
        fetchImpl: secretFetch,
        admittedAt: VERIFIED_AT
      })).rejects.toThrow("secret-like text");
      expect(secretFetch).not.toHaveBeenCalled();
      expect(existsSync(secretReceiptPath)).toBe(false);

      writeFileSync(corpusPath, `${serializeReviewBenchCorpus(corpus)}\n`);

      for (const [name, labelOverride] of [
        ["missing-path", { path: "src/does-not-exist.ts" }],
        ["deleted-file", { path: "src/obsolete.ts", line: 1 }],
        ["outside-hunk", { line: 999_999 }]
      ] as const) {
        let invalidAnchor = {
          ...train,
          labels: [{ ...train.labels[0], ...labelOverride }]
        } as ReviewBenchScenarioV1;
        const invalidEvidenceBytes = oracleEvidenceBytes(invalidAnchor);
        invalidAnchor = {
          ...invalidAnchor,
          oracle: { ...invalidAnchor.oracle, evidenceSha256: sha256(invalidEvidenceBytes) }
        };
        writeFileSync(
          join(artifactsDirectory, `${invalidAnchor.oracle.evidenceSha256}.oracle.json`),
          invalidEvidenceBytes
        );
        const invalidCorpus = { ...corpus, scenarios: [invalidAnchor, holdout] };
        expect(() => validateReviewBenchCorpus(invalidCorpus)).not.toThrow();
        writeFileSync(corpusPath, `${serializeReviewBenchCorpus(invalidCorpus)}\n`);
        const invalidReceiptPath = join(root, `${name}-receipt.json`);
        await expect(runReviewBenchSourceAdmission({
          corpusPath,
          artifactsDirectory,
          receiptPath: invalidReceiptPath,
          fetchImpl,
          admittedAt: VERIFIED_AT
        })).rejects.toThrow("gold label anchor");
        expect(existsSync(invalidReceiptPath)).toBe(false);
      }

      const paddedPacket = oracleEvidence(train);
      paddedPacket.annotationUniverse.candidates.push({
        id: "candidate-padding",
        path: "src/not-in-diff.ts",
        line: 1,
        title: "Padding candidate",
        body: "This candidate is not anchored in the reviewed source artifact."
      });
      paddedPacket.primary.labels = [...paddedPacket.primary.labels, {
        labelId: "candidate-padding",
        actionability: "not_actionable"
      }];
      paddedPacket.secondary.labels = [...paddedPacket.secondary.labels, {
        labelId: "candidate-padding",
        actionability: "not_actionable"
      }];
      paddedPacket.annotationUniverse.candidates.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      paddedPacket.primary.labels.sort((a, b) => a.labelId < b.labelId ? -1 : a.labelId > b.labelId ? 1 : 0);
      paddedPacket.secondary.labels.sort((a, b) => a.labelId < b.labelId ? -1 : a.labelId > b.labelId ? 1 : 0);
      const paddedBytes = serializeReviewBenchOracleEvidence(paddedPacket);
      const paddedTrain = {
        ...train,
        oracle: { ...train.oracle, evidenceSha256: sha256(paddedBytes) }
      } as ReviewBenchScenarioV1;
      writeFileSync(
        join(artifactsDirectory, `${paddedTrain.oracle.evidenceSha256}.oracle.json`),
        paddedBytes
      );
      writeFileSync(
        corpusPath,
        `${serializeReviewBenchCorpus({ ...corpus, scenarios: [paddedTrain, holdout] })}\n`
      );
      const paddedReceiptPath = join(root, "padded-candidate-receipt.json");
      const paddedFetch = vi.fn() as unknown as typeof fetch;
      await expect(runReviewBenchSourceAdmission({
        corpusPath,
        artifactsDirectory,
        receiptPath: paddedReceiptPath,
        fetchImpl: paddedFetch,
        admittedAt: VERIFIED_AT
      })).rejects.toThrow("annotation candidate anchor");
      expect(paddedFetch).not.toHaveBeenCalled();
      expect(existsSync(paddedReceiptPath)).toBe(false);

      const forged = {
        ...train,
        provenance: {
          ...train.provenance,
          verification: {
            ...train.provenance.verification,
            repositoryNodeId: "node:forged",
            bindingSha256: "0".repeat(64)
          }
        }
      } as ReviewBenchScenarioV1;
      forged.provenance.verification.bindingSha256 = computeReviewBenchSourceVerificationBinding(forged);
      writeFileSync(
        corpusPath,
        `${serializeReviewBenchCorpus({ ...corpus, scenarios: [forged, holdout] })}\n`
      );
      const forgedReceiptPath = join(root, "forged-receipt.json");
      await expect(runReviewBenchSourceAdmission({
        corpusPath,
        artifactsDirectory,
        receiptPath: forgedReceiptPath,
        fetchImpl,
        admittedAt: VERIFIED_AT
      })).rejects.toThrow("stored source verification differs");
      expect(existsSync(forgedReceiptPath)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects line-amplification diffs before network verification or receipt creation", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-review-bench-line-budget-"));
    try {
      const artifactsDirectory = join(root, "artifacts");
      mkdirSync(artifactsDirectory);
      const oversizedArtifact = new TextEncoder().encode([
        "diff --git a/src/state.ts b/src/state.ts",
        "index 1111111..2222222 100644",
        "--- /dev/null",
        "+++ b/src/state.ts",
        "@@ -0,0 +1,250000 @@",
        "+value\n".repeat(250_000)
      ].join("\n"));
      const holdoutArtifact = sourceDiff("holdout");
      const train = await verifiedScenario({
        repository: "example/alpha",
        revision: "a".repeat(40),
        artifact: oversizedArtifact,
        split: "train"
      });
      const holdout = await verifiedScenario({
        repository: "example/beta",
        revision: "b".repeat(40),
        artifact: holdoutArtifact,
        split: "holdout"
      });
      const corpus: ReviewBenchCorpusV1 = {
        schemaVersion: "review-bench-corpus/v1",
        corpusVersion: "1.0.0",
        splitPolicy: {
          repositoryGrouped: true,
          holdoutFloor: { scenarios: 1, repositories: 1, minimumFraction: 0.3 }
        },
        scenarios: [train, holdout]
      };
      const corpusPath = join(root, "corpus.json");
      const receiptPath = join(root, "receipt.json");
      writeFileSync(corpusPath, `${serializeReviewBenchCorpus(corpus)}\n`);
      writeFileSync(join(artifactsDirectory, `${train.provenance.sourceArtifactSha256}.diff`), oversizedArtifact);
      writeFileSync(join(artifactsDirectory, `${holdout.provenance.sourceArtifactSha256}.diff`), holdoutArtifact);
      writeOracleEvidence(artifactsDirectory, train);
      writeOracleEvidence(artifactsDirectory, holdout);
      const fetchImpl = vi.fn() as unknown as typeof fetch;

      await expect(runReviewBenchSourceAdmission({
        corpusPath,
        artifactsDirectory,
        receiptPath,
        fetchImpl,
        admittedAt: VERIFIED_AT
      })).rejects.toThrow("unified diff exceeds 250000 lines");
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(existsSync(receiptPath)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("scopes GitHub credentials to the API origin and bounds retries and request time", async () => {
    const calls: Array<{ url: string; authorization: string | null; hasSignal: boolean }> = [];
    let transient = true;
    const baseFetch = vi.fn(async (request: string | URL | Request, init?: RequestInit) => {
      const url = request instanceof Request ? request.url : String(request);
      const headers = new Headers(init?.headers);
      calls.push({
        url,
        authorization: headers.get("authorization"),
        hasSignal: init?.signal instanceof AbortSignal
      });
      if (url.includes("/transient") && transient) {
        transient = false;
        return new Response("retry", { status: 503 });
      }
      return new Response("ok");
    }) as typeof fetch;
    const guardedFetch = buildReviewBenchGitHubFetch({
      fetchImpl: baseFetch,
      token: "test-token-not-a-secret",
      timeoutMs: 1000,
      attempts: 2
    });

    await guardedFetch("https://api.github.com/repos/example/alpha/transient");
    await guardedFetch("https://github.com/example/alpha/commit/abc.diff", {
      headers: { authorization: "Bearer must-be-removed" }
    });
    await guardedFetch("https://raw.githubusercontent.com/example/alpha/abc/LICENSE", {
      headers: { authorization: "Bearer must-be-removed" }
    });

    expect(calls.filter((call) => call.url.includes("/transient"))).toHaveLength(2);
    expect(calls.slice(0, 2).every((call) => call.authorization === "Bearer test-token-not-a-secret"))
      .toBe(true);
    expect(calls.slice(2).every((call) => call.authorization === null)).toBe(true);
    expect(calls.every((call) => call.hasSignal)).toBe(true);
    expect(() => buildReviewBenchGitHubFetch({ timeoutMs: 0 })).toThrow("timeoutMs");
    expect(() => buildReviewBenchGitHubFetch({ attempts: 3 })).toThrow("attempts");
  });
});
