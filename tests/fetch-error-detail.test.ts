import { describe, expect, it } from "vitest";
import { describeFetchErrorCauseChain, FETCH_CAUSE_CHAIN_PATTERN, stripFetchCauseChain } from "../src/fetch-error-detail.js";

const outer = (cause: unknown) => new TypeError("fetch failed", { cause });
const coded = (message: string, code: unknown) => Object.assign(new Error(message), { code });

describe("fetch error cause detail", () => {
  it.each([undefined, null, 0, "", "string cause", new Error("one level")])("adds nothing for a plain cause: %s", (cause) => {
    expect(describeFetchErrorCauseChain(outer(cause))).toBe("");
  });

  it.each(["UND_ERR_SOCKET", "a_1", "x".repeat(40)])("includes valid string code %s", (code) => {
    expect(describeFetchErrorCauseChain(outer(coded("closed", code)))).toBe(`code=${code}`);
  });

  it.each([23, "", "bad-code", "x".repeat(41), "[ETIMEDOUT]", "ETIMED\nOUT"])("skips invalid code %s", (code) => {
    expect(describeFetchErrorCauseChain(outer(coded("closed", code)))).toBe("");
  });

  it("keeps the cancelled DOMException wrapper and skips numeric DOMException codes", () => {
    const cause = Object.assign(new DOMException("Request was cancelled."), {
      cause: new DOMException("The operation was aborted.", "AbortError")
    });
    expect(describeFetchErrorCauseChain(outer(cause))).toBe("AbortError: The operation was aborted.");
  });

  it("stops at a cycle including a return to the top error", () => {
    const a = new Error("a"), b = new Error("b", { cause: a });
    a.cause = b;
    expect(describeFetchErrorCauseChain(a)).toBe("cycle");
    expect(describeFetchErrorCauseChain(outer(a))).toBe("Error: b; cycle");
  });

  it("walks levels 2 through 4 and marks a level 5 without reading it", () => {
    let cause = new Error("level 6");
    for (let level = 5; level >= 1; level -= 1) cause = new Error(`level ${level}`, { cause });
    expect(describeFetchErrorCauseChain(outer(cause))).toBe("Error: level 2; Error: level 3; Error: level 4; depth-limit");
  });

  it("renders non-Error deeper values with String and stops at falsy values", () => {
    expect(describeFetchErrorCauseChain(outer(new Error("wrapper", { cause: "plain" })))).toBe("plain");
    expect(describeFetchErrorCauseChain(outer(new Error("wrapper", { cause: { message: "not an Error" } })))).toBe("(object Object)");
    for (const cause of [false, 0, "", null]) expect(describeFetchErrorCauseChain(outer(new Error("wrapper", { cause })))).toBe("");
  });

  it("caps each item at 160 and joined content at 320 including the ellipsis", () => {
    const cause = new Error("wrapper", { cause: new Error("x".repeat(10_000), {
      cause: new Error("y".repeat(10_000), { cause: new Error("z".repeat(10_000)) })
    }) });
    const detail = describeFetchErrorCauseChain(outer(cause));
    expect(detail.length).toBe(320);
    expect(detail.split("; ")[0]).toBe(`Error: ${"x".repeat(152)}…`);
    expect(detail.endsWith("…")).toBe(true);
  });

  it("redacts before normalizing brackets and control characters and truncating", () => {
    const token = ["ghp", "abcdefgh12345678"].join("_");
    const detail = describeFetchErrorCauseChain(outer(new Error("wrapper", {
      cause: new Error(`[deep]\n\u0000\u001f\u007f ${token} ${"x".repeat(200)}`)
    })));
    expect(detail).toContain("Error: (deep)     (redacted-secret)");
    expect(detail).not.toContain(token);
    expect(detail).not.toMatch(/[\[\]\u0000-\u001f\u007f]/);
    expect(detail.length).toBe(160);
  });

  it("lists only two AggregateError children, never their causes, at any visited level", () => {
    const e1 = Object.assign(new Error("connect ETIMEDOUT 192.0.2.1:443", { cause: new Error("hidden child cause") }), { code: "ETIMEDOUT" });
    const e2 = coded("connect ENETUNREACH", "ENETUNREACH");
    const aggregate = new AggregateError([e1, e2, new Error("third child")], "");
    const detail = "errors(0)=Error: connect ETIMEDOUT 192.0.2.1:443 (code=ETIMEDOUT); errors(1)=Error: connect ENETUNREACH (code=ENETUNREACH)";
    expect(describeFetchErrorCauseChain(outer(aggregate))).toBe(detail);
    expect(describeFetchErrorCauseChain(aggregate)).toBe(detail);
    expect(describeFetchErrorCauseChain(outer(new Error("wrapper", { cause: aggregate })))).toBe(`AggregateError: ; ${detail}`);
  });

  it("reads no unrelated transport properties", () => {
    const cause = coded("closed", "UND_ERR_SOCKET");
    for (const key of ["socket", "errno", "syscall", "address"]) Object.defineProperty(cause, key, { get() { throw new Error(`read ${key}`); } });
    expect(describeFetchErrorCauseChain(outer(cause))).toBe("code=UND_ERR_SOCKET");
  });

  it("never throws on a broken cause object and keeps what it already gathered", () => {
    const throwing = (key: string) => Object.defineProperty(new Error("broken"), key, { get() { throw new Error(`read ${key}`); } });
    const { proxy, revoke } = Proxy.revocable(new Error("revoked"), {});
    revoke();
    expect(describeFetchErrorCauseChain(outer(Object.assign(coded("closed", "ECONNRESET"), { cause: Object.create(null) })))).toBe("code=ECONNRESET");
    expect(describeFetchErrorCauseChain(outer(new Error("wrapper", { cause: proxy })))).toBe("");
    expect(describeFetchErrorCauseChain(proxy)).toBe("");
    for (const key of ["code", "errors", "cause"]) expect(describeFetchErrorCauseChain(outer(throwing(key)))).toBe("");
    expect(describeFetchErrorCauseChain(outer(new Error("wrapper", { cause: throwing("message") })))).toBe("");
  });

  it("never splits a surrogate pair when it truncates", () => {
    const detail = describeFetchErrorCauseChain(outer(new Error("wrapper", { cause: new Error(`${"x".repeat(151)}\u{1F600}${"y".repeat(20)}`) })));
    expect(detail).toBe(`Error: ${"x".repeat(151)}…`);
    expect(detail).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
  });

  it("strips every complete segment while preserving surrounding bytes", () => {
    expect(FETCH_CAUSE_CHAIN_PATTERN.source).toBe(/ \[cause-chain: [^\[\]]*\]/g.source);
    expect(stripFetchCauseChain("base [cause-chain: code=ONE]; next [cause-chain: Error: two]")).toBe("base; next");
    expect(stripFetchCauseChain("plain\ntext")).toBe("plain\ntext");
    expect(stripFetchCauseChain("base [cause-chain: incomplete")).toBe("base [cause-chain: incomplete");
  });
});
