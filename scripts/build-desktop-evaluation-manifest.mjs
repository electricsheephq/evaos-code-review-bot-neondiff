#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { assertPacketRoot, packetEntry } from "./shared/packet-paths.mjs";
import { canonicalDesktopEvaluationFixtureJSON, decodeDesktopEvaluationFixtureData } from "./shared/desktop-evaluation-fixture-validator.mjs";
import { readDesktopInfoPlistIdentity } from "./shared/desktop-info-plist.mjs";

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

function argument(flag) {
  const indexes = process.argv.flatMap((value, index) => value === flag ? [index] : []);
  if (indexes.length !== 1 || !process.argv[indexes[0] + 1]) fail(`missing ${flag}`);
  return process.argv[indexes[0] + 1];
}

const packet = assertPacketRoot(resolve(argument("--packet")));
const headSHA = argument("--head-sha");
if (!/^[a-f0-9]{40}$/.test(headSHA)) fail("invalid manifest head SHA");

function regular(path, label) {
  try {
    return packetEntry(packet, path, label, "file");
  } catch (error) {
    fail(error instanceof Error ? error.message : `${label} is invalid`);
  }
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function packetPath(path) {
  return relative(packet, path).split(sep).join("/");
}

function treeHash(path, directory = false) {
  const args = directory ? ["scripts/hash-desktop-bundle-tree.mjs", "--directory", path] : ["scripts/hash-desktop-bundle-tree.mjs", path];
  return JSON.parse(execFileSync("node", args, { encoding: "utf8" }));
}

function sameNumber(left, right, tolerance = 0.5) {
  return Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) <= tolerance;
}

function hasAccessibilityIdentifier(value, expected) {
  if (Array.isArray(value)) return value.some((item) => hasAccessibilityIdentifier(item, expected));
  if (!value || typeof value !== "object") return false;
  if (value.identifier === expected) return true;
  return Object.values(value).some((item) => hasAccessibilityIdentifier(item, expected));
}

const app = join(packet, "artifacts", "NeonDiffDesktop.app");
const fixturesDirectory = join(packet, "fixtures");
try {
  packetEntry(packet, app, "app artifact", "directory");
  packetEntry(packet, fixturesDirectory, "fixtures", "directory");
  packetEntry(packet, join(packet, "cases"), "cases", "directory");
} catch (error) {
  fail(error instanceof Error ? error.message : "packet directory is invalid");
}
const catalogPath = regular(join(fixturesDirectory, "catalog.json"), "catalog");
const testSummaryPath = regular(join(packet, "tests", "test-summary.json"), "test summary");
const testSummary = JSON.parse(readFileSync(testSummaryPath, "utf8"));
const requiredSuites = [
  "NeonDiffDesktopCoreTests",
  "NeonDiffDesktopAppCoreTests",
  "NeonDiffDesktopEvaluationSupportTests",
  "NeonDiffDesktopFixtureChecks"
];
if (testSummary.schemaVersion !== 1 || testSummary.headSHA !== headSHA || testSummary.status !== "passed" || testSummary.runner !== "swift-testing") {
  fail("test summary does not prove a passing exact-head run");
}
if (JSON.stringify([...testSummary.suites].sort()) !== JSON.stringify([...requiredSuites].sort())) {
  fail("test summary does not contain the required suites");
}
if (!Number.isInteger(testSummary.testCount) || testSummary.testCount < 1 || testSummary.testCount > 100_000
  || !Number.isFinite(testSummary.durationSeconds) || testSummary.durationSeconds < 0) {
  fail("test summary counts are invalid");
}
const testLog = regular(join(packet, "tests", "swift-testing.log"), "test log");
if (testSummary.logSHA256 !== sha256(testLog)) fail("test log hash does not match the typed summary");

