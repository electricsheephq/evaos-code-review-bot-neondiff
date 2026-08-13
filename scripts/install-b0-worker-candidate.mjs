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
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  planWorkerFirstInstall,
  planWorkerRollback,
  planWorkerUpdate,
  recoverFailedFirstInstall,
  recoverPreviouslyLoadedWorker,
  removeReplaceableWorkerVersion,
  requireFirstInstallLaunchdUnloaded,
  requireRollbackCandidate,
  retryTransientLaunchdBootstrap,
  selectStableNodeLaunchPath,
  selectWorkerVersionAction,
  validateWorkerCandidate
} from "./lib/b0-worker-installer.mjs";

const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_TARBALL_BYTES = 100 * 1024 * 1024;
const MAX_PLIST_BYTES = 1024 * 1024;
const STATE_FILENAME = "state.json";
const INSTALLATION_FILENAME = "installation.json";
const LOCK_DIRECTORY = ".install-lock";
const LOCK_OWNER_FILENAME = "owner.json";
const LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CHILD_PROCESS_OPTIONS = Object.freeze({
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
  timeout: 120_000,
  killSignal: "SIGKILL",
  maxBuffer: 10 * 1024 * 1024
});

function fail(message) {
  throw new Error(message);
}

function usage() {
  console.log(`Install or roll back one checksum-bound NeonDiff B0 worker.

Usage:
  node install-b0-worker-candidate.mjs first-install \\
    --manifest /absolute/path/manifest.json \\
    --manifest-sha256 <64-lowercase-hex> \\
    --tarball /absolute/path/neondiff-1.1.0-beta.N.tgz \\
    --launchd-label <label> [--dry-run true]

  node install-b0-worker-candidate.mjs update \\
    --manifest /absolute/path/manifest.json \\
    --manifest-sha256 <64-lowercase-hex> \\
    --tarball /absolute/path/neondiff-1.1.0-beta.N.tgz \\
    --launchd-label <label> [--dry-run true]

  node install-b0-worker-candidate.mjs first-install ... --dry-run false --confirm true
  node install-b0-worker-candidate.mjs update ... --dry-run false --confirm true
  node install-b0-worker-candidate.mjs rollback \\
    --manifest /absolute/path/prior-manifest.json \\
    --manifest-sha256 <64-lowercase-hex> \\
    --tarball /absolute/path/prior-neondiff.tgz \\
    --launchd-label <label> [--dry-run true]

  node install-b0-worker-candidate.mjs rollback ... --dry-run false --confirm true

First install creates only a credential-free CLI worker; it does not create or
load a LaunchAgent. Updates preserve the existing config and LaunchAgent
environment. The installer never reads or copies private-key bytes.
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

function requireSupportedRuntime() {
  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  if (!Number.isInteger(nodeMajor) || nodeMajor < 26) {
    fail("worker installation requires Node.js 26 or newer");
  }
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
  if (!LABEL_PATTERN.test(label)) fail("launchd label is invalid");
  const home = homedir();
  const workerRoot = join(
    home,
    "Library",
    "Application Support",
    "NeonDiffDesktop",
    "Workers",
    label
  );
  return {
    workerRoot,
    versionsRoot: join(workerRoot, "versions"),
    currentLink: join(workerRoot, "current"),
    statePath: join(workerRoot, STATE_FILENAME),
    installationPath: join(workerRoot, INSTALLATION_FILENAME),
    lockPath: join(workerRoot, LOCK_DIRECTORY),
    plistPath: join(home, "Library", "LaunchAgents", `${label}.plist`)
  };
}

function pathEntryExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return false;
    throw error;
  }
}

function assertFirstInstallTargetUnused(paths) {
  if (pathEntryExists(paths.plistPath)) {
    fail("first install refuses an existing LaunchAgent; use update instead");
  }
  if (
    pathEntryExists(paths.currentLink)
    || pathEntryExists(paths.statePath)
    || pathEntryExists(paths.installationPath)
  ) {
    fail("first install refuses existing or ambiguous worker state");
  }
}

function parsePlist(path) {
  const output = execFileSync(
    "/usr/bin/plutil",
    ["-convert", "json", "-o", "-", path],
    CHILD_PROCESS_OPTIONS
  );
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
  ], CHILD_PROCESS_OPTIONS);
  execFileSync("/usr/bin/plutil", [
    "-replace", "WorkingDirectory", "-string", launchAgent.WorkingDirectory, destinationPath
  ], CHILD_PROCESS_OPTIONS);
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
  try {
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  } catch (error) {
    safeUnlink(temporary);
    throw error;
  }
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
    ...CHILD_PROCESS_OPTIONS
  }).trim();
  if (version !== expectedVersion) fail("installed worker version mismatch");
  const help = JSON.parse(execFileSync(process.execPath, [cliPath, "review-pr", "--help"], {
    ...CHILD_PROCESS_OPTIONS
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

function installVersion({
  versionsRoot,
  versionID,
  tarballPath,
  manifestBytes,
  manifestSHA256,
  packageVersion,
  rejectExisting,
  protectedVersionIDs = []
}) {
  const versionRoot = join(versionsRoot, versionID);
  if (!pathIsInside(versionsRoot, versionRoot)) fail("worker version path escaped the version root");
  const action = selectWorkerVersionAction(versionRoot, {
    rejectExisting,
    versionID,
    protectedVersionIDs
  });
  if (action === "replace") {
    removeReplaceableWorkerVersion({ versionRoot, versionsRoot });
  }

  const staging = join(versionsRoot, `.staging-${process.pid}-${randomUUID()}`);
  mkdirSync(staging, { mode: 0o700 });
  const npmPath = resolveNpmPath();
  try {
    execFileSync(npmPath, [
      "install", "--offline", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", staging, tarballPath
    ], CHILD_PROCESS_OPTIONS);
    verifyInstalledWorker(staging, packageVersion);
    writeFileSync(join(staging, ".neondiff-candidate-manifest.json"), manifestBytes, { mode: 0o600 });
    writeFileSync(join(staging, ".neondiff-candidate-manifest.sha256"), `${manifestSHA256}\n`, { mode: 0o600 });
    renameSync(staging, versionRoot);
  } catch (error) {
    try {
      rmSync(staging, { recursive: true, force: true });
    } catch {
      fail("worker package installation failed and its staging directory could not be removed");
    }
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

function protectedWorkerVersionIDs(paths, state) {
  const protectedIDs = [];
  for (const value of [state?.currentVersionID, state?.previousVersionID]) {
    if (value === null || value === undefined) continue;
    if (
      typeof value !== "string"
      || value.length === 0
      || value.includes(sep)
    ) {
      fail("worker state version reference is invalid");
    }
    protectedIDs.push(value);
  }
  const activeTarget = currentTarget(paths.currentLink, paths.versionsRoot);
  if (activeTarget) {
    const activeVersionID = relative(
      paths.versionsRoot,
      resolve(dirname(paths.currentLink), activeTarget)
    );
    if (activeVersionID.length === 0 || activeVersionID.includes(sep)) {
      fail("worker current pointer must name one exact version");
    }
    protectedIDs.push(activeVersionID);
  }
  return [...new Set(protectedIDs)];
}

function switchCurrent(currentLink, relativeTarget) {
  const temporary = `${currentLink}.next-${process.pid}-${randomUUID()}`;
  try {
    symlinkSync(relativeTarget, temporary);
    renameSync(temporary, currentLink);
  } catch (error) {
    safeUnlink(temporary);
    throw error;
  }
}

function removeFreshWorkerVersion(versionRoot, versionsRoot) {
  if (!pathIsInside(versionsRoot, versionRoot)) {
    fail("first-install recovery version escaped the version root");
  }
  const entry = lstatSync(versionRoot);
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    fail("first-install recovery version is not the created directory");
  }
  const realVersionsRoot = realpathSync(versionsRoot);
  const realVersionRoot = realpathSync(versionRoot);
  if (!pathIsInside(realVersionsRoot, realVersionRoot)) {
    fail("first-install recovery version escaped the real version root");
  }
  rmSync(realVersionRoot, { recursive: true });
}

function launchdState(label) {
  const domain = `gui/${process.getuid()}`;
  const target = `${domain}/${label}`;
  const result = spawnSync("/bin/launchctl", ["print", target], CHILD_PROCESS_OPTIONS);
  if (result.status === 0) return { loaded: true, domain, target, label };
  const detail = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (/could not find service|service not found/i.test(detail)) {
    return { loaded: false, domain, target, label };
  }
  fail("launchd service state is ambiguous");
}

function stopIfLoaded(state) {
  if (!state.loaded) return;
  execFileSync("/bin/launchctl", ["bootout", state.target], {
    ...CHILD_PROCESS_OPTIONS
  });
}

function startIfPreviouslyLoaded(state, plistPath) {
  if (!state.loaded) return;
  retryTransientLaunchdBootstrap({
    bootstrap() {
      execFileSync("/bin/launchctl", ["bootstrap", state.domain, plistPath], {
        ...CHILD_PROCESS_OPTIONS
      });
    },
    isLoaded() {
      return launchdState(state.label).loaded;
    },
    wait(milliseconds) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
    }
  });
  execFileSync("/bin/launchctl", ["kickstart", "-k", state.target], {
    ...CHILD_PROCESS_OPTIONS
  });
}

function stopReplacementForRecovery(state) {
  if (!state.loaded) return;
  const result = spawnSync("/bin/launchctl", ["bootout", state.target], CHILD_PROCESS_OPTIONS);
  if (result.status === 0) return;
  const detail = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (/could not find service|service not found/i.test(detail)) return;
  fail("replacement launchd job could not be stopped during recovery");
}

function attemptRecoveryStep(errors, label, operation) {
  try {
    operation();
  } catch (error) {
    errors.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function mutateLaunchAgent({ plistPath, nextLaunchAgent, currentLink, nextTarget, nextState, statePath }) {
  const originalBytes = readFileSync(plistPath);
  const oldCurrentTarget = currentTarget(currentLink, join(dirname(currentLink), "versions"));
  const priorState = readState(statePath);
  const stagedPlist = `${plistPath}.next-${process.pid}-${randomUUID()}`;
  let service = null;
  let plistReplaced = false;
  try {
    writePlistFromTemplate(plistPath, stagedPlist, nextLaunchAgent);
    service = launchdState(nextLaunchAgent.Label);
    stopIfLoaded(service);
    renameSync(stagedPlist, plistPath);
    plistReplaced = true;
    if (nextTarget) {
      switchCurrent(currentLink, nextTarget);
    } else if (existsSync(currentLink) && lstatSync(currentLink).isSymbolicLink()) {
      unlinkSync(currentLink);
    }
    startIfPreviouslyLoaded(service, plistPath);
    writeState(statePath, nextState);
  } catch (error) {
    const recoveryErrors = [];
    attemptRecoveryStep(recoveryErrors, "remove staged plist", () => safeUnlink(stagedPlist));
    if (plistReplaced) {
      attemptRecoveryStep(recoveryErrors, "restore LaunchAgent plist", () => {
        const restorePlist = `${plistPath}.restore-${process.pid}-${randomUUID()}`;
        try {
          writeFileSync(restorePlist, originalBytes, { mode: 0o600 });
          renameSync(restorePlist, plistPath);
        } catch (caught) {
          safeUnlink(restorePlist);
          throw caught;
        }
      });
    }
    attemptRecoveryStep(recoveryErrors, "restore worker pointer", () => {
      if (oldCurrentTarget) {
        switchCurrent(currentLink, oldCurrentTarget);
      } else if (existsSync(currentLink) && lstatSync(currentLink).isSymbolicLink()) {
        unlinkSync(currentLink);
      }
    });
    attemptRecoveryStep(recoveryErrors, "restore rollback state", () => {
      if (priorState) writeState(statePath, priorState);
      else safeUnlink(statePath);
    });
    if (service && plistReplaced) {
      attemptRecoveryStep(recoveryErrors, "restore launchd service", () => {
        recoverPreviouslyLoadedWorker({
          wasLoaded: service.loaded,
          stopReplacement() {
            stopReplacementForRecovery(service);
          },
          startOriginal() {
            startIfPreviouslyLoaded(service, plistPath);
          }
        });
      });
    }
    if (recoveryErrors.length > 0) {
      fail(
        `worker activation failed and recovery was incomplete: ${
          error instanceof Error ? error.message : String(error)
        }; ${recoveryErrors.join("; ")}`
      );
    }
    fail(`worker activation failed and the prior worker was restored: ${error instanceof Error ? error.message : String(error)}`);
  }
  return service.loaded;
}

function withWorkerLock(paths, operation) {
  ensurePrivateDirectory(paths.workerRoot);
  ensurePrivateDirectory(paths.versionsRoot);
  const ownerPath = join(paths.lockPath, LOCK_OWNER_FILENAME);
  const owner = {
    schemaVersion: 1,
    pid: process.pid,
    createdAt: new Date().toISOString()
  };
  try {
    mkdirSync(paths.lockPath, { mode: 0o700 });
  } catch (error) {
    if (!error || typeof error !== "object" || error.code !== "EEXIST") {
      fail(`worker lock could not be created: ${error instanceof Error ? error.message : String(error)}`);
    }
    let existingOwner;
    try {
      existingOwner = JSON.parse(readFileSync(ownerPath, "utf8"));
    } catch {
      fail("worker lock exists without valid owner metadata; contact NeonDiff support before removing it");
    }
    if (!Number.isInteger(existingOwner?.pid) || existingOwner.pid <= 0) {
      fail("worker lock owner metadata is invalid; contact NeonDiff support before removing it");
    }
    let ownerIsAlive = true;
    try {
      process.kill(existingOwner.pid, 0);
    } catch (caught) {
      if (caught && typeof caught === "object" && caught.code === "ESRCH") ownerIsAlive = false;
    }
    if (ownerIsAlive) fail("another NeonDiff worker install or rollback is active");
    rmSync(paths.lockPath, { recursive: true, force: true });
    mkdirSync(paths.lockPath, { mode: 0o700 });
  }
  try {
    writeFileSync(ownerPath, `${JSON.stringify(owner)}\n`, { mode: 0o600 });
  } catch (error) {
    rmSync(paths.lockPath, { recursive: true, force: true });
    fail(`worker lock owner metadata could not be written: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return operation();
  } finally {
    rmSync(paths.lockPath, { recursive: true, force: true });
  }
}

