import { inflateSync } from "node:zlib";

const signature = Buffer.from("89504e470d0a1a0a", "hex");
const maximumDecodedBytes = 64 * 1024 * 1024;

export function readCompletePngDimensions(data) {
  if (!Buffer.isBuffer(data) || data.length < 57 || !data.subarray(0, 8).equals(signature)) {
    throw new Error("invalid PNG signature or truncated structure");
  }

  let offset = 8;
  let ihdr;
  let paletteSeen = false;
  let idatSeen = false;
  let idatFinished = false;
  let iendSeen = false;
  let chunks = 0;
  const compressed = [];

  while (offset < data.length) {
    if (data.length - offset < 12 || ++chunks > 10_000) throw new Error("invalid PNG chunk structure");
    const length = data.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > data.length) throw new Error("truncated PNG chunk");
    const typeBytes = data.subarray(offset + 4, offset + 8);
    const type = typeBytes.toString("ascii");
    if (!/^[A-Za-z]{4}$/.test(type)) throw new Error("invalid PNG chunk type");
    const chunkData = data.subarray(offset + 8, offset + 8 + length);
    const expectedCrc = data.readUInt32BE(offset + 8 + length);
    if (crc32(Buffer.concat([typeBytes, chunkData])) !== expectedCrc) throw new Error("invalid PNG chunk CRC");

    if (chunks === 1 && type !== "IHDR") throw new Error("PNG IHDR must be first");
    if (type === "IHDR") {
      if (ihdr || length !== 13) throw new Error("invalid PNG IHDR");
      ihdr = parseIhdr(chunkData);
    } else if (!ihdr) {
      throw new Error("PNG data precedes IHDR");
    } else if (type === "PLTE") {
      if (idatSeen || length === 0 || length % 3 !== 0 || length > 768) throw new Error("invalid PNG palette");
      paletteSeen = true;
    } else if (type === "IDAT") {
      if (idatFinished || length === 0) throw new Error("invalid PNG IDAT sequence");
      idatSeen = true;
      compressed.push(chunkData);
    } else if (type === "IEND") {
      if (length !== 0 || !idatSeen || end !== data.length) throw new Error("invalid PNG IEND");
      iendSeen = true;
    } else {
      if (idatSeen) idatFinished = true;
      if ((typeBytes[0] & 0x20) === 0) throw new Error(`unsupported critical PNG chunk: ${type}`);
    }
    offset = end;
    if (iendSeen) break;
  }

  if (!ihdr || !idatSeen || !iendSeen || offset !== data.length) throw new Error("incomplete PNG structure");
  if (ihdr.colorType === 3 && !paletteSeen) throw new Error("indexed PNG is missing a palette");
  validateDecodedImage(ihdr, Buffer.concat(compressed));
  return { width: ihdr.width, height: ihdr.height };
}

function parseIhdr(data) {
  const width = data.readUInt32BE(0);
  const height = data.readUInt32BE(4);
  const bitDepth = data[8];
  const colorType = data[9];
  const validDepths = new Map([
    [0, [1, 2, 4, 8, 16]],
    [2, [8, 16]],
    [3, [1, 2, 4, 8]],
    [4, [8, 16]],
    [6, [8, 16]]
  ]);
  if (width < 1 || height < 1
    || !validDepths.get(colorType)?.includes(bitDepth)
    || data[10] !== 0 || data[11] !== 0 || data[12] !== 0) {
    throw new Error("unsupported PNG image format");
  }
  const channels = new Map([[0, 1], [2, 3], [3, 1], [4, 2], [6, 4]]).get(colorType);
  const rowBytes = Math.ceil(width * channels * bitDepth / 8);
  const decodedBytes = height * (rowBytes + 1);
  if (!Number.isSafeInteger(decodedBytes) || decodedBytes > maximumDecodedBytes) {
    throw new Error("PNG decoded image exceeds evidence bounds");
  }
  return { width, height, bitDepth, colorType, rowBytes, decodedBytes };
}

function validateDecodedImage(ihdr, compressed) {
  let decoded;
  try {
    decoded = inflateSync(compressed, { maxOutputLength: ihdr.decodedBytes });
  } catch {
    throw new Error("invalid PNG image data");
  }
  if (decoded.length !== ihdr.decodedBytes) throw new Error("PNG image data length does not match IHDR");
  for (let offset = 0; offset < decoded.length; offset += ihdr.rowBytes + 1) {
    if (decoded[offset] > 4) throw new Error("invalid PNG row filter");
  }
}

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
