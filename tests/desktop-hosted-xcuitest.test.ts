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

  it("launches only a deterministic in-memory fixture and finds the native root", () => {
    const source = readFileSync(uiTestPath, "utf8");
    expect(source).toContain('NEONDIFF_DESKTOP_VISUAL_PROOF_FIXTURE');
    expect(source).toContain('provider-verification');
    expect(source).toContain('neondiff.desktop.root');
    expect(source).toContain("XCUIApplication()");
    expect(source).not.toMatch(/api[_-]?key|token|password|secret/i);
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
