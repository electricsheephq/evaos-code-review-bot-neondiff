import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { resolve } from "node:path";

const MAX_BYTES = 512 * 1024 * 1024, MAX_RECORDS = 20_000, MAX_METADATA = 16 * 1024 * 1024, MAX_NODES = 20_000;
const EOCD = 0x06054b50, LOCAL = 0x04034b50, CENTRAL = 0x02014b50, DATA_DESCRIPTOR = 0x08074b50, ZIP64 = "ZIP64 archive unsupported";
const UTF8 = new TextDecoder("utf-8", { fatal: true }), ALLOWED_FLAGS = 0x080e, TYPE_MASK = 0o170000, PATH_OVERRIDE_FIELDS = new Set([0x0008, 0x7075]);
const fail = (message) => { throw new Error(message); };
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

export function buildClassicZipMetadataGraph(artifactPath) {
  if (typeof artifactPath !== "string" || !artifactPath) fail("artifact path is required");
  const guarded = guardClassicZipArchive({ artifactPath }), nodes = new Map(), folded = new Map(); let expandedBytes = 0;
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
