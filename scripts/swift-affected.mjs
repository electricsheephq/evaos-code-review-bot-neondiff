#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const SWIFT_PATH_PREFIXES = [
  "apps/neondiff-desktop/Sources/",
  "apps/neondiff-desktop/Checks/",
  "apps/neondiff-desktop/Tests/",
  "apps/neondiff-desktop/UITests/",
  "apps/neondiff-desktop/NeonDiffDesktop.xcodeproj/",
  "apps/neondiff-desktop/script/",
  "apps/neondiff-desktop/scripts/",
  "apps/neondiff-desktop/fixtures/ui/"
];

const SWIFT_ROOT_FILES = new Set([
  "Package.swift",
  "Package.resolved",
  "apps/neondiff-desktop/Package.swift",
  "apps/neondiff-desktop/Package.resolved",
  "apps/neondiff-desktop/NeonDiffDesktop.xctestplan",
  "apps/neondiff-desktop/script/build_and_run.sh",
  "shared/canonical-secret-rules.json",
  "scripts/generate-secret-rules.mjs",
  "scripts/check-secret-corpus-boundary.mjs",
  "scripts/check-secret-rule-differential.mjs",
  "scripts/shared/swift-corpus-boundary.mjs",
  "scripts/check-desktop-fixture-boundary.mjs",
  "tests/desktop-evaluation-boundary.test.ts",
  "tests/desktop-repos-reachability-capture.test.ts",
  "tests/desktop-settled-geometry-capture.test.ts",
  "tests/desktop-hosted-xcuitest.test.ts",
  "scripts/secret-rule-foundation-runner.swift"
]);

const SWIFT_WORKFLOW_FILES = new Set([
  ".github/workflows/codeql-swift-path-aware.yml",
  ".github/workflows/swift-desktop-gate.yml"
]);

const EMPTY_LANES = Object.freeze({
  core: false,
  fixtureChecks: false,
  appCore: false,
  evaluationSupport: false,
  hostedXCUITest: false
});

const ALL_LANES = Object.freeze({
  core: true,
  fixtureChecks: true,
  appCore: true,
  evaluationSupport: true,
  hostedXCUITest: true
});

function normalizedPath(file) {
  return file.replaceAll("\\", "/").replace(/^\.\/+/, "").trim();
}

function lanesForPath(file) {
  const normalized = normalizedPath(file);
  if (!isSwiftRelevantPath(normalized)) return EMPTY_LANES;

  if (
    SWIFT_WORKFLOW_FILES.has(normalized)
    || SWIFT_ROOT_FILES.has(normalized)
    || normalized === "apps/neondiff-desktop/Package.swift"
    || normalized === "apps/neondiff-desktop/Package.resolved"
    || normalized.startsWith("apps/neondiff-desktop/script/")
    || normalized.startsWith("apps/neondiff-desktop/scripts/")
  ) {
    return ALL_LANES;
  }

  if (
    normalized.startsWith("apps/neondiff-desktop/Sources/NeonDiffDesktopCore/")
    || normalized.startsWith("apps/neondiff-desktop/Tests/NeonDiffDesktopCoreTests/")
  ) {
    return {
      ...EMPTY_LANES,
      core: true,
      fixtureChecks: true,
      appCore: true,
      evaluationSupport: true
    };
  }

  if (
    normalized.startsWith("apps/neondiff-desktop/Sources/NeonDiffDesktopAppCore/")
    || normalized.startsWith("apps/neondiff-desktop/Tests/NeonDiffDesktopAppCoreTests/")
  ) {
    return { ...EMPTY_LANES, appCore: true };
  }

  if (
    normalized.startsWith("apps/neondiff-desktop/Sources/NeonDiffDesktopEvaluationSupport/")
    || normalized.startsWith("apps/neondiff-desktop/Tests/NeonDiffDesktopEvaluationSupportTests/")
  ) {
    return { ...EMPTY_LANES, fixtureChecks: true, evaluationSupport: true };
  }

  if (
    normalized.startsWith("apps/neondiff-desktop/UITests/")
    || normalized.startsWith("apps/neondiff-desktop/NeonDiffDesktop.xcodeproj/")
    || normalized === "apps/neondiff-desktop/NeonDiffDesktop.xctestplan"
  ) {
    return { ...EMPTY_LANES, hostedXCUITest: true };
  }

  if (normalized.startsWith("apps/neondiff-desktop/Sources/NeonDiffDesktop/")) {
    return {
      ...EMPTY_LANES,
      fixtureChecks: true,
      appCore: true,
      hostedXCUITest: true
    };
  }

  if (
    normalized.startsWith("apps/neondiff-desktop/Sources/NeonDiffDesktopFixture")
    || normalized.startsWith("apps/neondiff-desktop/Sources/NeonDiffDesktopGeometry")
    || normalized.startsWith("apps/neondiff-desktop/Sources/NeonDiffDesktopReachability")
    || normalized.startsWith("apps/neondiff-desktop/Sources/NeonDiffDesktopSettledGeometry")
    || normalized.startsWith("apps/neondiff-desktop/Checks/")
    || normalized.startsWith("apps/neondiff-desktop/fixtures/ui/")
  ) {
    return {
      ...EMPTY_LANES,
      fixtureChecks: true,
      evaluationSupport: true,
      hostedXCUITest: true
    };
  }

  // An unclassified desktop path fails open to every lane. Adding a new
  // target must never silently reduce required CI coverage.
  return ALL_LANES;
}

export function isSwiftRelevantPath(file) {
  const normalized = normalizedPath(file);
  if (!normalized) return false;
  if (SWIFT_ROOT_FILES.has(normalized)) return true;
  if (SWIFT_WORKFLOW_FILES.has(normalized)) return true;
  return SWIFT_PATH_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

export function summarizeSwiftAffected(files) {
  const normalizedFiles = files
    .map(normalizedPath)
    .filter(Boolean);
  const matched = normalizedFiles.filter(isSwiftRelevantPath);
  const lanes = matched.reduce((summary, file) => {
    const classified = lanesForPath(file);
    for (const lane of Object.keys(summary)) {
      summary[lane] ||= classified[lane];
    }
    return summary;
  }, { ...EMPTY_LANES });
  return {
    affected: matched.length > 0,
    matched,
    files: normalizedFiles,
    lanes
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
    try {
      return execFileSync("git", ["diff", "--name-only", base, head], { encoding: "utf8" }).split(/\r?\n/);
    } catch {
      return [];
    }
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
