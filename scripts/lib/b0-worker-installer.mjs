import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { basename, isAbsolute, join, relative, sep } from "node:path";

const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const PACKAGE_VERSION_PATTERN = /^1\.1\.0-beta\.[1-9][0-9]{0,3}$/;
const LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const STABLE_NODE_PATHS = new Set([
  "/opt/homebrew/bin/node",
  "/usr/local/bin/node"
]);
const REQUIRED_REVIEW_FLAGS = ["--expected-config-revision", "--zcode"];
const APP_ID_KEYS = ["NEONDIFF_GITHUB_APP_ID", "EVAOS_REVIEW_BOT_APP_ID"];
const PRIVATE_KEY_KEYS = [
  "NEONDIFF_GITHUB_APP_PRIVATE_KEY_PATH",
  "EVAOS_REVIEW_BOT_PRIVATE_KEY_PATH"
];
const LAUNCHD_BOOTSTRAP_RETRY_DELAYS_MS = [250, 750, 2_000, 5_000, 10_000];

function fail(message) {
  throw new Error(message);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isPathAtOrInside(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function consistentEnvironmentValue(environment, keys, validator, label) {
  const present = keys.filter((key) => environment[key] !== undefined);
  if (present.length === 0) fail(`LaunchAgent is missing ${label}`);
  const values = present.map((key) => environment[key]);
  if (!values.every((value) => typeof value === "string" && validator(value))) {
    fail(`LaunchAgent has invalid ${label}`);
  }
  if (new Set(values).size !== 1) fail(`LaunchAgent has conflicting ${label}`);
  return values[0];
}

function daemonIndexFor(argumentsList, workingDirectory) {
  if (argumentsList.length < 2 || !isAbsolute(workingDirectory)) {
    fail("LaunchAgent is not an approved NeonDiff daemon invocation");
  }
  const executable = basename(argumentsList[0]);
  if (executable === "neondiff" && argumentsList[1] === "daemon") return 1;
  if (executable !== "node") fail("LaunchAgent is not an approved NeonDiff daemon invocation");
  if (
    argumentsList[2] === "daemon"
    && isAbsolute(argumentsList[1])
    && argumentsList[1].endsWith("/dist/src/cli.js")
  ) {
    return 2;
  }
  if (
    argumentsList[3] === "daemon"
    && isAbsolute(argumentsList[1])
    && argumentsList[1].endsWith("/node_modules/tsx/dist/cli.mjs")
    && argumentsList[2] === "src/cli.ts"
  ) {
    return 3;
  }
  fail("LaunchAgent is not an approved NeonDiff daemon invocation");
}

function validateLaunchAgent(launchAgent, expectedLabel) {
  if (!LABEL_PATTERN.test(expectedLabel)) fail("launchd label is invalid");
  if (!launchAgent || typeof launchAgent !== "object" || Array.isArray(launchAgent)) {
    fail("LaunchAgent root must be a dictionary");
  }
  if (launchAgent.Label !== expectedLabel) fail("LaunchAgent label mismatch");
  if (
    !Array.isArray(launchAgent.ProgramArguments)
    || launchAgent.ProgramArguments.length === 0
    || !launchAgent.ProgramArguments.every((value) => typeof value === "string" && value.length > 0)
  ) {
    fail("LaunchAgent ProgramArguments are invalid");
  }
  if (typeof launchAgent.WorkingDirectory !== "string" || !isAbsolute(launchAgent.WorkingDirectory)) {
    fail("LaunchAgent WorkingDirectory must be absolute");
  }
  const environment = launchAgent.EnvironmentVariables;
  if (!environment || typeof environment !== "object" || Array.isArray(environment)) {
    fail("LaunchAgent EnvironmentVariables are invalid");
  }
  consistentEnvironmentValue(
    environment,
    APP_ID_KEYS,
    (value) => /^[1-9][0-9]*$/.test(value),
    "GitHub App ID"
  );
  consistentEnvironmentValue(
    environment,
    PRIVATE_KEY_KEYS,
    (value) => isAbsolute(value),
    "GitHub App private-key path"
  );

  const daemonIndex = daemonIndexFor(launchAgent.ProgramArguments, launchAgent.WorkingDirectory);
  const daemonArguments = launchAgent.ProgramArguments.slice(daemonIndex + 1);
  const configIndexes = daemonArguments
    .map((value, index) => value === "--config" ? index : -1)
    .filter((index) => index >= 0);
  if (
    configIndexes.length !== 1
    || configIndexes[0] + 1 >= daemonArguments.length
    || !isAbsolute(daemonArguments[configIndexes[0] + 1])
  ) {
    fail("LaunchAgent must contain exactly one absolute --config path");
  }
  return {
    daemonArguments,
    configPath: daemonArguments[configIndexes[0] + 1]
  };
}

export function validateWorkerCandidate({
  manifestBytes,
  manifestSHA256,
  tarballBytes,
  tarballFilename
}) {
  if (!Buffer.isBuffer(manifestBytes) || !Buffer.isBuffer(tarballBytes)) {
    fail("candidate inputs must be buffers");
  }
  if (!SHA256_PATTERN.test(manifestSHA256) || sha256(manifestBytes) !== manifestSHA256) {
    fail("manifest SHA-256 mismatch");
  }
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch {
    fail("candidate manifest is invalid JSON");
  }
  if (
    manifest?.schemaVersion !== 1
    || manifest?.candidateClass !== "b0-access-controlled-cli"
    || manifest?.source?.repository !== "electricsheephq/evaos-code-review-bot-neondiff"
    || manifest?.source?.protectedMainVerified !== true
    || !FULL_SHA_PATTERN.test(manifest?.source?.candidateHead ?? "")
  ) {
    fail("candidate manifest source identity is invalid");
  }
  const packageVersion = manifest?.package?.packageVersion;
  if (
    manifest?.package?.name !== "neondiff"
    || !PACKAGE_VERSION_PATTERN.test(packageVersion ?? "")
    || manifest?.installedCompatibility?.reportedVersion !== packageVersion
    || manifest?.installedCompatibility?.isolatedInstallPassed !== true
    || manifest?.installedCompatibility?.offlineInstallPassed !== true
    || JSON.stringify(manifest?.installedCompatibility?.bundledProductionDependencies)
      !== JSON.stringify(["validate-npm-package-license@3.0.4"])
  ) {
    fail("candidate manifest package identity is invalid");
  }
  if (
    basename(tarballFilename) !== tarballFilename
    || manifest?.package?.filename !== tarballFilename
    || !SHA256_PATTERN.test(manifest?.package?.sha256 ?? "")
    || sha256(tarballBytes) !== manifest.package.sha256
  ) {
    fail("candidate tarball SHA-256 mismatch");
  }
  const reviewFlags = manifest?.installedCompatibility?.reviewFlags;
  if (!Array.isArray(reviewFlags)) fail("candidate review capability is missing");
  for (const flag of REQUIRED_REVIEW_FLAGS) {
    if (!reviewFlags.includes(flag)) fail(`missing review capability ${flag}`);
  }
  if (
    manifest?.distribution?.privateBucketTarget !== "neondiff-beta-canary"
    || manifest?.distribution?.publicNpmPublished !== false
    || manifest?.distribution?.tagCreated !== false
    || manifest?.distribution?.githubReleaseCreated !== false
    || manifest?.distribution?.publicDownloadEnabled !== false
  ) {
    fail("candidate distribution boundary is invalid");
  }
  return {
    candidateHead: manifest.source.candidateHead,
    packageVersion,
    tarballSHA256: manifest.package.sha256,
    reviewFlags: [...REQUIRED_REVIEW_FLAGS]
  };
}

export function requireMissingWorkerVersion(versionRoot) {
  try {
    lstatSync(versionRoot);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return;
    throw error;
  }
  fail("worker version already exists; refusing unverified reuse");
}

export function planWorkerFirstInstall({
  launchdLabel,
  workerRoot,
  nodePath,
  candidateHead,
  packageVersion,
  manifestSHA256
}) {
  if (!LABEL_PATTERN.test(launchdLabel)) fail("launchd label is invalid");
  if (!isAbsolute(workerRoot)) fail("worker path must be absolute");
  if (!STABLE_NODE_PATHS.has(nodePath)) fail("approved stable Node path is required");
  if (!FULL_SHA_PATTERN.test(candidateHead)) fail("candidate head is invalid");
  if (!PACKAGE_VERSION_PATTERN.test(packageVersion)) {
    fail("candidate package version is invalid");
  }
  if (!SHA256_PATTERN.test(manifestSHA256)) {
    fail("candidate manifest SHA-256 is invalid");
  }
  const versionID = `${packageVersion}-${candidateHead.slice(0, 12)}`;
  return {
    versionID,
    nextState: {
      schemaVersion: 1,
      installationKind: "credential-free-cli",
      launchdLabel,
      nodePath,
      candidateHead,
      packageVersion,
      manifestSHA256
    },
    publicSummary: {
      action: "first-install",
      launchdLabel,
      packageVersion,
      candidateHead,
      createsLaunchAgent: false,
      startsDaemon: false,
      readsCredentials: false
    }
  };
}

export function planWorkerUpdate({
  launchAgent,
  expectedLabel,
  workerRoot,
  nodePath,
  candidateHead,
  packageVersion,
  manifestSHA256,
  previousState = null
}) {
  if (!isAbsolute(workerRoot) || !isAbsolute(nodePath)) fail("worker and Node paths must be absolute");
  if (!FULL_SHA_PATTERN.test(candidateHead)) fail("candidate head is invalid");
  if (!PACKAGE_VERSION_PATTERN.test(packageVersion)) fail("candidate package version is invalid");
  if (!SHA256_PATTERN.test(manifestSHA256)) fail("candidate manifest SHA-256 is invalid");
  const { daemonArguments, configPath } = validateLaunchAgent(launchAgent, expectedLabel);
  const versionID = `${packageVersion}-${candidateHead.slice(0, 12)}`;
  const currentPackageRoot = join(workerRoot, "current", "node_modules", "neondiff");
  if (previousState && previousState.launchdLabel !== expectedLabel) {
    fail("worker state label mismatch");
  }
  if (
    !previousState
    && (
      isPathAtOrInside(currentPackageRoot, launchAgent.WorkingDirectory)
      || launchAgent.ProgramArguments.some(
        (value) => isAbsolute(value) && isPathAtOrInside(currentPackageRoot, value)
      )
    )
  ) {
    fail("managed worker has no rollback state");
  }
  const nextLaunchAgent = clone(launchAgent);
  nextLaunchAgent.ProgramArguments = [
    nodePath,
    join(currentPackageRoot, "dist", "src", "cli.js"),
    "daemon",
    ...daemonArguments
  ];
  nextLaunchAgent.WorkingDirectory = launchAgent.WorkingDirectory;

  const originalProgramArguments = previousState?.originalProgramArguments
    ?? clone(launchAgent.ProgramArguments);
  const originalWorkingDirectory = previousState?.originalWorkingDirectory
    ?? launchAgent.WorkingDirectory;
  const previousVersionID = previousState?.currentVersionID ?? null;
  const previousPackageVersion = previousVersionID
    ? previousState?.packageVersion ?? null
    : null;
  const nextState = {
    schemaVersion: 1,
    launchdLabel: expectedLabel,
    currentVersionID: versionID,
    previousVersionID,
    previousPackageVersion,
    originalProgramArguments,
    originalWorkingDirectory,
    candidateHead,
    packageVersion,
    manifestSHA256
  };
  return {
    versionID,
    configPath,
    nextLaunchAgent,
    nextState,
    publicSummary: {
      action: previousVersionID ? "update" : "install",
      launchdLabel: expectedLabel,
      packageVersion,
      candidateHead,
      preservesConfiguration: true,
      preservesCredentials: true,
      preservesProviderState: true,
      preservesRepositoryAllowlist: true
    }
  };
}

export function selectStableNodeLaunchPath({ execPath, stableCandidates, resolvePath }) {
  if (!isAbsolute(execPath) || !Array.isArray(stableCandidates) || typeof resolvePath !== "function") {
    fail("Node launch-path inputs are invalid");
  }
  let resolvedExecPath;
  try {
    resolvedExecPath = resolvePath(execPath);
  } catch {
    return execPath;
  }
  if (typeof resolvedExecPath !== "string" || !isAbsolute(resolvedExecPath)) return execPath;

  for (const candidate of stableCandidates) {
    if (typeof candidate !== "string" || !isAbsolute(candidate)) continue;
    try {
      if (resolvePath(candidate) === resolvedExecPath) return candidate;
    } catch {
      // A missing candidate is expected on machines using a different Node prefix.
    }
  }
  return execPath;
}

export function planWorkerRollback({ state, currentLaunchAgent, expectedLabel }) {
  validateLaunchAgent(currentLaunchAgent, expectedLabel);
  if (
    state?.schemaVersion !== 1
    || state?.launchdLabel !== expectedLabel
    || !Array.isArray(state?.originalProgramArguments)
    || typeof state?.originalWorkingDirectory !== "string"
    || !isAbsolute(state.originalWorkingDirectory)
  ) {
    fail("worker rollback state is invalid");
  }
  if (state.currentVersionID === null) {
    fail("original worker is already active; run update to reactivate a candidate");
  }
  if (state.previousVersionID) {
    return {
      nextLaunchAgent: clone(currentLaunchAgent),
      nextState: {
        ...state,
        currentVersionID: state.previousVersionID,
        previousVersionID: state.currentVersionID,
        packageVersion: state.previousPackageVersion,
        previousPackageVersion: state.packageVersion
      },
      publicSummary: {
        action: "rollback",
        target: "previous-worker",
        launchdLabel: expectedLabel
      }
    };
  }
  const nextLaunchAgent = clone(currentLaunchAgent);
  nextLaunchAgent.ProgramArguments = clone(state.originalProgramArguments);
  nextLaunchAgent.WorkingDirectory = state.originalWorkingDirectory;
  validateLaunchAgent(nextLaunchAgent, expectedLabel);
  return {
    nextLaunchAgent,
    nextState: {
      ...state,
      currentVersionID: null,
      previousVersionID: state.currentVersionID,
      packageVersion: null,
      previousPackageVersion: state.packageVersion
    },
    publicSummary: {
      action: "rollback",
      target: "original-worker",
      launchdLabel: expectedLabel
    }
  };
}

export function recoverPreviouslyLoadedWorker({
  wasLoaded,
  stopReplacement,
  startOriginal
}) {
  if (!wasLoaded) return false;
  stopReplacement();
  startOriginal();
  return true;
}

export function retryTransientLaunchdBootstrap({
  bootstrap,
  isLoaded,
  wait,
  delays = LAUNCHD_BOOTSTRAP_RETRY_DELAYS_MS
}) {
  if (
    typeof bootstrap !== "function"
    || typeof isLoaded !== "function"
    || typeof wait !== "function"
    || !Array.isArray(delays)
    || !delays.every((value) => Number.isInteger(value) && value >= 0)
  ) {
    fail("launchd bootstrap retry dependencies are invalid");
  }
  let attempts = 0;
  while (true) {
    attempts += 1;
    try {
      bootstrap();
      return attempts;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const delay = delays[attempts - 1];
      if (
        delay === undefined
        || !/bootstrap failed:\s*5:\s*input\/output error/i.test(detail)
      ) {
        throw error;
      }
      const loaded = isLoaded();
      if (loaded !== true && loaded !== false) {
        fail("launchd service state is ambiguous during bootstrap retry");
      }
      wait(delay);
    }
  }
}
