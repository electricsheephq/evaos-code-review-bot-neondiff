import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdtempSync, openSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { guardClassicZipArchive } from "./desktop-extracted-app-tree-proof.mjs";

export const DESKTOP_ARTIFACT_SOURCE_PREDICATE_TYPE = "https://neondiff.com/attestations/desktop-artifact-source-promotion/v1";
export const DESKTOP_ARTIFACT_SOURCE_CLAIM_CLASS = "neondiff.desktop.artifact-source-promotion.v1";

const REPOSITORY = "electricsheephq/evaos-code-review-bot-neondiff";
const SIGNER_WORKFLOW = `${REPOSITORY}/.github/workflows/desktop-accepted-release-packet.yml`;
const SOURCE_REF = "refs/heads/main";
const TEAM_ID = "TC6MS3T6NN";
const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const RELEASE_TAG = /^v1\.1\.0(?:-(?:beta\.[1-9][0-9]{0,3}|rc\.[1-9][0-9]{0,15}))?$/;
const MAX_EVIDENCE_BYTES = 4 * 1024 * 1024;
const INPUT_FIELDS = ["artifactPath", "bundlePath", "tagRefPath", "tagObjectPath", "releasePath", "outputDirectory"];
const PREDICATE_FIELDS = ["schemaVersion", "claimClass", "repository", "signerWorkflow", "workflowSourceRef", "workflowSourceSHA", "releaseTag", "artifactSourceSHA", "acceptedPacketSHA256", "developerIDTeamID"];
const STATEMENT_FIELDS = ["_type", "subject", "predicateType", "predicate"];
const STRICT_JSON = String.raw`
import json,sys
def pairs(values):
    result = {}
    for key,value in values:
        if key in result: raise ValueError("duplicate JSON key")
        result[key] = value
    return result
value = json.loads(sys.stdin.buffer.read(), object_pairs_hook=pairs)
sys.stdout.write(json.dumps(value, separators=(",", ":")))
`;

