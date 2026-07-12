import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "..");

describe("Review Bench public corpus gate", () => {
  it("makes live source admission and committed-receipt comparison mandatory in the publication workflow", () => {
    const workflow = readFileSync(join(repoRoot, ".github/workflows/ci.yml"), "utf8");
    expect(workflow).toContain("node dist/src/cli.js review-bench verify-sources");
    expect(workflow).toContain("scripts/check-review-bench-admission-receipt.mjs");
    expect(workflow).toContain("--committed docs/bench/review-bench-corpus-v1/admission-receipt.json");
    expect(workflow).toContain('publication_artifact_count=0');
    expect(workflow).toContain('if [[ "$publication_artifact_count" -ne 3 ]]');
    expect(workflow).toContain("Partial Review Bench Corpus v1 publication artifacts are forbidden.");
    expect(workflow).not.toMatch(/\n\s+paths:/);
    expect(workflow).not.toContain("continue-on-error");
  });

  it("accepts matching live/committed receipt claims and rejects hash drift", () => {
    const root = mkdtempSync(join(tmpdir(), "review-bench-receipt-gate-"));
    try {
      const livePath = join(root, "live.json");
      const committedPath = join(root, "committed.json");
      const live = receipt({ admittedAt: "2026-07-12T00:00:00.000Z" });
      const committed = receipt({ admittedAt: "2026-07-12T00:05:00.000Z" });
      writeFileSync(livePath, `${stableJson(live)}\n`);
      writeFileSync(committedPath, `${stableJson(committed)}\n`);

      const accepted = runReceiptGate(livePath, committedPath);
      expect(accepted.status).toBe(0);
      expect(JSON.parse(accepted.stdout)).toEqual(expect.objectContaining({
        ok: true,
        corpusHash: "a".repeat(64),
        verificationEvidenceSha256: "b".repeat(64),
        semanticEvidenceVersion: "review-bench-oracle-evidence/v2",
        semanticEvidenceVerifierVersion: "review-bench-semantic-admission/v2",
        semanticEvidenceSha256: "d".repeat(64),
        oracleSourceVerifierVersion: "github-oracle-source-verifier/v1",
        oracleSourceVerificationSha256: "e".repeat(64),
        adjudicationAgreementVersion: "review-bench-adjudication-agreement/v2",
        actionabilityItemCount: 175,
        actionabilityKappa: 0.9,
        artifactSemanticsKappa: 0.9,
        p0p1LabelCount: 30,
        severityWithinOneTierAgreement: 0.95
      }));

      const drifted = receipt({
        admittedAt: "2026-07-12T00:05:00.000Z",
        verificationEvidenceSha256: "c".repeat(64)
      });
      writeFileSync(committedPath, `${stableJson(drifted)}\n`);
      const rejected = runReceiptGate(livePath, committedPath);
      expect(rejected.status).not.toBe(0);
      expect(`${rejected.stdout}\n${rejected.stderr}`).toContain("receipt mismatch for verificationEvidenceSha256");

      const semanticDrift = receipt({
        admittedAt: "2026-07-12T00:05:00.000Z",
        semanticEvidenceSha256: "e".repeat(64)
      });
      writeFileSync(committedPath, `${stableJson(semanticDrift)}\n`);
      const semanticRejected = runReceiptGate(livePath, committedPath);
      expect(semanticRejected.status).not.toBe(0);
      expect(`${semanticRejected.stdout}\n${semanticRejected.stderr}`)
        .toContain("receipt mismatch for semanticEvidenceSha256");

      const invalidVersion = receipt({
        admittedAt: "2026-07-12T00:05:00.000Z",
        semanticEvidenceVersion: "review-bench-oracle-evidence/v0"
      });
      writeFileSync(committedPath, `${stableJson(invalidVersion)}\n`);
      const versionRejected = runReceiptGate(livePath, committedPath);
      expect(versionRejected.status).not.toBe(0);
      expect(`${versionRejected.stdout}\n${versionRejected.stderr}`).toContain("invalid fields");

      const insufficientHighSeverity = receipt({
        admittedAt: "2026-07-12T00:05:00.000Z",
        p0p1LabelCount: 29
      });
      writeFileSync(committedPath, `${stableJson(insufficientHighSeverity)}\n`);
      const severityFloorRejected = runReceiptGate(committedPath, committedPath);
      expect(severityFloorRejected.status).not.toBe(0);
      expect(`${severityFloorRejected.stdout}\n${severityFloorRejected.stderr}`).toContain("invalid fields");

      const canonicalCommitted = stableJson(committed);
      writeFileSync(
        committedPath,
        `{"corpusHash":"${"f".repeat(64)}",${canonicalCommitted.slice(1)}\n`
      );
      const duplicateKeyRejected = runReceiptGate(livePath, committedPath);
      expect(duplicateKeyRejected.status).not.toBe(0);
      expect(`${duplicateKeyRejected.stdout}\n${duplicateKeyRejected.stderr}`)
        .toContain("canonical JSON without duplicate keys");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("documents portable outside-checkout receipt generation and the reviewed publication handoff", () => {
    const operatorDocs = readFileSync(join(repoRoot, "docs/operator-cli.md"), "utf8");
    expect(operatorDocs).toContain("--receipt <outside-checkout-evidence-dir>/admission-receipt.json");
    expect(operatorDocs).toMatch(/copy that exact no-clobber\s+receipt into the publication worktree/);
    expect(operatorDocs).not.toContain("/Volumes/LEXAR/Codex/evals");
  });

  it("rejects a checkout-local receipt even when the CLI starts outside every git repository", () => {
    const root = mkdtempSync(join(tmpdir(), "review-bench-outside-cwd-"));
    const unsafeReceipt = join(repoRoot, `.review-bench-unsafe-${process.pid}.json`);
    try {
      const result = spawnSync(join(repoRoot, "node_modules/.bin/tsx"), [
        join(repoRoot, "src/cli.ts"),
        "review-bench",
        "verify-sources",
        "--corpus",
        join(root, "missing-corpus.json"),
        "--artifacts",
        root,
        "--receipt",
        unsafeReceipt
      ], { cwd: root, encoding: "utf8" });
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain("outside every git checkout");
      expect(existsSync(unsafeReceipt)).toBe(false);
    } finally {
      rmSync(unsafeReceipt, { force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("documents reviewed-state semantics, oracle isolation, and deterministic nearby matching", () => {
    const corpusDocs = readFileSync(
      join(repoRoot, "docs/evals/review-bench-corpus-v1.md"),
      "utf8"
    );
    expect(corpusDocs).toContain("A bug-fix diff cannot be labeled with the");
    expect(corpusDocs).toContain("answer-bearing evidence remain outside the model prompt");
    expect(corpusDocs).toContain("line delta one through three");
    expect(corpusDocs).toContain("synthetic");
  });

  it("exposes the packaged review-bench command and flags through CLI help", () => {
    const result = spawnSync("npx", ["tsx", "src/cli.ts", "review-bench", "--help"], {
      cwd: repoRoot,
      encoding: "utf8"
    });
    expect(result.status).toBe(0);
    const help = JSON.parse(result.stdout);
    expect(help.commands.existing).toContain("review-bench verify-sources");
    expect(help.usage.flags.map((flag: { name: string }) => flag.name)).toEqual([
      "--corpus",
      "--artifacts",
      "--receipt"
    ]);
  });
});

function receipt(overrides: Partial<{
  admittedAt: string;
  verificationEvidenceSha256: string;
  semanticEvidenceVersion: string;
  semanticEvidenceVerifierVersion: string;
  semanticEvidenceSha256: string;
  oracleSourceVerifierVersion: string;
  oracleSourceVerificationSha256: string;
  p0p1LabelCount: number;
}> = {}) {
  const basis = {
    schemaVersion: "review-bench-source-admission-receipt/v1",
    corpusVersion: "1.0.0",
    corpusHash: "a".repeat(64),
    verificationEvidenceSha256: overrides.verificationEvidenceSha256 ?? "b".repeat(64),
    semanticEvidenceVersion: overrides.semanticEvidenceVersion ?? "review-bench-oracle-evidence/v2",
    semanticEvidenceVerifierVersion: overrides.semanticEvidenceVerifierVersion ??
      "review-bench-semantic-admission/v2",
    semanticEvidenceSha256: overrides.semanticEvidenceSha256 ?? "d".repeat(64),
    oracleSourceVerifierVersion: overrides.oracleSourceVerifierVersion ??
      "github-oracle-source-verifier/v1",
    oracleSourceVerificationSha256: overrides.oracleSourceVerificationSha256 ?? "e".repeat(64),
    adjudicationAgreementVersion: "review-bench-adjudication-agreement/v2",
    adjudicationScenarioCount: 150,
    actionabilityItemCount: 175,
    actionabilityBothActionableCount: 125,
    actionabilityPrimaryOnlyCount: 0,
    actionabilitySecondaryOnlyCount: 0,
    actionabilityNeitherCount: 50,
    actionabilityKappa: 0.9,
    artifactBothDefectCount: 125,
    artifactPrimaryOnlyDefectCount: 0,
    artifactSecondaryOnlyDefectCount: 0,
    artifactBothCleanCount: 25,
    artifactSemanticsKappa: 0.9,
    severityAgreementLabelCount: 125,
    p0p1LabelCount: overrides.p0p1LabelCount ?? 30,
    severityWithinOneTierAgreement: 0.95,
    scenarioCount: 150,
    defectScenarioCount: 125,
    cleanControlCount: 25,
    languageCount: 6,
    repositoryCount: 10,
    sourceVerifierVersion: "github-public-source-ingest/v1",
    admittedAt: overrides.admittedAt ?? "2026-07-12T00:00:00.000Z"
  };
  return {
    ...basis,
    receiptSha256: createHash("sha256").update(stableJson(basis)).digest("hex")
  };
}

function runReceiptGate(livePath: string, committedPath: string) {
  return spawnSync("node", [
    "scripts/check-review-bench-admission-receipt.mjs",
    "--live",
    livePath,
    "--committed",
    committedPath
  ], { cwd: repoRoot, encoding: "utf8" });
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
