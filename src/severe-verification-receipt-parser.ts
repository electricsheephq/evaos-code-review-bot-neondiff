import { type SevereVerificationReceipt, compileSevereVerificationReceiptSchema } from "./severe-verification-receipt-schema.js";

export const MAX_SEVERE_VERIFICATION_RECEIPT_BYTES = 512 * 1024;
const MAX_JSON_DEPTH = 256;
const validate = compileSevereVerificationReceiptSchema();
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const intrinsicByteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength")!.get!;
const intrinsicByteOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteOffset")!.get!;
const intrinsicBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, "buffer")!.get!;
const intrinsicSet = Uint8Array.prototype.set, intrinsicTag = Object.getOwnPropertyDescriptor(typedArrayPrototype, Symbol.toStringTag)!.get!;
const reject = (code: string): never => { throw new Error(`severe_receipt_${code}`); };

export function parseSerializedSevereVerificationReceipt(input: unknown): SevereVerificationReceipt {
  const text = decodeInput(input);
  scanJson(text);
  let value: unknown;
  try { value = JSON.parse(text) as unknown; } catch { reject("malformed"); }
  if (!validate(value)) reject("schema_invalid");
  return copyReceipt(value as SevereVerificationReceipt);
}

export const parseSevereVerificationReceipt = parseSerializedSevereVerificationReceipt;

function decodeInput(input: unknown): string {
  if (typeof input === "string") {
    if (input.length > MAX_SEVERE_VERIFICATION_RECEIPT_BYTES) reject("cap_exceeded");
    const encoded = encoder.encode(input);
    if (encoded.byteLength > MAX_SEVERE_VERIFICATION_RECEIPT_BYTES) reject("cap_exceeded");
    const text = decodeUtf8(encoded);
    if (text !== input) reject("unicode");
    return text;
  }
  if (!isIntrinsicByteArray(input)) reject("serialized_input");
  let length: number;
  try { length = intrinsicByteLength.call(input); } catch { return reject("serialized_input"); }
  if (length > MAX_SEVERE_VERIFICATION_RECEIPT_BYTES) reject("cap_exceeded");
  try { if (hostileOwnProperties(input as Uint8Array)) reject("serialized_input"); } catch { return reject("serialized_input"); }
  let copy: Uint8Array;
  try {
    const source = new Uint8Array(intrinsicBuffer.call(input), intrinsicByteOffset.call(input), length);
    copy = new Uint8Array(length);
    intrinsicSet.call(copy, source);
  } catch { return reject("serialized_input"); }
  return decodeUtf8(copy);
}

function isIntrinsicByteArray(input: unknown): input is Uint8Array {
  if (!ArrayBuffer.isView(input)) return false;
  try {
    const prototype = Object.getPrototypeOf(input);
    return intrinsicTag.call(input) === "Uint8Array" && (prototype === Uint8Array.prototype || prototype === Buffer.prototype);
  } catch { return false; }
}
function hostileOwnProperties(input: Uint8Array): boolean {
  return Reflect.ownKeys(input).some((key) => {
    if (typeof key === "string" && /^\d+$/.test(key)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    return Boolean(descriptor && (descriptor.get || descriptor.set || typeof descriptor.value === "function"));
  });
}

function decodeUtf8(bytes: Uint8Array): string {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) reject("bom");
  let text: string;
  try {
    text = decoder.decode(bytes);
  } catch {
    return reject("utf8");
  }
  if (text.startsWith("\uFEFF")) reject("bom");
  return text;
}

