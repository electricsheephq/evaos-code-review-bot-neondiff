#!/usr/bin/env node

import { createRequire } from "node:module";
import { closeSync, constants, fstatSync, openSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

const BETA_FEED = "https://www.neondiff.com/updates/beta/appcast.xml";
const { default: Ajv } = createRequire(import.meta.url)("ajv/dist/2020.js");
const json = (path) => JSON.parse(readFileSync(path, "utf8"));
const ajv = new Ajv({ allErrors: true, strict: true });
const declarationSchema = json(new URL("../docs/schema/desktop-release-declaration-v1.schema.json", import.meta.url));
const indexSchema = json(new URL("../docs/schema/desktop-release-index-v1.schema.json", import.meta.url));
const validateDeclaration = ajv.compile(declarationSchema), validateIndex = ajv.compile(indexSchema);

function readRegular(path) {
  let fd;
  try { fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); if (!fstatSync(fd).isFile()) throw new Error(`non-regular file: ${path}`); return JSON.parse(readFileSync(fd, "utf8")); }
  catch (error) { if (error?.code === "ELOOP") throw new Error(`symlink or non-regular file: ${path}`); throw error; }
  finally { if (fd !== undefined) closeSync(fd); }
}
function fail(message) { throw new Error(message); }
function pathIn(directory, name) {
  if (isAbsolute(name) || name.includes("\\") || name.split("/").some((part) => !part || part === "." || part === "..")) fail(`unsafe declaration path: ${name}`);
  const target = resolve(directory, name);
  if (relative(directory, target).startsWith("..") || dirname(target) !== resolve(directory)) fail(`declaration path escapes directory: ${name}`);
  return target;
}
function realDirectory(path) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
    if (!fstatSync(fd).isDirectory()) fail("declaration directory is not a directory");
    const canonical = resolve(realpathSync(path)), expected = resolve(realpathSync(dirname(path)), basename(path));
    if (canonical !== expected) fail("declaration directory symlinked");
    return canonical;
  } catch (error) { if (error?.code === "ELOOP") fail("declaration directory symlinked"); throw error; }
  finally { if (fd !== undefined) closeSync(fd); }
}
function check(value, valid, label) { if (!valid(value)) fail(`${label} schema invalid: ${ajv.errorsText(valid.errors)}`); }

function main() {
  if (process.argv.length !== 4 || process.argv[2] !== "--index") fail("usage: validate-desktop-release-declaration.mjs --index PATH");
  const indexPath = resolve(process.argv[3]), index = readRegular(indexPath);
  check(index, validateIndex, "index");
  const directory = resolve(dirname(indexPath), index.declarationDirectory), directoryCanonical = realDirectory(directory);
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
    const version = declaration.version, match = version.match(/^1\.1\.0-(beta|rc)\.([1-9][0-9]{0,15})$/), sequenceText = match?.[2] ?? "";
    if (!match || declaration.tag !== `v${version}` || name !== `${declaration.tag}.json` || declaration.channel !== match[1] || sequenceText.length > 15 && sequenceText > "9007199254740991" || String(declaration.sequence) !== sequenceText) fail(`mixed declaration identity: ${name}`);
    const expectedArtifact = `NeonDiff-${version}-build${declaration.build}-macOS.zip`;
    if (declaration.distribution.artifactName !== expectedArtifact || declaration.distribution.origins.feed !== BETA_FEED) fail(`unsupported channel/feed identity: ${name}`);
  }
  const ordered = [...declarations].sort((a, b) => a[1].build - b[1].build || a[0].localeCompare(b[0]));
  if (ordered.some((item, i) => i && item[1].build <= ordered[i - 1][1].build)) fail("retained builds must be unique and strictly increasing");
  if (JSON.stringify(index.declarationPaths) !== JSON.stringify(ordered.map(([name]) => name))) fail("declarationPaths must be deterministic build order");
  const lastSequence = new Map(), seenRC = { value: false };
  ordered.forEach(([name, declaration]) => {
    if (declaration.channel === "beta" && seenRC.value) fail(`beta cannot follow RC: ${name}`);
    if (declaration.channel === "rc") seenRC.value = true;
    const previous = lastSequence.get(declaration.channel);
    if (previous !== undefined && declaration.sequence <= previous) fail(`channel sequence must increase: ${name}`);
    lastSequence.set(declaration.channel, declaration.sequence);
  });
  ordered.forEach(([name, declaration], i) => { if (declaration.predecessor !== (i ? ordered[i - 1][0] : null)) fail(`predecessor mismatch: ${name}`); });
  if (index.currentPath !== ordered.at(-1)[0]) fail("currentPath must be newest compatible declaration");
  if (resolve(realpathSync(directory)) !== directoryCanonical) fail("declaration directory changed during validation");
  return `${index.declarationPaths.length} declarations; currentPath=${index.currentPath}`;
}

try { console.log(main()); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
