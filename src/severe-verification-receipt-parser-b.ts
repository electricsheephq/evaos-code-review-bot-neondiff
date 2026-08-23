import {
  prepareSerializedSevereVerificationInput,
  type SerializedSevereVerificationInput
} from "./severe-verification-receipt-parser-a.js";

const MAX_JSON_DEPTH = 256;
const decoder = new TextDecoder("utf-8", { fatal: true });
const reject = (code: string): never => { throw new TypeError(`severe_receipt_${code}`); };

/** Parser B: decode and parse only the bounded output of Parser A. */
export function parseSevereVerificationReceiptJson(input: unknown): unknown {
  const bounded = prepareSerializedSevereVerificationInput(input);
  const text = decode(bounded);
  scanJson(text);
  try { return JSON.parse(text) as unknown; } catch { return reject("malformed"); }
}

function decode(input: SerializedSevereVerificationInput): string {
  if (typeof input === "string") {
    if (input.startsWith("\uFEFF")) reject("bom");
    return input;
  }
  if (input.length >= 3 && input[0] === 0xef && input[1] === 0xbb && input[2] === 0xbf) reject("bom");
  let text: string;
  try { text = decoder.decode(input); } catch { return reject("utf8"); }
  if (text.startsWith("\uFEFF")) reject("bom");
  return text;
}

function scalar(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

class JsonScanner {
  private position = 0;
  constructor(private readonly text: string) {}

  scan(): void {
    this.value(0);
    this.space();
    if (this.position !== this.text.length) reject("malformed");
  }

  private value(depth: number): void {
    if (depth > MAX_JSON_DEPTH) reject("depth");
    this.space();
    const code = this.text.charCodeAt(this.position);
    if (code === 34) return void this.string();
    if (code === 123) return void this.object(depth + 1);
    if (code === 91) return void this.array(depth + 1);
    if (code === 116 && this.literal("true")) return;
    if (code === 102 && this.literal("false")) return;
    if (code === 110 && this.literal("null")) return;
    if (code === 45 || (code >= 48 && code <= 57)) return void this.number();
    reject("malformed");
  }

  private object(depth: number): void {
    this.position += 1; this.space();
    const keys = new Set<string>();
    if (this.text.charCodeAt(this.position) === 125) { this.position += 1; return; }
    for (;;) {
      if (this.text.charCodeAt(this.position) !== 34) reject("malformed");
      const key = this.string(); this.space();
      if (this.text.charCodeAt(this.position++) !== 58) reject("malformed");
      if (keys.has(key)) reject("duplicate_key");
      keys.add(key); this.value(depth); this.space();
      const next = this.text.charCodeAt(this.position++);
      if (next === 125) return;
      if (next !== 44) reject("malformed");
      this.space();
    }
  }

  private array(depth: number): void {
    this.position += 1; this.space();
    if (this.text.charCodeAt(this.position) === 93) { this.position += 1; return; }
    for (;;) {
      this.value(depth); this.space();
      const next = this.text.charCodeAt(this.position++);
      if (next === 93) return;
      if (next !== 44) reject("malformed");
      this.space();
    }
  }

  private string(): string {
    this.position += 1; const chars: string[] = [];
    for (;;) {
      const code = this.text.charCodeAt(this.position++);
      if (code === 34) {
        const value = chars.join("");
        if (!scalar(value)) reject("unicode");
        return value;
      }
      if (code < 32 || Number.isNaN(code)) reject("malformed");
      if (code !== 92) { chars.push(String.fromCharCode(code)); continue; }
      const escaped = this.text.charCodeAt(this.position++);
      const simple: Record<number, string> = { 34: '"', 92: "\\", 47: "/", 98: "\b", 102: "\f", 110: "\n", 114: "\r", 116: "\t" };
      if (simple[escaped] !== undefined) { chars.push(simple[escaped]); continue; }
      if (escaped !== 117) reject("malformed");
      let unit = 0;
      for (let count = 0; count < 4; count += 1) {
        const digit = Number.parseInt(this.text[this.position++], 16);
        if (Number.isNaN(digit)) reject("malformed");
        unit = unit * 16 + digit;
      }
      chars.push(String.fromCharCode(unit));
    }
  }

  private literal(value: string): boolean {
    if (this.text.slice(this.position, this.position + value.length) !== value) return false;
    this.position += value.length; return true;
  }

  private number(): void {
    const start = this.position;
    if (this.text[this.position] === "-") this.position += 1;
    if (this.text[this.position] === "0") this.position += 1;
    else {
      if (!/[1-9]/.test(this.text[this.position] ?? "")) reject("malformed");
      while (/[0-9]/.test(this.text[this.position] ?? "")) this.position += 1;
    }
    if (this.text[this.position] === ".") {
      this.position += 1;
      if (!/[0-9]/.test(this.text[this.position] ?? "")) reject("malformed");
      while (/[0-9]/.test(this.text[this.position] ?? "")) this.position += 1;
    }
    if (this.text[this.position] === "e" || this.text[this.position] === "E") {
      this.position += 1;
      if (this.text[this.position] === "+" || this.text[this.position] === "-") this.position += 1;
      if (!/[0-9]/.test(this.text[this.position] ?? "")) reject("malformed");
      while (/[0-9]/.test(this.text[this.position] ?? "")) this.position += 1;
    }
    if (this.position === start) reject("malformed");
  }

  private space(): void {
    while ([9, 10, 13, 32].includes(this.text.charCodeAt(this.position))) this.position += 1;
  }
}

function scanJson(text: string): void { new JsonScanner(text).scan(); }