function fail(message) { throw new Error(message); }
function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}
function exactInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== INPUT_FIELDS.length || INPUT_FIELDS.some((field) => !Object.hasOwn(input, field) || typeof input[field] !== "string" || !input[field])) fail("artifact attestation inputs are malformed");
  return input;
}
function boundedBytes(input, label) {
  const path = resolve(input); let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.size < 1n || before.size > BigInt(MAX_EVIDENCE_BYTES)) fail(`${label} must be a bounded regular file`);
    const bytes = readFileSync(descriptor), after = fstatSync(descriptor, { bigint: true });
    if (!after.isFile() || !sameFile(before, after) || BigInt(bytes.length) !== before.size) fail(`${label} changed during read`);
    return { path, bytes };
  } catch (error) {
    if (error?.code === "ELOOP") fail(`${label} must not be symlinked`);
    throw error;
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}
function strictJSON(bytes, label) {
  const result = spawnSync("/usr/bin/python3", ["-I", "-c", STRICT_JSON], { input: bytes, encoding: "utf8", maxBuffer: MAX_EVIDENCE_BYTES });
  try { if (result.error || result.signal || result.status !== 0) fail(`${label} is malformed`); return JSON.parse(result.stdout); } catch { fail(`${label} is malformed`); }
}
function exactArtifact(path) {
  const resolved = resolve(path), before = lstatSync(resolved, { bigint: true });
  if (!before.isFile()) fail("artifact must be a regular file");
  const guarded = guardClassicZipArchive({ artifactPath: resolved }), after = lstatSync(resolved, { bigint: true });
  if (!after.isFile() || !sameFile(before, after) || BigInt(guarded.artifactBytes.length) !== before.size) fail("artifact changed during read");
  return { path: resolved, name: basename(resolved), bytes: guarded.artifactBytes, digest: guarded.artifactSHA256 };
}
function canonicalRelease(tagRefPath, tagObjectPath, releasePath, artifact, releaseTag) {
  const tagRef = strictJSON(boundedBytes(tagRefPath, "tag-ref metadata").bytes, "tag-ref metadata");
  const tagObject = strictJSON(boundedBytes(tagObjectPath, "tag-object metadata").bytes, "tag-object metadata");
  const release = strictJSON(boundedBytes(releasePath, "release metadata").bytes, "release metadata");
  const tagObjectSHA = tagRef?.object?.sha, beta = /^v1\.1\.0-beta\./.test(releaseTag), version = releaseTag.slice(1); let sourceSHA;
  if (tagRef?.ref !== `refs/tags/${releaseTag}` || !SHA1.test(tagObjectSHA ?? "")) fail("release tag metadata is not canonical");
  if (tagRef.object.type === "tag") { sourceSHA = tagObject?.object?.sha; if (tagObject?.sha !== tagObjectSHA || tagObject?.tag !== releaseTag || tagObject?.object?.type !== "commit" || !SHA1.test(sourceSHA ?? "") || sourceSHA === tagObjectSHA) fail("annotated tag metadata is not canonical"); }
  else if (tagRef.object.type === "commit" && beta) { sourceSHA = tagObject?.sha; if (sourceSHA !== tagObjectSHA || !SHA1.test(sourceSHA ?? "")) fail("lightweight beta tag metadata is not canonical"); }
  else fail("release tag metadata is not canonical");
  if (release?.tag_name !== releaseTag || release?.draft !== false || release?.prerelease !== (releaseTag !== "v1.1.0") || release?.immutable !== true || !Array.isArray(release.assets)) fail("immutable product release metadata is required");
  const expectedArtifact = new RegExp(`^NeonDiff-${version.replaceAll(".", "\\.")}-build[0-9]+-macOS\\.zip$`), assets = release.assets.filter((asset) => typeof asset?.name === "string" && expectedArtifact.test(asset.name));
  if (assets.length !== 1 || artifact.name !== assets[0].name) fail("one exact accepted Mac artifact is required");
  const url = `https://github.com/${REPOSITORY}/releases/download/${releaseTag}/${artifact.name}`;
  if (assets[0].browser_download_url !== url || assets[0].digest !== `sha256:${artifact.digest}` || assets[0].size !== artifact.bytes.length) fail("immutable release artifact identity mismatch");
  return { sourceSHA, releaseTag };
}
function canonicalContext() {
  const workflowSHA = process.env.GITHUB_SHA;
  if (process.env.GITHUB_ACTIONS !== "true" || process.env.GITHUB_REPOSITORY !== REPOSITORY || process.env.GITHUB_REF !== SOURCE_REF || !SHA1.test(workflowSHA ?? "") || process.env.GITHUB_WORKFLOW_REF !== `${SIGNER_WORKFLOW}@${SOURCE_REF}` || process.env.RUNNER_ENVIRONMENT !== "github-hosted") fail("canonical GitHub-hosted workflow identity is required");
  return { workflowSHA };
}
function exactPredicate(predicate, sourceSHA, workflowSHA, releaseTag) {
  if (!predicate || typeof predicate !== "object" || Array.isArray(predicate) || Object.keys(predicate).length !== PREDICATE_FIELDS.length || PREDICATE_FIELDS.some((field) => !Object.hasOwn(predicate, field))) fail("artifact source promotion predicate is not canonical");
  const expected = { schemaVersion: 1, claimClass: DESKTOP_ARTIFACT_SOURCE_CLAIM_CLASS, repository: REPOSITORY, signerWorkflow: SIGNER_WORKFLOW, workflowSourceRef: SOURCE_REF, workflowSourceSHA: workflowSHA, releaseTag, artifactSourceSHA: sourceSHA, developerIDTeamID: TEAM_ID };
  if (!SHA256.test(predicate.acceptedPacketSHA256 ?? "") || Object.keys(expected).some((field) => predicate[field] !== expected[field])) fail("artifact source promotion predicate is not canonical");
}
function exactStatement(statement, artifact, sourceSHA, workflowSHA, releaseTag) {
  const subject = statement?.subject;
  if (!statement || typeof statement !== "object" || Array.isArray(statement) || Object.keys(statement).length !== STATEMENT_FIELDS.length || STATEMENT_FIELDS.some((field) => !Object.hasOwn(statement, field)) || statement._type !== "https://in-toto.io/Statement/v1" || statement.predicateType !== DESKTOP_ARTIFACT_SOURCE_PREDICATE_TYPE || !Array.isArray(subject) || subject.length !== 1 || !subject[0] || Object.keys(subject[0]).length !== 2 || subject[0].name !== artifact.name || !subject[0].digest || Object.keys(subject[0].digest).length !== 1 || subject[0].digest.sha256 !== artifact.digest || !SHA256.test(subject[0].digest.sha256)) fail("attestation does not cover the exact accepted Mac artifact");
  exactPredicate(statement.predicate, sourceSHA, workflowSHA, releaseTag);
}
function exactBundle(bytes, artifact, sourceSHA, workflowSHA, releaseTag) {
  const bundle = strictJSON(bytes, "attestation bundle"), payload = bundle?.dsseEnvelope?.payload, signatures = bundle?.dsseEnvelope?.signatures;
  if (bundle?.mediaType !== "application/vnd.dev.sigstore.bundle.v0.3+json" || !bundle.verificationMaterial || typeof bundle.verificationMaterial !== "object" || Object.keys(bundle.verificationMaterial).length < 1 || bundle?.dsseEnvelope?.payloadType !== "application/vnd.in-toto+json" || typeof payload !== "string" || !payload || !Array.isArray(signatures) || signatures.length < 1 || signatures.some((item) => typeof item?.sig !== "string" || !item.sig || Buffer.from(item.sig, "base64").toString("base64") !== item.sig)) fail("attestation bundle is malformed");
  const decoded = Buffer.from(payload, "base64"); if (!decoded.length || decoded.toString("base64") !== payload) fail("attestation bundle is malformed");
  const statement = strictJSON(decoded, "attestation statement"); exactStatement(statement, artifact, sourceSHA, workflowSHA, releaseTag); return statement;
}
function writePrivate(path, bytes) {
  let descriptor;
  try { descriptor = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600); writeFileSync(descriptor, bytes); fsyncSync(descriptor); const stored = fstatSync(descriptor); if (!stored.isFile() || stored.size !== bytes.length) fail("private verification input was not written exactly"); }
  finally { if (descriptor !== undefined) closeSync(descriptor); }
}
function cryptographicallyVerify(artifact, bundle, sourceSHA, workflowSHA, releaseTag) {
  const root = mkdtempSync(join(tmpdir(), "neondiff-artifact-attestation-verification-")), artifactPath = join(root, artifact.name), bundlePath = join(root, "attestation.json"); let result;
  try {
    writePrivate(artifactPath, artifact.bytes); writePrivate(bundlePath, bundle.bytes);
    result = spawnSync("gh", ["attestation", "verify", artifactPath, "--bundle", bundlePath, "--repo", REPOSITORY, "--signer-workflow", SIGNER_WORKFLOW, "--predicate-type", DESKTOP_ARTIFACT_SOURCE_PREDICATE_TYPE, "--source-ref", SOURCE_REF, "--source-digest", workflowSHA, "--deny-self-hosted-runners", "--format", "json"], { encoding: "utf8", env: { ...process.env, GH_PAGER: "cat", PAGER: "cat", NO_COLOR: "1" }, maxBuffer: MAX_EVIDENCE_BYTES, timeout: 30_000 });
  } finally { rmSync(root, { recursive: true, force: true }); }
  if (result.error || result.signal || result.status !== 0) fail("canonical artifact attestation verification failed");
  let verification; try { verification = strictJSON(Buffer.from(result.stdout, "utf8"), "canonical artifact attestation verification"); } catch { fail("canonical artifact attestation verification failed"); }
  if (!Array.isArray(verification) || verification.length !== 1) fail("canonical artifact attestation verification failed");
  const statement = verification[0]?.verificationResult?.statement; exactStatement(statement, artifact, sourceSHA, workflowSHA, releaseTag); return statement;
}
function retainBundle(directoryPath, bytes) {
  const directory = resolve(directoryPath), digest = sha256(bytes), fileName = `${digest}.artifact-source-attestation.json`, path = join(directory, fileName); let directoryDescriptor, outputDescriptor, created = false;
  try {
    directoryDescriptor = openSync(directory, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0)); if (!fstatSync(directoryDescriptor).isDirectory()) fail("attestation output directory is invalid");
    outputDescriptor = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600); created = true; writeFileSync(outputDescriptor, bytes); fsyncSync(outputDescriptor); const stored = fstatSync(outputDescriptor); if (!stored.isFile() || stored.size !== bytes.length) fail("retained attestation was not written exactly");
  } catch (error) {
    if (created) { try { unlinkSync(path); } catch { /* best-effort cleanup of this invocation's new file */ } }
    throw error;
  } finally { if (outputDescriptor !== undefined) closeSync(outputDescriptor); if (directoryDescriptor !== undefined) closeSync(directoryDescriptor); }
  return { bundleSHA256: digest, bundleFileName: fileName };
}

