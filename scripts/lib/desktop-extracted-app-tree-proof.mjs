import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, closeSync, constants, createWriteStream, fstatSync, mkdirSync, mkdtempSync, openSync, readSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, resolve } from "node:path";
import { PassThrough, Readable, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createInflateRaw, crc32 } from "node:zlib";
import { walkDescriptorTree } from "../shared/safe-fs.mjs";

const MAX_BYTES = 512 * 1024 * 1024, MAX_RECORDS = 20_000, MAX_METADATA = 16 * 1024 * 1024, MAX_NODES = 20_000;
const EOCD = 0x06054b50, LOCAL = 0x04034b50, CENTRAL = 0x02014b50, DATA_DESCRIPTOR = 0x08074b50, ZIP64 = "ZIP64 archive unsupported";
const UTF8 = new TextDecoder("utf-8", { fatal: true }), ALLOWED_FLAGS = 0x080e, TYPE_MASK = 0o170000, PATH_OVERRIDE_FIELDS = new Set([0x0008, 0x7075]);
const fail = (message) => { throw new Error(message); };
const SHA1 = /^[a-f0-9]{40}$/, SHA256 = /^[a-f0-9]{64}$/, TREE_KIND = "neondiff.desktop.extracted-tree-proof-v1";
const TREE_FIELDS = ["schemaVersion", "kind", "verified", "algorithm", "sourceSHA", "artifactSHA256", "artifactByteLength", "treeSHA256", "records", "bundleMarkers", "appleDouble"];
const authenticatedTreeProofs = new WeakSet();
const PLIST_PARSER = String.raw`
import json, plistlib, re, sys, xml.etree.ElementTree as ET
raw = sys.stdin.buffer.read(1048577)
if len(raw) > 1048576 or raw.startswith(b"bplist00"):
    raise ValueError("unsupported plist")
try:
    text = raw.decode("utf-8")
except UnicodeDecodeError:
    raise ValueError("unsupported plist encoding")
declaration = re.match(r"^\s*<\?xml\s+[^?]*\?>", text, re.IGNORECASE)
encoding = re.search(r"\bencoding\s*=\s*(['\"])([^'\"]+)\1", declaration.group(0), re.IGNORECASE) if declaration else None
if encoding and encoding.group(2).lower() != "utf-8":
    raise ValueError("unsupported plist encoding")
doctype = '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
if text.startswith("\ufeff") or "\x00" in text or "<!ENTITY" in text or ("<!DOCTYPE" in text and (text.count("<!DOCTYPE") != 1 or text.count(doctype) != 1)):
    raise ValueError("unsupported plist declaration")
root = ET.fromstring(text)
if root.tag != "plist" or len(root) != 1 or root[0].tag != "dict":
    raise ValueError("invalid plist root")
def unique(node):
    if node.tag == "dict":
        children = list(node)
        if len(children) % 2:
            raise ValueError("invalid plist dictionary")
        seen = set()
        for index in range(0, len(children), 2):
            key, value = children[index], children[index + 1]
            if key.tag != "key" or (key.text or "") in seen:
                raise ValueError("duplicate or invalid plist key")
            seen.add(key.text or "")
            unique(value)
    elif node.tag == "array":
        for value in node:
            unique(value)
unique(root[0])
value = plistlib.loads(raw)
required = ("CFBundleIdentifier", "CFBundleShortVersionString", "CFBundleVersion", "LSMinimumSystemVersion", "SUFeedURL", "SUPublicEDKey")
if not isinstance(value, dict):
    raise ValueError("invalid plist dictionary")
result = {}
for key in required:
    item = value.get(key)
    if not isinstance(item, str) or not item or len(item.encode("utf-8")) > 128:
        raise ValueError("invalid plist marker")
    result[key] = item
result["productionContract"] = value.get("NeonDiffPaidBetaContract")
result["byoGitHubEnabled"] = value.get("NeonDiffBYOGitHubEnabled")
result["hasManagedGitHubBrokerEnabled"] = "NeonDiffManagedGitHubBrokerEnabled" in value
result["hasGitHubBrokerOrigin"] = "NeonDiffGitHubBrokerOrigin" in value
sys.stdout.write(json.dumps(result, separators=(",", ":")))
`;
function artifactBytes(descriptor) {
  const before = fstatSync(descriptor);
  if (!before.isFile() || before.size > MAX_BYTES) fail("artifact bytes exceed bound");
  const chunks = [], buffer = Buffer.allocUnsafe(1024 * 1024); let total = 0, count;
  do { count = readSync(descriptor, buffer, 0, buffer.length, null); if (count) { total += count; if (total > MAX_BYTES) fail("artifact bytes exceed bound"); chunks.push(Buffer.from(buffer.subarray(0, count))); } } while (count);
  const after = fstatSync(descriptor);
  if (!after.isFile() || before.size !== after.size || total !== after.size) fail("artifact changed during read");
  return Buffer.concat(chunks, total);
}
function eocdOffset(bytes) {
  const first = Math.max(0, bytes.length - 22 - 0xffff);
  let found = -1;
  for (let offset = bytes.length - 22; offset >= first; offset -= 1) if (bytes.readUInt32LE(offset) === EOCD && offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length) { if (found !== -1) fail("malformed EOCD"); found = offset; }
  if (found < 0) fail("malformed EOCD"); return found;
}
function guardCentralDirectory(bytes) {
  if (bytes.length < 22) fail("malformed EOCD");
  const eocd = eocdOffset(bytes), disk = bytes.readUInt16LE(eocd + 4), directoryDisk = bytes.readUInt16LE(eocd + 6), recordsOnDisk = bytes.readUInt16LE(eocd + 8), records = bytes.readUInt16LE(eocd + 10), size = bytes.readUInt32LE(eocd + 12), offset = bytes.readUInt32LE(eocd + 16);
  if (recordsOnDisk === 0xffff || records === 0xffff || size === 0xffffffff || offset === 0xffffffff) fail(ZIP64);
  if (disk !== 0 || directoryDisk !== 0 || recordsOnDisk !== records) fail("multi-disk archive unsupported");
  if (records > MAX_RECORDS) fail("archive entry bound exceeded");
  if (size > MAX_METADATA) fail("central metadata bound exceeded");
  if (offset > eocd || size > eocd - offset || offset + size !== eocd) fail("central directory range invalid");
  let cursor = offset;
  for (let index = 0; index < records; index += 1) {
    if (cursor + 46 > eocd || bytes.readUInt32LE(cursor) !== CENTRAL) fail("central directory malformed");
    const name = bytes.readUInt16LE(cursor + 28), extra = bytes.readUInt16LE(cursor + 30), comment = bytes.readUInt16LE(cursor + 32), recordSize = 46 + name + extra + comment, entryDisk = bytes.readUInt16LE(cursor + 34), compressed = bytes.readUInt32LE(cursor + 20), expanded = bytes.readUInt32LE(cursor + 24), localOffset = bytes.readUInt32LE(cursor + 42);
    if (entryDisk === 0xffff || compressed === 0xffffffff || expanded === 0xffffffff || localOffset === 0xffffffff) fail(ZIP64);
    if (entryDisk !== 0) fail("multi-disk archive unsupported");
    if (recordSize > eocd - cursor || localOffset >= offset || localOffset + 30 > offset || bytes.readUInt32LE(localOffset) !== LOCAL) fail("central directory range invalid");
    const localName = bytes.readUInt16LE(localOffset + 26), localExtra = bytes.readUInt16LE(localOffset + 28);
    if (localOffset + 30 + localName + localExtra + compressed > offset) fail("central directory range invalid");
    cursor += recordSize;
  }
  if (cursor !== eocd) fail("central directory malformed");
  return { recordCount: records, centralDirectoryOffset: offset, centralDirectorySize: size, eocdOffset: eocd };
}
export function guardClassicZipArchive(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== 1 || !Object.hasOwn(input, "artifactPath") || typeof input.artifactPath !== "string" || !input.artifactPath) fail("archive inputs are malformed");
  const descriptor = openSync(resolve(input.artifactPath), constants.O_RDONLY | constants.O_NOFOLLOW); let bytes;
  try { bytes = artifactBytes(descriptor); } finally { closeSync(descriptor); }
  const envelope = guardCentralDirectory(bytes);
  return Object.freeze({ ...envelope, artifactBytes: bytes, artifactSHA256: createHash("sha256").update(bytes).digest("hex") });
}
export const readBoundedClassicZip = guardClassicZipArchive;

