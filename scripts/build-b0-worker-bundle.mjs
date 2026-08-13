#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { validateWorkerCandidate } from "./lib/b0-worker-installer.mjs";

function fail(message) {
  throw new Error(message);
}

function parseArgs(values) {
  const args = new Map();
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith("--") || value === undefined) fail("invalid argument list");
    args.set(key.slice(2), value);
  }
  return args;
}

function required(args, name) {
  const value = args.get(name);
  if (!value) fail(`--${name} is required`);
  return value;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function git(repoRoot, args) {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

function assertExactCandidateCheckout(repoRoot, candidateHead) {
  if (git(repoRoot, ["rev-parse", "HEAD"]) !== candidateHead) {
    fail("bundle checkout does not match the candidate head");
  }
  if (git(repoRoot, ["rev-parse", "refs/remotes/origin/main"]) !== candidateHead) {
    fail("bundle candidate is not the fetched protected-main head");
  }
  if (git(repoRoot, ["status", "--porcelain", "--untracked-files=all"])) {
    fail("bundle checkout must be clean");
  }
}

function requireRegularFile(path, maximumSize, label) {
  if (!isAbsolute(path) || !existsSync(path)) fail(`${label} must be an existing absolute path`);
  const entry = lstatSync(path);
  if (entry.isSymbolicLink() || !entry.isFile() || entry.size <= 0 || entry.size > maximumSize) {
    fail(`${label} must be a bounded regular non-symlink file`);
  }
  return resolve(path);
}

function assertOutputDirectory(repoRoot, requested) {
  if (!isAbsolute(requested)) fail("output directory must be absolute");
  const output = resolve(requested);
  if (existsSync(output)) {
    const entry = lstatSync(output);
    if (entry.isSymbolicLink() || !entry.isDirectory()) fail("output path must be a real directory");
    if (readdirSync(output).length > 0) fail("output directory must be empty");
  } else {
    mkdirSync(output, { recursive: true, mode: 0o700 });
  }
  const realOutput = realpathSync(output);
  const realRepo = realpathSync(repoRoot);
  const rel = relative(realRepo, realOutput);
  if (rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`))) {
    fail("output directory must resolve outside the repository");
  }
  if ((statSync(realOutput).mode & 0o077) !== 0) fail("output directory must be private (0700)");
  return realOutput;
}

function installGuide(candidate, manifestFilename, tarballFilename, manifestSHA256) {
  return `# Install the NeonDiff ${candidate.packageVersion} B0 worker

This outer bundle ZIP is for the public paid BYO Mac beta. It is distributed
only through the immutable GitHub prerelease named in the release manifest; it
is not a public npm package or an automatic update.

Before extracting the outer ZIP, compare its SHA-256 with the prerelease notes.
Then compare this release manifest SHA-256 with the prerelease notes:

\`${manifestSHA256}\`

The installer verifies the inner \`.tgz\` tarball
\`${tarballFilename}\` against the release manifest before mutation. Compare
that tarball SHA-256 with the prerelease notes as well.

On a clean Mac with no NeonDiff LaunchAgent or worker state, preview the
credential-free CLI install:

\`\`\`sh
BUNDLE_DIR="$(pwd -P)"
node install-b0-worker-candidate.mjs first-install \\
  --manifest "$BUNDLE_DIR/${manifestFilename}" \\
  --manifest-sha256 ${manifestSHA256} \\
  --tarball "$BUNDLE_DIR/${tarballFilename}" \\
  --launchd-label com.electricsheephq.evaos-code-review-bot \\
  --dry-run true
\`\`\`

After the preview reports the expected label/version, repeat it with
\`--dry-run false --confirm true\`. First install writes only the verified
versioned CLI and its private installation marker. It creates or loads no
LaunchAgent, starts no daemon, and reads no credentials. Return to NeonDiff and
continue with **Initialize Local Config**; review and daemon readiness remain
separate gates.

For an existing LaunchAgent, preview the exact migration instead:

\`\`\`sh
BUNDLE_DIR="$(pwd -P)"
node install-b0-worker-candidate.mjs update \\
  --manifest "$BUNDLE_DIR/${manifestFilename}" \\
  --manifest-sha256 ${manifestSHA256} \\
  --tarball "$BUNDLE_DIR/${tarballFilename}" \\
  --launchd-label YOUR_NEONDIFF_LAUNCHD_LABEL \\
  --dry-run true
\`\`\`

Node.js 26 or newer is required for preview, install, and rollback. After the
preview reports the expected label/version, run the same command with
\`--dry-run false --confirm true\`. Return to NeonDiff and choose **Retry
Worker Check**. The existing config, GitHub App environment, provider state,
repository allowlist, and private-key file are preserved; private-key bytes are
never read by the installer.

The first checksum-managed migration has no trusted prior candidate and cannot
roll back to the unbound original invocation. After a later candidate update,
retain the prior candidate's complete verified bundle. Preview rollback from
that prior bundle:

\`\`\`sh
BUNDLE_DIR="$(pwd -P)"
node install-b0-worker-candidate.mjs rollback \\
  --manifest "$BUNDLE_DIR/${manifestFilename}" \\
  --manifest-sha256 ${manifestSHA256} \\
  --tarball "$BUNDLE_DIR/${tarballFilename}" \\
  --launchd-label YOUR_NEONDIFF_LAUNCHD_LABEL \\
  --dry-run true
\`\`\`

The placeholders above must name the prior candidate, not the currently active
candidate. Rollback mutation also requires
\`--dry-run false --confirm true\`.

Candidate source: \`${candidate.candidateHead}\`

Package: \`neondiff@${candidate.packageVersion}\`

Tarball SHA-256: \`${candidate.tarballSHA256}\`
`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const manifestPath = requireRegularFile(required(args, "manifest"), 1024 * 1024, "manifest");
  const tarballPath = requireRegularFile(required(args, "tarball"), 100 * 1024 * 1024, "tarball");
  const outputDirectory = assertOutputDirectory(repoRoot, required(args, "output-dir"));
  const manifestBytes = readFileSync(manifestPath);
  const tarballBytes = readFileSync(tarballPath);
  const manifestSHA256 = sha256(manifestBytes);
  const candidate = validateWorkerCandidate({
    manifestBytes,
    manifestSHA256,
    tarballBytes,
    tarballFilename: basename(tarballPath)
  });
  assertExactCandidateCheckout(repoRoot, candidate.candidateHead);

  const bundleName = `neondiff-worker-${candidate.packageVersion}-${candidate.candidateHead.slice(0, 12)}`;
  const temporaryRoot = mkdtempSync(join(tmpdir(), "neondiff-b0-worker-bundle-"));
  const bundleRoot = join(temporaryRoot, bundleName);
  const zipPath = join(outputDirectory, `${bundleName}.zip`);
  const receiptPath = join(outputDirectory, `${bundleName}-receipt.json`);
  const installerSource = join(repoRoot, "scripts", "install-b0-worker-candidate.mjs");
  const librarySource = join(repoRoot, "scripts", "lib", "b0-worker-installer.mjs");
  try {
    mkdirSync(join(bundleRoot, "lib"), { recursive: true, mode: 0o700 });
    const bundledManifest = join(bundleRoot, basename(manifestPath));
    const bundledTarball = join(bundleRoot, basename(tarballPath));
    const bundledInstaller = join(bundleRoot, "install-b0-worker-candidate.mjs");
    const bundledLibrary = join(bundleRoot, "lib", "b0-worker-installer.mjs");
    copyFileSync(manifestPath, bundledManifest);
    copyFileSync(tarballPath, bundledTarball);
    copyFileSync(installerSource, bundledInstaller);
    copyFileSync(librarySource, bundledLibrary);
    chmodSync(bundledInstaller, 0o700);
    writeFileSync(
      join(bundleRoot, "INSTALL.md"),
      installGuide(candidate, basename(manifestPath), basename(tarballPath), manifestSHA256),
      { mode: 0o600 }
    );
    execFileSync("/usr/bin/ditto", [
      "-c", "-k", "--sequesterRsrc", "--keepParent", bundleRoot, zipPath
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const bundleSHA256 = sha256(readFileSync(zipPath));
    const receipt = {
      schemaVersion: 1,
      candidateHead: candidate.candidateHead,
      packageVersion: candidate.packageVersion,
      manifestSHA256,
      tarballSHA256: candidate.tarballSHA256,
      installerSHA256: sha256(readFileSync(bundledInstaller)),
      installerLibrarySHA256: sha256(readFileSync(bundledLibrary)),
      bundleFilename: basename(zipPath),
      bundleSHA256,
      privateBucketTarget: "neondiff-beta-canary",
      uploaded: false,
      authenticatedReadbackPassed: false,
      publicDownloadEnabled: false,
      includedFiles: [
        basename(manifestPath),
        basename(tarballPath),
        "install-b0-worker-candidate.mjs",
        "lib/b0-worker-installer.mjs",
        "INSTALL.md"
      ],
      proofBoundary: "Worker bundle assembly only; no upload, publication, install, rollback, review, beta, release, or customer-readiness claim."
    };
    writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
    console.log(JSON.stringify({
      ok: true,
      candidateHead: candidate.candidateHead,
      packageVersion: candidate.packageVersion,
      manifestSHA256,
      bundlePath: zipPath,
      bundleSHA256,
      receiptPath,
      uploaded: false
    }));
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
