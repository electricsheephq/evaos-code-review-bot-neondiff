import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const tsxCommand = process.env.NEONDIFF_TEST_TSX ?? join(repoRoot, "node_modules", ".bin", "tsx");

describe("structured config recovery", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("keeps no-argument defaults user-local and rejects empty explicit paths", () => {
    const config = loadConfig();
    expect(config.skillPacks?.skillRoot).toBe(join(homedir(), ".config", "neondiff", "skills"));
    expect(config.zcode.appConfigPath).toBe(join(homedir(), ".config", "zcode", "config.json"));
    expect(JSON.stringify(config)).not.toContain("/Volumes/LEXAR");
    expect(() => loadConfig("")).toThrow("config path is required");
  });

  it.each(["release-status", "budget-status"])("reports missing %s config as JSON config_load", (command) => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-config-recovery-"));
    roots.push(root);
    const missingConfig = join(root, "missing.json");
    const result = spawnSync(tsxCommand, [join(repoRoot, "src/cli.ts"), command, "--config", missingConfig], {
      cwd: repoRoot,
      env: { ...process.env, NEONDIFF_TEST_TSX: tsxCommand },
      encoding: "utf8",
      timeout: 10_000
    });
    const output = JSON.parse(result.stdout);

    expect(result.status).toBe(1);
    expect(result.stderr).toBe("");
    expect(output.ok).toBe(false);
    expect(output.failedGates).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "config_load", ok: false })])
    );
  });
});
