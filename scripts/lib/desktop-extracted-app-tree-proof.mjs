import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { resolve } from "node:path";

const MAX_BYTES = 512 * 1024 * 1024, MAX_RECORDS = 20_000, MAX_METADATA = 16 * 1024 * 1024;
const EOCD = 0x06054b50, LOCAL = 0x04034b50, CENTRAL = 0x02014b50, ZIP64 = "ZIP64 archive unsupported";
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
