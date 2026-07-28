#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmdirSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  planWorkerRollback,
  planWorkerUpdate,
  validateWorkerCandidate
} from "./lib/b0-worker-installer.mjs";

const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_TARBALL_BYTES = 100 * 1024 * 1024;
const MAX_PLIST_BYTES = 1024 * 1024;
const STATE_FILENAME = "state.json";
const LOCK_DIRECTORY = ".install-lock";

function fail(message) {
  throw new Error(message);
}

function usage() {
  console.log(`Install or roll back one checksum-bound NeonDiff B0 worker.

Usage:
  node install-b0-worker-candidate.mjs update \\
    --manifest /absolute/path/manifest.json \\
    --manifest-sha256 <64-lowercase-hex> \\
    --tarball /absolute/path/neondiff-1.1.0-beta.N.tgz \\
    --launchd-label <label> [--dry-run true]

  node install-b0-worker-candidate.mjs update ... --dry-run false --confirm true
  node install-b0-worker-candidate.mjs rollback --launchd-label <label> [--dry-run true]
  node install-b0-worker-candidate.mjs rollback --launchd-label <label> --dry-run false --confirm true

The installer uses a user-owned versioned prefix, preserves the existing
config and LaunchAgent environment, and never reads or copies private-key bytes.
Dry-run is the default. Live mutation requires --dry-run false --confirm true.`);
}

function parseArgs(values) {
  const args = new Map();
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      fail(`invalid argument list near ${key ?? "(missing)"}`);
    }
    const name = key.slice(2);
    if (args.has(name)) fail(`duplicate --${name}`);
    args.set(name, value);
  }
  return args;
}

function required(args, name) {
  const value = args.get(name);
  if (!value) fail(`--${name} is required`);
  return value;
}

function parseBoolean(args, name, fallback) {
  const value = args.get(name);
  if (value === undefined) return fallback;
  if (value !== "true" && value !== "false") fail(`--${name} must be true or false`);
  return value === "true";
}

function requireLiveConfirmation(args) {
  const dryRun = parseBoolean(args, "dry-run", true);
  const confirm = parseBoolean(args, "confirm", false);
  if (!dryRun && !confirm) fail("live worker mutation requires --dry-run false --confirm true");
  return dryRun;
}

function requireAbsoluteRegularFile(path, maximumSize, label, requireOwner = true) {
  if (!isAbsolute(path)) fail(`${label} path must be absolute`);
  if (!existsSync(path)) fail(`${label} file is missing`);
  const entry = lstatSync(path);
  if (entry.isSymbolicLink() || !entry.isFile()) fail(`${label} must be a regular non-symlink file`);
  if (entry.size <= 0 || entry.size > maximumSize) fail(`${label} size is invalid`);
  if (requireOwner && typeof process.getuid === "function" && entry.uid !== process.getuid()) {
    fail(`${label} must be owned by the current user`);
  }
  return resolve(path);
}

function ensurePrivateDirectory(path) {
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o700 });
  const entry = lstatSync(path);
  if (entry.isSymbolicLink() || !entry.isDirectory()) fail("worker directory must be a real directory");
  if (typeof process.getuid === "function" && entry.uid !== process.getuid()) {
    fail("worker directory must be owned by the current user");
  }
  if ((entry.mode & 0o077) !== 0) fail("worker directory must be private to the current user (0700)");
  return realpathSync(path);
}

function pathIsInside(root, candidate) {
  const rel = relative(root, candidate);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function standardPaths(label) {
  const home = homedir();
  const workerRoot = join(home, "Library", "Application Support", "NeonDiffDesktop", "Workers");
  return {
    workerRoot,
    versionsRoot: join(workerRoot, "versions"),
    currentLink: join(workerRoot, "current"),
    statePath: join(workerRoot, STATE_FILENAME),
    lockPath: join(workerRoot, LOCK_DIRECTORY),
    plistPath: join(home, "Library", "LaunchAgents", `${label}.plist`)
  };
}

function parsePlist(path) {
  const output = execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", path], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  try {
    return JSON.parse(output);
  } catch {
    fail("LaunchAgent plist could not be parsed");
  }
}

