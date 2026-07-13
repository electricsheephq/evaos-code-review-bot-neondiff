import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { deflateSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { validateDesktopEvaluationFixture } from "../scripts/shared/desktop-evaluation-fixture-validator.mjs";

const roots: string[] = [];
const headSHA = "a".repeat(40);
const requiredSuites = [
  "NeonDiffDesktopCoreTests",
  "NeonDiffDesktopAppCoreTests",
  "NeonDiffDesktopEvaluationSupportTests",
  "NeonDiffDesktopFixtureChecks"
];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function sha256(path: string) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function tree(path: string, directory = false) {
  const args = ["scripts/hash-desktop-bundle-tree.mjs", ...(directory ? ["--directory"] : []), path];
  return JSON.parse(execFileSync("node", args, { encoding: "utf8" }));
}

function writeJSON(path: string, value: unknown) {
  writeFileSync(path, `${JSON.stringify(value)}\n`);
}

function crc32(data: Buffer) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data = Buffer.alloc(0)) {
  const typeBytes = Buffer.from(type, "ascii");
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBytes.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 8 + data.length);
  return chunk;
}

function completePng(width: number, height: number) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 1; // one-bit grayscale keeps deterministic fixtures compact
  const rowBytes = Math.ceil(width / 8);
  const raw = Buffer.alloc(height * (rowBytes + 1));
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND")
  ]);
}