for (const marker of ["packet-safety-scan.ok", "release-boundary.ok"]) {
  if (readFileSync(regular(join(packet, "validation", marker), marker), "utf8").trim() !== "ok") fail(`${marker} did not pass`);
}
const packetSecretScanPath = regular(join(packet, "validation", "packet-safety-scan.json"), "packet safety scan");
const releaseBoundaryPath = regular(join(packet, "validation", "release-boundary.log"), "release boundary log");
const platformEvidencePath = regular(join(packet, "validation", "platform.json"), "platform evidence");
const packetSecretScan = JSON.parse(readFileSync(packetSecretScanPath, "utf8"));
const platformEvidence = JSON.parse(readFileSync(platformEvidencePath, "utf8"));
if (packetSecretScan.ok !== true) fail("packet secret scan did not pass");
if (platformEvidence.schemaVersion !== 1
  || !/^\d+(?:\.\d+){1,3}$/.test(platformEvidence.macOSVersion)
  || typeof platformEvidence.xcodeVersion !== "string" || !platformEvidence.xcodeVersion
  || typeof platformEvidence.swiftVersion !== "string" || !platformEvidence.swiftVersion
  || !["arm64", "x86_64"].includes(platformEvidence.architecture)) {
  fail("platform evidence is invalid");
}

const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.entries) || catalog.entries.length === 0) fail("catalog schema is invalid");
const fixtureById = new Map();
for (const entry of catalog.entries) {
  if (typeof entry?.id !== "string" || typeof entry?.file !== "string"
    || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(entry.id) || !/^[a-z0-9][a-z0-9-]{0,63}\.json$/.test(entry.file)) {
    fail("catalog entry is not canonical");
  }
  if (fixtureById.has(entry.id)) fail("catalog fixture id is duplicated");
  const fixturePath = regular(join(fixturesDirectory, entry.file), `fixture ${entry.id}`);
  const normalizedPath = regular(join(fixturesDirectory, "normalized", `${entry.id}.json`), `normalized fixture ${entry.id}`);
  let fixture;
  let normalized;
  try {
    fixture = decodeDesktopEvaluationFixtureData(readFileSync(fixturePath));
    normalized = decodeDesktopEvaluationFixtureData(readFileSync(normalizedPath));
  } catch (error) {
    fail(error instanceof Error ? error.message : `fixture validation failed: ${entry.id}`);
  }
  if (fixture.id !== entry.id
    || canonicalDesktopEvaluationFixtureJSON(fixture) !== canonicalDesktopEvaluationFixtureJSON(normalized)) {
    fail(`normalized fixture mismatch: ${entry.id}`);
  }
  fixtureById.set(entry.id, normalized);
}