function writePlistFromTemplate(templatePath, destinationPath, launchAgent) {
  copyFileSync(templatePath, destinationPath);
  chmodSync(destinationPath, 0o600);
  execFileSync("/usr/bin/plutil", [
    "-replace", "ProgramArguments", "-json", JSON.stringify(launchAgent.ProgramArguments), destinationPath
  ], { stdio: ["ignore", "pipe", "pipe"] });
  execFileSync("/usr/bin/plutil", [
    "-replace", "WorkingDirectory", "-string", launchAgent.WorkingDirectory, destinationPath
  ], { stdio: ["ignore", "pipe", "pipe"] });
  const readback = parsePlist(destinationPath);
  if (
    readback.Label !== launchAgent.Label
    || JSON.stringify(readback.ProgramArguments) !== JSON.stringify(launchAgent.ProgramArguments)
    || readback.WorkingDirectory !== launchAgent.WorkingDirectory
    || JSON.stringify(readback.EnvironmentVariables) !== JSON.stringify(launchAgent.EnvironmentVariables)
  ) {
    fail("LaunchAgent staged readback mismatch");
  }
}

function readState(path) {
  if (!existsSync(path)) return null;
  requireAbsoluteRegularFile(path, MAX_MANIFEST_BYTES, "worker state");
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    fail("worker state is invalid JSON");
  }
}

function writeState(path, state) {
  const temporary = `${path}.next-${process.pid}-${randomUUID()}`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

function safeUnlink(path) {
  if (!existsSync(path)) return;
  const entry = lstatSync(path);
  if (!entry.isFile() && !entry.isSymbolicLink()) fail("refusing to unlink a non-file recovery path");
  unlinkSync(path);
}

function resolveNpmPath() {
  const candidates = [
    join(dirname(process.execPath), "npm"),
    "/opt/homebrew/bin/npm",
    "/usr/local/bin/npm"
  ];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const resolved = realpathSync(candidate);
    if (statSync(resolved).isFile()) return resolved;
  }
  fail("npm was not found beside Node or in an approved install location");
}

