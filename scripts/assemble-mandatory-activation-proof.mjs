#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

const DENIED_SCENARIOS = [
  "unknown_repo", "public_denied", "private_denied", "missing_key", "missing_api_url",
  "offline", "timeout", "forged_cache", "mismatched_cache", "disabled_policy_attempt",
  "fake_api", "rate_limited", "server_error", "malformed_response", "revoked", "expired",
  "dashboard_provider_pre_activation"
];
const REQUIRED_BOUNDARY_TESTS = [
  "providers verify license admission denies before provider-key stdin or provider network",
  "public NeonDiff CLI surface blocks provider-key stdin and provider network before activation",
  "public NeonDiff CLI surface blocks run-once before the first GitHub request without activation",
  "public NeonDiff CLI surface applies default-deny admission to useful commands without scoped help metadata",
  "local HTML dashboard serves HTML status but blocks provider verification before activation"
];

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function readArgs(argv) {
  if (argv.length % 2 !== 0) fail("expected --name value arguments");
  const args = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) fail("expected --name value arguments");
    args.set(key.slice(2), value);
  }
  return args;
}

function required(args, name) {
  const value = args.get(name);
  if (!value) fail(`missing --${name}`);
  return value;
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    fail(`${label} must be valid JSON`);
  }
}

function digestRecord(record) {
  return createHash("sha256").update(JSON.stringify(record)).digest("hex");
}

function writeJson(path, value) {
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  writeFileSync(path, payload, { encoding: "utf8", mode: 0o644 });
  return createHash("sha256").update(payload).digest("hex");
}

const args = readArgs(process.argv.slice(2));
const releaseVersion = required(args, "release-version");
const candidateHead = required(args, "candidate-head");
const packShasum = required(args, "pack-shasum");
const packIntegrity = required(args, "pack-integrity");
const lifecycleArtifactPath = realpathSync(required(args, "lifecycle-artifact"));
const lifecycleResult = readJson(required(args, "lifecycle-result"), "lifecycle result");
const matrixReport = readJson(required(args, "matrix-report"), "matrix report");
const boundaryTestReport = readJson(required(args, "boundary-test-report"), "boundary test report");
const installReport = readJson(required(args, "install-report"), "install report");
const desktopReport = readJson(required(args, "desktop-report"), "desktop report");
const outputDir = realpathSync(required(args, "output-dir"));

if (!/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(releaseVersion)) fail("release version must be stable semver");
if (!/^[a-f0-9]{40}$/.test(candidateHead)) fail("candidate head must be a full lowercase Git SHA");
if (!/^[a-f0-9]{40}$/.test(packShasum)) fail("pack shasum must be a lowercase SHA-1 digest");
if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(packIntegrity)) fail("pack integrity must be sha512");

const repositoryRoot = realpathSync(process.cwd());
const expectedEvidenceRoot = realpathSync(resolve(repositoryRoot, "docs", "evidence"));
const evidenceRoot = realpathSync(resolve(outputDir, ".."));
if (evidenceRoot !== expectedEvidenceRoot) {
  fail("output directory must be a release directory directly under docs/evidence");
}
for (const path of [lifecycleArtifactPath, outputDir]) {
  const confined = relative(evidenceRoot, path);
  if (confined.startsWith("..") || isAbsolute(confined)) fail("evidence paths must stay within docs/evidence");
}

