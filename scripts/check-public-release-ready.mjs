#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { readPublicReleaseManifestStatus } from "../dist/src/release-status.js";

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function readArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) fail("expected --name value arguments");
    args.set(key.slice(2), value);
  }
  return args;
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    fail(`${label} must be valid JSON`);
  }
}

const args = readArgs(process.argv.slice(2));
const manifestPath = args.get("manifest");
const expectedVersion = args.get("expected-version");
const candidateHead = args.get("candidate-head");
const releaseHead = args.get("release-head");
const packPath = args.get("pack");
const tarballPath = args.get("tarball");
if (!manifestPath || !expectedVersion || !candidateHead || !releaseHead || !packPath || !tarballPath) {
  fail("required arguments: --manifest --expected-version --candidate-head --release-head --pack --tarball");
}
if (!/^[a-f0-9]{40}$/.test(candidateHead)) fail("candidate head must be a full lowercase Git SHA");
if (!/^[a-f0-9]{40}$/.test(releaseHead)) fail("release head must be a full lowercase Git SHA");

const cwd = process.cwd();
const status = readPublicReleaseManifestStatus({
  cwd,
  manifestPath,
  expectedVersion
});
if (!status.ok) fail("public release manifest is blocked; run release-status locally for redacted gate details");
const actualHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
if (actualHead !== releaseHead) fail("release head does not match the checked-out commit");

const manifest = readJson(resolve(cwd, manifestPath), "public release manifest");
if (manifest?.source?.candidateHeadBeforeReleaseMetadata !== candidateHead) {
  fail("manifest candidate head does not match --candidate-head");
}
const activationProofPath = manifest?.licenseApi?.activationProofPath;
if (typeof activationProofPath !== "string") fail("manifest activationProofPath is missing");
if (isAbsolute(activationProofPath)) fail("activation proof path must be relative");
let evidenceRoot;
let resolvedActivationProofPath;
try {
  evidenceRoot = realpathSync(resolve(cwd, "docs", "evidence"));
  resolvedActivationProofPath = realpathSync(resolve(cwd, activationProofPath));
} catch {
  fail("activation proof must resolve within docs/evidence");
}
const evidenceRelativePath = relative(evidenceRoot, resolvedActivationProofPath);
if (evidenceRelativePath.startsWith("..") || isAbsolute(evidenceRelativePath)) {
  fail("activation proof path must stay within docs/evidence");
}
const activationProof = readJson(resolvedActivationProofPath, "activation proof");
const installedCandidate = activationProof?.installedCandidate;
if (installedCandidate?.sourceHead !== candidateHead) fail("activation proof source head does not match candidate head");

const packPayload = readJson(resolve(cwd, packPath), "npm pack output");
if (!Array.isArray(packPayload) || packPayload.length !== 1) fail("npm pack output must contain exactly one package");
const pack = packPayload[0];
const packageVersion = expectedVersion.slice(1);
if (pack?.name !== "neondiff" || pack?.version !== packageVersion) {
  fail(`npm pack identity must be neondiff@${packageVersion}`);
}
if (installedCandidate?.packageVersion !== packageVersion || installedCandidate?.binaryVersion !== packageVersion) {
  fail("activation proof installed package identity does not match the release version");
}
if (installedCandidate?.packShasum !== pack?.shasum) fail("activation proof pack shasum does not match npm pack");
if (installedCandidate?.packIntegrity !== pack?.integrity) fail("activation proof pack integrity does not match npm pack");
const tarball = readFileSync(resolve(cwd, tarballPath));
const tarballShasum = createHash("sha1").update(tarball).digest("hex");
const tarballIntegrity = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
if (tarballShasum !== pack?.shasum || tarballIntegrity !== pack?.integrity) {
  fail("materialized tarball does not match npm pack metadata");
}

process.stdout.write(`${JSON.stringify({
  ok: true,
  version: expectedVersion,
  candidateHead,
  releaseHead,
  packShasum: pack.shasum,
  packIntegrity: pack.integrity,
  activationProofPath
})}\n`);
