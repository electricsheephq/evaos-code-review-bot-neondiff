#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const NODE_VERSION = "26.7.0";
const NODE_ARCHIVES = {
  arm64: {
    filename: `node-v${NODE_VERSION}-darwin-arm64.tar.gz`,
    sha256: "7ee659a7768e641bbfd5360940660b8e8fd0052f77488f365562bac522fc15d4"
  },
  x64: {
    filename: `node-v${NODE_VERSION}-darwin-x64.tar.gz`,
    sha256: "f279d1ed28ce57f7788bf23435d2ad7fdd7438904ad5c4d8a1081a7cde3d4b96"
  }
};

function fail(message) {
  throw new Error(message);
}

function parseOutputArgument(values) {
  if (values.length !== 2 || values[0] !== "--output" || !values[1]?.startsWith("/")) {
    fail("usage: build-desktop-sealed-worker.mjs --output /absolute/path");
  }
  return resolve(values[1]);
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function packageVersion(repoRoot) {
  const packageJson = JSON.parse(
    readFileSync(join(repoRoot, "package.json"), "utf8")
  );
  if (
    typeof packageJson.version !== "string"
    || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(
      packageJson.version
    )
  ) {
    fail("package.json has an invalid version");
  }
  return packageJson.version;
}

function main() {
  if (process.platform !== "darwin") {
    fail("the sealed desktop worker can be built only on macOS");
  }
  const archive = NODE_ARCHIVES[process.arch];
  if (!archive) {
    fail(`unsupported sealed worker architecture: ${process.arch}`);
  }
  const output = parseOutputArgument(process.argv.slice(2));
  if (existsSync(output)) {
    fail("sealed worker output must not already exist");
  }

  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const sealedPackageVersion = packageVersion(repoRoot);
  const staging = mkdtempSync(join(tmpdir(), "neondiff-sealed-worker-"));
  const cacheDirectory = join(
    homedir(),
    "Library",
    "Caches",
    "NeonDiff",
    "node-runtime"
  );
  const archivePath = process.env.NEONDIFF_NODE_RUNTIME_ARCHIVE
    ? resolve(process.env.NEONDIFF_NODE_RUNTIME_ARCHIVE)
    : join(cacheDirectory, archive.filename);
  try {
    mkdirSync(cacheDirectory, { recursive: true, mode: 0o700 });
    if (!existsSync(archivePath)) {
      execFileSync("/usr/bin/curl", [
        "--fail",
        "--location",
        "--silent",
        "--show-error",
        "--output",
        archivePath,
        `https://nodejs.org/dist/v${NODE_VERSION}/${archive.filename}`
      ], { stdio: ["ignore", "ignore", "pipe"] });
    }
    if (sha256(archivePath) !== archive.sha256) {
      fail("the pinned Node runtime archive failed SHA-256 verification");
    }

    const bundlePath = join(staging, "neondiff-worker.mjs");
    execFileSync(process.execPath, ["--version"], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    build({
      entryPoints: [join(repoRoot, "src", "cli.ts")],
      outfile: bundlePath,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node26",
      define: {
        "import.meta.neondiffPackageVersion":
          JSON.stringify(sealedPackageVersion)
      },
      sourcemap: false,
      logLevel: "silent"
    });

    execFileSync("/usr/bin/tar", [
      "-xzf",
      archivePath,
      "-C",
      staging
    ], { stdio: ["ignore", "ignore", "pipe"] });
    const extractedRoot = join(
      staging,
      archive.filename.replace(/\.tar\.gz$/, "")
    );
    const nodePath = realpathSync(join(extractedRoot, "bin", "node"));
    const seaConfigPath = join(staging, "sea-config.json");
    writeFileSync(
      seaConfigPath,
      `${JSON.stringify({
        main: bundlePath,
        mainFormat: "module",
        output,
        disableExperimentalSEAWarning: true
      }, null, 2)}\n`,
      { mode: 0o600 }
    );
    mkdirSync(dirname(output), { recursive: true, mode: 0o755 });
    execFileSync(nodePath, ["--build-sea", seaConfigPath], {
      cwd: staging,
      stdio: ["ignore", "pipe", "pipe"]
    });
    chmodSync(output, 0o755);
    execFileSync("/usr/bin/codesign", [
      "--force",
      "--options",
      "runtime",
      "--entitlements",
      join(
        repoRoot,
        "apps",
        "neondiff-desktop",
        "script",
        "worker-runtime.entitlements.plist"
      ),
      "--sign",
      "-",
      output
    ], { stdio: ["ignore", "ignore", "pipe"] });
    const portabilityDirectory = join(staging, "portability-cwd");
    mkdirSync(portabilityDirectory, { mode: 0o700 });
    const reportedVersion = execFileSync(output, ["--version"], {
      cwd: portabilityDirectory,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    }).trim();
    if (reportedVersion !== sealedPackageVersion) {
      fail(`sealed worker reports unexpected version ${reportedVersion}`);
    }
    const dependencies = execFileSync("/usr/bin/otool", ["-L", output], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    }).split("\n").slice(1).map((line) => line.trim()).filter(Boolean);
    if (dependencies.some(
      (line) => !line.startsWith("/System/Library/")
        && !line.startsWith("/usr/lib/")
    )) {
      fail("sealed worker has a non-system dynamic library dependency");
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

main();
