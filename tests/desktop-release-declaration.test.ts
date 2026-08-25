import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { parseAcceptedDesktopReleasePacket } from "../scripts/lib/desktop-accepted-release-packet.mjs";

const script = "scripts/validate-desktop-release-declaration.mjs", feed = "https://www.neondiff.com/updates/beta/appcast.xml", stableFeed = "https://www.neondiff.com/updates/stable/appcast.xml", bundle = "com.electricsheephq.NeonDiffDesktop";
type Item = { channel?: string; seq?: string; build?: string; feed?: string; predecessor?: string | null; bundle?: string };
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function declarationPath(channel: string, seq: string) { return channel === "stable" ? "v1.1.0.json" : `v1.1.0-${channel}.${seq}.json`; }
function packet(channel: "beta" | "rc", sequence: string, build: string, hex: string) {
  const version = `1.1.0-${channel}.${sequence}`, tag = `v${version}`, sourceSHA = hex.repeat(40), tagObjectSHA = channel === "beta" ? sourceSHA : "6".repeat(40), artifactName = `NeonDiff-${version}-build${build}-macOS.zip`, artifactURL = `https://github.com/electricsheephq/evaos-code-review-bot-neondiff/releases/download/${tag}/${artifactName}`;
  const value = { schemaVersion: 3, kind: "neondiff.desktop.accepted-release-packet-v3", verified: true, channel, version, build, tag, sourceSHA, artifactSourceSHA: sourceSHA, tagObjectSHA, artifactURL, artifactName, artifactByteLength: 123, artifactSHA256: (hex === "a" ? "b" : "2").repeat(64), treeSHA256: (hex === "a" ? "c" : "3").repeat(64), feedSHA256: (hex === "a" ? "d" : "4").repeat(64), feedEntry: { url: artifactURL, length: 123, type: "application/octet-stream", version, build, shortVersionString: version, minimumSystemVersion: "14.0", channel: "beta", edSignature: "AQ==" }, enclosureProofSHA256: (hex === "a" ? "e" : "5").repeat(64), releaseContract: "paid-mac-beta-byo-v1", productionContract: { contract: "paid-mac-beta-byo-v1", byoGitHubEnabled: true, managedGitHubBrokerEnabledPresent: false, githubBrokerOriginPresent: false }, npmReleaseClass: channel === "beta" ? "paid-beta" : "desktop-only" };
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`); parseAcceptedDesktopReleasePacket(bytes); return { bytes, digest: sha256(bytes), value };
}
function writeTargetHistory(root: string, alter: (receipt: any) => void = () => {}, alterBytes: (bytes: Buffer) => Buffer = (bytes) => bytes) {
  const directory = join(root, "accepted-targets"), current = packet("beta", "87", "11091", "a"), target = packet("rc", "1", "11100", "1"); rmSync(join(directory, ".gitkeep"));
  const currentPacketPath = join(directory, `${current.digest}.packet.json`), targetPacketPath = join(directory, `${target.digest}.packet.json`); writeFileSync(currentPacketPath, current.bytes); writeFileSync(targetPacketPath, target.bytes);
  const receipt = { schemaVersion: 1, kind: "neondiff.desktop.accepted-transition-target-v1", action: "update", acceptedTarget: { tag: target.value.tag, version: target.value.version, build: target.value.build, channel: target.value.channel, packetSHA256: target.digest, sourceSHA: target.value.sourceSHA, tagObjectSHA: target.value.tagObjectSHA, artifactSHA256: target.value.artifactSHA256, treeSHA256: target.value.treeSHA256, sparklePublicKeySHA256: "9".repeat(64), evidenceWorkflowSourceSHA: "8".repeat(40) }, current: { tag: current.value.tag, version: current.value.version, build: current.value.build, channel: current.value.channel, packetSHA256: current.digest, sourceSHA: current.value.sourceSHA, tagObjectSHA: current.value.tagObjectSHA, artifactSHA256: current.value.artifactSHA256, treeSHA256: current.value.treeSHA256 }, previouslyAcceptedTargetPacketSHA256: null }; alter(receipt);
  const bytes = alterBytes(Buffer.from(`${JSON.stringify(receipt)}\n`)), receiptPath = join(directory, `${sha256(bytes)}.target.json`); writeFileSync(receiptPath, bytes);
  return { currentPacketPath, targetPacketPath, receiptPath };
}
function writeFixture(root: string, items: Item[]) {
  const directory = join(root, "declarations"), targets = join(root, "accepted-targets"); mkdirSync(directory, { recursive: true }); mkdirSync(targets); writeFileSync(join(targets, ".gitkeep"), "");
  const paths = items.map((item, index) => { const channel = item.channel ?? "beta", stable = channel === "stable", seq = stable ? null : item.seq ?? String(index + 1), build = item.build ?? String(index + 100), version = stable ? "1.1.0" : `1.1.0-${channel}.${seq}`, path = declarationPath(channel, seq ?? ""), previous = items[index - 1], predecessor = item.predecessor === undefined ? (index ? declarationPath(previous.channel ?? "beta", previous.seq ?? String(index)) : null) : item.predecessor; writeFileSync(join(directory, path), JSON.stringify({ schemaVersion: 1, product: "neondiff-desktop", version, tag: `v${version}`, channel, sequence: seq, build, predecessor, contract: stable ? "paid-mac-ga-byo-v1" : "paid-mac-beta-byo-v1", distribution: { bundleId: item.bundle ?? bundle, appPath: "NeonDiff.app", artifactName: `NeonDiff-${version}-build${build}-macOS.zip`, releaseClass: stable ? "desktop-only" : "paid-beta", origins: { github: "https://github.com/electricsheephq/evaos-code-review-bot-neondiff", site: "https://www.neondiff.com", feed: item.feed ?? (stable ? stableFeed : feed) } } })); return path; });
  if (!items.length) writeFileSync(join(directory, ".gitkeep"), "");
  const index = join(root, "index.json"); writeFileSync(index, JSON.stringify({ schemaVersion: 1, status: items.length ? "retained" : "empty", declarationDirectory: "declarations", declarationPaths: paths, currentPath: paths.at(-1) ?? null })); return { index, paths };
}
function run(items: Item[], alter: (root: string, paths: string[]) => void = () => {}) {
  const root = mkdtempSync(join(tmpdir(), "neondiff-declaration-")), fixture = writeFixture(root, items); alter(root, fixture.paths); const result = spawnSync(process.execPath, [script, "--index", fixture.index], { cwd: process.cwd(), encoding: "utf8" }); rmSync(root, { recursive: true, force: true }); return result;
}
function runInitial(items: Item[], alter: (root: string) => void = () => {}) {
  const root = mkdtempSync(join(tmpdir(), "neondiff-declaration-initial-")), fixture = writeFixture(root, items); alter(root); const result = spawnSync(process.execPath, [script, "--index", fixture.index, "--initial"], { cwd: process.cwd(), encoding: "utf8" }); rmSync(root, { recursive: true, force: true }); return result;
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
  it("rejects a content-addressed receipt whose shared identity disagrees with its packet", () => {
    expect(run([{ build: "100" }], (root) => writeTargetHistory(root, (receipt) => { receipt.acceptedTarget.sourceSHA = "f".repeat(40); })).status).not.toBe(0);
  });
  it("accepts canonical target history, first append, and an unchanged retained prefix", () => {
    const items = [{ build: "100" }];
    expect(run(items, (root) => { writeTargetHistory(root); }).status).toBe(0);
    expect(runTransition(items, items, (root) => { writeTargetHistory(join(root, "current")); }).status).toBe(0);
    expect(runTransition(items, items, (root) => { writeTargetHistory(join(root, "base")); writeTargetHistory(join(root, "current")); }).status).toBe(0);
    expect(runTransition(items, items, (root) => { writeTargetHistory(join(root, "base")); const current = writeTargetHistory(join(root, "current")); rmSync(current.receiptPath); }).status).not.toBe(0);
  }, 30_000);
  it("rejects noncanonical, missing, unsafe, and unbounded target history", () => {
    const items = [{ build: "100" }];
    expect(run(items, (root) => writeTargetHistory(root, (receipt) => { receipt.acceptedTarget.build = 11100; })).status).not.toBe(0);
    expect(run(items, (root) => writeTargetHistory(root, (receipt) => { receipt.extra = true; })).status).not.toBe(0);
    expect(run(items, (root) => writeTargetHistory(root, () => {}, (bytes) => Buffer.from(bytes.toString("utf8").replace('"action":"update"', '"action":"update","action":"update"')))).status).not.toBe(0);
    expect(run(items, (root) => writeTargetHistory(root, () => {}, (bytes) => Buffer.concat([bytes, Buffer.from([0xff])]))).status).not.toBe(0);
    expect(run(items, (root) => { const value = writeTargetHistory(root); rmSync(value.targetPacketPath); }).status).not.toBe(0);
    expect(run(items, (root) => { const value = writeTargetHistory(root); renameSync(value.receiptPath, join(root, "accepted-targets", `${"0".repeat(64)}.target.json`)); }).status).not.toBe(0);
    expect(run(items, (root) => { const value = writeTargetHistory(root); symlinkSync(value.currentPacketPath, join(root, "accepted-targets", `${"7".repeat(64)}.packet.json`)); }).status).not.toBe(0);
    expect(run(items, (root) => { const directory = join(root, "accepted-targets"), bytes = Buffer.alloc(4 * 1024 * 1024 + 1, 0x61); rmSync(join(directory, ".gitkeep")); writeFileSync(join(directory, `${sha256(bytes)}.target.json`), bytes); }).status).not.toBe(0);
    expect(run(items, (root) => rmSync(join(root, "accepted-targets"), { recursive: true, force: true })).status).not.toBe(0);
    expect(runInitial([], (root) => { writeTargetHistory(root); }).status).not.toBe(0);
  }, 30_000);
});
