#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function args(values) {
  const parsed = new Map();
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith("--") || value === undefined) fail("expected --name value arguments");
    parsed.set(key.slice(2), value);
  }
  return parsed;
}

const input = args(process.argv.slice(2));
const required = (name) => input.get(name) || fail(`--${name} is required`);
const attestationsPath = required("attestations");
const expectedPackage = required("expected-package");
const expectedVersion = required("expected-version");
const expectedIntegrity = required("expected-integrity");
const expectedRepository = required("expected-repository");
const expectedWorkflow = required("expected-workflow");
const expectedTag = required("expected-tag");
const expectedCommit = required("expected-commit");
if (!/^[a-f0-9]{40}$/.test(expectedCommit)) fail("expected commit must be a full lowercase Git SHA");
if (!expectedIntegrity.startsWith("sha512-")) fail("expected integrity must be sha512");

let document;
try {
  document = JSON.parse(readFileSync(attestationsPath, "utf8"));
} catch {
  fail("attestations response must be valid JSON");
}
const slsa = document?.attestations?.filter((item) => item?.predicateType === "https://slsa.dev/provenance/v1") ?? [];
if (slsa.length !== 1) fail("attestations response must contain exactly one SLSA provenance statement");
let statement;
try {
  statement = JSON.parse(Buffer.from(slsa[0].bundle.dsseEnvelope.payload, "base64").toString("utf8"));
} catch {
  fail("SLSA provenance payload must be valid base64 JSON");
}
if (statement.predicateType !== "https://slsa.dev/provenance/v1") fail("SLSA predicate type does not match");
const expectedSubject = `pkg:npm/${expectedPackage}@${expectedVersion}`;
const subject = statement.subject?.find((item) => item?.name === expectedSubject);
if (!subject) fail("provenance subject does not match the npm package");
let expectedSha512;
try {
  expectedSha512 = Buffer.from(expectedIntegrity.slice("sha512-".length), "base64").toString("hex");
} catch {
  fail("expected integrity is not valid base64");
}
if (subject.digest?.sha512 !== expectedSha512) fail("provenance subject digest does not match the reviewed tarball");
const build = statement.predicate?.buildDefinition;
const workflow = build?.externalParameters?.workflow;
if (workflow?.repository !== `https://github.com/${expectedRepository}`) fail("provenance repository does not match");
if (workflow?.path !== expectedWorkflow) fail("provenance workflow does not match");
if (workflow?.ref !== `refs/tags/${expectedTag}`) fail("provenance tag ref does not match");
const dependency = build?.resolvedDependencies?.find((item) => item?.digest?.gitCommit);
if (dependency?.digest?.gitCommit !== expectedCommit) fail("provenance git commit does not match");
if (dependency?.uri !== `git+https://github.com/${expectedRepository}@refs/tags/${expectedTag}`) {
  fail("provenance resolved dependency does not match the release tag");
}
process.stdout.write(`${JSON.stringify({ package: expectedPackage, version: expectedVersion, commit: expectedCommit, sha512: expectedSha512 })}\n`);
