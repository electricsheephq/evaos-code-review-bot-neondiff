import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeSync
} from "node:fs";
import type { Stats } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { format } from "node:util";
import { redactSecrets } from "./secrets.js";

export const LAUNCHD_LOG_POLICY = {
  maxBytes: 10 * 1024 * 1024,
  archiveCount: 5,
  maxAgeHours: 168,
  descriptorMode: "copy_ftruncate_same_inode" as const
};

export const LAUNCHD_LOG_ENV = {
  stdoutPath: "NEONDIFF_LAUNCHD_STDOUT_PATH",
  stderrPath: "NEONDIFF_LAUNCHD_STDERR_PATH",
  maxBytes: "NEONDIFF_LAUNCHD_LOG_MAX_BYTES",
  archiveCount: "NEONDIFF_LAUNCHD_LOG_ARCHIVE_COUNT",
  maxAgeHours: "NEONDIFF_LAUNCHD_LOG_MAX_AGE_HOURS"
} as const;

export interface LaunchdLogWriterOptions {
  path: string;
  fd: number;
  maxBytes?: number;
  archiveCount?: number;
  maxAgeMs?: number;
  now?: () => Date;
}

export interface LaunchdDaemonLogWriters {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

export interface DaemonLogEvent {
  event: string;
  level?: "info" | "error";
  [key: string]: unknown;
}

export function formatDaemonLog(input: DaemonLogEvent, now = new Date()): string {
  const { level = "info", ...rest } = input;
  return JSON.stringify({
    ts: now.toISOString(),
    level,
    ...redactRecord(rest)
  });
}

export function createLaunchdDaemonLogWriters(
  env: NodeJS.ProcessEnv = process.env
): LaunchdDaemonLogWriters | undefined {
  const values = Object.values(LAUNCHD_LOG_ENV).map((name) => env[name]);
  if (values.every((value) => value === undefined)) return undefined;
  if (values.some((value) => value === undefined)) {
    throw new Error("launchd log rotation environment is incomplete");
  }
  const stdoutPath = env[LAUNCHD_LOG_ENV.stdoutPath]!;
  const stderrPath = env[LAUNCHD_LOG_ENV.stderrPath]!;
  if (resolve(stdoutPath) === resolve(stderrPath)) {
    throw new Error("launchd stdout and stderr paths must be distinct");
  }
  const maxBytes = parsePositivePolicyInteger(env[LAUNCHD_LOG_ENV.maxBytes]!, LAUNCHD_LOG_ENV.maxBytes);
  const archiveCount = parsePositivePolicyInteger(
    env[LAUNCHD_LOG_ENV.archiveCount]!,
    LAUNCHD_LOG_ENV.archiveCount
  );
  const maxAgeHours = parsePositivePolicyInteger(
    env[LAUNCHD_LOG_ENV.maxAgeHours]!,
    LAUNCHD_LOG_ENV.maxAgeHours
  );
  return {
    stdout: createLaunchdLogWriter({
      path: stdoutPath,
      fd: process.stdout.fd,
      maxBytes,
      archiveCount,
      maxAgeMs: maxAgeHours * 60 * 60 * 1_000
    }),
    stderr: createLaunchdLogWriter({
      path: stderrPath,
      fd: process.stderr.fd,
      maxBytes,
      archiveCount,
      maxAgeMs: maxAgeHours * 60 * 60 * 1_000
    })
  };
}

export function installLaunchdDaemonConsole(writers: LaunchdDaemonLogWriters): void {
  console.log = (...values: unknown[]) => writers.stdout(redactSecrets(format(...values)));
  console.info = (...values: unknown[]) => writers.stdout(redactSecrets(format(...values)));
  console.warn = (...values: unknown[]) => writers.stderr(redactSecrets(format(...values)));
  console.error = (...values: unknown[]) => writers.stderr(redactSecrets(format(...values)));
}

export function createLaunchdLogWriter(options: LaunchdLogWriterOptions): (line: string) => void {
  const maxBytes = options.maxBytes ?? LAUNCHD_LOG_POLICY.maxBytes;
  const archiveCount = options.archiveCount ?? LAUNCHD_LOG_POLICY.archiveCount;
  const maxAgeMs = options.maxAgeMs ?? LAUNCHD_LOG_POLICY.maxAgeHours * 60 * 60 * 1_000;
  const now = options.now ?? (() => new Date());
  validatePolicyInteger(maxBytes, "maxBytes");
  validatePolicyInteger(archiveCount, "archiveCount");
  validatePolicyInteger(maxAgeMs, "maxAgeMs");
  assertPrivateLaunchdLog(options.path, options.fd);
  pruneLaunchdLogArchives(options.path, archiveCount, maxAgeMs, now());
  let archiveSequence = 0;
  return (line: string): void => {
    const record = Buffer.from(`${line}\n`, "utf8");
    pruneLaunchdLogArchives(options.path, archiveCount, maxAgeMs, now());
    const live = assertPrivateLaunchdLog(options.path, options.fd);
    if (live.size + record.byteLength > maxBytes && live.size > 0) {
      archiveSequence += 1;
      archiveLaunchdLog({
        path: options.path,
        fd: options.fd,
        archiveCount,
        maxAgeMs,
        now: now(),
        archiveSequence
      });
    }
    writeAll(options.fd, record);
  };
}

function archiveLaunchdLog(input: {
  path: string;
  fd: number;
  archiveCount: number;
  maxAgeMs: number;
  now: Date;
  archiveSequence: number;
}): void {
  assertPrivateLaunchdLog(input.path, input.fd);
  const directory = dirname(resolve(input.path));
  const archiveName = launchdArchiveName(input.path, input.now, input.archiveSequence);
  const archivePath = resolve(directory, archiveName);
  const temporaryPath = `${archivePath}.tmp`;
  const bytes = readInheritedLogSnapshot(input.path, input.fd);
  let temporaryFd: number | undefined;
  let temporaryCreated = false;
  try {
    temporaryFd = openSync(temporaryPath, "wx", 0o600);
    temporaryCreated = true;
    writeAll(temporaryFd, bytes);
    fsyncSync(temporaryFd);
    closeSync(temporaryFd);
    temporaryFd = undefined;
    renameSync(temporaryPath, archivePath);
    fsyncDirectory(directory);
    assertPrivateArchive(archivePath);
    pruneLaunchdLogArchives(input.path, input.archiveCount, input.maxAgeMs, input.now, archivePath);
    assertPrivateLaunchdLog(input.path, input.fd);
    ftruncateSync(input.fd, 0);
    assertPrivateLaunchdLog(input.path, input.fd);
  } catch (error) {
    if (temporaryFd !== undefined) closeSync(temporaryFd);
    if (temporaryCreated) {
      try {
        rmSync(temporaryPath, { force: true });
      } catch {
        // Preserve the original rotation failure; only this call's private temp path is eligible.
      }
    }
    throw error;
  }
}

function readInheritedLogSnapshot(path: string, inheritedFd: number): Buffer {
  const sourceFd = openSync(resolve(path), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const source = fstatSync(sourceFd) as Stats;
    const inherited = fstatSync(inheritedFd) as Stats;
    if (!source.isFile() || source.dev !== inherited.dev || source.ino !== inherited.ino) {
      throw new Error("launchd log snapshot must use the inherited descriptor inode");
    }
    return readFileSync(sourceFd);
  } finally {
    closeSync(sourceFd);
  }
}

function pruneLaunchdLogArchives(
  path: string,
  archiveCount: number,
  maxAgeMs: number,
  now: Date,
  protectedArchivePath?: string
): void {
  const directory = dirname(resolve(path));
  const archivePattern = launchdArchivePattern(path);
  const archives = readdirSync(directory)
    .filter((name) => archivePattern.test(name))
    .map((name) => {
      const archivePath = resolve(directory, name);
      const metadata = assertPrivateArchive(archivePath);
      return { path: archivePath, mtimeMs: metadata.mtimeMs };
    })
    .sort((left, right) => {
      if (left.path === right.path) return 0;
      if (left.path === protectedArchivePath) return -1;
      if (right.path === protectedArchivePath) return 1;
      return right.mtimeMs - left.mtimeMs || right.path.localeCompare(left.path);
    });
  for (const [index, archive] of archives.entries()) {
    if (
      archive.path !== protectedArchivePath
      && (index >= archiveCount || now.getTime() - archive.mtimeMs > maxAgeMs)
    ) {
      rmSync(archive.path);
    }
  }
}

function assertPrivateLaunchdLog(path: string, fd: number): Stats {
  const resolvedPath = resolve(path);
  const directory = dirname(resolvedPath);
  if (realpathSync(directory) !== directory) throw new Error("launchd log directory must not traverse symlinks");
  const directoryEntry = lstatSync(directory) as Stats;
  if (!directoryEntry.isDirectory() || directoryEntry.isSymbolicLink()) {
    throw new Error("launchd log directory must be a real directory");
  }
  assertCurrentUserPrivate(directoryEntry, "launchd log directory");
  const pathEntry = lstatSync(resolvedPath) as Stats;
  if (!pathEntry.isFile() || pathEntry.isSymbolicLink()) {
    throw new Error("launchd log path must be a regular non-symlink file");
  }
  assertCurrentUserPrivate(pathEntry, "launchd log path");
  const fdEntry = fstatSync(fd) as Stats;
  if (!fdEntry.isFile() || fdEntry.dev !== pathEntry.dev || fdEntry.ino !== pathEntry.ino) {
    throw new Error("launchd log path and inherited descriptor must identify the same regular file");
  }
  return fdEntry;
}

function assertPrivateArchive(path: string): Stats {
  const entry = lstatSync(path) as Stats;
  if (!entry.isFile() || entry.isSymbolicLink()) {
    throw new Error("launchd log archive must be a regular non-symlink file");
  }
  assertCurrentUserPrivate(entry, "launchd log archive");
  return entry;
}

function assertCurrentUserPrivate(entry: Stats, label: string): void {
  const getuid = process.getuid;
  if (typeof getuid !== "function" || entry.uid !== getuid()) {
    throw new Error(`${label} must be owned by the current user`);
  }
  if ((entry.mode & 0o077) !== 0) throw new Error(`${label} must not be group or world accessible`);
}

function launchdArchiveName(path: string, now: Date, sequence: number): string {
  const timestamp = now.toISOString().replace(/[-:.]/g, "");
  return `${basename(path)}.neondiff-${timestamp}-${process.pid}-${sequence}.archive`;
}

function launchdArchivePattern(path: string): RegExp {
  const escaped = basename(path).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped}\\.neondiff-\\d{8}T\\d{9}Z-\\d+-\\d+\\.archive$`);
}

function writeAll(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.byteLength) offset += writeSync(fd, bytes, offset, bytes.byteLength - offset);
}

function fsyncDirectory(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function parsePositivePolicyInteger(value: string, label: string): number {
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error(`${label} must be a positive integer`);
  const parsed = Number(value);
  validatePolicyInteger(parsed, label);
  return parsed;
}

function validatePolicyInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive safe integer`);
}

function redactRecord(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactObject(entry)]));
}

function redactObject(value: unknown): unknown {
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map((entry) => redactObject(entry));
  if (value && typeof value === "object") {
    return redactRecord(value as Record<string, unknown>);
  }
  return value;
}
