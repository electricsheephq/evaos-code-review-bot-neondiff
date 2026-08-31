#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
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
const existingPackageRecovery = args.get("existing-package-recovery") ?? "false";
const prepublication = args.get("prepublication") ?? "false";
const candidateLedgerArg = args.get("candidate-ledger");
if (!manifestPath || !expectedVersion || !candidateHead || !releaseHead || !packPath || !tarballPath) {
  fail("required arguments: --manifest --expected-version --candidate-head --release-head --pack --tarball");
}
if (!/^[a-f0-9]{40}$/.test(candidateHead)) fail("candidate head must be a full lowercase Git SHA");
if (!/^[a-f0-9]{40}$/.test(releaseHead)) fail("release head must be a full lowercase Git SHA");
if (existingPackageRecovery !== "true" && existingPackageRecovery !== "false") {
  fail("--existing-package-recovery must be true or false");
}
if (prepublication !== "true" && prepublication !== "false") fail("--prepublication must be true or false");
if (prepublication === "true" && existingPackageRecovery === "true") fail("prepublication cannot be combined with existing-package recovery");

const cwd = process.cwd();
const candidateLedgerPath = candidateLedgerArg ? resolveCandidateLedgerPath(cwd, candidateLedgerArg, expectedVersion) : undefined;
if (prepublication === "true" && !candidateLedgerPath) fail("--candidate-ledger is required in prepublication mode");
const candidateMode = candidateLedgerPath !== undefined;
const readinessManifestPath = candidateLedgerPath ?? manifestPath;
const status = readPublicReleaseManifestStatus({
  cwd,
  manifestPath: readinessManifestPath,
  expectedVersion,
  allowStaleActivationProof: existingPackageRecovery === "true"
});
const prepublicationReady = prepublication === "true" && candidateMode && status.npmPublication.ok === false && status.npmPublication.requiredForThisRelease === true && status.npmPublication.state === "candidate_pending_publication" && status.npmPublication.candidateReadyForPublication === true && status.releaseLevelGate.ok && status.docs.ok && status.licenseApi.ok && status.updateChannels.ok;
if ((!status.ok && !prepublicationReady) || (prepublication === "true" && !prepublicationReady)) fail("public release manifest is blocked; run release-status locally for redacted gate details");
const actualHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
if (actualHead !== releaseHead) fail("release head does not match the checked-out commit");

const manifest = readJson(resolve(cwd, readinessManifestPath), candidateMode ? "candidate ledger" : "public release manifest");
const recordedCandidateHead = candidateMode
  ? manifest?.candidateSourceSha
  : manifest?.source?.candidateHeadBeforeReleaseMetadata;
if (recordedCandidateHead !== candidateHead) {
  fail(`${candidateMode ? "candidate ledger" : "manifest"} candidate head does not match --candidate-head`);
}
let activationProofPath;
let installedCandidate;
if (candidateMode) {
  activationProofPath = manifest?.licenseApi?.activationProofPath;
  if (typeof activationProofPath !== "string") fail("candidate ledger activationProofPath is missing");
  const resolvedCandidateProofPath = resolveCandidateActivationProofPath(cwd, activationProofPath, expectedVersion, candidateHead);
  const activationProof = readJson(resolvedCandidateProofPath, "candidate activation proof");
  if (activationProof?.evidenceKind !== "mandatory_activation_no_bypass") fail("candidate activation proof evidenceKind is invalid");
  if (activationProof?.releaseVersion !== expectedVersion) fail("candidate activation proof releaseVersion does not match expected version");
  installedCandidate = activationProof?.installedCandidate;
} else {
  activationProofPath = manifest?.licenseApi?.activationProofPath;
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
  installedCandidate = activationProof?.installedCandidate;
}

const packPayload = readJson(resolve(cwd, packPath), "npm pack output");
if (!Array.isArray(packPayload) || packPayload.length !== 1) fail("npm pack output must contain exactly one package");
const pack = packPayload[0];
const packageVersion = expectedVersion.slice(1);
if (pack?.name !== "neondiff" || pack?.version !== packageVersion) {
  fail(`npm pack identity must be neondiff@${packageVersion}`);
}
const proofLabel = candidateMode ? "candidate activation proof" : "activation proof";
if (installedCandidate?.sourceHead !== candidateHead) fail(`${proofLabel} source head does not match candidate head`);
if (installedCandidate?.packageVersion !== packageVersion || installedCandidate?.binaryVersion !== packageVersion) {
  fail(`${proofLabel} installed package identity does not match the release version`);
}
if (installedCandidate?.packShasum !== pack?.shasum) fail(`${proofLabel} pack shasum does not match npm pack`);
if (installedCandidate?.packIntegrity !== pack?.integrity) fail(`${proofLabel} pack integrity does not match npm pack`);
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
  existingPackageRecovery: existingPackageRecovery === "true",
  prepublication: prepublication === "true",
  publicReady: prepublication !== "true",
  packShasum: pack.shasum,
  packIntegrity: pack.integrity,
  activationProofPath
})}\n`);

function resolveCandidateLedgerPath(cwd, candidatePath, expectedVersion) {
  if (expectedVersion !== "v1.0.5") fail("candidate ledger mode is scoped only to v1.0.5");
  const expectedPath = `docs/release-candidates/${expectedVersion}.json`;
  if (candidatePath !== expectedPath || isAbsolute(candidatePath)) {
    fail("candidate ledger path must be the exact relative v1.0.5 release-candidate ledger");
  }
  try {
    const candidateRoot = realpathSync(resolve(cwd, "docs", "release-candidates"));
    const resolvedCandidatePath = realpathSync(resolve(cwd, candidatePath));
    const candidateRelativePath = relative(candidateRoot, resolvedCandidatePath);
    if (candidateRelativePath !== `${expectedVersion}.json` || candidateRelativePath.startsWith("..") || isAbsolute(candidateRelativePath)) {
      fail("candidate ledger path must stay within docs/release-candidates");
    }
  } catch {
    fail("candidate ledger must resolve within docs/release-candidates");
  }
  return candidatePath;
}

function resolveCandidateActivationProofPath(cwd, proofPath, expectedVersion, candidateHead) {
  const expectedPath = `docs/evidence/${expectedVersion}/mandatory-activation-${candidateHead}.json`;
  if (proofPath !== expectedPath || isAbsolute(proofPath)) {
    fail("candidate activation proof path must be the exact v1.0.5 evidence path");
  }
  try {
    const evidenceRoot = realpathSync(resolve(cwd, "docs", "evidence"));
    const resolvedProofPath = resolve(cwd, proofPath);
    const lexicalRelativePath = relative(evidenceRoot, resolvedProofPath);
    if (lexicalRelativePath.startsWith("..") || isAbsolute(lexicalRelativePath)) {
      fail("candidate activation proof path must stay within docs/evidence");
    }
    if (!existsSync(resolvedProofPath)) fail("candidate activation proof is missing");
    const realProofPath = realpathSync(resolvedProofPath);
    const realRelativePath = relative(evidenceRoot, realProofPath);
    if (realRelativePath.startsWith("..") || isAbsolute(realRelativePath)) {
      fail("candidate activation proof path must stay within docs/evidence");
    }
    return realProofPath;
  } catch {
    fail("candidate activation proof must resolve within docs/evidence");
  }
}
