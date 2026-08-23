import { createHash } from "node:crypto";
import { posix } from "node:path";

const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const VERSION = /^1\.1\.0(?:-(?:beta\.[1-9][0-9]{0,3}|rc\.[1-9][0-9]{0,15}))?$/;
const KIND = "neondiff.desktop.extracted-tree-proof-v1";
const INPUT_FIELDS = ["sourceSHA", "artifactSHA256", "records", "bundleMarkers"];
const MARKER_FIELDS = ["appPath", "bundleID", "version", "build"];
const PROOF_FIELDS = ["schemaVersion", "kind", "verified", "algorithm", "sourceSHA", "artifactSHA256", "treeSHA256", "records", "bundleMarkers"];
const authenticated = new WeakSet();
const fail = (message) => { throw new Error(message); };

function exact(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length || keys.some((key) => typeof key !== "string" || !fields.includes(key))) fail(`${label} has undeclared fields`);
  return value;
}
function text(value, label) {
  if (typeof value !== "string" || !value || /[\u0000-\u001f\u007f]/.test(value)) fail(`${label} is malformed`);
  return value;
}
function digest(value, label, pattern = SHA256) {
  const result = text(value, label);
  if (!pattern.test(result)) fail(`${label} is malformed`);
  return result;
}
function hash(value) { return createHash("sha256").update(value, "utf8").digest("hex"); }

// NFC keeps descriptor bytes canonical; NFKC plus the explicit expansions is a
// locale-independent case-fold identity for the macOS case-insensitive target.
function macOSCaseFoldIdentity(value) {
  return value.normalize("NFC").normalize("NFKC").toLowerCase()
    .replace(/\u00df/g, "ss").replace(/\u03c2/g, "\u03c3");
}
function safePath(value, label) {
  const result = text(value, label);
  if (result !== result.normalize("NFC") || result.startsWith("/") || result.includes("\\") || result.split("/").some((part) => !part || part === "." || part === "..")) fail(`${label} is not canonical`);
  return result;
}
function canonicalRecords(rawRecords) {
  if (!Array.isArray(rawRecords) || rawRecords.length === 0) fail("tree records are required");
  const seen = new Set(); let previous = "";
  const records = rawRecords.map((raw) => {
    if (!Array.isArray(raw)) fail("tree record must be an array");
    const parts = [...raw], type = parts[0], path = safePath(parts[1], "tree record path");
    if (seen.has(macOSCaseFoldIdentity(path)) || path <= previous) fail("tree records are not canonical");
    seen.add(macOSCaseFoldIdentity(path)); previous = path;
    if (!["dir", "file", "link"].includes(type)) fail("tree record type is invalid");
    if (type === "dir" && parts.length !== 2) fail("directory tree record is malformed");
    if (type === "link") {
      const target = text(parts[2], "symlink target");
      const resolved = posix.normalize(posix.join(posix.dirname(path), target));
      if (parts.length !== 3 || !target || target !== target.normalize("NFC") || target.startsWith("/") || target.includes("\\") || resolved !== "NeonDiff.app" && !resolved.startsWith("NeonDiff.app/")) fail("symlink escapes app root");
    }
    if (type === "file" && (parts.length !== 5 || !["-", "x"].includes(parts[2]) || !Number.isSafeInteger(parts[3]) || parts[3] < 0 || typeof parts[4] !== "string" || !SHA256.test(parts[4]))) fail("file tree record is malformed");
    return parts;
  });
  if (records[0][0] !== "dir" || records[0][1] !== "NeonDiff.app" || records.some((record) => record[1] !== "NeonDiff.app" && !record[1].startsWith("NeonDiff.app/"))) fail("tree does not describe the required app bundle");
  return records;
}
function treeHash(records) {
  const digest = createHash("sha256");
  for (const record of canonicalRecords(records)) { for (const part of record) { digest.update(String(part), "utf8"); digest.update("\0"); } digest.update("\n"); }
  return digest.digest("hex");
}
function readMarkers(raw) {
  const value = exact(raw, MARKER_FIELDS, "bundle markers");
  const appPath = text(value.appPath, "app path"), bundleID = text(value.bundleID, "bundle ID"), version = text(value.version, "bundle version"), build = text(value.build, "bundle build");
  if (appPath !== "NeonDiff.app" || bundleID !== "com.electricsheephq.NeonDiffDesktop" || !VERSION.test(version) || !/^[0-9]+$/.test(build) || !Number.isSafeInteger(Number(build))) fail("bundle markers are not canonical");
  return { appPath, bundleID, version, build };
}
function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

export function treeProofDigest(records) { return treeHash(records); }
export function buildExtractedAppTreeProof(input) {
  const value = exact(input, INPUT_FIELDS, "tree proof inputs");
  const sourceSHA = digest(value.sourceSHA, "source SHA", SHA1), artifactSHA256 = digest(value.artifactSHA256, "artifact SHA-256");
  const records = canonicalRecords(value.records), bundleMarkers = readMarkers(value.bundleMarkers);
  const proof = { schemaVersion: 1, kind: KIND, verified: true, algorithm: "sha256-tree-v1", sourceSHA, artifactSHA256, treeSHA256: treeHash(records), records, bundleMarkers };
  authenticated.add(proof); return freeze(proof);
}
export function serializeExtractedAppTreeProof(proof) {
  if (!authenticated.has(proof)) fail("proof was not produced by the extracted-tree producer");
  return `${JSON.stringify(Object.fromEntries(PROOF_FIELDS.map((field) => [field, proof[field]])))}\n`;
}
export function extractedAppTreeProofDigest(proof) { return hash(serializeExtractedAppTreeProof(proof)); }
