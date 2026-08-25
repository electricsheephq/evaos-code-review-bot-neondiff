import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

export const DESKTOP_ACCEPTED_EVIDENCE_REPOSITORY = "electricsheephq/evaos-code-review-bot-neondiff";
export const DESKTOP_ACCEPTED_EVIDENCE_TAG = "neondiff-accepted-packet-v1.1.0";
export const DESKTOP_ACCEPTED_EVIDENCE_RELEASE_NAME = "NeonDiff accepted packet evidence v1.1.0";

const SIGNER_WORKFLOW = `${DESKTOP_ACCEPTED_EVIDENCE_REPOSITORY}/.github/workflows/desktop-accepted-release-packet.yml`;
const SOURCE_REF = "refs/heads/main";
const STABLE_TAG = "v1.1.0";
const TEAM_ID = "TC6MS3T6NN";
const PACKET_KIND = "neondiff.desktop.accepted-release-packet-v3";
const CLAIM_CLASS = "neondiff.desktop.artifact-source-promotion.v1";
const PREDICATE_TYPE = "https://neondiff.com/attestations/desktop-artifact-source-promotion/v1";
const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const ARTIFACT_NAME = /^NeonDiff-1\.1\.0-build[0-9]+-macOS\.zip$/;
const MAX_PACKET_BYTES = 1024 * 1024;
const MAX_BUNDLE_BYTES = 4 * 1024 * 1024;
const MAX_METADATA_BYTES = 1024 * 1024;
const INPUT_FIELDS = ["packetPath", "bundlePath", "releasePath", "tagRefPath"];
const PACKET_FIELDS = ["schemaVersion", "kind", "verified", "channel", "version", "build", "tag", "sourceSHA", "artifactSourceSHA", "tagObjectSHA", "artifactURL", "artifactName", "artifactByteLength", "artifactSHA256", "treeSHA256", "feedSHA256", "feedEntry", "enclosureProofSHA256", "releaseContract", "productionContract", "npmReleaseClass"];
const PREDICATE_FIELDS = ["schemaVersion", "claimClass", "repository", "signerWorkflow", "workflowSourceRef", "workflowSourceSHA", "releaseTag", "artifactSourceSHA", "developerIDTeamID"];
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
function exactObject(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== fields.length || fields.some((field) => !Object.hasOwn(value, field))) fail(`${label} is not canonical`);
}
function boundedBytes(input, label, maximum) {
  if (typeof input !== "string" || !input) fail(`${label} path is invalid`);
  const path = resolve(input); let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.size < 1n || before.size > BigInt(maximum)) fail(`${label} must be a bounded regular file`);
    const bytes = readFileSync(descriptor), after = fstatSync(descriptor, { bigint: true });
    if (!after.isFile() || !sameFile(before, after) || BigInt(bytes.length) !== before.size) fail(`${label} changed during read`);
    return { path, bytes, digest: sha256(bytes) };
  } catch (error) {
    if (error?.code === "ELOOP") fail(`${label} must not be symlinked`);
    throw error;
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}
function strictJSON(bytes, label) {
  const result = spawnSync("/usr/bin/python3", ["-I", "-c", STRICT_JSON], { input: bytes, encoding: "utf8", maxBuffer: MAX_BUNDLE_BYTES });
  try { if (result.error || result.signal || result.status !== 0) fail(`${label} is malformed`); return JSON.parse(result.stdout); } catch { fail(`${label} is malformed`); }
}
function canonicalContext() {
  const workflowSHA = process.env.GITHUB_SHA;
  if (process.env.GITHUB_ACTIONS !== "true" || process.env.GITHUB_REPOSITORY !== DESKTOP_ACCEPTED_EVIDENCE_REPOSITORY || process.env.GITHUB_REF !== SOURCE_REF || !SHA1.test(workflowSHA ?? "") || process.env.GITHUB_WORKFLOW_REF !== `${SIGNER_WORKFLOW}@${SOURCE_REF}` || process.env.RUNNER_ENVIRONMENT !== "github-hosted") fail("canonical GitHub-hosted workflow identity is required");
  return { workflowSHA };
}
function exactPacket(path) {
  const evidence = boundedBytes(path, "accepted packet", MAX_PACKET_BYTES), packet = strictJSON(evidence.bytes, "accepted packet"); exactObject(packet, PACKET_FIELDS, "accepted packet");
  if (packet.schemaVersion !== 3 || packet.kind !== PACKET_KIND || packet.verified !== true || packet.channel !== "stable" || packet.version !== "1.1.0" || packet.tag !== STABLE_TAG || !/^[1-9][0-9]*$/.test(packet.build ?? "") || !SHA1.test(packet.sourceSHA ?? "") || packet.artifactSourceSHA !== packet.sourceSHA || !SHA1.test(packet.tagObjectSHA ?? "") || packet.tagObjectSHA === packet.sourceSHA || !ARTIFACT_NAME.test(packet.artifactName ?? "") || !Number.isSafeInteger(packet.artifactByteLength) || packet.artifactByteLength < 1 || !SHA256.test(packet.artifactSHA256 ?? "") || !SHA256.test(packet.treeSHA256 ?? "") || !SHA256.test(packet.feedSHA256 ?? "") || !SHA256.test(packet.enclosureProofSHA256 ?? "") || packet.releaseContract !== "paid-mac-ga-byo-v1" || !packet.feedEntry || typeof packet.feedEntry !== "object" || Array.isArray(packet.feedEntry)) fail("accepted packet identity is not canonical");
  const artifactURL = `https://github.com/${DESKTOP_ACCEPTED_EVIDENCE_REPOSITORY}/releases/download/${STABLE_TAG}/${packet.artifactName}`;
  if (packet.artifactURL !== artifactURL || packet.feedEntry.url !== artifactURL || basename(evidence.path) !== `${evidence.digest}.packet.json`) fail("accepted packet content address is not canonical");
  return { ...evidence, packet, name: basename(evidence.path) };
}
function exactBundle(path, packet, workflowSHA) {
  const evidence = boundedBytes(path, "artifact-source attestation bundle", MAX_BUNDLE_BYTES);
  if (basename(evidence.path) !== `${evidence.digest}.artifact-source-attestation.json`) fail("artifact-source attestation content address is not canonical");
  const bundle = strictJSON(evidence.bytes, "artifact-source attestation bundle"), payload = bundle?.dsseEnvelope?.payload, signatures = bundle?.dsseEnvelope?.signatures;
  if (bundle?.mediaType !== "application/vnd.dev.sigstore.bundle.v0.3+json" || !bundle.verificationMaterial || typeof bundle.verificationMaterial !== "object" || Object.keys(bundle.verificationMaterial).length < 1 || bundle?.dsseEnvelope?.payloadType !== "application/vnd.in-toto+json" || typeof payload !== "string" || !payload || !Array.isArray(signatures) || signatures.length < 1 || signatures.some((value) => typeof value?.sig !== "string" || !value.sig || Buffer.from(value.sig, "base64").toString("base64") !== value.sig)) fail("artifact-source attestation bundle is malformed");
  const decoded = Buffer.from(payload, "base64"); if (!decoded.length || decoded.toString("base64") !== payload) fail("artifact-source attestation bundle is malformed");
  const statement = strictJSON(decoded, "artifact-source attestation statement"), subject = statement?.subject, predicate = statement?.predicate;
  exactObject(statement, ["_type", "subject", "predicateType", "predicate"], "artifact-source attestation statement"); exactObject(predicate, PREDICATE_FIELDS, "artifact-source attestation predicate");
  if (statement._type !== "https://in-toto.io/Statement/v1" || statement.predicateType !== PREDICATE_TYPE || !Array.isArray(subject) || subject.length !== 1 || subject[0]?.name !== packet.artifactName || subject[0]?.digest?.sha256 !== packet.artifactSHA256 || Object.keys(subject[0] ?? {}).length !== 2 || Object.keys(subject[0]?.digest ?? {}).length !== 1) fail("artifact-source attestation subject is not canonical");
  const expected = { schemaVersion: 1, claimClass: CLAIM_CLASS, repository: DESKTOP_ACCEPTED_EVIDENCE_REPOSITORY, signerWorkflow: SIGNER_WORKFLOW, workflowSourceRef: SOURCE_REF, workflowSourceSHA: workflowSHA, releaseTag: STABLE_TAG, artifactSourceSHA: packet.sourceSHA, developerIDTeamID: TEAM_ID };
  if (PREDICATE_FIELDS.some((field) => predicate[field] !== expected[field])) fail("artifact-source attestation predicate is not canonical");
  return { ...evidence, name: basename(evidence.path) };
}
function exactRelease(releasePath, tagRefPath, packet, retained) {
  const release = strictJSON(boundedBytes(releasePath, "evidence release metadata", MAX_METADATA_BYTES).bytes, "evidence release metadata"), tagRef = strictJSON(boundedBytes(tagRefPath, "evidence tag metadata", MAX_METADATA_BYTES).bytes, "evidence tag metadata");
  if (tagRef?.ref !== `refs/tags/${DESKTOP_ACCEPTED_EVIDENCE_TAG}` || tagRef?.object?.type !== "commit" || tagRef?.object?.sha !== packet.sourceSHA) fail("evidence tag is not bound to the artifact source");
  if (release?.tag_name !== DESKTOP_ACCEPTED_EVIDENCE_TAG || release?.name !== DESKTOP_ACCEPTED_EVIDENCE_RELEASE_NAME || release?.draft !== false || release?.prerelease !== true || release?.immutable !== true || release?.target_commitish !== packet.sourceSHA || release?.html_url !== `https://github.com/${DESKTOP_ACCEPTED_EVIDENCE_REPOSITORY}/releases/tag/${DESKTOP_ACCEPTED_EVIDENCE_TAG}` || !Array.isArray(release.assets) || release.assets.length !== retained.length) fail("immutable evidence release metadata is required");
  for (const evidence of retained) {
    const matches = release.assets.filter((asset) => asset?.name === evidence.name), url = `https://github.com/${DESKTOP_ACCEPTED_EVIDENCE_REPOSITORY}/releases/download/${DESKTOP_ACCEPTED_EVIDENCE_TAG}/${evidence.name}`;
    if (matches.length !== 1 || matches[0]?.digest !== `sha256:${evidence.digest}` || matches[0]?.size !== evidence.bytes.length || matches[0]?.browser_download_url !== url) fail("evidence release asset identity mismatch");
  }
}
function githubVerify(path) {
  const calls = [["release", "verify", DESKTOP_ACCEPTED_EVIDENCE_TAG, "--repo", DESKTOP_ACCEPTED_EVIDENCE_REPOSITORY, "--format", "json"], ["release", "verify-asset", DESKTOP_ACCEPTED_EVIDENCE_TAG, path.packet, "--repo", DESKTOP_ACCEPTED_EVIDENCE_REPOSITORY, "--format", "json"], ["release", "verify-asset", DESKTOP_ACCEPTED_EVIDENCE_TAG, path.bundle, "--repo", DESKTOP_ACCEPTED_EVIDENCE_REPOSITORY, "--format", "json"]];
  for (const args of calls) { const result = spawnSync("gh", args, { encoding: "utf8", env: { ...process.env, GH_PAGER: "cat", PAGER: "cat", NO_COLOR: "1" }, maxBuffer: MAX_BUNDLE_BYTES, timeout: 30_000 }); if (result.error || result.signal || result.status !== 0) fail("GitHub immutable release verification failed"); try { strictJSON(Buffer.from(result.stdout), "GitHub release verification result"); } catch { fail("GitHub immutable release verification failed"); } }
}

export function verifyRetainedDesktopAcceptedEvidence(input) {
  exactObject(input, INPUT_FIELDS, "retained evidence input"); for (const field of INPUT_FIELDS) if (typeof input[field] !== "string" || !input[field]) fail("retained evidence input is not canonical");
  const context = canonicalContext(), packet = exactPacket(input.packetPath), bundle = exactBundle(input.bundlePath, packet.packet, context.workflowSHA);
  if (dirname(packet.path) !== dirname(bundle.path)) fail("retained evidence files must share one release download directory");
  exactRelease(input.releasePath, input.tagRefPath, packet.packet, [packet, bundle]); githubVerify({ packet: packet.path, bundle: bundle.path });
  return Object.freeze({ retained: true, repository: DESKTOP_ACCEPTED_EVIDENCE_REPOSITORY, releaseTag: DESKTOP_ACCEPTED_EVIDENCE_TAG, artifactSourceSHA: packet.packet.sourceSHA, workflowSourceSHA: context.workflowSHA, packetSHA256: packet.digest, packetFileName: packet.name, artifactAttestationBundleSHA256: bundle.digest, artifactAttestationBundleFileName: bundle.name });
}
