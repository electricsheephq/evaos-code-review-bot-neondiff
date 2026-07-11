import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function read(path: string): string {
  return readFileSync(path, "utf8");
}

const retiredCoreChecksTarget = ["NeonDiffDesktopCore", "Checks"].join("");

function swiftAffected(files: string[]): { affected: boolean; matched: string[]; files: string[] } {
  return JSON.parse(execFileSync("node", ["scripts/swift-affected.mjs", "--files", ...files], { encoding: "utf8" }));
}

describe("Swift CI velocity policy", () => {
  it("classifies desktop and Swift workflow paths without flagging docs or TypeScript release tooling", () => {
    expect(swiftAffected([
      "docs/releases/v0.4.43-beta.1.md",
      "src/release-status.ts",
      "tests/release-status.test.ts",
      ".github/workflows/ci.yml",
      "apps/neondiff-desktop/docs/mac-release-runbook.md"
    ])).toMatchObject({
      affected: false,
      matched: []
    });

    expect(swiftAffected([
      "apps/neondiff-desktop/Sources/NeonDiffDesktop/Views/ContentView.swift",
      "shared/canonical-secret-rules.json",
      "scripts/check-secret-corpus-boundary.mjs",
      "scripts/check-secret-rule-differential.mjs",
      "apps/neondiff-desktop/fixtures/ui/catalog.json",
      ".github/workflows/swift-desktop-gate.yml"
    ])).toMatchObject({
      affected: true,
      matched: [
        "apps/neondiff-desktop/Sources/NeonDiffDesktop/Views/ContentView.swift",
        "shared/canonical-secret-rules.json",
        "scripts/check-secret-corpus-boundary.mjs",
        "scripts/check-secret-rule-differential.mjs",
        "apps/neondiff-desktop/fixtures/ui/catalog.json",
        ".github/workflows/swift-desktop-gate.yml"
      ]
    });
  });

  it("ships an always-reporting Swift desktop gate and a scheduled/manual Swift CodeQL workflow", () => {
    expect(existsSync(".github/workflows/swift-desktop-gate.yml")).toBe(true);
    expect(existsSync(".github/workflows/codeql-swift-path-aware.yml")).toBe(true);
    expect(existsSync("docs/swift-codeql-policy.md")).toBe(true);

    const gate = read(".github/workflows/swift-desktop-gate.yml");
    const codeql = read(".github/workflows/codeql-swift-path-aware.yml");
    const swiftCodeQLPolicy = read("docs/swift-codeql-policy.md");

    expect(gate).toMatch(/name:\s*Swift Desktop Gate/);
    expect(gate).toMatch(/swift-desktop-impact:/);
    expect(gate).toMatch(/name:\s*Swift desktop impact/);
    expect(gate).toMatch(/runs-on:\s*ubuntu-latest/);
    expect(gate).toMatch(/outputs:\s*\n\s*affected:/);
    expect(gate).toMatch(/swift-desktop-smoke:/);
    expect(gate).toMatch(/name:\s*Swift desktop smoke/);
    expect(gate).toMatch(/needs:\s*swift-desktop-impact/);
    expect(gate).toMatch(/if:\s*needs\.swift-desktop-impact\.outputs\.affected == 'true'/);
    expect(gate).toMatch(/runs-on:\s*macos-15/);
    expect(gate).toMatch(/swift-desktop-gate:/);
    expect(gate).toMatch(/Swift desktop gate/);
    expect(gate).toMatch(/needs:\s*\n\s*-\s*swift-desktop-impact\n\s*-\s*swift-desktop-smoke/);
    expect(gate).toMatch(/if:\s*always\(\)/);
    expect(gate).toMatch(/No Swift desktop files changed; macOS smoke correctly skipped/);
    expect(gate).toMatch(/scripts\/swift-affected\.mjs/);
    expect(gate).toMatch(/No Swift desktop files changed/);
    expect(gate).toMatch(/swift build --target NeonDiffDesktopKeychainChecks/);
    expect(gate).toMatch(/npm run check:secret-rule-differential/);
    expect(gate.match(/scripts\/run-swift-tests\.sh --filter NeonDiffDesktopCoreTests/g)).toHaveLength(1);
    expect(gate).not.toContain(retiredCoreChecksTarget);
    expect(gate.match(/swift run NeonDiffDesktopFixtureChecks/g)).toHaveLength(1);
    expect(gate).not.toMatch(/swift run NeonDiffDesktopKeychainChecks/);
    expect(gate).toMatch(/swift build/);
    expect(gate).toMatch(/script\/build_and_run\.sh build/);
    expect(gate).toMatch(/script\/build_and_run\.sh bundle-check/);
    expect(gate).toMatch(/cancel-in-progress:\s*true/);
    expect(gate).toMatch(/current PR\/main head/);
    expect(gate).toMatch(/Superseded runs may be cancelled/);
    expect(gate).toMatch(/persist-credentials:\s*false/);
    expect(gate).toMatch(/EVENT_NAME:/);
    expect(gate).toMatch(/BASE_REF:/);
    expect(gate).toMatch(/PULL_HEAD_SHA:/);
    expect(gate).toMatch(/payload && payload\.affected === true/);
    expect(gate).toMatch(/console\.log\('false'\)/);
    expect(gate).toMatch(/base ref unavailable; fail open/);

    expect(codeql).toMatch(/name:\s*Swift CodeQL Path-Aware/);
    expect(codeql).not.toMatch(/pull_request:/);
    expect(codeql).not.toMatch(/push:/);
    expect(codeql).not.toMatch(/apps\/neondiff-desktop\/Sources\/\*\*/);
    expect(codeql).not.toMatch(/apps\/neondiff-desktop\/Package\.swift/);
    expect(codeql).not.toMatch(/apps\/neondiff-desktop\/Package\.resolved/);
    expect(codeql).not.toMatch(/\.github\/workflows\/swift-desktop-gate\.yml/);
    expect(codeql).not.toMatch(/\.github\/workflows\/codeql-swift-path-aware\.yml/);
    expect(codeql).not.toMatch(/-\s*Package\.swift/);
    expect(codeql).not.toMatch(/-\s*Package\.resolved/);
    expect(codeql).toMatch(/languages:\s*swift/);
    expect(codeql).toMatch(/build-mode:\s*manual/);
    expect(codeql).toMatch(/swift build --product NeonDiffDesktop/);
    expect(codeql).toMatch(/upload:\s*false/);
    expect(codeql).toMatch(/upload-database:\s*false/);
    expect(codeql).toMatch(/wait-for-processing:\s*false/);
    expect(codeql).toMatch(/timeout-minutes:\s*35/);
    expect(codeql).toMatch(/default setup is enabled/);
    expect(codeql).toMatch(/#393/);
    expect(codeql).toMatch(/docs\/swift-codeql-policy\.md/);
    expect(codeql).not.toMatch(/security-events:\s*write/);
    expect(codeql).toMatch(/persist-credentials:\s*false/);
    expect(codeql).not.toMatch(/actions\/checkout@v4/);
    expect(codeql).not.toMatch(/github\/codeql-action\/init@v3/);
    expect(codeql).not.toMatch(/github\/codeql-action\/analyze@v3/);
    expect(codeql).not.toMatch(/--arch arm64/);
    expect(codeql).not.toMatch(/github\/codeql-action\/autobuild/);
    expect(codeql).toMatch(/schedule:/);
    expect(codeql).toMatch(/workflow_dispatch:/);
    expect(codeql).toMatch(/cancel-in-progress:\s*true/);
    expect(swiftCodeQLPolicy).toMatch(/not the\s+inner PR iteration loop/);
    expect(swiftCodeQLPolicy).toMatch(/no `pull_request` or `push` trigger/);
    expect(swiftCodeQLPolicy).toMatch(/upload: false/);
    expect(swiftCodeQLPolicy).toMatch(/default setup may remain configured/);
    expect(swiftCodeQLPolicy).toMatch(/must not list Swift/);
    expect(swiftCodeQLPolicy).toMatch(/35-minute job timeout/);
    expect(swiftCodeQLPolicy).toMatch(/--ref <immutable-release-tag>/);
    expect(swiftCodeQLPolicy).toMatch(/headSha.*equals the exact source SHA/);
    expect(swiftCodeQLPolicy).toMatch(/provisional evidence/);
    expect(swiftCodeQLPolicy).toMatch(/28882286388/);
    expect(swiftCodeQLPolicy).toMatch(/28886926047/);
    expect(swiftCodeQLPolicy).toMatch(/about 25m48s/);
    expect(swiftCodeQLPolicy).toMatch(/about 22m30s/);
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

  it("degrades safely when git diff refs are unavailable", () => {
    const output = execFileSync("node", [
      "scripts/swift-affected.mjs",
      "--base",
      "refs/does-not-exist",
      "--head",
      "also-missing"
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

    expect(JSON.parse(output)).toMatchObject({
      affected: false,
      matched: [],
      files: []
    });
  });

  it("documents the fast preview/smoke loop and the release proof boundary", () => {
    const betaRunbook = read("docs/beta-release-runbook.md");
    const macRunbook = read("apps/neondiff-desktop/docs/mac-release-runbook.md");
    const desktopDocs = read("docs/neondiff-desktop.md");

    expect(betaRunbook).toMatch(/Fast Iteration And Batched Release Validation/);
    expect(betaRunbook).toMatch(/preview server\/browser\s+smoke/);
    expect(betaRunbook).toMatch(/Swift desktop gate/);
    expect(betaRunbook).toMatch(/runs `NeonDiffDesktopCoreTests`/);
    expect(betaRunbook).toMatch(/`NeonDiffDesktopKeychainChecks`/);
    expect(betaRunbook).toMatch(/docs\/swift-codeql-policy\.md/);
    expect(betaRunbook).toMatch(/must not contain `swift`/);
    expect(betaRunbook).toMatch(/code-scanning\/default-setup/);
    expect(betaRunbook).toMatch(/read-only verification output currently includes `actions`, `javascript`,\s+`javascript-typescript`, and `typescript`/);
    expect(betaRunbook).toMatch(/not a PATCH payload/);
    expect(betaRunbook).toMatch(/desktop-smoke/);
    expect(betaRunbook).toMatch(/desktop-release/);
    expect(betaRunbook).toMatch(/Visible Desktop UI Smoke/);
    expect(betaRunbook).toMatch(/script\/build_and_run\.sh run/);
    expect(betaRunbook).toMatch(/exact `dist\/NeonDiffDesktop\.app` path/);
    expect(betaRunbook).toMatch(/Welcome visible/);
    expect(betaRunbook).toMatch(/changed button\/action clicked/);
    expect(betaRunbook).toMatch(/credential-gated steps/);
    expect(betaRunbook).toMatch(/A build-only Swift pass is not visible UI proof/);

    expect(macRunbook).toMatch(/Fast Desktop Iteration Before Release/);
    expect(macRunbook).toMatch(/swift run NeonDiffDesktopCoreSmoke/);
    expect(macRunbook).toMatch(/run the Swift Core tests/);
    expect(macRunbook).toMatch(/Run\s+`NeonDiffDesktopCoreTests`/);
    expect(macRunbook).toMatch(/script\/build_and_run\.sh bundle-check/);
    expect(macRunbook).toMatch(/path-aware Swift\s+CodeQL workflow is a release\/security scan/);
    expect(macRunbook).toMatch(/weekly schedule or manual dispatch\s+against the intended release ref/);
    expect(macRunbook).toMatch(/docs\/swift-codeql-policy\.md/);
    expect(macRunbook).toMatch(/Visible Desktop UI Smoke/);
    expect(macRunbook).toMatch(/Computer Use/);
    expect(macRunbook).toMatch(/CI artifact smoke/);
    expect(macRunbook).toMatch(/Signed\/notarized release proof/);
    expect(macRunbook).toMatch(/A build-only Swift pass is not visible UI proof/);
    expect(macRunbook).toMatch(/Continue advanced from Welcome/);
    expect(macRunbook).toMatch(/Provider key missing/);

    expect(desktopDocs).toMatch(/script\/build_and_run\.sh build/);
    expect(desktopDocs).toMatch(/script\/build_and_run\.sh bundle-check/);
    expect(desktopDocs).toMatch(/Signed,\s*notarized,\s*appcast,\s*and installed-app visual proof belong to the Mac release\s+runbook/);
  });
});