function firstInstall(args) {
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
  assertFirstInstallTargetUnused(paths);
  const manifestBytes = readFileSync(manifestPath);
  const candidate = validateWorkerCandidate({
    manifestBytes,
    manifestSHA256,
    tarballBytes: readFileSync(tarballPath),
    tarballFilename: basename(tarballPath)
  });
  const nodePath = selectStableNodeLaunchPath({
    execPath: process.execPath,
    stableCandidates: ["/opt/homebrew/bin/node", "/usr/local/bin/node"],
    resolvePath: realpathSync
  });
  const plan = planWorkerFirstInstall({
    launchdLabel: label,
    workerRoot: paths.workerRoot,
    nodePath,
    candidateHead: candidate.candidateHead,
    packageVersion: candidate.packageVersion,
    manifestSHA256
  });
  requireFirstInstallLaunchdUnloaded(launchdState(label));
  if (dryRun) {
    console.log(JSON.stringify({ ok: true, dryRun: true, ...plan.publicSummary }));
    return;
  }
  withWorkerLock(paths, () => {
    assertFirstInstallTargetUnused(paths);
    requireFirstInstallLaunchdUnloaded(launchdState(label));
    const versionRoot = installVersion({
      versionsRoot: paths.versionsRoot,
      versionID: plan.versionID,
      tarballPath,
      manifestBytes,
      manifestSHA256,
      packageVersion: candidate.packageVersion,
      rejectExisting: true
    });
    const relativeTarget = join("versions", plan.versionID);
    try {
      writeState(paths.installationPath, plan.nextState);
      switchCurrent(paths.currentLink, relativeTarget);
    } catch (error) {
      try {
        recoverFailedFirstInstall({
          expectedCurrentTarget: relativeTarget,
          observedCurrentTarget: currentTarget(
            paths.currentLink,
            paths.versionsRoot
          ),
          removeCurrent: () => safeUnlink(paths.currentLink),
          removeMarker: () => safeUnlink(paths.installationPath),
          removeVersion: () => removeFreshWorkerVersion(
            versionRoot,
            paths.versionsRoot
          )
        });
      } catch (recoveryError) {
        fail(
          `first install failed and cleanup was incomplete: ${
            error instanceof Error ? error.message : String(error)
          }; ${
            recoveryError instanceof Error
              ? recoveryError.message
              : String(recoveryError)
          }`
        );
      }
      throw error;
    }
  });
  console.log(JSON.stringify({ ok: true, dryRun: false, ...plan.publicSummary }));
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
  const nodePath = selectStableNodeLaunchPath({
    execPath: process.execPath,
    stableCandidates: ["/opt/homebrew/bin/node", "/usr/local/bin/node"],
    resolvePath: realpathSync
  });
  const plan = planWorkerUpdate({
    launchAgent,
    expectedLabel: label,
    workerRoot: paths.workerRoot,
    nodePath,
    candidateHead: candidate.candidateHead,
    packageVersion: candidate.packageVersion,
    manifestSHA256,
    previousState: priorState
  });
  if (dryRun) {
    console.log(JSON.stringify({ ok: true, dryRun: true, ...plan.publicSummary }));
    return;
  }
  const result = withWorkerLock(paths, () => {
    const lockedState = readState(paths.statePath);
    if (JSON.stringify(lockedState) !== JSON.stringify(priorState)) {
      fail("worker state changed after update preview; retry the update");
    }
    const protectedVersionIDs = protectedWorkerVersionIDs(paths, lockedState);
    installVersion({
      versionsRoot: paths.versionsRoot,
      versionID: plan.versionID,
      tarballPath,
      manifestBytes,
      manifestSHA256,
      packageVersion: candidate.packageVersion,
      rejectExisting: false,
      protectedVersionIDs
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
  const replacementVersionID = `rollback-${randomUUID()}`;
  const plan = planWorkerRollback({
    state,
    currentLaunchAgent: launchAgent,
    expectedLabel: label,
    replacementVersionID
  });
  const manifestPath = requireAbsoluteRegularFile(
    required(args, "manifest"),
    MAX_MANIFEST_BYTES,
    "rollback manifest"
  );
  const tarballPath = requireAbsoluteRegularFile(
    required(args, "tarball"),
    MAX_TARBALL_BYTES,
    "rollback tarball"
  );
  const manifestSHA256 = required(args, "manifest-sha256");
  const manifestBytes = readFileSync(manifestPath);
  const candidate = validateWorkerCandidate({
    manifestBytes,
    manifestSHA256,
    tarballBytes: readFileSync(tarballPath),
    tarballFilename: basename(tarballPath)
  });
  requireRollbackCandidate({
    expectedCandidate: plan.expectedCandidate,
    suppliedCandidate: candidate,
    suppliedManifestSHA256: manifestSHA256
  });
  if (dryRun) {
    console.log(JSON.stringify({ ok: true, dryRun: true, ...plan.publicSummary }));
    return;
  }
  const result = withWorkerLock(paths, () => {
    const lockedState = readState(paths.statePath);
    if (JSON.stringify(lockedState) !== JSON.stringify(state)) {
      fail("worker state changed after rollback preview; retry the rollback");
    }
    const lockedPlan = planWorkerRollback({
      state: lockedState,
      currentLaunchAgent: parsePlist(plistPath),
      expectedLabel: label,
      replacementVersionID
    });
    requireRollbackCandidate({
      expectedCandidate: lockedPlan.expectedCandidate,
      suppliedCandidate: candidate,
      suppliedManifestSHA256: manifestSHA256
    });
    installVersion({
      versionsRoot: paths.versionsRoot,
      versionID: replacementVersionID,
      tarballPath,
      manifestBytes,
      manifestSHA256,
      packageVersion: candidate.packageVersion,
      rejectExisting: true
    });
    const restarted = mutateLaunchAgent({
      plistPath,
      nextLaunchAgent: lockedPlan.nextLaunchAgent,
      currentLink: paths.currentLink,
      nextTarget: join("versions", replacementVersionID),
      nextState: lockedPlan.nextState,
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
  requireSupportedRuntime();
  const args = parseArgs(values);
  if (action === "first-install") firstInstall(args);
  else if (action === "update") update(args);
  else if (action === "rollback") rollback(args);
  else fail("action must be first-install, update, or rollback");
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
