import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    expect(read(scriptPath)).toContain('basePackageVersion !== "1.0.5"');
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
      "reviewFlags",
      "offlineInstallPassed",
      "bundledProductionDependencies",
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
    expect(script).toContain("--expected-config-revision");
    expect(script).toContain("--zcode");
    expect(script).toContain("empty-npm-cache");
    expect(script).toMatch(/execFileSync\("npm", \[\s*"ci",\s*"--ignore-scripts"/);
    expect(script).toContain("--allow-b0-bundled-production-closure");
    expect(script).toContain('name: "ajv", version: "8.20.0"');
    expect(script).toContain('name: "validate-npm-package-license", version: "3.0.4"');
    expect(script).toContain("git status --porcelain");
    expect(script).toContain("must not be a symbolic link");
    expect(script).toContain("must be private to the current user (0700)");
    expect(script).toContain("neondiff-beta-canary");
    expect(script).not.toMatch(/\bnpm publish\b/);
    expect(script).not.toMatch(/\bnpm dist-tag\b/);
    expect(script).not.toMatch(/\bgh release\b/);
    expect(script).not.toMatch(/\bgit tag\b/);
  });

  it("allows only the locked bundled B0 production dependency closure", () => {
    const temporary = mkdtempSync(join(tmpdir(), "neondiff-b0-packlist-"));
    const packPath = join(temporary, "pack.json");
    const required = [
      "dist/src/cli.js",
      "README.md",
      "LICENSE.md",
      "SECURITY.md",
      "CODE_OF_CONDUCT.md",
      "config.example.json",
      "docs/SETUP.md",
      "docs/ci-runner.md",
      "docs/docker.md",
      "docs/github-app-setup.md",
      "docs/providers.md",
      "docs/license-boundary.md",
      "docs/pricing.md",
      "docs/schema/neondiff-config.schema.json",
      "docs/systemd.md",
      "systemd/neondiff.service.example",
      "systemd/neondiff.user.service.example",
      "Dockerfile",
      "docker-compose.example.yml"
    ];
    const allowedClosure = [
      "node_modules/ajv/package.json",
      "node_modules/fast-deep-equal/package.json",
      "node_modules/fast-uri/package.json",
      "node_modules/json-schema-traverse/package.json",
      "node_modules/require-from-string/package.json",
      "node_modules/spdx-correct/package.json",
      "node_modules/spdx-exceptions/package.json",
      "node_modules/spdx-expression-parse/package.json",
      "node_modules/spdx-license-ids/package.json",
      "node_modules/validate-npm-package-license/package.json"
    ];
    try {
      writeFileSync(packPath, JSON.stringify([{ files: [...required, ...allowedClosure].map((path) => ({ path })) }]));
      const deniedByDefault = spawnSync(
        process.execPath,
        ["scripts/check-packlist.mjs", packPath],
        { encoding: "utf8" }
      );
      expect(deniedByDefault.status).not.toBe(0);
      expect(deniedByDefault.stderr).toContain("node_modules/validate-npm-package-license/package.json");

      const allowed = spawnSync(process.execPath, [
        "scripts/check-packlist.mjs",
        packPath,
        "--allow-b0-bundled-production-closure"
      ], { encoding: "utf8" });
      expect(allowed.status, `${allowed.stdout}\n${allowed.stderr}`).toBe(0);
      expect(allowed.stdout).toContain(`packlist ok: ${required.length + allowedClosure.length} files`);

      writeFileSync(packPath, JSON.stringify([{
        files: [...required.slice(1), ...allowedClosure].map((path) => ({ path }))
      }]));
      const missingRequired = spawnSync(process.execPath, [
        "scripts/check-packlist.mjs",
        packPath,
        "--allow-b0-bundled-production-closure"
      ], { encoding: "utf8" });
      expect(missingRequired.status).not.toBe(0);
      expect(missingRequired.stderr).toContain(`Missing required package file: ${required[0]}`);

      writeFileSync(packPath, JSON.stringify([{
        files: [...required, ...allowedClosure, "node_modules/unreviewed-package/index.js"]
          .map((path) => ({ path }))
      }]));
      const rejected = spawnSync(process.execPath, [
        "scripts/check-packlist.mjs",
        packPath,
        "--allow-b0-bundled-production-closure"
      ], { encoding: "utf8" });
      expect(rejected.status).not.toBe(0);
      expect(rejected.stderr).toContain("node_modules/unreviewed-package/index.js");
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });
});
