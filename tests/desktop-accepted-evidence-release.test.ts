import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";

const roots: string[] = [];
const repository = "electricsheephq/evaos-code-review-bot-neondiff";
const workflow = `${repository}/.github/workflows/desktop-accepted-release-packet.yml`;
const sourceRef = "refs/heads/main";
const evidenceTag = "neondiff-accepted-packet-v1.1.0";
const evidenceReleaseName = "NeonDiff accepted packet evidence v1.1.0";
const sourceSHA = "1".repeat(40);
const storedWorkflowSHA = "2".repeat(40);
const currentWorkflowSHA = "8".repeat(40);
const tagObjectSHA = "3".repeat(40);

function sha256(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "neondiff-retained-evidence-"));
  roots.push(root);
  const releaseDownload = join(root, "release-download");
  const actionsArtifact = join(root, "expired-actions-artifact");
  mkdirSync(releaseDownload);

  const artifactName = "NeonDiff-1.1.0-build11091-macOS.zip";
  const artifactBytes = Buffer.alloc(4096, 4), artifactSHA256 = sha256(artifactBytes), artifactPath = join(releaseDownload, artifactName);
  writeFileSync(artifactPath, artifactBytes);
  const packet = {
    schemaVersion: 3,
    kind: "neondiff.desktop.accepted-release-packet-v3",
    verified: true,
    channel: "stable",
    version: "1.1.0",
    build: "11091",
    tag: "v1.1.0",
    sourceSHA,
    artifactSourceSHA: sourceSHA,
    tagObjectSHA,
    artifactURL: `https://github.com/${repository}/releases/download/v1.1.0/${artifactName}`,
    artifactName,
    artifactByteLength: artifactBytes.length,
    artifactSHA256,
    treeSHA256: "5".repeat(64),
    feedSHA256: "6".repeat(64),
    feedEntry: {
      url: `https://github.com/${repository}/releases/download/v1.1.0/${artifactName}`,
      length: 4096,
      type: "application/octet-stream",
      version: "1.1.0",
      build: "11091",
      shortVersionString: "1.1.0",
      minimumSystemVersion: "13.0",
      channel: "stable",
      edSignature: "fixture"
    },
    enclosureProofSHA256: "7".repeat(64),
    releaseContract: "paid-mac-ga-byo-v1",
    productionContract: { contract: "paid-mac-beta-byo-v1", byoGitHubEnabled: true, managedGitHubBrokerEnabledPresent: false, githubBrokerOriginPresent: false },
    npmReleaseClass: "desktop-only"
  };
  const packetBytes = Buffer.from(`${JSON.stringify(packet)}\n`), packetSHA256 = sha256(packetBytes), packetName = `${packetSHA256}.packet.json`, packetPath = join(releaseDownload, packetName);
  writeFileSync(packetPath, packetBytes);

  const predicate = { schemaVersion: 1, claimClass: "neondiff.desktop.artifact-source-promotion.v1", repository, signerWorkflow: workflow, workflowSourceRef: sourceRef, workflowSourceSHA: storedWorkflowSHA, releaseTag: "v1.1.0", artifactSourceSHA: sourceSHA, acceptedPacketSHA256: packetSHA256, developerIDTeamID: "TC6MS3T6NN" };
  const statement = { _type: "https://in-toto.io/Statement/v1", subject: [{ name: artifactName, digest: { sha256: artifactSHA256 } }], predicateType: "https://neondiff.com/attestations/desktop-artifact-source-promotion/v1", predicate };
  const bundle = { mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json", verificationMaterial: { tlogEntries: [{}] }, dsseEnvelope: { payload: Buffer.from(JSON.stringify(statement)).toString("base64"), payloadType: "application/vnd.in-toto+json", signatures: [{ sig: Buffer.alloc(64, 1).toString("base64") }] } };
  const bundleBytes = Buffer.from(JSON.stringify(bundle)), bundleSHA256 = sha256(bundleBytes), bundleName = `${bundleSHA256}.artifact-source-attestation.json`, bundlePath = join(releaseDownload, bundleName);
  writeFileSync(bundlePath, bundleBytes);

  const releasePath = join(root, "release.json");
  writeFileSync(releasePath, JSON.stringify({
    tag_name: evidenceTag,
    name: evidenceReleaseName,
    draft: false,
    prerelease: true,
    immutable: true,
    target_commitish: sourceSHA,
    html_url: `https://github.com/${repository}/releases/tag/${evidenceTag}`,
    assets: [
      { name: packetName, size: packetBytes.length, digest: `sha256:${packetSHA256}`, browser_download_url: `https://github.com/${repository}/releases/download/${evidenceTag}/${packetName}` },
      { name: bundleName, size: bundleBytes.length, digest: `sha256:${bundleSHA256}`, browser_download_url: `https://github.com/${repository}/releases/download/${evidenceTag}/${bundleName}` }
    ]
  }));
  const tagRefPath = join(root, "tag-ref.json");
  writeFileSync(tagRefPath, JSON.stringify({ ref: `refs/tags/${evidenceTag}`, object: { type: "commit", sha: sourceSHA } }));

  const capturePath = join(root, "gh-calls.jsonl"), fakeGh = join(root, "gh");
  writeFileSync(fakeGh, `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(process.env.CAPTURE_PATH, JSON.stringify(args) + "\\n");
if (process.env.FAKE_GH_FAIL === args.slice(0, 3).join(" ") || process.env.FAKE_GH_FAIL === args.slice(0, 2).join(" ")) process.exit(1);
process.stdout.write(args[0] === "attestation" ? process.env.FAKE_ATTESTATION_RESULT + "\\n" : "{}\\n");
`);
  chmodSync(fakeGh, 0o755);

  const run = (paths: Record<string, string> = {}, env: Record<string, string> = {}) => spawnSync(process.execPath, [
    "scripts/verify-desktop-accepted-evidence-release.mjs",
    "--artifact", paths.artifact ?? artifactPath,
    "--packet", paths.packet ?? packetPath,
    "--bundle", paths.bundle ?? bundlePath,
    "--release", paths.release ?? releasePath,
    "--tag-ref", paths.tagRef ?? tagRefPath
  ], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 1500,
    env: {
      ...process.env,
      PATH: `${root}:${process.env.PATH}`,
      CAPTURE_PATH: capturePath,
      FAKE_ATTESTATION_RESULT: JSON.stringify([{ verificationResult: { statement } }]),
      GITHUB_ACTIONS: "true",
      GITHUB_REPOSITORY: repository,
      GITHUB_REF: sourceRef,
      GITHUB_SHA: currentWorkflowSHA,
      GITHUB_WORKFLOW_REF: `${workflow}@${sourceRef}`,
      RUNNER_ENVIRONMENT: "github-hosted",
      ...env
    }
  });
  return { actionsArtifact, artifactName, artifactPath, bundleName, bundlePath, bundleSHA256, capturePath, packetName, packetPath, packetSHA256, releasePath, root, run };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("retained accepted Desktop evidence", () => {
  it("reloads the prior immutable pair after Actions expiry and a later main workflow SHA", () => {
    const value = fixture();
    expect(existsSync(value.actionsArtifact)).toBe(false);
    const result = value.run();
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      retained: true,
      repository,
      releaseTag: evidenceTag,
      artifactSourceSHA: sourceSHA,
      workflowSourceSHA: storedWorkflowSHA,
      packetSHA256: value.packetSHA256,
      packetFileName: value.packetName,
      artifactAttestationBundleSHA256: value.bundleSHA256,
      artifactAttestationBundleFileName: value.bundleName
    });
    const calls = readFileSync(value.capturePath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(calls).toEqual([
      ["release", "verify", evidenceTag, "--repo", repository, "--format", "json"],
      ["release", "verify-asset", evidenceTag, expect.stringMatching(new RegExp(`${value.packetName}$`)), "--repo", repository, "--format", "json"],
      ["release", "verify-asset", evidenceTag, expect.stringMatching(new RegExp(`${value.bundleName}$`)), "--repo", repository, "--format", "json"],
      ["attestation", "verify", expect.stringMatching(new RegExp(`${value.artifactName}$`)), "--bundle", expect.stringMatching(new RegExp(`${value.bundleName}$`)), "--repo", repository, "--signer-workflow", workflow, "--predicate-type", "https://neondiff.com/attestations/desktop-artifact-source-promotion/v1", "--source-ref", sourceRef, "--source-digest", storedWorkflowSHA, "--deny-self-hosted-runners", "--format", "json"]
    ]);
  });

  it("fails closed for special files, mutable identity, duplicate assets, and failed GitHub verification", () => {
    const linked = fixture(), linkedRoot = join(linked.root, "linked-download"); mkdirSync(linkedRoot);
    const packetLink = join(linkedRoot, linked.packetName); symlinkSync(linked.packetPath, packetLink);
    expect(linked.run({ packet: packetLink }).status).not.toBe(0);

    const fifo = fixture(), fifoPath = join(fifo.root, fifo.packetName); expect(spawnSync("mkfifo", [fifoPath]).status).toBe(0);
    const fifoResult = fifo.run({ packet: fifoPath }); expect(fifoResult.error).toBeUndefined(); expect(fifoResult.status).not.toBe(0);
    const oversized = fixture(); truncateSync(oversized.bundlePath, 4 * 1024 * 1024 + 1); expect(oversized.run().status).not.toBe(0);

    const duplicate = fixture(), duplicateRelease = JSON.parse(readFileSync(duplicate.releasePath, "utf8"));
    duplicateRelease.assets.push({ ...duplicateRelease.assets[0], digest: `sha256:${"9".repeat(64)}` }); writeFileSync(duplicate.releasePath, JSON.stringify(duplicateRelease));
    expect(duplicate.run().status).not.toBe(0);
    const wrongTarget = fixture(), wrongRelease = JSON.parse(readFileSync(wrongTarget.releasePath, "utf8"));
    wrongRelease.target_commitish = "9".repeat(40); writeFileSync(wrongTarget.releasePath, JSON.stringify(wrongRelease)); expect(wrongTarget.run().status).not.toBe(0);
    expect(fixture().run({}, { GITHUB_REPOSITORY: "attacker/example" }).status).not.toBe(0);
    expect(fixture().run({}, { FAKE_GH_FAIL: `release verify ${evidenceTag}` }).status).not.toBe(0);
    expect(fixture().run({}, { FAKE_GH_FAIL: "attestation verify" }).status).not.toBe(0);
    expect(fixture().run({}, { FAKE_ATTESTATION_RESULT: "[]" }).status).not.toBe(0);
    const changedArtifact = fixture(); writeFileSync(changedArtifact.artifactPath, Buffer.alloc(4096, 9)); expect(changedArtifact.run().status).not.toBe(0);
    const forgedPacket = fixture(), forged = JSON.parse(readFileSync(forgedPacket.packetPath, "utf8")); forged.treeSHA256 = "9".repeat(64);
    const forgedBytes = Buffer.from(`${JSON.stringify(forged)}\n`), forgedSHA256 = sha256(forgedBytes), forgedName = `${forgedSHA256}.packet.json`, forgedPath = join(forgedPacket.root, "release-download", forgedName); writeFileSync(forgedPath, forgedBytes);
    const forgedRelease = JSON.parse(readFileSync(forgedPacket.releasePath, "utf8")); forgedRelease.assets[0] = { name: forgedName, size: forgedBytes.length, digest: `sha256:${forgedSHA256}`, browser_download_url: `https://github.com/${repository}/releases/download/${evidenceTag}/${forgedName}` }; writeFileSync(forgedPacket.releasePath, JSON.stringify(forgedRelease)); expect(forgedPacket.run({ packet: forgedPath }).status).not.toBe(0);
  });

  it("resolves retained state before scheduling the producer or verifier", () => {
    const workflowSource = readFileSync(".github/workflows/desktop-accepted-release-packet.yml", "utf8"), builderSource = readFileSync("scripts/build-desktop-accepted-release-packet.mjs", "utf8");
    const workflowDocument = parse(workflowSource) as { jobs: Record<string, any> };
    const resolver = workflowDocument.jobs["resolve-retained-evidence"];
    const producer = workflowDocument.jobs["promote-stable-artifact"];
    const retention = workflowDocument.jobs["retain-accepted-packet"];

    expect(resolver).toBeDefined();
    expect(resolver.needs).toBeUndefined();
    expect(resolver.permissions).toEqual({ contents: "read" });
    expect(resolver.outputs).toEqual({ state: "${{ steps.retained.outputs.state }}" });
    expect(resolver.if).toBe("${{ github.ref == 'refs/heads/main' }}");

    expect(producer.needs).toBe("resolve-retained-evidence");
    expect(producer.if).toContain("github.ref == 'refs/heads/main'");
    expect(producer.if).toContain("needs.resolve-retained-evidence.outputs.state == 'absent'");

    expect(retention.needs).toEqual(["resolve-retained-evidence", "promote-stable-artifact"]);
    expect(retention.if).toContain("always()");
    expect(retention.if).toContain("needs.resolve-retained-evidence.result == 'success'");
    expect(retention.if).toContain("needs.resolve-retained-evidence.outputs.state == 'present'");
    expect(retention.if).toContain("needs.promote-stable-artifact.result == 'skipped'");
    expect(retention.if).toContain("needs.resolve-retained-evidence.outputs.state == 'absent'");
    expect(retention.if).toContain("needs.promote-stable-artifact.result == 'success'");
    expect(retention.env.RETENTION_STATE).toBe("${{ needs.resolve-retained-evidence.outputs.state }}");
    const downloadStep = retention.steps.find((step: Record<string, any>) => typeof step.uses === "string" && step.uses.startsWith("actions/download-artifact@"));
    expect(downloadStep.if).toBe("${{ env.RETENTION_STATE == 'absent' }}");

    expect(workflowSource).toContain("if test \"$RETENTION_STATE\" = \"absent\"; then");
    expect(workflowSource).toContain("[.assets[].name | select(test(\"^[a-f0-9]{64}");
    expect(workflowSource).toContain("test \"$PACKET_NAME\" = \"$CURRENT_PACKET_NAME\"");
    expect(workflowSource).toContain("test \"$(jq -er '.workflowSourceSHA' <<< \"$RETENTION_RESULT\")\" = \"$GITHUB_SHA\"");
    const immutableSettingCheck = workflowSource.indexOf('gh api "repos/$REPOSITORY/immutable-releases" --silent'), releaseCreation = workflowSource.indexOf('gh release create "$EVIDENCE_TAG"'); expect(immutableSettingCheck).toBeGreaterThan(-1); expect(immutableSettingCheck).toBeLessThan(releaseCreation);
    expect(workflowSource).toContain("gh release download \"$RELEASE_TAG\"");
    expect(workflowSource).toContain("--artifact \"$RETRIEVED_ROOT/$ARTIFACT_NAME\"");
    expect(workflowSource.indexOf("Verify artifact attestation and build accepted packet")).toBeLessThan(workflowSource.indexOf("Upload source-bound packet evidence"));
    expect(builderSource.indexOf("verifyAndRetainDesktopArtifactSourceAttestation")).toBeLessThan(builderSource.indexOf("buildAcceptedDesktopReleasePacket(values.index"));
    expect(workflowSource).not.toMatch(/gh release delete|gh api[^\n]*-X DELETE/);
  });
});
