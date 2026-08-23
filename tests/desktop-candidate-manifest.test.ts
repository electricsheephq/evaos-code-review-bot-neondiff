import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { Ajv2020 } from "ajv/dist/2020.js";
import { compareSemver, validateDesktopReleaseManifest, validateManifestIndex } from "../scripts/validate-desktop-candidate-manifest.mjs";
const commit = "a".repeat(40);
const artifactSha = "a".repeat(64);
const rollbackSha = "b".repeat(64);
const evidence = ["synthetic fixture evidence"];
const url = "https://evidence.neondiff.com/receipt";
class AcceptingAjv { compile() { return () => true; } }
const gate = (state = "pending") => ({ state, artifactSha256: state === "proven" ? artifactSha : null, evidenceRefs: evidence });
function template() {
  return {
    schemaVersion: "desktop-release-manifest.v1", manifestKind: "desktop-release", product: "NeonDiff Desktop", version: "1.1.0-beta.1", releaseLevel: "template", channel: "beta",
    contract: { mode: "byo", paidContract: "paid-mac-beta-byo-v1", byoGitHubEnabled: true, managedBrokerEnabled: false, brokerOrigin: null },
    source: { repository: "electricsheephq/evaos-code-review-bot-neondiff", commit, ref: `sha:${commit}`, cleanCheckout: true, workflowRunRef: null, artifactRef: null },
    artifact: { state: "pending", version: "1.1.0-beta.1", bundleId: "com.electricsheephq.NeonDiffDesktop", appPath: "NeonDiff.app", archiveName: "NeonDiff-1.1.0-beta.1-build1-macOS.zip", build: "1", sha256: null, workflowRunRef: null, artifactRef: null, evidenceRefs: evidence },
    signing: { state: "pending", identity: null, teamIdentifier: null, artifactSha256: null, evidenceRefs: evidence }, notarization: gate(), stapling: gate(),
    postStapleCodeSign: { state: "pending", identity: null, teamIdentifier: null, artifactSha256: null, evidenceRefs: evidence }, gatekeeper: { ...gate(), assessment: null },
    feed: { state: "pending", channel: "beta", embeddedFeedUrl: null, feedUrl: null, publicKeyIdentity: null, publicKeyRef: null, artifactUrl: null, artifactSha256: null, signatureRef: null, evidenceRefs: evidence },
    site: { state: "pending", productUrl: "https://www.neondiff.com/mac-beta", downloadUrl: null, releaseNotesUrl: null, artifactSha256: null, evidenceRefs: evidence },
    billing: gate(), customer: { state: "pending", canaryRef: null, requiredScenarios: ["install", "launch", "update", "rollback", "billing"], evidenceRefs: evidence },
    runtime: { state: "pending", workerVersion: null, artifactSha256: null, configIdentitySha256: null, evidenceRefs: evidence },
    rollback: { state: "pending", targetVersion: null, targetArtifactSha256: null, targetReleaseRef: null, targetSignatureRef: null, targetPublicKeyRef: null, statePreservationRequired: true, evidenceRefs: evidence },
    references: { roadmap: url, execution: url, updater: url, desktopEvaluation: url, packaging: url }, proofBoundary: { allows: ["template shape only"], excludes: ["This is not a release candidate."] }
  };
}
function stable() {
  const m = template();
  Object.assign(m, { version: "1.1.0", releaseLevel: "stable", channel: "stable", contract: { ...m.contract, paidContract: "paid-mac-ga-byo-v1" } });
  const run = "https://github.com/electricsheephq/evaos-code-review-bot-neondiff/actions/runs/123";
  const artifact = `${run}/artifacts/456`;
  Object.assign(m.source, { workflowRunRef: run, artifactRef: artifact });
  Object.assign(m.artifact, { state: "proven", version: "1.1.0", archiveName: "NeonDiff-1.1.0-build1-macOS.zip", sha256: artifactSha, workflowRunRef: run, artifactRef: artifact });
  const id = "Developer ID Application: NeonDiff Distribution (ABCDE12345)";
  Object.assign(m.signing, { state: "proven", identity: id, teamIdentifier: "ABCDE12345", artifactSha256: artifactSha });
  Object.assign(m.postStapleCodeSign, { state: "proven", identity: id, teamIdentifier: "ABCDE12345", artifactSha256: artifactSha });
  for (const name of ["notarization", "stapling", "billing"]) Object.assign(m[name], { state: "proven", artifactSha256: artifactSha });
  Object.assign(m.gatekeeper, { state: "proven", assessment: "accepted", artifactSha256: artifactSha });
  Object.assign(m.feed, { state: "proven", channel: "stable", embeddedFeedUrl: "https://updates.neondiff.com/stable.xml", feedUrl: "https://updates.neondiff.com/stable.xml", publicKeyIdentity: "NeonDiff stable EdDSA key", publicKeyRef: url, artifactUrl: "https://downloads.neondiff.com/1.1.0.zip", artifactSha256: artifactSha, signatureRef: url });
  Object.assign(m.site, { state: "proven", downloadUrl: "https://downloads.neondiff.com/1.1.0.zip", releaseNotesUrl: "https://www.neondiff.com/releases/1.1.0", artifactSha256: artifactSha });
  Object.assign(m.customer, { state: "proven", canaryRef: url });
  Object.assign(m.runtime, { state: "proven", workerVersion: "1.1.0", artifactSha256: artifactSha, configIdentitySha256: "c".repeat(64) });
  Object.assign(m.rollback, { state: "proven", targetVersion: "1.0.4", targetArtifactSha256: rollbackSha, targetReleaseRef: "https://github.com/electricsheephq/evaos-code-review-bot-neondiff/releases/tag/v1.0.4", targetSignatureRef: url, targetPublicKeyRef: url });
  m.proofBoundary.excludes = ["No claims beyond this manifest contract."]; return m;
}
describe("Desktop release manifest contract", () => {
  it("fails closed when Ajv is unavailable, including for no manifest", () => {
    expect(validateDesktopReleaseManifest(undefined, { ajv: null })).toEqual({ valid: false, errors: ["schema validator unavailable"] });
  });
  it("accepts only an explicitly non-candidate pending template", () => {
    expect(validateDesktopReleaseManifest(template(), { ajv: AcceptingAjv })).toEqual({ valid: true, errors: [] });
    const bad = template(); bad.proofBoundary.excludes = ["pending only"];
    expect(validateDesktopReleaseManifest(bad, { ajv: AcceptingAjv }).valid).toBe(false);
  });
  it("uses SemVer prerelease precedence and stable GA proof", () => {
    expect(compareSemver("1.1.0-beta.10", "1.1.0-beta.2")).toBeGreaterThan(0);
    expect(compareSemver("1.0.0-beta.100000000000000000000", "1.0.0-beta.99999999999999999999")).toBeGreaterThan(0);
    expect(compareSemver("1.1.0", "1.1.0-rc.1")).toBeGreaterThan(0);
    expect(validateDesktopReleaseManifest(stable(), { ajv: Ajv2020 })).toEqual({ valid: true, errors: [] });
  });
  it("rejects schema identity, source, feed, runtime, URL, and rollback counterexamples", () => {
    const bad = stable(); bad.product = "wrong"; expect(validateDesktopReleaseManifest(bad, { ajv: Ajv2020 }).valid).toBe(false);
    const source = stable(); source.source.commit = "0".repeat(40); expect(validateDesktopReleaseManifest(source, { ajv: AcceptingAjv }).valid).toBe(false);
    const feed = stable(); feed.feed.embeddedFeedUrl = "https://updates.neondiff.com/other.xml";
    expect(validateDesktopReleaseManifest(feed, { ajv: AcceptingAjv }).valid).toBe(false);
    const runtime = stable(); runtime.runtime.configIdentitySha256 = " ".repeat(64);
    expect(validateDesktopReleaseManifest(runtime, { ajv: AcceptingAjv }).valid).toBe(false);
    const urlBad = stable(); urlBad.site.productUrl = "https://user:pass@www.neondiff.com";
    expect(validateDesktopReleaseManifest(urlBad, { ajv: AcceptingAjv }).valid).toBe(false);
    const rollback = stable(); rollback.rollback.targetVersion = "1.1.0";
    expect(validateDesktopReleaseManifest(rollback, { ajv: AcceptingAjv }).valid).toBe(false);
    const boundary = stable(); boundary.proofBoundary.excludes = ["This is not a release candidate."]; expect(validateDesktopReleaseManifest(boundary, { ajv: AcceptingAjv }).valid).toBe(false);
    const bypasses = [
      (() => { const m = stable(); Object.assign(m.source, { workflowRunRef: null, artifactRef: null }); Object.assign(m.artifact, { workflowRunRef: null, artifactRef: null }); return m; })(),
      (() => { const m = stable(), other = "https://github.com/electricsheephq/evaos-code-review-bot-neondiff/actions/runs/124/artifacts/456"; Object.assign(m.source, { artifactRef: other }); Object.assign(m.artifact, { artifactRef: other }); return m; })(),
      (() => { const m = stable(); m.gatekeeper.assessment = null; return m; })(),
      (() => { const m = stable(); m.feed.artifactUrl = "https://downloads.neondiff.com/other.zip"; return m; })(),
      (() => { const m = stable(); m.proofBoundary.excludes = ["Gatekeeper isn't proven", "The feed won't be published", "Rollback cannot be proven"]; return m; })()
    ];
    for (const manifest of bypasses) expect(validateDesktopReleaseManifest(manifest, { ajv: AcceptingAjv }).valid).toBe(false);
  });
  it("requires the explicit index and fails closed without Ajv", () => {
    expect(validateManifestIndex("docs/release-candidates/desktop-manifests.index.json", { ajv: Ajv2020 })).toEqual({ valid: true, errors: [] });
    expect(validateManifestIndex("docs/release-candidates/desktop-manifests.index.json", { ajv: null })).toEqual({ valid: false, errors: ["schema validator unavailable"] });
  });
  it("rejects an unindexed versioned manifest", () => {
    const dir = mkdtempSync(`${tmpdir()}/desktop-manifest-`), index = `${dir}/desktop-manifests.index.json`;
    writeFileSync(index, JSON.stringify({ schemaVersion: "desktop-release-manifest-index.v1", status: "no-versioned-manifest", manifestPaths: [], reason: "deferred until frozen source; not a release candidate" }));
    writeFileSync(`${dir}/v1.1.0-desktop-template.json`, "{}");
    expect(validateManifestIndex(index, { ajv: Ajv2020 }).valid).toBe(false); rmSync(dir, { recursive: true, force: true });
  });
});
