import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const SHA1 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const FEEDS = Object.freeze({ beta: "https://www.neondiff.com/updates/beta/appcast.xml", stable: "https://www.neondiff.com/updates/stable/appcast.xml" });
const { default: Ajv } = createRequire(import.meta.url)("ajv/dist/2020.js");
const validateDeclaration = new Ajv({ allErrors: true, strict: true }).compile(JSON.parse(readFileSync(new URL("../../docs/schema/desktop-release-declaration-v1.schema.json", import.meta.url), "utf8")));
const fail = (message) => { throw new Error(message); };
const string = (value, label) => { if (typeof value !== "string" || value.length === 0) fail(`${label} is required`); return value; };
const digest = (value, label, pattern) => { const result = string(value, label); if (!pattern.test(result)) fail(`${label} is malformed`); return result; };
const proof = (value, kind, label) => { if (value?.schemaVersion !== 1 || value.kind !== kind || value.verified !== true) fail(`${label} proof is not verified`); return value; };
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function releaseIdentity(declaration) {
  const version = string(declaration?.version, "declaration version"), tag = string(declaration?.tag, "declaration tag");
  const match = version.match(/^1\.1\.0-(beta|rc)\.([1-9][0-9]{0,15})$/);
  if (!match || tag !== `v${version}` || declaration?.channel !== match[1]) fail("declaration release identity is invalid");
  return { version, tag, channel: match[1] };
}

export function buildAcceptedReleaseProvenance(metadata) {
  const { declaration, tagMetadata, annotatedTagMetadata, releaseMetadata, artifactMetadata, feedMetadata } = metadata ?? {};
  if (declaration?.schemaVersion !== 1 || declaration?.product !== "neondiff-desktop" || declaration?.contract !== "paid-mac-beta-byo-v1") fail("declaration is not validated Desktop metadata");
  if (!validateDeclaration(declaration)) fail("declaration is outside the canonical v1 schema");
  const release = releaseIdentity(declaration), build = string(declaration?.build, "declaration build");
  if (!/^[0-9]+$/.test(build)) fail("declaration build is malformed");
  const artifactName = string(declaration?.distribution?.artifactName, "declaration artifact name");
  if (artifactName !== `NeonDiff-${release.version}-build${build}-macOS.zip`) fail("declaration artifact identity is invalid");
  const tagObjectSHA = digest(tagMetadata?.object?.sha, "annotated tag-object SHA", SHA1), sourceCommitSHA = digest(annotatedTagMetadata?.object?.sha, "source commit SHA", SHA1);
  if (tagMetadata?.ref !== `refs/tags/${release.tag}` || tagMetadata?.object?.type !== "tag") fail("release tag metadata is not annotated");
  if (annotatedTagMetadata?.sha !== tagObjectSHA || annotatedTagMetadata?.tag !== release.tag || annotatedTagMetadata?.object?.type !== "commit") fail("annotated tag metadata does not match");
  const assets = Array.isArray(releaseMetadata?.assets) ? releaseMetadata.assets.filter((item) => item?.name === artifactName) : [];
  if (releaseMetadata?.tag_name !== release.tag || releaseMetadata?.draft !== false || releaseMetadata?.immutable !== true || releaseMetadata?.prerelease !== (release.channel !== "stable") || assets.length !== 1) fail("release metadata is not an immutable identity match");
  const asset = assets[0], artifactSHA256 = digest(asset?.digest?.replace(/^sha256:/, ""), "artifact SHA-256", SHA256);
  if (asset.digest !== `sha256:${artifactSHA256}` || asset.browser_download_url !== `https://github.com/electricsheephq/evaos-code-review-bot-neondiff/releases/download/${release.tag}/${artifactName}`) fail("release asset metadata is not canonical");
  const identityProof = proof(metadata?.identityProof, "neondiff.desktop.release-identity-validation-v1", "release identity");
  if (identityProof.releaseTag !== release.tag || identityProof.sourceCommitSHA !== sourceCommitSHA || identityProof.tagObjectSHA !== tagObjectSHA || identityProof.artifactSHA256 !== artifactSHA256) fail("release identity proof does not match validated metadata");
  if (artifactMetadata?.treeAlgorithm !== "sha256-tree-v1") fail("tree digest algorithm is not supported");
  const appSHA256 = digest(artifactMetadata?.appSHA256, "app SHA-256", SHA256), treeSHA256 = digest(artifactMetadata?.treeSHA256, "tree SHA-256", SHA256);
  if (artifactMetadata?.artifactSHA256 !== artifactSHA256) fail("artifact metadata does not match release metadata");
  const artifactProof = proof(artifactMetadata?.proof, "neondiff.desktop.artifact-proof-v1", "artifact");
  if (artifactProof.appSHA256 !== appSHA256 || artifactProof.treeAlgorithm !== "sha256-tree-v1" || artifactProof.treeSHA256 !== treeSHA256 || artifactProof.artifactSHA256 !== artifactSHA256) fail("artifact proof does not match validated metadata");
  const feedChannel = string(feedMetadata?.channel, "feed channel");
  if (!Object.hasOwn(FEEDS, feedChannel) || feedMetadata.url !== FEEDS[feedChannel] || declaration?.distribution?.origins?.feed !== feedMetadata.url || feedChannel !== (release.channel === "stable" ? "stable" : "beta")) fail("feed identity does not match release metadata");
  const appcastSHA256 = digest(feedMetadata.appcastSHA256, "appcast SHA-256", SHA256);
  const feedProof = proof(feedMetadata?.proof, "neondiff.desktop.feed-proof-v1", "feed");
  if (feedProof.channel !== feedChannel || feedProof.url !== feedMetadata.url || feedProof.appcastSHA256 !== appcastSHA256) fail("feed proof does not match validated metadata");
  return { schemaVersion: 1, kind: "neondiff.desktop.accepted-release-provenance", product: "neondiff-desktop", release: { tag: release.tag, version: release.version, channel: release.channel, build, artifactName }, source: { commitSHA: sourceCommitSHA, tagObjectSHA }, artifacts: { appSHA256, treeAlgorithm: "sha256-tree-v1", treeSHA256, artifactSHA256 }, feed: { channel: feedChannel, url: feedMetadata.url, appcastSHA256 } };
}

export function serializeAcceptedReleaseProvenance(metadata) {
  const receipt = buildAcceptedReleaseProvenance(metadata);
  return `${JSON.stringify(receipt)}\n`;
}

export function acceptedReleaseProvenanceDigest(metadata) {
  return sha256(Buffer.from(serializeAcceptedReleaseProvenance(metadata)));
}
