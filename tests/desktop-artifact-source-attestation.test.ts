import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { crc32 } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
const repository = "electricsheephq/evaos-code-review-bot-neondiff";
const workflow = `${repository}/.github/workflows/desktop-accepted-release-packet.yml`;
const predicateType = "https://neondiff.com/attestations/desktop-artifact-source-promotion/v1";
const sourceRef = "refs/heads/main";
const workflowSHA = "4".repeat(40);
const sourceSHA = "1".repeat(40);
const tagObjectSHA = "2".repeat(40);
const acceptedPacketSHA256 = "5".repeat(64);

function u16(bytes: Buffer, offset: number, value: number) { bytes.writeUInt16LE(value, offset); }
function u32(bytes: Buffer, offset: number, value: number) { bytes.writeUInt32LE(value, offset); }
function classicZip() {
  const name = Buffer.from("NeonDiff.app/Contents/Info.plist"), payload = Buffer.from("fixture"), checksum = crc32(payload);
  const local = Buffer.alloc(30 + name.length + payload.length); u32(local, 0, 0x04034b50); u16(local, 4, 20); u16(local, 6, 0x800); u32(local, 14, checksum); u32(local, 18, payload.length); u32(local, 22, payload.length); u16(local, 26, name.length); name.copy(local, 30); payload.copy(local, 30 + name.length);
  const central = Buffer.alloc(46 + name.length); u32(central, 0, 0x02014b50); u16(central, 4, (3 << 8) | 20); u16(central, 6, 20); u16(central, 8, 0x800); u32(central, 16, checksum); u32(central, 20, payload.length); u32(central, 24, payload.length); u16(central, 28, name.length); u32(central, 38, (0o100644 << 16) >>> 0); name.copy(central, 46);
  const eocd = Buffer.alloc(22); u32(eocd, 0, 0x06054b50); u16(eocd, 8, 1); u16(eocd, 10, 1); u32(eocd, 12, central.length); u32(eocd, 16, local.length);
  return Buffer.concat([local, central, eocd]);
}

