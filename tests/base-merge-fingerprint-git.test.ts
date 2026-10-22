import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { computeOwnDiffFingerprint } from "../src/git.js";

const roots: string[] = [];
const hasGit = spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "neondiff-fingerprint-git-"));
  roots.push(root);
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"]
  }).trim();
  git("init", "-b", "main");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.test");
  git("config", "commit.gpgSign", "false");
  const write = (name: string, content: string) => writeFileSync(join(root, name), content);
  const commit = () => {
    git("add", "--ignore-removal", "."); git("commit", "-m", "fixture"); return git("rev-parse", "HEAD");
  };
  const fingerprint = async (base: string, head: string) => {
    const result = await computeOwnDiffFingerprint(root, base, head);
    expect(result).toHaveProperty("fingerprint", expect.stringMatching(/^git-patch-id-verbatim-v1:[a-f0-9]{40}$/));
    if ("error" in result) throw new Error(result.error);
    return result.fingerprint;
  };
  return { root, git, write, commit, fingerprint };
}

function hostConfig(key: string, value: string) {
  vi.stubEnv("GIT_CONFIG_COUNT", "1");
  vi.stubEnv("GIT_CONFIG_KEY_0", key);
  vi.stubEnv("GIT_CONFIG_VALUE_0", value);
}

describe.skipIf(!hasGit)("real-git own-diff fingerprints", () => {
  it("keeps a pure base merge identical", async () => {
    const f = fixture(); f.write("review.txt", "before\n"); const base = f.commit();
    f.git("checkout", "-b", "pr"); f.write("review.txt", "after\n"); const h1 = f.commit();
    f.git("checkout", "main"); f.write("base.txt", "base advance\n"); const nextBase = f.commit();
    f.git("checkout", "pr"); f.git("merge", "--no-edit", "main");
    const h2 = f.git("rev-parse", "HEAD");
    expect(await f.fingerprint(nextBase, h2)).toBe(await f.fingerprint(base, h1));
  });

  it("keeps the fingerprint when the base advances again without a new head", async () => {
    const f = fixture(); f.write("review.txt", "before\n"); f.commit();
    f.git("checkout", "-b", "pr"); f.write("review.txt", "after\n"); f.commit();
    f.git("checkout", "main"); f.write("base.txt", "base advance\n"); const mergedBase = f.commit();
    f.git("checkout", "pr"); f.git("merge", "--no-edit", "main");
    const head = f.git("rev-parse", "HEAD");
    f.git("checkout", "main"); f.write("later.txt", "later base advance\n"); const laterBase = f.commit();
    // A skip computed against a base snapshot that moved on since is the decision the newer base gives.
    expect(await f.fingerprint(laterBase, head)).toBe(await f.fingerprint(mergedBase, head));
  });

  it.each(["log", "diff", "ignore_all"])("detects a last-sorting gitlink bump under %s", async (kind) => {
    const f = fixture(); f.write("review.txt", "before\n"); const sub1 = f.commit();
    f.write("review.txt", "base\n"); const sub2 = f.commit();
    f.write(".gitmodules", '[submodule "z-sub"]\n\tpath = z-sub\n\turl = ./fixture\n\tignore = all\n');
    f.git("update-index", "--add", "--cacheinfo", `160000,${sub1},z-sub`);
    const base = f.commit(); f.git("checkout", "-b", "pr");
    f.write("review.txt", "changed\n"); const h1 = f.commit();
    f.git("update-index", "--cacheinfo", `160000,${sub2},z-sub`); const h2 = f.commit();
    if (kind !== "ignore_all") hostConfig("diff.submodule", kind);
    expect(await f.fingerprint(base, h2)).not.toBe(await f.fingerprint(base, h1));
  });

  it("pins blank context output and detects a later-file change", async () => {
    const f = fixture();
    // Two hunks with blank context make unpinned patch-id split at the next file.
    const original = "before\n\na\nb\nc\nd\ne\n\nbefore\n";
    f.write("a.txt", original); f.write("z.txt", original); const base = f.commit();
    f.write("a.txt", original.replaceAll("before", "after")); const h1 = f.commit();
    f.write("z.txt", original.replaceAll("before", "after")); const h2 = f.commit();
    hostConfig("diff.suppressBlankEmpty", "true");
    expect(await f.fingerprint(base, h2)).not.toBe(await f.fingerprint(base, h1));
  });

  it.each(["env_short", "env_long", "config"])("detects a moved edit despite zero-context %s", async (kind) => {
    const f = fixture();
    const original = "first context\ntarget\nfirst tail\nseparator\nsecond context\ntarget\nsecond tail\n";
    f.write("review.txt", original); const base = f.commit();
    f.write("review.txt", original.replace("target", "changed")); const h1 = f.commit();
    f.write("review.txt", original.replace("second context\ntarget", "second context\nchanged")); const h2 = f.commit();
    // Git versions that ignore the short env spelling still see the hostile host context.
    hostConfig("diff.context", "0");
    if (kind.startsWith("env")) vi.stubEnv("GIT_DIFF_OPTS", kind === "env_short" ? "-U0" : "--unified=0");
    expect(await f.fingerprint(base, h2)).not.toBe(await f.fingerprint(base, h1));
  });
});
