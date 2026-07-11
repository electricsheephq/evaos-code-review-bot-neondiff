#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertPacketRoot, packetRelativeEntry } from "./shared/packet-paths.mjs";
import { canonicalDesktopEvaluationFixtureJSON, decodeDesktopEvaluationFixtureData, decodeDesktopEvaluationPublicSafeJSON } from "./shared/desktop-evaluation-fixture-validator.mjs";

const flagIndex = process.argv.indexOf("--packet");
if (flagIndex < 0 || !process.argv[flagIndex + 1] || process.argv.length !== 4) {
  process.stderr.write("usage: verify-desktop-evaluation-packet.mjs --packet <directory>\n");
  process.exit(2);
}
const packet = assertPacketRoot(resolve(process.argv[flagIndex + 1]));

function fail(message) {
  throw new Error(message);
}

function regular(value, label) {
  return packetRelativeEntry(packet, value, label, "file");
}

function directory(value, label) {
  return packetRelativeEntry(packet, value, label, "directory");
}

function parseJSON(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    fail(`${label} is not valid JSON`);
  }
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function isHash(value, length = 64) {
  return typeof value === "string" && new RegExp(`^[a-f0-9]{${length}}$`).test(value);
}

function requireHash(reference, label) {
  if (!reference || !isHash(reference.sha256)) fail(`${label} reference is invalid`);
  const path = regular(reference.path, label);
  if (sha256(path) !== reference.sha256) fail(`${label} hash mismatch`);
  return path;
}

function sameNumber(left, right, tolerance = 0.5) {
  return Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) <= tolerance;
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
    fail(`${label} schema is invalid`);
  }
}

function hasAccessibilityIdentifier(value, expected) {
  if (Array.isArray(value)) return value.some((item) => hasAccessibilityIdentifier(item, expected));
  if (!value || typeof value !== "object") return false;
  if (value.identifier === expected) return true;
  return Object.values(value).some((item) => hasAccessibilityIdentifier(item, expected));
}

const proofBoundary = "Exact-source DEBUG SwiftPM nominal native baseline only; not the full async/error/overflow matrix, full Xcode/XCUITest, signed/notarized distribution, Sparkle/appcast, browser/native parity, GA readiness, or v1.1 completion.";
const unresolvedReason = "Nominal catalog capture is complete; typed async, recovery, disabled, and overflow fixtures remain required before redesign.";

const manifestPath = regular("manifest.json", "manifest");
const manifest = decodeDesktopEvaluationPublicSafeJSON(readFileSync(manifestPath), 1024 * 1024, "manifest");
exactKeys(manifest, ["schemaVersion", "generatedAt", "repository", "headSHA", "artifact", "catalogSHA256", "fixturesSHA256", "platform", "testSummary", "cases", "scans", "proofBoundary", "unresolvedFindings"], "manifest");
if (manifest.schemaVersion !== 2 || !isHash(manifest.headSHA, 40)) fail("manifest identity is invalid");
if (manifest.repository !== "electricsheephq/evaos-code-review-bot-neondiff"
  || typeof manifest.generatedAt !== "string"
  || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(manifest.generatedAt)
  || Number.isNaN(Date.parse(manifest.generatedAt))
  || manifest.proofBoundary !== proofBoundary) {
  fail("manifest proof boundary or source identity is invalid");
}
exactKeys(manifest.artifact, ["path", "sha256", "hashAlgorithm", "buildIdentity"], "artifact");
if (!/^NeonDiffDesktop \d+\.\d+\.\d+ \(\d+\); debug SwiftPM bundle$/.test(manifest.artifact.buildIdentity)) {
  fail("artifact build identity is invalid");
}
exactKeys(manifest.platform, ["macOSVersion", "xcodeVersion", "swiftVersion", "architecture", "backingScale", "evidence"], "platform");
if (!["arm64", "x86_64"].includes(manifest.platform.architecture)
  || ![1, 2, 3].includes(manifest.platform.backingScale)
  || !/^\d+(?:\.\d+){1,3}$/.test(manifest.platform.macOSVersion)
  || typeof manifest.platform.xcodeVersion !== "string" || !manifest.platform.xcodeVersion
  || typeof manifest.platform.swiftVersion !== "string" || !manifest.platform.swiftVersion) {
  fail("manifest platform is invalid");
}
if (!Array.isArray(manifest.unresolvedFindings) || manifest.unresolvedFindings.length !== 1) {
  fail("manifest unresolved findings are invalid");
}
const unresolved = manifest.unresolvedFindings[0];
exactKeys(unresolved, ["id", "severity", "owner", "recordedAt", "reason"], "unresolved finding");
if (unresolved.id !== "ND-EVAL-STATE-MATRIX" || unresolved.severity !== "P0"
  || unresolved.owner !== "issue-515" || unresolved.recordedAt !== manifest.generatedAt
  || unresolved.reason !== unresolvedReason) {
  fail("manifest unresolved finding semantics are invalid");
}