const lifecycleArtifact = readJson(lifecycleArtifactPath, "lifecycle artifact");
if (
  lifecycleArtifact.evidenceKind !== "production-lifecycle" ||
  lifecycleArtifact.releaseVersion !== releaseVersion ||
  lifecycleArtifact.candidateHead !== candidateHead ||
  lifecycleArtifact.packShasum !== packShasum ||
  lifecycleArtifact.packIntegrity !== packIntegrity ||
  !/^[a-f0-9]{64}$/.test(lifecycleArtifact.harnessRunId ?? "") ||
  !Array.isArray(lifecycleArtifact.records)
) fail("lifecycle artifact identity is invalid");
if (lifecycleResult.ok !== true || lifecycleResult.lifecycle?.apiBaseUrl !== "https://neondiff-license.fly.dev") {
  fail("lifecycle result must prove the official production API");
}
const lifecycleRequirements = new Map([
  ["issue", ["succeeded", 200]],
  ["activate", ["succeeded", 200]],
  ["validate_active", ["succeeded", 200]],
  ["deactivate", ["succeeded", 200]],
  ["validate_denied", ["denied", 409]]
]);
const lifecycleSteps = Array.isArray(lifecycleResult.lifecycle?.steps) ? lifecycleResult.lifecycle.steps : [];
const lifecycleById = new Map(lifecycleSteps.map((step) => [step?.id, step]));
for (const [id, [outcome, statusCode]] of lifecycleRequirements) {
  const step = lifecycleById.get(id);
  if (!step || step.outcome !== outcome || step.statusCode !== statusCode || step.apiBaseUrl !== "https://neondiff-license.fly.dev") {
    fail(`lifecycle result must include passing ${id}`);
  }
}
if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}T/.test(lifecycleResult.observedAt ?? "")) fail("lifecycle observedAt is invalid");
if (!/^sha256:[a-f0-9]{64}$/.test(lifecycleResult.licenseFingerprint ?? "")) fail("lifecycle fingerprint is invalid");
if (
  lifecycleResult.dashboard?.setupBlockedBeforeActivation !== true ||
  lifecycleResult.dashboard?.providerBlockedBeforeActivation !== true ||
  lifecycleResult.dashboard?.activatedStatusVisible !== true
) fail("lifecycle result must prove installed dashboard behavior before and after activation");

if (matrixReport.ok !== true || matrixReport.bypassAllowedCases !== 0 || !Array.isArray(matrixReport.records)) {
  fail("activation matrix report is not passing");
}
const scenarioRecords = matrixReport.records;
const requiredScenarioIds = new Set(["public_active", "private_active", ...DENIED_SCENARIOS]);
const observedScenarioIds = new Set();
for (const record of scenarioRecords) {
  if (!record || typeof record !== "object" || typeof record.id !== "string" || observedScenarioIds.has(record.id)) {
    fail("activation matrix records must have unique ids");
  }
  observedScenarioIds.add(record.id);
  if (!requiredScenarioIds.has(record.id)) fail(`activation matrix contains unexpected scenario: ${record.id}`);
  const expected = record.id === "public_active" || record.id === "private_active" ? "allowed" : "denied";
  if (record.expected !== expected || record.actual !== expected) fail(`activation matrix scenario did not match: ${record.id}`);
  if (!Number.isInteger(record.licenseApiCalls) || record.licenseApiCalls < 0) fail(`activation matrix scenario has invalid API-call count: ${record.id}`);
}
if (observedScenarioIds.size !== requiredScenarioIds.size || [...requiredScenarioIds].some((id) => !observedScenarioIds.has(id))) {
  fail("activation matrix is missing required scenarios");
}

if (boundaryTestReport.success !== true || boundaryTestReport.numFailedTests !== 0 || !Array.isArray(boundaryTestReport.testResults)) {
  fail("useful-work boundary test report is not passing");
}
const passedBoundaryTests = new Set(
  boundaryTestReport.testResults.flatMap((suite) => Array.isArray(suite.assertionResults)
    ? suite.assertionResults.filter((test) => test.status === "passed").map((test) => test.fullName)
    : [])
);
if (REQUIRED_BOUNDARY_TESTS.some((name) => !passedBoundaryTests.has(name))) {
  fail("useful-work boundary test report is missing a required passing test");
}

