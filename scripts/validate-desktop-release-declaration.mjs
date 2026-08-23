#!/usr/bin/env node

import { closeSync, constants, fstatSync, openSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const declarationSchema = JSON.parse(readFileSync(resolve(here, "../docs/schema/desktop-release-declaration-v1.schema.json"), "utf8"));
const indexSchema = JSON.parse(readFileSync(resolve(here, "../docs/schema/desktop-release-index-v1.schema.json"), "utf8"));
let DefaultAjv;
try { DefaultAjv = (await import("ajv/dist/2020.js")).Ajv2020; } catch {}
const VERSION = /^1\.1\.0(?:-(beta\.[1-9][0-9]{0,3}|rc\.[1-9][0-9]*))?$/;
const NAME = /^v1\.1\.0(?:-(?:beta\.[1-9][0-9]{0,3}|rc\.[1-9][0-9]*))?\.json$/;
const READ_ONLY = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
const DIRECTORY = constants.O_DIRECTORY ?? 0;
const fail = (...errors) => ({ valid: false, errors });
function compile(schema, override) {
  const Ajv = override === undefined ? DefaultAjv : override;
  if (!Ajv) return null;
  try { return new Ajv({ allErrors: true, strict: true }).compile(schema); } catch { return null; }
}
function check(value, schema, override) {
  const validator = compile(schema, override);
  if (!validator) return fail("schema validator unavailable");
  return validator(value) ? { valid: true, errors: [] } : fail("schema validation failed");
}
function versionParts(version) { const match = VERSION.exec(version ?? ""); return match && { channel: match[1] ?? "stable", number: match[2] ?? "" }; }
export function validateDesktopReleaseDeclaration(value, options = {}) {
  const shape = check(value, declarationSchema, Object.hasOwn(options, "ajv") ? options.ajv : undefined);
  if (!shape.valid) return shape;
  const parts = versionParts(value.version);
  if (!parts) return fail("version/tag must be canonical");
  const expectedContract = "paid-mac-beta-byo-v1";
  const expectedTag = `v${value.version}`;
  const expectedName = `NeonDiff-${value.version}-build${value.build}-macOS.zip`;
  const errors = [];
  if (!parts || value.tag !== expectedTag) errors.push("version/tag must be canonical");
  if (value.contract !== expectedContract) errors.push("contract does not match release class");
  if (value.distribution.artifactName !== expectedName) errors.push("artifact name does not match version");
  return errors.length ? fail(...errors) : { valid: true, errors: [] };
}
function safeRelative(value) {
  return typeof value === "string" && value && !value.startsWith("/") && !value.includes("\\") && value === value.split("/").filter(Boolean).join("/") && !value.split("/").some((part) => part === "." || part === "..") && value === value.replace(/\/\.\//g, "/");
}
function openRead(path, directory = false) {
  let fd;
  try {
    fd = openSync(path, READ_ONLY | (directory ? DIRECTORY : 0));
    const stat = fstatSync(fd);
    if (directory ? !stat.isDirectory() : !stat.isFile()) throw Error("unexpected declaration file type");
    return { fd, stat };
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    if (error?.code === "ELOOP") throw Error("symlinks are not allowed");
    throw Error("declaration path unreadable");
  }
}
function discover(root, expectedRoot) {
  const found = [];
  const files = new Map();
  let entryCount = 0;
  let canonical;
  try { canonical = realpathSync(root); } catch { throw Error("declaration directory unreadable or symlinked"); }
  if (resolve(canonical) !== resolve(expectedRoot)) throw Error("declaration directory symlinked");
  function visit(directory, expectedDirectory) {
    let directoryCanonical;
    try { directoryCanonical = realpathSync(directory); } catch { throw Error("declaration directory unreadable or symlinked"); }
    if (resolve(directoryCanonical) !== resolve(expectedDirectory)) throw Error("declaration directory symlinked");
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }); } catch { throw Error("declaration directory unreadable"); }
    entryCount += entries.length;
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) { visit(path, resolve(expectedRoot, relative(root, path))); continue; }
      const child = openRead(path);
      try {
        if (entry.name.endsWith(".json")) {
          const pathName = relative(root, path).split(sep).join("/");
          if (pathName !== basename(path) || !NAME.test(entry.name)) throw Error("noncanonical declaration filename");
          let content;
          try { content = readFileSync(child.fd, "utf8"); } catch { throw Error("declaration file unreadable"); }
          files.set(pathName, content);
          found.push(pathName);
        }
      } finally { closeSync(child.fd); }
    }
  }
  visit(root, expectedRoot);
  return { paths: found.sort(), files, entryCount };
}
export function validateDesktopReleaseIndex(indexPath, options = {}) {
  const override = Object.hasOwn(options, "ajv") ? options.ajv : undefined;
  const shape = check({}, indexSchema, override);
  if (!shape.valid && shape.errors[0] === "schema validator unavailable") return shape;
  let index;
  try { index = JSON.parse(readFileSync(resolve(indexPath), "utf8")); } catch { return fail("index unreadable or invalid JSON"); }
  const indexResult = check(index, indexSchema, override);
  if (!indexResult.valid) return indexResult;
  if (!safeRelative(index.declarationDirectory)) return fail("declaration directory traversal or absolute path");
  const base = resolve(dirname(indexPath));
  let canonicalBase;
  try { canonicalBase = realpathSync(base); } catch { return fail("index parent directory unreadable or symlinked"); }
  const root = resolve(base, index.declarationDirectory);
  const expectedRoot = resolve(canonicalBase, index.declarationDirectory);
  let discovered;
  try { discovered = discover(root, expectedRoot); } catch (error) { return fail(error.message); }
  const listed = [...index.declarationPaths].sort();
  const discoveredPaths = discovered.paths;
  if (listed.some((path) => !safeRelative(path) || !NAME.test(path))) return fail("index contains unsafe or noncanonical path");
  if (listed.length !== new Set(listed).size || JSON.stringify(discoveredPaths) !== JSON.stringify(listed)) return fail("index does not exactly enumerate declarations");
  if (index.status === "empty" && (discoveredPaths.length || discovered.entryCount)) return fail("empty index requires an empty declaration directory");
  if (index.status === "current" && (!discoveredPaths.length || !index.currentPath || !listed.includes(index.currentPath))) return fail("current index requires a listed declaration");
  if (index.status === "empty" && index.currentPath !== null) return fail("empty index currentPath must be null");
  for (const path of discoveredPaths) {
    let declaration;
    try { declaration = JSON.parse(discovered.files.get(path)); } catch { return fail(`${path}: unreadable or invalid JSON`); }
    if (path !== `v${declaration.version}.json`) return fail(`${path}: filename does not match version`);
    const result = validateDesktopReleaseDeclaration(declaration, options);
    if (!result.valid) return fail(`${path}: ${result.errors.join("; ")}`);
  }
  return { valid: true, errors: [] };
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const mode = process.argv[2], path = mode === "--index" ? process.argv[3] : mode;
  if (!path) { console.error("usage: node scripts/validate-desktop-release-declaration.mjs [--index] <path>"); process.exitCode = 64; }
  else { const result = mode === "--index" ? validateDesktopReleaseIndex(path) : (() => { try { return validateDesktopReleaseDeclaration(JSON.parse(readFileSync(resolve(path), "utf8"))); } catch { return fail("declaration unreadable or invalid JSON"); } })(); if (!result.valid) { for (const error of result.errors) console.error(error); process.exitCode = 1; } }
}
