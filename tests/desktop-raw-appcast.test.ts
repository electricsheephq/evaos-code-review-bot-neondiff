import { afterEach, describe, expect, it } from "vitest";
import { parseRawDesktopAppcast } from "../scripts/lib/desktop-raw-appcast.mjs";

const feed = `<?xml version="1.0" encoding="UTF-8"?>
<rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel>
<link>https://www.neondiff.com/appcast.xml</link><item>
<sparkle:minimumSystemVersion>14.0</sparkle:minimumSystemVersion><sparkle:channel>stable</sparkle:channel>
<enclosure url="https://example.test/NeonDiff.zip" length="42" type="application/octet-stream" sparkle:version="11000" sparkle:shortVersionString="1.1.0" sparkle:minimumSystemVersion="14.0" sparkle:edSignature="signature"/>
</item></channel></rss>`;
const hostile = `<?xml version="1.0"?><!DOCTYPE rss [<!ENTITY x "hostile">]><rss><channel><link>&x;</link></channel></rss>`;
const originalPythonPath = process.env.PYTHONPATH;

function encoded(text: string, width: 2 | 4, littleEndian: boolean) {
  const bom = width === 2 ? Buffer.from(littleEndian ? [0xff, 0xfe] : [0xfe, 0xff]) : Buffer.from(littleEndian ? [0xff, 0xfe, 0x00, 0x00] : [0x00, 0x00, 0xfe, 0xff]);
  const body = Buffer.alloc(text.length * width);
  for (let index = 0; index < text.length; index += 1) littleEndian ? body[width === 2 ? "writeUInt16LE" : "writeUInt32LE"](text.charCodeAt(index), index * width) : body[width === 2 ? "writeUInt16BE" : "writeUInt32BE"](text.charCodeAt(index), index * width);
  return Buffer.concat([bom, body]);
}

afterEach(() => { if (originalPythonPath === undefined) delete process.env.PYTHONPATH; else process.env.PYTHONPATH = originalPythonPath; });

describe("canonical raw Desktop appcast", () => {
  it("parses one strict canonical UTF-8 feed and freezes its bounded output", () => {
    const parsed = parseRawDesktopAppcast(Buffer.from(feed, "utf8"));
    expect(parsed).toMatchObject({ link: "https://www.neondiff.com/appcast.xml", entries: [{ version: "1.1.0", build: "11000", minimumSystemVersion: "14.0", channel: "stable" }] });
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.entries)).toBe(true);
    expect(Object.isFrozen(parsed.entries[0])).toBe(true);
  });

  it.each([
    ["primitive text", feed],
    ["empty bytes", Buffer.alloc(0)],
    ["oversized bytes", Buffer.alloc(4 * 1024 * 1024 + 1)],
    ["malformed UTF-8", Buffer.from([0xc3, 0x28])],
    ["UTF-8 BOM", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(feed)])],
    ["declared alternate encoding", Buffer.from(feed.replace("UTF-8", "UTF-16"))],
    ["UTF-16LE DTD", encoded(hostile, 2, true)],
    ["UTF-16BE DTD", encoded(hostile, 2, false)],
    ["UTF-32LE DTD", encoded(hostile, 4, true)],
    ["UTF-32BE DTD", encoded(hostile, 4, false)],
    ["UTF-8 DTD/entity", Buffer.from(hostile)],
    ["case-folded DTD/entity", Buffer.from(hostile.toLowerCase())]
  ])("rejects %s before XML acceptance", (_label, raw) => {
    expect(() => parseRawDesktopAppcast(raw as Uint8Array)).toThrow();
  });

  it.each([
    ["malformed XML", feed.slice(0, -8)],
    ["duplicate channel", feed.replace("</rss>", "<channel><link>x</link></channel></rss>")],
    ["extra enclosure attribute", feed.replace("<enclosure ", "<enclosure extra=\"x\" ")],
    ["minimum-version drift", feed.replace("<sparkle:minimumSystemVersion>14.0", "<sparkle:minimumSystemVersion>13.0")]
  ])("rejects %s", (_label, xml) => expect(() => parseRawDesktopAppcast(Buffer.from(xml))).toThrow());

  it("isolates the Python parser from ambient module paths", () => {
    process.env.PYTHONPATH = "/path/that/must/not/control/parsing";
    expect(parseRawDesktopAppcast(new Uint8Array(Buffer.from(feed))).entries).toHaveLength(1);
  });
});
