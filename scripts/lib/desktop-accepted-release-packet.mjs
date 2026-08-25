import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtractedAppTreeProof, guardClassicZipArchive } from "./desktop-extracted-app-tree-proof.mjs";
import { buildFeedEnclosureProof, feedEnclosureProofDigest } from "./desktop-feed-enclosure-proof.mjs";
import { classifyDesktopOnlyRelease } from "./desktop-only-release-policy.mjs";
import { parseRawDesktopAppcast } from "./desktop-raw-appcast.mjs";

const KIND = "neondiff.desktop.accepted-release-packet-v3", SHA1 = /^[a-f0-9]{40}$/, SHA256 = /^[a-f0-9]{64}$/, RELEASE_TAG = /^v1\.1\.0(?:-(?:beta\.[1-9][0-9]{0,3}|rc\.[1-9][0-9]{0,15}))?$/, MAX_INPUT = 4 * 1024 * 1024;
const FIELDS = ["schemaVersion", "kind", "verified", "channel", "version", "build", "tag", "sourceSHA", "artifactSourceSHA", "tagObjectSHA", "artifactURL", "artifactName", "artifactByteLength", "artifactSHA256", "treeSHA256", "feedSHA256", "feedEntry", "enclosureProofSHA256", "releaseContract", "productionContract", "npmReleaseClass"];
const ENTRY_FIELDS = ["url", "length", "type", "version", "build", "shortVersionString", "minimumSystemVersion", "channel", "edSignature"], CONTRACT_FIELDS = ["contract", "byoGitHubEnabled", "managedGitHubBrokerEnabledPresent", "githubBrokerOriginPresent"], authenticatedPackets = new WeakSet(), validator = fileURLToPath(new URL("../validate-desktop-release-declaration.mjs", import.meta.url));
const fail = (message) => { throw new Error(message); }, sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
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

