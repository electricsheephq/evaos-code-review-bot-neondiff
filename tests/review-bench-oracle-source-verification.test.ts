import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ReviewBenchCorpusV1, ReviewBenchScenarioV1 } from "../src/review-bench-corpus.js";
import {
  reverifyReviewBenchCorpusOracleSources as reverifyOracleSourcesWithAdmission,
  REVIEW_BENCH_ORACLE_SOURCE_VERIFIER_VERSION
} from "../src/review-bench-oracle-source-verification.js";
import type { ReviewBenchSemanticEvidenceRecord } from "../src/review-bench-semantic-evidence.js";

const OBSERVED_AT = "2026-07-12T00:00:00.000Z";
const BASE_DATE = "2026-05-01T00:00:00.000Z";

function reverifyReviewBenchCorpusOracleSources(
  input: Omit<Parameters<typeof reverifyOracleSourcesWithAdmission>[0], "admittedAt">
) {
  return reverifyOracleSourcesWithAdmission({ ...input, admittedAt: OBSERVED_AT });
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function scenario(input: {
  kind?: "later_fix" | "review_comment" | "clean_adjudication";
} = {}): ReviewBenchScenarioV1 {
  const kind = input.kind ?? "later_fix";
  const control = kind === "clean_adjudication";
  const pullRequest = kind === "review_comment" || control;
  const sourceRevision = "a".repeat(40);
  const oracleRevision = kind === "review_comment" || control ? sourceRevision : "c".repeat(40);
  return {
    schemaVersion: "review-bench-scenario/v1",
    taskKind: "review_defect_detection",
    artifactSemantics: control ? "verified_clean" : "defect_present",
    oracle: {
      schemaVersion: "review-bench-oracle/v1",
      kind,
      sourceUrl: kind === "review_comment"
        ? "https://api.github.com/repos/example/alpha/pulls/comments/123"
        : control
          ? "https://github.com/example/alpha/pull/7"
          : `https://github.com/example/alpha/commit/${oracleRevision}`,
      sourceRevision: oracleRevision,
      evidenceSha256: "1".repeat(64),
      defectPresentInReviewedArtifact: !control,
      modelInputExcluded: true
    },
    scenarioId: `scenario-${kind}`,
    sourceId: `source-${kind}`,
    runId: "run",
    repository: "example/alpha",
    sourceRevision,
    license: {
      spdxId: "MIT",
      licenseUrl: `https://raw.githubusercontent.com/example/alpha/${sourceRevision}/LICENSE`
    },
    provenance: {
      kind: pullRequest ? "pull_request" : "commit",
      repositoryUrl: "https://github.com/example/alpha",
      sourceUrl: pullRequest
        ? "https://github.com/example/alpha/pull/7"
        : `https://github.com/example/alpha/commit/${sourceRevision}`,
      sourceArtifactUrl: pullRequest
        ? `https://github.com/example/alpha/compare/${"b".repeat(40)}...${sourceRevision}.diff`
        : `https://github.com/example/alpha/commit/${sourceRevision}.diff`,
      ...(pullRequest ? { baseRevision: "b".repeat(40) } : {}),
      sourceArtifactSha256: "2".repeat(64),
      visibility: "public",
      visibilityEvidenceUrl: "https://api.github.com/repos/example/alpha",
      visibilityVerifiedAt: OBSERVED_AT,
      verification: {
        schemaVersion: "review-bench-source-verification/v1",
        provider: "github",
        verifierVersion: "github-public-source-ingest/v1",
        repositoryNodeId: "node",
        visibility: "public",
        licenseSpdxId: "MIT",
        repositoryMetadataSha256: "3".repeat(64),
        sourceMetadataSha256: "4".repeat(64),
        licenseArtifactSha256: "5".repeat(64),
        sourceArtifactSha256: "2".repeat(64),
        verifiedAt: OBSERVED_AT,
        bindingSha256: "6".repeat(64)
      }
    },
    language: "TypeScript",
    split: "train",
    bugFamily: "runtime_correctness",
    explicitControl: control,
    labels: control ? [] : [{
      id: "gold",
      path: "src/state.ts",
      line: 10,
      severity: "P1",
      title: "State bug",
      body: "The state transition is invalid."
    }],
    adjudication: {
      status: "independently_adjudicated",
      primaryAdjudicator: "human:one",
      secondaryAdjudicator: "human:two",
      agreement: "agree",
      method: "Independent review.",
      rubricVersion: "review-bench-rubric/v1",
      rubricSha256: "7".repeat(64),
      protocolVersion: "review-bench-adjudication-protocol/v1",
      protocolSha256: "8".repeat(64),
      completedAt: OBSERVED_AT
    }
  };
}

function corpus(item: ReviewBenchScenarioV1): ReviewBenchCorpusV1 {
  return {
    schemaVersion: "review-bench-corpus/v1",
    corpusVersion: "1.0.0",
    splitPolicy: {
      repositoryGrouped: true,
      holdoutFloor: { scenarios: 1, repositories: 1, minimumFraction: 0.3 }
    },
    scenarios: [item]
  };
}

function evidenceRecord(
  item: ReviewBenchScenarioV1,
  sourceEvidenceSha256: string,
  cleanObservation?: ReviewBenchSemanticEvidenceRecord["cleanObservation"]
): ReviewBenchSemanticEvidenceRecord {
  return {
    scenarioId: item.scenarioId,
    evidenceSha256: item.oracle.evidenceSha256,
    oracleObservedAt: OBSERVED_AT,
    oracleSourceEvidenceSha256: sourceEvidenceSha256,
    oracleLabelEvidence: item.labels.map((label) => ({
      labelId: label.id,
      sourceEvidenceSha256,
      sourcePath: label.path,
      sourceLine: item.oracle.kind === "review_comment" ? label.line : null,
      rationale: "The live oracle source supports this exact gold label."
    })),
    annotationUniverse: {
      schemaVersion: "review-bench-annotation-universe/v1",
      frozenAt: OBSERVED_AT,
      methodVersion: item.adjudication.protocolVersion,
      methodSha256: item.adjudication.protocolSha256,
      candidates: item.labels.map((label) => ({
        id: label.id,
        path: label.path,
        line: label.line,
        title: label.title,
        body: label.body
      }))
    },
    ...(cleanObservation === undefined ? {} : { cleanObservation }),
    primaryVerdict: item.artifactSemantics,
    secondaryVerdict: item.artifactSemantics,
    labelAgreement: item.labels.map((label) => ({
      labelId: label.id,
      primaryActionability: "actionable",
      secondaryActionability: "actionable",
      primarySeverity: label.severity,
      secondarySeverity: label.severity
    }))
  };
}

function ancestryResponse(base: string, head: string, options: { status?: string; baseDate?: string } = {}) {
  return {
    status: options.status ?? "ahead",
    ahead_by: 1,
    base_commit: {
      sha: base,
      commit: { committer: { date: options.baseDate ?? BASE_DATE } }
    },
    merge_base_commit: { sha: base },
    commits: [{ sha: head }]
  };
}

function cleanLineageResponse(base: string, head: string, message = "Routine maintenance") {
  return {
    status: "ahead",
    ahead_by: 1,
    base_commit: { sha: base },
    merge_base_commit: { sha: base },
    commits: [{ sha: head, commit: { message } }]
  };
}

describe("Review Bench live oracle-source verification", () => {
  it("verifies a later-fix commit, ancestry, chronology, and immutable diff bytes", async () => {
    const item = scenario();
    const diff = new TextEncoder().encode(
      "diff --git a/src/state.ts b/src/state.ts\n--- a/src/state.ts\n+++ b/src/state.ts\n@@ -1 +1 @@\n-old\n+fixed\n"
    );
    const evidence = evidenceRecord(item, sha256(diff));
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith(`/commits/${item.oracle.sourceRevision}`)) {
        return Response.json({
          sha: item.oracle.sourceRevision,
          commit: { committer: { date: "2026-07-12T00:00:00Z" } },
          parents: [{ sha: "b".repeat(40) }]
        });
      }
      if (url.pathname.includes("/compare/")) {
        return Response.json(ancestryResponse(item.sourceRevision, item.oracle.sourceRevision));
      }
      if (url.pathname.endsWith(`/commit/${item.oracle.sourceRevision}.diff`)) {
        return new Response(diff);
      }
      throw new Error(`unexpected URL ${url}`);
    }) as typeof fetch;

    const result = await reverifyReviewBenchCorpusOracleSources({
      corpus: corpus(item),
      semanticEvidenceRecords: [evidence],
      fetchImpl
    });
    expect(result.verifierVersion).toBe(REVIEW_BENCH_ORACLE_SOURCE_VERIFIER_VERSION);
    expect(result.oracleSourceVerificationSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.records[0]).toEqual(expect.objectContaining({
      scenarioId: item.scenarioId,
      sourceEvidenceSha256: sha256(diff)
    }));
  });

  it("rejects nonexistent and unrelated later-fix commits", async () => {
    const item = scenario();
    const diff = new TextEncoder().encode("fix diff");
    const evidence = evidenceRecord(item, sha256(diff));
    const missingFetch = vi.fn(async () => new Response("not found", { status: 404 })) as typeof fetch;
    await expect(reverifyReviewBenchCorpusOracleSources({
      corpus: corpus(item),
      semanticEvidenceRecords: [evidence],
      fetchImpl: missingFetch
    })).rejects.toThrow("HTTP 404");

    const unrelatedFetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.includes("/compare/")) {
        return Response.json(ancestryResponse(item.sourceRevision, item.oracle.sourceRevision, { status: "behind" }));
      }
      if (url.pathname.includes("/commits/")) {
        return Response.json({
          sha: item.oracle.sourceRevision,
          commit: { committer: { date: OBSERVED_AT } },
          parents: [{ sha: "b".repeat(40) }]
        });
      }
      return new Response(diff);
    }) as typeof fetch;
    await expect(reverifyReviewBenchCorpusOracleSources({
      corpus: corpus(item),
      semanticEvidenceRecords: [evidence],
      fetchImpl: unrelatedFetch
    })).rejects.toThrow("must prove the reviewed revision is an ancestor");
  });

  it("rejects a later-fix oracle whose exact diff does not change the mapped evidence path", async () => {
    const item = scenario();
    const diff = new TextEncoder().encode(
      "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-old\n+fixed\n"
    );
    const evidence = evidenceRecord(item, sha256(diff));
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith(`/commits/${item.oracle.sourceRevision}`)) {
        return Response.json({
          sha: item.oracle.sourceRevision,
          commit: { committer: { date: OBSERVED_AT } },
          parents: [{ sha: "b".repeat(40) }]
        });
      }
      if (url.pathname.includes("/compare/")) {
        return Response.json(ancestryResponse(item.sourceRevision, item.oracle.sourceRevision));
      }
      return new Response(diff);
    }) as typeof fetch;
    await expect(reverifyReviewBenchCorpusOracleSources({
      corpus: corpus(item),
      semanticEvidenceRecords: [evidence],
      fetchImpl
    })).rejects.toThrow("does not change mapped label-evidence path");
  });

  it("binds a review comment to its exact repository PR, reviewed head, line, body, and timestamp", async () => {
    const item = scenario({ kind: "review_comment" });
    const comment = {
      id: 123,
      commit_id: item.sourceRevision,
      pull_request_url: "https://api.github.com/repos/example/alpha/pulls/7",
      path: "src/state.ts",
      line: 10,
      side: "RIGHT",
      body: "This transition loses the latest state.",
      created_at: "2026-07-11T23:00:00.000Z",
      updated_at: "2026-07-12T00:00:00.000Z"
    };
    const projection = {
      id: comment.id,
      commitId: comment.commit_id,
      pullRequestUrl: comment.pull_request_url,
      path: comment.path,
      line: comment.line,
      side: comment.side,
      body: comment.body,
      createdAt: comment.created_at,
      updatedAt: OBSERVED_AT
    };
    const evidence = evidenceRecord(item, sha256(stableJson(projection)));
    const fetchImpl = vi.fn(async () => Response.json(comment)) as typeof fetch;
    await expect(reverifyReviewBenchCorpusOracleSources({
      corpus: corpus(item),
      semanticEvidenceRecords: [evidence],
      fetchImpl
    })).resolves.toEqual(expect.objectContaining({
      oracleSourceVerificationSha256: expect.stringMatching(/^[a-f0-9]{64}$/)
    }));

    const wrongHead = { ...comment, commit_id: "f".repeat(40) };
    await expect(reverifyReviewBenchCorpusOracleSources({
      corpus: corpus(item),
      semanticEvidenceRecords: [evidence],
      fetchImpl: vi.fn(async () => Response.json(wrongHead)) as typeof fetch
    })).rejects.toThrow("commit_id mismatch");

    const wrongLocation = { ...comment, path: "README.md", line: 1 };
    const wrongProjection = { ...projection, path: wrongLocation.path, line: wrongLocation.line };
    const wrongEvidence = evidenceRecord(item, sha256(stableJson(wrongProjection)));
    await expect(reverifyReviewBenchCorpusOracleSources({
      corpus: corpus(item),
      semanticEvidenceRecords: [wrongEvidence],
      fetchImpl: vi.fn(async () => Response.json(wrongLocation)) as typeof fetch
    })).rejects.toThrow("location does not match label evidence");

    const wrongPr = { ...comment, pull_request_url: "https://api.github.com/repos/example/alpha/pulls/8" };
    await expect(reverifyReviewBenchCorpusOracleSources({
      corpus: corpus(item),
      semanticEvidenceRecords: [evidence],
      fetchImpl: vi.fn(async () => Response.json(wrongPr)) as typeof fetch
    })).rejects.toThrow("PR mismatch");

    const impossibleChronology = { ...comment, updated_at: "2026-07-11T22:00:00.000Z" };
    await expect(reverifyReviewBenchCorpusOracleSources({
      corpus: corpus(item),
      semanticEvidenceRecords: [evidence],
      fetchImpl: vi.fn(async () => Response.json(impossibleChronology)) as typeof fetch,
      admittedAt: "2026-07-13T00:00:00Z"
    })).rejects.toThrow("update precedes creation");
  });

  it("requires a merged default-branch clean observation with exhaustive negative-signal checks", async () => {
    const item = scenario({ kind: "clean_adjudication" });
    const observationRevision = "e".repeat(40);
    const mergeCommitSha = "d".repeat(40);
    const observationDiff = new TextEncoder().encode("clean observation diff");
    const cleanObservation = {
      schemaVersion: "review-bench-clean-observation/v1" as const,
      sourceUrl: "https://github.com/example/alpha/pull/8",
      sourceRevision: observationRevision,
      sourceEvidenceSha256: sha256(observationDiff),
      observedThrough: OBSERVED_AT,
      minimumCleanDays: 30,
      checkedSignals: ["hotfix", "linked_defect", "revert"] as ["hotfix", "linked_defect", "revert"],
      evidenceSummary: "No linked defect, revert, or hotfix signal appeared."
    };
    const evidence = evidenceRecord(item, item.provenance.sourceArtifactSha256, cleanObservation);
    const fetchWithMergedAt = (
      mergedAt: string,
      historyMessage = "Routine maintenance",
      signals: {
        timeline?: unknown[];
        comments?: unknown[];
        nextPage?: boolean;
        currentHead?: string;
        serverDate?: string;
      } = {}
    ): typeof fetch =>
      vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/repos/example/alpha") {
        return Response.json(
          { default_branch: "main" },
          { headers: { date: signals.serverDate ?? "Sun, 12 Jul 2026 00:00:00 GMT" } }
        );
      }
      if (url.pathname === "/repos/example/alpha/pulls/7") {
        return Response.json({
          number: 7,
          state: "closed",
          merged: true,
          title: "Make state transitions atomic",
          merged_at: mergedAt,
          merge_commit_sha: mergeCommitSha,
          head: { sha: item.sourceRevision },
          base: { ref: "main", repo: { full_name: "example/alpha" } }
        });
      }
      if (url.pathname === "/repos/example/alpha/pulls/8") {
        return Response.json({
          number: 8,
          state: "closed",
          merged: true,
          merged_at: OBSERVED_AT,
          merge_commit_sha: observationRevision,
          base: { ref: "main", repo: { full_name: "example/alpha" } }
        });
      }
      if (url.pathname === "/repos/example/alpha/branches/main") {
        return Response.json({ commit: { sha: signals.currentHead ?? observationRevision } });
      }
      if (url.pathname.endsWith(`/commits/${observationRevision}`)) {
        return Response.json({
          sha: observationRevision,
          commit: { committer: { date: OBSERVED_AT } },
          parents: [{ sha: "d".repeat(40) }]
        });
      }
      if (url.pathname.includes("/compare/")) {
        const [base, head] = decodeURIComponent(url.pathname.split("/compare/")[1]!).split("...");
        return Response.json(base === observationRevision
          ? ancestryResponse(base, head)
          : cleanLineageResponse(mergeCommitSha, observationRevision, historyMessage));
      }
      if (url.pathname.endsWith("/issues/7/timeline")) {
        return Response.json(signals.timeline ?? [], {
          headers: signals.nextPage
            ? { link: '<https://api.github.com/next>; rel="next"' }
            : undefined
        });
      }
      if (url.pathname.endsWith("/issues/7/comments")) {
        return Response.json(signals.comments ?? []);
      }
      return new Response(observationDiff);
    }) as typeof fetch;

    const baselineResult = await reverifyReviewBenchCorpusOracleSources({
      corpus: corpus(item),
      semanticEvidenceRecords: [evidence],
      fetchImpl: fetchWithMergedAt(BASE_DATE)
    });
    expect(baselineResult).toEqual(expect.objectContaining({
      oracleSourceVerificationSha256: expect.stringMatching(/^[a-f0-9]{64}$/)
    }));
    const advancedResult = await reverifyOracleSourcesWithAdmission({
      corpus: corpus(item),
      semanticEvidenceRecords: [evidence],
      admittedAt: "2026-08-12T00:00:00.000Z",
      fetchImpl: fetchWithMergedAt(BASE_DATE, "Routine maintenance", {
        currentHead: "f".repeat(40),
        serverDate: "Wed, 12 Aug 2026 00:00:00 GMT",
        comments: [{
          id: 11,
          created_at: "2026-08-01T00:00:00Z",
          updated_at: "2026-08-01T00:00:00Z",
          body: "Thanks for documenting this."
        }]
      })
    });
    expect(advancedResult.oracleSourceVerificationSha256)
      .toBe(baselineResult.oracleSourceVerificationSha256);
    await expect(reverifyReviewBenchCorpusOracleSources({
      corpus: corpus(item),
      semanticEvidenceRecords: [evidence],
      fetchImpl: fetchWithMergedAt("2026-07-01T00:00:00Z")
    })).rejects.toThrow("does not prove the declared post-merge window");
    await expect(reverifyReviewBenchCorpusOracleSources({
      corpus: corpus(item),
      semanticEvidenceRecords: [evidence],
      fetchImpl: fetchWithMergedAt(BASE_DATE, "Hotfix for example/alpha#7")
    })).rejects.toThrow("linked corrective commit");
    await expect(reverifyReviewBenchCorpusOracleSources({
      corpus: corpus(item),
      semanticEvidenceRecords: [evidence],
      fetchImpl: fetchWithMergedAt(BASE_DATE, "Routine maintenance", {
        timeline: [{
          id: 9,
          event: "cross-referenced",
          created_at: "2026-06-01T00:00:00Z",
          source: { issue: { url: "https://api.github.com/repos/example/alpha/issues/99" } }
        }]
      })
    })).rejects.toThrow("post-merge cross-reference");
    await expect(reverifyReviewBenchCorpusOracleSources({
      corpus: corpus(item),
      semanticEvidenceRecords: [evidence],
      fetchImpl: fetchWithMergedAt(BASE_DATE, "Routine maintenance", {
        comments: [{
          id: 10,
          created_at: "2026-06-02T00:00:00Z",
          updated_at: "2026-06-02T00:00:00Z",
          body: "A regression here needs a hotfix."
        }]
      })
    })).rejects.toThrow("post-merge corrective discussion");
    await expect(reverifyReviewBenchCorpusOracleSources({
      corpus: corpus(item),
      semanticEvidenceRecords: [evidence],
      fetchImpl: fetchWithMergedAt(BASE_DATE, "Routine maintenance", {
        comments: [{
          id: 12,
          created_at: "2026-04-01T00:00:00Z",
          updated_at: "2026-06-03T00:00:00Z",
          body: "Editing this because the regression needs a hotfix."
        }]
      })
    })).rejects.toThrow("post-merge corrective discussion");
    await expect(reverifyReviewBenchCorpusOracleSources({
      corpus: corpus(item),
      semanticEvidenceRecords: [evidence],
      fetchImpl: fetchWithMergedAt(BASE_DATE, "Routine maintenance", { nextPage: true })
    })).rejects.toThrow("bounded exhaustive page");
  });
});

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
