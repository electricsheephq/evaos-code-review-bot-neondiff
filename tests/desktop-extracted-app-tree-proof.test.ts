import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildExtractedAppTreeProof, extractedAppTreeProofDigest, serializeExtractedAppTreeProof, treeProofDigest } from "../scripts/lib/desktop-extracted-app-tree-proof.mjs";

const source = "0123456789abcdef0123456789abcdef01234567";
const roots: string[] = [];
function fixture(build = "42", duplicate = false) {
  const root = mkdtempSync(join(tmpdir(), "neondiff-tree-proof-test-")); roots.push(root);
  const app = join(root, "NeonDiff.app"); mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
  writeFileSync(join(app, "Contents", "Info.plist"), `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.electricsheephq.NeonDiffDesktop</string><key>CFBundleShortVersionString</key><string>1.1.0-rc.9</string><key>CFBundleVersion</key><string>${build}</string>${duplicate ? "<key>CFBundleVersion</key><string>1</string>" : ""}</dict></plist>`);
  writeFileSync(join(app, "Contents", "MacOS", "NeonDiffDesktop"), "desktop"); chmodSync(join(app, "Contents", "MacOS", "NeonDiffDesktop"), 0o755);
  symlinkSync("MacOS/NeonDiffDesktop", join(app, "Contents", "Current"));
  const artifact = join(root, "NeonDiff.zip"); execFileSync("zip", ["-qry", artifact, "NeonDiff.app"], { cwd: root }); return { root, artifact };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("artifact-bound extracted app tree proof", () => {
  it("hashes one exact artifact and derives its tree and Info.plist markers", () => {
    const value = fixture("987654321098765432109876543210");
    const proof = buildExtractedAppTreeProof({ artifactPath: value.artifact, sourceSHA: source });
    const second = buildExtractedAppTreeProof({ artifactPath: value.artifact, sourceSHA: source });
    expect(proof.artifactSHA256).toBe(createHash("sha256").update(readFileSync(value.artifact)).digest("hex"));
    expect(proof.bundleMarkers).toEqual({ appPath: "NeonDiff.app", bundleID: "com.electricsheephq.NeonDiffDesktop", version: "1.1.0-rc.9", build: "987654321098765432109876543210" });
    expect(proof.records.map((record: unknown[]) => record.slice(0, 2))).toEqual([
      ["dir", "Contents"], ["link", "Contents/Current"], ["file", "Contents/Info.plist"],
      ["dir", "Contents/MacOS"], ["file", "Contents/MacOS/NeonDiffDesktop"]
    ]);
    expect(proof.records.filter((record: unknown[]) => record[0] === "file").map((record: unknown[]) => record[2])).toEqual(["-", "x"]);
    expect(proof.treeSHA256).toBe(treeProofDigest(proof.records));
    expect(serializeExtractedAppTreeProof(proof)).toBe(serializeExtractedAppTreeProof(second));
    expect(serializeExtractedAppTreeProof(proof)).toMatch(/\n$/);
    expect(extractedAppTreeProofDigest(proof)).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(proof) && Object.isFrozen(proof.records) && Object.isFrozen(proof.records[0]) && Object.isFrozen(proof.bundleMarkers)).toBe(true);
    let reads = 0; const input = new Proxy({ artifactPath: value.artifact, sourceSHA: source }, { get(target, key, receiver) { if (key === "sourceSHA") { reads += 1; return reads === 1 ? source : "f".repeat(40); } return Reflect.get(target, key, receiver); } });
    expect(buildExtractedAppTreeProof(input).sourceSHA).toBe(source); expect(reads).toBe(1);
  });
  it("rejects caller-authored authority and hostile archive topology", () => {
    const value = fixture();
    expect(() => buildExtractedAppTreeProof({ artifactPath: value.artifact, sourceSHA: source, artifactSHA256: "a".repeat(64) } as any)).toThrow();
    const escaped = join(value.root, "escaped.zip");
    execFileSync("/usr/bin/python3", ["-c", "import sys,zipfile; z=zipfile.ZipFile(sys.argv[1],'w'); z.writestr('../outside',b'outside'); z.close()", escaped]);
    expect(() => buildExtractedAppTreeProof({ artifactPath: escaped, sourceSHA: source })).toThrow();
    const duplicate = fixture("42", true);
    expect(() => buildExtractedAppTreeProof({ artifactPath: duplicate.artifact, sourceSHA: source })).toThrow();
  });
  it("bounds archive acquisition before extraction and ignores PATH extractors", () => {
    const value = fixture(), oversized = join(value.root, "oversized.zip"); writeFileSync(oversized, ""); truncateSync(oversized, 512 * 1024 * 1024 + 1);
    expect(() => buildExtractedAppTreeProof({ artifactPath: oversized, sourceSHA: source })).toThrow(/artifact bytes exceed bound/);
    const shadow = mkdtempSync(join(tmpdir(), "neondiff-tree-proof-shadow-")); roots.push(shadow);
    writeFileSync(join(shadow, "unzip"), "#!/bin/sh\nexit 99\n"); chmodSync(join(shadow, "unzip"), 0o755);
    const previous = process.env.PATH; process.env.PATH = `${shadow}:${previous ?? ""}`;
    try { expect(buildExtractedAppTreeProof({ artifactPath: value.artifact, sourceSHA: source }).verified).toBe(true); } finally { process.env.PATH = previous; }
  });
  it("rejects forged serialization and hostile direct records", () => {
    const value = fixture(); const proof = buildExtractedAppTreeProof({ artifactPath: value.artifact, sourceSHA: source });
    expect(() => serializeExtractedAppTreeProof({ ...proof } as any)).toThrow();
    expect(() => serializeExtractedAppTreeProof(new Proxy(proof, {}) as any)).toThrow();
    const records: any[] = [["dir", "Contents"], ["file", "Contents/a", "-", 1, "a".repeat(64)]];
    Object.defineProperty(records, "map", { value: () => [["dir", "NeonDiff.app"]] });
    expect(treeProofDigest(records)).toMatch(/^[a-f0-9]{64}$/);
    expect(() => treeProofDigest([["dir", "Contents"], ["file", "Contents/a/b", "-", 1, "a".repeat(64)]])).toThrow();
    expect(() => treeProofDigest([["dir", "Contents"], ["file", "Contents/\ud800", "-", 1, "a".repeat(64)]])).toThrow();
    expect(() => treeProofDigest([["dir", "Contents"], ["file", "Contents/В", "-", 1, "a".repeat(64)], ["file", "Contents/ᲀ", "-", 1, "b".repeat(64)]])).toThrow();
  });
});