function boundedBytes(input, label) {
  if (typeof input !== "string" || !input) fail(`${label} must be a primitive path`);
  let descriptor;
  try { descriptor = openSync(resolve(input), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); const before = fstatSync(descriptor); if (!before.isFile() || before.size > MAX_INPUT) fail(`${label} is not a bounded regular file`); const raw = readFileSync(descriptor), after = fstatSync(descriptor); if (!after.isFile() || raw.length !== before.size || after.size !== before.size) fail(`${label} changed during read`); return raw; }
  catch (error) { if (error?.code === "ELOOP") fail(`${label} must not be symlinked`); throw error; } finally { if (descriptor !== undefined) closeSync(descriptor); }
}
function parseIsolated(raw, script, label) { const result = spawnSync("/usr/bin/python3", ["-I", "-c", script], { input: raw, encoding: "utf8", maxBuffer: MAX_INPUT }); try { if (result.status !== 0) fail(`${label} is malformed`); return JSON.parse(result.stdout); } catch { fail(`${label} is malformed`); } }
function strictJSON(raw, label) { return parseIsolated(raw, STRICT_JSON, label); }
function exactObject(value, fields, label) { if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== fields.length || fields.some((field) => !Object.hasOwn(value, field))) fail(`${label} shape is invalid`); return value; }
function currentDeclaration(indexPath, releaseTag) {
  const indexRaw = boundedBytes(indexPath, "declaration index"), index = strictJSON(indexRaw, "declaration index");
  if (index?.declarationDirectory !== "declarations" || typeof index.currentPath !== "string" || !/^v1\.1\.0(?:-(?:beta\.[1-9][0-9]{0,3}|rc\.[1-9][0-9]{0,15}))?\.json$/.test(index.currentPath)) fail("declaration index has no canonical current path");
  if (releaseTag !== undefined && (typeof releaseTag !== "string" || !RELEASE_TAG.test(releaseTag))) fail("release tag selector is invalid"); const selectedPath = releaseTag === undefined ? index.currentPath : `${releaseTag}.json`;
  if (releaseTag !== undefined && (!Array.isArray(index.declarationPaths) || index.declarationPaths.filter((value) => value === selectedPath).length !== 1)) fail("release tag selector is not retained in protected declaration history");
  const directory = resolve(dirname(resolve(indexPath)), "declarations"), declarationPath = resolve(directory, selectedPath); if (relative(directory, declarationPath).startsWith("..")) fail("declaration path escapes index");
  const declarationRaw = boundedBytes(declarationPath, "release declaration"), checked = spawnSync(process.execPath, [validator, "--index", resolve(indexPath)], { encoding: "utf8", maxBuffer: MAX_INPUT });
  if (checked.status !== 0) fail((checked.stderr || "release declaration validation failed").trim());
  if (!boundedBytes(indexPath, "declaration index").equals(indexRaw) || !boundedBytes(declarationPath, "release declaration").equals(declarationRaw)) fail("release declaration changed during validation");
  return strictJSON(declarationRaw, "release declaration");
}
function metadata(tagRefPath, tagObjectPath, releasePath, declaration) {
  const tagRef = strictJSON(boundedBytes(tagRefPath, "tag-ref metadata"), "tag-ref metadata"), tagObject = strictJSON(boundedBytes(tagObjectPath, "tag-object metadata"), "tag-object metadata"), release = strictJSON(boundedBytes(releasePath, "release metadata"), "release metadata"), tagObjectSHA = tagRef?.object?.sha, beta = declaration.channel === "beta"; let sourceSHA, annotation = "";
  if (tagRef?.ref !== `refs/tags/${declaration.tag}` || !SHA1.test(tagObjectSHA ?? "")) fail("release tag metadata is not canonical");
  if (tagRef.object.type === "tag") { sourceSHA = tagObject?.object?.sha; annotation = tagObject?.message; if (tagObject?.sha !== tagObjectSHA || tagObject?.tag !== declaration.tag || tagObject?.object?.type !== "commit" || !SHA1.test(sourceSHA ?? "") || sourceSHA === tagObjectSHA) fail("annotated tag metadata is not canonical"); }
  else if (tagRef.object.type === "commit" && beta) { sourceSHA = tagObject?.sha; if (sourceSHA !== tagObjectSHA || !SHA1.test(sourceSHA ?? "")) fail("lightweight beta tag metadata is not canonical"); }
  else fail("release tag metadata is not canonical");
  const prerelease = declaration.channel !== "stable"; if (release?.tag_name !== declaration.tag || release?.draft !== false || release?.prerelease !== prerelease || release?.immutable !== true || prerelease && release?.target_commitish !== sourceSHA) fail("immutable product release metadata is required");
  const policy = beta ? Object.freeze({ releaseKind: "paid-beta" }) : classifyDesktopOnlyRelease(declaration.tag, annotation, release.prerelease), assets = Array.isArray(release.assets) ? release.assets.filter((asset) => asset?.name === declaration.distribution.artifactName) : [];
  if (assets.length !== 1) fail("one exact release asset is required"); return { tagObjectSHA, sourceSHA, asset: assets[0], policy };
}
function deepFreeze(value) { if (value && typeof value === "object" && !Object.isFrozen(value)) { for (const child of Object.values(value)) deepFreeze(child); Object.freeze(value); } return value; }

