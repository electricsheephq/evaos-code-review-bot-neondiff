import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function read(path: string): string {
  return readFileSync(path, "utf8");
}

function swiftAffected(files: string[]): { affected: boolean; matched: string[]; files: string[] } {
  return JSON.parse(execFileSync("node", ["scripts/swift-affected.mjs", "--files", ...files], { encoding: "utf8" }));
}

describe("Swift CI velocity policy", () => {
  it("classifies desktop and Swift workflow paths without flagging docs or TypeScript release tooling", () => {
    expect(swiftAffected([
      "docs/releases/v0.4.43-beta.1.md",
      "src/release-status.ts",
      "tests/release-status.test.ts",
      ".github/workflows/ci.yml"
    ])).toMatchObject({
      affected: false,
      matched: []
    });

    expect(swiftAffected([
      "apps/neondiff-desktop/Sources/NeonDiffDesktop/Views/ContentView.swift",
      ".github/workflows/swift-desktop-gate.yml"
    ])).toMatchObject({
      affected: true,
      matched: [
        "apps/neondiff-desktop/Sources/NeonDiffDesktop/Views/ContentView.swift",
        ".github/workflows/swift-desktop-gate.yml"
      ]
    });
  });

  it("ships an always-reporting Swift desktop gate and a path-aware Swift CodeQL workflow", () => {
    expect(existsSync(".github/workflows/swift-desktop-gate.yml")).toBe(true);
    expect(existsSync(".github/workflows/codeql-swift-path-aware.yml")).toBe(true);

    const gate = read(".github/workflows/swift-desktop-gate.yml");
    const codeql = read(".github/workflows/codeql-swift-path-aware.yml");

    expect(gate).toMatch(/name:\s*Swift Desktop Gate/);
    expect(gate).toMatch(/Swift desktop gate/);
    expect(gate).toMatch(/scripts\/swift-affected\.mjs/);
    expect(gate).toMatch(/No Swift desktop files changed/);
    expect(gate).toMatch(/swift run NeonDiffDesktopCoreChecks/);
    expect(gate).toMatch(/swift build/);
    expect(gate).toMatch(/script\/build_and_run\.sh build/);
    expect(gate).toMatch(/script\/build_and_run\.sh bundle-check/);
    expect(gate).toMatch(/cancel-in-progress:\s*true/);
    expect(gate).toMatch(/current PR\/main head/);
    expect(gate).toMatch(/Superseded runs may be cancelled/);
    expect(gate).toMatch(/payload && payload\.affected === true/);
    expect(gate).toMatch(/console\.log\('false'\)/);
    expect(gate).toMatch(/base ref unavailable; fail open/);

    expect(codeql).toMatch(/name:\s*Swift CodeQL Path-Aware/);
    expect(codeql).toMatch(/apps\/neondiff-desktop\/\*\*/);
    expect(codeql).not.toMatch(/\.github\/workflows\/swift-desktop-gate\.yml/);
    expect(codeql).not.toMatch(/\.github\/workflows\/codeql-swift-path-aware\.yml/);
    expect(codeql).not.toMatch(/-\s*Package\.swift/);
    expect(codeql).not.toMatch(/-\s*Package\.resolved/);
    expect(codeql).toMatch(/languages:\s*swift/);
    expect(codeql).toMatch(/build-mode:\s*manual/);
    expect(codeql).toMatch(/swift build --product NeonDiffDesktop/);
    expect(codeql).not.toMatch(/--arch arm64/);
    expect(codeql).not.toMatch(/github\/codeql-action\/autobuild/);
    expect(codeql).toMatch(/schedule:/);
    expect(codeql).toMatch(/workflow_dispatch:/);
    expect(codeql).toMatch(/cancel-in-progress:\s*true/);
    expect(gate).toMatch(/no PR\/push path filter/);
    expect(gate).toMatch(/before ref unavailable; fail open/);
  });

  it("keeps every operand after --files as a filename, including option-like paths", () => {
    expect(swiftAffected([
      "--base",
      "apps/neondiff-desktop/Package.swift"
    ])).toMatchObject({
      affected: true,
      matched: ["apps/neondiff-desktop/Package.swift"],
      files: ["--base", "apps/neondiff-desktop/Package.swift"]
    });
  });

  it("documents that --files is terminal", () => {
    const help = execFileSync("node", ["scripts/swift-affected.mjs", "--help"], { encoding: "utf8" });

    expect(help).toMatch(/--files is terminal/);
  });

  it("documents the fast preview/smoke loop and the release proof boundary", () => {
    const betaRunbook = read("docs/beta-release-runbook.md");
    const macRunbook = read("apps/neondiff-desktop/docs/mac-release-runbook.md");
    const desktopDocs = read("docs/neondiff-desktop.md");

    expect(betaRunbook).toMatch(/Fast Iteration And Batched Release Validation/);
    expect(betaRunbook).toMatch(/preview server\/browser\s+smoke/);
    expect(betaRunbook).toMatch(/Swift desktop gate/);
    expect(betaRunbook).toMatch(/remove Swift from\s+GitHub CodeQL default setup/i);
    expect(betaRunbook).toMatch(/code-scanning\/default-setup/);
    expect(betaRunbook).toMatch(/languages must not contain `swift`/);
    expect(betaRunbook).toMatch(/desktop-smoke/);
    expect(betaRunbook).toMatch(/desktop-release/);

    expect(macRunbook).toMatch(/Fast Desktop Iteration Before Release/);
    expect(macRunbook).toMatch(/swift run NeonDiffDesktopCoreSmoke/);
    expect(macRunbook).toMatch(/script\/build_and_run\.sh bundle-check/);
    expect(macRunbook).toMatch(/path-aware Swift CodeQL workflow is a release\/security scan/);

    expect(desktopDocs).toMatch(/script\/build_and_run\.sh build/);
    expect(desktopDocs).toMatch(/script\/build_and_run\.sh bundle-check/);
    expect(desktopDocs).toMatch(/Signed,\s*notarized,\s*appcast,\s*and installed-app visual proof belong to the Mac release\s+runbook/);
  });
});
