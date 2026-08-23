import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const script = "scripts/validate-desktop-release-declaration.mjs";
const feed = "https://www.neondiff.com/updates/beta/appcast.xml";
type Item = { channel?: string; seq?: number; build?: number; feed?: string; predecessor?: string | null };

function run(items: Item[], alter: (root: string, paths: string[]) => void = () => {}) {
  const root = mkdtempSync(join(tmpdir(), "neondiff-declaration-")), directory = join(root, "declarations");
  mkdirSync(directory);
  const paths = items.map((item, index) => {
    const channel = item.channel ?? "beta", seq = item.seq ?? index + 1, build = item.build ?? index + 100;
    const version = channel === "stable" ? "1.1.0" : `1.1.0-${channel}.${seq}`, path = `v${version}.json`;
    const predecessor = item.predecessor === undefined ? (index ? `v1.1.0-beta.${seq - 1}.json` : null) : item.predecessor;
    writeFileSync(join(directory, path), JSON.stringify({ schemaVersion: 1, product: "neondiff-desktop", version, tag: `v${version}`, channel, sequence: seq, build, predecessor, contract: "paid-mac-beta-byo-v1", distribution: { bundleId: "com.neondiff.desktop", appPath: "NeonDiff.app", artifactName: `NeonDiff-${version}-build${build}-macOS.zip`, releaseClass: "paid-beta", origins: { github: "https://github.com/electricsheephq/evaos-code-review-bot-neondiff", site: "https://www.neondiff.com", feed: item.feed ?? feed } } }));
    return path;
  });
  if (!items.length) writeFileSync(join(directory, ".gitkeep"), "");
  const index = join(root, "index.json");
  writeFileSync(index, JSON.stringify({ schemaVersion: 1, status: items.length ? "retained" : "empty", declarationDirectory: "declarations", declarationPaths: paths, currentPath: paths.at(-1) ?? null }));
  alter(root, paths);
  const result = spawnSync(process.execPath, [script, "--index", index], { cwd: process.cwd(), encoding: "utf8" });
  rmSync(root, { recursive: true, force: true });
  return result;
}

describe("versioned desktop declaration index", () => {
  it("accepts the tracked empty checkout and ordered compatible declarations", () => {
    expect(run([]).status).toBe(0);
    expect(run([{ build: 100 }, { build: 101 }]).status).toBe(0);
    expect(run([{ channel: "rc", seq: 1, build: 102 }]).status).toBe(0);
  });

  it("rejects duplicate or decreasing builds, predecessor mismatch, and current-path drift", () => {
    for (const items of [[{ build: 100 }, { build: 100 }], [{ build: 101 }, { build: 100 }], [{ build: 100 }, { build: 101, predecessor: "wrong.json" }]]) expect(run(items).status).not.toBe(0);
    expect(run([{ build: 100 }, { build: 101 }], (root) => { const path = join(root, "index.json"); const index = JSON.parse(readFileSync(path, "utf8")); index.currentPath = index.declarationPaths[0]; writeFileSync(path, JSON.stringify(index)); }).status).not.toBe(0);
    expect(run([{ seq: 2, build: 100 }, { seq: 1, build: 101, predecessor: "v1.1.0-beta.2.json" }]).status).not.toBe(0);
    expect(run([{ channel: "rc", seq: 1, build: 100 }, { channel: "beta", seq: 2, build: 101, predecessor: "v1.1.0-rc.1.json" }]).status).not.toBe(0);
  });

  it("rejects stable declarations and feed/channel drift", () => {
    expect(run([{ channel: "stable" }]).status).not.toBe(0);
    expect(run([{ feed: "https://updates.neondiff.com/stable/appcast.xml" }]).status).not.toBe(0);
    expect(run([{ channel: "rc", seq: 9007199254740992 }]).status).not.toBe(0);
  });

  it("binds the filename to the declaration tag", () => {
    expect(run([{ build: 100 }], (root, paths) => { const renamed = "v1.1.0-beta.2.json"; renameSync(join(root, "declarations", paths[0]), join(root, "declarations", renamed)); const path = join(root, "index.json"); const index = JSON.parse(readFileSync(path, "utf8")); index.declarationPaths = [renamed]; index.currentPath = renamed; writeFileSync(path, JSON.stringify(index)); }).status).not.toBe(0);
  });

  it("fails closed for unindexed symlink entries", () => {
    expect(run([{ build: 100 }], (root, paths) => symlinkSync(join(root, "declarations", paths[0]), join(root, "declarations", "alias.json"))).status).not.toBe(0);
  });
});
