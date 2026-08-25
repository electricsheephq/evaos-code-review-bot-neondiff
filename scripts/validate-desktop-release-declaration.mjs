#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { closeSync, constants, fstatSync, openSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { parseAcceptedDesktopReleasePacket } from "./lib/desktop-accepted-release-packet.mjs";
import { parseAcceptedDesktopTransitionTarget } from "./lib/desktop-accepted-transition-target.mjs";

const BETA_FEED = "https://www.neondiff.com/updates/beta/appcast.xml", STABLE_FEED = "https://www.neondiff.com/updates/stable/appcast.xml";
const MAX_SAFE = "9007199254740991";
const MAX_INPUT = 4 * 1024 * 1024;
const { default: Ajv } = createRequire(import.meta.url)("ajv/dist/2020.js");
const json = (path) => JSON.parse(readFileSync(path, "utf8"));
const ajv = new Ajv({ allErrors: true, strict: true });
const declarationSchema = json(new URL("../docs/schema/desktop-release-declaration-v1.schema.json", import.meta.url));
const indexSchema = json(new URL("../docs/schema/desktop-release-index-v1.schema.json", import.meta.url));
const validateDeclaration = ajv.compile(declarationSchema), validateIndex = ajv.compile(indexSchema);

function fail(message) { throw new Error(message); }
function decodeJsonKey(raw, start, end) {
  let key = "";
  for (let i = start + 1; i < end; i += 1) {
    if (raw[i] !== "\\") { key += raw[i]; continue; }
    const escaped = raw[++i];
    if (escaped === "u") { const code = raw.slice(i + 1, i + 5); if (!/^[0-9a-fA-F]{4}$/.test(code)) return null; key += String.fromCharCode(Number.parseInt(code, 16)); i += 4; continue; }
    key += ({ '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" })[escaped] ?? escaped;
  }
  return key;
}
function rejectDuplicateKeys(raw) {
  const objects = []; let inString = false; let escaped = false; let start = 0;
  for (let i = 0; i < raw.length; i += 1) {
    const char = raw[i];
    if (!inString) { if (char === '"') { inString = true; start = i; } else if (char === "{") objects.push(new Set()); else if (char === "}") objects.pop(); continue; }
    if (escaped) { escaped = false; continue; }
    if (char === "\\") { escaped = true; continue; }
    if (char !== '"') continue;
    inString = false; let next = i + 1;
    while (/\s/.test(raw[next] ?? "")) next += 1;
    if (raw[next] !== ":" || !objects.length) continue;
    const key = decodeJsonKey(raw, start, i); if (key === null) fail("invalid object key");
    const keys = objects.at(-1); if (keys.has(key)) fail(`duplicate object key: ${key}`); keys.add(key);
  }
}
function sameFile(left, right) { return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs; }
function readRawRegular(path) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const before = fstatSync(fd, { bigint: true }); if (!before.isFile() || before.size > BigInt(MAX_INPUT)) fail(`non-regular or oversized file: ${path}`);
    const bytes = readFileSync(fd), after = fstatSync(fd, { bigint: true }); if (!after.isFile() || !sameFile(before, after) || BigInt(bytes.length) !== before.size) fail(`file changed during read: ${path}`);
    const raw = bytes.toString("utf8"); if (!Buffer.from(raw, "utf8").equals(bytes)) fail(`invalid UTF-8 file: ${path}`);
    if (/(?:"build"\s*:\s*(?!"[0-9]+")|"sequence"\s*:\s*(?!"[0-9]+"|null))/.test(raw)) fail("identity fields must be quoted decimal text or null sequence");
    rejectDuplicateKeys(raw);
    return { bytes, raw };
  } catch (error) { if (error?.code === "ELOOP") fail(`symlink or non-regular file: ${path}`); throw error; }
  finally { if (fd !== undefined) closeSync(fd); }
}
function readRegular(path) { return JSON.parse(readRawRegular(path).raw); }
function openDirectory(path) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isDirectory()) fail("declaration directory is not a directory");
    return { fd, stat };
  } catch (error) { if (error?.code === "ELOOP") fail("declaration directory symlinked"); if (fd !== undefined) closeSync(fd); throw error; }
}
function sameDirectory(path, stat) { try { const current = statSync(path); return current.dev === stat.dev && current.ino === stat.ino; } catch { return false; } }
function pathIn(directory, name) {
  if (isAbsolute(name) || name.includes("\\") || name.split("/").some((part) => !part || part === "." || part === "..")) fail(`unsafe declaration path: ${name}`);
  const target = resolve(directory, name);
  if (relative(directory, target).startsWith("..") || dirname(target) !== resolve(directory)) fail(`declaration path escapes directory: ${name}`);
  return target;
}
function check(value, valid, label) { if (!valid(value)) fail(`${label} schema invalid: ${ajv.errorsText(valid.errors)}`); }
function buildCompare(a, b) { const left = BigInt(a), right = BigInt(b); return left < right ? -1 : left > right ? 1 : 0; }
function targetFiles(directory, missingAllowed = false) {
  let handle;
  try { handle = openDirectory(directory); }
  catch (error) { if (missingAllowed && error?.code === "ENOENT") return null; throw error; }
  const files = new Map(); let convention = false;
  try {
    const entries = readdirSync(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink() || !entry.isFile()) fail(`invalid accepted target entry: ${entry.name}`);
      const evidence = readRawRegular(resolve(directory, entry.name));
      if (entry.name === ".gitkeep") { if (evidence.bytes.length !== 0) fail("accepted target empty convention must be empty"); convention = true; continue; }
      const match = entry.name.match(/^([a-f0-9]{64})\.(packet|target)\.json$/);
      if (!match || createHash("sha256").update(evidence.bytes).digest("hex") !== match[1]) fail(`accepted target content address invalid: ${entry.name}`);
      const value = match[2] === "packet" ? parseAcceptedDesktopReleasePacket(evidence.bytes) : parseAcceptedDesktopTransitionTarget(evidence.bytes);
      files.set(entry.name, { bytes: evidence.bytes, type: match[2], value });
    }
    if (convention !== (files.size === 0) || convention && entries.length !== 1) fail("accepted target .gitkeep is only valid for empty history");
    if (!sameDirectory(directory, handle.stat)) fail("accepted target directory changed during validation");
    return { files, convention };
  } finally { closeSync(handle.fd); }
}
function packetRecord(history, digest, label) {
  const record = history.files.get(`${digest}.packet.json`);
  if (!record || record.type !== "packet") fail(`${label} references missing packet history`);
  return record.value;
}
function comparePacketIdentity(receipt, packet, label) {
  for (const field of ["tag", "version", "build", "channel", "sourceSHA", "tagObjectSHA", "artifactSHA256", "treeSHA256"]) if (receipt[field] !== packet[field]) fail(`${label} disagrees with referenced packet`);
}
function validateTargetHistory(root, baseRoot, initial) {
  const current = targetFiles(resolve(root, "accepted-targets"));
  if (initial && !current.convention) fail("initial history requires empty accepted target history");
  for (const record of current.files.values()) if (record.type === "target") {
    const target = packetRecord(current, record.value.acceptedTarget.packetSHA256, "accepted target"), currentPacket = packetRecord(current, record.value.current.packetSHA256, "accepted current release");
    comparePacketIdentity(record.value.acceptedTarget, target, "accepted target"); comparePacketIdentity(record.value.current, currentPacket, "accepted current release");
    if (record.value.previouslyAcceptedTargetPacketSHA256 !== null) packetRecord(current, record.value.previouslyAcceptedTargetPacketSHA256, "previous accepted target");
  }
  if (!baseRoot) return;
  const base = targetFiles(resolve(baseRoot, "accepted-targets"), true);
  if (!base) { if (current.files.size) fail("accepted target history comparison is unavailable"); return; }
  for (const [name, value] of base.files) { const retained = current.files.get(name); if (!retained || !retained.bytes.equals(value.bytes)) fail(`accepted target history rewritten: ${name}`); }
}
function validateTransition(index, directory, baseIndexPath) {
  const base = readRegular(baseIndexPath);
  check(base, validateIndex, "base index");
  if (base.status !== "retained") return;
  if (index.status !== "retained") fail("retained history cannot regress to empty");
  if (base.declarationPaths.some((name, i) => index.declarationPaths[i] !== name)) fail("retained declaration history must be an exact prefix");
  const baseDirectory = resolve(dirname(baseIndexPath), base.declarationDirectory), baseHandle = openDirectory(baseDirectory);
  try {
    for (const name of base.declarationPaths) {
      if (!readRawRegular(pathIn(directory, name)).bytes.equals(readRawRegular(pathIn(baseDirectory, name)).bytes)) fail(`retained declaration rewritten: ${name}`);
    }
    if (!sameDirectory(baseDirectory, baseHandle.stat)) fail("base declaration directory changed during validation");
  } finally { closeSync(baseHandle.fd); }
}
function parseArgs() {
  const args = process.argv.slice(2);
  if (args.length === 2 && args[0] === "--index") return { indexPath: resolve(args[1]), baseIndexPath: null, initial: false };
  if (args.length === 4 && args[0] === "--index" && args[2] === "--base-index") return { indexPath: resolve(args[1]), baseIndexPath: resolve(args[3]), initial: false };
  if (args.length === 3 && args[0] === "--index" && args[2] === "--initial") return { indexPath: resolve(args[1]), baseIndexPath: null, initial: true };
  fail("usage: validate-desktop-release-declaration.mjs --index PATH [--base-index PATH|--initial]");
}