function verifyInstalledWorker(versionRoot, expectedVersion) {
  const cliPath = join(versionRoot, "node_modules", "neondiff", "dist", "src", "cli.js");
  requireAbsoluteRegularFile(cliPath, 50 * 1024 * 1024, "installed worker CLI", false);
  const version = execFileSync(process.execPath, [cliPath, "--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
  if (version !== expectedVersion) fail("installed worker version mismatch");
  const help = JSON.parse(execFileSync(process.execPath, [cliPath, "review-pr", "--help"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }));
  const flags = new Set(help?.usage?.flags?.map((entry) => entry?.name));
  if (
    help?.ok !== true
    || help?.command !== "review-pr"
    || !flags.has("--expected-config-revision")
    || !flags.has("--zcode")
  ) {
    fail("installed worker review capability mismatch");
  }
}

function installVersion({ versionsRoot, versionID, tarballPath, manifestBytes, manifestSHA256, packageVersion }) {
  const versionRoot = join(versionsRoot, versionID);
  if (!pathIsInside(versionsRoot, versionRoot)) fail("worker version path escaped the version root");
  if (existsSync(versionRoot)) {
    const embeddedManifest = join(versionRoot, ".neondiff-candidate-manifest.json");
    requireAbsoluteRegularFile(embeddedManifest, MAX_MANIFEST_BYTES, "installed candidate manifest");
    const embeddedBytes = readFileSync(embeddedManifest);
    if (Buffer.compare(embeddedBytes, manifestBytes) !== 0) fail("installed candidate manifest mismatch");
    verifyInstalledWorker(versionRoot, packageVersion);
    return versionRoot;
  }

  const staging = join(versionsRoot, `.staging-${process.pid}-${randomUUID()}`);
  mkdirSync(staging, { mode: 0o700 });
  const npmPath = resolveNpmPath();
  try {
    execFileSync(npmPath, [
      "install", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", staging, tarballPath
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    verifyInstalledWorker(staging, packageVersion);
    writeFileSync(join(staging, ".neondiff-candidate-manifest.json"), manifestBytes, { mode: 0o600 });
    writeFileSync(join(staging, ".neondiff-candidate-manifest.sha256"), `${manifestSHA256}\n`, { mode: 0o600 });
    renameSync(staging, versionRoot);
  } catch (error) {
    fail(`worker package installation failed before activation: ${error instanceof Error ? error.message : String(error)}`);
  }
  return versionRoot;
}

function currentTarget(currentLink, versionsRoot) {
  if (!existsSync(currentLink)) return null;
  const entry = lstatSync(currentLink);
  if (!entry.isSymbolicLink()) fail("worker current pointer must be a symbolic link");
  const target = readlinkSync(currentLink);
  if (isAbsolute(target) || !target.startsWith(`versions${sep}`)) {
    fail("worker current pointer escaped the version root");
  }
  const resolved = resolve(dirname(currentLink), target);
  if (!pathIsInside(versionsRoot, resolved)) fail("worker current pointer escaped the version root");
  return target;
}

function switchCurrent(currentLink, relativeTarget) {
  const temporary = `${currentLink}.next-${process.pid}-${randomUUID()}`;
  symlinkSync(relativeTarget, temporary);
  renameSync(temporary, currentLink);
}

function launchdState(label) {
  const domain = `gui/${process.getuid()}`;
  const target = `${domain}/${label}`;
  const result = spawnSync("/bin/launchctl", ["print", target], { encoding: "utf8" });
  if (result.status === 0) return { loaded: true, domain, target };
  const detail = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (/could not find service|service not found/i.test(detail)) {
    return { loaded: false, domain, target };
  }
  fail("launchd service state is ambiguous");
}

function stopIfLoaded(state) {
  if (!state.loaded) return;
  execFileSync("/bin/launchctl", ["bootout", state.target], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function startIfPreviouslyLoaded(state, plistPath) {
  if (!state.loaded) return;
  execFileSync("/bin/launchctl", ["bootstrap", state.domain, plistPath], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  execFileSync("/bin/launchctl", ["kickstart", "-k", state.target], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function mutateLaunchAgent({ plistPath, nextLaunchAgent, currentLink, nextTarget, nextState, statePath }) {
  const originalBytes = readFileSync(plistPath);
  const oldCurrentTarget = currentTarget(currentLink, join(dirname(currentLink), "versions"));
  const priorState = readState(statePath);
  const stagedPlist = `${plistPath}.next-${process.pid}-${randomUUID()}`;
  writePlistFromTemplate(plistPath, stagedPlist, nextLaunchAgent);
  const service = launchdState(nextLaunchAgent.Label);
  writeState(statePath, nextState);
  let plistReplaced = false;
  try {
    stopIfLoaded(service);
    renameSync(stagedPlist, plistPath);
    plistReplaced = true;
    if (nextTarget) switchCurrent(currentLink, nextTarget);
    startIfPreviouslyLoaded(service, plistPath);
  } catch (error) {
    if (plistReplaced) {
      const restorePlist = `${plistPath}.restore-${process.pid}-${randomUUID()}`;
      writeFileSync(restorePlist, originalBytes, { mode: 0o600 });
      renameSync(restorePlist, plistPath);
    } else {
      safeUnlink(stagedPlist);
    }
    if (oldCurrentTarget) {
      switchCurrent(currentLink, oldCurrentTarget);
    } else if (existsSync(currentLink) && lstatSync(currentLink).isSymbolicLink()) {
      unlinkSync(currentLink);
    }
    if (priorState) writeState(statePath, priorState);
    else safeUnlink(statePath);
    try {
      startIfPreviouslyLoaded(service, plistPath);
    } catch {
      // The original plist/current pointer were restored; surface the primary failure.
    }
    fail(`worker activation failed and the prior worker was restored: ${error instanceof Error ? error.message : String(error)}`);
  }
  return service.loaded;
}

function withWorkerLock(paths, operation) {
  ensurePrivateDirectory(paths.workerRoot);
  ensurePrivateDirectory(paths.versionsRoot);
  try {
    mkdirSync(paths.lockPath, { mode: 0o700 });
  } catch {
    fail("another NeonDiff worker install or rollback is active");
  }
  try {
    return operation();
  } finally {
    rmdirSync(paths.lockPath);
  }
}

function update(args) {
  const dryRun = requireLiveConfirmation(args);
  const manifestPath = requireAbsoluteRegularFile(
    required(args, "manifest"),
    MAX_MANIFEST_BYTES,
    "candidate manifest"
  );
  const tarballPath = requireAbsoluteRegularFile(
    required(args, "tarball"),
    MAX_TARBALL_BYTES,
    "candidate tarball"
  );
  const manifestSHA256 = required(args, "manifest-sha256");
  const label = required(args, "launchd-label");
  const paths = standardPaths(label);
  const plistPath = requireAbsoluteRegularFile(paths.plistPath, MAX_PLIST_BYTES, "LaunchAgent plist");
  const manifestBytes = readFileSync(manifestPath);
  const tarballBytes = readFileSync(tarballPath);
  const candidate = validateWorkerCandidate({
    manifestBytes,
    manifestSHA256,
    tarballBytes,
    tarballFilename: basename(tarballPath)
  });
  const launchAgent = parsePlist(plistPath);
  const priorState = readState(paths.statePath);
  const plan = planWorkerUpdate({
    launchAgent,
    expectedLabel: label,
    workerRoot: paths.workerRoot,
    nodePath: process.execPath,
    candidateHead: candidate.candidateHead,
    packageVersion: candidate.packageVersion,
    manifestSHA256,
    previousState: priorState
  });
  if (dryRun) {
    console.log(JSON.stringify({ ok: true, dryRun: true, ...plan.publicSummary }));
    return;
  }
  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  if (!Number.isInteger(nodeMajor) || nodeMajor < 26) fail("worker installation requires Node.js 26 or newer");
  const result = withWorkerLock(paths, () => {
    installVersion({
      versionsRoot: paths.versionsRoot,
      versionID: plan.versionID,
      tarballPath,
      manifestBytes,
      manifestSHA256,
      packageVersion: candidate.packageVersion
    });
    const relativeTarget = join("versions", plan.versionID);
    const restarted = mutateLaunchAgent({
      plistPath,
      nextLaunchAgent: plan.nextLaunchAgent,
      currentLink: paths.currentLink,
      nextTarget: relativeTarget,
      nextState: plan.nextState,
      statePath: paths.statePath
    });
    return { restarted };
  });
  console.log(JSON.stringify({ ok: true, dryRun: false, ...plan.publicSummary, ...result }));
}

function rollback(args) {
  const dryRun = requireLiveConfirmation(args);
  const label = required(args, "launchd-label");
  const paths = standardPaths(label);
  const plistPath = requireAbsoluteRegularFile(paths.plistPath, MAX_PLIST_BYTES, "LaunchAgent plist");
  const state = readState(paths.statePath);
  if (!state) fail("no NeonDiff worker rollback state exists");
  const launchAgent = parsePlist(plistPath);
  const plan = planWorkerRollback({ state, currentLaunchAgent: launchAgent, expectedLabel: label });
  if (dryRun) {
    console.log(JSON.stringify({ ok: true, dryRun: true, ...plan.publicSummary }));
    return;
  }
  const result = withWorkerLock(paths, () => {
    let target = null;
    if (plan.nextState.currentVersionID) {
      const versionRoot = join(paths.versionsRoot, plan.nextState.currentVersionID);
      if (!existsSync(versionRoot) || !pathIsInside(paths.versionsRoot, realpathSync(versionRoot))) {
        fail("rollback worker version is missing or outside the version root");
      }
      verifyInstalledWorker(versionRoot, plan.nextState.packageVersion);
      target = join("versions", plan.nextState.currentVersionID);
    }
    const restarted = mutateLaunchAgent({
      plistPath,
      nextLaunchAgent: plan.nextLaunchAgent,
      currentLink: paths.currentLink,
      nextTarget: target,
      nextState: plan.nextState,
      statePath: paths.statePath
    });
    return { restarted };
  });
  console.log(JSON.stringify({ ok: true, dryRun: false, ...plan.publicSummary, ...result }));
}

function main() {
  const [action, ...values] = process.argv.slice(2);
  if (!action || action === "--help" || action === "-h") {
    usage();
    return;
  }
  const args = parseArgs(values);
  if (action === "update") update(args);
  else if (action === "rollback") rollback(args);
  else fail("action must be update or rollback");
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
