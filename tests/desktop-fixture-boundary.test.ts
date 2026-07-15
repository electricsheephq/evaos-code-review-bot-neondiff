import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
const fixtureMarkers = [
  "RecordingDesktopDependencies",
  "--ui-testing",
  "NEONDIFF_DESKTOP_VISUAL_PROOF_FIXTURE",
  "VisualProofDesktopDependencies",
  "VisualProofSecretStore",
  "DesktopEvaluationFixtureCatalog",
  "DesktopEvaluationLaunchContext",
  "DesktopEvaluationModelAdapter",
  "DesktopEvaluationDependencies",
  "DesktopEvaluationReadiness",
  "DesktopResolvedEvaluationFixture",
  "NeonDiffDesktopFixtureResolve",
  "DesktopModelInitialState",
  "applyInitialState",
  "NEONDIFF_DESKTOP_EVALUATION_READY_PATH"
];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function releaseArtifacts() {
  const root = mkdtempSync(join(tmpdir(), "neondiff-desktop-release-boundary-"));
  roots.push(root);
  const appCoreBuild = join(root, "release", "NeonDiffDesktopAppCore.build");
  const appCoreModule = join(root, "release", "Modules", "NeonDiffDesktopAppCore.swiftmodule");
  const appBundle = join(root, "dist-release", "NeonDiffDesktop.app");
  mkdirSync(appCoreBuild, { recursive: true });
  mkdirSync(appCoreModule, { recursive: true });
  mkdirSync(join(appBundle, "Contents", "Resources"), { recursive: true });
  mkdirSync(join(appBundle, "Contents", "Frameworks", "Fixture.framework"), { recursive: true });
  return {
    root,
    appCoreBuild,
    appCoreModule,
    appBundle,
    object: join(appCoreBuild, "NeonDiffDesktopModel.swift.o"),
    module: join(appCoreModule, "arm64-apple-macos.swiftmodule"),
    resource: join(appBundle, "Contents", "Resources", "payload"),
    framework: join(appBundle, "Contents", "Frameworks", "Fixture.framework", "Fixture")
  };
}

function scan(paths: string[]) {
  return spawnSync("node", ["scripts/check-desktop-fixture-boundary.mjs", ...paths], { encoding: "utf8" });
}

