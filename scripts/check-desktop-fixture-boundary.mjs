#!/usr/bin/env node
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

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
  "DesktopEvaluationEvidenceManifest",
  "DesktopEvaluationLaunchContext",
  "DesktopEvaluationModelAdapter",
  "DesktopEvaluationDependencies",
  "DesktopEvaluationReadiness",
  "DesktopResolvedEvaluationFixture",
  "NeonDiffDesktopFixtureResolve",
  "DesktopModelInitialState",
  "applyInitialState",
  "NEONDIFF_DESKTOP_EVALUATION_READY_PATH",
  "RecordingDesktopDependencies",
  "NEONDIFF_DESKTOP_VISUAL_PROOF_FIXTURE",
  "VisualProofDesktopDependencies",
  "VisualProofSecretStore"
];
const FORBIDDEN_CONTENT_MARKERS = [
  ...FORBIDDEN_MARKERS.map((marker) => ({ marker, bytes: Buffer.from(marker) })),
  { marker: "content:tab-overview", bytes: Buffer.from('"tab-overview"') }
];
const FORBIDDEN_PATH_MARKERS = [
  { marker: "path:fixtures/ui", matches: (path) => path.includes("/fixtures/ui/") },
  { marker: "path:tab-overview.json", matches: (path) => path.endsWith("/tab-overview.json") },
  {
    marker: "path:NeonDiffDesktopFixtureResolve",
    matches: (path) => path.includes("/neondiffdesktopfixtureresolve")
  }
];
const ALLOWED_DSYM_DEBUG_SOURCE_FILENAMES = [
  "DesktopEvaluationDependencies.swift",
  "DesktopEvaluationEvidenceManifest.swift",
  "DesktopEvaluationFixture.swift",
  "DesktopEvaluationFixtureCatalog.swift",
  "DesktopEvaluationLaunchContext.swift",
  "DesktopEvaluationLaunchOptions.swift",
  "DesktopEvaluationModelAdapter.swift",
  "DesktopEvaluationReadiness.swift",
  "DesktopResolvedEvaluationFixture.swift",
  "RecordingDesktopDependencies.swift",
  "VisualProofDesktopDependencies.swift"
].map((filename) => Buffer.from(filename));

function maskAllowedDsymSourceFilenames(data) {
  const masked = Buffer.from(data);
  for (const filename of ALLOWED_DSYM_DEBUG_SOURCE_FILENAMES) {
    let offset = 0;
    while ((offset = masked.indexOf(filename, offset)) >= 0) {
      masked.fill(0, offset, offset + filename.length);
      offset += filename.length;
    }
  }
  return masked;
}

function collectFiles(inputPaths) {
  const files = [];
  const pending = inputPaths.map((inputPath) => {
    const path = resolve(inputPath);
    const stat = lstatSync(path);
    const root = realpathSync(stat.isDirectory() ? path : dirname(path));
    return { path, root };
  });
  const visitedDirectories = new Set();
  const visitedFiles = new Set();
  while (pending.length > 0) {
    const { path, root } = pending.pop();
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      const target = realpathSync(path);
      const targetRelativePath = relative(root, target);
      if (targetRelativePath === ".." || targetRelativePath.startsWith(`..${sep}`) || isAbsolute(targetRelativePath)) {
        throw new Error(`symlink escapes artifact root: ${path}`);
      }
      pending.push({ path: target, root });
      continue;
    }
    const realPath = realpathSync(path);
    if (stat.isDirectory()) {
      if (visitedDirectories.has(realPath)) continue;
      visitedDirectories.add(realPath);
      for (const entry of readdirSync(realPath)) pending.push({ path: resolve(realPath, entry), root });
      continue;
    }
    if (!stat.isFile()) continue;
    if (visitedFiles.has(realPath)) continue;
    visitedFiles.add(realPath);
    if (stat.size > MAX_FILE_BYTES) throw new Error(`artifact file exceeds scan bound: ${path}`);
    files.push({
      path: realPath,
      relativePath: `/${relative(root, realPath).split(sep).join("/")}`,
      size: stat.size
    });
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
    const normalizedPath = file.relativePath.toLowerCase();
    for (const rule of FORBIDDEN_PATH_MARKERS) {
      if (rule.matches(normalizedPath)) {
        violations.push({ path: file.path, marker: rule.marker });
      }
    }
    const data = readFileSync(file.path);
    const normalizedRealPath = file.path.split(sep).join("/").toLowerCase();
    const content = normalizedRealPath.includes(".dsym/contents/resources/dwarf/")
      ? maskAllowedDsymSourceFilenames(data)
      : data;
    for (const rule of FORBIDDEN_CONTENT_MARKERS) {
      if (content.includes(rule.bytes)) violations.push({ path: file.path, marker: rule.marker });
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
