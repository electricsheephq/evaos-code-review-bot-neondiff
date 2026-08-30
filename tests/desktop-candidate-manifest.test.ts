import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as Ajv2020Module from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "..");
const schema = JSON.parse(readFileSync(resolve(root, "docs/schema/desktop-candidate-manifest.schema.json"), "utf8"));
const manifest = JSON.parse(readFileSync(resolve(root, "docs/release-candidates/v1.1.0-desktop-candidate-manifest.json"), "utf8"));
const ajv = new Ajv2020Module.default({ allErrors: true, strict: false, $data: true });
const validate = ajv.compile(schema);
const clone = () => JSON.parse(JSON.stringify(manifest));
const mandatoryGates = ["artifact", "signing", "notarization", "feed", "site", "billing", "customer", "runtime", "rollback"];
const provenCandidate = () => {
  const c = clone();
  const digest = "a".repeat(64);
  c.artifact = { ...c.artifact, state: "proven", sha256: digest, workflowRunRef: "run-1", artifactRef: "artifact-1" };
  c.signing = { ...c.signing, state: "proven", artifactSha256: digest };
  c.notarization = { ...c.notarization, state: "proven", artifactSha256: digest };
  c.feed = { ...c.feed, state: "proven", feedUrl: "https://updates.neondiff.com/beta.xml", publicKeyRef: "key-1", artifactUrl: "https://updates.neondiff.com/NeonDiff.zip", artifactSha256: digest, signatureRef: "sig-1" };
  c.site = { ...c.site, state: "proven", downloadUrl: "https://www.neondiff.com/download", releaseNotesUrl: "https://www.neondiff.com/releases/1.1.0-beta.87", artifactSha256: digest };
  c.billing = { ...c.billing, state: "proven", authorityRef: "billing-1", activationRef: "activation-1" };
  c.customer = { ...c.customer, state: "proven" };
  c.runtime = { ...c.runtime, state: "proven", workerVersion: "1.1.0-beta.87-build11091", configIdentitySha256: digest };
  c.rollback = { ...c.rollback, state: "proven", targetVersion: "1.0.4", targetArtifactSha256: "b".repeat(64), targetReleaseRef: "release-1" };
  return c;
};

