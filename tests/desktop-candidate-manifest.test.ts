import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as Ajv2020Module from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "..");
const schema = JSON.parse(readFileSync(resolve(root, "docs/schema/desktop-candidate-manifest.schema.json"), "utf8"));
const manifest = JSON.parse(readFileSync(resolve(root, "docs/release-candidates/v1.1.0-desktop-candidate-manifest.json"), "utf8"));
const ajv = new Ajv2020Module.default({ allErrors: true, strict: false });
const validate = ajv.compile(schema);
const cloneManifest = () => JSON.parse(JSON.stringify(manifest));
const feedMatchesArtifact = (candidate: typeof manifest) =>
  candidate.feed.artifactSha256 === null || candidate.artifact.sha256 === null ||
  candidate.feed.artifactSha256 === candidate.artifact.sha256;

describe("Desktop candidate manifest contract", () => {
  it("compiles and validates the versioned manifest with Ajv2020", () => {
    expect(validate(manifest), JSON.stringify(validate.errors)).toBe(true);
    expect(manifest.artifact.bundleId).toBe("com.electricsheephq.NeonDiffDesktop");
  });

  it("keeps all release and customer gates explicit", () => {
    for (const field of schema.required) expect(manifest).toHaveProperty(field);
    expect(manifest.schemaVersion).toBe("desktop-candidate-manifest.v1");
    expect(manifest.product).toBe("NeonDiff Desktop");
    expect(manifest.version).toBe("1.1.0-beta.87");
    expect(manifest.source.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(manifest.source.commit).toBe("de00a1daf20c27b1d14fff5a5defb9b5597e71b5");

    expect(manifest.contract).toMatchObject({
      mode: "byo",
      paidBetaContract: "paid-mac-beta-byo-v1",
      byoGitHubEnabled: true,
      managedBrokerEnabled: false,
      brokerOrigin: null
    });

    for (const gate of ["artifact", "signing", "notarization", "feed", "site", "billing", "customer", "runtime", "rollback"]) {
      expect(manifest[gate].state).toBeTruthy();
      expect(manifest[gate].evidenceRefs.length).toBeGreaterThan(0);
    }
    expect(manifest.runtime.noDowntimeInvariant).toMatch(/prior candidate|replacement/i);
    expect(manifest.artifact.archiveName).toMatch(/^NeonDiff-1\.1\.0-beta\.87-build[0-9]+-macOS\.zip$/);
    expect(manifest.feed.artifactSha256).toBeNull();
    expect(manifest.runtime.configIdentitySha256).toBeNull();
    expect(manifest.rollback.statePreservationRequired).toBe(true);
  });

  it("rejects mixed contracts and proven gates without proof identity", () => {
    const mixed = cloneManifest();
    mixed.contract.managedBrokerEnabled = true;
    expect(validate(mixed)).toBe(false);

    const unprovenIdentity = cloneManifest();
    unprovenIdentity.signing.state = "proven";
    unprovenIdentity.signing.identity = null;
    unprovenIdentity.signing.evidenceRefs = [];
    expect(validate(unprovenIdentity)).toBe(false);

    const unboundRuntime = cloneManifest();
    unboundRuntime.runtime.state = "proven";
    unboundRuntime.runtime.workerVersion = "1.1.0-beta.87-build11091";
    unboundRuntime.runtime.configIdentitySha256 = null;
    expect(validate(unboundRuntime)).toBe(false);
  });

  it("rejects an archive without a build and catches feed checksum drift", () => {
    const malformedArchive = cloneManifest();
    malformedArchive.artifact.archiveName = "NeonDiff-1.1.0-beta.87-macOS.zip";
    expect(validate(malformedArchive)).toBe(false);

    const mismatchedFeed = cloneManifest();
    mismatchedFeed.artifact.sha256 = "a".repeat(64);
    mismatchedFeed.feed.artifactSha256 = "b".repeat(64);
    expect(validate(mismatchedFeed)).toBe(true);
    expect(feedMatchesArtifact(mismatchedFeed)).toBe(false);
  });

  it("does not contain obsolete mounts or secret-shaped values", () => {
    const publicText = `${JSON.stringify(schema)}\n${JSON.stringify(manifest)}`;
    expect(publicText).not.toContain("/Volumes/LEXAR");
    expect(publicText).not.toMatch(/(private[_ -]?key|activation[_ -]?key|api[_ -]?key|token)\s*[:=]\s*[^,}\s]+/i);
  });

  it("leaves the published CLI v1.0.4 manifest as a separate contract", () => {
    const cliManifest = JSON.parse(readFileSync(resolve(root, "docs/public-release-manifest.json"), "utf8"));
    expect(cliManifest.version).toBe("v1.0.4");
    expect(cliManifest.packageArtifact.version).toBe("1.0.4");
    expect(cliManifest.updateChannels.cli.version).toBe("v1.0.4");
    expect(cliManifest).not.toHaveProperty("contract");
    expect(cliManifest).not.toHaveProperty("artifact.bundleId");
  });
});
