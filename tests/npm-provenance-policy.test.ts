import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

describe("npm provenance policy", () => {
  const roots: string[] = [];
  const script = resolve("scripts/verify-npm-provenance.mjs");

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("binds a verified npm provenance payload to the reviewed tarball and release commit", () => {
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

    const run = (expectedCommit: string) => spawnSync(process.execPath, [
      script,
      "--attestations", attestationsPath,
      "--expected-package", "neondiff",
      "--expected-version", "1.0.4",
      "--expected-integrity", integrity,
      "--expected-repository", "electricsheephq/evaos-code-review-bot-neondiff",
      "--expected-workflow", ".github/workflows/publish-npm.yml",
      "--expected-tag", "v1.0.4",
      "--expected-commit", expectedCommit
    ], { encoding: "utf8" });

    expect(run(commit).status).toBe(0);
    const rejected = run("b".repeat(40));
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toContain("provenance git commit does not match");
  }, 20_000);
});
