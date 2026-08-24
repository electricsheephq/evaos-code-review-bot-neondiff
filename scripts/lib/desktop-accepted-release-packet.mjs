import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtractedAppTreeProof, guardClassicZipArchive } from "./desktop-extracted-app-tree-proof.mjs";
import { buildFeedEnclosureProof, feedEnclosureProofDigest } from "./desktop-feed-enclosure-proof.mjs";
import { classifyDesktopOnlyRelease } from "./desktop-only-release-policy.mjs";

const KIND = "neondiff.desktop.accepted-release-packet-v1", SHA1 = /^[a-f0-9]{40}$/, MAX_INPUT = 4 * 1024 * 1024;
const FIELDS = ["schemaVersion", "kind", "verified", "channel", "version", "build", "tag", "sourceSHA", "tagObjectSHA", "artifactURL", "artifactName", "artifactByteLength", "artifactSHA256", "treeSHA256", "feedSHA256", "feedEntry", "enclosureProofSHA256", "npmReleaseClass"];
const ENTRY_FIELDS = ["url", "length", "type", "version", "build", "shortVersionString", "minimumSystemVersion", "channel", "edSignature"], authenticatedPackets = new WeakSet(), validator = fileURLToPath(new URL("../validate-desktop-release-declaration.mjs", import.meta.url));
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
const FEED_PARSER = String.raw`
import json,sys,xml.etree.ElementTree as ET
raw = sys.stdin.buffer.read()
if b"<!DOCTYPE" in raw or b"<!ENTITY" in raw: raise ValueError("DTD unsupported")
root = ET.fromstring(raw)
channels = [node for node in root if node.tag == "channel"]
if root.tag != "rss" or len(channels) != 1: raise ValueError("invalid feed")
channel = channels[0]; links = [node.text or "" for node in channel if node.tag == "link"]
if len(links) != 1: raise ValueError("invalid feed link")
ns = "{http://www.andymatuschak.org/xml-namespaces/sparkle}"; expected = {"url","length","type",ns+"version",ns+"shortVersionString",ns+"minimumSystemVersion",ns+"edSignature"}; entries = []
for item in [node for node in channel if node.tag == "item"]:
    enclosures = [node for node in item if node.tag == "enclosure"]; minimum = [node.text or "" for node in item if node.tag == ns+"minimumSystemVersion"]; rings = [node.text or "" for node in item if node.tag == ns+"channel"]
    if len(enclosures) != 1 or set(enclosures[0].attrib) != expected or len(minimum) != 1 or len(rings) > 1: raise ValueError("invalid feed item")
    value = enclosures[0].attrib
    if value[ns+"minimumSystemVersion"] != minimum[0]: raise ValueError("minimum version mismatch")
    entries.append({"url":value["url"],"length":value["length"],"type":value["type"],"version":value[ns+"shortVersionString"],"build":value[ns+"version"],"shortVersionString":value[ns+"shortVersionString"],"minimumSystemVersion":minimum[0],"channel":rings[0] if rings else "stable","edSignature":value[ns+"edSignature"]})
sys.stdout.write(json.dumps({"link":links[0],"entries":entries}, separators=(",", ":")))
`;

