import { types as nodeTypes } from "node:util";
import {
  compileSevereVerificationReceiptSchema,
  type SevereVerificationReceipt
} from "./severe-verification-receipt-schema.js";

const MAX_OBJECT_KEYS = 16;
const MAX_ARRAY_ITEMS = 64;
const validate = compileSevereVerificationReceiptSchema();
const ownKeys = Reflect.ownKeys;
const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const getPrototypeOf = Object.getPrototypeOf;
const defineProperty = Object.defineProperty;
const isProxy = nodeTypes.isProxy;
const reject = (): never => { throw new TypeError("severe_receipt_schema_invalid"); };

/** Parser C: validate Parser B data and return an isolated plain-data receipt. */
export function parseSevereVerificationReceipt(input: unknown): SevereVerificationReceipt {
  const value = copyPlainData(input, new Set<object>());
  if (!validate(value)) reject();
  return value as SevereVerificationReceipt;
}

function copyPlainData(input: unknown, seen: Set<object>): unknown {
  if (input === null) return null;
  const kind = typeof input;
  if (kind === "string" || kind === "boolean") return input;
  if (kind === "number") return Number.isFinite(input) ? input : reject();
  if (kind !== "object") reject();
  if (isProxy(input)) reject();
  const object = input as object;
  if (seen.has(object)) reject();
  seen.add(object);
  try {
    const array = Array.isArray(input);
    const prototype = getPrototypeOf(object);
    if (array) return copyArray(object as unknown[], prototype, seen);
    if (prototype !== Object.prototype) reject();
    return copyObject(object as Record<string, unknown>, seen);
  } catch { return reject(); } finally { seen.delete(object); }
}

function copyObject(input: Record<string, unknown>, seen: Set<object>): Record<string, unknown> {
  let keys: (string | symbol)[];
  try { keys = ownKeys(input); } catch { return reject(); }
  if (keys.length > MAX_OBJECT_KEYS) reject();
  const output: Record<string, unknown> = {};
  for (const key of keys) {
    if (typeof key !== "string") return reject();
    const value = dataProperty(input, key, true);
    defineProperty(output, key, { value: copyPlainData(value, seen), enumerable: true, writable: true, configurable: true });
  }
  return output;
}

function copyArray(input: unknown[], prototype: object | null, seen: Set<object>): unknown[] {
  if (prototype !== Array.prototype) reject();
  const lengthValue = dataProperty(input, "length", false);
  if (typeof lengthValue !== "number" || !Number.isSafeInteger(lengthValue) || lengthValue < 0 || lengthValue > MAX_ARRAY_ITEMS) return reject();
  const length = lengthValue as number;
  let keys: (string | symbol)[];
  try { keys = ownKeys(input); } catch { return reject(); }
  if (keys.length !== length + 1) reject();
  for (const key of keys) if (key !== "length" && (typeof key !== "string" || !isIndex(key, length))) return reject();
  const output: unknown[] = [];
  defineProperty(output, "length", { value: length, writable: true, enumerable: false, configurable: false });
  for (let index = 0; index < length; index += 1) {
    const key = String(index);
    defineProperty(output, key, { value: copyPlainData(dataProperty(input, key, true), seen), enumerable: true, writable: true, configurable: true });
  }
  return output;
}

function dataProperty(input: object, key: string, enumerable: boolean): unknown {
  let descriptor: PropertyDescriptor | undefined;
  try { descriptor = getOwnPropertyDescriptor(input, key); } catch { return reject(); }
  if (!descriptor || descriptor.get !== undefined || descriptor.set !== undefined || !("value" in descriptor) || descriptor.enumerable !== enumerable) return reject();
  return descriptor.value;
}

function isIndex(key: string, length: number): boolean {
  if (!/^(?:0|[1-9][0-9]*)$/.test(key)) return false;
  const index = Number(key);
  return Number.isSafeInteger(index) && index < length && String(index) === key;
}
