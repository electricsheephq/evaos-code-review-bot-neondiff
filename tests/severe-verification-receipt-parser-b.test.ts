import { describe, expect, it } from "vitest";
import { prepareSerializedSevereVerificationInput } from "../src/severe-verification-receipt-parser-a.js";
import { parseSevereVerificationReceiptJson } from "../src/severe-verification-receipt-parser-b.js";

const parse = (input: unknown) => parseSevereVerificationReceiptJson(prepareSerializedSevereVerificationInput(input));

describe("severe receipt Parser B JSON boundary", () => {
  it("consumes Parser A output and accepts JSON scalars and Unicode", () => {
    expect(parse("true")).toBe(true);
    expect(parse('{"path":"src/🧪.ts"}')).toEqual({ path: "src/🧪.ts" });
    expect(parse(new TextEncoder().encode('{"ok":null}'))).toEqual({ ok: null });
  });

  it("rejects fatal UTF-8, leading BOM, and lone Unicode surrogates", () => {
    expect(() => parse(new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d]))).toThrow("bom");
    expect(() => parse(new Uint8Array([0xc0, 0x80]))).toThrow("utf8");
    for (const value of ["\"\\ud800\"", `"${String.fromCharCode(0xd800)}"`, '"x\\udc00"']) {
      expect(() => parse(value)).toThrow("unicode");
    }
  });

  it("rejects decoded duplicates, malformed top-level syntax, and trailing values", () => {
    expect(() => parse('{"nested":{"a":1,"\\u0061":2}}')).toThrow("duplicate_key");
    expect(() => parse("true false")).toThrow("malformed");
    expect(() => parse("01")).toThrow("malformed");
    expect(() => parse(`{}${String.fromCharCode(0)}`)).toThrow("malformed");
  });

  it("bounds nesting before parse", () => {
    const deep = `${"[".repeat(257)}0${"]".repeat(257)}`;
    expect(() => parse(deep)).toThrow("depth");
  });
});
