import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runMandatoryActivationMatrix } from "../src/mandatory-activation-matrix.js";

describe("mandatory activation proof assembler", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("derives one bound aggregate and every required child artifact from passing trusted reports", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-mandatory-activation-proof-"));
    roots.push(root);
    const evidenceDir = join(root, "docs", "evidence", "v1.0.4");
    mkdirSync(evidenceDir, { recursive: true });
    const candidateHead = "a".repeat(40);
    const packShasum = "b".repeat(40);
    const packIntegrity = `sha512-${Buffer.alloc(64, 7).toString("base64")}`;
    const harnessRunId = "d".repeat(64);
    const lifecycleRecords = [
      { id: "issue", outcome: "succeeded", statusCode: 200, apiBaseUrl: "https://neondiff-license.fly.dev", redactedResponse: { status: "issued" } },
      { id: "activate", outcome: "succeeded", statusCode: 200, apiBaseUrl: "https://neondiff-license.fly.dev", redactedResponse: { status: "active", source: "api" } },
      { id: "validate_active", outcome: "succeeded", statusCode: 200, apiBaseUrl: "https://neondiff-license.fly.dev", redactedResponse: { status: "active", source: "api" } },
      { id: "deactivate", outcome: "succeeded", statusCode: 200, apiBaseUrl: "https://neondiff-license.fly.dev", redactedResponse: { status: "deactivated" } },
      { id: "validate_denied", outcome: "denied", statusCode: 409, apiBaseUrl: "https://neondiff-license.fly.dev", redactedResponse: { status: "scope_mismatch" } }
    ];
    const lifecyclePath = join(evidenceDir, `production-lifecycle-${candidateHead}.json`);
    writeFileSync(lifecyclePath, `${JSON.stringify({
      evidenceKind: "production-lifecycle",
      releaseVersion: "v1.0.4",
      candidateHead,
      packShasum,
      packIntegrity,
      harnessRunId,
      records: lifecycleRecords
    })}\n`);
    const lifecycleResultPath = join(root, "lifecycle-result.json");
    writeFileSync(lifecycleResultPath, JSON.stringify({
      ok: true,
      observedAt: "2026-07-12T04:00:00.000Z",
      licenseFingerprint: `sha256:${"c".repeat(64)}`,
      lifecycle: {
        apiBaseUrl: "https://neondiff-license.fly.dev",
        licenseFingerprint: `sha256:${"c".repeat(64)}`,
        steps: lifecycleRecords.map((record) => ({
          ...record,
          responseSha256: createHash("sha256").update(JSON.stringify(record.redactedResponse)).digest("hex")
        }))
      },
      dashboard: {
        setupBlockedBeforeActivation: true,
        providerBlockedBeforeActivation: true,
        activatedStatusVisible: true
      }
    }));
    const matrixPath = join(root, "matrix.json");
    writeFileSync(matrixPath, JSON.stringify(await runMandatoryActivationMatrix()));
    const boundaryTestPath = join(root, "boundary-tests.json");
    const requiredBoundaryTests = [
      "providers verify license admission denies before provider-key stdin or provider network",
      "public NeonDiff CLI surface blocks provider-key stdin and provider network before activation",
      "public NeonDiff CLI surface blocks run-once before the first GitHub request without activation",
      "public NeonDiff CLI surface applies default-deny admission to useful commands without scoped help metadata",
      "local HTML dashboard serves HTML status but blocks provider verification before activation"
    ];
    writeFileSync(boundaryTestPath, JSON.stringify({
      success: true,
      numFailedTests: 0,
      numTotalTests: requiredBoundaryTests.length,
      testResults: [{ assertionResults: requiredBoundaryTests.map((fullName) => ({ fullName, status: "passed" })) }]
    }));
    const installPath = join(root, "install.json");
    writeFileSync(installPath, JSON.stringify({
      freshInstallPassed: true,
      freshBinaryVersion: "1.0.4",
      upgradedFromVersion: "1.0.3",
      upgradedBinaryVersion: "1.0.4",
      upgradePassed: true,
      legacyConfigMigrationPassed: true,
      lifecycleCandidateSource: "upgraded_from_1.0.3"
    }));
    const desktopPath = join(root, "desktop.json");
    writeFileSync(desktopPath, JSON.stringify({
      swiftTestPassed: true,
      brokerUnavailable: true,
      usefulWorkBlocked: true
    }));

    const script = resolve("scripts/assemble-mandatory-activation-proof.mjs");
    const output = JSON.parse(execFileSync(process.execPath, [
      script,
      "--release-version", "v1.0.4",
      "--candidate-head", candidateHead,
      "--pack-shasum", packShasum,
      "--pack-integrity", packIntegrity,
      "--lifecycle-artifact", lifecyclePath,
      "--lifecycle-result", lifecycleResultPath,
      "--matrix-report", matrixPath,
      "--boundary-test-report", boundaryTestPath,
      "--install-report", installPath,
      "--desktop-report", desktopPath,
      "--output-dir", evidenceDir
    ], { cwd: root, encoding: "utf8" }));

    expect(output.ok).toBe(true);
    expect(output.artifactPaths).toHaveLength(7);
    const aggregate = JSON.parse(readFileSync(output.aggregatePath, "utf8"));
    expect(aggregate.evidenceKind).toBe("mandatory_activation_no_bypass");
    expect(aggregate.installedCandidate).toMatchObject({
      packageVersion: "1.0.4",
      binaryVersion: "1.0.4",
      sourceHead: candidateHead,
      packShasum,
      packIntegrity,
      installSource: "npm_pack_tarball"
    });
    expect(aggregate.artifacts.map((artifact: { kind: string }) => artifact.kind).sort()).toEqual([
      "dashboard", "desktop", "install-upgrade", "no-bypass-matrix", "production-lifecycle", "useful-work-boundaries"
    ]);
    for (const artifact of aggregate.artifacts) {
      const absolutePath = join(root, artifact.ref);
      expect(createHash("sha256").update(readFileSync(absolutePath)).digest("hex")).toBe(artifact.sha256);
    }

    const validLifecycleResult = JSON.parse(readFileSync(lifecycleResultPath, "utf8"));
    writeFileSync(lifecycleResultPath, JSON.stringify({
      ...validLifecycleResult,
      lifecycle: { ...validLifecycleResult.lifecycle, steps: [] }
    }));
    expect(() => execFileSync(process.execPath, [
      script,
      "--release-version", "v1.0.4",
      "--candidate-head", candidateHead,
      "--pack-shasum", packShasum,
      "--pack-integrity", packIntegrity,
      "--lifecycle-artifact", lifecyclePath,
      "--lifecycle-result", lifecycleResultPath,
      "--matrix-report", matrixPath,
      "--boundary-test-report", boundaryTestPath,
      "--install-report", installPath,
      "--desktop-report", desktopPath,
      "--output-dir", evidenceDir
    ], { cwd: root, encoding: "utf8" })).toThrow(/lifecycle result must include passing issue/);
    writeFileSync(lifecycleResultPath, JSON.stringify(validLifecycleResult));

    expect(() => execFileSync(process.execPath, [
      script,
      "--release-version", "v1.0.4",
      "--candidate-head", candidateHead,
      "--pack-shasum", packShasum,
      "--pack-integrity", packIntegrity,
      "--lifecycle-artifact", lifecyclePath,
      "--lifecycle-result", lifecycleResultPath,
      "--matrix-report", matrixPath,
      "--boundary-test-report", boundaryTestPath,
      "--install-report", installPath,
      "--desktop-report", desktopPath,
      "--output-dir", evidenceDir
    ], { encoding: "utf8" })).toThrow(/output directory must be a release directory directly under docs\/evidence/);

    const incompleteMatrix = await runMandatoryActivationMatrix();
    incompleteMatrix.records = incompleteMatrix.records.filter((record) => record.id !== "offline");
    writeFileSync(matrixPath, JSON.stringify(incompleteMatrix));
    expect(() => execFileSync(process.execPath, [
      script,
      "--release-version", "v1.0.4",
      "--candidate-head", candidateHead,
      "--pack-shasum", packShasum,
      "--pack-integrity", packIntegrity,
      "--lifecycle-artifact", lifecyclePath,
      "--lifecycle-result", lifecycleResultPath,
      "--matrix-report", matrixPath,
      "--boundary-test-report", boundaryTestPath,
      "--install-report", installPath,
      "--desktop-report", desktopPath,
      "--output-dir", evidenceDir
    ], { cwd: root, encoding: "utf8" })).toThrow(/activation matrix is missing required scenarios/);
  });
});