const caseRoot = join(packet, "cases");
const directoryIds = readdirSync(caseRoot).sort();
if (JSON.stringify(directoryIds) !== JSON.stringify([...fixtureById.keys()].sort())) {
  fail("case directories do not exactly match the fixture catalog");
}
const requiredSizes = ["1040x680", "1280x800"];
const cases = [];
const scales = new Set();
const expectedValidatedImages = [];
for (const fixtureId of directoryIds) {
  const fixture = fixtureById.get(fixtureId);
  const sizes = readdirSync(join(caseRoot, fixtureId)).sort();
  if (JSON.stringify(sizes) !== JSON.stringify([...requiredSizes].sort())) {
    fail(`fixture does not have exactly the required sizes: ${fixtureId}`);
  }
  for (const size of sizes) {
    const directory = join(caseRoot, fixtureId, size);
    const metadata = JSON.parse(readFileSync(regular(join(directory, "case.json"), "case metadata"), "utf8"));
    const capture = JSON.parse(readFileSync(regular(join(directory, "capture.json"), "capture metadata"), "utf8"));
    const geometryPath = regular(join(directory, "geometry.json"), "geometry");
    const accessibilityPath = regular(join(directory, "accessibility.json"), "accessibility");
    const screenshotPath = regular(join(directory, "screenshot.png"), "screenshot");
    const readinessPath = regular(join(directory, "readiness.json"), "readiness");
    const geometry = JSON.parse(readFileSync(geometryPath, "utf8"));
    const accessibility = JSON.parse(readFileSync(accessibilityPath, "utf8"));
    const readiness = JSON.parse(readFileSync(readinessPath, "utf8"));
    const [width, height] = size.split("x").map(Number);

    if (metadata.fixtureId !== fixtureId || metadata.size !== size || capture.fixtureId !== fixtureId || geometry.fixtureId !== fixtureId) {
      fail(`case identity mismatch: ${fixtureId} ${size}`);
    }
    if (capture.windowNumber !== geometry.windowNumber || capture.ok !== true) fail(`capture identity is invalid: ${fixtureId} ${size}`);
    if (!sameNumber(geometry.appContentFrame.width, width) || !sameNumber(geometry.appContentFrame.height, height)) {
      fail(`actual content size does not match requested size: ${fixtureId} ${size}`);
    }
    for (const dimension of ["width", "height"]) {
      if (!sameNumber(geometry.appWindowFrame[dimension], geometry.cgWindowBounds[dimension])) {
        fail(`CG and app window geometry disagree: ${fixtureId} ${size}`);
      }
    }
    if (geometry.accessibilityTruncated !== false || !Number.isInteger(geometry.accessibilityNodeCount) || geometry.accessibilityNodeCount < 1) {
      fail(`Accessibility evidence is incomplete: ${fixtureId} ${size}`);
    }
    if (!hasAccessibilityIdentifier(accessibility, `neondiff.fixture.${fixtureId}`)) {
      fail(`Accessibility identifier does not identify the requested fixture: ${fixtureId} ${size}`);
    }
    if (readiness.schemaVersion !== 1 || readiness.ready !== true
      || readiness.fixtureId !== fixtureId || readiness.pid !== geometry.pid
      || readiness.windowNumber !== geometry.windowNumber
      || !sameNumber(readiness.backingScale, geometry.backingScale)) {
      fail(`readiness identity is invalid: ${fixtureId} ${size}`);
    }
    for (const dimension of ["x", "y", "width", "height"]) {
      if (!sameNumber(readiness.windowFrame?.[dimension], geometry.appWindowFrame?.[dimension])
        || !sameNumber(readiness.contentFrame?.[dimension], geometry.appContentFrame?.[dimension])) {
        fail(`readiness geometry is invalid: ${fixtureId} ${size}`);
      }
    }
    if (!sameNumber(geometry.screenshotPixels.width, geometry.appWindowFrame.width * geometry.backingScale, 1)
      || !sameNumber(geometry.screenshotPixels.height, geometry.appWindowFrame.height * geometry.backingScale, 1)) {
      fail(`screenshot pixel geometry is invalid: ${fixtureId} ${size}`);
    }
    const evidence = (name, path) => {
      const hash = sha256(path);
      if (capture[name]?.path !== `${name}.png` && name === "screenshot") {
        fail(`capture path mismatch for ${name}: ${fixtureId} ${size}`);
      }
      if (capture[name]?.path !== `${name}.json` && name !== "screenshot") {
        fail(`capture path mismatch for ${name}: ${fixtureId} ${size}`);
      }
      if (capture[name]?.sha256 !== hash) fail(`capture hash mismatch for ${name}: ${fixtureId} ${size}`);
      return { path: packetPath(path), sha256: hash };
    };
    scales.add(geometry.backingScale);
    cases.push({
      fixtureId,
      section: fixture.surface.section,
      onboardingStep: fixture.surface.onboardingStep,
      appearance: fixture.environment.appearance,
      requestedContentSize: { width, height },
      actualWindowFrame: geometry.appWindowFrame,
      actualContentFrame: geometry.appContentFrame,
      screenshot: evidence("screenshot", screenshotPath),
      accessibility: evidence("accessibility", accessibilityPath),
      geometry: evidence("geometry", geometryPath),
      readiness: { path: packetPath(readinessPath), sha256: sha256(readinessPath) },
      visualBaseline: { status: "captured-no-reference" },
      expectedState: fixture.state.health
    });
    expectedValidatedImages.push({
      path: packetPath(screenshotPath),
      width: geometry.screenshotPixels.width,
      height: geometry.screenshotPixels.height
    });
  }
}
if (scales.size !== 1) fail("capture packet backing scale is inconsistent");
const expectedImages = cases.map((item) => item.screenshot.path).sort();
if (!Array.isArray(packetSecretScan.skippedImages)
  || JSON.stringify([...packetSecretScan.skippedImages].sort()) !== JSON.stringify(expectedImages)
  || JSON.stringify([...(packetSecretScan.validatedImages ?? [])].sort((left, right) => left.path.localeCompare(right.path)))
    !== JSON.stringify(expectedValidatedImages.sort((left, right) => left.path.localeCompare(right.path)))
  || (packetSecretScan.invalidImages?.length ?? 0) !== 0
  || (packetSecretScan.unsupportedBinaryFiles?.length ?? 0) !== 0
  || (packetSecretScan.unsupportedEntries?.length ?? 0) !== 0) {
  fail("packet secret scan did not account for every screenshot");
}

