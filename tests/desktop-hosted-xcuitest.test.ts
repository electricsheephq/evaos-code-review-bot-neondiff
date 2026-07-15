import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const projectPath = "apps/neondiff-desktop/NeonDiffDesktop.xcodeproj/project.pbxproj";
const schemePath =
  "apps/neondiff-desktop/NeonDiffDesktop.xcodeproj/xcshareddata/xcschemes/NeonDiffDesktopHosted.xcscheme";
const testPlanPath = "apps/neondiff-desktop/NeonDiffDesktop.xctestplan";
const uiTestPath = "apps/neondiff-desktop/UITests/NeonDiffDesktopUITests.swift";
const workflowPath = ".github/workflows/swift-desktop-gate.yml";

function extractBalancedSwiftDeclaration(
  source: string,
  declaration: string
): string {
  const code = maskSwiftCommentsAndLiterals(source);
  const declarationStart = code.indexOf(declaration);
  if (declarationStart < 0) {
    throw new Error(`Missing Swift declaration: ${declaration}`);
  }
  if (code.indexOf(declaration, declarationStart + declaration.length) >= 0) {
    throw new Error(`Ambiguous Swift declaration: ${declaration}`);
  }

  const bodyStart = code.indexOf("{", declarationStart);
  if (bodyStart < 0) {
    throw new Error(`Missing Swift declaration body: ${declaration}`);
  }

  let depth = 0;
  for (let index = bodyStart; index < code.length; index += 1) {
    if (code[index] === "{") {
      depth += 1;
    } else if (code[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(declarationStart, index + 1);
    }
  }

  throw new Error(`Unbalanced Swift declaration body: ${declaration}`);
}

function maskSwiftCommentsAndLiterals(source: string): string {
  const masked = [...source];
  let index = 0;

  while (index < source.length) {
    if (source.startsWith("//", index)) {
      const end = source.indexOf("\n", index + 2);
      index = maskSwiftRange(masked, index, end < 0 ? source.length : end);
      continue;
    }
    if (source.startsWith("/*", index)) {
      let end = index + 2;
      let depth = 1;
      while (end < source.length && depth > 0) {
        if (source.startsWith("/*", end)) {
          depth += 1;
          end += 2;
        } else if (source.startsWith("*/", end)) {
          depth -= 1;
          end += 2;
        } else {
          end += 1;
        }
      }
      if (depth !== 0) throw new Error("Unterminated Swift block comment");
      index = maskSwiftRange(masked, index, end);
      continue;
    }

    const poundCount = countLeadingPounds(source, index);
    const literalStart = index + poundCount;
    const quoteCount = source.startsWith('\"\"\"', literalStart)
      ? 3
      : source[literalStart] === '\"'
        ? 1
        : 0;
    if (quoteCount > 0) {
      const closing = '\"'.repeat(quoteCount) + "#".repeat(poundCount);
      let end = literalStart + quoteCount;
      let closed = false;
      while (end < source.length) {
        if (poundCount === 0 && source[end] === "\\") {
          end += 2;
        } else if (source.startsWith(closing, end)) {
          end += closing.length;
          closed = true;
          break;
        } else {
          end += 1;
        }
      }
      if (!closed) throw new Error("Unterminated Swift string literal");
      index = maskSwiftRange(masked, index, end);
      continue;
    }

    if (poundCount > 0 && source[literalStart] === "/") {
      const end = findSwiftRegexEnd(
        source,
        literalStart + 1,
        "/" + "#".repeat(poundCount)
      );
      index = maskSwiftRange(masked, index, end);
      continue;
    }
    if (
      source[index] === "/" &&
      source[index + 1] !== "/" &&
      source[index + 1] !== "*" &&
      isSwiftBareRegexStart(masked, index)
    ) {
      const end = findSwiftRegexEnd(source, index + 1, "/");
      index = maskSwiftRange(masked, index, end);
      continue;
    }

    index += 1;
  }

  return masked.join("");
}

function countLeadingPounds(source: string, start: number): number {
  let count = 0;
  while (source[start + count] === "#") count += 1;
  return count;
}

function maskSwiftRange(masked: string[], start: number, end: number): number {
  for (let index = start; index < end; index += 1) {
    if (masked[index] !== "\n") masked[index] = " ";
  }
  return end;
}

function isSwiftBareRegexStart(masked: string[], index: number): boolean {
  let previousIndex = index - 1;
  while (previousIndex >= 0 && /\s/.test(masked[previousIndex])) {
    previousIndex -= 1;
  }
  if (previousIndex < 0) return true;
  return "=([{,:;!&|?+-*%^~<>".includes(masked[previousIndex]);
}

function findSwiftRegexEnd(
  source: string,
  contentStart: number,
  closing: string
): number {
  let inCharacterClass = false;
  let escaping = false;
  for (let index = contentStart; index < source.length; index += 1) {
    const current = source[index];
    if (escaping) {
      escaping = false;
    } else if (current === "\\") {
      escaping = true;
    } else if (current === "[") {
      inCharacterClass = true;
    } else if (current === "]") {
      inCharacterClass = false;
    } else if (!inCharacterClass && source.startsWith(closing, index)) {
      return index + closing.length;
    }
  }
  throw new Error("Unterminated Swift regex literal");
}

describe("hosted NeonDiff desktop XCTest foundation", () => {
  it("extracts a Swift declaration without literal or comment decoys", () => {
    const source = `
let decoy = #"private func target() { decoy() }"#
/* private func target() { commentDecoy() } */
private func target() {
  let raw = #"quote \" and brace } stay literal"#
  let multiline = ##"""
  quote " and brace } stay literal
  """##
  let pattern = /[}]/
  let extendedPattern = #/[}]/#
  expected()
}
`;

    expect(extractBalancedSwiftDeclaration(source, "private func target()"))
      .toContain("expected()");
    expect(() =>
      extractBalancedSwiftDeclaration(
        `${source}\nprivate func target() { duplicate() }`,
        "private func target()"
      )
    ).toThrow(/Ambiguous Swift declaration/);
  });

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
    const logs = readFileSync(
      "apps/neondiff-desktop/Sources/NeonDiffDesktop/Views/LogsView.swift",
      "utf8"
    );

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
    expect(source).toContain(
      'let context = "\\(checkpoint.section)-\\(checkpoint.surfaceGeneration)-\\(sample.elapsedMilliseconds)ms"'
    );
    expect(source).toContain('"baseline=\\(region.frame) candidate=\\(candidate.frame)"');
    expect(logs).toContain("ScrollView(.vertical)");
    expect(logs).toContain('.accessibilityIdentifier("neondiff-logs-outer-scroll")');
    expect(logs).toContain(".frame(height: 360)");
    expect(logs).not.toContain(".frame(minHeight: 420)");
  });

  it("encodes the hosted contract for each sidebar page outer-scroll bottom reachability", () => {
    const source = readFileSync(uiTestPath, "utf8");
    const pageSources = [
      ["overview", "OverviewView.swift"],
      ["repos", "ReposView.swift"],
      ["providers", "ProviderSettingsView.swift"],
      ["license", "LicenseView.swift"],
      ["logs", "LogsView.swift"],
      ["policy", "PolicyView.swift"],
      ["settings", "SettingsPane.swift"]
    ] as const;

    expect(source).toContain(
      "testStrictFixtureReachesEverySidebarPageBottomAtMinimumSize"
    );
    expect(source).toContain(
      'scenario: "every-sidebar-page-bottom-at-minimum-size"'
    );
    expect(source).toContain(
      'proofBoundary: "hosted-outer-page-bottom-reachability-only-inner-scroll-exhaustion-excluded"'
    );
    expect(
      source.match(/outerPageScroll\.scroll\(byDeltaX: 0, deltaY: -10_000\)/g)
    ).toHaveLength(1);
    expect(source.match(/\.scroll\s*\(/g)).toHaveLength(1);
    const checkpointSource = extractBalancedSwiftDeclaration(
      source,
      "private func capturePageBottomCheckpoint("
    );
    expect(checkpointSource.match(/\.scroll\s*\(/g)).toHaveLength(1);
    expect(checkpointSource).not.toMatch(
      /\.(?:swipe\w*|tap|click|press|drag|coordinate)\s*\(/
    );
    expect(checkpointSource).not.toMatch(
      /AXUIElement|CGEvent|NSEvent|XCUIRemote|performAction|setAttributeValue/
    );
    expect(checkpointSource).not.toContain("bottomSentinel.isHittable");
    expect(source).not.toContain("case hittableSentinel");
    expect(checkpointSource).toContain("preActionSamples.allSatisfy");
    expect(checkpointSource).toContain(
      "for (sampleIndex, postActionSample) in postActionSamples.enumerated()"
    );
    expect(source).toContain("try requireFullyContained(");
    expect(source).toContain('result: "returned"');
    expect(source).toContain("effectProven: true");
    expect(source).toContain("throw HostedPageBottomTraceError");
    expect(source).toContain("testRun?.failureCount");
    expect(source).toContain("priorValidationFailure");
    expect(source).toContain("minimumSampleIntervalMilliseconds: 100");
    expect(source).toContain("samplingDeadlineMilliseconds: 5_000");
    expect(source).toContain("neondiff-hosted-page-bottom-reachability.json");

    for (const [section, fileName] of pageSources) {
      const page = readFileSync(
        `apps/neondiff-desktop/Sources/NeonDiffDesktop/Views/${fileName}`,
        "utf8"
      );
      expect(page).toContain(
        `.accessibilityIdentifier("neondiff-${section}-outer-scroll")`
      );
      expect(page).toContain(`PageBottomSentinel(section: "${section}")`);
      expect(source).toContain(`"neondiff-${section}-page-bottom"`);
    }

    const theme = readFileSync(
      "apps/neondiff-desktop/Sources/NeonDiffDesktop/Views/NeonDiffTheme.swift",
      "utf8"
    );
    expect(theme).toContain("HostedEvaluationAccessibility.isActive");
    expect(theme).toContain('arguments.contains("--ui-testing")');
    const sentinelStart = theme.indexOf("struct PageBottomSentinel: View");
    const sentinelEnd = theme.indexOf(
      "private enum HostedEvaluationAccessibility",
      sentinelStart
    );
    expect(sentinelStart).toBeGreaterThan(-1);
    expect(sentinelEnd).toBeGreaterThan(sentinelStart);
    const sentinelSource = theme.slice(sentinelStart, sentinelEnd);
    expect(sentinelSource).toContain("#if DEBUG");
    expect(sentinelSource).toContain(".allowsHitTesting(false)");
    expect(sentinelSource).toContain(
      ".accessibilityRespondsToUserInteraction(false)"
    );
  });

  it("encodes the remaining canonical content-size matrix", () => {
    const source = readFileSync(uiTestPath, "utf8");

    expect(source).toContain(
      "testStrictFixtureSettlesAndReachesEverySidebarPageBottomAtRemainingCanonicalSizes"
    );
    expect(source).toContain("HostedContentSize(width: 1280, height: 800)");
    expect(source).toContain("HostedContentSize(width: 1440, height: 900)");
    expect(source).toContain('contentSizeArgument: "1280x800"');
    expect(source).toContain('contentSizeArgument: "1440x900"');
    expect(source).toContain(
      'proofBoundary: "hosted-remaining-canonical-size-outer-geometry-and-page-bottom-only-inner-scroll-exhaustion-excluded"'
    );
    expect(source).toContain("assertStableAcrossTransitions(geometryCheckpoints)");
    expect(source).toContain("HostedCanonicalSizeMatrixTrace(");
    expect(source).toContain("neondiff-hosted-canonical-size-matrix.json");
  });

  it("pins the strict accessibility3 large-text hosted matrix", () => {
    const source = readFileSync(uiTestPath, "utf8");
    const launchOptions = readFileSync(
      "apps/neondiff-desktop/Sources/NeonDiffDesktopEvaluationSupport/DesktopEvaluationLaunchOptions.swift",
      "utf8"
    );
    const resolvedLaunch = readFileSync(
      "apps/neondiff-desktop/Sources/NeonDiffDesktop/Support/DesktopResolvedEvaluationFixture.swift",
      "utf8"
    );
    const app = readFileSync(
      "apps/neondiff-desktop/Sources/NeonDiffDesktop/App/NeonDiffDesktopApp.swift",
      "utf8"
    );

    expect(source).toContain(
      "testStrictFixtureSettlesAndReachesEverySidebarPageBottomAtMinimumSizeWithAccessibility3Text"
    );
    expect(source).toContain('"--text-size", "accessibility3"');
    expect(source).toContain(
      'let textSizeMode = "swiftui-dynamic-type-accessibility3-test-override"'
    );
    expect(source).toContain(
      'proofBoundary: "hosted-accessibility3-minimum-size-outer-geometry-and-page-bottom-only-inner-scroll-exhaustion-excluded"'
    );
    expect(source).toContain("neondiff-hosted-large-text-matrix.json");
    expect(launchOptions).toContain('"--text-size"');
    expect(launchOptions).toContain("case accessibility3");
    expect(resolvedLaunch).toContain('"--text-size"');
    expect(resolvedLaunch).toContain("textSizeMode: DesktopResolvedEvaluationTextSizeMode");
    expect(app).toContain(".dynamicTypeSize(.accessibility3)");
    expect(app).toContain(
      String.raw`neondiff.fixture.\(fixtureId).text-size.accessibility3`
    );
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
