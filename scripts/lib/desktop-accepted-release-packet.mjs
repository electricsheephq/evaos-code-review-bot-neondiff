import { createHash } from "node:crypto";
import { posix } from "node:path";
import { serializeFeedEnclosureProof } from "./desktop-feed-enclosure-proof.mjs";

const SHA1 = /^[a-f0-9]{40}$/, SHA256 = /^[a-f0-9]{64}$/;
const REPO = "https://github.com/electricsheephq/evaos-code-review-bot-neondiff";
const fail = (message) => { throw new Error(message); };
const text = (value, label) => { if (typeof value !== "string" || value.length === 0 || /[\u0000-\u001f\u007f]/.test(value)) fail(`${label} is malformed`); return value; };
const digest = (value, label, pattern = SHA256) => { const result = text(value, label); if (!pattern.test(result)) fail(`${label} is malformed`); return result; };
function exact(value, fields, label) { if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`); const keys = Object.keys(value); if (keys.length !== fields.length || keys.some((key) => !fields.includes(key))) fail(`${label} has undeclared fields`); return value; }
function snap(value, fields, label) { exact(value, fields, label); return Object.fromEntries(fields.map((field) => [field, value[field]])); }
function loose(value, fields, label) { if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`); return Object.fromEntries(fields.map((field) => [field, value[field]])); }
function hash(value) { return createHash("sha256").update(value, "utf8").digest("hex"); }
function treeHash(records) {
  if (!Array.isArray(records) || records.length === 0) fail("tree records are required");
  const digest = createHash("sha256"); let prior = "";
  for (const record of records) {
    const parts = Array.isArray(record) ? [...record] : [];
    if (!["dir", "file", "link"].includes(parts[0]) || typeof parts[1] !== "string" || !parts[1] || parts[1].startsWith("/") || parts[1] <= prior) fail("tree records are not canonical");
    prior = parts[1];
    if (parts[0] === "dir" && parts.length !== 2) fail("directory tree record is malformed");
    if (parts[0] === "link" && (parts.length !== 3 || typeof parts[2] !== "string" || !parts[2] || parts[2].startsWith("/") || ["..", "../"].some((prefix) => posix.normalize(posix.join(posix.dirname(parts[1]), parts[2])) === prefix || posix.normalize(posix.join(posix.dirname(parts[1]), parts[2])).startsWith(prefix)))) fail("link tree record is malformed");
    if (parts[0] === "file" && (parts.length !== 5 || !["-", "x"].includes(parts[2]) || !Number.isSafeInteger(parts[3]) || parts[3] < 0 || !SHA256.test(parts[4]))) fail("file tree record is malformed");
    for (const part of parts) { digest.update(String(part), "utf8"); digest.update("\0"); } digest.update("\n");
  }
  return digest.digest("hex");
}
function freeze(value) { if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
function safeIdentity(value, label) { const result = text(value, label); if (/\/|\\|private|secret|token|password|keychain/i.test(result)) fail(`${label} is not public-safe`); return result; }

const INPUT_FIELDS = ["identity", "tagMetadata", "annotatedTagMetadata", "releaseMetadata", "enclosureProof", "treeProof", "appleProof", "feedEntry"];
const IDENTITY_FIELDS = ["releaseTag", "sourceSHA", "tagObjectSHA", "version", "channel", "build", "artifactName", "artifactSHA256", "artifactLength", "artifactURL"];
const PACKET_FIELDS = ["schemaVersion", "kind", "source", "tag", "release", "artifact", "tree", "apple", "feed"];
const accepted = new WeakSet();
export function treeProofDigest(records) { return treeHash(records); }

export function buildAcceptedReleasePacket(input) {
  exact(input, INPUT_FIELDS, "release packet inputs");
  const i = snap(input.identity, IDENTITY_FIELDS, "release identity");
  const tag = text(i.releaseTag, "release tag"), match = tag.match(/^v(1\.1\.0-(beta|rc)\.([1-9][0-9]{0,15}))$/);
  if (!match || i.version !== match[1] || i.channel !== match[2]) fail("release identity is malformed");
  const version = text(i.version, "release version"), build = text(i.build, "artifact build");
  if (!/^[0-9]+$/.test(build) || !Number.isSafeInteger(Number(build)) || i.artifactName !== `NeonDiff-${version}-build${build}-macOS.zip`) fail("artifact identity is malformed");
  const sourceSHA = digest(i.sourceSHA, "reviewed source SHA", SHA1), tagObjectSHA = digest(i.tagObjectSHA, "annotated tag-object SHA", SHA1), artifactSHA256 = digest(i.artifactSHA256, "artifact SHA-256");
  if (!Number.isSafeInteger(i.artifactLength) || i.artifactLength < 1) fail("artifact length is malformed");
  const artifactURL = `${REPO}/releases/download/${tag}/${i.artifactName}`;
  if (i.artifactURL !== artifactURL) fail("artifact URL is not canonical");
  const tm = loose(input.tagMetadata, ["ref", "object"], "tag metadata"), to = loose(tm.object, ["type", "sha"], "tag object");
  const at = loose(input.annotatedTagMetadata, ["sha", "tag", "object"], "annotated tag metadata"), ao = loose(at.object, ["type", "sha"], "peeled tag");
  if (tm.ref !== `refs/tags/${tag}` || to.type !== "tag" || to.sha !== tagObjectSHA || at.sha !== tagObjectSHA || at.tag !== tag || ao.type !== "commit" || ao.sha !== sourceSHA) fail("tag identity does not match validated release output");
  const rm = loose(input.releaseMetadata, ["tag_name", "draft", "prerelease", "immutable", "assets"], "release metadata");
  if (rm.tag_name !== tag || rm.draft !== false || rm.prerelease !== true || rm.immutable !== true || !Array.isArray(rm.assets)) fail("release metadata is not immutable");
  const assets = rm.assets.filter((asset) => asset && asset.name === i.artifactName); if (assets.length !== 1) fail("release asset is not unique");
  const asset = loose(assets[0], ["name", "digest", "size", "browser_download_url"], "release asset");
  if (asset.name !== i.artifactName || asset.digest !== `sha256:${artifactSHA256}` || asset.size !== i.artifactLength || asset.browser_download_url !== artifactURL) fail("release asset does not match validated output");

  const enclosure = JSON.parse(serializeFeedEnclosureProof(input.enclosureProof));
  const e = snap(enclosure, ["schemaVersion", "kind", "verified", "signatureScope", "channel", "url", "artifactName", "artifactSHA256", "version", "build", "shortVersionString", "edSignature", "publicKeyFingerprint", "signedContentSHA256"], "enclosure proof");
  if (e.channel !== i.channel || e.url !== artifactURL || e.artifactName !== i.artifactName || e.artifactSHA256 !== artifactSHA256 || e.version !== version || e.build !== build || e.shortVersionString !== version || e.signedContentSHA256 !== artifactSHA256 || !/^sha256:[a-f0-9]{64}$/.test(e.publicKeyFingerprint)) fail("enclosure proof does not match release identity");
  const t = snap(input.treeProof, ["schemaVersion", "kind", "verified", "algorithm", "sourceSHA", "artifactSHA256", "treeSHA256", "records", "bundleMarkers"], "tree proof"), marker = snap(t.bundleMarkers, ["appPath", "bundleID", "version", "build"], "bundle markers");
  if (t.schemaVersion !== 1 || t.kind !== "neondiff.desktop.extracted-tree-proof-v1" || t.verified !== true || t.algorithm !== "sha256-tree-v1") fail("tree proof is not verified");
  const treeSHA256 = treeHash(t.records); if (t.sourceSHA !== sourceSHA || t.artifactSHA256 !== artifactSHA256 || t.treeSHA256 !== treeSHA256 || marker.appPath !== "NeonDiff.app" || marker.bundleID !== "com.electricsheephq.NeonDiffDesktop" || marker.version !== version || marker.build !== build) fail("tree proof does not match release identity");
  const a = snap(input.appleProof, ["schemaVersion", "kind", "verified", "teamID", "codesignIdentity", "notarizationIdentity", "stapleIdentity", "gatekeeperIdentity"], "Apple proof");
  if (a.schemaVersion !== 1 || a.kind !== "neondiff.desktop.apple-release-proof-v1" || a.verified !== true || a.teamID !== "TC6MS3T6NN") fail("Apple proof is not verified");
  const apple = { teamID: a.teamID, codesignIdentity: safeIdentity(a.codesignIdentity, "codesign identity"), notarizationIdentity: safeIdentity(a.notarizationIdentity, "notarization identity"), stapleIdentity: safeIdentity(a.stapleIdentity, "staple identity"), gatekeeperIdentity: safeIdentity(a.gatekeeperIdentity, "Gatekeeper identity") };
  if (!apple.codesignIdentity.startsWith("Developer ID Application:") || !/^accepted(?::|$)/i.test(apple.notarizationIdentity) || !/^valid(?::|$)/i.test(apple.stapleIdentity) || !/^accepted(?::|$)/i.test(apple.gatekeeperIdentity)) fail("Apple identities are not accepted");
  const f = snap(input.feedEntry, ["channel", "version", "build", "url", "artifactName", "artifactSHA256", "artifactLength", "edSignature"], "feed entry");
  if (f.channel !== i.channel || f.version !== version || f.build !== build || f.url !== artifactURL || f.artifactName !== i.artifactName || f.artifactSHA256 !== artifactSHA256 || f.artifactLength !== i.artifactLength || f.edSignature !== e.edSignature) fail("feed entry does not match enclosure proof");
  const feed = { channel: f.channel, version: f.version, build: f.build, url: f.url, artifactName: f.artifactName, artifactSHA256: f.artifactSHA256, artifactLength: f.artifactLength, edSignature: f.edSignature };
  const body = { schemaVersion: 1, kind: "neondiff.desktop.accepted-release-packet-v1", source: { commitSHA: sourceSHA }, tag: { name: tag, objectSHA: tagObjectSHA }, release: { version, build, channel: i.channel }, artifact: { name: i.artifactName, url: artifactURL, length: i.artifactLength, sha256: artifactSHA256, edSignature: e.edSignature, publicKeyFingerprint: e.publicKeyFingerprint }, tree: { algorithm: "sha256-tree-v1", sha256: treeSHA256, bundleMarkers: marker }, apple, feed: { ...feed, entrySHA256: hash(JSON.stringify(feed)) } };
  const packet = { ...body, packetDigest: hash(JSON.stringify(body)) }; accepted.add(packet); return freeze(packet);
}

export function serializeAcceptedReleasePacket(packet) {
  if (!accepted.has(packet)) fail("packet was not produced by the accepted packet producer");
  const body = Object.fromEntries(PACKET_FIELDS.map((field) => [field, packet[field]]));
  if (hash(JSON.stringify(body)) !== packet.packetDigest) fail("packet digest is invalid");
  return `${JSON.stringify({ ...body, packetDigest: packet.packetDigest })}\n`;
}
export function acceptedReleasePacketDigest(input) { return buildAcceptedReleasePacket(input).packetDigest; }
export const buildAcceptedDesktopReleasePacket = buildAcceptedReleasePacket;
export const serializeAcceptedDesktopReleasePacket = serializeAcceptedReleasePacket;
