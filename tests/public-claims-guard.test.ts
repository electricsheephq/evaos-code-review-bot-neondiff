import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const script = resolve("scripts/check-public-claims.mjs");
const scannedPaths = [...readFileSync(script, "utf8").matchAll(/^\s+"([^"]+\.md)",?$/gm)].map((match) => match[1]);
const roots: string[] = [];

function runGuardWith(readmePrefix: string) {
  const root = mkdtempSync(join(tmpdir(), "neondiff-public-claims-"));
  roots.push(root);
  for (const path of scannedPaths) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    copyFileSync(path, join(root, path));
  }
  // Prepend: the guard exempts matches with boundary words ("not", "never", ...) in the 12 lines before them.
  writeFileSync(join(root, "README.md"), `${readmePrefix}\n\n${readFileSync("README.md", "utf8")}`);
  return spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8" });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("public claims guard", () => {
  it("passes the current public docs", () => {
    expect(scannedPaths.length).toBeGreaterThan(5);
    expect(runGuardWith("").status).toBe(0);
  });

  it.each([
    "Private repositories are free to review with NeonDiff.",
    "Private repos are free.",
    "NeonDiff offers free private repo review.",
    "NeonDiff is free for private repositories."
  ])("rejects a free-private claim: %s", (claim) => {
    const result = runGuardWith(claim);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/forbidden public claims phrase/);
  });
});
