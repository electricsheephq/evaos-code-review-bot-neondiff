import { describe, expect, it } from "vitest";
import { acceptedReleaseProvenanceDigest, buildAcceptedReleaseProvenance, serializeAcceptedReleaseProvenance } from "../scripts/lib/desktop-release-provenance.mjs";

const source = "0123456789abcdef0123456789abcdef01234567", tagObject = "abcdef0123456789abcdef0123456789abcdef01";
function fixture(channel: "beta" | "stable" = "beta") {
  const version = channel === "stable" ? "1.1.0" : "1.1.0-beta.7", tag = `v${version}`, build = "42", feed = `https://www.neondiff.com/updates/${channel}/appcast.xml`, artifactName = `NeonDiff-${version}-build${build}-macOS.zip`, artifactSHA256 = "a".repeat(64);
  return { declaration: { schemaVersion: 1, product: "neondiff-desktop", contract: "paid-mac-beta-byo-v1", version, tag, channel, build, distribution: { artifactName, origins: { feed } } }, tagMetadata: { ref: `refs/tags/${tag}`, object: { type: "tag", sha: tagObject } }, annotatedTagMetadata: { sha: tagObject, tag, object: { type: "commit", sha: source } }, releaseMetadata: { tag_name: tag, draft: false, prerelease: channel !== "stable", immutable: true, assets: [{ name: artifactName, digest: `sha256:${artifactSHA256}`, browser_download_url: `https://github.com/electricsheephq/evaos-code-review-bot-neondiff/releases/download/${tag}/${artifactName}` }] }, artifactMetadata: { appSHA256: "b".repeat(64), treeAlgorithm: "sha256-tree-v1", treeSHA256: "c".repeat(64), artifactSHA256 }, feedMetadata: { channel, url: feed, appcastSHA256: "d".repeat(64) } };
}

describe("accepted Desktop release provenance", () => {
  it("derives source/tag/artifact/tree/app and explicit beta or stable feed identities", () => {
    for (const channel of ["beta", "stable"] as const) {
      const receipt = buildAcceptedReleaseProvenance(fixture(channel));
      expect(receipt).toMatchObject({ schemaVersion: 1, source: { commitSHA: source, tagObjectSHA: tagObject }, artifacts: { appSHA256: "b".repeat(64), treeAlgorithm: "sha256-tree-v1", treeSHA256: "c".repeat(64), artifactSHA256: "a".repeat(64) }, feed: { channel } });
      expect(JSON.parse(serializeAcceptedReleaseProvenance(fixture(channel)))).toEqual(receipt);
    }
  });
  it("is deterministic, digestable, and contains no secret-looking input fields", () => {
    const value = fixture(), first = serializeAcceptedReleaseProvenance(value);
    expect(first).toBe(serializeAcceptedReleaseProvenance(value));
    expect(acceptedReleaseProvenanceDigest(value)).toMatch(/^[0-9a-f]{64}$/);
    expect(first).not.toMatch(/secret|token|key|private|password/i);
  });
  it("fails closed for absent, malformed, mismatched, or mutable provenance", () => {
    const cases = [
      (v: ReturnType<typeof fixture>) => { delete (v.artifactMetadata as Partial<typeof v.artifactMetadata>).treeSHA256; },
      (v: ReturnType<typeof fixture>) => { v.artifactMetadata.treeAlgorithm = "sha256"; },
      (v: ReturnType<typeof fixture>) => { v.annotatedTagMetadata.object.sha = "not-a-sha"; },
      (v: ReturnType<typeof fixture>) => { v.annotatedTagMetadata.sha = source; },
      (v: ReturnType<typeof fixture>) => { v.releaseMetadata.immutable = false; },
      (v: ReturnType<typeof fixture>) => { v.releaseMetadata.assets[0].digest = `sha256:${"e".repeat(64)}`; },
      (v: ReturnType<typeof fixture>) => { v.feedMetadata.channel = "stable"; },
      (v: ReturnType<typeof fixture>) => { v.declaration.distribution.origins.feed = "https://example.invalid/feed"; }
    ];
    for (const mutate of cases) { const value = fixture(); mutate(value); expect(() => buildAcceptedReleaseProvenance(value)).toThrow(); }
  });
});
