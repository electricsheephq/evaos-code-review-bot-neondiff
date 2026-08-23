import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, loadConfigFromObject, resolvePortableHomePath } from "../src/config.js";
import { resolveEvalOutputRoot } from "../src/eval-harness.js";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));

describe("portable source defaults", () => {
  const originalEvalRoot = process.env.NEONDIFF_EVAL_ROOT;

  afterEach(() => {
    if (originalEvalRoot === undefined) delete process.env.NEONDIFF_EVAL_ROOT;
    else process.env.NEONDIFF_EVAL_ROOT = originalEvalRoot;
  });

  it("uses a portable external eval default and honors an explicit root", () => {
    delete process.env.NEONDIFF_EVAL_ROOT;
    expect(resolveEvalOutputRoot()).toBe(join(homedir(), ".local", "share", "neondiff", "evals"));

    const evalRoot = join(tmpdir(), "neondiff-portable-evals");
    process.env.NEONDIFF_EVAL_ROOT = evalRoot;
    expect(resolveEvalOutputRoot()).toBe(evalRoot);

    process.env.NEONDIFF_EVAL_ROOT = process.cwd();
    expect(() => resolveEvalOutputRoot()).toThrow("must not be inside the current git checkout");
  });

  it("uses portable user-local source defaults", () => {
    const config = loadConfigFromObject({});
    const noArgConfig = loadConfig();

    expect(config.skillPacks?.skillRoot).toBe(join(homedir(), ".config", "neondiff", "skills"));
    expect(config.zcode.appConfigPath).toBe(join(homedir(), ".config", "zcode", "config.json"));
    expect(noArgConfig.skillPacks?.skillRoot).toBe(config.skillPacks?.skillRoot);
    expect(noArgConfig.zcode.appConfigPath).toBe(config.zcode.appConfigPath);
    expect(JSON.stringify(config)).not.toContain("/Volumes/LEXAR");
    expect(readFileSync(new URL("../config.example.json", import.meta.url), "utf8")).not.toContain("/Volumes/LEXAR");
    expect(readFileSync(new URL("../apps/neondiff-desktop/Sources/NeonDiffDesktopCoreSmoke/main.swift", import.meta.url), "utf8")).not.toContain("/Volumes/LEXAR");
    expect(resolvePortableHomePath("/Users/test", ".config", "neondiff")).toBe("/Users/test/.config/neondiff");
    expect(() => resolvePortableHomePath("", ".config")).toThrow("must be absolute");
    expect(() => resolvePortableHomePath("../../escape", ".config")).toThrow("must be absolute");
  });

  it("fails closed for an explicit missing or empty config path", () => {
    expect(() => loadConfig(join(tmpdir(), "neondiff-config-does-not-exist.json"))).toThrow(
      "config file not found"
    );
    expect(() => loadConfig("")).toThrow("config path is required");
  });

  it("rejects QA evidence inside the checkout from a nested cwd", () => {
    const tsxCommand = process.env.NEONDIFF_TEST_TSX ?? join(repoRoot, "node_modules", ".bin", "tsx");
    const result = spawnSync(tsxCommand, [
      join(repoRoot, "scripts", "qa-lab", "queue-sim.ts")
    ], {
      cwd: join(repoRoot, "tests"),
      env: { ...process.env, NEONDIFF_EVIDENCE_ROOT: repoRoot },
      encoding: "utf8",
      timeout: 5_000
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("NEONDIFF_EVIDENCE_ROOT must be outside the current checkout");
  });

  it("reports a missing release-status config as structured JSON", () => {
    const missingConfig = join(tmpdir(), `neondiff-missing-${Date.now()}.json`);
    const tsxCommand = process.env.NEONDIFF_TEST_TSX ?? join(repoRoot, "node_modules", ".bin", "tsx");
    const result = spawnSync(tsxCommand, [
      join(repoRoot, "src", "cli.ts"),
      "release-status",
      "--config",
      missingConfig
    ], { cwd: repoRoot, encoding: "utf8" });
    const output = JSON.parse(result.stdout);

    expect(result.status).toBe(1);
    expect(output.ok).toBe(false);
    expect(output.failedGates).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "config_load", ok: false })])
    );
    expect(result.stderr).toBe("");
  });
});