const app = directory(manifest.artifact?.path, "app artifact");
const appHash = JSON.parse(execFileSync(
  "node",
  ["scripts/hash-desktop-bundle-tree.mjs", app],
  { encoding: "utf8" }
));
if (manifest.artifact.hashAlgorithm !== "sha256-tree-v1"
  || appHash.algorithm !== manifest.artifact.hashAlgorithm
  || appHash.sha256 !== manifest.artifact.sha256) {
  fail("app artifact tree hash mismatch");
}
const plist = resolve(app, "Contents", "Info.plist");
const shortVersion = execFileSync("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleShortVersionString", plist], { encoding: "utf8" }).trim();
const buildVersion = execFileSync("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleVersion", plist], { encoding: "utf8" }).trim();
if (manifest.artifact.buildIdentity !== `NeonDiffDesktop ${shortVersion} (${buildVersion}); debug SwiftPM bundle`) {
  fail("artifact build identity disagrees with Info.plist");
}
const platformEvidencePath = requireHash(manifest.platform.evidence, "platform evidence");
const platformEvidence = parseJSON(platformEvidencePath, "platform evidence");
exactKeys(platformEvidence, ["schemaVersion", "macOSVersion", "xcodeVersion", "swiftVersion", "architecture"], "platform evidence");
if (platformEvidence.schemaVersion !== 1
  || manifest.platform.macOSVersion !== platformEvidence.macOSVersion
  || manifest.platform.swiftVersion !== platformEvidence.swiftVersion
  || manifest.platform.architecture !== platformEvidence.architecture
  || manifest.platform.xcodeVersion !== platformEvidence.xcodeVersion) {
  fail("manifest platform disagrees with hashed capture-host evidence");
}

const fixtures = directory("fixtures", "fixtures");
const fixturesHash = JSON.parse(execFileSync(
  "node",
  ["scripts/hash-desktop-bundle-tree.mjs", "--directory", fixtures],
  { encoding: "utf8" }
));
if (fixturesHash.sha256 !== manifest.fixturesSHA256) fail("fixture tree hash mismatch");
const catalogPath = regular("fixtures/catalog.json", "catalog");
if (sha256(catalogPath) !== manifest.catalogSHA256) fail("catalog hash mismatch");

exactKeys(manifest.testSummary, ["testCount", "durationSeconds", "runner", "summary", "result"], "manifest test summary");
const testSummaryPath = requireHash(manifest.testSummary.summary, "typed test summary");
const testResultPath = requireHash(manifest.testSummary.result, "test result");
const testSummary = parseJSON(testSummaryPath, "test summary");
const requiredSuites = [
  "NeonDiffDesktopCoreTests",
  "NeonDiffDesktopAppCoreTests",
  "NeonDiffDesktopEvaluationSupportTests",
  "NeonDiffDesktopFixtureChecks"
];
if (testSummary.schemaVersion !== 1
  || testSummary.headSHA !== manifest.headSHA
  || testSummary.status !== "passed"
  || testSummary.runner !== "swift-testing"
  || !Number.isInteger(testSummary.testCount)
  || testSummary.testCount < 1
  || testSummary.testCount > 100_000
  || !Number.isFinite(testSummary.durationSeconds)
  || testSummary.durationSeconds < 0
  || JSON.stringify([...testSummary.suites ?? []].sort()) !== JSON.stringify([...requiredSuites].sort())) {
  fail("test summary does not prove a passing exact-head required-suite run");
}
if (manifest.testSummary.summary.path !== "tests/test-summary.json"
  || manifest.testSummary.result.path !== "tests/swift-testing.log"
  || !isHash(testSummary.logSHA256)
  || sha256(testResultPath) !== testSummary.logSHA256) {
  fail("test summary log hash mismatch");
}
if (manifest.testSummary.testCount !== testSummary.testCount
  || manifest.testSummary.durationSeconds !== testSummary.durationSeconds
  || manifest.testSummary.runner !== testSummary.runner) {
  fail("manifest test summary disagrees with typed test evidence");
}

