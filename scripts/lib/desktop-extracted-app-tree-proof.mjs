import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { closeSync, constants, fstatSync, lstatSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, resolve } from "node:path";
import { walkDescriptorTree } from "../shared/safe-fs.mjs";

const SHA1 = /^[a-f0-9]{40}$/, SHA256 = /^[a-f0-9]{64}$/;
const MAX_ENTRIES = 20_000, MAX_BYTES = 512 * 1024 * 1024;
const KIND = "neondiff.desktop.extracted-tree-proof-v1";
const FIELDS = ["schemaVersion", "kind", "verified", "algorithm", "sourceSHA", "artifactSHA256", "treeSHA256", "records", "bundleMarkers"];
const authenticated = new WeakSet();
const foldedPaths = new Map();
const fail = (message) => { throw new Error(message); };
function text(value, label) {
  if (typeof value !== "string" || !value || /[\u0000-\u001f\u007f]/.test(value)) fail(`${label} is malformed`);
  for (let i = 0; i < value.length; i += 1) { const code = value.charCodeAt(i); if (code >= 0xd800 && code <= 0xdfff) { if (code > 0xdbff || i + 1 >= value.length || value.charCodeAt(i + 1) < 0xdc00 || value.charCodeAt(i + 1) > 0xdfff) fail(`${label} has an unpaired surrogate`); i += 1; } }
  return value;
}
function digest(value, label, pattern = SHA256) { const result = text(value, label); if (!pattern.test(result)) fail(`${label} is malformed`); return result; }
function safePath(value, label) {
  const result = text(value, label);
  if (result !== result.normalize("NFC") || result.startsWith("/") || result.includes("\\") || result.split("/").some((part) => !part || part === "." || part === "..")) fail(`${label} is not canonical`);
  return result;
}
function fold(value) {
  const normalized = text(value, "path").normalize("NFKC");
  if (foldedPaths.has(normalized)) return foldedPaths.get(normalized);
  let result;
  if (/^[\x00-\x7f]*$/.test(normalized)) result = normalized.toLowerCase();
  else try { result = execFileSync("/usr/bin/python3", ["-c", "import sys,unicodedata; print(unicodedata.normalize('NFKC',sys.stdin.read()).casefold(),end='')"], { input: normalized, encoding: "utf8", maxBuffer: 1024 * 1024 }); } catch { fail("path case-folding failed closed"); }
  foldedPaths.set(normalized, result); return result;
}
function before(left, right) {
  const a = left.split("/"), b = right.split("/");
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) { const order = Buffer.from(a[i]).compare(Buffer.from(b[i])); if (order) return order < 0; }
  return a.length < b.length;
}
function normalizeRecords(raw) {
  if (!Array.isArray(raw)) fail("tree records are required");
  const count = raw.length; if (count === 0) fail("tree records are required");
  const records = [], seen = new Set(), dirs = new Set([""]); let previous = "";
  for (let i = 0; i < count; i += 1) {
    const item = raw[i]; if (!Array.isArray(item)) fail("tree record must be an array");
    const length = item.length, type = item[0], path = safePath(item[1], "tree record path"), third = item[2], fourth = item[3], fifth = item[4];
    if (i > 0 && !before(previous, path)) fail("tree records are not descriptor ordered");
    const key = fold(path); if (seen.has(key)) fail("tree path collision"); seen.add(key); previous = path;
    const slash = path.lastIndexOf("/"), parent = slash < 0 ? "" : path.slice(0, slash);
    if (type === "dir") { if (length !== 2 || (i > 0 && !dirs.has(parent))) fail("directory topology is invalid"); dirs.add(path); records.push([type, path]); continue; }
    if (!dirs.has(parent)) fail("tree parent topology is invalid");
    if (type === "link") {
      const target = text(third, "symlink target");
      const destination = posix.normalize(posix.join("NeonDiff.app", posix.dirname(path), target));
      if (length !== 3 || target.startsWith("/") || target.includes("\\") || destination !== "NeonDiff.app" && !destination.startsWith("NeonDiff.app/")) fail("symlink target escapes app root");
      records.push([type, path, target]); continue;
    }
    if (type !== "file" || length !== 5 || !["-", "x"].includes(third) || !Number.isSafeInteger(fourth) || fourth < 0 || typeof fifth !== "string" || !SHA256.test(fifth)) fail("file tree record is malformed");
    records.push([type, path, third, fourth, fifth]);
  }
  return records;
}
function treeHash(records) { const hash = createHash("sha256"); for (const record of records) { for (const part of record) { hash.update(String(part), "utf8"); hash.update("\0"); } hash.update("\n"); } return hash.digest("hex"); }
function freeze(value) { if (value && typeof value === "object" && !Object.isFrozen(value)) { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; }
function listArchive(artifact) {
  let listed; try { listed = JSON.parse(execFileSync("/usr/bin/python3", ["-c", "import json,sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); print(json.dumps([[i.filename,i.file_size] for i in z.infolist()]))", artifact], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })); } catch { fail("artifact is not a readable ZIP"); }
  if (!Array.isArray(listed) || listed.length === 0 || listed.length > MAX_ENTRIES) fail("archive entry bound exceeded");
  const seen = new Set(); let total = 0;
  for (let i = 0; i < listed.length; i += 1) { const item = listed[i]; if (!Array.isArray(item) || item.length !== 2 || typeof item[1] !== "number" || !Number.isSafeInteger(item[1]) || item[1] < 0 || (total += item[1]) > MAX_BYTES) fail("archive byte bound exceeded"); const raw = text(item[0], "archive entry"); const name = raw.endsWith("/") ? raw.slice(0, -1) : raw; safePath(name, "archive entry"); if (name !== "NeonDiff.app" && !name.startsWith("NeonDiff.app/")) fail("archive contains data outside NeonDiff.app"); const key = fold(name); if (seen.has(key)) fail("archive entry collision"); seen.add(key); }
}
function markers(bytes) {
  if (bytes.toString("ascii", 0, 8) === "bplist00") fail("binary Info.plist is unsupported");
  let value;
  try { value = JSON.parse(execFileSync("/usr/bin/python3", ["-c", "import json,plistlib,sys,xml.etree.ElementTree as ET; raw=sys.stdin.buffer.read(); d=plistlib.loads(raw); req=('CFBundleIdentifier','CFBundleShortVersionString','CFBundleVersion'); assert isinstance(d,dict) and all(isinstance(d[k],str) for k in req); r=ET.fromstring(raw) if not raw.startswith(b'bplist00') else None; c=list(r[0]) if r is not None and r.tag=='plist' and len(r)==1 and r[0].tag=='dict' else []; keys=[c[i].text or '' for i in range(0,len(c),2)] if len(c)%2==0 and all(c[i].tag=='key' for i in range(0,len(c),2)) else []; assert r is None or len(keys)*2==len(c) and all(keys.count(k)==1 for k in req); print(json.dumps({k:d[k] for k in req}))"], { input: bytes, encoding: "utf8", maxBuffer: 4096 })); } catch { fail("Info.plist is malformed"); }
  const bundleID = text(value.CFBundleIdentifier, "bundle identifier"), version = text(value.CFBundleShortVersionString, "bundle version"), build = text(value.CFBundleVersion, "bundle build");
  if (bundleID !== "com.electricsheephq.NeonDiffDesktop" || !/^1\.1\.0(?:-(?:beta|rc)\.[1-9][0-9]{0,15})?$/.test(version) || !/^\d+$/.test(build)) fail("bundle markers are not canonical");
  return { appPath: "NeonDiff.app", bundleID, version, build };
}
function extracted(app) {
  const records = []; let info;
  walkDescriptorTree(app, (entry) => { const path = safePath(entry.relativePath, "descriptor path"); if (entry.type === "directory") records.push(["dir", path]); else if (entry.type === "symlink") records.push(["link", path, entry.target]); else { if (!Buffer.isBuffer(entry.data)) fail("descriptor file bytes are invalid"); records.push(["file", path, (entry.stat.mode & 0o111) === 0 ? "-" : "x", entry.stat.size, createHash("sha256").update(entry.data).digest("hex")]); if (path === "Contents/Info.plist") info = entry.data; } });
  if (!info) fail("desktop Info.plist is missing");
  const normalized = normalizeRecords(records); return { records: normalized, markers: markers(info) };
}
export function treeProofDigest(records) { return treeHash(normalizeRecords(records)); }
export function buildExtractedAppTreeProof(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("tree proof inputs must be an object");
  const keys = Object.keys(input); if (keys.length !== 2 || !keys.includes("artifactPath") || !keys.includes("sourceSHA")) fail("tree proof inputs have undeclared fields");
  const artifactPath = text(input.artifactPath, "artifact path"), sourceSHA = digest(input.sourceSHA, "source SHA", SHA1);
  const artifact = resolve(artifactPath), descriptor = openSync(artifact, constants.O_RDONLY | constants.O_NOFOLLOW); let bytes;
  try { const before = fstatSync(descriptor); if (!before.isFile()) fail("artifact path must be a regular file"); bytes = readFileSync(descriptor); const after = fstatSync(descriptor); if (bytes.byteLength !== after.size || before.size !== after.size) fail("artifact changed during read"); } finally { closeSync(descriptor); }
  const artifactSHA256 = createHash("sha256").update(bytes).digest("hex");
  const temporary = mkdtempSync(join(tmpdir(), "neondiff-tree-proof-"));
  try { const archive = join(temporary, "artifact.zip"); writeFileSync(archive, bytes, { mode: 0o600 }); listArchive(archive); execFileSync("unzip", ["-q", "-o", archive, "-d", temporary], { maxBuffer: 1024 * 1024 }); const app = join(temporary, "NeonDiff.app"); if (!lstatSync(app).isDirectory()) fail("archive does not contain NeonDiff.app"); const value = extracted(app); const proof = { schemaVersion: 1, kind: KIND, verified: true, algorithm: "sha256-tree-v1", sourceSHA, artifactSHA256, treeSHA256: treeHash(value.records), records: value.records, bundleMarkers: value.markers }; authenticated.add(proof); return freeze(proof); } finally { rmSync(temporary, { recursive: true, force: true }); }
}
export function serializeExtractedAppTreeProof(proof) { if (!authenticated.has(proof)) fail("proof was not produced by the extracted-tree producer"); return `${JSON.stringify(Object.fromEntries(FIELDS.map((field) => [field, proof[field]])))}\n`; }
export function extractedAppTreeProofDigest(proof) { return createHash("sha256").update(serializeExtractedAppTreeProof(proof), "utf8").digest("hex"); }