export async function buildAcceptedDesktopReleasePacket(indexPath, artifactPath, feedPath, tagRefPath, tagObjectPath, releasePath, acceptedPublicKeyPath, releaseTag) {
  for (const [value, label] of [[indexPath, "indexPath"], [artifactPath, "artifactPath"], [feedPath, "feedPath"], [tagRefPath, "tagRefPath"], [tagObjectPath, "tagObjectPath"], [releasePath, "releasePath"], [acceptedPublicKeyPath, "acceptedPublicKeyPath"]]) if (typeof value !== "string" || !value) fail(`${label} must be a primitive path`);
  const declaration = currentDeclaration(indexPath, releaseTag), prerelease = declaration.version.match(/^1\.1\.0-(beta|rc)\.([1-9][0-9]{0,15})$/), channel = prerelease?.[1] ?? (declaration.version === "1.1.0" ? "stable" : undefined), sequence = prerelease?.[2] ?? null;
  if (!channel || declaration.channel !== channel || declaration.tag !== `v${declaration.version}` || declaration.sequence !== sequence || declaration.contract !== (channel === "stable" ? "paid-mac-ga-byo-v1" : "paid-mac-beta-byo-v1") || declaration.distribution.releaseClass !== (channel === "stable" ? "desktop-only" : "paid-beta")) fail("current declaration is not a supported Desktop release");
  const { tagObjectSHA, sourceSHA, asset, policy } = metadata(tagRefPath, tagObjectPath, releasePath, declaration), artifactName = declaration.distribution.artifactName, artifactURL = `https://github.com/electricsheephq/evaos-code-review-bot-neondiff/releases/download/${declaration.tag}/${artifactName}`;
  if (basename(resolve(artifactPath)) !== artifactName) fail("artifact path name is not canonical"); const guarded = guardClassicZipArchive({ artifactPath }), tree = await buildExtractedAppTreeProof(artifactPath, sourceSHA);
  if (asset?.browser_download_url !== artifactURL || asset?.digest !== `sha256:${guarded.artifactSHA256}` || asset?.size !== guarded.artifactBytes.length || tree.artifactSHA256 !== guarded.artifactSHA256 || tree.artifactByteLength !== guarded.artifactBytes.length) fail("release artifact identity mismatch");
  if (tree.bundleMarkers.appPath !== declaration.distribution.appPath || tree.bundleMarkers.bundleID !== declaration.distribution.bundleId || tree.bundleMarkers.version !== declaration.version || tree.bundleMarkers.build !== declaration.build || tree.bundleMarkers.feedURL !== declaration.distribution.origins.feed || tree.bundleMarkers.sourceSHA !== sourceSHA || tree.appleDouble.entryCount !== 0) fail(tree.appleDouble.entryCount ? "AppleDouble sidecars are unsupported by the accepted packet" : "extracted app identity mismatch");
  const rawFeed = boundedBytes(feedPath, "raw appcast"), feed = parseRawDesktopAppcast(rawFeed), matches = Array.isArray(feed.entries) ? feed.entries.filter((entry) => entry?.url === artifactURL) : [];
  if (feed.link !== declaration.distribution.origins.feed || matches.length !== 1) fail("raw appcast does not select one canonical enclosure"); const entry = matches[0], length = Number(entry.length);
  if (Object.keys(entry).length !== ENTRY_FIELDS.length || ENTRY_FIELDS.some((field) => !Object.hasOwn(entry, field)) || !/^(?:0|[1-9][0-9]*)$/.test(entry.length) || !Number.isSafeInteger(length) || length !== guarded.artifactBytes.length || entry.type !== "application/octet-stream" || entry.version !== declaration.version || entry.shortVersionString !== declaration.version || entry.build !== declaration.build || entry.channel !== (channel === "stable" ? "stable" : "beta") || entry.minimumSystemVersion !== tree.bundleMarkers.minimumSystemVersion) fail("selected appcast enclosure identity mismatch");
  const acceptedPublicKey = boundedBytes(acceptedPublicKeyPath, "accepted Sparkle public key").toString("utf8"); if (acceptedPublicKey !== tree.bundleMarkers.publicKey) fail("artifact Sparkle public key does not match accepted release authority");
  const enclosure = buildFeedEnclosureProof({ url: entry.url, version: entry.version, build: entry.build, shortVersionString: entry.shortVersionString, channel: declaration.channel, artifactName, artifactSHA256: guarded.artifactSHA256, edSignature: entry.edSignature }, { acceptedPublicKey, signedContent: guarded.artifactBytes });
  const packet = { schemaVersion: 3, kind: KIND, verified: true, channel: declaration.channel, version: declaration.version, build: declaration.build, tag: declaration.tag, sourceSHA, artifactSourceSHA: tree.bundleMarkers.sourceSHA, tagObjectSHA, artifactURL, artifactName, artifactByteLength: guarded.artifactBytes.length, artifactSHA256: guarded.artifactSHA256, treeSHA256: tree.treeSHA256, feedSHA256: sha256(rawFeed), feedEntry: Object.fromEntries(ENTRY_FIELDS.map((field) => [field, field === "length" ? length : entry[field]])), enclosureProofSHA256: feedEnclosureProofDigest(enclosure), releaseContract: declaration.contract, productionContract: tree.bundleMarkers.productionContract, npmReleaseClass: policy.releaseKind };
  authenticatedPackets.add(packet); return deepFreeze(packet);
}
export function parseAcceptedDesktopReleasePacket(input) {
  if (!(input instanceof Uint8Array)) fail("accepted packet must be bytes"); const raw = Buffer.from(input); if (!raw.length || raw.length > MAX_INPUT) fail("accepted packet is not bounded");
  const packet = exactObject(strictJSON(raw, "accepted packet"), FIELDS, "accepted packet"), entry = exactObject(packet.feedEntry, ENTRY_FIELDS, "accepted packet feed entry"), contract = exactObject(packet.productionContract, CONTRACT_FIELDS, "accepted packet production contract"), canonical = Buffer.from(`${JSON.stringify(Object.fromEntries(FIELDS.map((field) => [field, field === "feedEntry" ? Object.fromEntries(ENTRY_FIELDS.map((key) => [key, entry[key]])) : field === "productionContract" ? Object.fromEntries(CONTRACT_FIELDS.map((key) => [key, contract[key]])) : packet[field]])))}\n`); if (!raw.equals(canonical)) fail("accepted packet bytes are not canonical");
  const prerelease = typeof packet.version === "string" ? packet.version.match(/^1\.1\.0-(beta|rc)\.([1-9][0-9]{0,15})$/) : null, channel = prerelease?.[1] ?? (packet.version === "1.1.0" ? "stable" : undefined), releaseContract = channel === "stable" ? "paid-mac-ga-byo-v1" : "paid-mac-beta-byo-v1", expectedBuild = channel === "stable" ? /^[1-9][0-9]*$/ : /^[0-9]+$/;
  if (packet.schemaVersion !== 3 || packet.kind !== KIND || packet.verified !== true || packet.channel !== channel || channel === "beta" && prerelease[2].length > 4 || packet.tag !== `v${packet.version}` || !expectedBuild.test(packet.build ?? "") || !SHA1.test(packet.sourceSHA ?? "") || packet.artifactSourceSHA !== packet.sourceSHA || !SHA1.test(packet.tagObjectSHA ?? "") || channel !== "beta" && packet.sourceSHA === packet.tagObjectSHA || packet.releaseContract !== releaseContract || contract.contract !== "paid-mac-beta-byo-v1" || contract.byoGitHubEnabled !== true || contract.managedGitHubBrokerEnabledPresent !== false || contract.githubBrokerOriginPresent !== false) fail("accepted packet identity is invalid");
  const artifactName = `NeonDiff-${packet.version}-build${packet.build}-macOS.zip`, artifactURL = `https://github.com/electricsheephq/evaos-code-review-bot-neondiff/releases/download/${packet.tag}/${artifactName}`, expectedNpmClass = channel === "beta" ? "paid-beta" : "desktop-only", expectedFeedChannel = channel === "stable" ? "stable" : "beta";
  if (packet.artifactName !== artifactName || packet.artifactURL !== artifactURL || !Number.isSafeInteger(packet.artifactByteLength) || packet.artifactByteLength < 1 || [packet.artifactSHA256, packet.treeSHA256, packet.feedSHA256, packet.enclosureProofSHA256].some((value) => !SHA256.test(value ?? "")) || packet.npmReleaseClass !== expectedNpmClass) fail("accepted packet evidence identity is invalid");
  if (entry.url !== artifactURL || entry.length !== packet.artifactByteLength || entry.type !== "application/octet-stream" || entry.version !== packet.version || entry.build !== packet.build || entry.shortVersionString !== packet.version || entry.channel !== expectedFeedChannel || typeof entry.minimumSystemVersion !== "string" || !entry.minimumSystemVersion || typeof entry.edSignature !== "string" || !entry.edSignature) fail("accepted packet feed identity is invalid"); return deepFreeze(packet);
}
export function serializeAcceptedDesktopReleasePacket(packet) { if (!authenticatedPackets.has(packet)) fail("packet was not produced by the accepted release producer"); return `${JSON.stringify(Object.fromEntries(FIELDS.map((field) => [field, packet[field]])))}\n`; }
export function acceptedDesktopReleasePacketDigest(packet) { return sha256(Buffer.from(serializeAcceptedDesktopReleasePacket(packet), "utf8")); }
