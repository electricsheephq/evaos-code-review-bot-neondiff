import { closeSync, constants, fstatSync, fsyncSync, openSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { acceptedDesktopReleasePacketDigest, buildAcceptedDesktopReleasePacket, serializeAcceptedDesktopReleasePacket } from "./lib/desktop-accepted-release-packet.mjs";
import { verifyAndRetainDesktopArtifactSourceAttestation } from "./lib/desktop-artifact-source-attestation.mjs";

const NAMES = ["index", "artifact", "feed", "tag-ref", "tag-object", "release", "accepted-public-key", "artifact-attestation", "attestation-output-directory", "output"];
const OPTIONAL = "release-tag";
function fail(message) { throw new Error(message); }
function parseArguments(values) {
  if (values.length !== NAMES.length * 2 && values.length !== (NAMES.length + 1) * 2) fail("exact packet builder arguments are required");
  const parsed = Object.create(null);
  for (let index = 0; index < values.length; index += 2) {
    const flag = values[index], value = values[index + 1], name = typeof flag === "string" && flag.startsWith("--") ? flag.slice(2) : "";
    if (![...NAMES, OPTIONAL].includes(name) || Object.hasOwn(parsed, name) || typeof value !== "string" || !value) fail("packet builder arguments are invalid"); parsed[name] = name === OPTIONAL ? value : resolve(value);
  }
  const hasOptional = Object.hasOwn(parsed, OPTIONAL); if (NAMES.some((name) => !Object.hasOwn(parsed, name)) || hasOptional !== (values.length === (NAMES.length + 1) * 2)) fail("packet builder arguments are invalid");
  return parsed;
}
async function main() {
  const values = parseArguments(process.argv.slice(2));
  const attestation = verifyAndRetainDesktopArtifactSourceAttestation({ artifactPath: values.artifact, bundlePath: values["artifact-attestation"], tagRefPath: values["tag-ref"], tagObjectPath: values["tag-object"], releasePath: values.release, outputDirectory: values["attestation-output-directory"] }, values[OPTIONAL]);
  const packet = await buildAcceptedDesktopReleasePacket(values.index, values.artifact, values.feed, values["tag-ref"], values["tag-object"], values.release, values["accepted-public-key"], values[OPTIONAL]);
  const serialized = serializeAcceptedDesktopReleasePacket(packet), packetSHA256 = acceptedDesktopReleasePacketDigest(packet);
  if (packet.artifactName !== attestation.artifactName || packet.artifactSHA256 !== attestation.artifactSHA256 || packet.artifactByteLength !== attestation.artifactByteLength || packet.sourceSHA !== attestation.artifactSourceSHA || packet.artifactSourceSHA !== attestation.artifactSourceSHA || packetSHA256 !== attestation.acceptedPacketSHA256) fail("accepted packet does not match verified artifact source attestation");
  const bytes = Buffer.from(serialized, "utf8"); let descriptor, created = false;
  try {
    descriptor = openSync(values.output, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600); created = true; writeFileSync(descriptor, bytes); fsyncSync(descriptor); const stored = fstatSync(descriptor); if (!stored.isFile() || stored.size !== bytes.length) fail("packet output was not written exactly");
  } catch (error) {
    if (created) { try { unlinkSync(values.output); } catch { /* best-effort cleanup of this invocation's new file */ } } throw error;
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
  process.stdout.write(`${JSON.stringify({ packetSHA256, packetFileName: `${packetSHA256}.packet.json`, artifactAttestationBundleSHA256: attestation.bundleSHA256, artifactAttestationBundleFileName: attestation.bundleFileName })}\n`);
}
try { await main(); } catch { process.stderr.write("accepted release packet build failed\n"); process.exitCode = 1; }
