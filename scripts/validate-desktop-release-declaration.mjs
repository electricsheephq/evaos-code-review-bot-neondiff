#!/usr/bin/env node

import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const declarationSchema = JSON.parse(readFileSync(resolve(here, "../docs/schema/desktop-release-declaration-v1.schema.json"), "utf8"));
const indexSchema = JSON.parse(readFileSync(resolve(here, "../docs/schema/desktop-release-index-v1.schema.json"), "utf8"));
let DefaultAjv;
try { DefaultAjv = (await import("ajv/dist/2020.js")).Ajv2020; } catch {}
const VERSION = /^1\.1\.0(?:-(beta|rc)\.([1-9][0-9]*))?$/;
const NAME = /^v1\.1\.0(?:-(?:beta|rc)\.[1-9][0-9]*)?\.json$/;
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
  const expectedContract = parts.channel === "stable" ? "paid-mac-ga-byo-v1" : "paid-mac-beta-byo-v1";
  const expectedTag = `v${value.version}`;
  const expectedName = `NeonDiffDesktop-${value.version}.zip`;
  const errors = [];
  if (!parts || value.tag !== expectedTag) errors.push("version/tag must be canonical");
  if (value.contract !== expectedContract) errors.push("contract does not match release class");
  if (value.distribution.artifactName !== expectedName) errors.push("artifact name does not match version");
  return errors.length ? fail(...errors) : { valid: true, errors: [] };
}
function safeRelative(value) {
  return typeof value === "string" && value && !value.startsWith("/") && !value.includes("\\") && value === value.split("/").filter(Boolean).join("/") && !value.split("/").includes("..") && value === value.replace(/\/\.\//g, "/");
}
function discover(root) {
  const found = [];
  try { const stat = lstatSync(root); if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error(); } catch { throw Error("declaration directory unreadable or symlinked"); }
  function visit(directory) {
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }); } catch { throw Error("declaration directory unreadable"); }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      let stat;
      try { stat = lstatSync(path); } catch { throw Error("declaration path unreadable"); }
      if (stat.isSymbolicLink() || entry.isSymbolicLink()) throw Error("symlinks are not allowed");
      if (stat.isDirectory()) visit(path);
      else if (stat.isFile() && entry.name.endsWith(".json")) {
        const pathName = relative(root, path).split(sep).join("/");
        if (pathName !== basename(path) || !NAME.test(entry.name)) throw Error("noncanonical declaration filename");
        try { readFileSync(path, "utf8"); } catch { throw Error("declaration file unreadable"); }
        found.push(pathName);
      }
    }
  }
  visit(root);
  return found.sort();
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
  const root = resolve(dirname(indexPath), index.declarationDirectory);
  let discovered;
  try { discovered = discover(root); } catch (error) { return fail(error.message); }
  const listed = [...index.declarationPaths].sort();
  if (listed.some((path) => !safeRelative(path) || !NAME.test(path))) return fail("index contains unsafe or noncanonical path");
  if (listed.length !== new Set(listed).size || JSON.stringify(discovered) !== JSON.stringify(listed)) return fail("index does not exactly enumerate declarations");
  let directoryEntries;
  try { directoryEntries = readdirSync(root); } catch { return fail("declaration directory unreadable"); }
  if (index.status === "empty" && (discovered.length || directoryEntries.length)) return fail("empty index requires an empty declaration directory");
  if (index.status === "current" && (!discovered.length || !index.currentPath || !listed.includes(index.currentPath))) return fail("current index requires a listed declaration");
  if (index.status === "empty" && index.currentPath !== null) return fail("empty index currentPath must be null");
  for (const path of discovered) {
    let declaration;
    try { declaration = JSON.parse(readFileSync(join(root, path), "utf8")); } catch { return fail(`${path}: unreadable or invalid JSON`); }
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
