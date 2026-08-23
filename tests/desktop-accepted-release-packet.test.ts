import { describe, expect, it } from "vitest";
import { buildFeedEnclosureProof } from "../scripts/lib/desktop-feed-enclosure-proof.mjs";
import { buildAcceptedReleasePacket, serializeAcceptedReleasePacket, treeProofDigest } from "../scripts/lib/desktop-accepted-release-packet.mjs";

const source = "0123456789abcdef0123456789abcdef01234567", tagObject = "abcdef0123456789abcdef0123456789abcdef01";
const digest = "26e3f3b46951073f491eb4bce9ed29f37373a71f8660f09f1e5565dd36db03d5", publicKey = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";
const records = [["dir", "NeonDiff.app"], ["dir", "NeonDiff.app/Contents"], ["file", "NeonDiff.app/Contents/Info.plist", "-", 1, "c".repeat(64)]];
const url = "https://github.com/electricsheephq/evaos-code-review-bot-neondiff/releases/download/v1.1.0-beta.7/NeonDiff-1.1.0-beta.7-build42-macOS.zip";

function fixture() {
  const enclosure = buildFeedEnclosureProof({ url, version: "1.1.0-beta.7", build: "42", shortVersionString: "1.1.0-beta.7", channel: "beta", artifactName: "NeonDiff-1.1.0-beta.7-build42-macOS.zip", artifactSHA256: "26e3f3b46951073f491eb4bce9ed29f37373a71f8660f09f1e5565dd36db03d5", edSignature: "kdfWQEYJInL03AG3nHvaoXVLgg0tqI1z+VUWuR/kcaangjaZ4ZTrN1s3ISdTnOqPhqrvx9uEoqqZ8/iVhCc4Ag==" }, { acceptedPublicKey: Buffer.from(publicKey, "hex").toString("base64"), signedContent: Buffer.from("NeonDiff-1.1.0-beta.7-build42-macOS.zip") });
  const artifact = "NeonDiff-1.1.0-beta.7-build42-macOS.zip", tag = "v1.1.0-beta.7";
  return { identity: { releaseTag: tag, sourceSHA: source, tagObjectSHA: tagObject, version: "1.1.0-beta.7", channel: "beta", build: "42", artifactName: artifact, artifactSHA256: digest, artifactLength: 4242, artifactURL: url }, tagMetadata: { ref: `refs/tags/${tag}`, object: { type: "tag", sha: tagObject } }, annotatedTagMetadata: { sha: tagObject, tag, object: { type: "commit", sha: source } }, releaseMetadata: { tag_name: tag, draft: false, prerelease: true, immutable: true, assets: [{ name: artifact, digest: `sha256:${digest}`, size: 4242, browser_download_url: url }] }, enclosureProof: enclosure, treeProof: { schemaVersion: 1, kind: "neondiff.desktop.extracted-tree-proof-v1", verified: true, algorithm: "sha256-tree-v1", sourceSHA: source, artifactSHA256: digest, treeSHA256: treeProofDigest(records), records, bundleMarkers: { appPath: "NeonDiff.app", bundleID: "com.electricsheephq.NeonDiffDesktop", version: "1.1.0-beta.7", build: "42" } }, appleProof: { schemaVersion: 1, kind: "neondiff.desktop.apple-release-proof-v1", verified: true, teamID: "TC6MS3T6NN", codesignIdentity: "Developer ID Application: NeonDiff", notarizationIdentity: "accepted", stapleIdentity: "valid", gatekeeperIdentity: "accepted" }, feedEntry: { channel: "beta", version: "1.1.0-beta.7", build: "42", url, artifactName: artifact, artifactSHA256: digest, artifactLength: 4242, edSignature: enclosure.edSignature } };
}

describe("accepted Desktop release packet", () => {
  it("emits deterministic frozen public-safe bytes bound to validated proofs", () => {
    const value = fixture(), first = buildAcceptedReleasePacket(value), second = buildAcceptedReleasePacket({ ...value, identity: { ...value.identity } });
    expect(first).toEqual(second);
    expect(Object.isFrozen(first) && Object.isFrozen(first.artifact) && Object.isFrozen(first.feed)).toBe(true);
    expect(serializeAcceptedReleasePacket(first)).toBe(serializeAcceptedReleasePacket(second));
    expect(first.source.commitSHA).toBe(source);
    expect(first.tag.objectSHA).toBe(tagObject);
    expect(first.artifact).toMatchObject({ length: 4242, sha256: digest, url });
    expect(first.tree).toMatchObject({ sha256: treeProofDigest(records), algorithm: "sha256-tree-v1" });
    expect(JSON.stringify(first)).not.toMatch(/private|secret|token|password|keychain|\/Users\//i);
  });

  it.each(["sourceSHA", "tagObjectSHA", "artifactSHA256", "artifactLength", "treeSHA256", "teamID", "notarizationIdentity", "stapleIdentity", "gatekeeperIdentity"])("rejects %s substitution", (field) => {
    const value: any = fixture();
    if (field in value.identity) value.identity[field] = field.endsWith("SHA") ? "f".repeat(64) : field === "artifactLength" ? 1 : "other";
    else if (field === "treeSHA256") value.treeProof.treeSHA256 = "f".repeat(64);
    else value.appleProof[field] = "other";
    expect(() => buildAcceptedReleasePacket(value)).toThrow();
  });

  it("rejects malformed proofs, extra authority fields, and accessor substitution", () => {
    const extra: any = fixture(); extra.appleProof.privateKey = "never"; expect(() => buildAcceptedReleasePacket(extra)).toThrow();
    const falseProof: any = fixture(); falseProof.treeProof.verified = false; expect(() => buildAcceptedReleasePacket(falseProof)).toThrow();
    let reads = 0; const value: any = fixture(); value.identity = new Proxy(value.identity, { get(target, key, receiver) { if (key === "sourceSHA") { reads += 1; return reads === 1 ? source : "f".repeat(40); } return Reflect.get(target, key, receiver); } });
    expect(() => buildAcceptedReleasePacket(value)).not.toThrow(); expect(reads).toBe(1);
  });

  it("rejects tree evidence or source binding drift", () => {
    const evidence: any = fixture(); evidence.treeProof.records[2][4] = "d".repeat(64); expect(() => buildAcceptedReleasePacket(evidence)).toThrow();
    const sourceBinding: any = fixture(); sourceBinding.treeProof.sourceSHA = "f".repeat(40); expect(() => buildAcceptedReleasePacket(sourceBinding)).toThrow();
  });
});
