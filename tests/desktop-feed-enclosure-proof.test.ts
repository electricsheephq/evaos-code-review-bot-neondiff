import { describe, expect, it } from "vitest";
import { buildFeedEnclosureProof, feedEnclosureProofDigest, serializeFeedEnclosureProof } from "../scripts/lib/desktop-feed-enclosure-proof.mjs";

const publicKey = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";
const signedContent = Buffer.from("NeonDiff-1.1.0-beta.7-build42-macOS.zip");
const artifactSHA256 = "26e3f3b46951073f491eb4bce9ed29f37373a71f8660f09f1e5565dd36db03d5";
const signature = "kdfWQEYJInL03AG3nHvaoXVLgg0tqI1z+VUWuR/kcaangjaZ4ZTrN1s3ISdTnOqPhqrvx9uEoqqZ8/iVhCc4Ag==";

function enclosure() {
  return { url: "https://github.com/electricsheephq/evaos-code-review-bot-neondiff/releases/download/v1.1.0-beta.7/NeonDiff-1.1.0-beta.7-build42-macOS.zip", version: "1.1.0-beta.7", build: "42", shortVersionString: "1.1.0-beta.7", channel: "beta", artifactName: "NeonDiff-1.1.0-beta.7-build42-macOS.zip", artifactSHA256, edSignature: signature };
}
const options = { acceptedPublicKey: Buffer.from(publicKey, "hex").toString("base64"), signedContent };

describe("desktop feed enclosure proof", () => {
  it("verifies Sparkle bytes and stays deterministic across DTO key order", () => {
    const first = buildFeedEnclosureProof(enclosure(), options);
    const reversed = Object.fromEntries(Object.entries(enclosure()).reverse());
    const second = buildFeedEnclosureProof(reversed, options);
    expect(second).toEqual(first);
    expect(serializeFeedEnclosureProof(first)).toBe(serializeFeedEnclosureProof(second));
    expect(feedEnclosureProofDigest(first)).toMatch(/^[a-f0-9]{64}$/);
    expect(serializeFeedEnclosureProof(first)).not.toContain(publicKey);
  });

  it.each([
    ["extra field", (value: any) => { value.privateKey = "never-accepted"; }],
    ["missing field", (value: any) => { delete value.edSignature; }],
    ["malformed signature", (value: any) => { value.edSignature = "not-base64"; }],
    ["substituted URL", (value: any) => { value.url = value.url.replace("beta.7", "beta.8"); }],
    ["localhost URL", (value: any) => { value.url = value.url.replace("github.com", "localhost"); }],
    ["private URL", (value: any) => { value.url = value.url.replace("github.com", "192.168.1.4"); }],
    ["noncanonical URL", (value: any) => { value.url = value.url.replace("/download/", "/download/../download/"); }],
    ["substituted artifact digest", (value: any) => { value.artifactSHA256 = "a".repeat(64); }]
  ])("rejects %s", (_label, mutate) => {
    const value = enclosure(); mutate(value);
    expect(() => buildFeedEnclosureProof(value, options)).toThrow();
  });

  it("rejects wrong key, wrong bytes, and false or missing proof", () => {
    expect(() => buildFeedEnclosureProof(enclosure(), { ...options, acceptedPublicKey: "11".repeat(32) })).toThrow();
    expect(() => buildFeedEnclosureProof(enclosure(), { ...options, signedContent: Buffer.from("substituted") })).toThrow();
    const proof = buildFeedEnclosureProof(enclosure(), options);
    expect(proof.publicKeyFingerprint).toBe("sha256:21fe31dfa154a261626bf854046fd2271b7bed4b6abe45aa58877ef47f9721b9");
    expect(proof.signatureScope).toBe("sparkle-artifact-bytes");
    expect(() => serializeFeedEnclosureProof({ ...proof, verified: false })).toThrow();
    expect(() => serializeFeedEnclosureProof({ ...proof })).toThrow();
    expect(() => serializeFeedEnclosureProof(JSON.parse(serializeFeedEnclosureProof(proof)))).toThrow();
    const { signedContentSHA256: _omitted, ...missing } = proof;
    expect(() => serializeFeedEnclosureProof(missing)).toThrow();
  });
});
