import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

describe("npm release policy", () => {
  const roots: string[] = [];
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const policyScript = join(repoRoot, "scripts", "npm-release-policy.mjs");

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("rejects a stable npm package from a prerelease GitHub Release", () => {
    const result = spawnSync(process.execPath, [
      policyScript,
      "classify",
      "--event-name", "release",
      "--release-prerelease", "true",
      "--tag", "v1.0.3",
      "--package-version", "1.0.3",
      "--release-level", "stable",
      "--skipped-versions-json", "[]"
    ], { encoding: "utf8" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("stable npm packages require a non-prerelease GitHub Release");
  });

  it("classifies a matching stable release for npm latest", () => {
    const output = execFileSync(process.execPath, [
      policyScript,
      "classify",
      "--event-name", "release",
      "--release-prerelease", "false",
      "--tag", "v1.0.3",
      "--package-version", "1.0.3",
      "--release-level", "stable",
      "--skipped-versions-json", "[]"
    ], { encoding: "utf8" });

    expect(JSON.parse(output)).toEqual({ shouldPublish: true, npmTag: "latest" });
  });

  it("requires the release tag and declared candidate to be ancestors of protected main", () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-npm-release-policy-"));
    roots.push(root);
    execFileSync("git", ["init", "-b", "main"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "release-policy@example.invalid"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Release Policy Test"], { cwd: root });
    writeFileSync(join(root, "candidate.txt"), "candidate\n");
    execFileSync("git", ["add", "candidate.txt"], { cwd: root });
    execFileSync("git", ["commit", "-m", "candidate"], { cwd: root, stdio: "ignore" });
    const candidate = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    writeFileSync(join(root, "release.txt"), "release\n");
    execFileSync("git", ["add", "release.txt"], { cwd: root });
    execFileSync("git", ["commit", "-m", "release"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["tag", "-a", "v1.0.3", "-m", "v1.0.3"], { cwd: root });
    execFileSync("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], { cwd: root });

    expect(() => execFileSync(process.execPath, [
      policyScript,
      "verify-git",
      "--tag", "v1.0.3",
      "--candidate-head", candidate,
      "--main-ref", "refs/remotes/origin/main"
    ], { cwd: root, stdio: "pipe" })).not.toThrow();

    execFileSync("git", ["checkout", "-b", "unsafe", candidate], { cwd: root, stdio: "ignore" });
    writeFileSync(join(root, "unsafe.txt"), "unsafe\n");
    execFileSync("git", ["add", "unsafe.txt"], { cwd: root });
    execFileSync("git", ["commit", "-m", "unsafe"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["tag", "-a", "v1.0.4", "-m", "v1.0.4"], { cwd: root });

    const rejected = spawnSync(process.execPath, [
      policyScript,
      "verify-git",
      "--tag", "v1.0.4",
      "--candidate-head", candidate,
      "--main-ref", "refs/remotes/origin/main"
    ], { cwd: root, encoding: "utf8" });
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toContain("release tag commit must be an ancestor of protected main");
  });

  it("rejects an existing npm tarball whose integrity differs from the reviewed pack", () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-npm-pack-integrity-"));
    roots.push(root);
    const localPath = join(root, "pack.json");
    const remotePath = join(root, "remote.json");
    writeFileSync(localPath, JSON.stringify([{
      version: "1.0.3",
      integrity: "sha512-reviewed",
      shasum: "1111111111111111111111111111111111111111"
    }]));
    writeFileSync(remotePath, JSON.stringify({
      version: "1.0.3",
      "dist.integrity": "sha512-different",
      "dist.shasum": "2222222222222222222222222222222222222222"
    }));

    const result = spawnSync(process.execPath, [
      policyScript,
      "verify-pack",
      "--local-pack", localPath,
      "--remote-metadata", remotePath,
      "--expected-version", "1.0.3"
    ], { encoding: "utf8" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("npm tarball integrity does not match the reviewed pack");
  });
});