describe("desktop fixture release-artifact boundary", () => {
  it("anchors every allowed dSYM basename to an existing whole-file DEBUG app source", () => {
    const scannerSource = readFileSync("scripts/check-desktop-fixture-boundary.mjs", "utf8");
    const manifestMatch = scannerSource.match(/const ALLOWED_DSYM_DEBUG_SOURCE_PATHS = (\[[\s\S]*?\]);/);
    expect(manifestMatch).not.toBeNull();
    const sourcePaths = JSON.parse(manifestMatch![1]) as unknown;
    expect(Array.isArray(sourcePaths)).toBe(true);
    expect(sourcePaths).toHaveLength(5);
    expect(sourcePaths.every((sourcePath) => typeof sourcePath === "string")).toBe(true);

    const typedSourcePaths = sourcePaths as string[];
    expect(new Set(typedSourcePaths).size).toBe(typedSourcePaths.length);
    const appSourceRoot = "apps/neondiff-desktop/Sources/NeonDiffDesktop";
    const appSwiftPaths = readdirSync(appSourceRoot, { recursive: true, encoding: "utf8" })
      .filter((entry) => entry.endsWith(".swift"))
      .map((entry) => join(appSourceRoot, entry));

    for (const sourcePath of typedSourcePaths) {
      expect(sourcePath.startsWith(`${appSourceRoot}/`), sourcePath).toBe(true);
      const source = readFileSync(sourcePath, "utf8").trim();
      expect(source, sourcePath).toMatch(/^#if DEBUG\n/);
      expect(source, sourcePath).toMatch(/\n#endif$/);
      const basename = sourcePath.split("/").at(-1);
      expect(appSwiftPaths.filter((path) => path.endsWith(`/${basename}`)), sourcePath).toEqual([sourcePath]);
    }
  });

  it("accepts clean AppCore objects, modules, resources, and frameworks", () => {
    const artifacts = releaseArtifacts();
    for (const path of [artifacts.object, artifacts.module, artifacts.resource, artifacts.framework]) {
      writeFileSync(path, "release desktop artifact");
    }

    const result = scan([artifacts.appCoreBuild, artifacts.appCoreModule, artifacts.appBundle]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, violationCount: 0, scannedFiles: 4 });
  });

  it.each([
    ["AppCore object", "object"],
    ["AppCore swiftmodule", "module"],
    ["release app resource", "resource"],
    ["release app framework", "framework"]
  ] as const)("rejects %s leakage markers", (_surface, key) => {
    for (const marker of fixtureMarkers) {
      const artifacts = releaseArtifacts();
      writeFileSync(artifacts[key], `release artifact ${marker}`);

      const result = scan([artifacts.appCoreBuild, artifacts.appCoreModule, artifacts.appBundle]);
      expect(result.status, marker).toBe(1);
      expect(JSON.parse(result.stdout), marker).toMatchObject({
        ok: false,
        violations: expect.arrayContaining([expect.objectContaining({ marker })])
      });
    }
  });

  it("refuses release-bundle symlinks that escape the artifact root", () => {
    const artifacts = releaseArtifacts();
    const outside = join(artifacts.root, "outside-payload");
    writeFileSync(outside, "release desktop artifact");
    symlinkSync(outside, join(artifacts.appBundle, "Contents", "Resources", "escape"));

    const result = scan([artifacts.appBundle]);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/symlink escapes artifact root/);
  });

  it("fails closed when an empty directory symlink DAG exceeds the traversal bound", () => {
    const artifacts = releaseArtifacts();
    const archive = join(artifacts.root, "NeonDiffDesktop.xcarchive");
    const layers = join(archive, "empty-alias-layers");
    const depth = 14;
    for (let index = 0; index <= depth; index += 1) {
      mkdirSync(join(layers, `layer-${index}`), { recursive: true });
    }
    for (let index = 0; index < depth; index += 1) {
      const layer = join(layers, `layer-${index}`);
      const target = `../layer-${index + 1}`;
      symlinkSync(target, join(layer, "left"));
      symlinkSync(target, join(layer, "right"));
    }

    const result = scan([archive]);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/artifact traversal exceeds scan bound/);
  });

  it("rejects the canonical fixture at an archive-like resource path", () => {
    const artifacts = releaseArtifacts();
    const fixturePath = join(
      artifacts.root,
      "NeonDiffDesktop.xcarchive",
      "Products",
      "Applications",
      "NeonDiffDesktop.app",
      "Contents",
      "Resources",
      "fixtures",
      "ui",
      "tab-overview.json"
    );
    mkdirSync(join(fixturePath, ".."), { recursive: true });
    writeFileSync(
      fixturePath,
      readFileSync("apps/neondiff-desktop/fixtures/ui/tab-overview.json")
    );

    const result = scan([join(artifacts.root, "NeonDiffDesktop.xcarchive")]);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      violations: expect.arrayContaining([
        expect.objectContaining({ marker: "path:fixtures/ui" }),
        expect.objectContaining({ marker: "content:tab-overview" })
      ])
    });
  });

  it("accepts an excluded DEBUG source filename in dSYM metadata", () => {
    const artifacts = releaseArtifacts();
    const dwarf = join(
      artifacts.root,
      "NeonDiffDesktop.xcarchive",
      "dSYMs",
      "NeonDiffDesktop.app.dSYM",
      "Contents",
      "Resources",
      "DWARF",
      "NeonDiffDesktop"
    );
    mkdirSync(join(dwarf, ".."), { recursive: true });
    writeFileSync(
      dwarf,
      "/build/Sources/NeonDiffDesktop/Support/DesktopEvaluationReadiness.swift\0"
    );

    const result = scan([join(artifacts.root, "NeonDiffDesktop.xcarchive")]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      violationCount: 0,
      scannedFiles: 1
    });
  });

  it("rejects an evaluation symbol in dSYM metadata after an allowed source filename", () => {
    const artifacts = releaseArtifacts();
    const dwarf = join(
      artifacts.root,
      "NeonDiffDesktop.xcarchive",
      "dSYMs",
      "NeonDiffDesktop.app.dSYM",
      "Contents",
      "Resources",
      "DWARF",
      "NeonDiffDesktop"
    );
    mkdirSync(join(dwarf, ".."), { recursive: true });
    writeFileSync(
      dwarf,
      "/build/Support/DesktopEvaluationReadiness.swift\0_$s15NeonDiffDesktop26DesktopEvaluationReadinessV"
    );

    const result = scan([join(artifacts.root, "NeonDiffDesktop.xcarchive")]);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      violations: expect.arrayContaining([
        expect.objectContaining({ marker: "DesktopEvaluationReadiness" })
      ])
    });
  });

  it("rejects an allowlisted basename without a path-component boundary", () => {
    const artifacts = releaseArtifacts();
    const dwarf = join(
      artifacts.root,
      "NeonDiffDesktop.xcarchive",
      "dSYMs",
      "NeonDiffDesktop.app.dSYM",
      "Contents",
      "Resources",
      "DWARF",
      "NeonDiffDesktop"
    );
    mkdirSync(join(dwarf, ".."), { recursive: true });
    writeFileSync(dwarf, "leaked DesktopEvaluationReadiness.swift\0");

    const result = scan([join(artifacts.root, "NeonDiffDesktop.xcarchive")]);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      violations: expect.arrayContaining([
        expect.objectContaining({ marker: "DesktopEvaluationReadiness" })
      ])
    });
  });

  it("rejects a fake nested dSYM path inside a release app resource", () => {
    const artifacts = releaseArtifacts();
    const payload = join(
      artifacts.appBundle,
      "Contents",
      "Resources",
      "payload.dSYM",
      "Contents",
      "Resources",
      "DWARF",
      "payload"
    );
    mkdirSync(join(payload, ".."), { recursive: true });
    writeFileSync(
      payload,
      "/build/Sources/NeonDiffDesktop/Support/DesktopEvaluationReadiness.swift\0"
    );

    const result = scan([artifacts.appBundle]);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      violations: expect.arrayContaining([
        expect.objectContaining({ marker: "DesktopEvaluationReadiness" })
      ])
    });
  });

  it("rejects an allowed source filename in an unrelated top-level archive dSYM", () => {
    const artifacts = releaseArtifacts();
    const archive = join(artifacts.root, "NeonDiffDesktop.xcarchive");
    const dwarf = join(
      archive,
      "dSYMs",
      "Other.framework.dSYM",
      "Contents",
      "Resources",
      "DWARF",
      "Other"
    );
    mkdirSync(dirname(dwarf), { recursive: true });
    writeFileSync(dwarf, "/build/Support/DesktopEvaluationReadiness.swift\0");

    const result = scan([archive]);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      violations: expect.arrayContaining([
        expect.objectContaining({ marker: "DesktopEvaluationReadiness" })
      ])
    });
  });

  it("rejects an allowed source filename in an alternate-case app dSYM path", () => {
    const artifacts = releaseArtifacts();
    const archive = join(artifacts.root, "NeonDiffDesktop.xcarchive");
    const dwarf = join(
      archive,
      "dSyMs",
      "NeonDiffDesktop.App.dSYM",
      "Contents",
      "Resources",
      "DWARF",
      "NeonDiffDesktop"
    );
    mkdirSync(dirname(dwarf), { recursive: true });
    writeFileSync(dwarf, "/build/Support/DesktopEvaluationReadiness.swift\0");

    const result = scan([archive]);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      violations: expect.arrayContaining([
        expect.objectContaining({ marker: "DesktopEvaluationReadiness" })
      ])
    });
  });

  it("scans an archive dSYM file again without masking through an app-resource symlink", () => {
    const artifacts = releaseArtifacts();
    const archive = join(artifacts.root, "NeonDiffDesktop.xcarchive");
    const dwarf = join(
      archive,
      "dSYMs",
      "NeonDiffDesktop.app.dSYM",
      "Contents",
      "Resources",
      "DWARF",
      "NeonDiffDesktop"
    );
    mkdirSync(dirname(dwarf), { recursive: true });
    writeFileSync(dwarf, "/build/Support/DesktopEvaluationReadiness.swift\0");

    const alias = join(
      archive,
      "Products",
      "Applications",
      "NeonDiffDesktop.app",
      "Contents",
      "Resources",
      "leaked-debug-payload"
    );
    mkdirSync(dirname(alias), { recursive: true });
    symlinkSync(relative(dirname(alias), dwarf), alias);

    const result = scan([archive]);
    expect(result.status).toBe(1);
    const report = JSON.parse(result.stdout);
    expect(report).toMatchObject({
      ok: false,
      violations: expect.arrayContaining([
        expect.objectContaining({ marker: "DesktopEvaluationReadiness" })
      ])
    });
    const aliasViolation = report.violations.find(
      (violation: { path: string; marker: string }) => violation.marker === "DesktopEvaluationReadiness"
    );
    expect(aliasViolation.path).toMatch(
      /\/Products\/Applications\/NeonDiffDesktop\.app\/Contents\/Resources\/leaked-debug-payload$/
    );
  });

  it("rejects a top-level dSYMs tree when the scan root is not an xcarchive", () => {
    const artifacts = releaseArtifacts();
    const dwarf = join(
      artifacts.root,
      "dSYMs",
      "NeonDiffDesktop.app.dSYM",
      "Contents",
      "Resources",
      "DWARF",
      "NeonDiffDesktop"
    );
    mkdirSync(join(dwarf, ".."), { recursive: true });
    writeFileSync(
      dwarf,
      "/build/Sources/NeonDiffDesktop/Support/DesktopEvaluationReadiness.swift\0"
    );

    const result = scan([artifacts.root]);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      violations: expect.arrayContaining([
        expect.objectContaining({ marker: "DesktopEvaluationReadiness" })
      ])
    });
  });

  it("scans only release fixture surfaces and all debug/release Core and AppCore secret surfaces", () => {
    const gate = readFileSync(".github/workflows/swift-desktop-gate.yml", "utf8");

    expect(gate).toMatch(/npm run check:desktop-fixture-boundary --[\s\S]*?"\$release_bin\/NeonDiffDesktop"/);
    expect(gate).toContain('"$release_bin/NeonDiffDesktopCore.build"');
    expect(gate).toContain('"$release_bin/NeonDiffDesktopAppCore.build"');
    expect(gate).toContain('"$release_bin/Modules/NeonDiffDesktopCore.swiftmodule"');
    expect(gate).toContain('"$release_bin/Modules/NeonDiffDesktopAppCore.swiftmodule"');
    expect(gate).toContain('"apps/neondiff-desktop/dist-release/NeonDiffDesktop.app"');
    expect(gate).toContain('"$RELEASE_ARCHIVE"');
    expect(gate).not.toMatch(/npm run check:desktop-fixture-boundary --[\s\S]*?"\$debug_bin\/NeonDiffDesktop/);
    expect(gate).toMatch(
      /Archive Release fixture boundary[\s\S]*?npm run check:secret-corpus-boundary --[\s\S]*?"\$RELEASE_ARCHIVE"/
    );

    for (const target of [
      '"$debug_bin/NeonDiffDesktop"',
      '"$release_bin/NeonDiffDesktop"',
      '"$debug_bin/NeonDiffDesktopCore.build"',
      '"$release_bin/NeonDiffDesktopCore.build"',
      '"$debug_bin/NeonDiffDesktopAppCore.build"',
      '"$release_bin/NeonDiffDesktopAppCore.build"',
      '"$debug_bin/Modules/NeonDiffDesktopCore.swiftmodule"',
      '"$release_bin/Modules/NeonDiffDesktopCore.swiftmodule"',
      '"$debug_bin/Modules/NeonDiffDesktopAppCore.swiftmodule"',
      '"$release_bin/Modules/NeonDiffDesktopAppCore.swiftmodule"'
    ]) expect(gate).toContain(target);
  });
});
