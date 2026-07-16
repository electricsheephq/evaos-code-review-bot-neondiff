import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const projectPath = "apps/neondiff-desktop/NeonDiffDesktop.xcodeproj/project.pbxproj";
const schemePath =
  "apps/neondiff-desktop/NeonDiffDesktop.xcodeproj/xcshareddata/xcschemes/NeonDiffDesktopHosted.xcscheme";
const testPlanPath = "apps/neondiff-desktop/NeonDiffDesktop.xctestplan";
const uiTestPath = "apps/neondiff-desktop/UITests/NeonDiffDesktopUITests.swift";
const themePath =
  "apps/neondiff-desktop/Sources/NeonDiffDesktop/Views/NeonDiffTheme.swift";
const appPath =
  "apps/neondiff-desktop/Sources/NeonDiffDesktop/App/NeonDiffDesktopApp.swift";
const settingsPath =
  "apps/neondiff-desktop/Sources/NeonDiffDesktop/Views/SettingsPane.swift";
const reposPath =
  "apps/neondiff-desktop/Sources/NeonDiffDesktop/Views/ReposView.swift";
const logsPath =
  "apps/neondiff-desktop/Sources/NeonDiffDesktop/Views/LogsView.swift";
const hostedInnerScrollFixturePath =
  "apps/neondiff-desktop/UITests/Fixtures/hosted-inner-scroll-overflow.json";
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractPbxObject(source: string, objectId: string, comment: string): string {
  const pattern = new RegExp(
    `^\\t\\t${escapeRegExp(objectId)} /\\* ${escapeRegExp(comment)} \\*/ = \\{[\\s\\S]*?^\\t\\t\\};$`,
    "m"
  );
  const matches = source.match(new RegExp(pattern.source, "gm")) ?? [];
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one PBX object: id=${objectId} comment=${comment} count=${matches.length}`
    );
  }
  return matches[0];
}

function extractPbxNativeTarget(source: string, targetComment: string): string {
  const section = source.match(
    /\/\* Begin PBXNativeTarget section \*\/[\s\S]*?\/\* End PBXNativeTarget section \*\//
  )?.[0];
  if (!section) throw new Error("Missing PBXNativeTarget section");
  const targetPattern = new RegExp(
    `^\\t\\t([A-F0-9]{24}) /\\* ${escapeRegExp(targetComment)} \\*/ = \\{`,
    "gm"
  );
  const targetIds = [...section.matchAll(targetPattern)].map((match) => match[1]);
  if (targetIds.length !== 1) {
    throw new Error(
      `Expected exactly one PBX native target: ${targetComment} count=${targetIds.length}`
    );
  }
  return extractPbxObject(source, targetIds[0], targetComment);
}

function extractPbxResourcesPhaseForTarget(source: string, target: string): string {
  const buildPhases = target.match(/buildPhases = \([\s\S]*?\);/)?.[0];
  if (!buildPhases) throw new Error("Target has no buildPhases list");
  const resourceIds = [
    ...buildPhases.matchAll(/([A-F0-9]{24}) \/\* Resources \*\//g),
  ].map((match) => match[1]);
  if (resourceIds.length !== 1) {
    throw new Error(
      `Expected exactly one Resources phase for target, found ${resourceIds.length}`
    );
  }
  return extractPbxObject(source, resourceIds[0], "Resources");
}

function extractPbxSynchronizedRootsForTarget(
  source: string,
  target: string
): string[] {
  const synchronizedGroups = target.match(
    /fileSystemSynchronizedGroups = \([\s\S]*?\);/
  )?.[0];
  if (!synchronizedGroups) {
    throw new Error("Target has no fileSystemSynchronizedGroups list");
  }
  const groups = [
    ...synchronizedGroups.matchAll(/([A-F0-9]{24}) \/\* ([^*]+) \*\//g),
  ];
  if (groups.length === 0) {
    throw new Error("Target has no synchronized root groups");
  }
  return groups.map((match) =>
    extractPbxObject(source, match[1], match[2].trim())
  );
}

function projectSwiftReleaseSource(source: string): string {
  const lines = source.match(/.*(?:\n|$)/g)?.filter(Boolean) ?? [];
  const maskedLines =
    maskSwiftCommentsAndLiterals(source).match(/.*(?:\n|$)/g)?.filter(Boolean) ?? [];
  if (maskedLines.length !== lines.length) {
    throw new Error("Swift release projection line mismatch");
  }
  const frames: Array<{
    kind: "debug" | "other";
    parentIncluded: boolean;
    debugBranchIncluded?: boolean;
  }> = [];
  const projected: string[] = [];
  let included = true;

  for (const [index, line] of lines.entries()) {
    const directive = maskedLines[index].trim();
    const ifMatch = directive.match(/^#if\s+(.+)$/);
    if (ifMatch) {
      const condition = ifMatch[1].trim();
      if (condition === "DEBUG" || condition === "!DEBUG") {
        const debugBranchIncluded = condition === "!DEBUG";
        frames.push({
          kind: "debug",
          parentIncluded: included,
          debugBranchIncluded,
        });
        included = included && debugBranchIncluded;
        continue;
      }
      if (/\bDEBUG\b/.test(condition)) {
        throw new Error(`Unsupported Swift DEBUG condition: ${directive}`);
      }
      frames.push({ kind: "other", parentIncluded: included });
      if (included) projected.push(line);
      continue;
    }
    if (directive.startsWith("#if")) {
      throw new Error(`Unsupported Swift conditional directive: ${directive}`);
    }
    if (directive === "#else") {
      const frame = frames.at(-1);
      if (!frame) throw new Error("Unmatched Swift #else");
      if (frame.kind === "debug") {
        frame.debugBranchIncluded = !frame.debugBranchIncluded;
        included = frame.parentIncluded && frame.debugBranchIncluded;
      } else {
        included = frame.parentIncluded;
        if (included) projected.push(line);
      }
      continue;
    }
    const elseifMatch = directive.match(/^#elseif\s+(.+)$/);
    if (elseifMatch) {
      const frame = frames.at(-1);
      if (!frame) throw new Error("Unmatched Swift #elseif");
      const condition = elseifMatch[1].trim();
      if (condition === "DEBUG") {
        included = false;
      } else if (condition === "!DEBUG") {
        included = frame.parentIncluded;
      } else {
        if (/\bDEBUG\b/.test(condition)) {
          throw new Error(`Unsupported Swift DEBUG condition: ${directive}`);
        }
        // Preserve every non-DEBUG alternative conservatively. This can make
        // the contract false-fail, but cannot hide release-reachable symbols.
        included = frame.parentIncluded;
      }
      if (frame.kind === "other" && included) {
        projected.push(line);
      }
      continue;
    }
    if (directive.startsWith("#elseif")) {
      throw new Error(`Unsupported Swift conditional directive: ${directive}`);
    }
    if (directive === "#endif") {
      const frame = frames.pop();
      if (!frame) throw new Error("Unmatched Swift #endif");
      included = frame.parentIncluded;
      if (frame.kind === "other" && included) projected.push(line);
      continue;
    }
    if (included) projected.push(line);
  }

  if (frames.length !== 0) {
    throw new Error("Unterminated Swift conditional compilation block");
  }
  return projected.join("");
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

  it("projects DEBUG branches out of release source without directive decoys", () => {
    const source = `
let literalDecoy = """
#if DEBUG
#endif
"""
/*
#if DEBUG
#endif
*/
releaseBeforeConditional()
#if DEBUG
debugOnly()
#elseif os(macOS)
releaseAlternative()
#else
releaseFallback()
#endif
releaseAfterConditional()
#if DEBUG
debugTabOnly()
#elseif\tos(macOS)
releaseTabbedAlternative()
#endif
`;

    const projected = projectSwiftReleaseSource(source);
    expect(projected).toContain("releaseBeforeConditional()");
    expect(projected).toContain("releaseAlternative()");
    expect(projected).toContain("releaseFallback()");
    expect(projected).toContain("releaseAfterConditional()");
    expect(projected).toContain("releaseTabbedAlternative()");
    expect(projected).not.toContain("debugOnly()");
    expect(projected).not.toContain("debugTabOnly()");
    expect(() =>
      projectSwiftReleaseSource("#if DEBUG && os(macOS)\ndebugOnly()\n#endif\n")
    ).toThrow(/Unsupported Swift DEBUG condition/);
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
    for (const fixture of [
      "onboarding-welcome",
      "onboarding-provider",
      "onboarding-daemon",
      "onboarding-license",
      "onboarding-done"
    ]) {
      expect(project).toContain(`${fixture}.json in Resources`);
      expect(project).toContain(`path = fixtures/ui/${fixture}.json`);
    }
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
    const maskedSource = maskSwiftCommentsAndLiterals(source);
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
      maskedSource.match(/outerPageScrollTarget\.scroll\(byDeltaX: 0, deltaY: -10_000\)/g)
    ).toHaveLength(1);
    const checkpointSource = extractBalancedSwiftDeclaration(
      source,
      "private func capturePageBottomCheckpoint("
    );
    const maskedCheckpointSource = maskSwiftCommentsAndLiterals(checkpointSource);
    expect(maskedCheckpointSource.match(/\.scroll\s*\(/g)).toHaveLength(1);
    expect(maskedCheckpointSource).not.toMatch(
      /\.(?:swipe\w*|tap|click|press|drag|coordinate)\s*\(/
    );
    expect(maskedCheckpointSource).not.toMatch(
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
    expect(source).toContain(
      "private let hostedPageBottomSamplingDeadlineMilliseconds = 15_000"
    );
    expect(
      source.match(
        /samplingDeadlineMilliseconds: hostedPageBottomSamplingDeadlineMilliseconds/g
      )
    ).toHaveLength(3);
    expect(
      source.match(
        /HostedPageBottomReachabilityTrace\(\s*schemaVersion: 2,/g
      )
    ).toHaveLength(3);
    expect(source).not.toMatch(
      /HostedPageBottomReachabilityTrace\(\s*schemaVersion: 1,/
    );
    expect(checkpointSource).toContain(
      "preActionSamplingDurationMilliseconds: preActionWindow.durationMilliseconds"
    );
    expect(checkpointSource).toContain(
      "postActionSamplingDurationMilliseconds: postActionWindow.durationMilliseconds"
    );
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

  it("encodes hosted native Repos and Logs inner-scroll exhaustion without changing the production fixture catalog", () => {
    const project = readFileSync(projectPath, "utf8");
    const source = readFileSync(uiTestPath, "utf8");
    const repos = readFileSync(reposPath, "utf8");
    const logs = readFileSync(logsPath, "utf8");
    const textVisibility = readFileSync(
      "apps/neondiff-desktop/Sources/NeonDiffDesktopAppCore/DesktopTextVisibility.swift",
      "utf8"
    );

    expect(existsSync(hostedInnerScrollFixturePath)).toBe(true);
    if (!existsSync(hostedInnerScrollFixturePath)) return;

    const fixtureSource = readFileSync(hostedInnerScrollFixturePath, "utf8");
    const fixture = JSON.parse(fixtureSource);
    expect(fixture.schemaVersion).toBe(1);
    expect(fixture.id).toBe("hosted-inner-scroll-overflow");
    expect(fixture.surface).toEqual({ section: "repos", onboardingStep: null });
    expect(fixture.environment).toMatchObject({
      locale: "en_US_POSIX",
      appearance: "dark",
      disableAnimations: true,
      contentSize: { width: 1040, height: 680 },
    });
    expect(fixture.state.repositories).toHaveLength(40);
    expect(fixture.state.repositories.at(-1)?.name).toBe("synthetic-org/repo-040");
    expect(fixture.state.logText.split("\n")).toHaveLength(70);
    expect(fixture.state.logText.endsWith("HOSTED_INNER_SCROLL_SAFE_TAIL_070")).toBe(true);
    expect(fixtureSource).not.toMatch(
      /(?:ghp_|github_pat_|sk-|Bearer\s|BEGIN [A-Z ]*PRIVATE KEY|https?:\/\/[^\s"']*:[^\s"']*@)/i
    );

    expect(project).not.toContain("hosted-inner-scroll-overflow.json");
    const appTarget = extractPbxNativeTarget(project, "NeonDiffDesktop");
    const uiTestTarget = extractPbxNativeTarget(project, "NeonDiffDesktopUITests");
    const appResources = extractPbxResourcesPhaseForTarget(project, appTarget);
    const uiTestResources = extractPbxResourcesPhaseForTarget(project, uiTestTarget);
    const appSynchronizedRoots = extractPbxSynchronizedRootsForTarget(
      project,
      appTarget
    );
    const uiTestSynchronizedRoots = extractPbxSynchronizedRootsForTarget(
      project,
      uiTestTarget
    );
    expect(appResources).not.toContain("hosted-inner-scroll-overflow.json in Resources");
    expect(uiTestResources).not.toContain(
      "hosted-inner-scroll-overflow.json in Resources"
    );
    expect(appSynchronizedRoots.some((root) => root.includes("path = UITests;"))).toBe(false);
    expect(uiTestSynchronizedRoots).toHaveLength(1);
    expect(uiTestSynchronizedRoots[0]).toContain("path = UITests;");
    expect(
      readFileSync("apps/neondiff-desktop/fixtures/ui/catalog.json", "utf8")
    ).not.toContain("hosted-inner-scroll-overflow");
    expect(repos).toContain('.accessibilityIdentifier("neondiff-repos-table")');
    expect(logs).toContain('.accessibilityIdentifier("neondiff-logs-text-editor")');
    expect(logs).toContain('import AppKit');
    expect(logs).toContain('LogsTextEditorVisibleRangeProbe(');
    expect(logs).toContain('"neondiff-logs-visible-tail"');
    expect(logs).toContain('HostedLogsVisibleRangeEvaluation.isActive');
    expect(logs).toContain('!NSWorkspace.shared.isVoiceOverEnabled');
    expect(logs).toContain('!NSWorkspace.shared.isSwitchControlEnabled');
    expect(logs).toContain('static var isActive: Bool');
    expect(logs).not.toContain('static let isActive: Bool');
    expect(logs).toContain('observe(\\.isVoiceOverEnabled');
    expect(logs).toContain('observe(\\.isSwitchControlEnabled');
    expect(logs).toContain('deactivateForAssistiveTechnology()');
    expect(logs).toContain('options: [.initial, .new]');
    expect(logs).toContain('hosted-inner-scroll-overflow.json');
    expect(logs).toContain('NSView.boundsDidChangeNotification');
    expect(logs).toContain('DesktopTextVisibility.visibleRange(');
    expect(logs).toContain('layoutManager.boundingRect(');
    expect(logs).toContain('visibleTextContainerRect');
    expect(logs).toContain('terminalGlyphBoundsAreFullyVisible');
    expect(logs).toContain('HostedLogsTerminalVisibilityPayload(');
    expect(logs).toContain('coordinateSpace: "appkit-text-view-local"');
    expect(logs).toContain('"ndlv1:"');
    expect(logs).toContain('"ndlv1-chunks:\\(chunks.count)"');
    expect(logs).toContain('let chunkByteCount = 64');
    expect(logs).toContain('guard label.utf8.count <= 128');
    expect(logs).toContain('"neondiff-logs-visible-tail-chunk-\\(index)"');
    expect(textVisibility).toContain('public enum DesktopTextVisibility');
    expect(textVisibility).toMatch(/^import Foundation\n\n#if DEBUG\n/);
    expect(textVisibility).toContain('tokenRange.location >= visibleRange.location');
    expect(textVisibility).toContain('NSMaxRange(tokenRange) <= NSMaxRange(visibleRange)');
    const resolveVisibleTextSource = extractBalancedSwiftDeclaration(
      logs,
      "func resolveAndObserveTextView("
    );
    expect(resolveVisibleTextSource).toContain(
      "guard !NSWorkspace.shared.isVoiceOverEnabled"
    );
    expect(resolveVisibleTextSource).toContain(
      "!NSWorkspace.shared.isSwitchControlEnabled"
    );
    const updateVisibleTextSource = extractBalancedSwiftDeclaration(
      logs,
      "private func updateVisibility("
    );
    expect(updateVisibleTextSource).toContain(
      "guard !NSWorkspace.shared.isVoiceOverEnabled"
    );
    expect(updateVisibleTextSource).toContain(
      "!NSWorkspace.shared.isSwitchControlEnabled"
    );

    expect(source).toContain("testHostedNativeInnerScrollsReachTerminalStateWithoutMovingOuterPage");
    expect(source).toContain('scenario: "repos-and-logs-native-inner-scroll-terminal-at-1040x680"');
    expect(source).toContain('fixtureId: "hosted-inner-scroll-overflow"');
    expect(source).toContain('"neondiff-repos-table"');
    expect(source).toContain('"neondiff-logs-text-editor"');
    expect(source).toContain('"synthetic-org/repo-040"');
    expect(source).toContain('"HOSTED_INNER_SCROLL_SAFE_TAIL_070"');
    expect(source).toContain("HostedNativeInnerScrollTrace(");
    expect(source).toContain("neondiff-hosted-native-inner-scroll.json");
    expect(source).toContain(
      'proofBoundary: "hosted-debug-fixture-repos-table-and-logs-text-editor-rendered-terminal-glyph-bounds-outer-page-bottom-checkpoint-then-native-inner-viewport-restaging-before-first-terminal-repeat-no-effect-and-outer-page-isolation-at-1040x680-only-manual-trackpad-keyboard-voiceover-focus-large-text-other-sizes-overflow-production-data-installed-signed-release-excluded"'
    );

    const scenarioSource = extractBalancedSwiftDeclaration(
      source,
      "func testHostedNativeInnerScrollsReachTerminalStateWithoutMovingOuterPage("
    );
    expect(scenarioSource).toContain("schemaVersion: 11");
    expect(scenarioSource).toContain(
      "let reposGeometry = try captureCheckpoint("
    );
    expect(scenarioSource).toContain(
      "let logsGeometry = try captureCheckpoint("
    );
    expect(scenarioSource).toContain(
      "observedGeometryCheckpoints: [reposGeometry, logsGeometry]"
    );
    expect(scenarioSource).toContain(
      "coordinateSpaces: HostedNativeInnerScrollCoordinateSpaces("
    );
    expect(scenarioSource).toContain('xcuiGeometry: "xcui-screen"');
    expect(scenarioSource).toContain(
      'observedWindowAndContent: "appkit-screen"'
    );
    expect(scenarioSource).toContain('observedRegions: "swiftui-global"');
    expect(scenarioSource).toContain(
      'terminalNativeVisibility: "per-payload-appkit-text-view-local"'
    );
    expect(scenarioSource).not.toContain('coordinateSpace: "xcui-screen"');
    expect(scenarioSource).toContain("controlElementType: .outline");
    expect(scenarioSource).toContain('controlElementTypeName: "outline"');
    expect(scenarioSource).toContain("terminalRowElementType: .outlineRow");
    expect(scenarioSource).toContain('terminalRowElementTypeName: "outline-row"');
    expect(scenarioSource).toContain("outerPreparationCheckpoint: reposOuter");
    expect(scenarioSource).toContain(
      'nestedScrollControlIdentifier: "neondiff-repos-table"'
    );
    expect(scenarioSource).toContain(
      "nestedScrollControlElementType: .outline"
    );
    expect(scenarioSource).toContain("requiresGuardedScrollAction: true");
    expect(scenarioSource).toContain("terminalVisibilityMarkerIdentifier: nil");
    expect(scenarioSource).toContain("controlElementType: .textView");
    expect(scenarioSource).toContain('controlElementTypeName: "text-view"');
    expect(scenarioSource).toContain("terminalRowElementType: nil");
    expect(scenarioSource).toContain("terminalRowElementTypeName: nil");
    expect(scenarioSource).toContain("outerPreparationCheckpoint: logsOuter");
    expect(scenarioSource).toContain(
      'nestedScrollControlIdentifier: "neondiff-logs-text-editor"'
    );
    expect(scenarioSource).toContain(
      "nestedScrollControlElementType: .textView"
    );
    expect(
      scenarioSource.match(/requiresGuardedScrollAction: true/g)
    ).toHaveLength(2);
    expect(scenarioSource).toContain(
      'terminalVisibilityMarkerIdentifier: "neondiff-logs-visible-tail"'
    );
    expect(scenarioSource.match(/captureNativeInnerScrollExhaustion\s*\(/g)).toHaveLength(2);
    expect(scenarioSource.match(/capturePageBottomCheckpoint\s*\(/g)).toHaveLength(2);
    const reposOuterPosition = scenarioSource.indexOf(
      "let reposOuter = try capturePageBottomCheckpoint("
    );
    const reposInnerPosition = scenarioSource.indexOf(
      "let reposInner = try captureNativeInnerScrollExhaustion("
    );
    const logsOuterPosition = scenarioSource.indexOf(
      "let logsOuter = try capturePageBottomCheckpoint("
    );
    const logsInnerPosition = scenarioSource.indexOf(
      "let logsInner = try captureNativeInnerScrollExhaustion("
    );
    expect(reposOuterPosition).toBeGreaterThan(-1);
    expect(reposInnerPosition).toBeGreaterThan(reposOuterPosition);
    expect(logsOuterPosition).toBeGreaterThan(-1);
    expect(logsInnerPosition).toBeGreaterThan(logsOuterPosition);
    expect(scenarioSource).toContain(
      "outerPageBottomCheckpoints: [reposOuter, logsOuter]"
    );
    const pageBottomCheckpointSource = extractBalancedSwiftDeclaration(
      source,
      "private func capturePageBottomCheckpoint("
    );
    const maskedPageBottomCheckpointSource = maskSwiftCommentsAndLiterals(
      pageBottomCheckpointSource
    );
    expect(pageBottomCheckpointSource).toContain(
      "nestedScrollControlIdentifier: String? = nil"
    );
    expect(pageBottomCheckpointSource).toContain(
      "nestedScrollControlElementType: XCUIElement.ElementType? = nil"
    );
    expect(pageBottomCheckpointSource).toContain(
      "requiresGuardedScrollAction: Bool = false"
    );
    expect(pageBottomCheckpointSource).toContain(
      "let nestedScrollGuard = try guardedOuterPageScrollTarget("
    );
    expect(pageBottomCheckpointSource).toContain(
      "let outerPageScrollTarget = nestedScrollGuard?.targetCoordinate"
    );
    expect(maskedPageBottomCheckpointSource).toContain(
      "outerPageScrollTarget.scroll(byDeltaX: 0, deltaY: -10_000)"
    );
    expect(pageBottomCheckpointSource).toContain(
      "let nestedScrollValueAfter = try nestedScrollGuard.map"
    );
    expect(pageBottomCheckpointSource).toContain(
      "nestedScrollValueAfter == nestedScrollGuard.baselineValue"
    );
    expect(pageBottomCheckpointSource).toContain(
      "nestedScrollValueChangedDuringOuterPreparation("
    );
    expect(pageBottomCheckpointSource).toContain(
      "requiredGuardedScrollActionWasNotIssued("
    );
    expect(pageBottomCheckpointSource).toContain(
      "targetPoint: nestedScrollGuard?.targetPoint"
    );
    expect(pageBottomCheckpointSource).toContain(
      "nestedScrollControlIdentifier: nestedScrollGuard?.controlIdentifier"
    );
    expect(pageBottomCheckpointSource).toContain(
      "nestedScrollValueBefore: nestedScrollGuard?.baselineValue"
    );
    expect(pageBottomCheckpointSource).toContain(
      "nestedScrollValueAfter: nestedScrollValueAfter"
    );
    expect(pageBottomCheckpointSource).toContain(
      "guardOuterScrollFrame: nestedScrollGuard?.outerScrollFrame"
    );
    expect(pageBottomCheckpointSource).toContain(
      "guardNestedScrollFrame: nestedScrollGuard?.nestedScrollFrame"
    );
    const guardedOuterTargetSource = extractBalancedSwiftDeclaration(
      source,
      "private func guardedOuterPageScrollTarget("
    );
    expect(guardedOuterTargetSource).toContain(
      "let target = try outerRestagingCoordinate("
    );
    expect(guardedOuterTargetSource).toContain(
      "candidate.descendants(matching: controlElementType)"
    );
    expect(guardedOuterTargetSource).toContain(
      "normalizedScrollValue(verticalScrollBar.value)"
    );
    const pageScrollActionSource = extractBalancedSwiftDeclaration(
      source,
      "private struct HostedPageScrollAction:"
    );
    for (const field of [
      "targetPoint",
      "nestedScrollControlIdentifier",
      "nestedScrollValueBefore",
      "nestedScrollValueAfter",
      "guardOuterScrollFrame",
      "guardNestedScrollFrame",
    ]) {
      expect(pageScrollActionSource).toContain(`let ${field}:`);
      expect(pageScrollActionSource).toContain(
        `forKey: .${field}`
      );
    }
    expect(pageScrollActionSource.match(/encodeIfPresent\s*\(/g)).toHaveLength(6);
    const pageBottomSamplesSource = extractBalancedSwiftDeclaration(
      source,
      "private func capturePageBottomSamples("
    );
    expect(pageBottomSamplesSource).toContain(
      "samplingDeadlineMilliseconds: Int = hostedPageBottomSamplingDeadlineMilliseconds"
    );
    expect(pageBottomSamplesSource).toContain(
      "let samplingCompletedAt = ProcessInfo.processInfo.systemUptime"
    );
    expect(pageBottomSamplesSource).toContain(
      "samplingCompletedAt - start"
    );
    expect(pageBottomSamplesSource).toContain(
      "durationMilliseconds: durationMilliseconds"
    );
    expect(pageBottomSamplesSource).toContain(
      "samplingDeadlineMilliseconds: samplingDeadlineMilliseconds"
    );
    const pageBottomCadenceSource = extractBalancedSwiftDeclaration(
      source,
      "private func validatePageBottomCadence("
    );
    expect(pageBottomCadenceSource).toContain(
      "samplingDeadlineMilliseconds: Int"
    );
    expect(pageBottomCadenceSource).toContain(
      "durationMilliseconds <= samplingDeadlineMilliseconds"
    );
    expect(pageBottomCadenceSource).not.toContain("finalElapsed");
    const helperSource = extractBalancedSwiftDeclaration(
      source,
      "private func captureNativeInnerScrollExhaustion("
    );
    expect(helperSource).toContain(
      "outerPreparationCheckpoint: HostedPageBottomCheckpoint"
    );
    expect(helperSource).toContain("var outerPreparationFailures: [String] = []");
    for (const category of [
      "section-mismatch",
      "outer-scroll-identifier-mismatch",
      "sentinel-identifier-mismatch",
      "scroll-action-control-mismatch",
      "scroll-action-attempt-count",
      "scroll-action-result",
      "scroll-action-effect",
      "scroll-action-guard-target-missing",
      "scroll-action-guard-frames-missing",
      "scroll-action-guard-outer-frame-invalid",
      "scroll-action-guard-nested-frame-invalid",
      "scroll-action-guard-target-outside-outer",
      "scroll-action-guard-target-inside-nested",
      "scroll-action-nested-control-mismatch",
      "scroll-action-nested-value-missing",
      "scroll-action-nested-value-changed",
      "missing-post-action-sample",
      "post-sentinel-outside-outer",
      "post-sentinel-outside-detail",
      "outer-frame-drift",
      "sentinel-frame-drift",
      "current-sentinel-outside-outer",
    ]) {
      expect(helperSource).toContain(`outerPreparationFailures.append("${category}")`);
    }
    expect(helperSource).not.toContain(
      'outerPreparationFailures.append("missing-scroll-action")'
    );
    expect(helperSource).toContain(
      'outerRestagingFailures.append("inner-scroll-outside-outer")'
    );
    expect(helperSource).toContain(
      'outerRestagingFailures.append("inner-scroll-value-changed-during-outer-restaging")'
    );
    expect(helperSource).toContain(
      'outerRestagingFailures.append("outer-restaging-no-effect")'
    );
    expect(helperSource).toContain(
      'outerRestagingFailures.append("unexpected-outer-restaging-effect")'
    );
    expect(helperSource).toContain(
      'outerRestagingFailures.append("outer-restaging-direction-mismatch")'
    );
    expect(helperSource).toContain(
      'outerRestagingFailures.append("outer-restaging-translation-mismatch")'
    );
    expect(helperSource).toContain(
      "outerRestagingNotEstablished(section: section, failedChecks: outerRestagingFailures)"
    );
    expect(helperSource).toContain(
      "outerPreparationNotEstablished(section: section, failedChecks: outerPreparationFailures)"
    );
    expect(helperSource).toContain(
      "let outerPreparationSample = try captureNativeInnerScrollSample("
    );
    expect(helperSource).toContain(
      "let restagingDeltaY = try outerRestagingDeltaY("
    );
    expect(helperSource).toContain(
      "let requiresOuterRestaging = abs(restagingDeltaY) > 0.5"
    );
    expect(helperSource.match(/requiresOuterRestaging/g)).toHaveLength(6);
    expect(helperSource.match(/abs\(restagingDeltaY\)/g)).toHaveLength(1);
    expect(helperSource).toContain("if requiresOuterRestaging {");
    expect(helperSource).toContain(
      "if requiresOuterRestaging, !restagingEffectObserved {"
    );
    expect(helperSource).toContain(
      "if !requiresOuterRestaging, restagingEffectObserved {"
    );
    expect(helperSource).toContain(
      "if requiresOuterRestaging,\n           restagingDeltaY * scrollContainerTranslation <= 0 {"
    );
    expect(helperSource).toContain("if !requiresOuterRestaging {");
    expect(helperSource).not.toContain("restagingDeltaY != 0");
    expect(helperSource).not.toContain("restagingDeltaY == 0");
    expect(helperSource).toContain(
      "let target = try outerRestagingCoordinate("
    );
    expect(helperSource).toContain(
      "target.coordinate.scroll(byDeltaX: 0, deltaY: CGFloat(restagingDeltaY))"
    );
    expect(helperSource).not.toContain(
      "outerScroll.scroll(byDeltaX: 0, deltaY: CGFloat(restagingDeltaY))"
    );
    expect(helperSource).toContain("targetPoint: outerRestagingTargetPoint");
    expect(helperSource).toContain(
      "outerRestagingSamples.allSatisfy"
    );
    expect(helperSource).not.toContain(
      "outerRestagingSamples = [outerPreparationSample]"
    );
    expect(helperSource).toContain(
      "outerRestagingWindowDurationMilliseconds: restagingWindow.durationMilliseconds"
    );
    expect(
      helperSource.match(/frameMatchesRigidVerticalTranslation\s*\(/g)
    ).toHaveLength(4);
    expect(helperSource).toContain("outerRestagingAction:");
    expect(helperSource).toContain("outerRestagingSamples:");
    expect(helperSource).toContain("outerPreparationSample:");
    expect(helperSource).toContain(
      'outerPreparationResult: "verified-page-bottom-then-inner-viewport-restaged-before-isolation-baseline"'
    );
    expect(helperSource).not.toContain("outerPreparationNotEstablished(section)");
    expect(helperSource).toContain(
      "sample.scrollContainerFrame.isFullyContained("
    );
    expect(helperSource).toContain(
      "outerPreparationCheckpoint.section != section"
    );
    expect(helperSource).toContain(
      "outerPreparationCheckpoint.outerScrollIdentifier != outerScrollIdentifier"
    );
    expect(helperSource).toContain(
      "outerPreparationCheckpoint.sentinelIdentifier != outerSentinelIdentifier"
    );
    expect(helperSource).toContain(
      "if let preparedSample = outerPreparationCheckpoint.postActionSamples.last"
    );
    expect(helperSource).toContain(
      "preparedSample.outerScrollFrame.differs("
    );
    expect(helperSource).toContain("preparedSample.sentinelFrame.differs(");
    expect(helperSource).toContain(
      "outerPreparationCheckpoint: outerPreparationCheckpoint"
    );
    expect(helperSource.match(/\.scroll\s*\(/g)).toHaveLength(3);
    expect(helperSource).toContain("app.descendants(matching: .scrollView)");
    expect(helperSource).toContain("scrollContainer.scrollBars");
    expect(helperSource).not.toContain("control.scrollBars");
    expect(helperSource.match(/scrollContainer\.scroll\s*\(/g)).toHaveLength(2);
    expect(helperSource).toContain("normalizedScrollValue");
    expect(helperSource).toContain(
      "let preTerminalValue = preSample.normalizedScrollValue"
    );
    expect(helperSource).toContain("preTerminalValue < 1");
    expect(helperSource).toContain(
      "terminalSamples.allSatisfy({ $0.normalizedScrollValue == 1 })"
    );
    expect(helperSource).toContain(
      "repeatTerminalObservedSamples.allSatisfy({"
    );
    expect(helperSource).toContain("elapsedMilliseconds:");
    expect(helperSource).toContain("minimumAcceptedSampleIntervalMilliseconds");
    expect(helperSource).toContain("minimumAcceptedSampleIntervalMilliseconds = 90");
    expect(source).toContain(
      "private let hostedNativeInnerScrollSamplingDeadlineMilliseconds = 15_000"
    );
    expect(helperSource).toContain(
      "samplingDeadlineMilliseconds = hostedNativeInnerScrollSamplingDeadlineMilliseconds"
    );
    expect(helperSource.match(/captureStableNativeInnerScrollSamples\s*\(/g)).toHaveLength(3);
    expect(helperSource).toContain("terminalSamples");
    expect(helperSource).toContain("repeatTerminalSamples");
    expect(helperSource).toContain("outerRestagingObservedSamples:");
    expect(helperSource).toContain("terminalObservedSamples:");
    expect(helperSource).toContain("repeatTerminalObservedSamples:");
    expect(helperSource).toContain(
      "let repeatTerminalObservedSamples = repeatTerminalWindow.observedSamples"
    );
    expect(helperSource).toContain("for candidate in repeatTerminalObservedSamples");
    expect(helperSource).toContain(
      "let postActionObservedSamples =\n            terminalWindow.observedSamples + repeatTerminalWindow.observedSamples"
    );
    expect(helperSource).toContain("effectObserved: true");
    expect(helperSource).toContain("effectObserved: false");
    expect(helperSource.match(/effectProven: true/g)).toHaveLength(3);
    expect(helperSource).toContain("terminalRowFrame");
    expect(helperSource).toContain("terminalRowFullyContained");
    expect(helperSource).toContain("terminalRowElementType");
    expect(helperSource).toContain("terminalVisibilityMarkerQuery.count != 0");
    expect(helperSource).toContain(
      "terminalVisibilityMarkerPresentBeforeTerminal("
    );
    expect(helperSource).toContain("marker.waitForExistence(timeout: 2)");
    expect(helperSource).toContain("terminalVisibilityMarkerFrame != nil");
    expect(helperSource).toContain(
      "terminalVisibilityMarkerFullyContained == true"
    );
    expect(helperSource).toContain("terminalNativeVisibility != nil");
    expect(helperSource).toContain("nativeVisibilityProvesTerminalToken(");
    expect(helperSource).toContain("scrollContainerFrame");
    expect(helperSource).toContain('scrollContainerElementType: "scroll-view"');
    expect(helperSource).toContain("scrollContainerCount: scrollContainers.count");
    expect(helperSource).toContain(
      "terminalVisibilityMarkerIdentifier: terminalVisibilityMarkerIdentifier"
    );
    expect(helperSource).toContain(
      "terminalVisibleText: terminalVisibleText"
    );
    expect(helperSource).toContain(
      "terminalValueToken: terminalValueToken"
    );
    expect(helperSource).toContain(
      "terminalRowElementType: terminalRowElementTypeName"
    );
    expect(helperSource).toContain(
      "terminalWindowDurationMilliseconds: terminalWindow.durationMilliseconds"
    );
    expect(helperSource).toMatch(
      /repeatTerminalWindowDurationMilliseconds:\s*repeatTerminalWindow\.durationMilliseconds/
    );
    const settledHelperSource = extractBalancedSwiftDeclaration(
      source,
      "private func captureStableNativeInnerScrollSamples("
    );
    expect(settledHelperSource).toContain(
      "let maximumSampleAttempts = max("
    );
    expect(settledHelperSource).toContain(
      "for _ in 0..<maximumSampleAttempts"
    );
    expect(settledHelperSource).toContain(
      "if let baseline = samples.first,"
    );
    expect(settledHelperSource).toContain("samples = [sample]");
    expect(settledHelperSource).toContain("if samples.count == 3 { break }");
    expect(settledHelperSource).toContain("observedSamples.append(sample)");
    expect(settledHelperSource).toContain("observedSamples: observedSamples");
    expect(settledHelperSource).toContain(">= minimumAcceptedSampleIntervalMilliseconds");
    expect(settledHelperSource).toContain("<= samplingDeadlineMilliseconds");
    expect(settledHelperSource).toContain("nativeInnerScrollSamplesMatch");
    expect(settledHelperSource).toContain(
      "let samplingCompletedAt = ProcessInfo.processInfo.systemUptime"
    );
    expect(settledHelperSource).toContain(
      "samplingCompletedAt - actionStartedAt"
    );
    expect(settledHelperSource).not.toContain(
      "last.elapsedMilliseconds - actionElapsedMilliseconds"
    );
    expect(helperSource).toContain("outerSentinelFrame");
    expect(helperSource).not.toMatch(
      /AXUIElement|CGEvent|NSEvent|XCUIRemote|performAction|setAttributeValue/
    );
    const restagingCoordinateSource = extractBalancedSwiftDeclaration(
      source,
      "private func outerRestagingCoordinate("
    );
    expect(restagingCoordinateSource).toContain(
      "pointIsOutsideInner"
    );
    expect(restagingCoordinateSource).toContain(
      "outerScroll.coordinate(withNormalizedOffset: normalizedOffset)"
    );
    expect(restagingCoordinateSource).toContain(
      "let targetY = outerScrollFrame.y + (outerScrollFrame.height / 2)"
    );
    expect(restagingCoordinateSource).toContain(
      "throw HostedNativeInnerScrollTraceError.noSafeOuterRestagingCoordinate"
    );
    const nativeVisibilityParserSource = extractBalancedSwiftDeclaration(
      source,
      "private func decodeTerminalNativeVisibility("
    );
    expect(nativeVisibilityParserSource).toContain(
      'manifest.hasPrefix("ndlv1-chunks:")'
    );
    expect(nativeVisibilityParserSource).toContain(
      '"neondiff-logs-visible-tail-chunk-\\(index)"'
    );
    expect(nativeVisibilityParserSource).toContain(
      'let prefix = "ndlv1:\\(index):\\(chunkCount):"'
    );
    expect(nativeVisibilityParserSource).toContain(
      "for index in 0..<chunkCount {"
    );
    expect(nativeVisibilityParserSource).toContain(
      "let chunk = query.element(boundBy: 0)"
    );
    expect(nativeVisibilityParserSource).toContain(
      "guard chunk.waitForExistence(timeout: 2)"
    );
    expect(nativeVisibilityParserSource).not.toContain("query.count == 1");
    expect(nativeVisibilityParserSource).toContain(
      "guard label.utf8.count <= 128"
    );
    expect(nativeVisibilityParserSource).toContain(
      "(index == chunkCount - 1 || decoded.count == 64)"
    );
    expect(nativeVisibilityParserSource).toContain("decoded.count <= 64");
    expect(nativeVisibilityParserSource).toContain("data.append(decoded)");
    expect(nativeVisibilityParserSource).toContain("Data(base64Encoded:");
    const nativeVisibilityValidatorSource = extractBalancedSwiftDeclaration(
      source,
      "private func nativeVisibilityProvesTerminalToken("
    );
    expect(nativeVisibilityValidatorSource).toContain(
      'coordinateSpace == "appkit-text-view-local"'
    );
    expect(nativeVisibilityValidatorSource).toContain(
      "terminalGlyphBounds.isFullyContained("
    );
    const rigidTranslationSource = extractBalancedSwiftDeclaration(
      source,
      "private func frameMatchesRigidVerticalTranslation("
    );
    expect(rigidTranslationSource).toContain("abs(candidate.x - baseline.x) <= tolerance");
    expect(rigidTranslationSource).toContain(
      "abs(candidate.y - (baseline.y + translationY)) <= tolerance"
    );
    expect(rigidTranslationSource).toContain(
      "abs(candidate.width - baseline.width) <= tolerance"
    );
    expect(rigidTranslationSource).toContain(
      "abs(candidate.height - baseline.height) <= tolerance"
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

  it("pins the canonical five-step onboarding geometry matrix", () => {
    const source = readFileSync(uiTestPath, "utf8");
    const onboarding = readFileSync(
      "apps/neondiff-desktop/Sources/NeonDiffDesktop/Views/OnboardingWizardView.swift",
      "utf8"
    );
    const workflow = readFileSync(workflowPath, "utf8");

    expect(source).toContain(
      "testStrictFixtureSettlesAcrossEveryOnboardingStepAtCanonicalSize"
    );
    expect(source).toContain("HostedContentSize(width: 760, height: 560)");
    expect(source).toContain(
      'HostedOnboardingFixtureStep(fixtureId: "onboarding-welcome", onboardingStep: "welcome", section: "overview")'
    );
    expect(source).toContain(
      'HostedOnboardingFixtureStep(fixtureId: "onboarding-provider", onboardingStep: "provider", section: "providers")'
    );
    expect(source).toContain(
      'HostedOnboardingFixtureStep(fixtureId: "onboarding-daemon", onboardingStep: "daemon", section: "overview")'
    );
    expect(source).toContain(
      'HostedOnboardingFixtureStep(fixtureId: "onboarding-license", onboardingStep: "license", section: "license")'
    );
    expect(source).toContain(
      'HostedOnboardingFixtureStep(fixtureId: "onboarding-done", onboardingStep: "done", section: "overview")'
    );
    expect(source).toContain(
      '"--content-size", "\\(requestedContentSize.width)x\\(requestedContentSize.height)"'
    );
    expect(source).toContain("wizardFrame.matches(requestedContentSize");
    expect(source).toContain('"neondiff-onboarding-wizard"');
    expect(source).toContain('"neondiff-onboarding-header"');
    expect(source).toContain('"neondiff-onboarding-step-list"');
    expect(source).toContain('"neondiff-onboarding-step-content"');
    expect(source).toContain('"neondiff-onboarding-footer"');
    expect(source).toContain(
      '"neondiff-onboarding-current-step-\\(fixtureStep.onboardingStep)"'
    );
    expect(source).toContain("captureStableOnboardingSamples");
    expect(source).toContain("samples.count == 3");
    expect(source).toContain("finalCompletionElapsedMilliseconds <= 5_000");
    expect(source).toContain("completionElapsedMilliseconds");
    expect(source).toContain("validateStableOnboardingSamples");
    expect(source).toContain("validateOnboardingRegionLayout");
    expect(source).toContain("fullyContainedInWizard");
    expect(source).toContain("fullyContainedInWindow");
    expect(source).toContain("testRun?.failureCount");
    expect(source).toContain("priorValidationFailure");
    expect(source).toContain("HostedOnboardingMatrixTrace(");
    expect(source).toContain("neondiff-hosted-onboarding-matrix.json");
    expect(source).toContain(
      'proofBoundary: "hosted-five-onboarding-fixtures-760x560-settled-geometry-only-actions-scroll-large-text-manual-excluded"'
    );
    const onboardingImplementationStart = source.indexOf(
      "func testStrictFixtureSettlesAcrossEveryOnboardingStepAtCanonicalSize"
    );
    const onboardingImplementationEnd = source.indexOf(
      "private func captureRenderedTextScaleScenario",
      onboardingImplementationStart
    );
    expect(onboardingImplementationStart).toBeGreaterThanOrEqual(0);
    expect(onboardingImplementationEnd).toBeGreaterThan(
      onboardingImplementationStart
    );
    const onboardingImplementation = source.slice(
      onboardingImplementationStart,
      onboardingImplementationEnd
    );
    expect(onboardingImplementation).not.toMatch(
      /\.(?:click|doubleClick|rightClick|hover|tap|twoFingerTap|press|typeKey|typeText|scroll|swipe\w*|drag|coordinate|perform|pinch|rotate)\s*\(/
    );

    for (const identifier of [
      "neondiff-onboarding-wizard",
      "neondiff-onboarding-header",
      "neondiff-onboarding-step-list",
      "neondiff-onboarding-step-content",
      "neondiff-onboarding-footer"
    ]) {
      expect(onboarding).toContain(
        `.hostedOnboardingEvaluationRegion("${identifier}")`
      );
    }
    expect(onboarding).toContain(
      '"neondiff-onboarding-current-step-\\(model.onboardingFlow.currentStep.rawValue)"'
    );
    expect(onboarding).toContain("#if DEBUG");
    expect(onboarding).toContain("hostedOnboardingEvaluationRegion");
    expect(workflow).toMatch(
      /name: Hosted XCUITest smoke\s+timeout-minutes: 25/
    );
  });

  it("requires settled rendered scaling for visible production text", () => {
    const source = readFileSync(uiTestPath, "utf8");
    const theme = readFileSync(themePath, "utf8");

    expect(source).toContain(
      "testAccessibility3OverrideScalesVisibleProductionSectionTitle"
    );
    expect(source).toContain("captureStableVisibleTextSamples");
    expect(source).toContain("HostedRenderedTextScaleTrace(");
    expect(source).toContain("robustRenderedHeightGrowthPoints > 1");
    expect(source).toContain("defaultScenario.samples.max");
    expect(source).toContain("accessibility3Scenario.samples.min");
    expect(source).toContain("case insufficientRenderedScale(");
    expect(source).toContain("samples.count == 3");
    expect(source).toContain("finalElapsedMilliseconds <= 5_000");
    expect(source).toContain("visibleContainer: app.windows.firstMatch");
    expect(source).toContain("fullyContainedInVisibleContainer");
    expect(source).toContain("case textNotVisible(");
    expect(source).toContain("element.value as? String");
    expect(source).toContain("case unexpectedSemanticValue(String)");
    expect(source).toContain('expectedSemanticValue: "Overview"');
    expect(source).toContain(
      'proofBoundary: "hosted-visible-production-section-title-rendered-scale-comparison-only-system-preference-excluded"'
    );
    expect(source).toContain("neondiff-hosted-rendered-text-scale.json");
    expect(source).toContain(
      'textSizeMode: "runner-default-no-test-override"'
    );
    expect(source).toContain(
      'textSizeMode: "swiftui-dynamic-type-accessibility3-test-override"'
    );
    expect(theme).toContain(
      '.accessibilityIdentifier("neondiff-section-title")'
    );
    expect(theme).toContain(
      "@Environment(\\.dynamicTypeSize) private var dynamicTypeSize"
    );
    expect(theme).toContain("private var sectionTitleSize: CGFloat");
    expect(theme).toContain("case .accessibility3: 23");
    expect(theme).toContain("case .accessibility5: 30");
    expect(theme).toContain(
      ".font(.system(size: sectionTitleSize, weight: .bold, design: .monospaced))"
    );
  });

  it("pins the separate Settings scene canonical geometry contract", () => {
    const source = readFileSync(uiTestPath, "utf8");
    const app = readFileSync(appPath, "utf8");
    const settings = readFileSync(settingsPath, "utf8");

    expect(source).toContain(
      "testSeparateSettingsSceneFitsVisibleScreenAndReachesPageBottom"
    );
    const settingsTestSource = extractBalancedSwiftDeclaration(
      source,
      "func testSeparateSettingsSceneFitsVisibleScreenAndReachesPageBottom()"
    );
    expect(settingsTestSource).toContain("schemaVersion: 2");
    expect(source).toContain("HostedContentSize(width: 560, height: 700)");
    expect(source).toContain(
      'HostedSettingsTextSizeRequest(textSizeMode: "runner-default-no-test-override", textSizeArgument: nil)'
    );
    expect(source).toContain(
      'HostedSettingsTextSizeRequest(textSizeMode: "swiftui-dynamic-type-accessibility3-test-override", textSizeArgument: "accessibility3")'
    );
    expect(source).toContain('app.typeKey(",", modifierFlags: [.command])');
    expect(source).toContain('"neondiff-settings-evaluation-container"');
    expect(source).toContain('"neondiff.evaluation.settings.quiescent"');
    expect(source).toContain('"neondiff.evaluation.settings.text-size"');
    expect(source).toContain('let textSizePrefix = "ndst1:"');
    expect(source).toContain("let textSizeLabel = textSizeMarker.label");
    expect(source).toContain('observedTextSize != "accessibility3"');
    expect(source).toContain(
      '"neondiff.evaluation.settings.appkit-geometry"'
    );
    expect(source).toContain("decodeAndValidateSettingsAppKitGeometry");
    expect(source).toContain('let manifestPrefix = "ndsg1-chunks:"');
    expect(source).toContain('let prefix = "ndsg1:\\(index):\\(chunkCount):"');
    expect(source).toContain("let label = chunk.label");
    expect(source).toContain(
      'envelope.coordinateSpaces.contentLayoutRect == "appkit-window"'
    );
    expect(source).toContain(
      'envelope.coordinateSpaces.contentLayoutScreenRect == "appkit-screen"'
    );
    expect(source).toContain("envelope.samples.count == 3");
    expect(source).toContain(
      "sample.contentLayoutRect.matchesFittedSettingsContent("
    );
    expect(source).toContain(
      "sample.contentLayoutScreenRect.matchesFittedSettingsContent("
    );
    expect(source).toContain("isFullyContainedInWindowBounds(");
    expect(source).toContain("sample.contentLayoutScreenRect.isFullyContained(");
    expect(source).toContain("sample.windowFrame.isFullyContained(");
    expect(source).toContain(
      "observedAppKitContentLayoutSize: observedAppKitContentLayoutSize"
    );
    expect(source).toContain(
      "observedAppKitWindowSize: observedAppKitWindowSize"
    );
    expect(source).toContain('"neondiff-settings-outer-scroll"');
    expect(source).toContain('"neondiff-settings-page-bottom"');
    expect(source).toContain("captureStableSettingsSceneSamples");
    expect(source).toContain("samples.count == 3");
    expect(source).toContain("finalCompletionElapsedMilliseconds <= 5_000");
    expect(source).toContain("windowFrame.matches(expectedAppKitWindowSize");
    expect(source).toContain("accessibilityContainerMatchesWindowFrame");
    expect(source).toContain("projectedAppKitContentLayoutFrame");
    expect(source).toContain(
      "appKitContentLayoutScreenRect.x - appKitWindowFrame.x"
    );
    expect(source).toContain(
      "appKitWindowFrame.maxY - appKitContentLayoutScreenRect.maxY"
    );
    expect(source).toContain(
      "projectedAppKitContentLayoutFullyContainedInWindow"
    );
    expect(source).toContain(
      "outerScrollFullyContainedInProjectedAppKitContentLayout"
    );
    expect(source).toContain("sentinelFullyContainedInOuterScroll");
    expect(source).toContain("effectProven: true");
    expect(source).toContain("scrollHadNoEffect");
    expect(source).toContain("HostedSettingsSceneTrace(");
    expect(source).toContain("neondiff-hosted-settings-scene.json");
    expect(source).toContain(
      'proofBoundary: "hosted-separate-settings-preferred-560x700-appkit-window-and-content-layout-fitted-to-observed-visible-screen-xcui-window-dimension-bridge-outer-scroll-contained-and-page-bottom-reachable-runner-default-and-swiftui-accessibility3-test-override-only-system-text-preference-inner-scroll-manual-voiceover-focus-control-hittability-localization-multidisplay-relocation-installed-release-excluded"'
    );
    const settingsScenarioSource = extractBalancedSwiftDeclaration(
      source,
      "private func captureSettingsSceneScenario("
    );
    expect(settingsScenarioSource.match(/\.scroll\s*\(/g)).toHaveLength(1);
    expect(settingsScenarioSource).not.toMatch(
      /AXUIElement|CGEvent|NSEvent|XCUIRemote|performAction|setAttributeValue/
    );

    expect(app).toContain("evaluationTextSizedSettingsScene");
    expect(app).toContain("SettingsWindowLayout.preferredContentWidth");
    expect(app).toContain("SettingsWindowLayout.fittedContentHeight(");
    expect(app).toContain("SettingsWindowFitView(contentHeight:");
    expect(app).toContain("window.screen?.visibleFrame");
    expect(app).toContain("NSWindow.didChangeScreenNotification");
    expect(app).toContain("NSApplication.didChangeScreenParametersNotification");
    expect(app).not.toContain("NSWindow.didMoveNotification");
    const screenChangeSource = extractBalancedSwiftDeclaration(
      app,
      "private func windowScreenDidChange("
    );
    expect(screenChangeSource).toContain("fitWindow(containOrigin: false)");
    expect(app).toContain("static let preferredContentWidth: CGFloat = 560");
    expect(app).toContain("static let preferredContentHeight: CGFloat = 700");
    expect(app).toContain("floor(visibleScreenHeight - chromeHeight)");
    expect(app).not.toContain("NSScreen.main?.visibleFrame.height");
    const fittedHeightSource = extractBalancedSwiftDeclaration(
      app,
      "static func fittedContentHeight("
    );
    expect(fittedHeightSource).toContain("chromeHeight.isFinite");
    expect(fittedHeightSource).toContain("chromeHeight >= 0");
    expect(fittedHeightSource).toContain("visibleScreenHeight > chromeHeight");
    const fitWindowSource = extractBalancedSwiftDeclaration(
      app,
      "private func fitWindow(containOrigin: Bool = true)"
    );
    expect(fitWindowSource).toContain(
      "let chromeHeight = windowFrame.height - contentLayoutRect.height"
    );
    expect(fitWindowSource).toContain("Self.isFiniteNonempty(windowFrame)");
    expect(fitWindowSource).toContain("Self.isFiniteNonempty(contentLayoutRect)");
    expect(fitWindowSource).toContain("Self.isFiniteNonempty(visibleFrame)");
    expect(fitWindowSource.match(/pendingHeight = nil/g)).toHaveLength(2);
    expect(fitWindowSource).toContain("guard containOrigin else { return }");
    expect(fitWindowSource).toContain(
      "pendingOriginContainment = pendingOriginContainment || containOrigin"
    );
    expect(fitWindowSource).toContain(
      "let shouldContainOrigin = self.pendingOriginContainment"
    );
    expect(fitWindowSource).toContain(
      "self.fitWindow(containOrigin: shouldContainOrigin)"
    );
    const attachSource = extractBalancedSwiftDeclaration(
      app,
      "func attach(to window: NSWindow?, contentHeight: Binding<CGFloat>)"
    );
    expect(attachSource).toMatch(
      /attachmentGeneration \+= 1\s+pendingHeight = nil\s+pendingOriginContainment = false\s+self\.window = window/
    );
    expect(attachSource).toContain("pendingOriginContainment = false");
    const detachSource = extractBalancedSwiftDeclaration(app, "func detach()");
    expect(detachSource).toContain("pendingOriginContainment = false");
    expect(app).toContain(".dynamicTypeSize(.accessibility3)");
    expect(app).toContain("hostedSettingsEvaluationContent");
    const settingsSceneSource = extractBalancedSwiftDeclaration(
      app,
      "private var evaluationTextSizedSettingsScene"
    );
    const hostedWrapperIndex = settingsSceneSource.indexOf(
      ".hostedSettingsEvaluationContent("
    );
    const accessibilityOverrideIndex = settingsSceneSource.indexOf(
      ".dynamicTypeSize(.accessibility3)"
    );
    expect(hostedWrapperIndex).toBeGreaterThan(-1);
    expect(accessibilityOverrideIndex).toBeGreaterThan(hostedWrapperIndex);
    expect(settings).toContain("HostedSettingsWindowConfigurator");
    expect(settings).toContain("HostedSettingsEvaluationStatus");
    expect(settings).toContain('"neondiff.evaluation.settings.quiescent"');
    expect(settings).toContain('"neondiff-settings-evaluation-container"');
    expect(settings).toContain('"neondiff.evaluation.settings.text-size"');
    expect(settings).toContain('"neondiff.evaluation.settings.appkit-geometry"');
    expect(settings).toContain("HostedSettingsGeometryAccessibilityChunk");
    expect(settings).toContain("geometryAccessibilityManifest");
    expect(settings).toContain("geometryAccessibilityChunks");
    expect(settings).toContain('let chunkByteCount = 64');
    expect(settings).toContain('let label = "ndsg1:');
    expect(settings).toContain("guard label.utf8.count <= 128");
    expect(settings).not.toContain(".accessibilityValue(");
    expect(settings).toContain("visibleScreenFrame: visibleScreenFrame");
    expect(settings).toContain("window.convertToScreen(");
    expect(settings).toContain("status.markQuiescent(samples: stableSamples)");
    expect(settings).toContain("if let baseline = stableSamples.first");
    expect(settings).not.toContain("if let previous = stableSamples.last");
    const releaseSettings = projectSwiftReleaseSource(settings);
    for (const debugOnlySetting of [
      "HostedSettingsWindowConfigurator",
      "HostedSettingsEvaluationStatus",
      "HostedSettingsGeometryAccessibilityChunk",
      "neondiff.evaluation.settings.quiescent",
      "neondiff-settings-evaluation-container",
      "neondiff.evaluation.settings.text-size",
      "neondiff.evaluation.settings.appkit-geometry",
      "geometryAccessibilityManifest",
      "geometryAccessibilityChunks",
    ]) {
      expect(releaseSettings).not.toContain(debugOnlySetting);
    }
    const releaseApp = projectSwiftReleaseSource(app);
    expect(releaseApp).not.toContain("HostedSettingsEvaluationStatus");
    expect(releaseApp).not.toContain("settingsEvaluationStatus");
    expect(releaseApp).not.toContain(".hostedSettingsEvaluationContent(");
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