const packetScanPath = requireHash(manifest.scans?.secretScan, "packet secret scan");
requireHash(manifest.scans?.releaseBoundary, "release boundary");
if (manifest.scans.secretScanPassed !== true || manifest.scans.releaseBoundaryPassed !== true) {
  fail("manifest scan gate is false");
}
for (const marker of ["packet-safety-scan.ok", "release-boundary.ok"]) {
  if (readFileSync(regular(`validation/${marker}`, marker), "utf8").trim() !== "ok") {
    fail(`${marker} did not pass`);
  }
}
const packetScan = parseJSON(packetScanPath, "packet secret scan");
if (packetScan.ok !== true || (packetScan.findings?.length ?? 0) !== 0
  || (packetScan.sensitiveFiles?.length ?? 0) !== 0
  || (packetScan.unsupportedBinaryFiles?.length ?? 0) !== 0
  || (packetScan.unsupportedEntries?.length ?? 0) !== 0) {
  fail("packet secret scan did not pass");
}

const catalog = parseJSON(catalogPath, "catalog");
if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.entries) || catalog.entries.length !== 12) {
  fail("catalog must contain the 12 nominal fixtures");
}
const fixtureById = new Map();
const fixtureFiles = new Set();
for (const entry of catalog.entries) {
  if (typeof entry?.id !== "string" || typeof entry?.file !== "string"
    || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(entry.id)
    || !/^[a-z0-9][a-z0-9-]{0,63}\.json$/.test(entry?.file)
    || fixtureById.has(entry.id)
    || fixtureFiles.has(entry.file)) {
    fail("catalog entry is not canonical and unique");
  }
  const fixturePath = regular(`fixtures/${entry.file}`, `fixture ${entry.id}`);
  const normalizedPath = regular(`fixtures/normalized/${entry.id}.json`, `normalized fixture ${entry.id}`);
  let fixture;
  let normalized;
  try {
    fixture = decodeDesktopEvaluationFixtureData(readFileSync(fixturePath));
    normalized = decodeDesktopEvaluationFixtureData(readFileSync(normalizedPath));
  } catch {
    fail(`trusted fixture validator rejected packet fixture: ${entry.id}`);
  }
  if (fixture.id !== entry.id
    || canonicalDesktopEvaluationFixtureJSON(fixture) !== canonicalDesktopEvaluationFixtureJSON(normalized)) {
    fail(`normalized fixture mismatch: ${entry.id}`);
  }
  fixtureById.set(entry.id, normalized);
  fixtureFiles.add(entry.file);
}

