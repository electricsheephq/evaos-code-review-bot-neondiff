#!/usr/bin/env node

import { createRequire } from "node:module";
import { closeSync, constants, fstatSync, openSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

const BETA_FEED = "https://www.neondiff.com/updates/beta/appcast.xml";
const MAX_SAFE = "9007199254740991";
const { default: Ajv } = createRequire(import.meta.url)("ajv/dist/2020.js");
const json = (path) => JSON.parse(readFileSync(path, "utf8"));
const ajv = new Ajv({ allErrors: true, strict: true });
const declarationSchema = json(new URL("../docs/schema/desktop-release-declaration-v1.schema.json", import.meta.url));
const indexSchema = json(new URL("../docs/schema/desktop-release-index-v1.schema.json", import.meta.url));
const validateDeclaration = ajv.compile(declarationSchema), validateIndex = ajv.compile(indexSchema);

function fail(message) { throw new Error(message); }
function rejectDuplicateIdentityKeys(raw) {
  const seen = new Set(); let inString = false; let escaped = false; let start = 0;
  for (let i = 0; i < raw.length; i += 1) {
    const char = raw[i];
    if (!inString) { if (char === '"') { inString = true; start = i; } continue; }
    if (escaped) { escaped = false; continue; }
    if (char === "\\") { escaped = true; continue; }
    if (char !== '"') continue;
    inString = false; let next = i + 1;
    while (/\s/.test(raw[next] ?? "")) next += 1;
    if (raw[next] !== ":") continue;
    const key = JSON.parse(raw.slice(start, i + 1));
    if ((key === "build" || key === "sequence") && seen.has(key)) fail(`duplicate identity key: ${key}`);
    if (key === "build" || key === "sequence") seen.add(key);
  }
}
function readRegular(path) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    if (!fstatSync(fd).isFile()) fail(`non-regular file: ${path}`);
    const raw = readFileSync(fd, "utf8");
    if (/(?:"build"|"sequence")\s*:\s*(?!"[0-9]+")/.test(raw)) fail("identity fields must be quoted decimal text");
    rejectDuplicateIdentityKeys(raw);
    return JSON.parse(raw);
  } catch (error) { if (error?.code === "ELOOP") fail(`symlink or non-regular file: ${path}`); throw error; }
  finally { if (fd !== undefined) closeSync(fd); }
}
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

function main() {
  if (process.argv.length !== 4 || process.argv[2] !== "--index") fail("usage: validate-desktop-release-declaration.mjs --index PATH");
  const indexPath = resolve(process.argv[3]), index = readRegular(indexPath);
  check(index, validateIndex, "index");
  const directory = resolve(dirname(indexPath), index.declarationDirectory), handle = openDirectory(directory);
  try {
    const entries = readdirSync(directory, { withFileTypes: true }), listed = new Set(index.declarationPaths);
    let convention = false;
    for (const entry of entries) {
      if (entry.isSymbolicLink()) fail(`symlink entry: ${entry.name}`);
      if (entry.name === ".gitkeep") { if (!entry.isFile()) fail("empty convention must be a regular file"); convention = true; continue; }
      if (!entry.isFile() || !listed.has(entry.name)) fail(`unindexed declaration entry: ${entry.name}`);
    }
    if (index.status === "empty") { if (!convention || entries.length !== 1) fail("empty index requires only tracked .gitkeep convention"); return "empty"; }
    if (convention) fail(".gitkeep is only valid for an empty index");
    const declarations = index.declarationPaths.map((name) => [name, readRegular(pathIn(directory, name))]);
    for (const [name, declaration] of declarations) {
      check(declaration, validateDeclaration, `declaration ${name}`);
      const match = declaration.version.match(/^1\.1\.0-(beta|rc)\.([1-9][0-9]{0,15})$/), sequence = match?.[2] ?? "";
      if (!match || declaration.tag !== `v${declaration.version}` || name !== `${declaration.tag}.json` || declaration.channel !== match[1] || declaration.sequence !== sequence || sequence.length > 15 && sequence > MAX_SAFE) fail(`mixed declaration identity: ${name}`);
      if (declaration.distribution.artifactName !== `NeonDiff-${declaration.version}-build${declaration.build}-macOS.zip` || declaration.distribution.origins.feed !== BETA_FEED) fail(`unsupported channel/feed identity: ${name}`);
    }
    const ordered = [...declarations].sort((a, b) => buildCompare(a[1].build, b[1].build) || a[0].localeCompare(b[0]));
    if (ordered.some((item, i) => i && buildCompare(item[1].build, ordered[i - 1][1].build) <= 0)) fail("retained builds must be unique and strictly increasing");
    if (JSON.stringify(index.declarationPaths) !== JSON.stringify(ordered.map(([name]) => name))) fail("declarationPaths must be deterministic build order");
    const lastSequence = new Map(); let seenRC = false;
    for (const [name, declaration] of ordered) {
      if (declaration.channel === "beta" && seenRC) fail(`beta cannot follow RC: ${name}`);
      if (declaration.channel === "rc") seenRC = true;
      const previous = lastSequence.get(declaration.channel);
      if (previous !== undefined && BigInt(declaration.sequence) <= BigInt(previous)) fail(`channel sequence must increase: ${name}`);
      lastSequence.set(declaration.channel, declaration.sequence);
    }
    ordered.forEach(([name, declaration], i) => { if (declaration.predecessor !== (i ? ordered[i - 1][0] : null)) fail(`predecessor mismatch: ${name}`); });
    if (index.currentPath !== ordered.at(-1)[0]) fail("currentPath must be newest compatible declaration");
    if (!sameDirectory(directory, handle.stat)) fail("declaration directory changed during validation");
    return `${index.declarationPaths.length} declarations; currentPath=${index.currentPath}`;
  } finally { closeSync(handle.fd); }
}

try { console.log(main()); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
