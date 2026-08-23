import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { assertPathOutsideProtectedRoot } from "./path-safety.js";
import { redactSecrets } from "./secrets.js";

export const DEFAULT_GIT_COMMAND_TIMEOUT_MS = 120_000;
const gitMirrorTails = new Map<string, Promise<void>>();

export class GitCommandError extends Error {
  readonly failureKind: "timeout" | "spawn_error" | "exit_nonzero";
  readonly timeoutMs: number;

  constructor(input: {
    failureKind: "timeout" | "spawn_error" | "exit_nonzero";
    timeoutMs: number;
    detail?: string;
  }) {
    super(`git command ${input.failureKind}${input.detail ? `: ${redactSecrets(input.detail).slice(0, 400)}` : ""}`);
    this.name = "GitCommandError";
    this.failureKind = input.failureKind;
    this.timeoutMs = input.timeoutMs;
  }
}

export interface PreparedWorktree {
  path: string;
  headSha: string;
}

export interface PullWorktreePathPlan {
  mirrorPath: string;
  worktreePath: string;
  repoUrl: string;
}

export interface PullWorktreeInput {
  repo: string;
  pullNumber: number;
  expectedHeadSha: string;
  workRoot: string;
  protectedCheckoutRoot?: string;
  protectedCheckoutRoots?: string[];
  gitCommandTimeoutMs?: number;
}

export interface BranchWorktreeInput {
  repo: string;
  branch: string;
  repoUrl?: string;
  workRoot: string;
  protectedCheckoutRoot?: string;
  protectedCheckoutRoots?: string[];
  gitCommandTimeoutMs?: number;
}

export async function prepareBranchWorktree(input: BranchWorktreeInput): Promise<PreparedWorktree> {
  const timeoutMs = input.gitCommandTimeoutMs ?? DEFAULT_GIT_COMMAND_TIMEOUT_MS;
  const safeRepo = input.repo.replace(/[^A-Za-z0-9_.-]+/g, "__");
  const mirrorPath = join(input.workRoot, "mirrors", `${safeRepo}.git`);
  const repoUrl = input.repoUrl ?? `https://github.com/${input.repo}.git`;
  assertPathOutsideProtectedRoot({
    path: input.workRoot,
    protectedRoot: input.protectedCheckoutRoot,
    protectedRoots: input.protectedCheckoutRoots,
    pathLabel: "workRoot",
    protectedRootLabel: "the protected live checkout"
  });
  await run(["check-ref-format", `refs/heads/${input.branch}`], timeoutMs);
  return withGitMirrorLock(mirrorPath, async () => {
  mkdirSync(join(input.workRoot, "mirrors"), { recursive: true });
  mkdirSync(join(input.workRoot, "worktrees"), { recursive: true });
  if (!await existsAsGitMirror(mirrorPath, timeoutMs)) {
    await run(["clone", "--mirror", repoUrl, mirrorPath], timeoutMs);
  } else {
    await run(["--git-dir", mirrorPath, "remote", "set-url", "origin", repoUrl], timeoutMs);
  }
  await run([
    "--git-dir",
    mirrorPath,
    "fetch",
    "--prune",
    "origin",
    `+refs/heads/${input.branch}:refs/heads/${input.branch}`
  ], timeoutMs);
  const headSha = (await run(["--git-dir", mirrorPath, "rev-parse", `refs/heads/${input.branch}`], timeoutMs)).stdout.trim();
  const worktreePath = join(input.workRoot, "worktrees", branchWorktreeName(input.repo, input.branch, headSha));
  assertPathOutsideProtectedRoot({
    path: worktreePath,
    protectedRoot: input.protectedCheckoutRoot,
    protectedRoots: input.protectedCheckoutRoots,
    pathLabel: "worktreePath",
    protectedRootLabel: "the protected live checkout"
  });
  await repairExistingReviewWorktreePathForCheckout({
    worktreePath,
    mirrorPath,
    protectedCheckoutRoot: input.protectedCheckoutRoot,
    protectedCheckoutRoots: input.protectedCheckoutRoots,
    gitCommandTimeoutMs: timeoutMs
  });
  await run(["--git-dir", mirrorPath, "worktree", "add", "--detach", worktreePath, headSha], timeoutMs);
  const actualHeadSha = (await run(["-C", worktreePath, "rev-parse", "HEAD"], timeoutMs)).stdout.trim();
  if (actualHeadSha !== headSha) {
    throw new Error(`Worktree head mismatch for ${input.repo}@${input.branch}: ${actualHeadSha} !== ${headSha}`);
  }
  return { path: worktreePath, headSha: actualHeadSha };
  });
}

