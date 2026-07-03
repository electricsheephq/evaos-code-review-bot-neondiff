import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withTemporaryZCodeReviewPolicy } from "../src/zcode.js";

describe("temporary ZCode review policy", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("installs a restrictive project policy only for the ZCode run", () => {
    const root = mkdtempSync(join(tmpdir(), "zcode-policy-"));
    const evidence = mkdtempSync(join(tmpdir(), "zcode-policy-evidence-"));
    roots.push(root, evidence);

    const result = withTemporaryZCodeReviewPolicy(root, evidence, () => {
      const policyPath = join(root, ".zcode", "config.json");
      const policy = JSON.parse(readFileSync(policyPath, "utf8")) as {
        permission: { allowedTools: string[]; disallowedTools: string[] };
        features: { subagent: boolean };
      };

      expect(policy.permission.allowedTools).toEqual(["Read", "Grep", "Glob", "LS"]);
      expect(policy.permission.disallowedTools).toContain("Bash");
      expect(policy.features.subagent).toBe(false);
      return "reviewed";
    });

    expect(result).toBe("reviewed");
    expect(existsSync(join(root, ".zcode", "config.json"))).toBe(false);
    expect(readFileSync(join(evidence, "zcode-review-policy.json"), "utf8")).toContain("\"Bash\"");
  });

  it("restores an existing repo ZCode config after the run", () => {
    const root = mkdtempSync(join(tmpdir(), "zcode-policy-existing-"));
    roots.push(root);
    const configDir = join(root, ".zcode");
    const configPath = join(configDir, "config.json");
    mkdirSync(configDir);
    writeFileSync(configPath, "{\"features\":{\"subagent\":true}}\n");

    withTemporaryZCodeReviewPolicy(root, undefined, () => {
      expect(readFileSync(configPath, "utf8")).toContain("\"Bash\"");
    });

    expect(readFileSync(configPath, "utf8")).toBe("{\"features\":{\"subagent\":true}}\n");
  });

  it("restores an existing repo ZCode config when the run removes the config directory", () => {
    const root = mkdtempSync(join(tmpdir(), "zcode-policy-existing-removed-"));
    roots.push(root);
    const configDir = join(root, ".zcode");
    const configPath = join(configDir, "config.json");
    mkdirSync(configDir);
    writeFileSync(configPath, "{\"features\":{\"subagent\":true}}\n");

    const result = withTemporaryZCodeReviewPolicy(root, undefined, () => {
      rmSync(configDir, { recursive: true, force: true });
      return "reviewed";
    });

    expect(result).toBe("reviewed");
    expect(readFileSync(configPath, "utf8")).toBe("{\"features\":{\"subagent\":true}}\n");
  });
});
