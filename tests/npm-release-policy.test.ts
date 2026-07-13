import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

describe("npm release policy", () => {
  const roots: string[] = [];
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const policyScript = join(repoRoot, "scripts", "npm-release-policy.mjs");
  const releaseCommit = "fc66d27b6ab9f6a1eb8282d289ef63407cd96982";

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

  it("accepts an absent npm gitHead only with exact v1.0.4 provenance and recovery-dispatch proof", () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-npm-provenance-fallback-"));
    roots.push(root);
    const localPath = join(root, "pack.json");
    const remotePath = join(root, "remote.json");
    const provenancePath = join(root, "verified-provenance.json");
    const recoveryProofPath = join(root, "recovery-dispatch-proof.json");
    const integrity = `sha512-${Buffer.from("reviewed-v1.0.4-tarball").toString("base64")}`;
    writeFileSync(localPath, JSON.stringify([{
      version: "1.0.4",
      integrity,
      shasum: "1".repeat(40)
    }]));
    writeFileSync(remotePath, JSON.stringify({
      version: "1.0.4",
      "dist.integrity": integrity,
      "dist.shasum": "1".repeat(40)
    }));
    writeFileSync(provenancePath, JSON.stringify({
      package: "neondiff",
      version: "1.0.4",
      integrity,
      sha512: Buffer.from(integrity.slice("sha512-".length), "base64").toString("hex"),
      repository: "electricsheephq/evaos-code-review-bot-neondiff",
      workflow: ".github/workflows/publish-npm.yml",
      tag: "v1.0.4",
      commit: releaseCommit
    }));

    const verifyPackArgs = [
      policyScript, "verify-pack",
      "--local-pack", localPath,
      "--remote-metadata", remotePath,
      "--expected-version", "1.0.4",
      "--expected-git-head", releaseCommit,
      "--verified-provenance", provenancePath,
      "--expected-package", "neondiff",
      "--expected-repository", "electricsheephq/evaos-code-review-bot-neondiff",
      "--expected-workflow", ".github/workflows/publish-npm.yml",
      "--expected-tag", "v1.0.4"
    ];
    const unbound = spawnSync(process.execPath, verifyPackArgs, { encoding: "utf8" });
    expect(unbound.status).not.toBe(0);
    expect(unbound.stderr).toContain("protected-main recovery dispatch proof");

    const mainSha = "a".repeat(40);
    const dispatch = spawnSync(process.execPath, [
      policyScript, "verify-recovery-dispatch",
      "--event-name", "workflow_dispatch",
      "--github-ref", "refs/heads/main",
      "--workflow-ref", "electricsheephq/evaos-code-review-bot-neondiff/.github/workflows/publish-npm.yml@refs/heads/main",
      "--workflow-sha", mainSha,
      "--github-sha", mainSha,
      "--main-sha", mainSha,
      "--tag", "v1.0.4",
      "--tag-commit", releaseCommit,
      "--package-version", "1.0.4",
      "--provenance-recovery", "true",
      "--release-valid", "true",
      "--package-exists", "true",
      "--proof-output", recoveryProofPath
    ], { encoding: "utf8" });
    expect(dispatch.status, dispatch.stderr).toBe(0);

    const result = spawnSync(process.execPath, [
      ...verifyPackArgs,
      "--recovery-proof", recoveryProofPath
    ], { encoding: "utf8" });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      version: "1.0.4",
      sourceIdentity: "verified_provenance_fallback"
    });

    const exactProof = JSON.parse(readFileSync(recoveryProofPath, "utf8"));
    for (const [field, value] of [
      ["workflowSha", "b".repeat(40)],
      ["mainSha", "b".repeat(40)],
      ["tag", "v1.0.5"],
      ["tagCommit", "b".repeat(40)],
      ["packageVersion", "1.0.5"],
      ["provenanceRecovery", false],
      ["releaseValid", false],
      ["packageExists", false]
    ] as const) {
      writeFileSync(recoveryProofPath, JSON.stringify({ ...exactProof, [field]: value }));
      const rejected = spawnSync(process.execPath, [
        ...verifyPackArgs,
        "--recovery-proof", recoveryProofPath
      ], { encoding: "utf8" });
      expect(rejected.status, field).not.toBe(0);
      expect(rejected.stderr, field).toContain("recovery dispatch proof does not match");
    }
    writeFileSync(recoveryProofPath, "not-json");
    const malformedProof = spawnSync(process.execPath, [
      ...verifyPackArgs,
      "--recovery-proof", recoveryProofPath
    ], { encoding: "utf8" });
    expect(malformedProof.status).not.toBe(0);
    expect(malformedProof.stderr).toContain("recovery dispatch proof is not valid JSON");
  });

  it("rejects malformed, mismatched, or under-bound provenance for an absent gitHead", () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-npm-provenance-rejections-"));
    roots.push(root);
    const localPath = join(root, "pack.json");
    const remotePath = join(root, "remote.json");
    const provenancePath = join(root, "verified-provenance.json");
    const recoveryProofPath = join(root, "recovery-dispatch-proof.json");
    const integrity = `sha512-${Buffer.from("reviewed-v1.0.4-tarball").toString("base64")}`;
    const exactProvenance = {
      package: "neondiff",
      version: "1.0.4",
      integrity,
      sha512: Buffer.from(integrity.slice("sha512-".length), "base64").toString("hex"),
      repository: "electricsheephq/evaos-code-review-bot-neondiff",
      workflow: ".github/workflows/publish-npm.yml",
      tag: "v1.0.4",
      commit: releaseCommit
    };
    writeFileSync(localPath, JSON.stringify([{
      version: "1.0.4",
      integrity,
      shasum: "1".repeat(40)
    }]));
    writeFileSync(remotePath, JSON.stringify({
      version: "1.0.4",
      "dist.integrity": integrity,
      "dist.shasum": "1".repeat(40)
    }));
    const mainSha = "a".repeat(40);
    execFileSync(process.execPath, [
      policyScript, "verify-recovery-dispatch",
      "--event-name", "workflow_dispatch",
      "--github-ref", "refs/heads/main",
      "--workflow-ref", "electricsheephq/evaos-code-review-bot-neondiff/.github/workflows/publish-npm.yml@refs/heads/main",
      "--workflow-sha", mainSha,
      "--github-sha", mainSha,
      "--main-sha", mainSha,
      "--tag", "v1.0.4",
      "--tag-commit", releaseCommit,
      "--package-version", "1.0.4",
      "--provenance-recovery", "true",
      "--release-valid", "true",
      "--package-exists", "true",
      "--proof-output", recoveryProofPath
    ]);

    const run = () => spawnSync(process.execPath, [
      policyScript, "verify-pack",
      "--local-pack", localPath,
      "--remote-metadata", remotePath,
      "--expected-version", "1.0.4",
      "--expected-git-head", releaseCommit,
      "--verified-provenance", provenancePath,
      "--expected-package", "neondiff",
      "--expected-repository", "electricsheephq/evaos-code-review-bot-neondiff",
      "--expected-workflow", ".github/workflows/publish-npm.yml",
      "--expected-tag", "v1.0.4",
      "--recovery-proof", recoveryProofPath
    ], { encoding: "utf8" });

    for (const [field, value] of [
      ["package", "other"],
      ["version", "1.0.5"],
      ["integrity", "sha512-other"],
      ["sha512", "00"],
      ["repository", "other/repo"],
      ["workflow", ".github/workflows/other.yml"],
      ["tag", "v1.0.5"],
      ["commit", "2".repeat(40)]
    ] as const) {
      writeFileSync(provenancePath, JSON.stringify({ ...exactProvenance, [field]: value }));
      const result = run();
      expect(result.status, field).not.toBe(0);
      expect(result.stderr, field).toContain("verified npm provenance does not match the reviewed release");
    }

    writeFileSync(provenancePath, "not-json");
    const malformed = run();
    expect(malformed.status).not.toBe(0);
    expect(malformed.stderr).toContain("verified npm provenance is not valid JSON");
  });

  it("rejects every present malformed or mismatched gitHead despite exact provenance", () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-npm-present-git-head-"));
    roots.push(root);
    const localPath = join(root, "pack.json");
    const remotePath = join(root, "remote.json");
    const provenancePath = join(root, "verified-provenance.json");
    const integrity = `sha512-${Buffer.from("reviewed-v1.0.4-tarball").toString("base64")}`;
    writeFileSync(localPath, JSON.stringify([{ version: "1.0.4", integrity, shasum: "1".repeat(40) }]));
    writeFileSync(provenancePath, JSON.stringify({
      package: "neondiff", version: "1.0.4", integrity,
      sha512: Buffer.from(integrity.slice("sha512-".length), "base64").toString("hex"),
      repository: "electricsheephq/evaos-code-review-bot-neondiff",
      workflow: ".github/workflows/publish-npm.yml", tag: "v1.0.4", commit: releaseCommit
    }));

    for (const gitHead of [null, "", "   ", [], {}, "2".repeat(40)]) {
      writeFileSync(remotePath, JSON.stringify({
        version: "1.0.4",
        "dist.integrity": integrity,
        "dist.shasum": "1".repeat(40),
        gitHead
      }));
      const result = spawnSync(process.execPath, [
        policyScript, "verify-pack",
        "--local-pack", localPath,
        "--remote-metadata", remotePath,
        "--expected-version", "1.0.4",
        "--expected-git-head", releaseCommit,
        "--verified-provenance", provenancePath,
        "--expected-package", "neondiff",
        "--expected-repository", "electricsheephq/evaos-code-review-bot-neondiff",
        "--expected-workflow", ".github/workflows/publish-npm.yml",
        "--expected-tag", "v1.0.4"
      ], { encoding: "utf8" });
      expect(result.status, JSON.stringify(gitHead)).not.toBe(0);
      expect(result.stderr).toMatch(/npm gitHead (?:is malformed|does not match)/);
    }
  });

  it("scopes protected-main provenance recovery to the exact existing v1.0.4 release", () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-recovery-dispatch-proof-"));
    roots.push(root);
    const proofPath = join(root, "proof.json");
    const mainSha = "a".repeat(40);
    const exactArgs = [
      policyScript, "verify-recovery-dispatch",
      "--event-name", "workflow_dispatch",
      "--github-ref", "refs/heads/main",
      "--workflow-ref", "electricsheephq/evaos-code-review-bot-neondiff/.github/workflows/publish-npm.yml@refs/heads/main",
      "--workflow-sha", mainSha,
      "--github-sha", mainSha,
      "--main-sha", mainSha,
      "--tag", "v1.0.4",
      "--tag-commit", releaseCommit,
      "--package-version", "1.0.4",
      "--provenance-recovery", "true",
      "--release-valid", "true",
      "--package-exists", "true",
      "--proof-output", proofPath
    ];
    const accepted = spawnSync(process.execPath, exactArgs, { encoding: "utf8" });
    expect(accepted.status).toBe(0);
    expect(JSON.parse(readFileSync(proofPath, "utf8"))).toMatchObject({
      eventName: "workflow_dispatch",
      workflowSha: mainSha,
      mainSha,
      tag: "v1.0.4",
      tagCommit: releaseCommit,
      packageVersion: "1.0.4",
      provenanceRecovery: true,
      releaseValid: true,
      packageExists: true
    });

    const mutations: Array<[string, string]> = [
      ["--event-name", "release"],
      ["--github-ref", "refs/tags/v1.0.4"],
      ["--workflow-ref", "other"],
      ["--workflow-sha", "b".repeat(40)],
      ["--github-sha", "b".repeat(40)],
      ["--main-sha", "b".repeat(40)],
      ["--tag", "v1.0.5"],
      ["--tag-commit", "b".repeat(40)],
      ["--package-version", "1.0.5"],
      ["--provenance-recovery", "false"],
      ["--release-valid", "false"],
      ["--package-exists", "false"]
    ];
    for (const [flag, value] of mutations) {
      rmSync(proofPath, { force: true });
      const args = [...exactArgs];
      args[args.indexOf(flag) + 1] = value;
      const rejected = spawnSync(process.execPath, args, { encoding: "utf8" });
      expect(rejected.status, flag).not.toBe(0);
    }
  });

  it("requires exact predecessor and quarantine ownership before recovery promotion", () => {
    const run = (latestVersion: string, quarantineVersion: string) => spawnSync(process.execPath, [
      policyScript, "verify-recovery-channels",
      "--latest-version", latestVersion,
      "--quarantine-version", quarantineVersion,
      "--target-version", "1.0.4",
      "--expected-predecessor", "1.0.3"
    ], { encoding: "utf8" });

    expect(JSON.parse(run("1.0.3", "1.0.4").stdout)).toMatchObject({ action: "promote" });
    expect(JSON.parse(run("1.0.4", "1.0.4").stdout)).toMatchObject({ action: "confirm_and_cleanup" });
    expect(JSON.parse(run("1.0.4", "").stdout)).toMatchObject({ action: "confirmed" });
    for (const [latest, quarantine] of [
      ["1.0.3", ""],
      ["1.0.3", "9.9.9"],
      ["1.0.4", "9.9.9"],
      ["9.9.9", "1.0.4"]
    ]) {
      expect(run(latest, quarantine).status, `${latest}/${quarantine}`).not.toBe(0);
    }
  });

  it("runs the activation-aware public release gate after packing and before npm publication", () => {
    const workflow = readFileSync(join(repoRoot, ".github", "workflows", "publish-npm.yml"), "utf8");
    const packIndex = workflow.indexOf('npm pack --json --pack-destination "$PACK_DIR" > pack.json');
    const readinessIndex = workflow.indexOf("node scripts/check-public-release-ready.mjs");
    const publishIndex = workflow.indexOf('npm publish "$PACK_TARBALL" --provenance');

    expect(packIndex).toBeGreaterThan(-1);
    expect(readinessIndex).toBeGreaterThan(packIndex);
    expect(publishIndex).toBeGreaterThan(readinessIndex);
    expect(workflow.match(/node scripts\/check-public-release-ready\.mjs/g)).toHaveLength(2);
    expect(workflow).not.toContain('tar -xzf "$PACK_TARBALL" -C "$STAGING_ROOT"');
    expect(workflow).not.toContain('npm pack "$STAGING_ROOT/package"');
    expect(workflow).toContain("verify-npm-provenance.mjs");
    expect(workflow).toContain('npm audit signatures --prefix "$SIGNATURE_VERIFY_ROOT" --json');
    expect(workflow).not.toMatch(/^\s*npm publish --provenance/m);
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
