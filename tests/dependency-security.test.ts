import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { verify } from "sigstore";
import { verifyNpmProvenanceBundle } from "../scripts/lib/npm-provenance-policy.mjs";

const require = createRequire(import.meta.url);

describe("compatible provenance dependency security refresh", () => {
  it("keeps every resolved glob outside GHSA-3g3m-2fjr-6pw4", async () => {
    const lock = JSON.parse(await readFile("package-lock.json", "utf8"));
    const semver = require("semver");
    const globs = Object.entries(lock.packages).filter(([path]) => path.endsWith("node_modules/glob"));
    expect(globs.length).toBeGreaterThan(0);
    for (const [, entry] of globs) {
      expect(semver.satisfies((entry as { version: string }).version, ">=9.0.0 <=14.0.1")).toBe(false);
    }
  });

  it("preserves sigstore's verify API and fails closed when signature verification rejects", async () => {
    expect(typeof verify).toBe("function");
    const bundle = { dsseEnvelope: { payload: "synthetic unsigned bundle" } };
    let calls = 0;
    await expect(verifyNpmProvenanceBundle({
      document: { attestations: [{ predicateType: "https://slsa.dev/provenance/v1", bundle }] },
      expectedPackage: "synthetic-package",
      expectedVersion: "1.0.0",
      expectedIntegrity: "sha512-c3ludGhldGlj",
      expectedRepository: "example/synthetic",
      expectedWorkflow: ".github/workflows/synthetic.yml",
      expectedTag: "v1.0.0",
      expectedCommit: "a".repeat(40)
    }, async (received: unknown) => {
      calls++;
      expect(received).toBe(bundle);
      throw new Error("synthetic signature rejection");
    })).rejects.toThrow("synthetic signature rejection");
    expect(calls).toBe(1);
  });

  it("preserves TUF delegated path matching on its declared minimatch dependency", () => {
    const { Targets } = require("@tufjs/models");
    const targets = Targets.fromJSON({
      _type: "targets", spec_version: "1.0.31", version: 1,
      expires: "2099-01-01T00:00:00Z", targets: {},
      delegations: { keys: {}, roles: [{
        name: "synthetic-role", keyids: ["synthetic-key"], threshold: 1,
        terminating: false, paths: ["packages/*.json"]
      }] }
    });
    expect([...targets.delegations.rolesForTarget("packages/synthetic.json")])
      .toEqual([{ role: "synthetic-role", terminating: false }]);
    expect([...targets.delegations.rolesForTarget("other/synthetic.json")]).toEqual([]);
    expect([...targets.delegations.rolesForTarget("packages/nested/synthetic.json")]).toEqual([]);
  });

  it("exercises glob and cacache locally without a registry or TUF call", async () => {
    const { glob } = require("glob");
    const cacache = require("cacache");
    const root = await mkdtemp(join(tmpdir(), "neondiff-dependency-security-"));
    try {
      await writeFile(join(root, "synthetic.json"), "synthetic fixture");
      await writeFile(join(root, "ignored.txt"), "synthetic fixture");
      expect(await glob("*.json", { cwd: root })).toEqual(["synthetic.json"]);
      const cache = join(root, "cache");
      await cacache.put(cache, "synthetic-key", "synthetic payload");
      expect((await cacache.get(cache, "synthetic-key")).data.toString()).toBe("synthetic payload");
      await cacache.rm.entry(cache, "synthetic-key");
      await expect(cacache.get(cache, "synthetic-key")).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
