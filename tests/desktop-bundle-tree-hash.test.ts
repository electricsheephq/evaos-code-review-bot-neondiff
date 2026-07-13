import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "neondiff-bundle-hash-"));
  roots.push(root);
  const bundle = join(root, "NeonDiffDesktop.app");
  mkdirSync(join(bundle, "Contents", "MacOS"), { recursive: true });
  const executable = join(bundle, "Contents", "MacOS", "NeonDiffDesktop");
  writeFileSync(executable, "fixture executable");
  chmodSync(executable, 0o755);
  return { root, bundle, executable };
}

function hash(bundle: string) {
  return JSON.parse(execFileSync("node", ["scripts/hash-desktop-bundle-tree.mjs", bundle], { encoding: "utf8" }));
}

describe("desktop bundle tree hash", () => {
  it("is stable across timestamps and changes for bytes or executable mode", () => {
    const value = fixture();
    const first = hash(value.bundle);
    utimesSync(value.executable, new Date(1_000), new Date(2_000));
    expect(hash(value.bundle)).toEqual(first);

    writeFileSync(value.executable, "changed fixture executable");
    const changedBytes = hash(value.bundle);
    expect(changedBytes.sha256).not.toBe(first.sha256);

    chmodSync(value.executable, 0o644);
    expect(hash(value.bundle).sha256).not.toBe(changedBytes.sha256);
  });

  it("hashes in-bundle symlink topology and rejects escaping links", () => {
    const value = fixture();
    symlinkSync("NeonDiffDesktop", join(value.bundle, "Contents", "MacOS", "Current"));
    expect(hash(value.bundle)).toMatchObject({ algorithm: "sha256-tree-v1", entryCount: 4 });

    symlinkSync("../../../../outside", join(value.bundle, "Contents", "escape"));
    const result = spawnSync("node", ["scripts/hash-desktop-bundle-tree.mjs", value.bundle], { encoding: "utf8" });
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/symlink escapes bundle root/);
  });
});
