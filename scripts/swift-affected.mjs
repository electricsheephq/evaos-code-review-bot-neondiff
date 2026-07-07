#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const SWIFT_PATH_PREFIXES = [
  "apps/neondiff-desktop/"
];

const SWIFT_ROOT_FILES = new Set([
  "Package.swift",
  "Package.resolved"
]);

const SWIFT_WORKFLOW_FILES = new Set([
  ".github/workflows/codeql-swift-path-aware.yml",
  ".github/workflows/swift-desktop-gate.yml"
]);

export function isSwiftRelevantPath(file) {
  const normalized = file.replaceAll("\\", "/").replace(/^\.\/+/, "").trim();
  if (!normalized) return false;
  if (SWIFT_ROOT_FILES.has(normalized)) return true;
  if (SWIFT_WORKFLOW_FILES.has(normalized)) return true;
  return SWIFT_PATH_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

export function summarizeSwiftAffected(files) {
  const normalizedFiles = files
    .map((file) => file.replaceAll("\\", "/").replace(/^\.\/+/, "").trim())
    .filter(Boolean);
  const matched = normalizedFiles.filter(isSwiftRelevantPath);
  return {
    affected: matched.length > 0,
    matched,
    files: normalizedFiles
  };
}

function parseArgs(argv) {
  const args = [...argv];
  const parsed = {
    files: [],
    stdin: false,
    base: undefined,
    head: undefined
  };
  while (args.length) {
    const arg = args.shift();
    if (arg === "--stdin") {
      parsed.stdin = true;
    } else if (arg === "--files") {
      parsed.files.push(...args.splice(0));
    } else if (arg === "--base") {
      parsed.base = args.shift();
    } else if (arg === "--head") {
      parsed.head = args.shift();
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else if (arg) {
      parsed.files.push(arg);
    }
  }
  return parsed;
}

function readGitDiffFiles(base, head) {
  if (!base || !head) return [];
  try {
    return execFileSync("git", ["diff", "--name-only", `${base}...${head}`], { encoding: "utf8" }).split(/\r?\n/);
  } catch {
    return execFileSync("git", ["diff", "--name-only", base, head], { encoding: "utf8" }).split(/\r?\n/);
  }
}

function printUsage() {
  console.log(`usage:
  node scripts/swift-affected.mjs --files <path...>  # --files is terminal and consumes the remaining argv
  node scripts/swift-affected.mjs --stdin < changed-files.txt
  node scripts/swift-affected.mjs --base <git-ref> --head <git-ref>`);
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) {
  const args = parseArgs(process.argv.slice(2));
  const stdinFiles = args.stdin ? readFileSync(0, "utf8").split(/\r?\n/) : [];
  const gitFiles = args.base && args.head ? readGitDiffFiles(args.base, args.head) : [];
  const summary = summarizeSwiftAffected([...args.files, ...stdinFiles, ...gitFiles]);
  console.log(JSON.stringify(summary, null, 2));
}
