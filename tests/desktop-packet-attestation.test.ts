import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [], verifier = "scripts/verify-desktop-packet-attestation.mjs", retainer = "scripts/retain-desktop-packet-attestation.mjs", builder = "scripts/build-desktop-accepted-release-packet.mjs", workflowPath = ".github/workflows/desktop-accepted-release-packet.yml";
const repository = "electricsheephq/evaos-code-review-bot-neondiff", signerWorkflow = `${repository}/${workflowPath}`, sourceRef = "refs/heads/main";
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "neondiff-packet-attestation-")); roots.push(root); const bytes = Buffer.from('{"kind":"synthetic-accepted-packet"}\n'), packetSHA256 = createHash("sha256").update(bytes).digest("hex"), packet = join(root, `${packetSHA256}.packet.json`), bin = join(root, "bin"), capture = join(root, "args.json");
  writeFileSync(packet, bytes); writeFileSync(join(root, "gh"), `#!/usr/bin/env node
const { createHash } = require("node:crypto"), { readFileSync, writeFileSync } = require("node:fs"), { basename } = require("node:path");
const args = process.argv.slice(2), packet = args[2]; writeFileSync(process.env.CAPTURE_PATH, JSON.stringify(args));
if (process.env.FAKE_GH_MODE === "fail") { process.stderr.write("no canonical attestation"); process.exit(1); }
if (process.env.FAKE_GH_MODE === "malformed") { process.stdout.write("{"); process.exit(0); }
const actual = createHash("sha256").update(readFileSync(packet)).digest("hex"), digest = process.env.FAKE_GH_MODE === "wrong-subject" ? "0".repeat(64) : actual;
process.stdout.write(JSON.stringify([{ verificationResult: { statement: { predicateType: "https://slsa.dev/provenance/v1", subject: [{ name: basename(packet), digest: { sha256: digest } }] } } }]));
`); chmodSync(join(root, "gh"), 0o755); symlinkSync(join(root, "gh"), bin);
  const run = (mode = "success", args = ["--packet", packet]) => spawnSync(process.execPath, [verifier, ...args], { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, PATH: `${root}:${process.env.PATH}`, CAPTURE_PATH: capture, FAKE_GH_MODE: mode } });
  return { root, packet, packetSHA256, capture, run };
}

function bundleFixture(mode: "valid" | "wrong-subject" | "malformed" = "valid") {
  const root = mkdtempSync(join(tmpdir(), "neondiff-packet-bundle-")); roots.push(root); const output = join(root, "retained"); mkdirSync(output);
  const packetSHA256 = "a".repeat(64), packetName = `${packetSHA256}.packet.json`, statement = { _type: "https://in-toto.io/Statement/v1", predicateType: "https://slsa.dev/provenance/v1", subject: [{ name: packetName, digest: { sha256: mode === "wrong-subject" ? "b".repeat(64) : packetSHA256 } }], predicate: {} };
  const bundle = join(root, "attestation.json"), bytes = mode === "malformed" ? Buffer.from("{") : Buffer.from(`${JSON.stringify({ mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json", verificationMaterial: {}, dsseEnvelope: { payload: Buffer.from(JSON.stringify(statement)).toString("base64"), payloadType: "application/vnd.in-toto+json", signatures: [{ sig: "synthetic" }] } })}\n`); writeFileSync(bundle, bytes);
  const run = (args = ["--bundle", bundle, "--packet-name", packetName, "--output-directory", output]) => spawnSync(process.execPath, [retainer, ...args], { cwd: process.cwd(), encoding: "utf8" });
  return { root, output, packetName, bundle, bytes, run };
}

