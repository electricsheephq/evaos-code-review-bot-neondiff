import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("desktop evaluation production boundary", () => {
  it("accepts a release artifact without evaluation hooks", () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-eval-boundary-safe-"));
    roots.push(root);
    const artifact = join(root, "NeonDiffDesktop");
    writeFileSync(artifact, "production desktop artifact");

    const output = execFileSync("node", ["scripts/check-desktop-fixture-boundary.mjs", artifact], {
      encoding: "utf8"
    });
    expect(JSON.parse(output)).toMatchObject({ ok: true, scannedFiles: 1 });
  });

  it("rejects UI-test flags and fixture markers in release artifacts", () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-eval-boundary-unsafe-"));
    roots.push(root);
    const artifact = join(root, "NeonDiffDesktop");
    writeFileSync(artifact, "release --ui-fixture NEONDIFF_DESKTOP_EVALUATION_FIXTURE_V1");

    const result = spawnSync("node", ["scripts/check-desktop-fixture-boundary.mjs", artifact], {
      encoding: "utf8"
    });
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, violationCount: 2 });
  });

  it("scans in-root symlink targets and rejects escaping symlinks", () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-eval-boundary-symlink-"));
    roots.push(root);
    const target = join(root, "fixture-payload");
    const link = join(root, "artifact-link");
    writeFileSync(target, "DesktopEvaluationFixture");
    symlinkSync(target, link);

    const inRoot = spawnSync("node", ["scripts/check-desktop-fixture-boundary.mjs", link], {
      encoding: "utf8"
    });
    expect(inRoot.status).toBe(1);
    expect(JSON.parse(inRoot.stdout)).toMatchObject({ ok: false, violationCount: 1 });

    const bundle = join(root, "Bundle.app");
    mkdirSync(bundle);
    const outside = join(root, "outside-payload");
    writeFileSync(outside, "production artifact");
    symlinkSync(outside, join(bundle, "escape"));
    const escaping = spawnSync("node", ["scripts/check-desktop-fixture-boundary.mjs", bundle], {
      encoding: "utf8"
    });
    expect(escaping.status).toBe(2);
    expect(escaping.stderr).toMatch(/escapes artifact root/);
  });

  it("wires the boundary scan and fixture checks into the Swift desktop gate", () => {
    const packageJSON = JSON.parse(readFileSync("package.json", "utf8"));
    const gate = readFileSync(".github/workflows/swift-desktop-gate.yml", "utf8");

    expect(packageJSON.scripts["check:desktop-fixture-boundary"]).toBe(
      "node scripts/check-desktop-fixture-boundary.mjs"
    );
    expect(gate).toMatch(/swift run NeonDiffDesktopFixtureChecks/);
    expect(gate).toMatch(/npm run check:desktop-fixture-boundary/);
    expect(gate).toMatch(/release_bin\/NeonDiffDesktop/);
    expect(gate).toMatch(/NEONDIFF_DESKTOP_DIST_DIR=.*dist-release/);
    expect(gate).toMatch(/release-bundle-check/);
    expect(gate).toMatch(/dist-release\/NeonDiffDesktop\.app/);

    const bundleBuilder = readFileSync("apps/neondiff-desktop/script/build_and_run.sh", "utf8");
    expect(bundleBuilder).toMatch(/NEONDIFF_DESKTOP_BUILD_CONFIGURATION/);
    expect(bundleBuilder).toMatch(/NEONDIFF_DESKTOP_DIST_DIR/);
    expect(bundleBuilder).toMatch(/release-bundle-check/);
  });

  it("keeps launched evaluation wiring debug-only and fail-closed", () => {
    const packageManifest = readFileSync("apps/neondiff-desktop/Package.swift", "utf8");
    const app = readFileSync(
      "apps/neondiff-desktop/Sources/NeonDiffDesktop/App/NeonDiffDesktopApp.swift",
      "utf8"
    );
    const launchContext = readFileSync(
      "apps/neondiff-desktop/Sources/NeonDiffDesktopEvaluationSupport/DesktopEvaluationLaunchContext.swift",
      "utf8"
    );

    const appTarget = packageManifest.match(/\.executableTarget\(\s*name: "NeonDiffDesktop",([\s\S]*?)resources:/)?.[1];
    expect(appTarget).toBeDefined();
    expect(appTarget).not.toContain("NeonDiffDesktopEvaluationSupport");
    expect(packageManifest).toMatch(/name: "NeonDiffDesktopFixtureResolve"[\s\S]*?"NeonDiffDesktopEvaluationSupport"/);
    expect(app).not.toContain("import NeonDiffDesktopEvaluationSupport");
    expect(app).toContain("DesktopResolvedEvaluationLaunch.load");
    expect(app).toMatch(/fatalError\("NeonDiff Desktop evaluation launch rejected/);
    expect(launchContext).toMatch(/isRegularFileKey/);
    expect(launchContext).toMatch(/isSymbolicLinkKey/);
    expect(launchContext).toMatch(/launch content size mismatch/);
  });

  it("captures exact native windows with non-prompting permission and readiness gates", () => {
    const helper = readFileSync(
      "apps/neondiff-desktop/Sources/NeonDiffDesktopCapture/main.swift",
      "utf8"
    );
    const runner = readFileSync(
      "apps/neondiff-desktop/scripts/capture-evaluation-baseline.sh",
      "utf8"
    );
    const readiness = readFileSync(
      "apps/neondiff-desktop/Sources/NeonDiffDesktop/Support/DesktopEvaluationReadiness.swift",
      "utf8"
    );
    const windowConfigurator = readFileSync(
      "apps/neondiff-desktop/Sources/NeonDiffDesktop/Support/NeonWindowConfigurator.swift",
      "utf8"
    );
    const app = readFileSync(
      "apps/neondiff-desktop/Sources/NeonDiffDesktop/App/NeonDiffDesktopApp.swift",
      "utf8"
    );
    const updater = readFileSync(
      "apps/neondiff-desktop/Sources/NeonDiffDesktop/Support/NeonUpdateController.swift",
      "utf8"
    );
    const manifestBuilder = readFileSync("scripts/build-desktop-evaluation-manifest.mjs", "utf8");

    expect(helper).toContain("CGPreflightScreenCaptureAccess()");
    expect(helper).toContain("AXIsProcessTrusted()");
    expect(helper).toContain("/usr/sbin/screencapture");
    expect(helper).toContain("exact PID/window identity mismatch");
    expect(helper).toContain("AXUIElementSetMessagingTimeout");
    expect(helper).toContain("screencapture timed out");
    expect(runner).toContain("canonical capture requires a clean worktree");
    expect(runner).toContain("umask 077");
    expect(runner).toMatch(/mktemp -d/);
    expect(runner).not.toContain('tmp_root="/tmp/neondiff-desktop-evaluation/$run_id"');
    expect(readiness).toContain("neondiff-desktop-evaluation\\.[A-Za-z0-9]{8}");
    expect(readiness).toContain("runRoot.deletingLastPathComponent().path == allowedParent.path");
    expect(readiness).toContain("values.isSymbolicLink != true");
    expect(runner).toContain("assert_clean_head");
    expect(runner).toContain('swift package --package-path "$package_dir" clean');
    expect(runner).toContain("NeonDiffDesktopCoreTests");
    expect(runner).toContain("NeonDiffDesktopAppCoreTests");
    expect(runner).toContain("NeonDiffDesktopEvaluationSupportTests");
    expect(runner).toContain("NEONDIFF_DESKTOP_EVALUATION_READY_PATH");
    expect(runner).toMatch(/for size in 1040x680 1280x800/);
    expect(runner).toContain("NeonDiffDesktopManifestChecks");
    expect(runner).toContain("check-desktop-evaluation-packet-secrets.mjs");
    expect(runner).toContain("verify-desktop-evaluation-packet.mjs");
    expect(runner).toContain("capture_pid");
    expect(runner).toContain("capture helper timed out");
    expect(runner).not.toMatch(/(^|\s)screencapture\s/);
    expect(windowConfigurator).toMatch(/readinessAttemptCount \+= 1[\s\S]*readinessAttemptCount < 50[\s\S]*renderLatch\.isReady/);
    expect(windowConfigurator).toContain("window.isRestorable = false");
    expect(app).toContain("applicationShouldRestoreSecureApplicationState");
    expect(app).toContain("failed to open a window through the Cmd+N menu action after exhausting retries");
    expect(app).toContain('keyEquivalent == "n"');
    expect(app).not.toContain('item(withTitle: "File")');
    expect(app).not.toContain('hasPrefix("New NeonDiff Desktop Window")');
    expect(updater).toContain("Updates blocked pending native activation proof");
    expect(updater).not.toContain("SPUStandardUpdaterController");
    expect(manifestBuilder).toContain('visualBaseline: { status: "captured-no-reference" }');
    expect(manifestBuilder).not.toContain("goldenMetrics");
    expect(runner).toContain("kill -KILL");
    const resolver = readFileSync(
      "apps/neondiff-desktop/Sources/NeonDiffDesktop/Support/DesktopResolvedEvaluationFixture.swift",
      "utf8"
    );
    expect(resolver).toContain("SIGKILL");
    expect(resolver).not.toContain("readDataToEndOfFile");
  });

  it("fails capture when evidence bytes cannot be read for hashing", () => {
    const helper = readFileSync(
      "apps/neondiff-desktop/Sources/NeonDiffDesktopCapture/main.swift",
      "utf8"
    );

    expect(helper).toMatch(/private func evidence\(_ url: URL\) throws/);
    expect(helper).toContain("try Data(contentsOf: url)");
    expect(helper).not.toContain("guard let data = try? Data(contentsOf: url) else { return \"\" }");
  });

  it("routes missing manifest files through the stable exit-65 contract", { timeout: 30_000 }, () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-manifest-checks-"));
    roots.push(root);
    const result = spawnSync(
      "swift",
      [
        "run",
        "--package-path",
        "apps/neondiff-desktop",
        "NeonDiffDesktopManifestChecks",
        join(root, "missing-manifest.json")
      ],
      { encoding: "utf8", timeout: 30_000 }
    );

    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(65);
    expect(result.stderr).toContain("manifest must be an absolute regular non-symlink file");
    expect(result.stderr).not.toMatch(/Fatal error|uncaught/i);
  });

  it("records the current Xcode host without treating issue 516 as an install blocker", () => {
    const docs = readFileSync("apps/neondiff-desktop/docs/ui-evaluation.md", "utf8");

    expect(docs).toMatch(/Xcode 26\.6 is installed and selected/);
    expect(docs).toMatch(/hosted XCUITest\/`.xcresult` coverage remains #516/);
    expect(docs).not.toContain("full-Xcode/storage gated");
  });
});
