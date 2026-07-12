import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  computeReviewBenchSourceVerificationBinding,
  validateReviewBenchCorpus,
  type ReviewBenchCorpusV1,
  type ReviewBenchScenarioV1
} from "../src/review-bench-corpus.js";
import {
  reverifyReviewBenchCorpusPublicSources,
  verifyGitHubReviewBenchSource
} from "../src/review-bench-source-verification.js";
import { runReviewBenchSourceAdmission } from "../src/review-bench-source-admission.js";

const VERIFIED_AT = "2026-07-12T00:00:00.000Z";

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function sourceDiff(marker: string): Uint8Array {
  return new TextEncoder().encode([
    "diff --git a/src/state.ts b/src/state.ts",
    "index 1111111..2222222 100644",
    "--- a/src/state.ts",
    "+++ b/src/state.ts",
    "@@ -9,2 +9,2 @@",
    " const current = readState();",
    `-writeState(\"old-${marker}\");`,
    `+writeState(\"new-${marker}\");`,
    ""
  ].join("\n"));
}

function draftScenario(input: {
  repository: string;
  revision: string;
  artifact: Uint8Array;
  split: "train" | "holdout";
}): ReviewBenchScenarioV1 {
  const { repository, revision, artifact, split } = input;
  return {
    schemaVersion: "review-bench-scenario/v1",
    scenarioId: `${repository}:${split}`,
    sourceId: `github:${repository}:commit/${revision}`,
    runId: `ingest:${repository}:${revision}`,
    repository,
    sourceRevision: revision,
    license: {
      spdxId: "MIT",
      licenseUrl: `https://raw.githubusercontent.com/${repository}/${revision}/LICENSE`
    },
    provenance: {
      kind: "commit",
      repositoryUrl: `https://github.com/${repository}`,
      sourceUrl: `https://github.com/${repository}/commit/${revision}`,
      sourceArtifactUrl: `https://github.com/${repository}/commit/${revision}.diff`,
      sourceArtifactSha256: sha256(artifact),
      visibility: "public",
      visibilityEvidenceUrl: `https://api.github.com/repos/${repository}`,
      visibilityVerifiedAt: VERIFIED_AT
    },
    language: "TypeScript",
    split,
    bugFamily: `state_consistency_${split}`,
    explicitControl: false,
    labels: [{
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
      completedAt: VERIFIED_AT
    }
  } as ReviewBenchScenarioV1;
}

function githubFetch(options: {
  privateRepository?: boolean;
  licenseSpdxId?: string;
  sourceArtifact?: Uint8Array;
  licenseArtifact?: Uint8Array;
  pullHeadSha?: string;
  pullBaseSha?: string;
} = {}): typeof fetch {
  return vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.hostname === "api.github.com") {
      const parts = url.pathname.replace(/^\/repos\//, "").split("/");
      const repository = `${parts[0]}/${parts[1]}`;
      if (parts[2] === "pulls") {
        const pullNumber = Number(parts[3]);
        return new Response(JSON.stringify({
          number: pullNumber,
          head: { sha: options.pullHeadSha ?? "a".repeat(40) },
          base: {
            sha: options.pullBaseSha ?? "0".repeat(40),
            repo: { full_name: repository }
          }
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (parts[2] === "commits") {
        return new Response(JSON.stringify({ sha: parts[3] }), {
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
        private: options.privateRepository ?? false,
        visibility: options.privateRepository ? "private" : "public"
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.hostname === "raw.githubusercontent.com") {
      return new Response(options.licenseArtifact ?? "MIT License\nPermission is hereby granted.", {
        status: 200,
        headers: { "content-type": "text/plain" }
      });
    }
    if (url.hostname === "github.com" && url.pathname.endsWith(".diff")) {
      return new Response(options.sourceArtifact ?? new TextEncoder().encode("unexpected artifact"), {
        status: 200,
        headers: { "content-type": "text/plain" }
      });
    }
    throw new Error(`unexpected URL: ${url.origin}`);
  }) as typeof fetch;
}

async function verifiedScenario(input: {
  repository: string;
  revision: string;
  artifact: Uint8Array;
  split: "train" | "holdout";
}): Promise<ReviewBenchScenarioV1> {
  const draft = draftScenario(input);
  const verification = await verifyGitHubReviewBenchSource({
    scenario: draft,
    sourceArtifact: input.artifact,
    fetchImpl: githubFetch({ sourceArtifact: input.artifact }),
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

  it("binds pull-request provenance to the exact GitHub PR head", async () => {
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
      pullHeadSha: revision,
      pullBaseSha: baseRevision
    });
    await expect(verifyGitHubReviewBenchSource({
      scenario: pullDraft,
      sourceArtifact: artifact,
      fetchImpl: successfulFetch,
      verifiedAt: VERIFIED_AT
    })).resolves.toEqual(expect.objectContaining({
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
        pullBaseSha: baseRevision
      }),
      verifiedAt: VERIFIED_AT
    })).rejects.toThrow("PR head");
    await expect(verifyGitHubReviewBenchSource({
      scenario: pullDraft,
      sourceArtifact: artifact,
      fetchImpl: githubFetch({
        sourceArtifact: artifact,
        pullHeadSha: revision,
        pullBaseSha: "f".repeat(40)
      }),
      verifiedAt: VERIFIED_AT
    })).rejects.toThrow("PR head");
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
      const alphaArtifact = sourceDiff("alpha");
      const betaArtifact = sourceDiff("beta");
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
      writeFileSync(corpusPath, JSON.stringify(corpus));
      writeFileSync(join(artifactsDirectory, `${train.provenance.sourceArtifactSha256}.diff`), alphaArtifact);
      writeFileSync(join(artifactsDirectory, `${holdout.provenance.sourceArtifactSha256}.diff`), betaArtifact);
      const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const repository = new URL(String(input)).pathname.includes("example/beta")
          ? "example/beta"
          : "example/alpha";
        const sourceArtifact = repository === "example/beta" ? betaArtifact : alphaArtifact;
        return githubFetch({ sourceArtifact })(input, init);
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
        scenarioCount: 2,
        admittedAt: VERIFIED_AT
      }));
      const originalReceipt = readFileSync(receiptPath, "utf8");
      await expect(runReviewBenchSourceAdmission({
        corpusPath,
        artifactsDirectory,
        receiptPath,
        fetchImpl,
        admittedAt: VERIFIED_AT
      })).rejects.toMatchObject({ code: "EEXIST" });
      expect(readFileSync(receiptPath, "utf8")).toBe(originalReceipt);

      for (const [name, labelOverride] of [
        ["missing-path", { path: "src/does-not-exist.ts" }],
        ["outside-hunk", { line: 999_999 }]
      ] as const) {
        const invalidAnchor = {
          ...train,
          labels: [{ ...train.labels[0], ...labelOverride }]
        } as ReviewBenchScenarioV1;
        const invalidCorpus = { ...corpus, scenarios: [invalidAnchor, holdout] };
        expect(() => validateReviewBenchCorpus(invalidCorpus)).not.toThrow();
        writeFileSync(corpusPath, JSON.stringify(invalidCorpus));
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
      writeFileSync(corpusPath, JSON.stringify({ ...corpus, scenarios: [forged, holdout] }));
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
      writeFileSync(corpusPath, JSON.stringify(corpus));
      writeFileSync(join(artifactsDirectory, `${train.provenance.sourceArtifactSha256}.diff`), oversizedArtifact);
      writeFileSync(join(artifactsDirectory, `${holdout.provenance.sourceArtifactSha256}.diff`), holdoutArtifact);
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
});
