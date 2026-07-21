import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
const workflowPath = ".github/workflows/b0-cli-candidate.yml";
const scriptPath = "scripts/build-b0-cli-candidate.mjs";

function read(path: string): string {
  return readFileSync(path, "utf8");
}

describe("B0 access-controlled CLI candidate", () => {
  it("does not expose the private candidate as a public-repository Actions artifact", () => {
    expect(existsSync(workflowPath)).toBe(false);
  });

  it("validates candidate identity before touching package metadata", () => {
    expect(existsSync(scriptPath)).toBe(true);

    const invalidHead = spawnSync(process.execPath, [
      scriptPath,
      "--candidate-head", "HEAD",
      "--package-version", "1.1.0-beta.2",
      "--output-dir", "/tmp/neondiff-b0-invalid-head"
    ], { encoding: "utf8" });
    expect(invalidHead.status).not.toBe(0);
    expect(invalidHead.stderr).toContain("candidate head must be one lowercase full Git SHA");

    const invalidVersion = spawnSync(process.execPath, [
      scriptPath,
      "--candidate-head", "0".repeat(40),
      "--package-version", "latest",
      "--output-dir", "/tmp/neondiff-b0-invalid-version"
    ], { encoding: "utf8" });
    expect(invalidVersion.status).not.toBe(0);
    expect(invalidVersion.stderr).toContain("package version must match 1.1.0-beta.N");
  });

  it("records exact package identity, installed capabilities, and the proof boundary", () => {
    expect(existsSync(scriptPath)).toBe(true);

    const script = read(scriptPath);
    for (const field of [
      "schemaVersion",
      "candidateClass",
      "candidateHead",
      "protectedMainVerified",
      "basePackageVersion",
      "packageVersion",
      "filename",
      "sha256",
      "shasum",
      "integrity",
      "reportedVersion",
      "nodeVersion",
      "activationFlags",
      "githubDoctorFlags",
      "publicNpmPublished",
      "tagCreated",
      "githubReleaseCreated",
      "privateBucketTarget",
      "uploaded",
      "proofBoundary"
    ]) {
      expect(script).toContain(field);
    }
    expect(script).toContain("npm");
    expect(script).toContain("pack");
    expect(script).toContain("check-packlist.mjs");
    expect(script).toMatch(/execFileSync\("npm", \[\s*"run",\s*"build"/);
    expect(script.search(/"run",\s*"build"/)).toBeLessThan(script.indexOf('"pack"'));
    expect(script).toContain('ensureClean(repoRoot, "post-build")');
    expect(script).toContain("--persist-local-state");
    expect(script).toContain("--license-machine-id");
    expect(script).toContain("--github-app-id");
    expect(script).toContain("--github-app-private-key-stdin");
    expect(script).toContain("git status --porcelain");
    expect(script).toContain("must not be a symbolic link");
    expect(script).toContain("must be private to the current user (0700)");
    expect(script).toContain("neondiff-beta-canary");
    expect(script).not.toMatch(/\bnpm publish\b/);
    expect(script).not.toMatch(/\bnpm dist-tag\b/);
    expect(script).not.toMatch(/\bgh release\b/);
    expect(script).not.toMatch(/\bgit tag\b/);
  });
});