function fixture(attestedSourceSHA: string) {
  const root = mkdtempSync(join(tmpdir(), "neondiff-artifact-attestation-")); roots.push(root);
  const artifactName = "NeonDiff-1.1.0-build11091-macOS.zip", artifact = join(root, artifactName), artifactBytes = classicZip(), artifactSHA256 = createHash("sha256").update(artifactBytes).digest("hex"); writeFileSync(artifact, artifactBytes);
  const tagRef = join(root, "tag-ref.json"), tagObject = join(root, "tag-object.json"), release = join(root, "release.json"), bundle = join(root, "bundle.json"), output = join(root, "retained"), capture = join(root, "capture.json"); mkdirSync(output);
  writeFileSync(tagRef, JSON.stringify({ ref: "refs/tags/v1.1.0", object: { type: "tag", sha: tagObjectSHA } }));
  writeFileSync(tagObject, JSON.stringify({ sha: tagObjectSHA, tag: "v1.1.0", object: { type: "commit", sha: sourceSHA } }));
  writeFileSync(release, JSON.stringify({ tag_name: "v1.1.0", draft: false, prerelease: false, immutable: true, assets: [{ name: artifactName, size: artifactBytes.length, digest: `sha256:${artifactSHA256}`, browser_download_url: `https://github.com/${repository}/releases/download/v1.1.0/${artifactName}` }] }));
  const predicate = { schemaVersion: 1, claimClass: "neondiff.desktop.artifact-source-promotion.v1", repository, signerWorkflow: workflow, workflowSourceRef: sourceRef, workflowSourceSHA: workflowSHA, releaseTag: "v1.1.0", artifactSourceSHA: attestedSourceSHA, acceptedPacketSHA256, developerIDTeamID: "TC6MS3T6NN" };
  const statement = { _type: "https://in-toto.io/Statement/v1", subject: [{ name: artifactName, digest: { sha256: artifactSHA256 } }], predicateType, predicate };
  const bundleDocument = { mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json", verificationMaterial: { tlogEntries: [{}] }, dsseEnvelope: { payload: Buffer.from(JSON.stringify(statement)).toString("base64"), payloadType: "application/vnd.in-toto+json", signatures: [{ sig: Buffer.alloc(64, 1).toString("base64") }] } }, bundleBytes = Buffer.from(JSON.stringify(bundleDocument)); writeFileSync(bundle, bundleBytes);
  const fakeGh = join(root, "gh"); writeFileSync(fakeGh, `#!/usr/bin/env node
const { readFileSync, writeFileSync } = require("node:fs");
const args = process.argv.slice(2); writeFileSync(process.env.CAPTURE_PATH, JSON.stringify(args));
if (process.env.FAKE_GH_MODE === "fail") process.exit(1);
const bundlePath = args[args.indexOf("--bundle") + 1], document = JSON.parse(readFileSync(bundlePath, "utf8")), statement = JSON.parse(Buffer.from(document.dsseEnvelope.payload, "base64").toString("utf8"));
if (process.env.FAKE_GH_MODE === "wrong-result-source") statement.predicate.artifactSourceSHA = "9".repeat(40);
if (process.env.FAKE_GH_MODE === "wrong-result-subject") statement.subject[0].digest.sha256 = "9".repeat(64);
if (process.env.FAKE_GH_MODE === "wrong-result-packet") statement.predicate.acceptedPacketSHA256 = "8".repeat(64);
process.stdout.write(JSON.stringify([{ verificationResult: { statement } }]));
`); chmodSync(fakeGh, 0o755);
  const run = (mode = "success", env: Record<string, string> = {}, args = ["--artifact", artifact, "--bundle", bundle, "--tag-ref", tagRef, "--tag-object", tagObject, "--release", release, "--output-directory", output]) => spawnSync(process.execPath, ["scripts/verify-desktop-artifact-source-attestation.mjs", ...args], { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, PATH: `${root}:${process.env.PATH}`, CAPTURE_PATH: capture, FAKE_GH_MODE: mode, GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: repository, GITHUB_REF: sourceRef, GITHUB_SHA: workflowSHA, GITHUB_WORKFLOW_REF: `${workflow}@${sourceRef}`, RUNNER_ENVIRONMENT: "github-hosted", ...env } });
  return { root, artifact, tagRef, tagObject, release, bundle, bundleBytes, capture, output, artifactName, artifactSHA256, run };
}

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("Desktop artifact-source promotion attestation", () => {
  it("rejects an otherwise exact artifact statement bound to the wrong peeled source SHA", () => {
    const value = fixture("3".repeat(40)), result = value.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("artifact source attestation verification failed");
    expect(existsSync(value.capture)).toBe(false);
  });

  it("verifies and retains one content-addressed bundle under fixed GitHub identity", () => {
    const value = fixture(sourceSHA), result = value.run(); expect(result.status).toBe(0); const receipt = JSON.parse(result.stdout), bundleSHA256 = createHash("sha256").update(value.bundleBytes).digest("hex"), retained = join(value.output, `${bundleSHA256}.artifact-source-attestation.json`);
    expect(receipt).toEqual({ verified: true, artifactName: value.artifactName, artifactSHA256: value.artifactSHA256, artifactByteLength: readFileSync(value.artifact).length, artifactSourceSHA: sourceSHA, workflowSourceSHA: workflowSHA, acceptedPacketSHA256, predicateType, bundleSHA256, bundleFileName: `${bundleSHA256}.artifact-source-attestation.json` });
    expect(readFileSync(retained)).toEqual(value.bundleBytes); expect(statSync(retained).mode & 0o777).toBe(0o600);
    const args = JSON.parse(readFileSync(value.capture, "utf8")); expect(args.slice(0, 3)).toEqual(["attestation", "verify", expect.any(String)]); expect(args[2]).not.toBe(value.artifact); expect(args.slice(3)).toEqual(["--bundle", expect.any(String), "--repo", repository, "--signer-workflow", workflow, "--predicate-type", predicateType, "--source-ref", sourceRef, "--source-digest", workflowSHA, "--deny-self-hosted-runners", "--format", "json"]); expect(args[4]).not.toBe(value.bundle);
    expect(result.stdout).not.toContain(value.root);
  });

  it("fails closed for untrusted verification output, runner identity, and unsafe evidence", () => {
    expect(fixture(sourceSHA).run("fail").status).not.toBe(0);
    expect(fixture(sourceSHA).run("wrong-result-source").status).not.toBe(0);
    expect(fixture(sourceSHA).run("wrong-result-subject").status).not.toBe(0);
    expect(fixture(sourceSHA).run("wrong-result-packet").status).not.toBe(0);
    expect(fixture(sourceSHA).run("success", { RUNNER_ENVIRONMENT: "self-hosted" }).status).not.toBe(0);
    expect(fixture(sourceSHA).run("success", { GITHUB_REPOSITORY: "attacker/example" }).status).not.toBe(0);
    const linked = fixture(sourceSHA), alias = join(linked.root, "bundle-link.json"); symlinkSync(linked.bundle, alias); expect(linked.run("success", {}, ["--artifact", linked.artifact, "--bundle", alias, "--tag-ref", linked.tagRef, "--tag-object", linked.tagObject, "--release", linked.release, "--output-directory", linked.output]).status).not.toBe(0);
    const oversized = fixture(sourceSHA); truncateSync(oversized.bundle, 4 * 1024 * 1024 + 1); expect(oversized.run().status).not.toBe(0);
    const extra = fixture(sourceSHA), document = JSON.parse(readFileSync(extra.bundle, "utf8")), statement = JSON.parse(Buffer.from(document.dsseEnvelope.payload, "base64").toString("utf8")); statement.predicate.synthetic = true; document.dsseEnvelope.payload = Buffer.from(JSON.stringify(statement)).toString("base64"); writeFileSync(extra.bundle, JSON.stringify(document)); expect(extra.run().status).not.toBe(0);
    const mutations = [(value: any) => { value.predicate.repository = "attacker/example"; }, (value: any) => { value.predicate.signerWorkflow = "attacker/example/.github/workflows/release.yml"; }, (value: any) => { value.predicate.workflowSourceSHA = "8".repeat(40); }, (value: any) => { value.predicate.releaseTag = "v1.1.0-rc.1"; }, (value: any) => { value.predicate.acceptedPacketSHA256 = "not-a-digest"; }, (value: any) => { value.predicate.developerIDTeamID = "ATTACKER00"; }, (value: any) => { value.predicateType = "https://slsa.dev/provenance/v1"; }];
    for (const mutate of mutations) { const changed = fixture(sourceSHA), raw = JSON.parse(readFileSync(changed.bundle, "utf8")), value = JSON.parse(Buffer.from(raw.dsseEnvelope.payload, "base64").toString("utf8")); mutate(value); raw.dsseEnvelope.payload = Buffer.from(JSON.stringify(value)).toString("base64"); writeFileSync(changed.bundle, JSON.stringify(raw)); expect(changed.run().status).not.toBe(0); }
  }, 20_000);

  it("keeps promotion authority fixed and verifies before packet construction", () => {
    const workflowSource = readFileSync(".github/workflows/desktop-accepted-release-packet.yml", "utf8"), verifierSource = readFileSync("scripts/lib/desktop-artifact-source-attestation.mjs", "utf8"), builderSource = readFileSync("scripts/build-desktop-accepted-release-packet.mjs", "utf8");
    expect(workflowSource).toMatch(/workflow_dispatch:\s*\n/); expect(workflowSource).not.toMatch(/workflow_dispatch:\s*\n\s+inputs:/); expect(workflowSource).not.toMatch(/^permissions:/m); expect(workflowSource).toContain("  promote-stable-artifact:\n    name: Verify source binding and build accepted packet\n    needs: resolve-retained-evidence\n    permissions:\n      contents: read\n      id-token: write\n      attestations: write"); expect(workflowSource).toContain("npm ci --ignore-scripts --omit=dev"); expect(workflowSource).not.toMatch(/run: npm ci\s*$/m); expect(workflowSource).not.toContain("cache: npm"); expect(workflowSource).toContain("github.ref == 'refs/heads/main'"); expect(workflowSource).toContain("runs-on: macos-15"); expect(workflowSource).not.toMatch(/runs-on:\s*\[[^\]]*self-hosted|runs-on:\s*self-hosted/); expect(workflowSource).toContain('test "$GITHUB_SHA" = "$(git rev-parse origin/main)"'); expect(workflowSource).toContain('test "$GITHUB_SHA" = "$CURRENT_MAIN_SHA"');
    expect(workflowSource).toContain("actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6 # v4"); expect(workflowSource).not.toContain("actions/attest-build-provenance"); expect(workflowSource).toContain(`PREDICATE_TYPE: ${predicateType}`); expect(workflowSource).toContain("TeamIdentifier=$DEVELOPER_ID_TEAM_ID"); expect(workflowSource).toMatch(/codesign --verify/); expect(workflowSource).toMatch(/stapler validate/); expect(workflowSource).toMatch(/spctl --assess/); expect(workflowSource).toContain("Print :NeonDiffSourceSHA");
    expect(workflowSource).toContain("acceptedPacketSHA256:$acceptedPacketSHA256");
    expect(verifierSource).toContain('"--repo", REPOSITORY'); expect(verifierSource).toContain('"--signer-workflow", SIGNER_WORKFLOW'); expect(verifierSource).toContain('"--predicate-type", DESKTOP_ARTIFACT_SOURCE_PREDICATE_TYPE'); expect(verifierSource).toContain('"--source-ref", SOURCE_REF'); expect(verifierSource).toContain('"--source-digest", workflowSHA'); expect(verifierSource).toContain('"--deny-self-hosted-runners"');
    expect(builderSource.indexOf("verifyAndRetainDesktopArtifactSourceAttestation")).toBeLessThan(builderSource.indexOf("buildAcceptedDesktopReleasePacket(values.index")); expect(builderSource).toContain("packetSHA256 !== attestation.acceptedPacketSHA256"); expect(builderSource).not.toMatch(/private.?key|secret/i);
  });
});
