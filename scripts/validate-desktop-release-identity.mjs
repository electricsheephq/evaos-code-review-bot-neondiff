#!/usr/bin/env node

import { appendFileSync, readFileSync } from "node:fs";

function fail(message) {
  console.error(message);
  process.exit(1);
}

const values = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  const value = process.argv[index + 1];
  if (!key?.startsWith("--") || value === undefined) fail(`invalid argument near ${key ?? "(missing)"}`);
  values.set(key.slice(2), value);
}
const required = (name) => {
  const value = values.get(name);
  if (!value) fail(`--${name} is required`);
  return value;
};
const readJSON = (name) => {
  try {
    return JSON.parse(readFileSync(required(name), "utf8"));
  } catch {
    fail(`--${name} must point to valid JSON`);
  }
};
const tag = required("release-tag");
const artifact = required("artifact-name");
const digest = required("artifact-sha256");
const sourceSHA = required("reviewed-source-sha");
const tagMatch = tag.match(/^v1\.1\.0-(beta\.([1-9][0-9]{0,3})|rc\.([1-9][0-9]*))$/);
if (!tagMatch) fail("release tag must be canonical beta.N or rc.[1-9][0-9]*");
const releaseIdentity = tagMatch[1];
const releaseChannel = releaseIdentity.split(".")[0];
const releaseNumber = releaseIdentity.split(".")[1];
const artifactMatch = artifact.match(/^NeonDiff-1\.1\.0-(beta\.([1-9][0-9]{0,3})|rc\.([1-9][0-9]*))-build([0-9]+)-macOS\.zip$/);
if (!artifactMatch) fail("artifact name is not build-named for the supported release");
const artifactIdentity = artifactMatch[1];
if (artifactIdentity !== releaseIdentity) fail("tag and artifact channel/number disagree");
if (!/^[a-f0-9]{64}$/.test(digest)) fail("artifact SHA-256 must be lowercase 64-hex");
if (!/^[0-9a-f]{40}$/.test(sourceSHA)) fail("reviewed source SHA must be exactly 40 lowercase hex");

const tagMetadata = readJSON("tag-metadata");
const annotatedTag = readJSON("annotated-tag-metadata");
const release = readJSON("release-metadata");
const tagObjectSHA = tagMetadata.object?.sha;
if (tagMetadata.ref !== `refs/tags/${tag}` || tagMetadata.object?.type !== "tag" || !/^[0-9a-f]{40}$/.test(tagObjectSHA ?? "")) {
  fail("release tag must resolve to an annotated tag object");
}
if (annotatedTag.sha !== tagObjectSHA || annotatedTag.tag !== tag) {
  fail("annotated tag identity does not match the requested tag object");
}
if (annotatedTag.object?.type !== "commit" || annotatedTag.object.sha !== sourceSHA) {
  fail("annotated tag does not peel to the explicitly reviewed source SHA");
}
if (release.tag_name !== tag || release.draft !== false || release.prerelease !== true || release.immutable !== true) {
  fail("GitHub release must match the tag and be immutable published prerelease");
}
const assets = Array.isArray(release.assets) ? release.assets.filter((item) => item?.name === artifact) : [];
if (assets.length !== 1 || assets[0].digest !== `sha256:${digest}`) fail("exact release asset and digest are required");
const expectedURL = `https://github.com/electricsheephq/evaos-code-review-bot-neondiff/releases/download/${tag}/${artifact}`;
if (assets[0].browser_download_url !== expectedURL) fail("release asset URL is not canonical");

const output = values.get("github-output");
if (output) {
  appendFileSync(output, [
    `release_channel=${releaseChannel}`,
    `release_version=1.1.0-${releaseIdentity}`,
    `artifact_build=${artifactMatch[4]}`,
    `url=${expectedURL}`,
    `reviewed_source_sha=${sourceSHA}`
  ].join("\n") + "\n");
}