describe("trusted Desktop accepted-packet attestation", () => {
  it("verifies one exact content-addressed packet under fixed canonical identity", () => {
    const value = fixture(), result = value.run(); expect(result.status).toBe(0); expect(JSON.parse(result.stdout)).toEqual({ verified: true, packetSHA256: value.packetSHA256, repository, signerWorkflow, sourceRef });
    const args = JSON.parse(readFileSync(value.capture, "utf8")); expect(args.slice(0, 2)).toEqual(["attestation", "verify"]); expect(basename(args[2])).toBe(basename(value.packet)); expect(args[2]).not.toBe(value.packet);
    expect(args.slice(3)).toEqual(["--repo", repository, "--signer-workflow", signerWorkflow, "--source-ref", sourceRef, "--deny-self-hosted-runners", "--format", "json"]);
    expect(result.stdout).not.toContain(value.packet); expect(result.stdout).not.toMatch(/attestation|certificate|signature|path/i);
  });

  it("rejects missing authority, wrong subjects, alternate CLI identity, and unsafe packet paths", () => {
    const missing = fixture(); expect(missing.run("fail").status).not.toBe(0);
    const malformed = fixture(); expect(malformed.run("malformed").status).not.toBe(0);
    const wrong = fixture(); expect(wrong.run("wrong-subject").status).not.toBe(0);
    const alternate = fixture(); expect(alternate.run("success", ["--packet", alternate.packet, "--repo", "attacker/example"]).status).not.toBe(0);
    const unaddressed = fixture(), renamed = join(unaddressed.root, "packet.json"); writeFileSync(renamed, readFileSync(unaddressed.packet)); expect(unaddressed.run("success", ["--packet", renamed]).status).not.toBe(0);
    const linked = fixture(), alias = join(linked.root, basename(linked.packet).replace(".packet.json", ".alias.packet.json")); symlinkSync(linked.packet, alias); expect(linked.run("success", ["--packet", alias]).status).not.toBe(0); expect(existsSync(linked.capture)).toBe(false);
  });

  it("retains one bounded content-addressed bundle bound to the exact packet", () => {
    const value = bundleFixture(), result = value.run(); expect(result.status).toBe(0); const receipt = JSON.parse(result.stdout), expectedDigest = createHash("sha256").update(value.bytes).digest("hex"), target = join(value.output, `${expectedDigest}.attestation.json`);
    expect(receipt).toEqual({ bundleSHA256: expectedDigest, bundleFileName: `${expectedDigest}.attestation.json` }); expect(readFileSync(target)).toEqual(value.bytes); expect(statSync(target).mode & 0o777).toBe(0o600);
    expect(bundleFixture("malformed").run().status).not.toBe(0); expect(bundleFixture("wrong-subject").run().status).not.toBe(0);
    const linked = bundleFixture(), alias = join(linked.root, "alias.json"); symlinkSync(linked.bundle, alias); expect(linked.run(["--bundle", alias, "--packet-name", linked.packetName, "--output-directory", linked.output]).status).not.toBe(0);
    const alternate = bundleFixture(); expect(alternate.run(["--bundle", alternate.bundle, "--packet-name", alternate.packetName, "--output-directory", alternate.output, "--repo", "attacker/example"]).status).not.toBe(0);
  });

  it("keeps the canonical builder and attester on protected main with no authority inputs", () => {
    const workflow = readFileSync(workflowPath, "utf8"), producer = readFileSync(builder, "utf8");
    expect(workflow).toMatch(/workflow_dispatch:\s*\n/); expect(workflow).not.toMatch(/workflow_dispatch:\s*\n\s+inputs:/); expect(workflow).toMatch(/contents:\s*read[\s\S]*id-token:\s*write[\s\S]*attestations:\s*write/);
    expect(workflow).toContain("github.ref == 'refs/heads/main'"); expect(workflow).toContain("runs-on: macos-15"); expect(workflow).not.toContain("self-hosted"); expect(workflow).toContain('RELEASE_TAG: v1.1.0'); expect(workflow).toContain('test "$GITHUB_SHA" = "$(git rev-parse HEAD)"');
    expect(workflow).toContain("TeamIdentifier=TC6MS3T6NN"); expect(workflow).toMatch(/codesign --verify/); expect(workflow).toMatch(/stapler validate/); expect(workflow).toMatch(/spctl --assess/); expect(workflow).toContain("build-desktop-accepted-release-packet.mjs");
    expect(workflow).toContain("actions/attest-build-provenance@977bb373ede98d70efdf65b84cb5f73e068dcc2a # v3"); expect(workflow).toContain("actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4");
    expect(workflow).toContain("steps.attest.outputs.bundle-path"); expect(workflow).toContain("retain-desktop-packet-attestation.mjs");
    expect(producer).toContain("buildAcceptedDesktopReleasePacket"); expect(producer).toContain("serializeAcceptedDesktopReleasePacket"); expect(producer).toContain("acceptedDesktopReleasePacketDigest"); expect(producer).toMatch(/O_EXCL/); expect(producer).not.toMatch(/private.?key|token|secret/i);
  });
});
