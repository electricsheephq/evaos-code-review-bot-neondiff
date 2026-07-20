#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const CLEAN_STATUS_COMMAND = "git status --porcelain";
const CANDIDATE_VERSION_PATTERN = /^1\.1\.0-beta\.[1-9][0-9]{0,3}$/;
const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/;
const PRIVATE_BUCKET_TARGET = "neondiff-beta-canary";

function fail(message) {
  throw new Error(message);
}

function parseArgs(values) {
  const args = new Map();
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      fail(`invalid argument list near ${key ?? "(missing)"}`);
    }
    args.set(key.slice(2), value);
  }
  return args;
}

function required(args, name) {
  const value = args.get(name);
  if (!value) fail(`--${name} is required`);
  return value;
}

function git(repoRoot, args) {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

function sha256(path) {
  const hash = createHash("sha256");
  hash.update(readFileSync(path));
  return hash.digest("hex");
}

function parseHelp(binaryPath, command) {
  const output = execFileSync(binaryPath, [command, "--help"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  const parsed = JSON.parse(output);
  if (parsed?.ok !== true || parsed?.command !== command || !Array.isArray(parsed?.usage?.flags)) {
    fail(`installed ${command} help is not the expected structured contract`);
  }
  return parsed;
}

function requireFlags(help, expected, label) {
  const flags = new Set(help.usage.flags.map((entry) => entry?.name).filter(Boolean));
  for (const flag of expected) {
    if (!flags.has(flag)) fail(`installed candidate is missing ${label} flag ${flag}`);
  }
  return expected;
}

function assertOutputDirectory(repoRoot, requestedOutputDirectory) {
  if (!isAbsolute(requestedOutputDirectory)) {
    fail("output directory must be absolute");
  }
  const outputDirectory = resolve(requestedOutputDirectory);
  const relativeToRepo = relative(repoRoot, outputDirectory);
  if (relativeToRepo === "" || (!relativeToRepo.startsWith(`..${sep}`) && relativeToRepo !== "..")) {
    fail("output directory must be outside the repository");
  }
  if (existsSync(outputDirectory)) {
    if (!statSync(outputDirectory).isDirectory()) fail("output path must be a directory");
    if (readdirSync(outputDirectory).length > 0) fail("output directory must be empty");
  } else {
    mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
  }
  return outputDirectory;
}

function ensureClean(repoRoot, stage) {
  const status = git(repoRoot, ["status", "--porcelain", "--untracked-files=all"]);
  if (status) fail(`${stage}: source tree must be clean (${CLEAN_STATUS_COMMAND})`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const candidateHead = required(args, "candidate-head");
  const packageVersion = required(args, "package-version");
  const requestedOutputDirectory = required(args, "output-dir");

  if (!FULL_SHA_PATTERN.test(candidateHead)) {
    fail("candidate head must be one lowercase full Git SHA");
  }
  if (!CANDIDATE_VERSION_PATTERN.test(packageVersion)) {
    fail("package version must match 1.1.0-beta.N");
  }

  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const nodeMajorVersion = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  if (!Number.isInteger(nodeMajorVersion) || nodeMajorVersion < 26) {
    fail("B0 candidate packaging requires Node.js 26 or newer");
  }
  const exactHead = git(repoRoot, ["rev-parse", "HEAD"]);
  if (exactHead !== candidateHead) {
    fail(`candidate head mismatch: checkout is ${exactHead}`);
  }
  const protectedMainHead = git(repoRoot, ["rev-parse", "refs/remotes/origin/main"]);
  if (protectedMainHead !== candidateHead) {
    fail(`candidate head is not the fetched protected-main head ${protectedMainHead}`);
  }
  ensureClean(repoRoot, "preflight");

  const outputDirectory = assertOutputDirectory(repoRoot, requestedOutputDirectory);
  const packagePath = join(repoRoot, "package.json");
  const packageLockPath = join(repoRoot, "package-lock.json");
  const originalPackage = readFileSync(packagePath);
  const originalPackageLock = readFileSync(packageLockPath);
  const packageMetadata = JSON.parse(originalPackage.toString("utf8"));
  const basePackageVersion = packageMetadata.version;
  if (packageMetadata.name !== "neondiff" || basePackageVersion !== "1.0.4") {
    fail("B0 candidate packaging requires the reviewed neondiff@1.0.4 source baseline");
  }
  if (!existsSync(join(repoRoot, "dist", "src", "cli.js"))) {
    fail("built dist/src/cli.js is required; run npm run build first");
  }

  const installRoot = mkdtempSync(join(tmpdir(), "neondiff-b0-cli-install-"));
  let manifest;
  let tarballPath;
  let packJsonPath;
  try {
    execFileSync("npm", [
      "version",
      packageVersion,
      "--no-git-tag-version",
      "--allow-same-version"
    ], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });

    const packOutput = execFileSync("npm", [
      "pack",
      "--json",
      "--pack-destination",
      outputDirectory
    ], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
    const parsedPack = JSON.parse(packOutput);
    const pack = parsedPack[0];
    if (!pack || parsedPack.length !== 1 || pack.name !== "neondiff" || pack.version !== packageVersion) {
      fail("npm pack did not emit the exact requested neondiff candidate");
    }

    packJsonPath = join(outputDirectory, "pack.json");
    writeFileSync(packJsonPath, `${JSON.stringify(parsedPack, null, 2)}\n`, { mode: 0o600 });
    execFileSync(process.execPath, [join(repoRoot, "scripts", "check-packlist.mjs"), packJsonPath], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });

    tarballPath = join(outputDirectory, pack.filename);
    if (!existsSync(tarballPath) || !statSync(tarballPath).isFile()) {
      fail("npm pack tarball is missing");
    }

    execFileSync("npm", [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--prefix",
      installRoot,
      tarballPath
    ], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });

    const installedBinary = join(installRoot, "node_modules", ".bin", "neondiff");
    const reportedVersion = execFileSync(installedBinary, ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    }).trim();
    if (reportedVersion !== packageVersion) {
      fail(`installed candidate reports unexpected version ${reportedVersion}`);
    }

    const activationFlags = requireFlags(
      parseHelp(installedBinary, "license"),
      ["--license-key-stdin", "--persist-local-state", "--license-machine-id"],
      "native activation"
    );
    const githubDoctorFlags = requireFlags(
      parseHelp(installedBinary, "doctor"),
      ["--github-app-id", "--github-app-private-key-stdin"],
      "BYO GitHub verification"
    );

    manifest = {
      schemaVersion: 1,
      candidateClass: "b0-access-controlled-cli",
      source: {
        repository: "electricsheephq/evaos-code-review-bot-neondiff",
        candidateHead,
        protectedMainVerified: true,
        sourceTreeCleanBeforePackaging: true,
        packageMetadataMutation: "version-only-ephemeral-restored"
      },
      package: {
        name: "neondiff",
        basePackageVersion,
        packageVersion,
        filename: pack.filename,
        sha256: sha256(tarballPath),
        shasum: pack.shasum,
        integrity: pack.integrity,
        fileCount: Array.isArray(pack.files) ? pack.files.length : null,
        unpackedSize: pack.unpackedSize ?? null
      },
      installedCompatibility: {
        nodeVersion: process.versions.node,
        nodeEngine: packageMetadata.engines?.node ?? null,
        reportedVersion,
        activationFlags,
        githubDoctorFlags,
        isolatedInstallPassed: true
      },
      distribution: {
        privateBucketTarget: PRIVATE_BUCKET_TARGET,
        objectPrefix: `b0/${packageVersion}/${candidateHead}`,
        uploaded: false,
        authenticatedReadbackPassed: false,
        publicNpmPublished: false,
        tagCreated: false,
        githubReleaseCreated: false,
        publicDownloadEnabled: false
      },
      proofBoundary: {
        allows: [
          "exact clean protected-main source was packed with version-only ephemeral metadata",
          "isolated installed CLI exposes the B0 native activation and BYO GitHub verification flags"
        ],
        excludes: [
          "private bucket upload or authenticated readback",
          "public npm publication or dist-tag mutation",
          "Git tag or GitHub Release",
          "signed or notarized Mac artifact",
          "billing, activation, dry-run, live review, canary, beta, release, or customer readiness"
        ]
      }
    };
  } finally {
    writeFileSync(packagePath, originalPackage);
    writeFileSync(packageLockPath, originalPackageLock);
    rmSync(installRoot, { recursive: true, force: true });
  }

  ensureClean(repoRoot, "post-package restoration");
  if (!manifest || !tarballPath || !packJsonPath) fail("candidate packaging did not complete");

  const manifestPath = join(
    outputDirectory,
    `neondiff-${packageVersion}-b0-candidate-manifest.json`
  );
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({
    ok: true,
    candidateHead,
    packageVersion,
    tarballPath,
    packJsonPath,
    manifestPath,
    sha256: manifest.package.sha256,
    privateBucketTarget: PRIVATE_BUCKET_TARGET,
    uploaded: false
  }));
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
