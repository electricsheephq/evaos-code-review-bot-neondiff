import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyNpmProvenanceBundle } from "../scripts/lib/npm-provenance-policy.mjs";

describe("npm provenance policy", () => {
  const roots: string[] = [];
  const script = resolve("scripts/verify-npm-provenance.mjs");

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("binds the exact cryptographically verified bundle to the reviewed tarball and release commit", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-provenance-"));
    roots.push(root);
    const bytes = Buffer.from("reviewed tarball fixture");
    const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
    const commit = "a".repeat(40);
    const payload = {
      subject: [{ name: "pkg:npm/neondiff@1.0.4", digest: { sha512: createHash("sha512").update(bytes).digest("hex") } }],
      predicateType: "https://slsa.dev/provenance/v1",
      predicate: {
        buildDefinition: {
          externalParameters: {
            workflow: {
              ref: "refs/tags/v1.0.4",
              repository: "https://github.com/electricsheephq/evaos-code-review-bot-neondiff",
              path: ".github/workflows/publish-npm.yml"
            }
          },
          resolvedDependencies: [{
            uri: "git+https://github.com/electricsheephq/evaos-code-review-bot-neondiff@refs/tags/v1.0.4",
            digest: { gitCommit: commit }
          }]
        }
      }
    };
    const attestationsPath = join(root, "attestations.json");
    writeFileSync(attestationsPath, JSON.stringify({ attestations: [{
      predicateType: "https://slsa.dev/provenance/v1",
      bundle: { dsseEnvelope: { payload: Buffer.from(JSON.stringify(payload)).toString("base64") } }
    }] }));

    const document = JSON.parse(readFileSync(attestationsPath, "utf8"));
    let verifiedBundle: unknown;
    const result = await verifyNpmProvenanceBundle({
      document,
      expectedPackage: "neondiff",
      expectedVersion: "1.0.4",
      expectedIntegrity: integrity,
      expectedRepository: "electricsheephq/evaos-code-review-bot-neondiff",
      expectedWorkflow: ".github/workflows/publish-npm.yml",
      expectedTag: "v1.0.4",
      expectedCommit: commit
    }, async (bundle) => { verifiedBundle = bundle; return {} as never; });
    expect(verifiedBundle).toBe(document.attestations[0].bundle);
    expect(result).toEqual({
      package: "neondiff",
      version: "1.0.4",
      integrity,
      sha512: createHash("sha512").update(bytes).digest("hex"),
      repository: "electricsheephq/evaos-code-review-bot-neondiff",
      workflow: ".github/workflows/publish-npm.yml",
      tag: "v1.0.4",
      commit
    });

    await expect(verifyNpmProvenanceBundle({
      document,
      expectedPackage: "neondiff",
      expectedVersion: "1.0.4",
      expectedIntegrity: integrity,
      expectedRepository: "electricsheephq/evaos-code-review-bot-neondiff",
      expectedWorkflow: ".github/workflows/publish-npm.yml",
      expectedTag: "v1.0.4",
      expectedCommit: commit
    }, async () => { throw new Error("signature rejected"); })).rejects.toThrow("signature rejected");

    const unsignedRun = spawnSync(process.execPath, [
      script, "--attestations", attestationsPath, "--expected-package", "neondiff",
      "--expected-version", "1.0.4", "--expected-integrity", integrity,
      "--expected-repository", "electricsheephq/evaos-code-review-bot-neondiff",
      "--expected-workflow", ".github/workflows/publish-npm.yml", "--expected-tag", "v1.0.4",
      "--expected-commit", commit
    ], { encoding: "utf8" });
    expect(unsignedRun.status).not.toBe(0);
  }, 20_000);
});