export function branchWorktreeName(repo: string, branch: string, headSha: string): string {
  const safeRepo = repo.replace(/[^A-Za-z0-9_.-]+/g, "__");
  const branchIdentity = createHash("sha256").update(branch).digest("hex").slice(0, 16);
  return `${safeRepo}__branch-${branchIdentity}__${headSha.slice(0, 12)}`;
}

export function planPullWorktreePaths(input: PullWorktreeInput): PullWorktreePathPlan {
  const safeRepo = input.repo.replace(/[^A-Za-z0-9_.-]+/g, "__");
  const mirrorPath = join(input.workRoot, "mirrors", `${safeRepo}.git`);
  const worktreePath = join(input.workRoot, "worktrees", `${safeRepo}__pr-${input.pullNumber}__${input.expectedHeadSha.slice(0, 12)}`);
  const repoUrl = `https://github.com/${input.repo}.git`;
  assertReviewPathOutsideProtectedCheckout("workRoot", input.workRoot, input);
  assertReviewPathOutsideProtectedCheckout("mirrorPath", mirrorPath, input);
  assertReviewPathOutsideProtectedCheckout("worktreePath", worktreePath, input);

  return { mirrorPath, worktreePath, repoUrl };
}

export async function preparePullWorktree(input: PullWorktreeInput): Promise<PreparedWorktree> {
  const timeoutMs = input.gitCommandTimeoutMs ?? DEFAULT_GIT_COMMAND_TIMEOUT_MS;
  const { mirrorPath, worktreePath, repoUrl } = planPullWorktreePaths(input);

  return withGitMirrorLock(mirrorPath, async () => {
  mkdirSync(join(input.workRoot, "mirrors"), { recursive: true });
  mkdirSync(join(input.workRoot, "worktrees"), { recursive: true });

  if (!await existsAsGitMirror(mirrorPath, timeoutMs)) {
    await run(["clone", "--mirror", repoUrl, mirrorPath], timeoutMs);
  } else {
    await run(["--git-dir", mirrorPath, "remote", "set-url", "origin", repoUrl], timeoutMs);
  }

  await run([
    "--git-dir",
    mirrorPath,
    "fetch",
    "--prune",
    "origin",
    `+refs/pull/${input.pullNumber}/head:refs/pull/${input.pullNumber}/head`,
    "+refs/heads/*:refs/heads/*"
  ], timeoutMs);

  await repairExistingReviewWorktreePathForCheckout({
    worktreePath,
    mirrorPath,
    protectedCheckoutRoot: input.protectedCheckoutRoot,
    protectedCheckoutRoots: input.protectedCheckoutRoots,
    gitCommandTimeoutMs: timeoutMs
  });
  await run([
    "--git-dir",
    mirrorPath,
    "worktree",
    "add",
    "--detach",
    worktreePath,
    `refs/pull/${input.pullNumber}/head`
  ], timeoutMs);

  const actualHeadSha = (await run(["-C", worktreePath, "rev-parse", "HEAD"], timeoutMs)).stdout.trim();
  if (actualHeadSha !== input.expectedHeadSha) {
    throw new Error(`Worktree head mismatch for ${input.repo}#${input.pullNumber}: ${actualHeadSha} !== ${input.expectedHeadSha}`);
  }

  return { path: worktreePath, headSha: actualHeadSha };
  });
}

export async function repairExistingReviewWorktreePathForCheckout(input: {
  worktreePath: string;
  mirrorPath: string;
  protectedCheckoutRoot?: string;
  protectedCheckoutRoots?: string[];
  gitCommandTimeoutMs?: number;
}): Promise<void> {
  const timeoutMs = input.gitCommandTimeoutMs ?? DEFAULT_GIT_COMMAND_TIMEOUT_MS;
  assertPathOutsideProtectedRoot({
    path: input.worktreePath,
    protectedRoot: input.protectedCheckoutRoot,
    protectedRoots: input.protectedCheckoutRoots,
    pathLabel: "worktreePath",
    protectedRootLabel: "the protected live checkout"
  });

  if (existsSync(input.worktreePath)) {
    const stat = lstatSync(input.worktreePath);
    if (stat.isSymbolicLink()) {
      throw new Error(`checkout preparation failed for ${input.worktreePath}: existing_symlink`);
    }
    const existingGitWorktree = await existsAsGitWorktree(input.worktreePath, timeoutMs);

    if (existingGitWorktree) {
      if (!await isGitWorktreeOwnedByMirror(input, timeoutMs)) {
        throw new Error(`checkout preparation failed for ${input.worktreePath}: existing_git_worktree_not_owned`);
      }
      await run(["--git-dir", input.mirrorPath, "worktree", "remove", "--force", input.worktreePath], timeoutMs);
    } else if (stat.isDirectory()) {
      const entries = readdirSync(input.worktreePath);
      const nonIgnorableEntries = entries.filter((entry) => !isIgnorableEmptyWorktreeEntry(entry));
      if (nonIgnorableEntries.length > 0) {
        throw new Error(
          `checkout preparation failed for ${input.worktreePath}: existing_non_git_non_empty; refusing to remove ${nonIgnorableEntries.length} file(s)`
        );
      }
      removeExistingReviewPath(input.worktreePath);
    } else {
      throw new Error(`checkout preparation failed for ${input.worktreePath}: existing_non_directory`);
    }
  }

  await run(["--git-dir", input.mirrorPath, "worktree", "prune"], timeoutMs);
}

