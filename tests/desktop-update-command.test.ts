import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { planDesktopUpdate } from "../scripts/lib/desktop-update-command.mjs";

const hex = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
function fixture() {
  const artifact = Buffer.from("immutable desktop zip"), { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const declaration = { version: "1.1.0-rc.1", tag: "v1.1.0-rc.1", channel: "rc", build: "11092", distribution: { artifactName: "NeonDiff-1.1.0-rc.1-build11092-macOS.zip", origins: { feed: "https://www.neondiff.com/updates/beta/appcast.xml" } } };
  const declarationBytes = Buffer.from(JSON.stringify(declaration)), packet = {
    schemaVersion: 1, declarationSHA256: hex(declarationBytes),
    release: { version: declaration.version, tag: declaration.tag, channel: declaration.channel, build: declaration.build, artifactName: declaration.distribution.artifactName, artifactSHA256: hex(artifact), treeSHA256: "b".repeat(64) },
    sparkle: { publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64"), edSignature: sign(null, artifact, privateKey).toString("base64"), feedURL: declaration.distribution.origins.feed, entrySHA256: "c".repeat(64) },
    apple: { teamID: "TEAM123456", notarized: true, stapled: true, gatekeeper: true },
    prestate: { appSHA256: "d".repeat(64), configSHA256: "e".repeat(64), databaseSHA256: "f".repeat(64), allowlistSHA256: "1".repeat(64), plistSHA256: "2".repeat(64), label: "com.electricsheephq.neondiff", wrapperPID: 101, wrapperPath: "/Applications/NeonDiff.app/Contents/MacOS/NeonDiffDesktop", helperPID: 102, helperPath: "/Applications/NeonDiff.app/Contents/Helpers/NeonDiffWorker" }
  };
  const packetBytes = Buffer.from(JSON.stringify(packet));
  return { artifact, declaration, packet, packetBytes, input: { action: "update", declaration, declarationBytes, packet, packetBytes, packetSHA256: hex(packetBytes), artifactBytes: artifact, expectedTeamID: "TEAM123456" } };
}

describe("signed Desktop update preflight", () => {
  it("emits a redacted non-mutating plan bound to accepted bytes", () => {
    const { input } = fixture(), plan = planDesktopUpdate(input);
    expect(plan).toMatchObject({ dryRun: true, action: "update", candidate: { version: "1.1.0-rc.1", build: "11092" }, prestate: { label: "com.electricsheephq.neondiff" } });
    expect(plan.steps).toEqual(["wait-for-zero-lease-cycle", "stage-and-verify", "swap-and-restart-exact-service", "verify-poststate"]);
    expect(JSON.stringify(plan)).not.toMatch(/publicKey|edSignature|TEAM123456|packetBytes|artifactBytes/i);
  });

  it("rejects every signed-release identity failure before planning", () => {
    const cases: Array<[string, (value: ReturnType<typeof fixture>) => void]> = [
      ["packet digest", (v) => { v.input.packetSHA256 = "0".repeat(64); }],
      ["declaration digest", (v) => { v.packet.declarationSHA256 = "0".repeat(64); }],
      ["artifact digest", (v) => { v.packet.release.artifactSHA256 = "0".repeat(64); }],
      ["Sparkle signature", (v) => { v.packet.sparkle.edSignature = Buffer.alloc(64).toString("base64"); }],
      ["Team ID", (v) => { v.packet.apple.teamID = "OTHERTEAM"; }],
      ["tag", (v) => { v.packet.release.tag = "v1.1.0-rc.2"; }],
      ["build", (v) => { v.packet.release.build = "11093"; }],
      ["notarization", (v) => { v.packet.apple.notarized = false; }],
      ["stapling", (v) => { v.packet.apple.stapled = false; }],
      ["Gatekeeper", (v) => { v.packet.apple.gatekeeper = false; }]
    ];
    for (const [label, mutate] of cases) { const value = fixture(); mutate(value); value.packetBytes = Buffer.from(JSON.stringify(value.packet)); value.input.packetBytes = value.packetBytes; if (label !== "packet digest") value.input.packetSHA256 = hex(value.packetBytes); expect(() => planDesktopUpdate(value.input), label).toThrow(); }
  });
});
