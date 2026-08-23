import { createHash } from "node:crypto";
import { validateReleaseDeclaration } from "../validate-desktop-release-declaration.mjs";

const SHA1 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const REPO = "https://github.com/electricsheephq/evaos-code-review-bot-neondiff";
const fail = (message) => { throw new Error(message); };
const text = (value, label) => { if (typeof value !== "string" || value.length === 0) fail(`${label} is required`); return value; };
const hex = (value, label, pattern) => { const result = text(value, label); if (!pattern.test(result)) fail(`${label} is malformed`); return result; };
const proof = (value, kind, label) => { if (value?.schemaVersion !== 1 || value.kind !== kind || value.verified !== true) fail(`${label} proof is not verified`); return value; };
const same = (actual, expected, label) => { if (actual !== expected) fail(`${label} does not match`); };

function acceptedMetadata(metadata) {
  const { declaration, declarationValidation, tagMetadata, annotatedTagMetadata, releaseMetadata, identityProof, artifactMetadata, feedMetadata } = metadata ?? {};
  const validation = validateReleaseDeclaration(declaration);
  const declarationProof = proof(declarationValidation, "neondiff.desktop.release-declaration-validation-v1", "declaration");
  for (const key of ["releaseTag", "version", "channel", "sequence", "build", "artifactName", "feed"]) same(declarationProof[key], validation[key === "releaseTag" ? "releaseTag" : key], `declaration ${key}`);
  const { releaseTag: tag, version, channel, sequence, build, artifactName, feed } = validation;
  const tagObjectSHA = hex(tagMetadata?.object?.sha, "annotated tag-object SHA", SHA1);
  const sourceCommitSHA = hex(annotatedTagMetadata?.object?.sha, "source commit SHA", SHA1);
  same(tagMetadata?.ref, `refs/tags/${tag}`, "release tag ref");
  same(tagMetadata?.object?.type, "tag", "release tag type");
  if (annotatedTagMetadata?.sha !== tagObjectSHA || annotatedTagMetadata?.tag !== tag || annotatedTagMetadata?.object?.type !== "commit") fail("annotated tag metadata does not match");
  const assets = Array.isArray(releaseMetadata?.assets) ? releaseMetadata.assets.filter((item) => item?.name === artifactName) : [];
  if (releaseMetadata?.tag_name !== tag || releaseMetadata?.draft !== false || releaseMetadata?.prerelease !== true || releaseMetadata?.immutable !== true || assets.length !== 1) fail("release metadata is not an immutable identity match");
  const asset = assets[0], artifactSHA256 = hex(asset?.digest?.replace(/^sha256:/, ""), "artifact SHA-256", SHA256);
  const artifactURL = `${REPO}/releases/download/${tag}/${artifactName}`;
  if (asset.digest !== `sha256:${artifactSHA256}` || asset.browser_download_url !== artifactURL) fail("release asset metadata is not canonical");
  const identity = proof(identityProof, "neondiff.desktop.release-identity-validation-v2", "release identity");
  for (const [key, value] of Object.entries({ releaseTag: tag, sourceCommitSHA, tagObjectSHA, artifactName, artifactSHA256 })) same(identity[key], value, `release identity ${key}`);
  const appSHA256 = hex(artifactMetadata?.appSHA256, "app SHA-256", SHA256), treeSHA256 = hex(artifactMetadata?.treeSHA256, "tree SHA-256", SHA256);
  same(artifactMetadata?.releaseTag, tag, "artifact release tag"); same(artifactMetadata?.artifactName, artifactName, "artifact name"); same(artifactMetadata?.artifactSHA256, artifactSHA256, "artifact digest"); same(artifactMetadata?.treeAlgorithm, "sha256-tree-v1", "tree algorithm");
  const artifact = proof(artifactMetadata?.proof, "neondiff.desktop.artifact-proof-v2", "artifact");
  for (const [key, value] of Object.entries({ releaseTag: tag, artifactName, artifactSHA256, appSHA256, treeAlgorithm: "sha256-tree-v1", treeSHA256 })) same(artifact[key], value, `artifact proof ${key}`);
  const feedURL = feedMetadata?.url;
  if (feedMetadata?.channel !== channel || feedURL !== feed || feedMetadata?.appcastSHA256 !== feedMetadata?.proof?.appcastSHA256) fail("feed identity does not match declaration");
  const appcastSHA256 = hex(feedMetadata?.appcastSHA256, "appcast SHA-256", SHA256), feedReceipt = proof(feedMetadata?.proof, "neondiff.desktop.feed-enclosure-proof-v2", "feed");
  for (const [key, value] of Object.entries({ channel, url: feedURL, releaseTag: tag, artifactName, artifactSHA256, appcastSHA256 })) same(feedReceipt[key], value, `feed proof ${key}`);
  const enclosure = feedReceipt.enclosure, declaredEnclosure = feedMetadata?.enclosure;
  if (!declaredEnclosure || declaredEnclosure.url !== enclosure?.url || declaredEnclosure.version !== enclosure?.version || declaredEnclosure.build !== enclosure?.build || declaredEnclosure.shortVersionString !== enclosure?.shortVersionString || declaredEnclosure.edSignature !== enclosure?.edSignature || declaredEnclosure.signatureVerified !== enclosure?.signatureVerified || enclosure.url !== artifactURL || enclosure.version !== build || enclosure.build !== build || enclosure.shortVersionString !== version || enclosure.signatureVerified !== true || typeof enclosure.edSignature !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(enclosure.edSignature)) fail("feed enclosure identity or signature is not verified");
  return { tag, version, channel, sequence, build, artifactName, sourceCommitSHA, tagObjectSHA, artifactSHA256, appSHA256, treeSHA256, appcastSHA256, feed: feedURL, enclosure };
}

export function buildAcceptedReleaseProvenance(metadata) {
  const value = acceptedMetadata(metadata);
  return { schemaVersion: 1, kind: "neondiff.desktop.accepted-release-provenance-v2", product: "neondiff-desktop", release: { tag: value.tag, version: value.version, channel: value.channel, sequence: value.sequence, build: value.build, artifactName: value.artifactName }, source: { commitSHA: value.sourceCommitSHA, tagObjectSHA: value.tagObjectSHA }, artifacts: { artifactName: value.artifactName, artifactSHA256: value.artifactSHA256, appSHA256: value.appSHA256, treeAlgorithm: "sha256-tree-v1", treeSHA256: value.treeSHA256 }, feed: { channel: value.channel, url: value.feed, appcastSHA256: value.appcastSHA256, releaseTag: value.tag, artifactName: value.artifactName, artifactSHA256: value.artifactSHA256, enclosure: value.enclosure } };
}

export function serializeAcceptedReleaseProvenance(metadata) { return `${JSON.stringify(buildAcceptedReleaseProvenance(metadata))}\n`; }
export function acceptedReleaseProvenanceDigest(metadata) { return createHash("sha256").update(serializeAcceptedReleaseProvenance(metadata)).digest("hex"); }
