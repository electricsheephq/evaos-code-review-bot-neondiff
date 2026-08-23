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
  });

  it("rejects stable publication with unfinished gates and mixed licensing modes", () => {
    const stable = clone();
    stable.releaseLevel = "stable";
    stable.channel = "stable";
    expect(validate(stable)).toBe(false);
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
