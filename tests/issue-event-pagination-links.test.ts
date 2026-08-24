import { describe, expect, it } from "vitest";
import { parseIssueEventLink, parseIssueEventPage } from "../src/issue-event-pagination-links.js";

const origin = "https://api.github.com";
const path = "/repos/owner/repo/issues/7/events";
const href = (query: string) => `${origin}${path}?${query}`;
const link = (relation: string, query = "page=2") => `<${href(query)}>; rel="${relation}"`;
const parse = (value: unknown, currentPage = 1) => parseIssueEventLink({
  link: value,
  apiOrigin: origin,
  issueEventsPath: path,
  currentPage
});

describe("strict issue-event Link parser", () => {
  it("distinguishes absent Link from present-invalid and normalizes safe metadata", () => {
    expect(parse(undefined)).toEqual({ kind: "absent" });
    expect(parse(link("next", "page=2&per_page=100"))).toEqual({ kind: "present", relations: { next: 2 } });
    expect(() => parse("")).toThrow();
  });

  it("rejects hostile origins, paths, credentials, hashes, queries, relations, and pages", () => {
    const bad = [
      `<https://evil.test/x?page=2>; rel="next"`, `<${origin}/wrong?page=2>; rel="next"`,
      `<${origin}/repos/owner/repo/issues/7/events/../events?page=2>; rel="next"`,
      `<https://user:pass@api.github.com${path}?page=2>; rel="next"`, `<${origin}${path}?page=2#bad>; rel="next"`,
      `<${href("per_page=100")}>; rel="next"`, `<${href("page=2&page=2")}>; rel="next"`,
      `<${href("page=2&Page=3")}>; rel="next"`, `<${href("page=0")}>; rel="next"`,
      `<${href("page=-1")}>; rel="next"`, `<${href("page=1.5")}>; rel="next"`,
      `<${href("page=9007199254740992")}>; rel="next"`, `<${href("page=2&per_page=200")}>; rel="next"`,
      `<${href("page=2&per_page=100&per_page=100")}>; rel="next"`, `<${href("page=2&extra=x")}>; rel="next"`,
      `<${href("page=2")}>; rel="next"`, `<${href("page=2")}>; rel="Next"`,
      `<${href("page=2")}>; rel="bogus"`, `<${href("page=2")}>; rel="next" junk`,
      `${link("next")}, ${link("next", "page=3")}`, `${link("next")}, ${link("prev", "page=0")}`
    ];
    for (const value of [null, ...bad]) expect(() => parse(value)).toThrow();
  });

  it("rejects contradictory local relation metadata", () => {
    expect(() => parse(`${link("first", "page=2")}`)).toThrow();
    expect(() => parse(`${link("prev", "page=2")}`, 4)).toThrow();
    expect(() => parse(`${link("next", "page=6")}`, 4)).toThrow();
    expect(() => parse(`${link("last", "page=3")}`, 4)).toThrow();
    expect(() => parse(`${link("next", "page=5")}, ${link("last", "page=4")}`, 4)).toThrow();
  });
});

describe("issue-event page envelope", () => {
  it("truthfully classifies empty, short, and full pages", () => {
    expect(parseIssueEventPage({ requestedPage: 1, returnedPage: 1, items: [] }).cardinality).toBe("empty");
    expect(parseIssueEventPage({ requestedPage: 2, returnedPage: 2, items: [{}] }).cardinality).toBe("short");
    expect(parseIssueEventPage({ requestedPage: 3, returnedPage: 3, items: Array(99) }).cardinality).toBe("short");
    expect(parseIssueEventPage({ requestedPage: 4, returnedPage: 4, items: Array(100) }).cardinality).toBe("full");
  });

  it("rejects wrong-page, non-array, and overfull envelopes", () => {
    expect(() => parseIssueEventPage({ requestedPage: 2, returnedPage: 1, items: [] })).toThrow();
    expect(() => parseIssueEventPage({ requestedPage: 1, returnedPage: 1, items: {} })).toThrow();
    expect(() => parseIssueEventPage({ requestedPage: 1, returnedPage: 1, items: Array(101) })).toThrow();
  });
});
