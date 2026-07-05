import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { assertPathOutsideProtectedRoot } from "./path-safety.js";

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

export function preparePullWorktree(input: PullWorktreeInput): PreparedWorktree {
  const { mirrorPath, worktreePath, repoUrl } = planPullWorktreePaths(input);

  mkdirSync(join(input.workRoot, "mirrors"), { recursive: true });
  mkdirSync(join(input.workRoot, "worktrees"), { recursive: true });

  if (!existsAsGitMirror(mirrorPath)) {
    run("git", ["clone", "--mirror", repoUrl, mirrorPath]);
  } else {
    run("git", ["--git-dir", mirrorPath, "remote", "set-url", "origin", repoUrl]);
  }

  run("git", [
    "--git-dir",
    mirrorPath,
    "fetch",
    "--prune",
    "origin",
    `+refs/pull/${input.pullNumber}/head:refs/pull/${input.pullNumber}/head`,
    "+refs/heads/*:refs/heads/*"
  ]);

  repairExistingReviewWorktreePathForCheckout({
    worktreePath,
    mirrorPath,
    protectedCheckoutRoot: input.protectedCheckoutRoot,
    protectedCheckoutRoots: input.protectedCheckoutRoots
  });
  run("git", [
    "--git-dir",
    mirrorPath,
    "worktree",
    "add",
    "--detach",
    worktreePath,
    `refs/pull/${input.pullNumber}/head`
  ]);

  const actualHeadSha = run("git", ["-C", worktreePath, "rev-parse", "HEAD"]).stdout.trim();
  if (actualHeadSha !== input.expectedHeadSha) {
    throw new Error(`Worktree head mismatch for ${input.repo}#${input.pullNumber}: ${actualHeadSha} !== ${input.expectedHeadSha}`);
  }

  return { path: worktreePath, headSha: actualHeadSha };
}

export function repairExistingReviewWorktreePathForCheckout(input: {
  worktreePath: string;
  mirrorPath: string;
  protectedCheckoutRoot?: string;
  protectedCheckoutRoots?: string[];
}): void {
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
    const existingGitWorktree = existsAsGitWorktree(input.worktreePath);

    if (existingGitWorktree) {
      if (!isGitWorktreeOwnedByMirror(input)) {
        throw new Error(`checkout preparation failed for ${input.worktreePath}: existing_git_worktree_not_owned`);
      }
      run("git", ["--git-dir", input.mirrorPath, "worktree", "remove", "--force", input.worktreePath]);
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

  run("git", ["--git-dir", input.mirrorPath, "worktree", "prune"]);
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

export function assertGitClean(worktreePath: string): void {
  run("git", ["-C", worktreePath, "diff", "--exit-code"]);
  run("git", ["-C", worktreePath, "diff", "--cached", "--exit-code"]);
  const status = run("git", ["-C", worktreePath, "status", "--porcelain=v1", "--untracked-files=all"]).stdout.trim();
  if (status) {
    throw new Error(`Worktree has untracked or modified files after review:\n${status}`);
  }
}

function existsAsGitMirror(path: string): boolean {
  const result = spawnSync("git", ["--git-dir", path, "rev-parse", "--is-bare-repository"], { encoding: "utf8" });
  return result.status === 0 && result.stdout.trim() === "true";
}

function existsAsGitWorktree(path: string): boolean {
  const result = spawnSync("git", ["-C", path, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8" });
  if (result.status === null) {
    const message = result.error instanceof Error ? result.error.message : "git failed before returning a status";
    throw new Error(`checkout preparation failed for ${path}: git_worktree_probe_failed: ${message}`);
  }
  return result.status === 0 && result.stdout.trim() === "true";
}

function isGitWorktreeOwnedByMirror(input: { mirrorPath: string; worktreePath: string }): boolean {
  const result = spawnSync("git", ["--git-dir", input.mirrorPath, "worktree", "list", "--porcelain"], { encoding: "utf8" });
  if (result.status === null) {
    const message = result.error instanceof Error ? result.error.message : "git failed before returning a status";
    throw new Error(`checkout preparation failed for ${input.worktreePath}: git_worktree_list_failed: ${message}`);
  }
  if (result.status !== 0) {
    throw new Error(`checkout preparation failed for ${input.worktreePath}: git_worktree_list_failed`);
  }

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

function run(command: string, args: string[]): { stdout: string; stderr: string } {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return { stdout: result.stdout, stderr: result.stderr };
}