function packetFixture() {
  const packet = mkdtempSync(join(tmpdir(), "neondiff-evaluation-packet-"));
  roots.push(packet);
  const app = join(packet, "artifacts", "NeonDiffDesktop.app");
  const fixtures = join(packet, "fixtures");
  mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
  mkdirSync(join(app, "Contents", "Helpers"), { recursive: true });
  mkdirSync(fixtures, { recursive: true });
  mkdirSync(join(packet, "tests"), { recursive: true });
  mkdirSync(join(packet, "validation"), { recursive: true });
  writeFileSync(join(app, "Contents", "MacOS", "NeonDiffDesktop"), "fixture app");
  const resolver = join(app, "Contents", "Helpers", "NeonDiffDesktopFixtureResolve");
  const resolverSentinel = join(packet, "resolver-was-executed");
  writeFileSync(resolver, `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(resolverSentinel)}, "unsafe packet code executed");
process.exit(99);
`);
  chmodSync(resolver, 0o755);
  writeFileSync(
    join(app, "Contents", "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleShortVersionString</key><string>0.1.0</string>
<key>CFBundleVersion</key><string>1</string>
</dict></plist>\n`
  );

  const entries = Array.from({ length: 12 }, (_, index) => ({
    id: `fixture-${String(index).padStart(2, "0")}`,
    file: `fixture-${String(index).padStart(2, "0")}.json`
  }));
  mkdirSync(join(fixtures, "normalized"), { recursive: true });
  writeJSON(join(fixtures, "catalog.json"), { schemaVersion: 1, entries });
  for (const entry of entries) {
    const fixture = {
      schemaVersion: 1,
      id: entry.id,
      surface: { section: "overview", onboardingStep: null },
      environment: { clock: "2026-07-10T12:00:00Z", locale: "en_US_POSIX", appearance: "dark", disableAnimations: true },
      state: {
        health: "healthy",
        runtimeReady: true,
        repositories: [],
        provider: null,
        license: { entitlement: "active", credentialPresent: true, updateChannel: "dev" },
        github: { connection: "disconnected", login: null, repositoryCount: 0 },
        logText: "Fixture log: nominal state."
      },
      scriptedOutcomes: [],
      expectedActions: ["refresh-status"],
      safeCopy: ["Deterministic fixture state."]
    };
    writeJSON(join(fixtures, entry.file), fixture);
    writeJSON(join(fixtures, "normalized", `${entry.id}.json`), fixture);
  }

  const testLog = join(packet, "tests", "swift-testing.log");
  writeFileSync(testLog, "all required suites passed\n");
  writeJSON(join(packet, "tests", "test-summary.json"), {
    schemaVersion: 1,
    headSHA,
    status: "passed",
    runner: "swift-testing",
    suites: requiredSuites,
    testCount: 42,
    durationSeconds: 1.25,
    logSHA256: sha256(testLog)
  });
  writeFileSync(join(packet, "validation", "packet-safety-scan.ok"), "ok\n");
  writeFileSync(join(packet, "validation", "release-boundary.ok"), "ok\n");
  writeFileSync(join(packet, "validation", "release-boundary.log"), "release boundary passed\n");
  writeJSON(join(packet, "validation", "platform.json"), {
    schemaVersion: 1,
    macOSVersion: "99.1",
    xcodeVersion: "not-installed-command-line-tools",
    swiftVersion: "Apple Swift version fixture",
    architecture: "arm64"
  });

  const skippedImages: string[] = [];
  const validatedImages: Array<{ path: string; width: number; height: number }> = [];
  let firstScreenshot = "";
  for (const entry of entries) {
    for (const size of ["1040x680", "1280x800"]) {
      const [width, height] = size.split("x").map(Number);
      const directory = join(packet, "cases", entry.id, size);
      mkdirSync(directory, { recursive: true });
      const screenshot = join(directory, "screenshot.png");
      const accessibility = join(directory, "accessibility.json");
      const geometry = join(directory, "geometry.json");
      const readiness = join(directory, "readiness.json");
      writeFileSync(screenshot, completePng(width * 2, (height + 32) * 2));
      writeJSON(accessibility, { identifier: `neondiff.fixture.${entry.id}` });
      writeJSON(geometry, {
        schemaVersion: 1,
        fixtureId: entry.id,
        pid: 123,
        windowNumber: 456,
        appWindowFrame: { x: 0, y: 0, width, height: height + 32 },
        appContentFrame: { x: 0, y: 0, width, height },
        cgWindowBounds: { x: 0, y: 0, width, height: height + 32 },
        backingScale: 2,
        accessibilityNodeCount: 1,
        accessibilityTruncated: false,
        screenshotPixels: { width: width * 2, height: (height + 32) * 2 }
      });
      writeJSON(readiness, {
        schemaVersion: 1,
        fixtureId: entry.id,
        pid: 123,
        windowNumber: 456,
        windowFrame: { x: 0, y: 0, width, height: height + 32 },
        contentFrame: { x: 0, y: 0, width, height },
        backingScale: 2,
        ready: true
      });
      const evidence = (path: string) => ({ path: basename(path), sha256: sha256(path) });
      const capture = {
        ok: true,
        fixtureId: entry.id,
        windowNumber: 456,
        screenshot: evidence(screenshot),
        accessibility: evidence(accessibility),
        geometry: evidence(geometry)
      };
      writeJSON(join(directory, "capture.json"), capture);
      writeJSON(join(directory, "case.json"), { fixtureId: entry.id, size });
      skippedImages.push(relative(packet, screenshot));
      validatedImages.push({ path: relative(packet, screenshot), width: width * 2, height: (height + 32) * 2 });
      if (!firstScreenshot) firstScreenshot = screenshot;
    }
  }
  writeJSON(join(packet, "validation", "packet-safety-scan.json"), {
    ok: true,
    skippedImages,
    validatedImages,
    invalidImages: [],
    findings: [],
    sensitiveFiles: []
  });
  execFileSync(
    "node",
    ["scripts/build-desktop-evaluation-manifest.mjs", "--packet", packet, "--head-sha", headSHA],
    { encoding: "utf8" }
  );
  return { packet, firstScreenshot, resolverSentinel };
}

function verify(packet: string) {
  return spawnSync("node", ["scripts/verify-desktop-evaluation-packet.mjs", "--packet", packet], { encoding: "utf8" });
}

function rewriteManifest(packet: string, mutate: (manifest: any) => void) {
  const path = join(packet, "manifest.json");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  mutate(manifest);
  writeJSON(path, manifest);
}

describe("desktop evaluation packet integrity", { timeout: 30_000 }, () => {
  it("recomputes referenced bytes and rejects post-capture tampering", () => {
    const value = packetFixture();
    expect(verify(value.packet).status).toBe(0);
    expect(existsSync(value.resolverSentinel)).toBe(false);
    const manifest = JSON.parse(readFileSync(join(value.packet, "manifest.json"), "utf8"));
    expect(manifest.testSummary.summary.path).toBe("tests/test-summary.json");
    expect(manifest.testSummary.result.path).toBe("tests/swift-testing.log");
    expect(manifest.platform.evidence.path).toBe("validation/platform.json");
    expect(manifest.cases[0].readiness.path).toMatch(/readiness\.json$/);
    writeFileSync(value.firstScreenshot, "tampered screenshot");
    const tampered = verify(value.packet);
    expect(tampered.status).not.toBe(0);
    expect(tampered.stderr).toMatch(/hash mismatch/);
  });

  it("verifies a portable packet using hashed capture-host platform evidence", () => {
    const value = packetFixture();
    const platformPath = join(value.packet, "validation", "platform.json");
    const platform = {
      schemaVersion: 1,
      macOSVersion: "99.1",
      xcodeVersion: "Xcode 99.0; Build version 99A1",
      swiftVersion: "Apple Swift version 99.0",
      architecture: "arm64"
    };
    writeJSON(platformPath, platform);
    rewriteManifest(value.packet, (manifest) => {
      Object.assign(manifest.platform, platform);
      delete manifest.platform.schemaVersion;
      manifest.platform.evidence.sha256 = sha256(platformPath);
    });
    expect(verify(value.packet).status).toBe(0);
  });

  it("revalidates normalized fixture data without executing packaged code", () => {
    const value = packetFixture();
    const fixturePath = join(value.packet, "fixtures", "fixture-00.json");
    const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
    fixture.unexpected = true;
    writeJSON(fixturePath, fixture);
    rewriteManifest(value.packet, (manifest) => {
      manifest.fixturesSHA256 = tree(join(value.packet, "fixtures"), true).sha256;
    });
    const result = verify(value.packet);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/fixture validator|normalized fixture/i);
  });

  it("rejects mutated proof-boundary and unresolved-finding semantics", () => {
    const value = packetFixture();
    rewriteManifest(value.packet, (manifest) => {
      manifest.proofBoundary = "GA ready";
      manifest.unresolvedFindings = [];
      manifest.unexpected = true;
    });
    const result = verify(value.packet);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/schema|proof boundary|unresolved/i);
  });

  it("rejects manifest strings beyond Swift public-safety limits", () => {
    const value = packetFixture();
    rewriteManifest(value.packet, (manifest) => {
      manifest.platform.xcodeVersion = "x".repeat(5_000);
    });
    const result = verify(value.packet);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/unsafe|oversized string/i);
  });

  it("rejects whitespace-padded manifests beyond Swift's byte limit", () => {
    const value = packetFixture();
    const manifestPath = join(value.packet, "manifest.json");
    writeFileSync(manifestPath, Buffer.concat([readFileSync(manifestPath), Buffer.alloc(1024 * 1024, 0x20)]));
    const result = verify(value.packet);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/exceeds.*byte limit/i);
  });

  it("binds app-authored readiness and rejects a hash-consistent false ready state", () => {
    const value = packetFixture();
    const manifestPath = join(value.packet, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const readinessPath = join(value.packet, manifest.cases[0].readiness.path);
    const readiness = JSON.parse(readFileSync(readinessPath, "utf8"));
    readiness.ready = false;
    writeJSON(readinessPath, readiness);
    manifest.cases[0].readiness.sha256 = sha256(readinessPath);
    writeJSON(manifestPath, manifest);
    const result = verify(value.packet);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/readiness/i);
  });

  it("binds manifest frame summaries to hashed geometry evidence", () => {
    const value = packetFixture();
    rewriteManifest(value.packet, (manifest) => {
      manifest.cases[0].actualContentFrame.height -= 1;
      manifest.cases[0].actualWindowFrame.x += 1;
    });
    const result = verify(value.packet);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/frame summary|geometry/i);
  });

  it("requires a structural AX identifier rather than matching arbitrary text", () => {
    const value = packetFixture();
    const manifestPath = join(value.packet, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const item = manifest.cases[0];
    const accessibilityPath = join(value.packet, item.accessibility.path);
    writeJSON(accessibilityPath, { title: `neondiff.fixture.${item.fixtureId}` });
    item.accessibility.sha256 = sha256(accessibilityPath);
    const capturePath = join(value.packet, "cases", item.fixtureId, `${item.requestedContentSize.width}x${item.requestedContentSize.height}`, "capture.json");
    const capture = JSON.parse(readFileSync(capturePath, "utf8"));
    capture.accessibility.sha256 = item.accessibility.sha256;
    writeJSON(capturePath, capture);
    writeJSON(manifestPath, manifest);
    const result = verify(value.packet);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/Accessibility identifier/i);
  });

  it("rejects a hash-consistent but failed or wrong-head test summary", () => {
    const value = packetFixture();
    const summaryPath = join(value.packet, "tests", "test-summary.json");
    const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
    summary.status = "failed";
    summary.headSHA = "b".repeat(40);
    writeJSON(summaryPath, summary);
    rewriteManifest(value.packet, (manifest) => {
      manifest.testSummary.summary.sha256 = sha256(summaryPath);
    });
    const result = verify(value.packet);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/test summary/);
  });

  it("rejects test counts beyond the Swift manifest limit", () => {
    const value = packetFixture();
    const summaryPath = join(value.packet, "tests", "test-summary.json");
    const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
    summary.testCount = 100_001;
    writeJSON(summaryPath, summary);
    rewriteManifest(value.packet, (manifest) => {
      manifest.testSummary.testCount = summary.testCount;
      manifest.testSummary.summary.sha256 = sha256(summaryPath);
    });
    const result = verify(value.packet);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/test summary/i);
  });

  it("rejects an empty catalog even when all affected hashes are recomputed", () => {
    const value = packetFixture();
    const catalogPath = join(value.packet, "fixtures", "catalog.json");
    writeJSON(catalogPath, { schemaVersion: 1, entries: [] });
    rewriteManifest(value.packet, (manifest) => {
      manifest.catalogSHA256 = sha256(catalogPath);
      manifest.fixturesSHA256 = tree(join(value.packet, "fixtures"), true).sha256;
    });
    const result = verify(value.packet);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/catalog/);
  });

  it("rejects intermediate packet-directory symlinks before reading outside data", () => {
    const value = packetFixture();
    const outside = mkdtempSync(join(tmpdir(), "neondiff-evaluation-outside-"));
    roots.push(outside);
    renameSync(join(value.packet, "artifacts"), join(outside, "artifacts"));
    symlinkSync(join(outside, "artifacts"), join(value.packet, "artifacts"));

    const scan = spawnSync("node", ["scripts/check-desktop-evaluation-packet-secrets.mjs", "--packet", value.packet], { encoding: "utf8" });
    expect(scan.status).not.toBe(0);
    expect(scan.stderr).toMatch(/symlink/);

    const result = verify(value.packet);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/symlink/);
  });

  it("allows accounted app-bundle symlinks that resolve inside the artifact root", () => {
    const value = packetFixture();
    const framework = join(value.packet, "artifacts", "NeonDiffDesktop.app", "Contents", "Frameworks", "Fixture.framework");
    mkdirSync(join(framework, "Versions", "A"), { recursive: true });
    writeFileSync(join(framework, "Versions", "A", "Fixture"), "fixture framework binary");
    symlinkSync("A", join(framework, "Versions", "Current"));
    symlinkSync("Versions/Current/Fixture", join(framework, "Fixture"));

    const scan = spawnSync("node", ["scripts/check-desktop-evaluation-packet-secrets.mjs", "--packet", value.packet], { encoding: "utf8" });
    expect(scan.status, `${scan.stderr}\n${scan.stdout}`).toBe(0);
    expect(JSON.parse(scan.stdout).skippedArtifactSymlinks).toEqual([
      "artifacts/NeonDiffDesktop.app/Contents/Frameworks/Fixture.framework/Fixture",
      "artifacts/NeonDiffDesktop.app/Contents/Frameworks/Fixture.framework/Versions/Current"
    ]);

    writeFileSync(join(value.packet, "allowed.txt"), "packet sibling must not become an app link target");
    symlinkSync(
      "../../../../allowed.txt",
      join(value.packet, "artifacts", "NeonDiffDesktop.app", "Contents", "Frameworks", "escape-existing")
    );
    const escaping = spawnSync("node", ["scripts/check-desktop-evaluation-packet-secrets.mjs", "--packet", value.packet], { encoding: "utf8" });
    expect(escaping.status).not.toBe(0);
    expect(escaping.stderr).toMatch(/escaping|unsafe/i);
  });

  it("scans packet text after capture and accounts for skipped images", () => {
    const value = packetFixture();
    const scan = () => spawnSync("node", ["scripts/check-desktop-evaluation-packet-secrets.mjs", "--packet", value.packet], { encoding: "utf8" });
    const clean = scan();
    expect(clean.status).toBe(0);
    expect(JSON.parse(clean.stdout).skippedImages).toHaveLength(24);

    const token = ["gh", "p_", "fixture_secret_material_1234567890"].join("");
    writeFileSync(join(value.packet, "cases", "fixture-00", "1040x680", "accessibility.json"), token);
    const unsafe = scan();
    expect(unsafe.status).toBe(1);
    expect(JSON.parse(unsafe.stdout).findings).toEqual(expect.arrayContaining([expect.objectContaining({ pattern: "github_token" })]));

    const canonical = packetFixture();
    writeFileSync(
      join(canonical.packet, "cases", "fixture-00", "1040x680", "accessibility.json"),
      `Bearer ${"a".repeat(24)}`
    );
    const canonicalUnsafe = spawnSync("node", ["scripts/check-desktop-evaluation-packet-secrets.mjs", "--packet", canonical.packet], { encoding: "utf8" });
    expect(canonicalUnsafe.status).toBe(1);
    expect(JSON.parse(canonicalUnsafe.stdout).findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ pattern: "canonical_secret" })])
    );

    const disguised = packetFixture();
    writeFileSync(join(disguised.packet, "cases", "fixture-00", "SPARKLE-LICENSE.txt"), "customer@example.com");
    const disguisedUnsafe = spawnSync("node", ["scripts/check-desktop-evaluation-packet-secrets.mjs", "--packet", disguised.packet], { encoding: "utf8" });
    expect(disguisedUnsafe.status).toBe(1);
    expect(JSON.parse(disguisedUnsafe.stdout).findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ pattern: "canonical_secret" })])
    );

    const forgedLicense = packetFixture();
    const forgedPath = join(
      forgedLicense.packet,
      "artifacts",
      "NeonDiffDesktop.app",
      "Contents",
      "Resources",
      "NeonDiffDesktop_NeonDiffDesktop.bundle"
    );
    mkdirSync(forgedPath, { recursive: true });
    writeFileSync(join(forgedPath, "SPARKLE-LICENSE.txt"), "Copyright (c) 2026 Customer Records <customer.private@example.com>");
    const forgedUnsafe = spawnSync("node", ["scripts/check-desktop-evaluation-packet-secrets.mjs", "--packet", forgedLicense.packet], { encoding: "utf8" });
    expect(forgedUnsafe.status).toBe(1);
    expect(JSON.parse(forgedUnsafe.stdout).findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ pattern: "canonical_secret" })])
    );
  });

  it("rejects a canonical done fixture without API-backed activation", () => {
    const value = packetFixture();
    const fixture = JSON.parse(readFileSync(join(value.packet, "fixtures", "fixture-00.json"), "utf8"));
    fixture.surface.onboardingStep = "done";
    fixture.state.license = { entitlement: "not activated", credentialPresent: false, updateChannel: "dev" };
    fixture.state.provider = {
      id: "zcode-glm",
      displayName: "Z.AI GLM",
      adapter: "openai-compatible",
      authMode: "api-key-env",
      baseURL: "https://api.z.ai/api/coding/paas/v4",
      model: "glm-5",
      credentialPresent: true,
      verification: "healthy"
    };

    expect(() => validateDesktopEvaluationFixture(fixture)).toThrow(/activation/i);
  });

  it("fails closed on invalid UTF-8 in a text-like app resource", () => {
    const value = packetFixture();
    const resource = join(
      value.packet,
      "artifacts",
      "NeonDiffDesktop.app",
      "Contents",
      "Resources",
      "secret.txt"
    );
    mkdirSync(join(resource, ".."), { recursive: true });
    writeFileSync(resource, Buffer.concat([
      Buffer.from([0xff]),
      Buffer.from(["gh", "p_", "fixture_secret_material_1234567890"].join(""))
    ]));

    const scan = spawnSync(
      "node",
      ["scripts/check-desktop-evaluation-packet-secrets.mjs", "--packet", value.packet],
      { encoding: "utf8" }
    );
    expect(scan.status).toBe(1);
    expect(JSON.parse(scan.stdout).unsupportedBinaryFiles).toContain(
      "artifacts/NeonDiffDesktop.app/Contents/Resources/secret.txt"
    );
  });

  it("scans printable secret text inside recognized app binary extensions", () => {
    const value = packetFixture();
    const resource = join(
      value.packet,
      "artifacts",
      "NeonDiffDesktop.app",
      "Contents",
      "Resources",
      "secret.car"
    );
    mkdirSync(join(resource, ".."), { recursive: true });
    writeFileSync(resource, Buffer.concat([
      Buffer.from([0xff, 0x00]),
      Buffer.from(["gh", "p_", "fixture_secret_material_1234567890"].join(""))
    ]));

    const scan = spawnSync(
      "node",
      ["scripts/check-desktop-evaluation-packet-secrets.mjs", "--packet", value.packet],
      { encoding: "utf8" }
    );
    expect(scan.status).toBe(1);
    expect(JSON.parse(scan.stdout).findings).toEqual(
      expect.arrayContaining([expect.objectContaining({
        file: "artifacts/NeonDiffDesktop.app/Contents/Resources/secret.car",
        pattern: "github_token"
      })])
    );
  });

  it("rejects a hash-consistent screenshot that is not PNG image evidence", () => {
    const value = packetFixture();
    const manifestPath = join(value.packet, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const item = manifest.cases[0];
    const screenshotPath = join(value.packet, item.screenshot.path);
    writeFileSync(screenshotPath, "renamed text is not screenshot evidence");
    item.screenshot.sha256 = sha256(screenshotPath);
    const size = `${item.requestedContentSize.width}x${item.requestedContentSize.height}`;
    const capturePath = join(value.packet, "cases", item.fixtureId, size, "capture.json");
    const capture = JSON.parse(readFileSync(capturePath, "utf8"));
    capture.screenshot.sha256 = item.screenshot.sha256;
    writeJSON(capturePath, capture);
    writeJSON(manifestPath, manifest);
    const result = verify(value.packet);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/PNG|image/i);
  });

  it("rejects a hash-consistent truncated PNG header without image data", () => {
    const value = packetFixture();
    const manifestPath = join(value.packet, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const item = manifest.cases[0];
    const screenshotPath = join(value.packet, item.screenshot.path);
    const truncated = completePng(1, 1).subarray(0, 24);
    writeFileSync(screenshotPath, truncated);
    item.screenshot.sha256 = sha256(screenshotPath);
    const size = `${item.requestedContentSize.width}x${item.requestedContentSize.height}`;
    const capturePath = join(value.packet, "cases", item.fixtureId, size, "capture.json");
    const capture = JSON.parse(readFileSync(capturePath, "utf8"));
    capture.screenshot.sha256 = item.screenshot.sha256;
    writeJSON(capturePath, capture);
    writeJSON(manifestPath, manifest);
    const result = verify(value.packet);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/PNG|image/i);
  });

  it("rejects unaccounted binary files outside the exact screenshot set", () => {
    const value = packetFixture();
    writeFileSync(join(value.packet, "customer.pdf"), "private binary-shaped attachment");
    const scan = spawnSync("node", ["scripts/check-desktop-evaluation-packet-secrets.mjs", "--packet", value.packet], { encoding: "utf8" });
    expect(scan.status).toBe(1);
    expect(JSON.parse(scan.stdout).unsupportedBinaryFiles).toContain("customer.pdf");
    const result = verify(value.packet);
    expect(result.status).not.toBe(0);
  });

  it("rejects binary content with an unknown extension anywhere outside the app artifact", () => {
    const value = packetFixture();
    const blob = join(value.packet, "cases", "fixture-00", "1040x680", "opaque-evidence");
    writeFileSync(blob, Buffer.from([0xff, 0xfe, 0xfd]));

    const scan = spawnSync(
      "node",
      ["scripts/check-desktop-evaluation-packet-secrets.mjs", "--packet", value.packet],
      { encoding: "utf8" }
    );
    expect(scan.status).toBe(1);
    expect(JSON.parse(scan.stdout).unsupportedBinaryFiles).toContain(
      "cases/fixture-00/1040x680/opaque-evidence"
    );
  });
});
