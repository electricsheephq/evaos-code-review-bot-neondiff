import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const projectPath = "apps/neondiff-desktop/NeonDiffDesktop.xcodeproj/project.pbxproj";
const schemePath =
  "apps/neondiff-desktop/NeonDiffDesktop.xcodeproj/xcshareddata/xcschemes/NeonDiffDesktopHosted.xcscheme";
const testPlanPath = "apps/neondiff-desktop/NeonDiffDesktop.xctestplan";
const uiTestPath = "apps/neondiff-desktop/UITests/NeonDiffDesktopUITests.swift";
const workflowPath = ".github/workflows/swift-desktop-gate.yml";

describe("hosted NeonDiff desktop XCTest foundation", () => {
  it("checks in a shared app/UI-test project and test plan", () => {
    expect(existsSync(projectPath)).toBe(true);
    expect(existsSync(schemePath)).toBe(true);
    expect(existsSync(testPlanPath)).toBe(true);

    const project = readFileSync(projectPath, "utf8");
    expect(project).toContain("com.apple.product-type.application");
    expect(project).toContain("com.apple.product-type.bundle.ui-testing");
    expect(project).toContain("NeonDiffDesktopAppCore");
    expect(project).toContain("NeonDiffDesktopCore");
    expect(project).toContain("Sparkle in Frameworks");
    expect(project).toContain("name = NeonDiffDesktopHostedApp");
    expect(project).toContain("productName = NeonDiffDesktop");
    expect(project).toContain(
      "PRODUCT_BUNDLE_IDENTIFIER = com.electricsheephq.NeonDiffDesktop"
    );
    expect(project).toContain("TEST_TARGET_NAME = NeonDiffDesktopHostedApp");
    expect(project).not.toMatch(/CODE_SIGNING_ALLOWED\s*=\s*["']?NO["']?/i);
    expect(project).not.toContain("UITargetAppPath");
    expect(project).not.toContain("UITargetAppBundleIdentifier");

    const scheme = readFileSync(schemePath, "utf8");
    expect(scheme).toContain('reference = "container:NeonDiffDesktop.xctestplan"');

    const plan = JSON.parse(readFileSync(testPlanPath, "utf8"));
    expect(plan.version).toBe(1);
    expect(plan.testTargets).toHaveLength(1);
    expect(plan.testTargets[0].target.name).toBe("NeonDiffDesktopUITests");
  });

  it("launches the strict deterministic fixture contract and finds its native root", () => {
    const project = readFileSync(projectPath, "utf8");
    const source = readFileSync(uiTestPath, "utf8");
    const scheme = readFileSync(schemePath, "utf8");
    expect(project).toContain("NeonDiffDesktopFixtureResolve");
    expect(project).toContain("NeonDiffDesktopEvaluationSupport in Frameworks");
    expect(project).toContain("$(CONTENTS_FOLDER_PATH)/Helpers");
    expect(project).toContain('$CONFIGURATION\\" != \\"Debug');
    expect(project).toContain("alwaysOutOfDate = 1;");
    expect(project.match(/SKIP_INSTALL = YES;/g)).toHaveLength(2);
    expect(project).toContain("tab-overview.json in Resources");
    expect(source).toContain('"--ui-testing"');
    expect(source).toContain('"--ui-fixture"');
    expect(source).toContain('"--content-size"');
    expect(source).toContain('"1040x680"');
    expect(source).toContain('"--disable-animations"');
    expect(source).toContain('"tab-overview"');
    expect(source).toContain('"neondiff.fixture.tab-overview"');
    expect(source).not.toContain("createDirectory");
    expect(source).not.toContain("setAttributes");
    expect(source).not.toContain("NEONDIFF_DESKTOP_EVALUATION_READY_PATH");
    expect(scheme).toContain('parallelizeBuildables = "NO"');
    expect(scheme).toMatch(
      /buildForArchiving = "NO"[\s\S]{0,700}BlueprintIdentifier = "A10000000000000000000012"/
    );
    expect(project).not.toContain("remoteInfo = NeonDiffDesktopFixtureResolve");
    expect(source).toContain("XCUIApplication()");
    expect(source).not.toContain('NEONDIFF_DESKTOP_VISUAL_PROOF_FIXTURE');
  });

  it("retains app-authored quiescent cross-tab geometry evidence in the xcresult", () => {
    const source = readFileSync(uiTestPath, "utf8");
    const app = readFileSync(
      "apps/neondiff-desktop/Sources/NeonDiffDesktop/App/NeonDiffDesktopApp.swift",
      "utf8"
    );
    const content = readFileSync(
      "apps/neondiff-desktop/Sources/NeonDiffDesktop/Views/ContentView.swift",
      "utf8"
    );
    const readiness = readFileSync(
      "apps/neondiff-desktop/Sources/NeonDiffDesktop/Support/DesktopEvaluationReadiness.swift",
      "utf8"
    );
    const configurator = readFileSync(
      "apps/neondiff-desktop/Sources/NeonDiffDesktop/Support/NeonWindowConfigurator.swift",
      "utf8"
    );
    const sidebar = readFileSync(
      "apps/neondiff-desktop/Sources/NeonDiffDesktop/Views/SidebarView.swift",
      "utf8"
    );

    expect(source).toContain("testStrictFixtureSettlesAcrossOverviewReposOverview");
    expect(source).toContain('"neondiff.evaluation.surface.overview.0.quiescent"');
    expect(source).toContain('"neondiff.evaluation.surface.repos.1.quiescent"');
    expect(source).toContain('"neondiff.evaluation.surface.overview.2.quiescent"');
    expect(source).toContain('"neondiff-sidebar-section-repos"');
    expect(source).toContain('"neondiff-sidebar-section-overview"');
    expect(source).toContain("button.click()");
    expect(source).not.toContain("button.tap()");
    expect(source).toContain('"neondiff-chrome"');
    expect(source).toContain('"neondiff-sidebar"');
    expect(source).toContain('"neondiff-detail"');
    expect(source).toContain("sampleIntervalMilliseconds: 100");
    expect(source).toContain("tolerancePoints: 1");
    expect(source).toContain('windowAndContent: "appkit-screen"');
    expect(source).toContain('regions: "swiftui-global"');
    expect(source).toContain("observedContentGeometry:");
    expect(source).toContain("assertObservedContentSize(");
    expect(source).toContain("marker.label");
    expect(source).toContain("parseAppAuthoredGeometrySamples(");
    expect(source).toContain('"ndg2-chunks:4"');
    expect(source).toContain('"ndg2:\\(index):4:"');
    expect(source).toContain("CompactHostedGeometryCursor");
    expect(source).toContain("invalidTransportManifest");
    expect(source).toContain("invalidTransportChunk");
    expect(source).toContain("neondiff-hosted-transport-diagnostic.json");
    expect(source).toMatch(/XCTAssertFalse\(\s*marker\.isHittable/);
    expect(source).not.toContain("Thread.sleep");
    expect(source).toContain("XCTAttachment");
    expect(source).toContain("neondiff-hosted-settled-geometry.json");
    expect(source).toContain(".keepAlways");

    expect(readiness).toContain("final class DesktopEvaluationSurfaceStatus: ObservableObject");
    expect(readiness).toContain("func begin(section:");
    expect(readiness).toContain("func markRendered(section:");
    expect(readiness).toContain("func markQuiescent(");
    expect(readiness).toContain("contentFrame:");
    expect(readiness).toContain("geometryAccessibilityManifest");
    expect(readiness).toContain("geometryAccessibilityChunks");
    expect(readiness).toContain('"rendered-regions-ready"');
    expect(readiness).toContain('"rendered-regions-missing"');
    expect(readiness).toContain("DesktopHostedGeometryCompactTransport");
    expect(readiness).toContain("chunkByteCount = 68");
    expect(readiness).toContain("label.utf8.count <= 128");
    expect(readiness).toContain("DesktopHostedGeometrySample");
    expect(readiness).toContain("updateRegionFrames(");
    expect(configurator).toContain("surfaceStatus.isRendered(");
    expect(configurator).toContain("surfaceStatus.markQuiescent(");
    expect(configurator).toContain("surfaceStatus.hostedGeometrySample(");
    expect(content).toContain("EvaluationSurfaceAccessibilityMarker");
    expect(content).toContain("EvaluationSurfaceGeometryChunkMarker");
    expect(content).toContain(".accessibilityLabel(status.geometryAccessibilityManifest)");
    expect(content).toContain(".accessibilityLabel(chunk.label)");
    expect(content).not.toContain(".accessibilityValue(status.geometryAccessibilityValue)");
    expect(content).toContain("EvaluationRegionFramesPreferenceKey");
    expect(content).toContain("EvaluationRegionFrameCollector");
    expect(content).toContain("@ObservedObject var status: DesktopEvaluationSurfaceStatus");
    expect(content).toContain("content(status.snapshot?.generation)");
    expect(content).toContain("GenerationBoundRegionFrameRouting.route(");
    expect(sidebar).toMatch(
      /\.padding\(\.horizontal, 10\)\s*\.padding\(\.vertical, 9\)\s*\.contentShape\(Rectangle\(\)\)/
    );
    expect(app).toContain("evaluationSurfaceStatus");
    expect(source).not.toContain("NEONDIFF_DESKTOP_EVALUATION_READY_PATH");
    expect(source).not.toContain("createDirectory");
  });

  it("covers every sidebar destination in one minimum-size settled circuit", () => {
    const source = readFileSync(uiTestPath, "utf8");

    expect(source).toContain(
      "testStrictFixtureSettlesAcrossEverySidebarSectionAtMinimumSize"
    );
    expect(source).toContain(
      'scenario: "overview-repos-providers-license-logs-policy-settings-overview"'
    );
    expect(source).toContain(
      'proofBoundary: "hosted-every-sidebar-destination-minimum-size-geometry-only"'
    );
    expect(source).toContain('HostedSidebarRouteStep(section: "overview", generation: 0)');
    expect(source).toContain('HostedSidebarRouteStep(section: "repos", generation: 1)');
    expect(source).toContain('HostedSidebarRouteStep(section: "providers", generation: 2)');
    expect(source).toContain('HostedSidebarRouteStep(section: "license", generation: 3)');
    expect(source).toContain('HostedSidebarRouteStep(section: "logs", generation: 4)');
    expect(source).toContain('HostedSidebarRouteStep(section: "policy", generation: 5)');
    expect(source).toContain('HostedSidebarRouteStep(section: "settings", generation: 6)');
    expect(source).toContain('HostedSidebarRouteStep(section: "overview", generation: 7)');
    expect(source).toContain("XCTAssertEqual(checkpoints.count, 8)");
    expect(source).toContain("XCTAssertEqual(navigationActions.count, 7)");
  });

  it("runs xcodebuild at the exact head and always uploads the immutable xcresult", () => {
    const workflow = readFileSync(workflowPath, "utf8");
    expect(workflow).toContain("Hosted XCUITest smoke");
    expect(workflow).toContain("xcodebuild test");
    expect(workflow).toContain("NeonDiffDesktop.xcodeproj");
    expect(workflow).toContain("-scheme NeonDiffDesktopHosted");
    expect(workflow).toContain("-testPlan NeonDiffDesktop");
    expect(workflow).toContain(
      'ref: ${{ github.event.pull_request.head.sha || github.sha }}'
    );
    expect(workflow).toContain(
      'PROOF_SHA: ${{ github.event.pull_request.head.sha || github.sha }}'
    );
    expect(workflow).toContain(
      'DEVELOPER_DIR: /Applications/Xcode_16.4.app/Contents/Developer'
    );
    expect(workflow).toContain("Record pinned Xcode toolchain");
    expect(workflow).toContain('test "$(git rev-parse HEAD)" = "$PROOF_SHA"');
    expect(workflow).toContain(
      'NeonDiffDesktop-${{ github.event.pull_request.head.sha || github.sha }}.xcresult'
    );
    expect(workflow).toContain(
      'neondiff-desktop-xcresult-${{ github.event.pull_request.head.sha || github.sha }}'
    );
    expect(workflow).toContain("actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02");
    expect(workflow).toContain("xcodebuild archive");
    expect(workflow).toContain('RELEASE_ARCHIVE: ${{ runner.temp }}/NeonDiffDesktop-release.xcarchive');
    expect(workflow).toContain('"$RELEASE_ARCHIVE"');
    expect(workflow).not.toMatch(/CODE_SIGNING_ALLOWED\s*=\s*["']?NO["']?/i);

    const routing = JSON.parse(execFileSync(
      "node",
      ["scripts/swift-affected.mjs", "--files", "tests/desktop-hosted-xcuitest.test.ts"],
      { encoding: "utf8" }
    ));
    expect(routing).toMatchObject({
      affected: true,
      matched: ["tests/desktop-hosted-xcuitest.test.ts"]
    });
  });
});