function main() {
  const { indexPath, baseIndexPath, initial } = parseArgs(), index = readRegular(indexPath);
  check(index, validateIndex, "index");
  if (initial && index.status !== "empty") fail("initial history requires the empty clean-checkout convention");
  validateTargetHistory(dirname(indexPath), baseIndexPath ? dirname(baseIndexPath) : null, initial);
  const directory = resolve(dirname(indexPath), index.declarationDirectory), handle = openDirectory(directory);
  try {
    const entries = readdirSync(directory, { withFileTypes: true }), listed = new Set(index.declarationPaths);
    let convention = false;
    for (const entry of entries) {
      if (entry.isSymbolicLink()) fail(`symlink entry: ${entry.name}`);
      if (entry.name === ".gitkeep") { if (!entry.isFile()) fail("empty convention must be a regular file"); convention = true; continue; }
      if (!entry.isFile() || !listed.has(entry.name)) fail(`unindexed declaration entry: ${entry.name}`);
    }
    if (index.status === "empty") { if (!convention || entries.length !== 1) fail("empty index requires only tracked .gitkeep convention"); if (!sameDirectory(directory, handle.stat)) fail("declaration directory changed during validation"); if (baseIndexPath) { validateTransition(index, directory, baseIndexPath); if (!sameDirectory(directory, handle.stat)) fail("declaration directory changed during transition"); } return "empty"; }
    if (convention) fail(".gitkeep is only valid for an empty index");
    const declarations = index.declarationPaths.map((name) => [name, readRegular(pathIn(directory, name))]);
    for (const [name, declaration] of declarations) {
      check(declaration, validateDeclaration, `declaration ${name}`);
      const match = declaration.version.match(/^1\.1\.0(?:-(beta|rc)\.([1-9][0-9]{0,15}))?$/), channel = match?.[1] ?? "stable", sequence = match?.[2] ?? null;
      if (!match || declaration.tag !== `v${declaration.version}` || name !== `${declaration.tag}.json` || declaration.channel !== channel || declaration.sequence !== sequence || sequence !== null && sequence.length > 15 && BigInt(sequence) > BigInt(MAX_SAFE)) fail(`mixed declaration identity: ${name}`);
      const feed = channel === "stable" ? STABLE_FEED : BETA_FEED;
      if (declaration.distribution.artifactName !== `NeonDiff-${declaration.version}-build${declaration.build}-macOS.zip` || declaration.distribution.origins.feed !== feed) fail(`unsupported channel/feed identity: ${name}`);
    }
    const ordered = [...declarations].sort((a, b) => buildCompare(a[1].build, b[1].build) || a[0].localeCompare(b[0]));
    if (ordered.some((item, i) => i && buildCompare(item[1].build, ordered[i - 1][1].build) <= 0)) fail("retained builds must be unique and strictly increasing");
    if (JSON.stringify(index.declarationPaths) !== JSON.stringify(ordered.map(([name]) => name))) fail("declarationPaths must be deterministic build order");
    const lastSequence = new Map(); let seenRC = false, seenStable = false;
    for (const [name, declaration] of ordered) {
      if (declaration.channel === "stable") { if (seenStable) fail(`duplicate stable declaration: ${name}`); seenStable = true; continue; }
      if (seenStable) fail(`pre-release cannot follow stable: ${name}`);
      if (declaration.channel === "beta" && seenRC) fail(`beta cannot follow RC: ${name}`);
      if (declaration.channel === "rc") seenRC = true;
      const previous = lastSequence.get(declaration.channel);
      if (previous !== undefined && BigInt(declaration.sequence) <= BigInt(previous)) fail(`channel sequence must increase: ${name}`);
      lastSequence.set(declaration.channel, declaration.sequence);
    }
    ordered.forEach(([name, declaration], i) => { if (declaration.predecessor !== (i ? ordered[i - 1][0] : null)) fail(`predecessor mismatch: ${name}`); });
    if (index.currentPath !== ordered.at(-1)[0]) fail("currentPath must be newest compatible declaration");
    if (!sameDirectory(directory, handle.stat)) fail("declaration directory changed during validation");
    if (baseIndexPath) { validateTransition(index, directory, baseIndexPath); if (!sameDirectory(directory, handle.stat)) fail("declaration directory changed during transition"); }
    return `${index.declarationPaths.length} declarations; currentPath=${index.currentPath}`;
  } finally { closeSync(handle.fd); }
}

try { console.log(main()); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