function entryPath(nameBytes, flags, type) {
  if (!(flags & 0x800) && nameBytes.some((byte) => byte > 0x7f)) fail("archive path encoding unsupported");
  let raw;
  try { raw = UTF8.decode(nameBytes); } catch { fail("archive path encoding unsupported"); }
  const directory = raw.endsWith("/");
  if (!raw || !Buffer.from(raw, "utf8").equals(nameBytes) || /[\\\u0000-\u001f\u007f]/.test(raw) || raw.startsWith("/") || /^[A-Za-z]:/.test(raw)) fail("unsafe archive path");
  if ((type === "directory") !== directory) fail("directory path/type mismatch");
  const path = directory ? raw.slice(0, -1) : raw, parts = path.split("/");
  if (!["NeonDiff.app", "__MACOSX"].includes(parts[0]) || parts[0] === "__MACOSX" && parts.length > 1 && !["NeonDiff.app", "._NeonDiff.app"].includes(parts[1]) || parts.some((part) => !part || part === "." || part === ".." || Buffer.byteLength(part, "utf8") > 255)) fail("unsafe archive path");
  return { path, parts };
}
function caseless(part) {
  const normalized = part.normalize("NFC"), lower = normalized.toLowerCase();
  if (lower.toUpperCase().toLowerCase() !== lower) fail("unsupported caseless archive path");
  return lower.normalize("NFC");
}
function rejectPathOverrideFields(bytes, offset, length) {
  const end = offset + length;
  while (offset < end) {
    if (offset + 4 > end) fail("malformed ZIP extra field");
    const id = bytes.readUInt16LE(offset), size = bytes.readUInt16LE(offset + 2); offset += 4;
    if (size > end - offset) fail("malformed ZIP extra field");
    if (PATH_OVERRIDE_FIELDS.has(id)) fail("path-overriding ZIP extra field"); offset += size;
  }
}
function parseMetadataRecords(guarded) {
  const { artifactBytes: bytes, centralDirectoryOffset: start, eocdOffset: end, recordCount } = guarded, records = [];
  let cursor = start;
  for (let index = 0; index < recordCount; index += 1) {
    const madeBy = bytes.readUInt16LE(cursor + 4), host = madeBy >>> 8, flags = bytes.readUInt16LE(cursor + 8), method = bytes.readUInt16LE(cursor + 10), crc32 = bytes.readUInt32LE(cursor + 16), compressedSize = bytes.readUInt32LE(cursor + 20), uncompressedSize = bytes.readUInt32LE(cursor + 24), nameLength = bytes.readUInt16LE(cursor + 28), extraLength = bytes.readUInt16LE(cursor + 30), commentLength = bytes.readUInt16LE(cursor + 32), external = bytes.readUInt32LE(cursor + 38), localOffset = bytes.readUInt32LE(cursor + 42);
    if (![3, 19].includes(host)) fail("unsupported archive host attributes");
    if (flags & ~ALLOWED_FLAGS || method === 0 && flags & 0x6 || ![0, 8].includes(method)) fail("encrypted or unsupported ZIP flags");
    const mode = external >>> 16, kind = mode & TYPE_MASK, type = kind === 0o040000 ? "directory" : kind === 0o100000 ? "file" : kind === 0o120000 ? "symlink" : null;
    if (!type) fail("unsupported archive entry type");
    if (method === 0 && compressedSize !== uncompressedSize) fail("stored entry size mismatch");
    if (type === "directory" && (compressedSize !== 0 || uncompressedSize !== 0)) fail("directory entry contains data");
    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameLength), localFlags = bytes.readUInt16LE(localOffset + 6), localMethod = bytes.readUInt16LE(localOffset + 8), localCRC = bytes.readUInt32LE(localOffset + 14), localCompressed = bytes.readUInt32LE(localOffset + 18), localExpanded = bytes.readUInt32LE(localOffset + 22), localNameLength = bytes.readUInt16LE(localOffset + 26), localExtraLength = bytes.readUInt16LE(localOffset + 28), localName = bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength);
    rejectPathOverrideFields(bytes, cursor + 46 + nameLength, extraLength); rejectPathOverrideFields(bytes, localOffset + 30 + localNameLength, localExtraLength);
    const descriptor = Boolean(flags & 0x8), localIdentityMismatch = descriptor ? localCRC !== 0 || localCompressed !== 0 || localExpanded !== 0 : localCRC !== crc32 || localCompressed !== compressedSize || localExpanded !== uncompressedSize;
    if (localFlags !== flags || localMethod !== method || !localName.equals(nameBytes) || localIdentityMismatch) fail("local/central metadata mismatch");
    const { path, parts } = entryPath(nameBytes, flags, type), dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    let descriptorSize = 0;
    if (descriptor) {
      const dataEnd = dataOffset + compressedSize, candidates = [];
      if (dataEnd + 12 <= start && bytes.readUInt32LE(dataEnd) === crc32 && bytes.readUInt32LE(dataEnd + 4) === compressedSize && bytes.readUInt32LE(dataEnd + 8) === uncompressedSize) candidates.push(12);
      if (dataEnd + 16 <= start && bytes.readUInt32LE(dataEnd) === DATA_DESCRIPTOR && bytes.readUInt32LE(dataEnd + 4) === crc32 && bytes.readUInt32LE(dataEnd + 8) === compressedSize && bytes.readUInt32LE(dataEnd + 12) === uncompressedSize) candidates.push(16);
      if (candidates.length !== 1) fail("data descriptor mismatch"); descriptorSize = candidates[0];
    }
    records.push({ path, parts, type, mode: mode & 0o7777, compressionMethod: method, compressedSize, uncompressedSize, crc32, localHeaderOffset: localOffset, dataOffset, descriptorSize, rangeEnd: dataOffset + compressedSize + descriptorSize, explicit: true });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  if (cursor !== end) fail("central directory malformed");
  const ranges = [...records].sort((left, right) => left.localHeaderOffset - right.localHeaderOffset);
  if (ranges.some((record, index) => index && record.localHeaderOffset < ranges[index - 1].rangeEnd)) fail("overlapping local entry ranges");
  return records;
}

