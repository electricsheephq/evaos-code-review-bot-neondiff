import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";

const MIN_RETENTION_MS = 2 * 60 * 60_000;
const SUBPROCESS_TIMEOUT_MS = 30_000;

export type ReviewWorktreeCleanupReason =
  | "stale_clean_owned"
  | "recent"
  | "dirty"
  | "symlink"
  | "non_directory"
  | "path_escape"
  | "active_head"
  | "active_review_run"
  | "open_or_in_use"
  | "unexpected_head"
  | "not_registered_to_expected_mirror"
  | "mirror_missing_or_invalid"
  | "git_probe_failed"
  | "git_remove_refused"
  | "dry_run";

export interface ReviewWorktreeCleanupOutcome {
  path: string;
  status: "deleted" | "skipped" | "error";
  reason: ReviewWorktreeCleanupReason;
  error?: string;
}

export interface ReviewWorktreeCleanupSummary {
  worktreesRoot: string;
  retentionMs: number;
  checked: number;
  deleted: number;
  skipped: number;
  errors: number;
  outcomes: ReviewWorktreeCleanupOutcome[];
}

export interface ActiveReviewHead {
  repo: string;
  pullNumber: number;
  headSha: string;
}

export interface GitCommandResult {
  ok: boolean;
  stdout?: string;
  error?: string;
  reason?: "active_review_run";
}

export interface ReviewWorktreeCleanupOps {
  runGit?: (args: string[]) => GitCommandResult;
  removeWorktree?: (mirrorPath: string, worktreePath: string) => GitCommandResult;
}

export interface CleanupStaleReviewWorktreesInput {
  workRoot: string;
  retentionMs: number;
  leaseTtlMs: number;
  activeReviewRun: boolean;
  activeReviewHeads: ActiveReviewHead[];
  openWorktreePaths: ReadonlySet<string>;
  now?: Date;
  dryRun?: boolean;
  ops?: ReviewWorktreeCleanupOps;
}

export interface OpenReviewWorktreeProbe {
  ok: boolean;
  paths: Set<string>;
  error?: string;
}

export interface OpenReviewWorktreeProbeOptions {
  runLsof?: () => {
    status: number | null;
    stdout: string;
    stderr?: string;
    error?: Error;
  };
}

