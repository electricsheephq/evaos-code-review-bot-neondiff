import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

  it("wires the boundary scan and fixture checks into the Swift desktop gate", () => {
    const packageJSON = JSON.parse(readFileSync("package.json", "utf8"));
    const gate = readFileSync(".github/workflows/swift-desktop-gate.yml", "utf8");

    expect(packageJSON.scripts["check:desktop-fixture-boundary"]).toBe(
      "node scripts/check-desktop-fixture-boundary.mjs"
    );
    expect(gate).toMatch(/swift run NeonDiffDesktopFixtureChecks/);
    expect(gate).toMatch(/npm run check:desktop-fixture-boundary/);
    expect(gate).toMatch(/release_bin\/NeonDiffDesktop/);
    expect(gate).toMatch(/dist\/NeonDiffDesktop\.app/);
  });
});