function buildClassicZipMetadataGraphFromGuarded(guarded) {
  const nodes = new Map(), folded = new Map(); let expandedBytes = 0;
  for (const entry of parseMetadataRecords(guarded)) {
    if (entry.type !== "directory" && (expandedBytes += entry.uncompressedSize) > MAX_BYTES) fail("expanded byte bound exceeded");
    let path = "", identity = "";
    for (let index = 0; index < entry.parts.length; index += 1) {
      path += `${index ? "/" : ""}${entry.parts[index]}`; identity += `${index ? "/" : ""}${caseless(entry.parts[index])}`;
      const collision = folded.get(identity); if (collision && collision !== path) fail("archive path collision"); folded.set(identity, path);
      const leaf = index === entry.parts.length - 1, type = leaf ? entry.type : "directory", existing = nodes.get(path);
      if (existing && existing.type !== type) fail(leaf ? "archive path type conflict" : "archive parent is not a directory");
      if (existing && leaf && existing.explicit) fail("duplicate archive path");
      if (!existing || leaf && !existing.explicit) {
        if (!existing && nodes.size >= MAX_NODES) fail("metadata node bound exceeded");
        nodes.set(path, leaf ? { ...entry, path } : { path, type: "directory", mode: 0o755, compressionMethod: 0, compressedSize: 0, uncompressedSize: 0, crc32: 0, localHeaderOffset: null, dataOffset: null, descriptorSize: 0, rangeEnd: null, explicit: false });
      }
    }
  }
  if (nodes.get("NeonDiff.app")?.type !== "directory") fail("archive app root is missing");
  for (const record of nodes.values()) {
    if (record.path === "__MACOSX" && record.type !== "directory") fail("unsupported AppleDouble root");
    if (!record.explicit || record.type === "directory" || !record.path.startsWith("__MACOSX/")) continue;
    if (record.type !== "file") fail("unsupported AppleDouble entry type");
    const parts = record.path.slice("__MACOSX/".length).split("/"), leaf = parts.pop();
    if (!leaf.startsWith("._") || leaf.length === 2) fail("unsupported AppleDouble entry");
    parts.push(leaf.slice(2)); const target = parts.join("/");
    if (!nodes.has(target)) fail("orphan AppleDouble entry"); record.sidecarTarget = target;
  }
  const records = [...nodes.values()].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0).map(({ parts: _parts, rangeEnd: _rangeEnd, ...record }) => Object.freeze(record));
  return Object.freeze({ kind: "neondiff.desktop.classic-zip-metadata-graph-v1", artifactSHA256: guarded.artifactSHA256, artifactByteLength: guarded.artifactBytes.length, expandedByteLength: expandedBytes, records: Object.freeze(records) });
}

