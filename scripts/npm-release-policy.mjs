#!/usr/bin/env node

import { appendFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parseArgs(values) {
  const parsed = new Map();
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith("--") || value === undefined) fail(`invalid argument list near ${key ?? "(missing)"}`);
    parsed.set(key.slice(2), value);
  }
  return parsed;
}

function required(args, name) {
  const value = args.get(name);
  if (!value) fail(`--${name} is required`);
  return value;
}

function parseBoolean(value, name) {
  if (value === "true") return true;
  if (value === "false") return false;
  fail(`--${name} must be true or false`);
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function isAncestor(ancestor, descendant) {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function classify(args) {
  const eventName = required(args, "event-name");
  const releasePrerelease = parseBoolean(required(args, "release-prerelease"), "release-prerelease");
  const tag = required(args, "tag");
  const packageVersion = required(args, "package-version");
  const releaseLevel = required(args, "release-level");
  let skippedVersions;
  try {
    skippedVersions = JSON.parse(required(args, "skipped-versions-json"));
  } catch {
    fail("--skipped-versions-json must be valid JSON");
  }
  if (!Array.isArray(skippedVersions) || !skippedVersions.every((value) => typeof value === "string")) {
    fail("--skipped-versions-json must be a JSON array of strings");
  }

  const npmTag = packageVersion.includes("-") ? "beta" : "latest";
  if (eventName === "release" && releasePrerelease && npmTag === "latest") {
    fail("stable npm packages require a non-prerelease GitHub Release");
  }
  if (eventName === "workflow_dispatch") {
    const releaseMetadataPath = args.get("release-metadata");
    if (!releaseMetadataPath && npmTag === "latest") {
      fail("manual stable publish requires an existing non-prerelease GitHub Release");
    }
    if (!releaseMetadataPath) fail("manual npm publish requires existing GitHub Release metadata");
    let releaseMetadata;
    try {
      releaseMetadata = JSON.parse(readFileSync(releaseMetadataPath, "utf8"));
    } catch {
      fail("manual npm publish release metadata is not valid JSON");
    }
    if (releaseMetadata.tag_name !== tag || releaseMetadata.draft !== false) {
      fail("manual npm publish requires matching published GitHub Release metadata");
    }
    if (npmTag === "latest" && releaseMetadata.prerelease !== false) {
      fail("manual stable publish requires an existing non-prerelease GitHub Release");
    }
    if (npmTag === "beta" && releaseMetadata.prerelease !== true) {
      fail("manual beta publish requires an existing prerelease GitHub Release");
    }
  }

  let shouldPublish = true;
  if (tag !== `v${packageVersion}`) {
    if (eventName === "workflow_dispatch") {
      fail(`manual npm publish tag ${tag} does not match package.json version v${packageVersion}`);
    }
    if (releaseLevel === "source-beta" && skippedVersions.includes(tag)) {
      shouldPublish = false;
    } else {
      fail(`release tag ${tag} does not match package.json version v${packageVersion}`);
    }
  }

  const result = { shouldPublish, npmTag };
  const githubOutput = args.get("github-output");
  if (githubOutput) {
    appendFileSync(githubOutput, `should_publish=${shouldPublish}\nnpm_tag=${npmTag}\n`, { encoding: "utf8" });
  }
  console.log(JSON.stringify(result));
}

function verifyGit(args) {
  const tag = required(args, "tag");
  const candidateHead = required(args, "candidate-head");
  const mainRef = required(args, "main-ref");
  if (!/^[0-9a-f]{40}$/i.test(candidateHead)) fail("candidate head must be a full 40-character Git SHA");

  let tagType;
  try {
    tagType = git(["cat-file", "-t", tag]);
  } catch {
    fail(`release tag ${tag} is missing`);
  }
  if (tagType !== "tag") fail("release tag must be annotated");

  let tagCommit;
  try {
    tagCommit = git(["rev-list", "-n", "1", tag]);
    git(["rev-parse", "--verify", `${candidateHead}^{commit}`]);
    git(["rev-parse", "--verify", `${mainRef}^{commit}`]);
  } catch {
    fail("release tag, candidate head, or protected main ref is not a valid commit");
  }
  if (!isAncestor(tagCommit, mainRef)) {
    fail("release tag commit must be an ancestor of protected main");
  }
  if (!isAncestor(candidateHead, tagCommit)) {
    fail("declared release candidate head must be an ancestor of the release tag commit");
  }
  console.log(JSON.stringify({ tag, tagCommit, candidateHead, mainRef }));
}

function verifyPack(args) {
  const localPackPath = required(args, "local-pack");
  const remoteMetadataPath = required(args, "remote-metadata");
  const expectedVersion = required(args, "expected-version");
  const expectedGitHead = args.get("expected-git-head");
  let localPack;
  let remote;
  try {
    [localPack] = JSON.parse(readFileSync(localPackPath, "utf8"));
    remote = JSON.parse(readFileSync(remoteMetadataPath, "utf8"));
  } catch {
    fail("local pack or remote npm metadata is not valid JSON");
  }
  if (localPack?.version !== expectedVersion || remote?.version !== expectedVersion) {
    fail(`npm package version must match ${expectedVersion}`);
  }
  if (!localPack.integrity || localPack.integrity !== remote["dist.integrity"]) {
    fail("npm tarball integrity does not match the reviewed pack");
  }
  if (!localPack.shasum || localPack.shasum !== remote["dist.shasum"]) {
    fail("npm tarball shasum does not match the reviewed pack");
  }
  if (expectedGitHead) {
    if (typeof remote.gitHead !== "string" || remote.gitHead.length === 0) {
      fail("npm gitHead is missing from published package metadata");
    }
    if (remote.gitHead !== expectedGitHead) {
      fail("npm gitHead does not match the reviewed release tag commit");
    }
  }
  console.log(JSON.stringify({
    version: expectedVersion,
    integrity: localPack.integrity,
    shasum: localPack.shasum,
    gitHead: remote.gitHead
  }));
}

const [command, ...rawArgs] = process.argv.slice(2);
const args = parseArgs(rawArgs);
if (command === "classify") classify(args);
else if (command === "verify-git") verifyGit(args);
else if (command === "verify-pack") verifyPack(args);
else fail("command must be classify, verify-git, or verify-pack");
