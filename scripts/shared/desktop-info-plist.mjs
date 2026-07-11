import { spawnSync } from "node:child_process";
import { walkDescriptorTree } from "./safe-fs.mjs";

const parser = String.raw`
import json, plistlib, sys, xml.etree.ElementTree as ET

raw = sys.stdin.buffer.read(1048577)
if len(raw) > 1048576:
    raise ValueError("oversized plist")
value = plistlib.loads(raw)
if not isinstance(value, dict):
    raise ValueError("plist root is not a dictionary")

required = ("CFBundleShortVersionString", "CFBundleVersion")
if not raw.startswith(b"bplist00"):
    root = ET.fromstring(raw)
    if root.tag != "plist" or len(root) != 1 or root[0].tag != "dict":
        raise ValueError("invalid XML plist root")
    children = list(root[0])
    if len(children) % 2:
        raise ValueError("invalid XML plist dictionary")
    keys = []
    for index in range(0, len(children), 2):
        if children[index].tag != "key":
            raise ValueError("invalid XML plist key")
        keys.append(children[index].text or "")
    if any(keys.count(key) != 1 for key in required):
        raise ValueError("missing or duplicate identity key")

result = {}
for key in required:
    item = value.get(key)
    if not isinstance(item, str) or not item or len(item.encode("utf-8")) > 128:
        raise ValueError("invalid identity value")
    result[key] = item
sys.stdout.write(json.dumps(result))
`;

export function readDesktopInfoPlistIdentity(app) {
  let plist;
  walkDescriptorTree(app, (entry) => {
    if (entry.type === "file" && entry.relativePath === "Contents/Info.plist") plist = entry.data;
  });
  if (!plist || plist.byteLength > 1024 * 1024) throw new Error("desktop Info.plist is missing or oversized");
  const parsed = spawnSync("/usr/bin/python3", ["-c", parser], {
    input: plist,
    encoding: "utf8",
    maxBuffer: 4096
  });
  if (parsed.status !== 0) throw new Error("desktop Info.plist is malformed or has invalid identity keys");
  const identity = JSON.parse(parsed.stdout);
  return {
    shortVersion: identity.CFBundleShortVersionString,
    buildVersion: identity.CFBundleVersion
  };
}
