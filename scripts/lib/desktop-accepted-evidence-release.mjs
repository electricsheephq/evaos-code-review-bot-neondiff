import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parseAcceptedDesktopReleasePacket } from "./desktop-accepted-release-packet.mjs";

export const DESKTOP_ACCEPTED_EVIDENCE_REPOSITORY = "electricsheephq/evaos-code-review-bot-neondiff";
export const DESKTOP_ACCEPTED_EVIDENCE_TAG = "neondiff-accepted-packet-v1.1.0";
export const DESKTOP_ACCEPTED_EVIDENCE_RELEASE_NAME = "NeonDiff accepted packet evidence v1.1.0";

const SIGNER_WORKFLOW = `${DESKTOP_ACCEPTED_EVIDENCE_REPOSITORY}/.github/workflows/desktop-accepted-release-packet.yml`;
const SOURCE_REF = "refs/heads/main", STABLE_TAG = "v1.1.0", TEAM_ID = "TC6MS3T6NN";
const CLAIM_CLASS = "neondiff.desktop.artifact-source-promotion.v1", PREDICATE_TYPE = "https://neondiff.com/attestations/desktop-artifact-source-promotion/v1";
const SHA1 = /^[a-f0-9]{40}$/;
const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024, MAX_PACKET_BYTES = 1024 * 1024, MAX_BUNDLE_BYTES = 4 * 1024 * 1024, MAX_METADATA_BYTES = 1024 * 1024;
const INPUT_FIELDS = ["artifactPath", "packetPath", "bundlePath", "releasePath", "tagRefPath"];
const PREDICATE_FIELDS = ["schemaVersion", "claimClass", "repository", "signerWorkflow", "workflowSourceRef", "workflowSourceSHA", "releaseTag", "artifactSourceSHA", "acceptedPacketSHA256", "developerIDTeamID"];
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
function sameFile(left, right) { return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs; }
function exactObject(value, fields, label) { if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== fields.length || fields.some((field) => !Object.hasOwn(value, field))) fail(`${label} is not canonical`); }
function boundedBytes(input, label, maximum) {
  if (typeof input !== "string" || !input) fail(`${label} path is invalid`);
  const path = resolve(input); let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0));
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.size < 1n || before.size > BigInt(maximum)) fail(`${label} must be a bounded regular file`);
    const bytes = readFileSync(descriptor), after = fstatSync(descriptor, { bigint: true });
    if (!after.isFile() || !sameFile(before, after) || BigInt(bytes.length) !== before.size) fail(`${label} changed during read`);
    return { path, bytes, digest: sha256(bytes) };
  } catch (error) { if (error?.code === "ELOOP") fail(`${label} must not be symlinked`); throw error; }
  finally { if (descriptor !== undefined) closeSync(descriptor); }
}
function strictJSON(bytes, label) {
  const result = spawnSync("/usr/bin/python3", ["-I", "-c", STRICT_JSON], { input: bytes, encoding: "utf8", maxBuffer: MAX_BUNDLE_BYTES });
  try { if (result.error || result.signal || result.status !== 0) fail(`${label} is malformed`); return JSON.parse(result.stdout); } catch { fail(`${label} is malformed`); }
}
function canonicalContext() {
  if (process.env.GITHUB_ACTIONS !== "true" || process.env.GITHUB_REPOSITORY !== DESKTOP_ACCEPTED_EVIDENCE_REPOSITORY || process.env.GITHUB_REF !== SOURCE_REF || !SHA1.test(process.env.GITHUB_SHA ?? "") || process.env.GITHUB_WORKFLOW_REF !== `${SIGNER_WORKFLOW}@${SOURCE_REF}` || process.env.RUNNER_ENVIRONMENT !== "github-hosted") fail("canonical GitHub-hosted workflow identity is required");
}
function exactPacket(path, stableOnly) {
  const evidence = boundedBytes(path, "accepted packet", MAX_PACKET_BYTES), packet = parseAcceptedDesktopReleasePacket(evidence.bytes); if (packet.artifactByteLength > MAX_ARTIFACT_BYTES || stableOnly && (packet.channel !== "stable" || packet.version !== "1.1.0" || packet.tag !== STABLE_TAG)) fail("accepted packet identity is not canonical");
  if (basename(evidence.path) !== `${evidence.digest}.packet.json`) fail("accepted packet content address is not canonical"); const evidenceTag = `neondiff-accepted-packet-${packet.tag}`, evidenceReleaseName = `NeonDiff accepted packet evidence ${packet.tag}`;
  return { ...evidence, packet, name: basename(evidence.path), evidenceTag, evidenceReleaseName };
}
function exactBundle(path, accepted) {
  const packet = accepted.packet;
  const evidence = boundedBytes(path, "artifact-source attestation bundle", MAX_BUNDLE_BYTES);
  if (basename(evidence.path) !== `${evidence.digest}.artifact-source-attestation.json`) fail("artifact-source attestation content address is not canonical");
  const bundle = strictJSON(evidence.bytes, "artifact-source attestation bundle"), payload = bundle?.dsseEnvelope?.payload, signatures = bundle?.dsseEnvelope?.signatures;
  if (bundle?.mediaType !== "application/vnd.dev.sigstore.bundle.v0.3+json" || !bundle.verificationMaterial || typeof bundle.verificationMaterial !== "object" || Object.keys(bundle.verificationMaterial).length < 1 || bundle?.dsseEnvelope?.payloadType !== "application/vnd.in-toto+json" || typeof payload !== "string" || !payload || !Array.isArray(signatures) || signatures.length < 1 || signatures.some((value) => typeof value?.sig !== "string" || !value.sig || Buffer.from(value.sig, "base64").toString("base64") !== value.sig)) fail("artifact-source attestation bundle is malformed");
  const decoded = Buffer.from(payload, "base64"); if (!decoded.length || decoded.toString("base64") !== payload) fail("artifact-source attestation bundle is malformed");
  const statement = strictJSON(decoded, "artifact-source attestation statement"), subject = statement?.subject, predicate = statement?.predicate;
  exactObject(statement, ["_type", "subject", "predicateType", "predicate"], "artifact-source attestation statement"); exactObject(predicate, PREDICATE_FIELDS, "artifact-source attestation predicate");
  if (statement._type !== "https://in-toto.io/Statement/v1" || statement.predicateType !== PREDICATE_TYPE || !Array.isArray(subject) || subject.length !== 1 || subject[0]?.name !== packet.artifactName || subject[0]?.digest?.sha256 !== packet.artifactSHA256 || Object.keys(subject[0] ?? {}).length !== 2 || Object.keys(subject[0]?.digest ?? {}).length !== 1) fail("artifact-source attestation subject is not canonical");
  const expected = { schemaVersion: 1, claimClass: CLAIM_CLASS, repository: DESKTOP_ACCEPTED_EVIDENCE_REPOSITORY, signerWorkflow: SIGNER_WORKFLOW, workflowSourceRef: SOURCE_REF, releaseTag: packet.tag, artifactSourceSHA: packet.sourceSHA, acceptedPacketSHA256: accepted.digest, developerIDTeamID: TEAM_ID };
  if (!SHA1.test(predicate.workflowSourceSHA ?? "") || Object.keys(expected).some((field) => predicate[field] !== expected[field])) fail("artifact-source attestation predicate is not canonical");
  return { ...evidence, name: basename(evidence.path), statement, workflowSourceSHA: predicate.workflowSourceSHA };
}
function exactArtifact(path, packet) {
  const artifact = boundedBytes(path, "stable artifact", MAX_ARTIFACT_BYTES);
  if (basename(artifact.path) !== packet.artifactName || artifact.bytes.length !== packet.artifactByteLength || artifact.digest !== packet.artifactSHA256) fail("accepted artifact identity mismatch");
  return { ...artifact, name: basename(artifact.path) };
}
function exactRelease(releasePath, tagRefPath, accepted, retained) {
  const { packet, evidenceTag, evidenceReleaseName } = accepted;
  const release = strictJSON(boundedBytes(releasePath, "evidence release metadata", MAX_METADATA_BYTES).bytes, "evidence release metadata"), tagRef = strictJSON(boundedBytes(tagRefPath, "evidence tag metadata", MAX_METADATA_BYTES).bytes, "evidence tag metadata");
  if (tagRef?.ref !== `refs/tags/${evidenceTag}` || tagRef?.object?.type !== "commit" || tagRef?.object?.sha !== packet.sourceSHA) fail("evidence tag is not bound to the artifact source");
  if (release?.tag_name !== evidenceTag || release?.name !== evidenceReleaseName || release?.draft !== false || release?.prerelease !== true || release?.immutable !== true || release?.target_commitish !== packet.sourceSHA || release?.html_url !== `https://github.com/${DESKTOP_ACCEPTED_EVIDENCE_REPOSITORY}/releases/tag/${evidenceTag}` || !Array.isArray(release.assets) || release.assets.length !== retained.length) fail("immutable evidence release metadata is required");
  for (const evidence of retained) { const matches = release.assets.filter((asset) => asset?.name === evidence.name), url = `https://github.com/${DESKTOP_ACCEPTED_EVIDENCE_REPOSITORY}/releases/download/${evidenceTag}/${evidence.name}`; if (matches.length !== 1 || matches[0]?.digest !== `sha256:${evidence.digest}` || matches[0]?.size !== evidence.bytes.length || matches[0]?.browser_download_url !== url) fail("evidence release asset identity mismatch"); }
}
function githubVerify(paths, retained, evidenceTag) {
  const calls = [["release", "verify", evidenceTag, "--repo", DESKTOP_ACCEPTED_EVIDENCE_REPOSITORY, "--format", "json"], ["release", "verify-asset", evidenceTag, paths.packet, "--repo", DESKTOP_ACCEPTED_EVIDENCE_REPOSITORY, "--format", "json"], ["release", "verify-asset", evidenceTag, paths.bundle, "--repo", DESKTOP_ACCEPTED_EVIDENCE_REPOSITORY, "--format", "json"]];
  for (const args of calls) { const result = spawnSync("gh", args, { encoding: "utf8", env: { ...process.env, GH_PAGER: "cat", PAGER: "cat", NO_COLOR: "1" }, maxBuffer: MAX_BUNDLE_BYTES, timeout: 30_000 }); if (result.error || result.signal || result.status !== 0) fail("GitHub immutable release verification failed"); try { strictJSON(Buffer.from(result.stdout), "GitHub release verification result"); } catch { fail("GitHub immutable release verification failed"); } }
  const args = ["attestation", "verify", paths.artifact, "--bundle", paths.bundle, "--repo", DESKTOP_ACCEPTED_EVIDENCE_REPOSITORY, "--signer-workflow", SIGNER_WORKFLOW, "--predicate-type", PREDICATE_TYPE, "--source-ref", SOURCE_REF, "--source-digest", retained.workflowSourceSHA, "--deny-self-hosted-runners", "--format", "json"];
  const result = spawnSync("gh", args, { encoding: "utf8", env: { ...process.env, GH_PAGER: "cat", PAGER: "cat", NO_COLOR: "1" }, maxBuffer: MAX_BUNDLE_BYTES, timeout: 30_000 });
  if (result.error || result.signal || result.status !== 0) fail("canonical artifact attestation verification failed");
  let verification; try { verification = strictJSON(Buffer.from(result.stdout), "canonical artifact attestation verification"); } catch { fail("canonical artifact attestation verification failed"); }
  if (!Array.isArray(verification) || verification.length !== 1 || !isDeepStrictEqual(verification[0]?.verificationResult?.statement, retained.statement)) fail("canonical artifact attestation verification failed");
}

