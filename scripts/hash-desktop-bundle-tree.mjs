#!/usr/bin/env node
import { createHash } from "node:crypto";
import { isAbsolute, posix, resolve } from "node:path";
import { walkDescriptorTree } from "./shared/safe-fs.mjs";

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
if (!directoryMode && !root.endsWith(".app")) {
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

function assertSafeLink(relativePath, target) {
  if (isAbsolute(target)) fail(`absolute symlink target is not allowed: ${relativePath}`);
  const resolved = posix.normalize(posix.join(posix.dirname(relativePath), target));
  if (resolved === ".." || resolved.startsWith("../")) {
    fail(`symlink escapes bundle root: ${relativePath}`);
  }
}

try {
  walkDescriptorTree(root, (entry) => {
    if (entry.type === "symlink") {
      assertSafeLink(entry.relativePath, entry.target);
      updateRecord(["link", entry.relativePath, entry.target]);
    } else if (entry.type === "directory") {
      updateRecord(["dir", entry.relativePath]);
    } else {
      const fileHash = createHash("sha256").update(entry.data).digest("hex");
      const executable = (entry.stat.mode & 0o111) === 0 ? "-" : "x";
      updateRecord(["file", entry.relativePath, executable, entry.stat.size, fileHash]);
    }
  });
} catch (error) {
  fail(error instanceof Error ? error.message : "descriptor-relative tree traversal failed");
}
process.stdout.write(`${JSON.stringify({ algorithm: "sha256-tree-v1", sha256: digest.digest("hex"), entryCount })}\n`);
