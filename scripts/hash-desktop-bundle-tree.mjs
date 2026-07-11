#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstat, readFile, readlink, readdir } from "node:fs/promises";
import { isAbsolute, posix, relative, resolve, sep } from "node:path";

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

const directoryMode = process.argv[2] === "--directory";
const input = directoryMode ? process.argv[3] : process.argv[2];
if (!input || process.argv.length !== (directoryMode ? 4 : 3)) {
  fail("usage: hash-desktop-bundle-tree.mjs [--directory] <path>");
}

const root = resolve(input);
let rootStat;
try {
  rootStat = await lstat(root);
} catch {
  fail("bundle path does not exist");
}
if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || (!directoryMode && !root.endsWith(".app"))) {
  fail(directoryMode ? "path must be a regular directory" : "bundle path must be a regular .app directory");
}

const digest = createHash("sha256");
let entryCount = 0;

function updateRecord(parts) {
  for (const part of parts) {
    digest.update(String(part), "utf8");
    digest.update("\0");
  }
  digest.update("\n");
  entryCount += 1;
}

function bytewise(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function packetPath(path) {
  return relative(root, path).split(sep).join(posix.sep);
}

function assertSafeLink(linkPath, target) {
  if (isAbsolute(target)) fail(`absolute symlink target is not allowed: ${packetPath(linkPath)}`);
  const resolved = resolve(linkPath, "..", target);
  if (resolved !== root && !resolved.startsWith(`${root}${sep}`)) {
    fail(`symlink escapes bundle root: ${packetPath(linkPath)}`);
  }
}

async function walk(directory) {
  const names = (await readdir(directory)).sort(bytewise);
  for (const name of names) {
    const path = resolve(directory, name);
    const rel = packetPath(path);
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) {
      const target = await readlink(path);
      assertSafeLink(path, target);
      updateRecord(["link", rel, target]);
    } else if (stat.isDirectory()) {
      updateRecord(["dir", rel]);
      await walk(path);
    } else if (stat.isFile()) {
      const data = await readFile(path);
      const fileHash = createHash("sha256").update(data).digest("hex");
      const executable = (stat.mode & 0o111) === 0 ? "-" : "x";
      updateRecord(["file", rel, executable, stat.size, fileHash]);
    } else {
      fail(`unsupported bundle entry type: ${rel}`);
    }
  }
}

await walk(root);
process.stdout.write(`${JSON.stringify({ algorithm: "sha256-tree-v1", sha256: digest.digest("hex"), entryCount })}\n`);
