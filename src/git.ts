import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
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
}

export function planPullWorktreePaths(input: PullWorktreeInput): PullWorktreePathPlan {
  assertWorkRootOutsideProtectedCheckout(input.workRoot, input.protectedCheckoutRoot);
  const safeRepo = input.repo.replace(/[^A-Za-z0-9_.-]+/g, "__");
  const mirrorPath = join(input.workRoot, "mirrors", `${safeRepo}.git`);
  const worktreePath = join(input.workRoot, "worktrees", `${safeRepo}__pr-${input.pullNumber}__${input.expectedHeadSha.slice(0, 12)}`);
  const repoUrl = `https://github.com/${input.repo}.git`;

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

  rmSync(worktreePath, { recursive: true, force: true });
  run("git", ["--git-dir", mirrorPath, "worktree", "prune"]);
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

function assertWorkRootOutsideProtectedCheckout(workRoot: string, protectedCheckoutRoot: string | undefined): void {
  assertPathOutsideProtectedRoot({
    path: workRoot,
    protectedRoot: protectedCheckoutRoot,
    pathLabel: "workRoot",
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
