import { describe, expect, it } from "vitest";
import { parseIssueEventLink } from "../src/issue-event-pagination-links.js";

const target = "https://api.github.com/repos/owner/repo/issues/7/events?page=2";
const member = (relation: string, href = target) => `<${href}>; rel=${relation}`;

describe("strict issue-event Link framing", () => {
  it("distinguishes absent values and preserves every raw field", () => {
    expect(parseIssueEventLink(undefined)).toEqual({ kind: "absent" });
    expect(parseIssueEventLink(null)).toEqual({ kind: "absent" });

    const link = ` \t<${target}> \t; \t rel \t= \t"next last",\t<${target}&copy=raw>; rel=Next`;
    expect(parseIssueEventLink(link)).toEqual({
      kind: "present",
      link,
      members: [
        {
          raw: ` \t<${target}> \t; \t rel \t= \t"next last"`,
          target,
          relation: '"next last"'
        },
        {
          raw: `\t<${target}&copy=raw>; rel=Next`,
          target: `${target}&copy=raw`,
          relation: "Next"
        }
      ]
    });
  });

  it("frames quoted and bare relations without semantic allowlisting", () => {
    expect(parseIssueEventLink(member('"next last"'))).toMatchObject({
      kind: "present",
      members: [{ relation: '"next last"' }]
    });
    expect(parseIssueEventLink(member("bogus"))).toMatchObject({
      kind: "present",
      members: [{ relation: "bogus" }]
    });
    expect(parseIssueEventLink(member('"next next"'))).toMatchObject({ kind: "present" });
  });

  it("rejects empty members, target whitespace, controls, and unbalanced framing", () => {
    const invalid = [
      "",
      " \t",
      `,${member("next")}`,
      `${member("next")},`,
      `${member("next")},,${member("last")}`,
      `${member("next")}, \t`,
      `< ${target}>; rel=next`,
      `<${target} >; rel=next`,
      `<${target.replace("events", "ev\tents")}>; rel=next`,
      `<${target.replace("events", "ev\nents")}>; rel=next`,
      `<${target},other>; rel=next`,
      `<${target}; rel=next`,
      `<${target}>; rel="next`,
      `<${target}>; rel="next" junk`,
      `<${target}>; rel=next>`,
      `<${target}>; rel=<next`
    ];
    for (const value of invalid) expect(() => parseIssueEventLink(value)).toThrow();
  });

  it("rejects malformed parameters and unsupported trailing syntax", () => {
    const invalid = [
      `${member("next")}; foo=bar`,
      `${member("next")}; rel=last`,
      `<${target}>; rel`,
      `<${target}>; rel=`,
      `<${target}>; rel=""`,
      `<${target}>; rel="next${String.fromCharCode(9)}last"`,
      `<${target}>; rel="next last `
    ];
    for (const value of invalid) expect(() => parseIssueEventLink(value)).toThrow();
  });
});
