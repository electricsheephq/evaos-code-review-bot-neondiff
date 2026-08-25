import { closeSync, constants, fstatSync, fsyncSync, openSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { acceptedDesktopTransitionTargetDigest, buildAcceptedDesktopTransitionTarget, serializeAcceptedDesktopTransitionTarget } from "./lib/desktop-accepted-transition-target.mjs";

const REQUIRED = ["action", "artifact", "packet", "bundle", "release", "tag-ref", "current-packet", "output-directory"], OPTIONAL = "previous-target-packet";
const fail = (message) => { throw new Error(message); };
function argumentsOf(values) {
  if (values.length !== REQUIRED.length * 2 && values.length !== (REQUIRED.length + 1) * 2) fail("exact transition producer arguments are required");
  const parsed = Object.create(null);
  for (let index = 0; index < values.length; index += 2) { const flag = values[index], value = values[index + 1], name = typeof flag === "string" && flag.startsWith("--") ? flag.slice(2) : ""; if (![...REQUIRED, OPTIONAL].includes(name) || Object.hasOwn(parsed, name) || typeof value !== "string" || !value) fail("transition producer arguments are invalid"); parsed[name] = name === "action" ? value : resolve(value); }
  if (REQUIRED.some((name) => !Object.hasOwn(parsed, name)) || Object.hasOwn(parsed, OPTIONAL) !== (values.length === (REQUIRED.length + 1) * 2)) fail("transition producer arguments are invalid");
  return parsed;
}
async function main() {
  const values = argumentsOf(process.argv.slice(2)), receipt = await buildAcceptedDesktopTransitionTarget({ action: values.action, artifactPath: values.artifact, packetPath: values.packet, bundlePath: values.bundle, releasePath: values.release, tagRefPath: values["tag-ref"], currentPacketPath: values["current-packet"], previousTargetPacketPath: values[OPTIONAL] ?? null });
  const bytes = Buffer.from(serializeAcceptedDesktopTransitionTarget(receipt)), digest = acceptedDesktopTransitionTargetDigest(receipt), name = `${digest}.target.json`, directory = values["output-directory"]; let directoryDescriptor, descriptor, created = false;
  try {
    directoryDescriptor = openSync(directory, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0)); const before = fstatSync(directoryDescriptor); if (!before.isDirectory()) fail("transition output directory is invalid");
    const output = join(directory, name); descriptor = openSync(output, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600); created = true; writeFileSync(descriptor, bytes); fsyncSync(descriptor); const stored = fstatSync(descriptor), after = statSync(directory); if (!stored.isFile() || stored.size !== bytes.length || after.dev !== before.dev || after.ino !== before.ino) fail("transition receipt was not written exactly");
  } catch (error) { if (created) { try { unlinkSync(join(directory, name)); } catch { /* remove only this invocation's new output */ } } throw error; }
  finally { if (descriptor !== undefined) closeSync(descriptor); if (directoryDescriptor !== undefined) closeSync(directoryDescriptor); }
  process.stdout.write(`${JSON.stringify({ action: receipt.action, targetPacketSHA256: receipt.acceptedTarget.packetSHA256, targetPacketFileName: `${receipt.acceptedTarget.packetSHA256}.packet.json`, targetReceiptSHA256: digest, targetReceiptFileName: name })}\n`);
}
try { await main(); } catch { process.stderr.write("accepted transition target build failed\n"); process.exitCode = 1; }
