import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const script = "scripts/validate-desktop-release-declaration.mjs", feed = "https://www.neondiff.com/updates/beta/appcast.xml", stableFeed = "https://www.neondiff.com/updates/stable/appcast.xml", bundle = "com.electricsheephq.NeonDiffDesktop";
type Item = { channel?: string; seq?: string; build?: string; feed?: string; predecessor?: string | null; bundle?: string };
function declarationPath(channel: string, seq: string) { return channel === "stable" ? "v1.1.0.json" : `v1.1.0-${channel}.${seq}.json`; }
function writeFixture(root: string, items: Item[]) {
  const directory = join(root, "declarations"), targets = join(root, "accepted-targets"); mkdirSync(directory, { recursive: true }); mkdirSync(targets); writeFileSync(join(targets, ".gitkeep"), "");
  const paths = items.map((item, index) => { const channel = item.channel ?? "beta", stable = channel === "stable", seq = stable ? null : item.seq ?? String(index + 1), build = item.build ?? String(index + 100), version = stable ? "1.1.0" : `1.1.0-${channel}.${seq}`, path = declarationPath(channel, seq ?? ""), previous = items[index - 1], predecessor = item.predecessor === undefined ? (index ? declarationPath(previous.channel ?? "beta", previous.seq ?? String(index)) : null) : item.predecessor; writeFileSync(join(directory, path), JSON.stringify({ schemaVersion: 1, product: "neondiff-desktop", version, tag: `v${version}`, channel, sequence: seq, build, predecessor, contract: stable ? "paid-mac-ga-byo-v1" : "paid-mac-beta-byo-v1", distribution: { bundleId: item.bundle ?? bundle, appPath: "NeonDiff.app", artifactName: `NeonDiff-${version}-build${build}-macOS.zip`, releaseClass: stable ? "desktop-only" : "paid-beta", origins: { github: "https://github.com/electricsheephq/evaos-code-review-bot-neondiff", site: "https://www.neondiff.com", feed: item.feed ?? (stable ? stableFeed : feed) } } })); return path; });
  if (!items.length) writeFileSync(join(directory, ".gitkeep"), "");
  const index = join(root, "index.json"); writeFileSync(index, JSON.stringify({ schemaVersion: 1, status: items.length ? "retained" : "empty", declarationDirectory: "declarations", declarationPaths: paths, currentPath: paths.at(-1) ?? null })); return { index, paths };
}
function run(items: Item[], alter: (root: string, paths: string[]) => void = () => {}) {
  const root = mkdtempSync(join(tmpdir(), "neondiff-declaration-")), fixture = writeFixture(root, items); alter(root, fixture.paths); const result = spawnSync(process.execPath, [script, "--index", fixture.index], { cwd: process.cwd(), encoding: "utf8" }); rmSync(root, { recursive: true, force: true }); return result;
}
function runInitial(items: Item[]) {
  const root = mkdtempSync(join(tmpdir(), "neondiff-declaration-initial-")), fixture = writeFixture(root, items), result = spawnSync(process.execPath, [script, "--index", fixture.index, "--initial"], { cwd: process.cwd(), encoding: "utf8" }); rmSync(root, { recursive: true, force: true }); return result;
}
function runTransition(baseItems: Item[], currentItems: Item[], alter: (root: string) => void = () => {}) {
  const root = mkdtempSync(join(tmpdir(), "neondiff-declaration-transition-")), base = writeFixture(join(root, "base"), baseItems), current = writeFixture(join(root, "current"), currentItems); alter(root); const result = spawnSync(process.execPath, [script, "--index", current.index, "--base-index", base.index], { cwd: process.cwd(), encoding: "utf8" }); rmSync(root, { recursive: true, force: true }); return result;
}