export function cleanupStaleReviewWorktrees(input: CleanupStaleReviewWorktreesInput): ReviewWorktreeCleanupSummary {
  const safetyFloor = Math.max(MIN_RETENTION_MS, input.leaseTtlMs);
  if (!Number.isInteger(input.retentionMs) || input.retentionMs < safetyFloor) {
    throw new Error(`worktree cleanup retentionMs must be at least ${safetyFloor}`);
  }

  const worktreesRoot = resolve(input.workRoot, "worktrees");
  const outcomes: ReviewWorktreeCleanupOutcome[] = [];
  const nowMs = (input.now ?? new Date()).getTime();
  const runGit = input.ops?.runGit ?? defaultRunGit;
  const removeWorktree = input.ops?.removeWorktree ?? ((mirrorPath, worktreePath) =>
    runGit(["--git-dir", mirrorPath, "worktree", "remove", worktreePath]));

  let rootRealPath: string;
  try {
    const rootStat = lstatSync(worktreesRoot);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      throw new Error(`review worktrees root is not a real directory: ${worktreesRoot}`);
    }
    rootRealPath = realpathSync(worktreesRoot);
  } catch (error) {
    if (isMissingPathError(error)) return summarize(worktreesRoot, input.retentionMs, outcomes);
    throw error;
  }

  const activeNames = new Set(input.activeReviewHeads.map(reviewHeadWorktreeName));
  const openPaths = new Set(
    [...input.openWorktreePaths].flatMap((path) => [...comparablePathVariants(path)])
  );
  const entries = readdirSync(worktreesRoot, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    const ownedName = parseOwnedWorktreeName(entry.name);
    if (!ownedName) continue;
    const path = join(worktreesRoot, entry.name);
    if (entry.isSymbolicLink()) {
      outcomes.push({ path, status: "skipped", reason: "symlink" });
      continue;
    }
    if (!entry.isDirectory()) {
      outcomes.push({ path, status: "skipped", reason: "non_directory" });
      continue;
    }

    let stat;
    let realPath: string;
    try {
      stat = lstatSync(path);
      realPath = realpathSync(path);
      if (stat.isSymbolicLink() || dirname(realPath) !== rootRealPath) {
        outcomes.push({ path, status: "skipped", reason: stat.isSymbolicLink() ? "symlink" : "path_escape" });
        continue;
      }
    } catch (error) {
      outcomes.push({ path, status: "error", reason: "git_probe_failed", error: errorMessage(error) });
      continue;
    }

    if (nowMs - stat.mtimeMs <= input.retentionMs) {
      outcomes.push({ path, status: "skipped", reason: "recent" });
      continue;
    }
    if (input.activeReviewRun) {
      outcomes.push({ path, status: "skipped", reason: "active_review_run" });
      continue;
    }
    if (activeNames.has(entry.name)) {
      outcomes.push({ path, status: "skipped", reason: "active_head" });
      continue;
    }
    if (openPaths.has(resolve(path)) || openPaths.has(realPath)) {
      outcomes.push({ path, status: "skipped", reason: "open_or_in_use" });
      continue;
    }

    const mirrorPath = join(input.workRoot, "mirrors", `${ownedName.safeRepo}.git`);
    if (!isValidMirror(mirrorPath, runGit)) {
      outcomes.push({ path, status: "skipped", reason: "mirror_missing_or_invalid" });
      continue;
    }
    const ownership = isRegisteredToExpectedMirror({ path, mirrorPath, runGit });
    if (!ownership.ok) {
      outcomes.push({
        path,
        status: ownership.error ? "error" : "skipped",
        reason: ownership.error ? "git_probe_failed" : "not_registered_to_expected_mirror",
        ...(ownership.error ? { error: ownership.error } : {})
      });
      continue;
    }
    const status = runGit([
      "-C",
      path,
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
      "--ignored=matching"
    ]);
    if (!status.ok) {
      outcomes.push({ path, status: "error", reason: "git_probe_failed", error: status.error });
      continue;
    }
    if (status.stdout?.trim()) {
      outcomes.push({ path, status: "skipped", reason: "dirty" });
      continue;
    }
    const head = runGit(["-C", path, "rev-parse", "HEAD"]);
    if (!head.ok || !head.stdout?.trim()) {
      outcomes.push({ path, status: "error", reason: "git_probe_failed", error: head.error ?? "git head probe failed" });
      continue;
    }
    if (head.stdout.trim().slice(0, 12).toLowerCase() !== ownedName.headSha.toLowerCase()) {
      outcomes.push({ path, status: "skipped", reason: "unexpected_head" });
      continue;
    }
    if (input.dryRun) {
      outcomes.push({ path, status: "skipped", reason: "dry_run" });
      continue;
    }

    const removed = removeWorktree(mirrorPath, path);
    if (!removed.ok) {
      if (removed.reason === "active_review_run") {
        outcomes.push({ path, status: "skipped", reason: "active_review_run" });
      } else {
        outcomes.push({ path, status: "error", reason: "git_remove_refused", error: removed.error });
      }
      continue;
    }
    outcomes.push({ path, status: "deleted", reason: "stale_clean_owned" });
  }

  return summarize(worktreesRoot, input.retentionMs, outcomes);
}

function parseOwnedWorktreeName(name: string): { safeRepo: string; headSha: string } | undefined {
  const pullSeparator = name.lastIndexOf("__pr-");
  if (pullSeparator <= 0) return undefined;
  const safeRepo = name.slice(0, pullSeparator);
  const pullAndHead = name.slice(pullSeparator + "__pr-".length);
  const headSeparator = pullAndHead.indexOf("__");
  if (headSeparator <= 0 || pullAndHead.indexOf("__", headSeparator + 2) !== -1) return undefined;
  const pullNumber = pullAndHead.slice(0, headSeparator);
  const headSha = pullAndHead.slice(headSeparator + 2);
  if (!/^[A-Za-z0-9_.-]+$/.test(safeRepo)) return undefined;
  if (!/^[1-9][0-9]*$/.test(pullNumber)) return undefined;
  if (!/^[0-9a-fA-F]{12}$/.test(headSha)) return undefined;
  return { safeRepo, headSha };
}