describe("Desktop candidate manifest contract", () => {
  it("validates an explicit beta candidate and keeps every GA gate visible", () => {
    expect(validate(manifest), JSON.stringify(validate.errors)).toBe(true);
    expect(manifest.schemaVersion).toBe("desktop-candidate-manifest.v1");
    expect(manifest.product).toBe("NeonDiff Desktop");
    expect(manifest.version).toBe("1.1.0-beta.87");
    expect(manifest.releaseLevel).toBe("candidate");
    expect(manifest.channel).toBe("beta");
    expect(manifest.source.commit).toBe("de00a1daf20c27b1d14fff5a5defb9b5597e71b5");
    expect(manifest.contract).toMatchObject({ mode: "byo", paidBetaContract: "paid-mac-beta-byo-v1", byoGitHubEnabled: true, managedBrokerEnabled: false, brokerOrigin: null });
    expect(manifest.artifact.version).toBe(manifest.version);
    expect(manifest.feed.channel).toBe(manifest.channel);
    for (const gate of mandatoryGates) expect(manifest[gate].state).not.toBe("proven");
    expect(manifest.runtime.state).toBe("not-performed");
    expect(manifest.artifact.sha256).toBeNull();
    expect(manifest.feed.artifactSha256).toBeNull();
    expect(manifest.rollback.statePreservationRequired).toBe(true);
  });

  it("rejects checksum drift when both artifact and feed hashes are present", () => {
    const mismatch = clone();
    mismatch.artifact.sha256 = "a".repeat(64);
    mismatch.feed.artifactSha256 = "b".repeat(64);
    expect(validate(mismatch)).toBe(false);
    const aligned = clone();
    aligned.artifact.sha256 = "a".repeat(64);
    aligned.feed.artifactSha256 = "a".repeat(64);
    expect(validate(aligned)).toBe(true);
    const siteMismatch = clone();
    siteMismatch.artifact.sha256 = "a".repeat(64);
    siteMismatch.feed.artifactSha256 = "a".repeat(64);
    siteMismatch.site.artifactSha256 = "b".repeat(64);
    expect(validate(siteMismatch)).toBe(false);
    siteMismatch.site.artifactSha256 = "a".repeat(64);
    expect(validate(siteMismatch)).toBe(true);
  });

  it("binds feed channel, archive identity, URLs, and proof digests", () => {
    const proven = provenCandidate();
    expect(validate(proven), JSON.stringify(validate.errors)).toBe(true);
    const feedChannel = clone();
    feedChannel.feed.channel = "stable";
    expect(validate(feedChannel)).toBe(false);
    const archive = clone();
    archive.artifact.archiveName = "NeonDiff-1.1.0-beta.88-build999-macOS.zip";
    expect(validate(archive)).toBe(false);
    const url = provenCandidate();
    url.feed.feedUrl = "not-a-url";
    expect(validate(url)).toBe(false);
    const signedForOtherArtifact = provenCandidate();
    signedForOtherArtifact.signing.artifactSha256 = "b".repeat(64);
    expect(validate(signedForOtherArtifact)).toBe(false);
  });

  it("rejects stable publication with unfinished gates and mixed licensing modes", () => {
    const stable = clone();
    stable.releaseLevel = "stable";
    stable.channel = "stable";
    expect(validate(stable)).toBe(false);
    const prereleaseStable = provenCandidate();
    prereleaseStable.releaseLevel = "stable";
    prereleaseStable.channel = "stable";
    expect(validate(prereleaseStable)).toBe(false);
    const stableVersion = provenCandidate();
    stableVersion.releaseLevel = "stable";
    stableVersion.channel = "stable";
    stableVersion.version = "1.1.0";
    stableVersion.artifact.version = "1.1.0";
    stableVersion.artifact.archiveName = "NeonDiff-1.1.0-build11091-macOS.zip";
    stableVersion.feed.channel = "stable";
    expect(validate(stableVersion)).toBe(true);
    const mixed = clone();
    mixed.contract.managedBrokerEnabled = true;
    expect(validate(mixed)).toBe(false);
    const billingMismatch = clone();
    billingMismatch.contract = { mode: "managed", paidBetaContract: "paid-mac-beta-v1", byoGitHubEnabled: false, managedBrokerEnabled: true, brokerOrigin: "https://neondiff-license.fly.dev" };
    expect(validate(billingMismatch)).toBe(false);
  });

  it("requires identity and evidence for proven gates", () => {
    const signing = clone();
    signing.signing.state = "proven";
    signing.signing.identity = null;
    signing.signing.evidenceRefs = [];
    expect(validate(signing)).toBe(false);
    const runtime = clone();
    runtime.runtime.state = "proven";
    runtime.runtime.workerVersion = "1.1.0-beta.87-build11091";
    runtime.runtime.configIdentitySha256 = null;
    expect(validate(runtime)).toBe(false);
    const artifact = clone();
    artifact.artifact.state = "proven";
    artifact.artifact.sha256 = null;
    artifact.artifact.workflowRunRef = null;
    artifact.artifact.artifactRef = null;
    expect(validate(artifact)).toBe(false);
    const placeholderScenarios = provenCandidate();
    placeholderScenarios.customer.requiredScenarios = ["placeholder", "placeholder-2", "placeholder-3", "placeholder-4", "placeholder-5"];
    expect(validate(placeholderScenarios)).toBe(false);
    const selfRollback = provenCandidate();
    selfRollback.rollback.targetVersion = selfRollback.version;
    selfRollback.rollback.targetArtifactSha256 = selfRollback.artifact.sha256;
    expect(validate(selfRollback)).toBe(false);
  });

  it("preserves the published CLI manifest and public-safe boundary", () => {
    const cliPath = resolve(root, "docs/public-release-manifest.json");
    const cliManifest = JSON.parse(readFileSync(cliPath, "utf8"));
    expect(cliManifest.version).toBe("v1.0.4");
    expect(cliManifest).not.toHaveProperty("contract");
    expect(createHash("sha256").update(readFileSync(cliPath)).digest("hex")).toBe("9e5aae15c24da42c7197133dfe1b3c9cbc52e9e6578fd2a662b83d55fd4c8b4a");
    expect(`${JSON.stringify(schema)}${JSON.stringify(manifest)}`).not.toContain("/Volumes/LEXAR");
  });
});
