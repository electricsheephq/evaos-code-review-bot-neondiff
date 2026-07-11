#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { verify } from "sigstore";
import { verifyNpmProvenanceBundle } from "./lib/npm-provenance-policy.mjs";

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
try {
  const result = await verifyNpmProvenanceBundle({
    document,
    expectedPackage,
    expectedVersion,
    expectedIntegrity,
    expectedRepository,
    expectedWorkflow,
    expectedTag,
    expectedCommit
  }, verify);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  fail(error instanceof Error ? error.message : "npm provenance verification failed");
}