export function buildClassicZipMetadataGraph(artifactPath) {
  if (typeof artifactPath !== "string" || !artifactPath) fail("artifact path is required");
  return buildClassicZipMetadataGraphFromGuarded(guardClassicZipArchive({ artifactPath }));
}

function materializedPath(root, path) {
  const destination = resolve(root, path);
  if (!destination.startsWith(`${root}/`)) fail("unsafe materialized path");
  return destination;
}
async function pipeVerifiedEntry(guarded, record, destination, aggregate) {
  let actual = 0, checksum = 0;
  const end = record.dataOffset + record.compressedSize, source = Readable.from((function* () { for (let offset = record.dataOffset; offset < end; offset += 64 * 1024) yield guarded.artifactBytes.subarray(offset, Math.min(end, offset + 64 * 1024)); })());
  const verifier = new Transform({ transform(chunk, _encoding, callback) {
    actual += chunk.length; aggregate.value += chunk.length;
    if (actual > record.uncompressedSize) return callback(new Error("expanded entry size mismatch"));
    if (aggregate.value > MAX_BYTES) return callback(new Error("expanded byte bound exceeded"));
    checksum = crc32(chunk, checksum); callback(null, chunk);
  } });
  await pipeline(source, record.compressionMethod === 8 ? createInflateRaw({ rejectGarbageAfterEnd: true }) : new PassThrough(), verifier, destination);
  if (actual !== record.uncompressedSize) fail("expanded entry size mismatch");
  if ((checksum >>> 0) !== record.crc32) fail("CRC-32 mismatch");
}
function verifyGraphSymlink(path, target, byPath, linkTargets) {
  let candidate = posix.normalize(posix.join(posix.dirname(path), target)); const seen = new Set();
  while (true) {
    if (candidate !== "NeonDiff.app" && !candidate.startsWith("NeonDiff.app/")) fail("unsafe symlink target");
    const parts = candidate.split("/"); let link = null, suffix = [];
    for (let index = 1; index <= parts.length; index += 1) { const prefix = parts.slice(0, index).join("/"); if (linkTargets.has(prefix)) { link = prefix; suffix = parts.slice(index); break; } }
    if (!link) { if (!byPath.has(candidate)) fail("missing symlink target"); return; }
    if (seen.has(link)) fail("symlink cycle"); seen.add(link);
    candidate = posix.normalize(posix.join(posix.dirname(link), linkTargets.get(link), ...suffix));
  }
}

