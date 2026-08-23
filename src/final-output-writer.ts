import { closeSync, constants, fsyncSync, fstatSync, lstatSync, mkdtempSync, openSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export interface FinalOutputOptions {
  trustedRoot: string;
  relativePath: string;
  contents: string | Uint8Array;
  /** Deterministic hostile-race fixture; production callers should omit this. */
  beforeCommit?: () => void;
}

interface DirectorySnapshot {
  path: string;
  fd: number;
  dev: number;
  ino: number;
}

const noFollow = constants.O_NOFOLLOW;
const directory = constants.O_DIRECTORY;

/** Write once, atomically, beneath an existing trusted directory. Consumers are not migrated here. */
export function writeFinalOutput(input: FinalOutputOptions): string {
  if (typeof noFollow !== "number" || typeof directory !== "number") {
    throw new Error("descriptor-bound final output requires O_NOFOLLOW and O_DIRECTORY");
  }
  const rootInput = resolve(input.trustedRoot);
  const rootEntry = lstatSync(rootInput);
  if (rootEntry.isSymbolicLink() || !rootEntry.isDirectory()) throw new Error("trusted root must be a real directory");
  const root = realpathSync.native(rootInput);
  const target = resolve(root, input.relativePath);
  const relation = relative(root, target);
  if (!input.relativePath || isAbsolute(input.relativePath) || relation === "" || relation === ".." || relation.startsWith(`..${sep}`)) {
    throw new Error("final output path must be a non-empty relative child of trusted root");
  }
  if (basename(target).includes("\0")) throw new Error("final output path contains NUL");
  const parent = dirname(target);
  const snapshots: DirectorySnapshot[] = [];
  let temporaryDirectory: string | undefined;
  let temporarySnapshot: DirectorySnapshot | undefined;
  try {
    for (const path of [root, ...(relative(root, parent) ? relative(root, parent).split(sep).map((part, i, parts) => join(root, ...parts.slice(0, i + 1))) : [])]) {
      snapshots.push(openDirectory(path));
    }
    rejectExistingTarget(target);
    temporaryDirectory = mkdtempSync(join(root, ".neondiff-final-output-"));
    temporarySnapshot = openDirectory(temporaryDirectory);
    const temporaryPath = join(temporaryDirectory, "payload");
    const temporaryFd = openSync(temporaryPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600);
    let temporaryStat: ReturnType<typeof fstatSync> | undefined;
    try {
      writeFileSync(temporaryFd, input.contents);
      fsyncSync(temporaryFd);
      temporaryStat = fstatSync(temporaryFd);
    } finally {
      closeSync(temporaryFd);
    }
    if (!temporaryStat || !temporaryStat.isFile() || temporaryStat.nlink !== 1) throw new Error("temporary output is not a private regular file");
    input.beforeCommit?.();
    revalidate(snapshots);
    revalidate([temporarySnapshot]);
    rejectExistingTarget(target);
    const onDiskTemporary = lstatSync(temporaryPath);
    if (!onDiskTemporary.isFile() || onDiskTemporary.nlink !== 1 || onDiskTemporary.dev !== temporaryStat.dev || onDiskTemporary.ino !== temporaryStat.ino) {
      throw new Error("temporary output descriptor no longer matches its path");
    }
    renameSync(temporaryPath, target);
    const finalStat = lstatSync(target);
    if (!finalStat.isFile() || finalStat.nlink !== 1 || finalStat.dev !== temporaryStat.dev || finalStat.ino !== temporaryStat.ino) {
      throw new Error("final output did not commit the validated temporary file");
    }
    return target;
  } finally {
    for (const snapshot of snapshots) closeSync(snapshot.fd);
    if (temporarySnapshot) {
      try { closeSync(temporarySnapshot.fd); } catch { /* already closed */ }
    }
    if (temporaryDirectory) {
      try {
        const entry = lstatSync(temporaryDirectory);
        if (entry.isDirectory() && entry.dev === temporarySnapshot?.dev && entry.ino === temporarySnapshot?.ino) {
          rmSync(temporaryDirectory, { recursive: true, force: true });
        }
      } catch { /* never replace the primary failure or remove a replacement */ }
    }
  }
}

function openDirectory(path: string): DirectorySnapshot {
  const fd = openSync(path, constants.O_RDONLY | directory | noFollow);
  try {
    const descriptor = fstatSync(fd);
    const entry = lstatSync(path);
    if (entry.isSymbolicLink() || !entry.isDirectory() || entry.dev !== descriptor.dev || entry.ino !== descriptor.ino) {
      throw new Error(`ancestor directory is not descriptor-bound: ${path}`);
    }
    return { path, fd, dev: descriptor.dev, ino: descriptor.ino };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function revalidate(snapshots: DirectorySnapshot[]): void {
  for (const snapshot of snapshots) {
    const entry = lstatSync(snapshot.path);
    const descriptor = fstatSync(snapshot.fd);
    if (entry.isSymbolicLink() || !entry.isDirectory() || entry.dev !== snapshot.dev || entry.ino !== snapshot.ino || descriptor.dev !== snapshot.dev || descriptor.ino !== snapshot.ino) {
      throw new Error(`ancestor directory changed before final output commit: ${snapshot.path}`);
    }
  }
}

function rejectExistingTarget(path: string): void {
  let entry;
  try { entry = lstatSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (entry.isSymbolicLink() || entry.nlink > 1) throw new Error("refusing linked final output target");
  throw new Error("final output already exists; replay is rejected");
}