export function verifyAndRetainDesktopArtifactSourceAttestation(input, releaseTag = "v1.1.0") {
  if (typeof releaseTag !== "string" || !RELEASE_TAG.test(releaseTag)) fail("release tag selector is invalid");
  const values = exactInput(input), context = canonicalContext(), artifact = exactArtifact(values.artifactPath), release = canonicalRelease(values.tagRefPath, values.tagObjectPath, values.releasePath, artifact, releaseTag), bundle = boundedBytes(values.bundlePath, "attestation bundle");
  const statement = exactBundle(bundle.bytes, artifact, release.sourceSHA, context.workflowSHA, release.releaseTag), verifiedStatement = cryptographicallyVerify(artifact, bundle, release.sourceSHA, context.workflowSHA, release.releaseTag); if (!isDeepStrictEqual(statement, verifiedStatement)) fail("cryptographically verified attestation statement mismatch"); const retained = retainBundle(values.outputDirectory, bundle.bytes);
  return Object.freeze({ verified: true, artifactName: artifact.name, artifactSHA256: artifact.digest, artifactByteLength: artifact.bytes.length, artifactSourceSHA: release.sourceSHA, workflowSourceSHA: context.workflowSHA, acceptedPacketSHA256: statement.predicate.acceptedPacketSHA256, predicateType: DESKTOP_ARTIFACT_SOURCE_PREDICATE_TYPE, ...retained });
}
