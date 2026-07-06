import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { evaluateCalibrationPromotion, runCalibrationPromotion } from "../src/calibration-promote.js";

const tsxCli = createRequire(import.meta.url).resolve("tsx/cli");

const ELIGIBLE = { labeledFindings: 120, p0p1Labels: 35, negativeControlScenarios: 12, bestWilsonLowerBound: 0.96 };

function writeAggregate(dir: string, overrides: Partial<typeof ELIGIBLE> = {}): string {
  const path = join(dir, "aggregate-calibration.json");
  writeFileSync(path, `${JSON.stringify({ ...ELIGIBLE, ...overrides })}\n`);
  return path;
}

describe("calibration promotion gate (#286 PR C)", () => {
  it("names the failing gate for each below-threshold input", () => {
    expect(evaluateCalibrationPromotion({ ...ELIGIBLE, labeledFindings: 99 }).failingGate).toBe("min_labeled_findings");
    expect(evaluateCalibrationPromotion({ ...ELIGIBLE, p0p1Labels: 29 }).failingGate).toBe("min_p0_p1_labels");
    expect(evaluateCalibrationPromotion({ ...ELIGIBLE, negativeControlScenarios: 9 }).failingGate).toBe("min_negative_control_scenarios");
    expect(evaluateCalibrationPromotion({ ...ELIGIBLE, bestWilsonLowerBound: 0.94 }).failingGate).toBe("min_wilson_lower_bound");
    expect(evaluateCalibrationPromotion(ELIGIBLE).eligible).toBe(true);
  });

  it("evaluates against the operator's RAISED effective floors when a policy override is supplied (#286 PR C)", () => {
    // ELIGIBLE clears the hard floor (30 P0/P1) but the operator raised the minimum to 50.
    expect(evaluateCalibrationPromotion(ELIGIBLE).eligible).toBe(true);
    const gate = evaluateCalibrationPromotion(ELIGIBLE, { minP0P1Labels: 50 });
    expect(gate.eligible).toBe(false);
    expect(gate.failingGate).toBe("min_p0_p1_labels");
  });
});

describe("calibration promotion run (#286 PR C)", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("requires --confirm", () => {
    const dir = mkdtempSync(join(tmpdir(), "evaos-promote-confirm-"));
    roots.push(dir);
    expect(() =>
      runCalibrationPromotion({ aggregatePath: writeAggregate(dir), outputDir: join(dir, "out"), confirm: false })
    ).toThrow(/--confirm/);
  });

  it("writes a config PATCH FILE that never sets publicDisplay.mode (default patch mode)", () => {
    const dir = mkdtempSync(join(tmpdir(), "evaos-promote-patch-"));
    roots.push(dir);
    const result = runCalibrationPromotion({ aggregatePath: writeAggregate(dir), outputDir: join(dir, "out"), confirm: true });

    expect(result.mode).toBe("patch");
    const patch = readFileSync(result.outputPath!, "utf8");
    const parsed = JSON.parse(patch);
    // The patch carries the numbers but NEVER the mode field: the calibrated flip is a manual edit.
    expect(parsed.confidenceCalibration.publicDisplay).toMatchObject({ labeledFindings: 120, p0p1Labels: 35, negativeControlScenarios: 12, wilsonLowerBound: 0.96 });
    expect(parsed.confidenceCalibration.publicDisplay.mode).toBeUndefined();
    // The loud note explains mode stays manual; assert no publicDisplay.mode key exists anywhere.
    expect(JSON.stringify(parsed.confidenceCalibration.publicDisplay)).not.toMatch(/"mode"/);
  });

  it("refuses below-threshold evidence with the failing gate named (nothing written)", () => {
    const dir = mkdtempSync(join(tmpdir(), "evaos-promote-below-"));
    roots.push(dir);
    expect(() =>
      runCalibrationPromotion({ aggregatePath: writeAggregate(dir, { p0p1Labels: 5 }), outputDir: join(dir, "out"), confirm: true })
    ).toThrow(/min_p0_p1_labels/);
    expect(existsSync(join(dir, "out"))).toBe(false);
  });

  it("--apply requires the --i-understand-live-config double flag and still never sets mode", () => {
    const dir = mkdtempSync(join(tmpdir(), "evaos-promote-apply-"));
    roots.push(dir);
    expect(() =>
      runCalibrationPromotion({ aggregatePath: writeAggregate(dir), outputDir: join(dir, "out"), confirm: true, apply: true })
    ).toThrow(/i-understand-live-config/);

    const ok = runCalibrationPromotion({
      aggregatePath: writeAggregate(dir), outputDir: join(dir, "out2"), confirm: true, apply: true, iUnderstandLiveConfig: true
    });
    expect(ok.mode).toBe("apply");
    const applied = JSON.parse(readFileSync(ok.outputPath!, "utf8"));
    expect(applied.confidenceCalibration.publicDisplay.mode).toBeUndefined();
  });

  it("exposes a CLI that requires --confirm and writes a patch, never mutating a live config", () => {
    const dir = mkdtempSync(join(tmpdir(), "evaos-promote-cli-"));
    roots.push(dir);
    const aggregatePath = writeAggregate(dir);
    const outputDir = join(dir, "out");

    const output = execFileSync(process.execPath, [
      tsxCli, "src/cli.ts", "calibration-promote", "--input", aggregatePath, "--output-dir", outputDir, "--confirm", "true"
    ], { cwd: process.cwd(), encoding: "utf8" });

    const parsed = JSON.parse(output);
    expect(parsed).toMatchObject({ command: "calibration-promote", ok: true, mode: "patch", eligible: true });
    expect(existsSync(join(outputDir, "calibration-config-patch.json"))).toBe(true);
  });
});
