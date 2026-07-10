#!/usr/bin/env node
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const MAX_FILES = 20_000;
const MAX_FILE_BYTES = 128 * 1024 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const FORBIDDEN_MARKERS = [
  "--ui-testing",
  "--ui-fixture",
  "--content-size",
  "--disable-animations",
  "NEONDIFF_DESKTOP_EVALUATION_FIXTURE_V1",
  "DesktopEvaluationFixture",
  "DesktopEvaluationFixtureCatalog",
  "DesktopEvaluationEvidenceManifest"
];

function collectFiles(inputPaths) {
  const files = [];
  const pending = inputPaths.map((path) => resolve(path));
  while (pending.length > 0) {
    const path = pending.pop();
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      for (const entry of readdirSync(path)) pending.push(resolve(path, entry));
      continue;
    }
    if (!stat.isFile()) continue;
    if (stat.size > MAX_FILE_BYTES) throw new Error(`artifact file exceeds scan bound: ${path}`);
    files.push({ path, size: stat.size });
    if (files.length > MAX_FILES) throw new Error("artifact file count exceeds scan bound");
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function scan(inputPaths) {
  if (inputPaths.length === 0) throw new Error("provide at least one release artifact path");
  const files = collectFiles(inputPaths);
  let scannedBytes = 0;
  const violations = [];
  for (const file of files) {
    scannedBytes += file.size;
    if (scannedBytes > MAX_TOTAL_BYTES) throw new Error("artifact bytes exceed scan bound");
    const data = readFileSync(file.path);
    for (const marker of FORBIDDEN_MARKERS) {
      if (data.includes(Buffer.from(marker))) violations.push({ path: file.path, marker });
    }
  }
  return {
    ok: violations.length === 0,
    scannedFiles: files.length,
    scannedBytes,
    violationCount: violations.length,
    violations
  };
}

try {
  const report = scan(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (!report.ok) process.exitCode = 1;
} catch (error) {
  process.stderr.write(`desktop fixture boundary scan failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
}
