import { describe, expect, it } from "vitest";
import {
  MAX_SEVERE_VERIFICATION_RECEIPT_BYTES,
  prepareSerializedSevereVerificationInput
} from "../src/severe-verification-receipt-parser-a.js";

const prepare = prepareSerializedSevereVerificationInput;

describe("severe receipt Parser A input boundary", () => {
  it("accepts primitive strings and intrinsic Uint8Array/Buffer inputs", () => {
    const text = "{\"ok\":true}";
    expect(prepare(text)).toBe(text);
    expect(prepare(new Uint8Array([1, 2, 3]))).toEqual(new Uint8Array([1, 2, 3]));
    expect(prepare(Buffer.from([4, 5, 6]))).toEqual(new Uint8Array([4, 5, 6]));
  });

  it("returns a defensive byte copy", () => {
    const source = new Uint8Array([1, 2, 3]);
    const copy = prepare(source);
    source[0] = 9;
    expect(copy).toEqual(new Uint8Array([1, 2, 3]));
    if (copy instanceof Uint8Array) copy[1] = 8;
    expect(source).toEqual(new Uint8Array([9, 2, 3]));
  });

  it("enforces the cap before enumerating or copying", () => {
    let enumerated = false;
    const oversized = new Uint8Array(MAX_SEVERE_VERIFICATION_RECEIPT_BYTES + 1);
    Object.defineProperty(oversized, "oversized", {
      enumerable: true,
      get() { enumerated = true; throw new Error("getter invoked"); }
    });
    expect(() => prepare(oversized)).toThrow("cap_exceeded");
    expect(enumerated).toBe(false);
    expect(() => prepare("x".repeat(MAX_SEVERE_VERIFICATION_RECEIPT_BYTES + 1))).toThrow("cap_exceeded");
  });

  it.each(["00", "01", "999999999999999999999999999999999999999999999999999999"]) (
    "rejects noncanonical numeric-looking own key %s without invoking it",
    (key) => {
      let invoked = false;
      const input = new Uint8Array([7]);
      Object.defineProperty(input, key, {
        configurable: true,
        get() { invoked = true; throw new Error("getter invoked"); }
      });
      expect(() => prepare(input)).toThrow("serialized_input");
      expect(invoked).toBe(false);
    }
  );

  it("rejects -0 and arbitrary non-byte inputs", () => {
    expect(() => prepare({ "-0": 1 })).toThrow("serialized_input");
    expect(() => prepare(() => "bytes")).toThrow("serialized_input");
  });

  it("rejects accessors, functions, symbols, and non-index own properties", () => {
    const accessor = new Uint8Array([1]);
    Object.defineProperty(accessor, "evil", { get() { throw new Error("getter invoked"); } });
    expect(() => prepare(accessor)).toThrow("serialized_input");

    const functionValue = new Uint8Array([1]);
    Object.defineProperty(functionValue, "evil", { value: () => { throw new Error("called"); } });
    expect(() => prepare(functionValue)).toThrow("serialized_input");

    const symbolValue = new Uint8Array([1]);
    Object.defineProperty(symbolValue, Symbol("evil"), { value: 1 });
    expect(() => prepare(symbolValue)).toThrow("serialized_input");
  });

  it("rejects proxies, subclasses, and prototype-spoofed typed arrays without traps", () => {
    let trapped = false;
    const proxy = new Proxy(new Uint8Array([1]), {
      get() { trapped = true; throw new Error("trap"); },
      ownKeys() { trapped = true; throw new Error("trap"); }
    });
    expect(() => prepare(proxy)).toThrow("serialized_input");
    expect(trapped).toBe(false);

    class Child extends Uint8Array {}
    expect(() => prepare(new Child([1]))).toThrow("serialized_input");

    const int8 = new Int8Array([1]);
    Object.setPrototypeOf(int8, Uint8Array.prototype);
    expect(() => prepare(int8)).toThrow("serialized_input");

    const clamped = new Uint8ClampedArray([1]);
    Object.setPrototypeOf(clamped, Uint8Array.prototype);
    expect(() => prepare(clamped)).toThrow("serialized_input");
  });

  it("accepts only canonical integer indices", () => {
    const input = new Uint8Array([7, 8]);
    expect(prepare(input)).toEqual(new Uint8Array([7, 8]));
  });
});
