import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "..");
const schema = JSON.parse(readFileSync(resolve(root, "docs/schema/desktop-candidate-manifest.schema.json"), "utf8"));
const manifest = JSON.parse(readFileSync(resolve(root, "docs/release-candidates/v1.1.0-desktop-candidate-manifest.json"), "utf8"));

describe("Desktop candidate manifest contract", () => {
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
    expect(manifest.rollback.statePreservationRequired).toBe(true);
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
