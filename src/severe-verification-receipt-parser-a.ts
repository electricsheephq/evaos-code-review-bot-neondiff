export const MAX_SEVERE_VERIFICATION_RECEIPT_BYTES = 512 * 1024;

export type SerializedSevereVerificationInput = string | Uint8Array;

const IntrinsicUint8Array = Uint8Array;
const intrinsicIsView = ArrayBuffer.isView;
const intrinsicGetPrototypeOf = Object.getPrototypeOf;
const intrinsicOwnKeys = Reflect.ownKeys;
const typedArrayPrototype = intrinsicGetPrototypeOf(IntrinsicUint8Array.prototype);
const intrinsicByteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength")!.get!;
const intrinsicByteOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteOffset")!.get!;
const intrinsicBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, "buffer")!.get!;
const intrinsicTag = Object.getOwnPropertyDescriptor(typedArrayPrototype, Symbol.toStringTag)!.get!;
const intrinsicSet = IntrinsicUint8Array.prototype.set;
const intrinsicBufferPrototype = typeof Buffer === "function" ? Buffer.prototype : undefined;

const reject = (code: string): never => { throw new TypeError(`severe_receipt_${code}`); };

/** Parser A: preserve text, or copy an intrinsically branded byte view for Parser B. */
export function prepareSerializedSevereVerificationInput(input: unknown): SerializedSevereVerificationInput {
  if (typeof input === "string") {
    if (!withinByteCap(input)) reject("cap_exceeded");
    return input;
  }
  if (!isIntrinsicByteArray(input)) reject("serialized_input");
  const bytes = input as Uint8Array;

  let length: number;
  try { length = intrinsicByteLength.call(bytes); } catch { return reject("serialized_input"); }
  if (length > MAX_SEVERE_VERIFICATION_RECEIPT_BYTES) reject("cap_exceeded");
  if (!hasOnlyCanonicalIndices(bytes, length)) reject("serialized_input");

  try {
    const source = new IntrinsicUint8Array(
      intrinsicBuffer.call(bytes), intrinsicByteOffset.call(bytes), length
    );
    const copy = new IntrinsicUint8Array(length);
    intrinsicSet.call(copy, source);
    return copy;
  } catch { return reject("serialized_input"); }
}

function isIntrinsicByteArray(input: unknown): input is Uint8Array {
  if (!intrinsicIsView(input)) return false;
  try {
    const prototype = intrinsicGetPrototypeOf(input);
    return intrinsicTag.call(input) === "Uint8Array" &&
      (prototype === IntrinsicUint8Array.prototype || prototype === intrinsicBufferPrototype);
  } catch { return false; }
}

function hasOnlyCanonicalIndices(input: Uint8Array, length: number): boolean {
  for (const key of intrinsicOwnKeys(input)) {
    if (typeof key !== "string" || !isCanonicalIndex(key, length)) return false;
  }
  return true;
}

function isCanonicalIndex(key: string, length: number): boolean {
  if (!/^(?:0|[1-9][0-9]*)$/.test(key)) return false;
  const index = Number(key);
  return Number.isSafeInteger(index) && index < length && String(index) === key;
}

function withinByteCap(value: string): boolean {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
    if (bytes > MAX_SEVERE_VERIFICATION_RECEIPT_BYTES) return false;
  }
  return true;
}