class JsonScanner {
  private position = 0;
  constructor(private readonly text: string) {}
  scan(): void { this.value(0); this.space(); if (this.position !== this.text.length) reject("malformed"); }
  private value(depth: number): void {
    if (depth > MAX_JSON_DEPTH) reject("depth");
    this.space();
    const code = this.text.charCodeAt(this.position);
    if (code === 34) { this.string(); return; }
    if (code === 123) { this.object(depth + 1); return; }
    if (code === 91) { this.array(depth + 1); return; }
    if (code === 116 && this.literal("true")) return;
    if (code === 102 && this.literal("false")) return;
    if (code === 110 && this.literal("null")) return;
    if (code === 45 || (code >= 48 && code <= 57)) { this.number(); return; }
    reject("malformed");
  }
  private object(depth: number): void {
    this.position++; this.space(); const keys = new Set<string>();
    if (this.text.charCodeAt(this.position) === 125) { this.position++; return; }
    for (;;) {
      if (this.text.charCodeAt(this.position) !== 34) reject("malformed");
      const key = this.string(); if (keys.has(key)) reject("duplicate_key"); keys.add(key); this.space();
      if (this.text.charCodeAt(this.position++) !== 58) reject("malformed");
      this.value(depth); this.space();
      const next = this.text.charCodeAt(this.position++);
      if (next === 125) return;
      if (next !== 44) reject("malformed");
      this.space();
    }
  }
  private array(depth: number): void {
    this.position++; this.space(); if (this.text.charCodeAt(this.position) === 93) { this.position++; return; }
    for (;;) { this.value(depth); this.space(); const next = this.text.charCodeAt(this.position++); if (next === 93) return; if (next !== 44) reject("malformed"); this.space(); }
  }
  private string(): string {
    this.position++; let value = "";
    for (;;) {
      const code = this.text.charCodeAt(this.position++);
      if (code === 34) { if (!scalar(value)) reject("unicode"); return value; }
      if (code < 32 || Number.isNaN(code)) reject("malformed");
      if (code !== 92) { value += String.fromCharCode(code); continue; }
      const escaped = this.text.charCodeAt(this.position++);
      const simple = ({34: '"', 92: "\\", 47: "/", 98: "\b", 102: "\f", 110: "\n", 114: "\r", 116: "\t"} as Record<number, string>)[escaped];
      if (simple !== undefined) { value += simple; continue; }
      if (escaped !== 117) reject("malformed");
      let unit = 0; for (let count = 0; count < 4; count++) { const digit = Number.parseInt(this.text[this.position++], 16); if (Number.isNaN(digit)) reject("malformed"); unit = unit * 16 + digit; }
      value += String.fromCharCode(unit);
    }
  }
  private literal(literal: string): boolean { if (this.text.slice(this.position, this.position + literal.length) !== literal) return false; this.position += literal.length; return true; }
  private number(): void { const start = this.position; if (this.text[this.position] === "-") this.position++; if (this.text[this.position] === "0") this.position++; else { if (!/[1-9]/.test(this.text[this.position] ?? "")) reject("malformed"); while (/[0-9]/.test(this.text[this.position] ?? "")) this.position++; } if (this.text[this.position] === ".") { this.position++; if (!/[0-9]/.test(this.text[this.position] ?? "")) reject("malformed"); while (/[0-9]/.test(this.text[this.position] ?? "")) this.position++; } if (this.text[this.position] === "e" || this.text[this.position] === "E") { this.position++; if (this.text[this.position] === "+" || this.text[this.position] === "-") this.position++; if (!/[0-9]/.test(this.text[this.position] ?? "")) reject("malformed"); while (/[0-9]/.test(this.text[this.position] ?? "")) this.position++; } if (this.position === start) reject("malformed"); }
  private space(): void { while ([9, 10, 13, 32].includes(this.text.charCodeAt(this.position))) this.position++; }
}

function scalar(value: string): boolean { for (let i = 0; i < value.length; i++) { const code = value.charCodeAt(i); if (code >= 0xd800 && code <= 0xdbff) { const next = value.charCodeAt(++i); if (next < 0xdc00 || next > 0xdfff) return false; } else if (code >= 0xdc00 && code <= 0xdfff) return false; } return true; }
function scanJson(text: string): void { new JsonScanner(text).scan(); }
function copyReceipt(source: SevereVerificationReceipt): SevereVerificationReceipt {
  return { schemaVersion: source.schemaVersion, repo: source.repo, pullNumber: source.pullNumber, baseSha: source.baseSha, headSha: source.headSha, findingFingerprint: source.findingFingerprint, state: source.state, disposition: source.disposition, ...(source.confidence === undefined ? {} : { confidence: source.confidence }), ...(source.reasonCode === undefined ? {} : { reasonCode: source.reasonCode }), evidence: { files: source.evidence.files.map((file) => ({ path: file.path, kind: file.kind, sha256: file.sha256, bytes: file.bytes, complete: file.complete })), omitted: source.evidence.omitted.map((item) => ({ path: item.path, code: item.code })), complete: source.evidence.complete } };
}