const appTreeHash = treeHash(app);
const fixturesTreeHash = treeHash(fixturesDirectory, true);
const { shortVersion, buildVersion } = readDesktopInfoPlistIdentity(app);
const recordedAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
const manifest = {
  schemaVersion: 2,
  generatedAt: recordedAt,
  repository: "electricsheephq/evaos-code-review-bot-neondiff",
  headSHA,
  artifact: {
    path: packetPath(app),
    sha256: appTreeHash.sha256,
    hashAlgorithm: appTreeHash.algorithm,
    buildIdentity: `NeonDiffDesktop ${shortVersion} (${buildVersion}); debug SwiftPM bundle`
  },
  catalogSHA256: sha256(catalogPath),
  fixturesSHA256: fixturesTreeHash.sha256,
  platform: {
    macOSVersion: platformEvidence.macOSVersion,
    xcodeVersion: platformEvidence.xcodeVersion,
    swiftVersion: platformEvidence.swiftVersion,
    architecture: platformEvidence.architecture,
    backingScale: [...scales][0],
    evidence: { path: packetPath(platformEvidencePath), sha256: sha256(platformEvidencePath) }
  },
  testSummary: {
    testCount: testSummary.testCount,
    durationSeconds: testSummary.durationSeconds,
    runner: "swift-testing",
    summary: { path: packetPath(testSummaryPath), sha256: sha256(testSummaryPath) },
    result: { path: packetPath(testLog), sha256: sha256(testLog) }
  },
  cases,
  scans: {
    secretScanPassed: true,
    releaseBoundaryPassed: true,
    secretScan: { path: packetPath(packetSecretScanPath), sha256: sha256(packetSecretScanPath) },
    releaseBoundary: { path: packetPath(releaseBoundaryPath), sha256: sha256(releaseBoundaryPath) }
  },
  proofBoundary: "Exact-source DEBUG SwiftPM nominal native baseline only; not the full async/error/overflow matrix, full Xcode/XCUITest, signed/notarized distribution, Sparkle/appcast, browser/native parity, GA readiness, or v1.1 completion.",
  unresolvedFindings: [{
    id: "ND-EVAL-STATE-MATRIX",
    severity: "P0",
    owner: "issue-515",
    recordedAt,
    reason: "Nominal catalog capture is complete; typed async, recovery, disabled, and overflow fixtures remain required before redesign."
  }]
};

writeFileSync(join(packet, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
process.stdout.write(`${JSON.stringify({ ok: true, manifest: "manifest.json", caseCount: cases.length, fixtureCount: fixtureById.size })}\n`);