export async function withMaterializedClassicZipApp(artifactPath, consumer) {
  if (typeof artifactPath !== "string" || !artifactPath || typeof consumer !== "function") fail("materialization inputs are malformed");
  const guarded = guardClassicZipArchive({ artifactPath }), graph = buildClassicZipMetadataGraphFromGuarded(guarded), byPath = new Map(graph.records.map((record) => [record.path, record]));
  if (graph.records.some((record) => record.mode & 0o7000)) fail("special permission bits unsupported");
  const root = mkdtempSync(join(tmpdir(), "neondiff-materialized-")), directories = graph.records.filter((record) => record.type === "directory"), aggregate = { value: 0 };
  chmodSync(root, 0o700);
  try {
    for (const record of directories) mkdirSync(materializedPath(root, record.path), { mode: 0o700 });
    for (const record of graph.records.filter((candidate) => candidate.type === "file")) {
      const destination = materializedPath(root, record.path);
      await pipeVerifiedEntry(guarded, record, createWriteStream(destination, { flags: constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, mode: 0o600 }), aggregate);
      chmodSync(destination, record.mode & 0o777);
    }
    const symlinks = graph.records.filter((candidate) => candidate.type === "symlink"), linkTargets = new Map();
    for (const record of symlinks) {
      if (record.uncompressedSize > 4096) fail("symlink target too large");
      const chunks = []; await pipeVerifiedEntry(guarded, record, new Writable({ write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } }), aggregate);
      const bytes = Buffer.concat(chunks); let target;
      try { target = UTF8.decode(bytes); } catch { fail("unsafe symlink target"); }
      if (!target || bytes.includes(0) || !Buffer.from(target, "utf8").equals(bytes) || posix.isAbsolute(target)) fail("unsafe symlink target");
      linkTargets.set(record.path, target);
    }
    for (const record of symlinks) verifyGraphSymlink(record.path, linkTargets.get(record.path), byPath, linkTargets);
    for (const record of symlinks) symlinkSync(linkTargets.get(record.path), materializedPath(root, record.path));
    for (const record of [...directories].reverse()) chmodSync(materializedPath(root, record.path), record.mode & 0o777);
    return await consumer(materializedPath(root, "NeonDiff.app"), graph);
  } finally {
    for (const record of directories) { try { chmodSync(materializedPath(root, record.path), 0o700); } catch {} }
    rmSync(root, { recursive: true, force: true });
  }
}

