import { readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, loadConfigFromObject } from "../src/config.js";
import { resolveEvalOutputRoot } from "../src/eval-harness.js";

describe("portable source defaults", () => {
  const originalEvalRoot = process.env.NEONDIFF_EVAL_ROOT;

  afterEach(() => {
    if (originalEvalRoot === undefined) delete process.env.NEONDIFF_EVAL_ROOT;
    else process.env.NEONDIFF_EVAL_ROOT = originalEvalRoot;
  });

  it("requires an explicit external eval root and honors it", () => {
    delete process.env.NEONDIFF_EVAL_ROOT;
    expect(() => resolveEvalOutputRoot()).toThrow("NEONDIFF_EVAL_ROOT is required");

    const evalRoot = join(tmpdir(), "neondiff-portable-evals");
    process.env.NEONDIFF_EVAL_ROOT = evalRoot;
    expect(resolveEvalOutputRoot()).toBe(evalRoot);
  });

  it("uses portable user-local source defaults", () => {
    const config = loadConfigFromObject({});

    expect(config.skillPacks?.skillRoot).toBe(join(homedir(), ".config", "neondiff", "skills"));
    expect(config.zcode.appConfigPath).toBe(join(homedir(), ".config", "zcode", "config.json"));
    expect(JSON.stringify(config)).not.toContain("/Volumes/LEXAR");
    expect(readFileSync(new URL("../config.example.json", import.meta.url), "utf8")).not.toContain("/Volumes/LEXAR");
  });

  it("fails closed for an explicit missing or empty config path", () => {
    expect(() => loadConfig(join(tmpdir(), "neondiff-config-does-not-exist.json"))).toThrow(
      "config file not found"
    );
    expect(() => loadConfig("")).toThrow("config path is required");
  });
});