export function probeOpenReviewWorktreePaths(
  workRoot: string,
  options: OpenReviewWorktreeProbeOptions = {}
): OpenReviewWorktreeProbe {
  const worktreesRoot = resolve(workRoot, "worktrees");
  const worktreesRootVariants = comparablePathVariants(worktreesRoot);
  const runLsof = options.runLsof ?? (() => spawnSync("lsof", ["-Fn"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: SUBPROCESS_TIMEOUT_MS,
    killSignal: "SIGKILL"
  }));
  const result = runLsof();
  if (result.status !== 0) {
    return {
      ok: false,
      paths: new Set(),
      error: result.error instanceof Error ? result.error.message : (result.stderr || "lsof failed").trim()
    };
  }

  const paths = new Set<string>();
  for (const line of result.stdout.split(/\r?\n/)) {
    if (!line.startsWith("n")) continue;
    const openPath = line.slice(1).replace(/ \(deleted\)$/, "");
    if (!isAbsolute(openPath)) continue;
    const child = directChildForPath(worktreesRootVariants, openPath);
    if (child) paths.add(child);
  }
  return { ok: true, paths };
}

export function removeRegisteredReviewWorktree(mirrorPath: string, worktreePath: string): GitCommandResult {
  return defaultRunGit(["--git-dir", mirrorPath, "worktree", "remove", worktreePath]);
}

function reviewHeadWorktreeName(head: ActiveReviewHead): string {
  const safeRepo = head.repo.replace(/[^A-Za-z0-9_.-]+/g, "__");
  return `${safeRepo}__pr-${head.pullNumber}__${head.headSha.slice(0, 12)}`;
}

function isValidMirror(mirrorPath: string, runGit: (args: string[]) => GitCommandResult): boolean {
  try {
    const stat = lstatSync(mirrorPath);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
  } catch {
    return false;
  }
  const result = runGit(["--git-dir", mirrorPath, "rev-parse", "--is-bare-repository"]);
  return result.ok && result.stdout?.trim() === "true";
}

function isRegisteredToExpectedMirror(input: {
  path: string;
  mirrorPath: string;
  runGit: (args: string[]) => GitCommandResult;
}): { ok: boolean; error?: string } {
  const commonDir = input.runGit(["-C", input.path, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!commonDir.ok || !commonDir.stdout?.trim()) return { ok: false, error: commonDir.error ?? "git common-dir probe failed" };
  try {
    if (realpathSync(commonDir.stdout.trim()) !== realpathSync(input.mirrorPath)) return { ok: false };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }

  const listed = input.runGit(["--git-dir", input.mirrorPath, "worktree", "list", "--porcelain"]);
  if (!listed.ok) return { ok: false, error: listed.error ?? "git worktree list failed" };
  let expected: string;
  try {
    expected = realpathSync(input.path);
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
  return {
    ok: listed.stdout?.split(/\r?\n/).some((line) => {
      if (!line.startsWith("worktree ")) return false;
      try {
        return realpathSync(line.slice(9).trim()) === expected;
      } catch {
        return false;
      }
    }) === true
  };
}

function directChildForPath(roots: ReadonlySet<string>, path: string): string | undefined {
  for (const comparableRoot of roots) {
    for (const comparablePath of comparablePathVariants(path)) {
      const childRelative = relative(comparableRoot, comparablePath);
      if (!childRelative
        || childRelative === ".."
        || childRelative.startsWith(`..${sep}`)
        || isAbsolute(childRelative)) continue;
      const firstSegment = childRelative.split(sep)[0];
      if (firstSegment) return join(comparableRoot, firstSegment);
    }
  }
  return undefined;
}

function comparablePathVariants(path: string): Set<string> {
  const variants = new Set([resolve(path)]);
  try {
    variants.add(realpathSync(path));
  } catch {
    // lsof can report a path whose leaf was deleted after the handle opened.
  }
  return variants;
}

function defaultRunGit(args: string[]): GitCommandResult {
  const result = spawnSync("git", args, {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    timeout: SUBPROCESS_TIMEOUT_MS,
    killSignal: "SIGKILL",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }
  });
  if (result.status !== 0) {
    return {
      ok: false,
      error: result.error instanceof Error ? result.error.message : (result.stderr || result.stdout || "git failed").trim()
    };
  }
  return { ok: true, stdout: result.stdout };
}

function summarize(
  worktreesRoot: string,
  retentionMs: number,
  outcomes: ReviewWorktreeCleanupOutcome[]
): ReviewWorktreeCleanupSummary {
  return {
    worktreesRoot,
    retentionMs,
    checked: outcomes.length,
    deleted: outcomes.filter((outcome) => outcome.status === "deleted").length,
    skipped: outcomes.filter((outcome) => outcome.status === "skipped").length,
    errors: outcomes.filter((outcome) => outcome.status === "error").length,
    outcomes
  };
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