function proofText(value, label) {
  if (typeof value !== "string" || !value || /[\\\u0000-\u001f\u007f]/.test(value) || value.startsWith("/") || value.split("/").some((part) => !part || part === "." || part === "..")) fail(`${label} is malformed`);
  for (let index = 0; index < value.length; index += 1) { const code = value.charCodeAt(index); if (code >= 0xd800 && code <= 0xdfff) { if (code > 0xdbff || index + 1 >= value.length || value.charCodeAt(index + 1) < 0xdc00 || value.charCodeAt(index + 1) > 0xdfff) fail(`${label} is malformed`); index += 1; } }
  return value;
}
function proofTarget(value) {
  if (typeof value !== "string" || !value || /[\\\u0000-\u001f\u007f]/.test(value)) fail("symlink target is malformed");
  for (let index = 0; index < value.length; index += 1) { const code = value.charCodeAt(index); if (code >= 0xd800 && code <= 0xdfff) { if (code > 0xdbff || index + 1 >= value.length || value.charCodeAt(index + 1) < 0xdc00 || value.charCodeAt(index + 1) > 0xdfff) fail("symlink target is malformed"); index += 1; } }
  return value;
}
function proofPathIdentity(path) {
  return path.split("/").map((part) => { const normalized = part.normalize("NFKC"), lower = normalized.toLowerCase(); if (lower.toUpperCase().toLowerCase() !== lower) fail("unsupported caseless tree path"); return lower.normalize("NFKC"); }).join("/");
}
function treeDigest(records) {
  const digest = createHash("sha256");
  for (const record of records) { for (const part of record) { digest.update(String(part), "utf8"); digest.update("\0"); } digest.update("\n"); }
  return digest.digest("hex");
}
function appTree(appPath) {
  const records = [], directories = new Set([""]), identities = new Map(); let aggregate = 0, infoPlist;
  walkDescriptorTree(appPath, (entry) => {
    if (records.length >= MAX_NODES) fail("tree record bound exceeded");
    const path = proofText(entry.relativePath, "tree path"), identity = proofPathIdentity(path), collision = identities.get(identity);
    if (path.split("/").some((part) => part.startsWith("._"))) fail("AppleDouble sidecars are unsupported inside the app tree");
    if (collision && collision !== path) fail("tree path collision"); identities.set(identity, path);
    const slash = path.lastIndexOf("/"), parent = slash < 0 ? "" : path.slice(0, slash);
    if (!directories.has(parent)) fail("tree parent topology is invalid");
    if (entry.type === "directory") { directories.add(path); records.push(["dir", path]); return; }
    if (entry.type === "symlink") {
      const target = proofTarget(entry.target), destination = posix.normalize(posix.join(posix.dirname(path), target));
      if (posix.isAbsolute(target) || destination === ".." || destination.startsWith("../")) fail("symlink target escapes app root");
      records.push(["link", path, target]); return;
    }
    if (!Buffer.isBuffer(entry.data) || !Number.isSafeInteger(entry.stat.size) || entry.stat.size !== entry.data.length || (aggregate += entry.data.length) > MAX_BYTES) fail("tree file bytes are invalid");
    const fileSHA = createHash("sha256").update(entry.data).digest("hex"); if (!SHA256.test(fileSHA)) fail("tree file digest is invalid");
    records.push(["file", path, (entry.stat.mode & 0o111) === 0 ? "-" : "x", entry.stat.size, fileSHA]);
    if (path === "Contents/Info.plist") { if (infoPlist) fail("desktop Info.plist is duplicated"); infoPlist = entry.data; }
  });
  if (!infoPlist) fail("desktop Info.plist is missing");
  return { records, infoPlist };
}
function plistMarkers(bytes) {
  const parsed = spawnSync("/usr/bin/python3", ["-I", "-c", PLIST_PARSER], { input: bytes, encoding: "utf8", maxBuffer: 4096 }); let value;
  try { if (parsed.status !== 0) fail("desktop Info.plist is malformed"); value = JSON.parse(parsed.stdout); } catch { fail("desktop Info.plist is malformed"); }
  const bundleID = value.CFBundleIdentifier, version = value.CFBundleShortVersionString, build = value.CFBundleVersion, minimumSystemVersion = value.LSMinimumSystemVersion, feedURL = value.SUFeedURL, publicKey = value.SUPublicEDKey;
  if (bundleID !== "com.electricsheephq.NeonDiffDesktop" || !/^1\.1\.0(?:-(?:beta|rc)\.[1-9][0-9]{0,15})?$/.test(version) || !/^[0-9]{1,32}$/.test(build)) fail("bundle markers are not canonical");
  if (value.productionContract !== "paid-mac-beta-byo-v1" || value.byoGitHubEnabled !== true || value.hasManagedGitHubBrokerEnabled !== false || value.hasGitHubBrokerOrigin !== false) fail("bundle production contract is not canonical");
  const expectedFeed = version === "1.1.0" ? "https://www.neondiff.com/updates/stable/appcast.xml" : "https://www.neondiff.com/updates/beta/appcast.xml", decodedKey = Buffer.from(publicKey, "base64");
  if (!/^\d+(?:\.\d+){1,2}$/.test(minimumSystemVersion)) fail("bundle minimum system version is not canonical");
  if (feedURL !== expectedFeed || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(publicKey) || decodedKey.length !== 32 || decodedKey.toString("base64") !== publicKey) fail("bundle updater markers are not canonical");
  return { appPath: "NeonDiff.app", bundleID, version, build, minimumSystemVersion, feedURL, publicKey };
}
function deepFreeze(value) { if (value && typeof value === "object" && !Object.isFrozen(value)) { for (const child of Object.values(value)) deepFreeze(child); Object.freeze(value); } return value; }

