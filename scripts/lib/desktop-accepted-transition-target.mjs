import { spawnSync } from "node:child_process";

const KIND = "neondiff.desktop.accepted-transition-target-v1";
const SHA1 = /^[a-f0-9]{40}$/, SHA256 = /^[a-f0-9]{64}$/;
const MAX_INPUT = 4 * 1024 * 1024;
const TARGET_FIELDS = ["tag", "version", "build", "channel", "packetSHA256", "sourceSHA", "tagObjectSHA", "artifactSHA256", "treeSHA256", "sparklePublicKeySHA256", "evidenceWorkflowSourceSHA"];
const CURRENT_FIELDS = ["tag", "version", "build", "channel", "packetSHA256", "sourceSHA", "tagObjectSHA", "artifactSHA256", "treeSHA256"];
const RECEIPT_FIELDS = ["schemaVersion", "kind", "action", "acceptedTarget", "current", "previouslyAcceptedTargetPacketSHA256"];
const STRICT_JSON = String.raw`
import json,sys
def pairs(values):
    result = {}
    for key,value in values:
        if key in result: raise ValueError("duplicate JSON key")
        result[key] = value
    return result
value = json.loads(sys.stdin.buffer.read(), object_pairs_hook=pairs)
sys.stdout.write(json.dumps(value, separators=(",", ":")))
`;

function fail(message) { throw new Error(message); }
function exact(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== fields.length || fields.some((field) => !Object.hasOwn(value, field))) fail(`${label} shape is invalid`);
  return value;
}
function strictJSON(raw) {
  const result = spawnSync("/usr/bin/python3", ["-I", "-c", STRICT_JSON], { input: raw, encoding: "utf8", maxBuffer: MAX_INPUT });
  try { if (result.error || result.signal || result.status !== 0) fail("accepted transition target is malformed"); return JSON.parse(result.stdout); }
  catch { fail("accepted transition target is malformed"); }
}
function canonicalRelease(value) {
  const prerelease = typeof value.version === "string" ? value.version.match(/^1\.1\.0-(beta|rc)\.([1-9][0-9]{0,15})$/) : null;
  const channel = prerelease?.[1] ?? (value.version === "1.1.0" ? "stable" : undefined), build = channel === "stable" ? /^[1-9][0-9]*$/ : /^[0-9]+$/;
  if (!channel || value.channel !== channel || channel === "beta" && prerelease[2].length > 4 || value.tag !== `v${value.version}` || typeof value.build !== "string" || !build.test(value.build)) fail("accepted transition target release identity is invalid");
}
function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}

export function parseAcceptedDesktopTransitionTarget(input) {
  if (!(input instanceof Uint8Array) || !input.length || input.length > MAX_INPUT) fail("accepted transition target must be bounded bytes");
  const raw = Buffer.from(input), receipt = exact(strictJSON(raw), RECEIPT_FIELDS, "accepted transition target"), target = exact(receipt.acceptedTarget, TARGET_FIELDS, "accepted target"), current = exact(receipt.current, CURRENT_FIELDS, "accepted current release");
  const canonical = Buffer.from(`${JSON.stringify({ schemaVersion: receipt.schemaVersion, kind: receipt.kind, action: receipt.action, acceptedTarget: Object.fromEntries(TARGET_FIELDS.map((field) => [field, target[field]])), current: Object.fromEntries(CURRENT_FIELDS.map((field) => [field, current[field]])), previouslyAcceptedTargetPacketSHA256: receipt.previouslyAcceptedTargetPacketSHA256 })}\n`);
  if (!raw.equals(canonical) || receipt.schemaVersion !== 1 || receipt.kind !== KIND || !["update", "rollback", "reupdate"].includes(receipt.action)) fail("accepted transition target is not canonical");
  for (const value of [target.packetSHA256, target.artifactSHA256, target.treeSHA256, target.sparklePublicKeySHA256, current.packetSHA256, current.artifactSHA256, current.treeSHA256]) if (!SHA256.test(value ?? "")) fail("accepted transition target digest is invalid");
  for (const value of [target.sourceSHA, target.tagObjectSHA, target.evidenceWorkflowSourceSHA, current.sourceSHA, current.tagObjectSHA]) if (!SHA1.test(value ?? "")) fail("accepted transition target source identity is invalid");
  canonicalRelease(target); canonicalRelease(current);
  const previous = receipt.previouslyAcceptedTargetPacketSHA256, targetBuild = BigInt(target.build), currentBuild = BigInt(current.build), forward = receipt.action !== "rollback";
  if ((previous !== null && !SHA256.test(previous ?? "")) || receipt.action === "update" && previous !== null || receipt.action !== "update" && previous !== target.packetSHA256 || forward && targetBuild <= currentBuild || !forward && targetBuild >= currentBuild || target.packetSHA256 === current.packetSHA256 || target.tag === current.tag || target.build === current.build || target.artifactSHA256 === current.artifactSHA256 || target.treeSHA256 === current.treeSHA256) fail("accepted transition target history identity is invalid");
  return freeze(receipt);
}
