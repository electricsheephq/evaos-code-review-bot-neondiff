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
const markers = { appPath: "NeonDiff.app", bundleID: "com.electricsheephq.NeonDiffDesktop", version: "1.1.0", build: "42" };
function fixture() { return { sourceSHA: source, artifactSHA256: artifact, records: records.map((record) => [...record]), bundleMarkers: { ...markers } }; }

describe("authenticated extracted app-tree proof", () => {
  it.each(["1.1.0", "1.1.0-beta.7", "1.1.0-rc.12"])("accepts supported version %s", (version) => {
    const value = fixture(); value.bundleMarkers.version = version;
    const proof = buildExtractedAppTreeProof(value);
    expect(proof.treeSHA256).toBe("962e947f4cc77ba95d402ae8f9a8762bd2ba7bb7588b63243115d8d8688e11ed");
    expect(proof.treeSHA256).toBe(treeProofDigest(records));
    expect(serializeExtractedAppTreeProof(proof)).toContain("\"algorithm\":\"sha256-tree-v1\"");
    expect(extractedAppTreeProofDigest(proof)).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(proof) && Object.isFrozen(proof.records[0]) && Object.isFrozen(proof.bundleMarkers)).toBe(true);
  });

  it.each([
    ["order", (value: any) => value.records.reverse()],
    ["case-fold collision", (value: any) => { value.records.splice(3, 0, ["dir", "NeonDiff.app/Contents/STRASSE"]); value.records.splice(3, 0, ["dir", "NeonDiff.app/Contents/Straße"]); }],
    ["NFD path", (value: any) => value.records.splice(3, 0, ["dir", "NeonDiff.app/Contents/e\u0301"])],
    ["mode", (value: any) => value.records[2][2] = "rw"],
    ["size", (value: any) => value.records[2][3] = -1],
    ["non-primitive digest", (value: any) => value.records[2][4] = ["b".repeat(64)]],
    ["digest", (value: any) => value.records[2][4] = "not-a-sha"],
    ["escaping symlink", (value: any) => value.records.splice(2, 0, ["link", "NeonDiff.app/Contents/Current", "../../../../outside"])],
    ["stable shape", (value: any) => value.bundleMarkers.version = "1.1.1"],
    ["source binding", (value: any) => value.sourceSHA = "not-a-source-sha"],
    ["artifact binding", (value: any) => value.artifactSHA256 = "not-an-artifact-sha"]
  ])("rejects hostile %s input", (_label, mutate) => {
    const value = fixture();
    mutate(value);
    expect(() => buildExtractedAppTreeProof(value)).toThrow();
  });

  it("rejects forged, spread, JSON, and proxy proofs", () => {
    const proof = buildExtractedAppTreeProof(fixture());
    expect(() => serializeExtractedAppTreeProof({ ...proof })).toThrow();
    expect(() => serializeExtractedAppTreeProof(JSON.parse(JSON.stringify(proof)))).toThrow();
    expect(() => serializeExtractedAppTreeProof(new Proxy(proof, {}))).toThrow();
  });

  it("snapshots an accessor once before serialization", () => {
    let reads = 0;
    const value = new Proxy(fixture(), { get(target, key, receiver) {
      if (key === "sourceSHA") { reads += 1; return reads === 1 ? source : "f".repeat(40); }
      return Reflect.get(target, key, receiver);
    } });
    expect(buildExtractedAppTreeProof(value).sourceSHA).toBe(source);
    expect(reads).toBe(1);
  });
});
