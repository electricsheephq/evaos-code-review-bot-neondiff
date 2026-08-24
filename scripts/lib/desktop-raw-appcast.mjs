import { spawnSync } from "node:child_process";

const MAX_INPUT = 4 * 1024 * 1024;
const PARSER = String.raw`
import json,sys,xml.etree.ElementTree as ET
text = sys.stdin.buffer.read().decode("utf-8")
root = ET.fromstring(text)
channels = [node for node in root if node.tag == "channel"]
if root.tag != "rss" or len(channels) != 1: raise ValueError("invalid feed")
channel = channels[0]; links = [node.text or "" for node in channel if node.tag == "link"]
if len(links) != 1: raise ValueError("invalid feed link")
ns = "{http://www.andymatuschak.org/xml-namespaces/sparkle}"; expected = {"url","length","type",ns+"version",ns+"shortVersionString",ns+"minimumSystemVersion",ns+"edSignature"}; entries = []
for item in [node for node in channel if node.tag == "item"]:
    enclosures = [node for node in item if node.tag == "enclosure"]; minimum = [node.text or "" for node in item if node.tag == ns+"minimumSystemVersion"]; rings = [node.text or "" for node in item if node.tag == ns+"channel"]
    if len(enclosures) != 1 or set(enclosures[0].attrib) != expected or len(minimum) != 1 or len(rings) > 1: raise ValueError("invalid feed item")
    value = enclosures[0].attrib
    if value[ns+"minimumSystemVersion"] != minimum[0]: raise ValueError("minimum version mismatch")
    entries.append({"url":value["url"],"length":value["length"],"type":value["type"],"version":value[ns+"shortVersionString"],"build":value[ns+"version"],"shortVersionString":value[ns+"shortVersionString"],"minimumSystemVersion":minimum[0],"channel":rings[0] if rings else "stable","edSignature":value[ns+"edSignature"]})
sys.stdout.write(json.dumps({"link":links[0],"entries":entries}, separators=(",", ":")))
`;

const fail = (message) => { throw new Error(message); };
function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function canonicalUTF8(input) {
  if (!(input instanceof Uint8Array)) fail("raw appcast must be bytes");
  const raw = Buffer.from(input);
  if (raw.length === 0 || raw.length > MAX_INPUT) fail("raw appcast is not bounded");
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw); }
  catch { fail("raw appcast is not canonical UTF-8"); }
  if (text.charCodeAt(0) === 0xfeff || text.includes("\0") || !Buffer.from(text, "utf8").equals(raw)) fail("raw appcast is not canonical UTF-8");
  const declaration = text.match(/^<\?xml\s+([\s\S]*?)\?>/i), encoding = declaration?.[1].match(/\bencoding\s*=\s*(["'])([^"']+)\1/i)?.[2];
  if (encoding && !/^utf-8$/i.test(encoding)) fail("raw appcast declares a non-UTF-8 encoding");
  if (/<!(?:doctype|entity)\b/i.test(text)) fail("raw appcast DTD is unsupported");
  return raw;
}

export function parseRawDesktopAppcast(input) {
  const raw = canonicalUTF8(input), result = spawnSync("/usr/bin/python3", ["-I", "-c", PARSER], { input: raw, encoding: "utf8", maxBuffer: MAX_INPUT, timeout: 5_000 });
  try { if (result.status !== 0) fail("raw appcast is malformed"); return deepFreeze(JSON.parse(result.stdout)); }
  catch { fail("raw appcast is malformed"); }
}