function verifyRetained(input, stableOnly) {
  exactObject(input, INPUT_FIELDS, "retained evidence input"); for (const field of INPUT_FIELDS) if (typeof input[field] !== "string" || !input[field]) fail("retained evidence input is not canonical"); canonicalContext();
  const packet = exactPacket(input.packetPath, stableOnly), bundle = exactBundle(input.bundlePath, packet), artifact = exactArtifact(input.artifactPath, packet.packet); if (dirname(packet.path) !== dirname(bundle.path) || dirname(packet.path) !== dirname(artifact.path)) fail("retained evidence files must share one release download directory");
  exactRelease(input.releasePath, input.tagRefPath, packet, [packet, bundle]); githubVerify({ artifact: artifact.path, packet: packet.path, bundle: bundle.path }, bundle, packet.evidenceTag);
  return Object.freeze({ retained: true, repository: DESKTOP_ACCEPTED_EVIDENCE_REPOSITORY, releaseTag: packet.evidenceTag, artifactSourceSHA: packet.packet.sourceSHA, workflowSourceSHA: bundle.workflowSourceSHA, packetSHA256: packet.digest, packetFileName: packet.name, artifactAttestationBundleSHA256: bundle.digest, artifactAttestationBundleFileName: bundle.name });
}
export function verifyRetainedDesktopAcceptedEvidence(input) { return verifyRetained(input, true); }
export function verifyRetainedDesktopAcceptedTargetEvidence(input) { return verifyRetained(input, false); }
