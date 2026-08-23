import { describe, expect, it } from "vitest";
import {
  buildExtractedAppTreeProof,
  extractedAppTreeProofDigest,
  serializeExtractedAppTreeProof,
  treeProofDigest
} from "../scripts/lib/desktop-extracted-app-tree-proof.mjs";

const source = "0123456789abcdef0123456789abcdef01234567";
const artifact = "a".repeat(64);
const records = [
  ["dir", "NeonDiff.app"],
  ["dir", "NeonDiff.app/Contents"],
  ["file", "NeonDiff.app/Contents/Info.plist", "-", 3, "b".repeat(64)],
  ["dir", "NeonDiff.app/Contents/MacOS"],
  ["file", "NeonDiff.app/Contents/MacOS/NeonDiffDesktop", "x", 7, "c".repeat(64)]
];
const markers = { appPath: "NeonDiff.app", bundleID: "com.electricsheephq.NeonDiffDesktop", version: "1.1.0-beta.7", build: "42" };

function fixture() { return { sourceSHA: source, artifactSHA256: artifact, records: records.map((record) => [...record]), bundleMarkers: { ...markers } }; }

describe("authenticated extracted app-tree proof", () => {
  it("derives deterministic sha256-tree-v1 bytes and snapshots inputs", () => {
    const first = buildExtractedAppTreeProof(fixture());
    const second = buildExtractedAppTreeProof(fixture());
    expect(first).toEqual(second);
    expect(first.algorithm).toBe("sha256-tree-v1");
    expect(first.treeSHA256).toBe("962e947f4cc77ba95d402ae8f9a8762bd2ba7bb7588b63243115d8d8688e11ed");
    expect(first.treeSHA256).toBe(treeProofDigest(records));
    expect(serializeExtractedAppTreeProof(first)).toBe(serializeExtractedAppTreeProof(second));
    expect(extractedAppTreeProofDigest(first)).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(first) && Object.isFrozen(first.records[0]) && Object.isFrozen(first.bundleMarkers)).toBe(true);
    expect(serializeExtractedAppTreeProof(first)).not.toMatch(/\/Users\/|private|secret|token|password|keychain/i);
  });

  it.each([
    ["order", (value: any) => { value.records.reverse(); }],
    ["case duplicate", (value: any) => { value.records.splice(3, 0, ["file", "NeonDiff.app/Contents/info.plist", "-", 3, "b".repeat(64)]); }],
    ["mode", (value: any) => { value.records[2][2] = "rw"; }],
    ["size", (value: any) => { value.records[2][3] = -1; }],
    ["byte digest", (value: any) => { value.records[2][4] = "not-a-sha"; }],
    ["non-primitive byte digest", (value: any) => { value.records[2][4] = ["b".repeat(64)]; }],
    ["escaping symlink", (value: any) => { value.records.splice(2, 0, ["link", "NeonDiff.app/Contents/Current", "../../../../outside"]); }],
    ["symlink outside app root", (value: any) => { value.records.push(["link", "NeonDiff.app/escape", "../outside"]); }],
    ["bundle marker", (value: any) => { value.bundleMarkers.bundleID = "other.bundle"; }],
    ["source binding", (value: any) => { value.sourceSHA = "not-a-source-sha"; }],
    ["artifact binding", (value: any) => { value.artifactSHA256 = "not-an-artifact-sha"; }]
  ])("rejects hostile %s input", (_label, mutate) => {
    const value = fixture(); mutate(value);
    expect(() => buildExtractedAppTreeProof(value)).toThrow();
  });

  it("rejects forged, spread, JSON, and proxy proofs at serialization", () => {
    const proof = buildExtractedAppTreeProof(fixture());
    expect(() => serializeExtractedAppTreeProof({ ...proof })).toThrow();
    expect(() => serializeExtractedAppTreeProof(JSON.parse(JSON.stringify(proof)))).toThrow();
    expect(() => serializeExtractedAppTreeProof(new Proxy(proof, {}))).toThrow();
  });

  it("reads source binding once before a hostile accessor can substitute it", () => {
    let reads = 0;
    const value = new Proxy(fixture(), { get(target, key, receiver) {
      if (key === "sourceSHA") { reads += 1; return reads === 1 ? source : "f".repeat(40); }
      return Reflect.get(target, key, receiver);
    } });
    const proof = buildExtractedAppTreeProof(value);
    expect(reads).toBe(1);
    expect(proof.sourceSHA).toBe(source);
  });
});
