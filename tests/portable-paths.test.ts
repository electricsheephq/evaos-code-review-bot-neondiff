import { readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, loadConfigFromObject, resolvePortableHomePath } from "../src/config.js";
import { resolveEvalOutputRoot } from "../src/eval-harness.js";

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
});