function assertReviewPathOutsideProtectedCheckout(pathLabel: string, path: string, input: PullWorktreeInput): void {
  assertPathOutsideProtectedRoot({
    path,
    protectedRoot: input.protectedCheckoutRoot,
    protectedRoots: input.protectedCheckoutRoots,
    pathLabel,
    protectedRootLabel: "the protected live checkout"
  });
}

export async function assertGitClean(worktreePath: string): Promise<void> {
  await run(["-C", worktreePath, "diff", "--exit-code"], DEFAULT_GIT_COMMAND_TIMEOUT_MS);
  await run(["-C", worktreePath, "diff", "--cached", "--exit-code"], DEFAULT_GIT_COMMAND_TIMEOUT_MS);
  const status = (await run(["-C", worktreePath, "status", "--porcelain=v1", "--untracked-files=all"], DEFAULT_GIT_COMMAND_TIMEOUT_MS)).stdout.trim();
  if (status) {
    throw new Error(`Worktree has untracked or modified files after review:\n${status}`);
  }
}

async function existsAsGitMirror(path: string, timeoutMs: number): Promise<boolean> {
  const result = await probe(["--git-dir", path, "rev-parse", "--is-bare-repository"], timeoutMs);
  return result?.stdout.trim() === "true";
}

async function existsAsGitWorktree(path: string, timeoutMs: number): Promise<boolean> {
  const result = await probe(["-C", path, "rev-parse", "--is-inside-work-tree"], timeoutMs);
  return result?.stdout.trim() === "true";
}

async function isGitWorktreeOwnedByMirror(
  input: { mirrorPath: string; worktreePath: string },
  timeoutMs: number
): Promise<boolean> {
  const result = await run(["--git-dir", input.mirrorPath, "worktree", "list", "--porcelain"], timeoutMs);

  const existingRawPath = resolve(input.worktreePath);
  const existingRealPath = maybeRealpath(input.worktreePath);
  if (!existingRealPath) {
    throw new Error(`checkout preparation failed for ${input.worktreePath}: existing_git_worktree_missing`);
  }
  for (const line of result.stdout.split(/\r?\n/)) {
    if (!line.startsWith("worktree ")) continue;
    const listedPath = line.slice("worktree ".length).trim();
    if (!listedPath) continue;
    if (resolve(listedPath) === existingRawPath) return true;
    const listedRealPath = maybeRealpath(listedPath);
    if (listedRealPath === existingRealPath) return true;
  }
  return false;
}

function maybeRealpath(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

function removeExistingReviewPath(path: string): void {
  if (lstatSync(path).isSymbolicLink()) {
    throw new Error(`checkout preparation failed for ${path}: existing_symlink`);
  }
  rmSync(path, { recursive: true, force: true });
}

function isIgnorableEmptyWorktreeEntry(entry: string): boolean {
  return entry === ".DS_Store";
}

async function withGitMirrorLock<T>(mirrorPath: string, action: () => Promise<T>): Promise<T> {
  const predecessor = gitMirrorTails.get(mirrorPath) ?? Promise.resolve();
  let release!: () => void;
  const tail = new Promise<void>((resolve) => { release = resolve; });
  gitMirrorTails.set(mirrorPath, tail);
  await predecessor;
  try {
    return await action();
  } finally {
    release();
    if (gitMirrorTails.get(mirrorPath) === tail) gitMirrorTails.delete(mirrorPath);
  }
}

async function probe(args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string } | undefined> {
  try {
    return await run(args, timeoutMs);
  } catch (error) {
    if (error instanceof GitCommandError && error.failureKind === "exit_nonzero") return undefined;
    throw error;
  }
}

function run(args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { encoding: "utf8", maxBuffer: 10 * 1024 * 1024, timeout: timeoutMs }, (error, stdout, stderr) => {
      if (!error) {
        resolve({ stdout, stderr });
        return;
      }
      const processError = error as typeof error & { killed?: boolean; code?: string | number };
      const failureKind = processError.killed
        ? "timeout"
        : typeof processError.code === "number"
          ? "exit_nonzero"
          : "spawn_error";
      reject(new GitCommandError({
        failureKind,
        timeoutMs,
        detail: stderr || stdout || error.message
      }));
    });
  });
}