describe("versioned desktop declaration index", () => {
  it("accepts empty, beta, RC, stable, and upstream leading-zero builds", () => { expect(run([]).status).toBe(0); expect(run([{ build: "001" }]).status).toBe(0); expect(run([{ channel: "rc", seq: "1", build: "102" }]).status).toBe(0); expect(run([{ channel: "beta", build: "100" }, { channel: "rc", seq: "1", build: "101" }, { channel: "stable", build: "102" }]).status).toBe(0); });
  it("rejects identity, numeric-token, feed, ordering, and symlink drift", () => {
    for (const items of [[{ build: "100" }, { build: "100" }], [{ seq: "2", build: "100" }, { seq: "1", build: "101", predecessor: "v1.1.0-beta.2.json" }], [{ channel: "rc", seq: "1", build: "100" }, { channel: "beta", seq: "2", build: "101", predecessor: "v1.1.0-rc.1.json" }], [{ channel: "rc", seq: "9007199254740992" }], [{ bundle: "com.neondiff.desktop" }], [{ feed: "https://updates.neondiff.com/stable/appcast.xml" }]]) expect(run(items).status).not.toBe(0);
    expect(run([{ channel: "stable", feed }]).status).not.toBe(0);
    expect(run([{ channel: "stable", feed: stableFeed + "?mutable=true" }]).status).not.toBe(0);
    expect(run([{ channel: "stable" }], (root) => { const path = join(root, "declarations", "v1.1.0.json"), raw = readFileSync(path, "utf8").replace("\"sequence\":null", "\"sequence\":\"1\""); writeFileSync(path, raw); }).status).not.toBe(0);
    expect(run([{ channel: "stable" }], (root) => { const path = join(root, "declarations", "v1.1.0.json"), raw = readFileSync(path, "utf8").replace("\"contract\":\"paid-mac-ga-byo-v1\"", "\"contract\":\"paid-mac-beta-byo-v1\""); writeFileSync(path, raw); }).status).not.toBe(0);
    expect(run([{ channel: "stable", build: "100" }, { channel: "stable", build: "101" }]).status).not.toBe(0);
    expect(run([{ channel: "stable", build: "100" }, { channel: "rc", seq: "1", build: "101" }]).status).not.toBe(0);
    expect(run([{ build: "100" }], (root, paths) => { const renamed = "v1.1.0-beta.2.json"; renameSync(join(root, "declarations", paths[0]), join(root, "declarations", renamed)); const path = join(root, "index.json"), index = JSON.parse(readFileSync(path, "utf8")); index.declarationPaths = [renamed]; index.currentPath = renamed; writeFileSync(path, JSON.stringify(index)); }).status).not.toBe(0);
    expect(run([{ build: "100" }], (root) => { const path = join(root, "declarations", "v1.1.0-beta.1.json"), raw = readFileSync(path, "utf8").replace('"sequence":"1"', '"sequence":1.00000000000000001'); writeFileSync(path, raw); }).status).not.toBe(0);
    expect(run([{ build: "100" }], (root) => { const path = join(root, "declarations", "v1.1.0-beta.1.json"), raw = readFileSync(path, "utf8").replace('"build":"100"', '"build":"100","build":"101"'); writeFileSync(path, raw); }).status).not.toBe(0);
    expect(run([{ build: "100" }], (root) => { const path = join(root, "declarations", "v1.1.0-beta.1.json"), raw = readFileSync(path, "utf8").replace('"site":"https://www.neondiff.com"', '"site":"https://www.neondiff.com","site":"https://www.neondiff.com"'); writeFileSync(path, raw); }).status).not.toBe(0);
    expect(run([{ build: "100" }], (root, paths) => symlinkSync(join(root, "declarations", paths[0]), join(root, "declarations", "alias.json"))).status).not.toBe(0);
  });
  it("enforces initial and retained-history transitions", () => {
    const base = [{ build: "100" }], appended = [{ build: "100" }, { build: "101" }];
    expect(runInitial([]).status).toBe(0);
    expect(runInitial(base).status).not.toBe(0);
    expect(runTransition(base, appended).status).toBe(0);
    expect(runTransition(base, []).status).not.toBe(0);
    expect(runTransition(base, [{ build: "101" }]).status).not.toBe(0);
    expect(runTransition(base, base, (root) => { renameSync(join(root, "current", "declarations"), join(root, "current", "declarations-real")); symlinkSync(join(root, "current", "declarations-real"), join(root, "current", "declarations")); }).status).not.toBe(0);
  });
  it("fails closed when the accepted comparison index is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-declaration-missing-")), fixture = writeFixture(root, []), result = spawnSync(process.execPath, [script, "--index", fixture.index, "--base-index", join(root, "missing-index.json")], { cwd: process.cwd(), encoding: "utf8" }); rmSync(root, { recursive: true, force: true }); expect(result.status).not.toBe(0);
  });
});