function boundedBytes(input, label) {
  if (typeof input !== "string" || !input) fail(`${label} must be a primitive path`);
  let descriptor;
  try { descriptor = openSync(resolve(input), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); const before = fstatSync(descriptor); if (!before.isFile() || before.size > MAX_INPUT) fail(`${label} is not a bounded regular file`); const raw = readFileSync(descriptor), after = fstatSync(descriptor); if (!after.isFile() || raw.length !== before.size || after.size !== before.size) fail(`${label} changed during read`); return raw; }
  catch (error) { if (error?.code === "ELOOP") fail(`${label} must not be symlinked`); throw error; } finally { if (descriptor !== undefined) closeSync(descriptor); }
}
function parseIsolated(raw, script, label) { const result = spawnSync("/usr/bin/python3", ["-I", "-c", script], { input: raw, encoding: "utf8", maxBuffer: MAX_INPUT }); try { if (result.status !== 0) fail(`${label} is malformed`); return JSON.parse(result.stdout); } catch { fail(`${label} is malformed`); } }
function strictJSON(raw, label) { return parseIsolated(raw, STRICT_JSON, label); }
function currentDeclaration(indexPath) {
  const indexRaw = boundedBytes(indexPath, "declaration index"), index = strictJSON(indexRaw, "declaration index");
  if (index?.declarationDirectory !== "declarations" || typeof index.currentPath !== "string" || !/^v1\.1\.0(?:-(?:beta\.[1-9][0-9]{0,3}|rc\.[1-9][0-9]{0,15}))?\.json$/.test(index.currentPath)) fail("declaration index has no canonical current path");
  const directory = resolve(dirname(resolve(indexPath)), "declarations"), declarationPath = resolve(directory, index.currentPath); if (relative(directory, declarationPath).startsWith("..")) fail("declaration path escapes index");
  const declarationRaw = boundedBytes(declarationPath, "release declaration"), checked = spawnSync(process.execPath, [validator, "--index", resolve(indexPath)], { encoding: "utf8", maxBuffer: MAX_INPUT });
  if (checked.status !== 0) fail((checked.stderr || "release declaration validation failed").trim());
  if (!boundedBytes(indexPath, "declaration index").equals(indexRaw) || !boundedBytes(declarationPath, "release declaration").equals(declarationRaw)) fail("release declaration changed during validation");
  return strictJSON(declarationRaw, "release declaration");
}
function metadata(tagRefPath, tagObjectPath, releasePath, declaration) {
  const tagRef = strictJSON(boundedBytes(tagRefPath, "tag-ref metadata"), "tag-ref metadata"), tagObject = strictJSON(boundedBytes(tagObjectPath, "annotated-tag metadata"), "annotated-tag metadata"), release = strictJSON(boundedBytes(releasePath, "release metadata"), "release metadata"), tagObjectSHA = tagRef?.object?.sha, sourceSHA = tagObject?.object?.sha;
  if (tagRef?.ref !== `refs/tags/${declaration.tag}` || tagRef?.object?.type !== "tag" || !SHA1.test(tagObjectSHA ?? "") || tagObject?.sha !== tagObjectSHA || tagObject?.tag !== declaration.tag || tagObject?.object?.type !== "commit" || !SHA1.test(sourceSHA ?? "") || sourceSHA === tagObjectSHA) fail("annotated tag metadata is not canonical");
  if (release?.tag_name !== declaration.tag || release?.draft !== false || release?.prerelease !== false || release?.immutable !== true) fail("immutable stable release metadata is required");
  const policy = classifyDesktopOnlyRelease(declaration.tag, tagObject.message, release.prerelease), assets = Array.isArray(release.assets) ? release.assets.filter((asset) => asset?.name === declaration.distribution.artifactName) : [];
  if (assets.length !== 1) fail("one exact release asset is required"); return { tagObjectSHA, sourceSHA, asset: assets[0], policy };
}
function parseFeed(raw) { return parseIsolated(raw, FEED_PARSER, "raw appcast"); }
function deepFreeze(value) { if (value && typeof value === "object" && !Object.isFrozen(value)) { for (const child of Object.values(value)) deepFreeze(child); Object.freeze(value); } return value; }

