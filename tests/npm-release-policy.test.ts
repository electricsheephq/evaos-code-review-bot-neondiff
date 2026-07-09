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

  it("rejects a beta npm package from a non-prerelease GitHub Release", () => {
    const result = spawnSync(process.execPath, [
      policyScript,
      "classify",
      "--event-name", "release",
      "--release-prerelease", "false",
      "--tag", "v1.1.0-beta.1",
      "--package-version", "1.1.0-beta.1",
      "--release-level", "beta",
      "--skipped-versions-json", "[]"
    ], { encoding: "utf8" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("beta npm packages require a prerelease GitHub Release");
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

  it("requires manual stable retries to prove an existing non-prerelease GitHub Release", () => {
    const result = spawnSync(process.execPath, [
      policyScript,
      "classify",
      "--event-name", "workflow_dispatch",
      "--release-prerelease", "false",
      "--tag", "v1.0.3",
      "--package-version", "1.0.3",
      "--release-level", "stable",
      "--skipped-versions-json", "[]"
    ], { encoding: "utf8" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("manual stable publish requires an existing non-prerelease GitHub Release");
  });

  it("accepts a manual stable retry only with matching published release metadata", () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-manual-release-metadata-"));
    roots.push(root);
    const metadataPath = join(root, "release.json");
    writeFileSync(metadataPath, JSON.stringify({ tag_name: "v1.0.3", draft: false, prerelease: false }));

    const output = execFileSync(process.execPath, [
      policyScript,
      "classify",
      "--event-name", "workflow_dispatch",
      "--release-prerelease", "false",
      "--tag", "v1.0.3",
      "--package-version", "1.0.3",
      "--release-level", "stable",
      "--skipped-versions-json", "[]",
      "--release-metadata", metadataPath
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

    const unsafeCandidate = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    execFileSync("git", ["checkout", "main"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["tag", "-a", "v1.0.5", "-m", "v1.0.5"], { cwd: root });
    const candidateRejected = spawnSync(process.execPath, [
      policyScript,
      "verify-git",
      "--tag", "v1.0.5",
      "--candidate-head", unsafeCandidate,
      "--main-ref", "refs/remotes/origin/main"
    ], { cwd: root, encoding: "utf8" });
    expect(candidateRejected.status).not.toBe(0);
    expect(candidateRejected.stderr).toContain("declared release candidate head must be an ancestor of the release tag commit");
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

    writeFileSync(remotePath, JSON.stringify({
      version: "1.0.3",
      "dist.integrity": "sha512-reviewed",
      "dist.shasum": "2222222222222222222222222222222222222222"
    }));
    const shasumRejected = spawnSync(process.execPath, [
      policyScript,
      "verify-pack",
      "--local-pack", localPath,
      "--remote-metadata", remotePath,
      "--expected-version", "1.0.3"
    ], { encoding: "utf8" });
    expect(shasumRejected.status).not.toBe(0);
    expect(shasumRejected.stderr).toContain("npm tarball shasum does not match the reviewed pack");

    writeFileSync(remotePath, JSON.stringify({
      version: "1.0.3",
      "dist.integrity": "sha512-reviewed",
      "dist.shasum": "1111111111111111111111111111111111111111",
      gitHead: "2222222222222222222222222222222222222222"
    }));
    const gitHeadRejected = spawnSync(process.execPath, [
      policyScript,
      "verify-pack",
      "--local-pack", localPath,
      "--remote-metadata", remotePath,
      "--expected-version", "1.0.3",
      "--expected-git-head", "1111111111111111111111111111111111111111"
    ], { encoding: "utf8" });
    expect(gitHeadRejected.status).not.toBe(0);
    expect(gitHeadRejected.stderr).toContain("npm gitHead does not match the reviewed release tag commit");

    writeFileSync(remotePath, JSON.stringify({
      version: "1.0.3",
      "dist.integrity": "sha512-reviewed",
      "dist.shasum": "1111111111111111111111111111111111111111"
    }));
    const missingGitHeadRejected = spawnSync(process.execPath, [
      policyScript,
      "verify-pack",
      "--local-pack", localPath,
      "--remote-metadata", remotePath,
      "--expected-version", "1.0.3",
      "--expected-git-head", "1111111111111111111111111111111111111111"
    ], { encoding: "utf8" });
    expect(missingGitHeadRejected.status).not.toBe(0);
    expect(missingGitHeadRejected.stderr).toContain("npm gitHead is missing from published package metadata");
  });

  it("receives integrity and shasum from the npm dry-run pack used by the publish gate", () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-npm-pack-dry-run-"));
    roots.push(root);
    writeFileSync(join(root, "package.json"), JSON.stringify({
      name: "neondiff-pack-shape-probe",
      version: "1.0.3",
      files: ["index.js"]
    }));
    writeFileSync(join(root, "index.js"), "export const probe = true;\n");

    const [pack] = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json"], {
      cwd: root,
      encoding: "utf8"
    })) as Array<{ integrity?: string; shasum?: string }>;

    expect(pack.integrity).toMatch(/^sha512-/);
    expect(pack.shasum).toMatch(/^[a-f0-9]{40}$/);
  });

  it("allows only absent, identical, or manifest-declared predecessor channel values", () => {
    for (const currentVersion of ["", "1.0.2", "1.0.3"]) {
      const output = execFileSync(process.execPath, [
        policyScript,
        "verify-channel",
        "--current-version", currentVersion,
        "--target-version", "1.0.3",
        "--expected-predecessor", "1.0.2",
        "--npm-tag", "latest"
      ], { encoding: "utf8" });
      expect(JSON.parse(output)).toEqual({
        npmTag: "latest",
        currentVersion,
        targetVersion: "1.0.3",
        expectedPredecessor: "1.0.2"
      });
    }

    const rejected = spawnSync(process.execPath, [
      policyScript,
      "verify-channel",
      "--current-version", "1.0.4",
      "--target-version", "1.0.3",
      "--expected-predecessor", "1.0.2",
      "--npm-tag", "latest"
    ], { encoding: "utf8" });
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toContain("refusing to move npm dist-tag latest from unexpected 1.0.4 to 1.0.3");
  });
});