export async function buildExtractedAppTreeProof(artifactPath, sourceSHA) {
  if (typeof artifactPath !== "string" || !artifactPath) fail("artifact path is malformed");
  if (typeof sourceSHA !== "string" || !SHA1.test(sourceSHA)) fail("source SHA is malformed");
  return withMaterializedClassicZipApp(artifactPath, (appPath, graph) => {
    const { records, infoPlist } = appTree(appPath), proof = { schemaVersion: 1, kind: TREE_KIND, verified: true, algorithm: "sha256-tree-v1", sourceSHA, artifactSHA256: graph.artifactSHA256, artifactByteLength: graph.artifactByteLength, treeSHA256: treeDigest(records), records, bundleMarkers: plistMarkers(infoPlist), appleDouble: { policy: "artifact-bound-excluded-from-tree-v1", entryCount: graph.records.filter((record) => typeof record.sidecarTarget === "string").length } };
    authenticatedTreeProofs.add(proof); return deepFreeze(proof);
  });
}
export function serializeExtractedAppTreeProof(proof) {
  if (!authenticatedTreeProofs.has(proof)) fail("proof was not produced by the extracted-tree producer");
  return `${JSON.stringify(Object.fromEntries(TREE_FIELDS.map((field) => [field, proof[field]])))}\n`;
}
export function extractedAppTreeProofDigest(proof) { return createHash("sha256").update(serializeExtractedAppTreeProof(proof), "utf8").digest("hex"); }
