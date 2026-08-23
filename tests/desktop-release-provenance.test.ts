import { describe, expect, it } from "vitest";
import { validateReleaseDeclaration } from "../scripts/validate-desktop-release-declaration.mjs";
import { acceptedReleaseProvenanceDigest, buildAcceptedReleaseProvenance, serializeAcceptedReleaseProvenance } from "../scripts/lib/desktop-release-provenance.mjs";

const source = "0123456789abcdef0123456789abcdef01234567";
const tagObject = "abcdef0123456789abcdef0123456789abcdef01";
const artifactSHA256 = "a".repeat(64);
const artifactURL = "https://github.com/electricsheephq/evaos-code-review-bot-neondiff/releases/download/v1.1.0-beta.7/NeonDiff-1.1.0-beta.7-build42-macOS.zip";

function fixture() {
  const version = "1.1.0-beta.7", tag = `v${version}`, build = "42", feed = "https://www.neondiff.com/updates/beta/appcast.xml";
  const declaration = { schemaVersion: 1, product: "neondiff-desktop", contract: "paid-mac-beta-byo-v1", version, tag, channel: "beta", sequence: "7", build, predecessor: null, distribution: { bundleId: "com.electricsheephq.NeonDiffDesktop", appPath: "NeonDiff.app", artifactName: `NeonDiff-${version}-build${build}-macOS.zip`, releaseClass: "paid-beta", origins: { github: "https://github.com/electricsheephq/evaos-code-review-bot-neondiff", site: "https://www.neondiff.com", feed } } };
  const declarationValidation = validateReleaseDeclaration(declaration);
  const identityProof = { schemaVersion: 1, kind: "neondiff.desktop.release-identity-validation-v2", verified: true, releaseTag: tag, sourceCommitSHA: source, tagObjectSHA: tagObject, artifactName: declaration.distribution.artifactName, artifactSHA256 };
  const artifactProof = { schemaVersion: 1, kind: "neondiff.desktop.artifact-proof-v2", verified: true, releaseTag: tag, artifactName: declaration.distribution.artifactName, artifactSHA256, appSHA256: "b".repeat(64), treeAlgorithm: "sha256-tree-v1", treeSHA256: "c".repeat(64) };
  const enclosure = { url: artifactURL, version: build, build, shortVersionString: version, edSignature: "c2lnbmF0dXJlNw==", signatureVerified: true };
  const feedProof = { schemaVersion: 1, kind: "neondiff.desktop.feed-enclosure-proof-v2", verified: true, channel: "beta", url: feed, releaseTag: tag, artifactName: declaration.distribution.artifactName, artifactSHA256, appcastSHA256: "d".repeat(64), enclosure };
  return { declaration, declarationValidation, tagMetadata: { ref: `refs/tags/${tag}`, object: { type: "tag", sha: tagObject } }, annotatedTagMetadata: { sha: tagObject, tag, object: { type: "commit", sha: source } }, releaseMetadata: { tag_name: tag, draft: false, prerelease: true, immutable: true, assets: [{ name: declaration.distribution.artifactName, digest: `sha256:${artifactSHA256}`, browser_download_url: artifactURL }] }, identityProof, artifactMetadata: { ...artifactProof, proof: artifactProof }, feedMetadata: { channel: "beta", url: feed, appcastSHA256: "d".repeat(64), enclosure, proof: feedProof } };
}

describe("accepted Desktop release provenance", () => {
  it("accepts canonical validation and emits one deterministic receipt", () => {
    const value = fixture(), receipt = buildAcceptedReleaseProvenance(value);
    expect(receipt).toMatchObject({ release: { tag: "v1.1.0-beta.7", sequence: "7", build: "42" }, source: { commitSHA: source, tagObjectSHA: tagObject }, artifacts: { artifactSHA256, treeAlgorithm: "sha256-tree-v1" }, feed: { releaseTag: "v1.1.0-beta.7", artifactName: value.declaration.distribution.artifactName, enclosure: { version: "42", build: "42", shortVersionString: "1.1.0-beta.7", edSignature: "c2lnbmF0dXJlNw==" } } });
    expect(JSON.parse(serializeAcceptedReleaseProvenance(value))).toEqual(receipt);
    expect(acceptedReleaseProvenanceDigest(value)).toMatch(/^[0-9a-f]{64}$/);
    expect(serializeAcceptedReleaseProvenance(value)).toBe(serializeAcceptedReleaseProvenance(value));
  });

  it("rejects validator-invariant and verification failures", () => {
    for (const mutate of [
      (v: any) => { v.declaration.sequence = "8"; },
      (v: any) => { v.declaration.version = "1.1.0-rc.9007199254740992"; v.declaration.tag = `v${v.declaration.version}`; v.declaration.channel = "rc"; },
      (v: any) => { v.identityProof.verified = false; },
      (v: any) => { v.artifactMetadata.proof.verified = false; },
      (v: any) => { v.feedMetadata.proof.verified = false; }
    ]) { const value = fixture(); mutate(value); expect(() => buildAcceptedReleaseProvenance(value)).toThrow(); }
  });

  it("rejects cross-release source, tag, artifact, and feed-enclosure substitution", () => {
    for (const mutate of [
      (v: any) => { v.identityProof.releaseTag = "v1.1.0-beta.8"; },
      (v: any) => { v.annotatedTagMetadata.object.sha = "f".repeat(40); },
      (v: any) => { v.releaseMetadata.assets[0].digest = `sha256:${"e".repeat(64)}`; },
      (v: any) => { v.artifactMetadata.proof.artifactName = "NeonDiff-1.1.0-beta.8-build43-macOS.zip"; },
      (v: any) => { v.feedMetadata.proof.releaseTag = "v1.1.0-beta.8"; },
      (v: any) => { v.feedMetadata.proof.enclosure.shortVersionString = "1.1.0-beta.8"; },
      (v: any) => { v.feedMetadata.proof.enclosure.build = "43"; },
      (v: any) => { v.feedMetadata.proof.enclosure.url = v.feedMetadata.proof.enclosure.url.replace("beta.7", "beta.8"); }
    ]) { const value = fixture(); mutate(value); expect(() => buildAcceptedReleaseProvenance(value)).toThrow(); }
  });
});
