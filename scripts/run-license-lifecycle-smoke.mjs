#!/usr/bin/env node

import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { runLicenseLifecycleSmoke } from "../dist/src/license-lifecycle-smoke.js";
import { requestGitHubActionsOidcToken } from "./lib/github-actions-oidc-token.mjs";

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) fail("expected --name value arguments");
    args.set(key.slice(2), value);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const required = [
  "release-version",
  "candidate-head",
  "pack-shasum",
  "pack-integrity",
  "candidate-cli",
  "config",
  "artifact-output",
  "confirm-live-lifecycle"
];
for (const name of required) {
  if (!args.get(name)) fail(`missing --${name}`);
}
if (args.get("confirm-live-lifecycle") !== "true") fail("--confirm-live-lifecycle true is required");

const cwd = process.cwd();
const artifactOutput = args.get("artifact-output");
if (isAbsolute(artifactOutput)) fail("--artifact-output must be relative and stay within docs/evidence");
let evidenceRoot;
try {
  evidenceRoot = realpathSync(resolve(cwd, "docs", "evidence"));
} catch {
  fail("docs/evidence must exist before running the lifecycle smoke");
}
const absoluteOutput = resolve(cwd, artifactOutput);
const outputRelative = relative(evidenceRoot, absoluteOutput);
if (outputRelative.startsWith("..") || isAbsolute(outputRelative)) {
  fail("--artifact-output must stay within docs/evidence");
}

let oidcToken;
try {
  oidcToken = await requestGitHubActionsOidcToken({
    requestUrl: process.env.ACTIONS_ID_TOKEN_REQUEST_URL,
    requestToken: process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
    audience: "neondiff-license-lifecycle",
    fetchImpl: fetch
  });
} catch {
  fail("trusted GitHub Actions OIDC token could not be obtained");
}

const result = await runLicenseLifecycleSmoke({
  releaseVersion: args.get("release-version"),
  candidateHead: args.get("candidate-head"),
  packShasum: args.get("pack-shasum"),
  packIntegrity: args.get("pack-integrity"),
  apiBaseUrl: "https://neondiff-license.fly.dev",
  issuanceAuthorization: { kind: "github-oidc", bearer: oidcToken },
  candidateCliPath: args.get("candidate-cli"),
  configPath: args.get("config"),
  confirmLiveLifecycle: true
});
oidcToken = undefined;

if (!result.ok) fail(`license lifecycle smoke failed: ${result.errorCode}`);
mkdirSync(dirname(absoluteOutput), { recursive: true });
writeFileSync(absoluteOutput, `${JSON.stringify(result.artifact, null, 2)}\n`, { encoding: "utf8", mode: 0o644 });
process.stdout.write(`${JSON.stringify({
  ok: true,
  command: result.command,
  observedAt: result.observedAt,
  licenseFingerprint: result.licenseFingerprint,
  lifecycle: result.lifecycle,
  artifactPath: artifactOutput,
  proofBoundary: result.proofBoundary
})}\n`);