export async function buildAcceptedDesktopReleasePacket(indexPath, artifactPath, feedPath, tagRefPath, tagObjectPath, releasePath, acceptedPublicKeyPath) {
  for (const [value, label] of [[indexPath, "indexPath"], [artifactPath, "artifactPath"], [feedPath, "feedPath"], [tagRefPath, "tagRefPath"], [tagObjectPath, "tagObjectPath"], [releasePath, "releasePath"], [acceptedPublicKeyPath, "acceptedPublicKeyPath"]]) if (typeof value !== "string" || !value) fail(`${label} must be a primitive path`);
  const declaration = currentDeclaration(indexPath); if (declaration.channel !== "stable" || declaration.version !== "1.1.0" || declaration.tag !== "v1.1.0" || declaration.sequence !== null || declaration.distribution.releaseClass !== "desktop-only") fail("current declaration is not the stable Desktop release");
  const { tagObjectSHA, sourceSHA, asset, policy } = metadata(tagRefPath, tagObjectPath, releasePath, declaration), artifactName = declaration.distribution.artifactName, artifactURL = `https://github.com/electricsheephq/evaos-code-review-bot-neondiff/releases/download/${declaration.tag}/${artifactName}`;
  if (basename(resolve(artifactPath)) !== artifactName) fail("artifact path name is not canonical"); const guarded = guardClassicZipArchive({ artifactPath }), tree = await buildExtractedAppTreeProof(artifactPath, sourceSHA);
  if (asset?.browser_download_url !== artifactURL || asset?.digest !== `sha256:${guarded.artifactSHA256}` || asset?.size !== guarded.artifactBytes.length || tree.artifactSHA256 !== guarded.artifactSHA256 || tree.artifactByteLength !== guarded.artifactBytes.length) fail("release artifact identity mismatch");
  if (tree.bundleMarkers.appPath !== declaration.distribution.appPath || tree.bundleMarkers.bundleID !== declaration.distribution.bundleId || tree.bundleMarkers.version !== declaration.version || tree.bundleMarkers.build !== declaration.build || tree.bundleMarkers.feedURL !== declaration.distribution.origins.feed || tree.appleDouble.entryCount !== 0) fail(tree.appleDouble.entryCount ? "AppleDouble sidecars are unsupported by the accepted packet" : "extracted app identity mismatch");
  const rawFeed = boundedBytes(feedPath, "raw appcast"), feed = parseFeed(rawFeed), matches = Array.isArray(feed.entries) ? feed.entries.filter((entry) => entry?.url === artifactURL) : [];
  if (feed.link !== declaration.distribution.origins.feed || matches.length !== 1) fail("raw appcast does not select one canonical enclosure"); const entry = matches[0], length = Number(entry.length);
  if (Object.keys(entry).length !== ENTRY_FIELDS.length || ENTRY_FIELDS.some((field) => !Object.hasOwn(entry, field)) || !/^(?:0|[1-9][0-9]*)$/.test(entry.length) || !Number.isSafeInteger(length) || length !== guarded.artifactBytes.length || entry.type !== "application/octet-stream" || entry.version !== declaration.version || entry.shortVersionString !== declaration.version || entry.build !== declaration.build || entry.channel !== "stable" || entry.minimumSystemVersion !== tree.bundleMarkers.minimumSystemVersion) fail("selected appcast enclosure identity mismatch");
  const acceptedPublicKey = boundedBytes(acceptedPublicKeyPath, "accepted Sparkle public key").toString("utf8"); if (acceptedPublicKey !== tree.bundleMarkers.publicKey) fail("artifact Sparkle public key does not match accepted release authority");
  const enclosure = buildFeedEnclosureProof({ url: entry.url, version: entry.version, build: entry.build, shortVersionString: entry.shortVersionString, channel: entry.channel, artifactName, artifactSHA256: guarded.artifactSHA256, edSignature: entry.edSignature }, { acceptedPublicKey, signedContent: guarded.artifactBytes });
  const packet = { schemaVersion: 1, kind: KIND, verified: true, channel: declaration.channel, version: declaration.version, build: declaration.build, tag: declaration.tag, sourceSHA, tagObjectSHA, artifactURL, artifactName, artifactByteLength: guarded.artifactBytes.length, artifactSHA256: guarded.artifactSHA256, treeSHA256: tree.treeSHA256, feedSHA256: sha256(rawFeed), feedEntry: Object.fromEntries(ENTRY_FIELDS.map((field) => [field, field === "length" ? length : entry[field]])), enclosureProofSHA256: feedEnclosureProofDigest(enclosure), npmReleaseClass: policy.releaseKind };
  authenticatedPackets.add(packet); return deepFreeze(packet);
}
export function serializeAcceptedDesktopReleasePacket(packet) { if (!authenticatedPackets.has(packet)) fail("packet was not produced by the accepted release producer"); return `${JSON.stringify(Object.fromEntries(FIELDS.map((field) => [field, packet[field]])))}\n`; }
export function acceptedDesktopReleasePacketDigest(packet) { return sha256(Buffer.from(serializeAcceptedDesktopReleasePacket(packet), "utf8")); }