if (
  installReport.freshInstallPassed !== true ||
  installReport.freshBinaryVersion !== releaseVersion.slice(1) ||
  installReport.upgradedFromVersion !== "1.0.3" ||
  installReport.upgradedBinaryVersion !== releaseVersion.slice(1) ||
  installReport.upgradePassed !== true ||
  installReport.legacyConfigMigrationPassed !== true ||
  installReport.lifecycleCandidateSource !== "upgraded_from_1.0.3"
) fail("install report does not prove fresh install and v1.0.3 upgrade");
if (
  desktopReport.swiftTestPassed !== true ||
  desktopReport.brokerUnavailable !== true ||
  desktopReport.usefulWorkBlocked !== true
) fail("desktop report does not prove production quarantine");

const installRecord = { freshInstallPassed: true, upgradedFromVersion: "1.0.3", upgradePassed: true };
const dashboardRecord = lifecycleResult.dashboard;
const desktopRecord = { brokerUnavailable: true, usefulWorkBlocked: true };
const usefulWorkBoundaryRecord = {
  reportPassed: true,
  totalTests: boundaryTestReport.numTotalTests,
  requiredPassingTests: REQUIRED_BOUNDARY_TESTS
};
const common = { releaseVersion, candidateHead, packShasum, packIntegrity, harnessRunId: lifecycleArtifact.harnessRunId };
const childDefinitions = [
  ["no-bypass-matrix", scenarioRecords],
  ["useful-work-boundaries", [usefulWorkBoundaryRecord]],
  ["dashboard", [dashboardRecord]],
  ["desktop", [desktopRecord]],
  ["install-upgrade", [installRecord]]
];
const artifacts = [];
const lifecycleRef = relative(repositoryRoot, lifecycleArtifactPath);
const lifecycleBytes = readFileSync(lifecycleArtifactPath);
artifacts.push({ kind: "production-lifecycle", ref: lifecycleRef, sha256: createHash("sha256").update(lifecycleBytes).digest("hex") });
const artifactPaths = [lifecycleArtifactPath];
for (const [kind, records] of childDefinitions) {
  const path = resolve(outputDir, `${kind}-${candidateHead}.json`);
  const sha256 = writeJson(path, { evidenceKind: kind, ...common, records });
  artifacts.push({ kind, ref: relative(repositoryRoot, path), sha256 });
  artifactPaths.push(path);
}

const aggregate = {
  evidenceKind: "mandatory_activation_no_bypass",
  releaseVersion,
  observedAt: lifecycleResult.observedAt,
  harness: {
    name: "neondiff-license-lifecycle-smoke",
    version: 1,
    sourceHead: candidateHead,
    runId: lifecycleArtifact.harnessRunId
  },
  installedCandidate: {
    packageVersion: releaseVersion.slice(1),
    binaryVersion: installReport.freshBinaryVersion,
    sourceHead: candidateHead,
    packShasum,
    packIntegrity,
    installSource: "npm_pack_tarball"
  },
  productionLifecycle: lifecycleResult.lifecycle,
  matrix: {
    bypassAllowedCases: 0,
    scenarios: scenarioRecords.map((record) => ({ ...record, resultSha256: digestRecord(record) }))
  },
  usefulWorkBoundaries: { ...usefulWorkBoundaryRecord, resultSha256: digestRecord(usefulWorkBoundaryRecord) },
  installUpgrade: { ...installRecord, resultSha256: digestRecord(installRecord) },
  dashboard: { ...dashboardRecord, resultSha256: digestRecord(dashboardRecord) },
  desktop: { ...desktopRecord, resultSha256: digestRecord(desktopRecord) },
  redaction: { rawLicenseKeyAbsent: true, bearerTokenAbsent: true, privatePathsAbsent: true },
  artifacts
};
const aggregatePath = resolve(outputDir, `mandatory-activation-${candidateHead}.json`);
writeJson(aggregatePath, aggregate);
artifactPaths.push(aggregatePath);

process.stdout.write(`${JSON.stringify({ ok: true, aggregatePath, artifactPaths })}\n`);