if (!Array.isArray(manifest.cases) || manifest.cases.length !== 24) {
  fail("manifest must contain 24 nominal cases");
}
const requiredSizes = ["1040x680", "1280x800"];
const expectedKeys = new Set([...fixtureById.keys()].flatMap((fixtureId) => requiredSizes.map((size) => `${fixtureId}|${size}`)));
const seenKeys = new Set();
const expectedImages = [];
for (const item of manifest.cases) {
  exactKeys(item, ["fixtureId", "section", "onboardingStep", "appearance", "requestedContentSize", "actualWindowFrame", "actualContentFrame", "screenshot", "accessibility", "geometry", "readiness", "visualBaseline", "expectedState"], "manifest case");
  const fixture = fixtureById.get(item.fixtureId);
  const width = item.requestedContentSize?.width;
  const height = item.requestedContentSize?.height;
  const size = `${width}x${height}`;
  const key = `${item.fixtureId}|${size}`;
  if (!fixture || !expectedKeys.has(key) || seenKeys.has(key)) fail("manifest case matrix is invalid or duplicated");
  seenKeys.add(key);
  if (item.section !== fixture.surface?.section
    || item.onboardingStep !== (fixture.surface?.onboardingStep ?? null)
    || item.appearance !== fixture.environment?.appearance
    || item.expectedState !== fixture.state?.health) {
    fail(`manifest case fixture semantics mismatch: ${key}`);
  }
  if (item.visualBaseline?.status !== "captured-no-reference" || "goldenMetrics" in item) {
    fail(`manifest case fabricates or mislabels visual comparison evidence: ${key}`);
  }
  const base = `cases/${item.fixtureId}/${size}`;
  const expectedPaths = {
    screenshot: `${base}/screenshot.png`,
    accessibility: `${base}/accessibility.json`,
    geometry: `${base}/geometry.json`,
    readiness: `${base}/readiness.json`
  };
  for (const name of Object.keys(expectedPaths)) {
    if (item[name]?.path !== expectedPaths[name]) fail(`manifest ${name} path is not canonical: ${key}`);
    requireHash(item[name], `${name} ${key}`);
  }
  expectedImages.push(expectedPaths.screenshot);

  const capture = parseJSON(regular(`${base}/capture.json`, `capture ${key}`), `capture ${key}`);
  const metadata = parseJSON(regular(`${base}/case.json`, `case metadata ${key}`), `case metadata ${key}`);
  const geometry = parseJSON(regular(expectedPaths.geometry, `geometry ${key}`), `geometry ${key}`);
  const readiness = parseJSON(regular(expectedPaths.readiness, `readiness ${key}`), `readiness ${key}`);
  const accessibility = parseJSON(regular(expectedPaths.accessibility, `accessibility ${key}`), `accessibility ${key}`);
  if (capture.ok !== true
    || capture.fixtureId !== item.fixtureId
    || capture.windowNumber !== geometry.windowNumber
    || metadata.fixtureId !== item.fixtureId
    || metadata.size !== size
    || geometry.fixtureId !== item.fixtureId) {
    fail(`case identity is invalid: ${key}`);
  }
  if (!sameNumber(geometry.backingScale, manifest.platform.backingScale)) {
    fail(`case backing scale disagrees with manifest platform: ${key}`);
  }
  for (const name of ["screenshot", "accessibility", "geometry"]) {
    const expectedCapturePath = name === "screenshot" ? "screenshot.png" : `${name}.json`;
    if (capture[name]?.path !== expectedCapturePath || capture[name]?.sha256 !== item[name].sha256) {
      fail(`capture evidence disagrees with manifest: ${name} ${key}`);
    }
  }
  if (readiness.schemaVersion !== 1 || readiness.ready !== true
    || readiness.fixtureId !== item.fixtureId || readiness.pid !== geometry.pid
    || readiness.windowNumber !== geometry.windowNumber
    || !sameNumber(readiness.backingScale, geometry.backingScale)) {
    fail(`readiness identity is invalid: ${key}`);
  }
  for (const dimension of ["x", "y", "width", "height"]) {
    if (!sameNumber(readiness.windowFrame?.[dimension], geometry.appWindowFrame?.[dimension])
      || !sameNumber(readiness.contentFrame?.[dimension], geometry.appContentFrame?.[dimension])) {
      fail(`readiness geometry is invalid: ${key}`);
    }
  }
  if (!sameNumber(geometry.appContentFrame?.width, width)
    || !sameNumber(geometry.appContentFrame?.height, height)
    || !sameNumber(geometry.appWindowFrame?.width, geometry.cgWindowBounds?.width)
    || !sameNumber(geometry.appWindowFrame?.height, geometry.cgWindowBounds?.height)) {
    fail(`case geometry is invalid: ${key}`);
  }
  if (geometry.accessibilityTruncated !== false
    || !Number.isInteger(geometry.accessibilityNodeCount)
    || geometry.accessibilityNodeCount < 1
    || !hasAccessibilityIdentifier(accessibility, `neondiff.fixture.${item.fixtureId}`)) {
    fail(`Accessibility identifier evidence is incomplete: ${key}`);
  }
  if (!sameNumber(geometry.screenshotPixels?.width, geometry.appWindowFrame.width * geometry.backingScale, 1)
    || !sameNumber(geometry.screenshotPixels?.height, geometry.appWindowFrame.height * geometry.backingScale, 1)) {
    fail(`screenshot pixel geometry is invalid: ${key}`);
  }
}
if (seenKeys.size !== expectedKeys.size || [...expectedKeys].some((key) => !seenKeys.has(key))) {
  fail("manifest case matrix is incomplete");
}
if (JSON.stringify([...(packetScan.skippedImages ?? [])].sort()) !== JSON.stringify(expectedImages.sort())) {
  fail("packet secret scan did not account for the exact screenshot set");
}

let freshScan;
try {
  freshScan = JSON.parse(execFileSync(
    "node",
    ["scripts/check-desktop-evaluation-packet-secrets.mjs", "--packet", packet],
    { encoding: "utf8" }
  ));
} catch {
  fail("fresh packet secret scan failed");
}
if (freshScan.ok !== true
  || (freshScan.unsupportedBinaryFiles?.length ?? 0) !== 0
  || (freshScan.unsupportedEntries?.length ?? 0) !== 0
  || JSON.stringify([...freshScan.skippedImages].sort()) !== JSON.stringify(expectedImages.sort())) {
  fail("fresh packet secret scan does not corroborate the manifest");
}

process.stdout.write(`${JSON.stringify({ ok: true, headSHA: manifest.headSHA, caseCount: manifest.cases.length })}\n`);
