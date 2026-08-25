import { closeSync, constants, fstatSync, fsyncSync, openSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  acceptedDesktopReleasePacketDigest,
  buildAcceptedDesktopReleasePacket,
  serializeAcceptedDesktopReleasePacket
} from "./lib/desktop-accepted-release-packet.mjs";

const NAMES = ["index", "artifact", "feed", "tag-ref", "tag-object", "release", "accepted-public-key", "output"];

function fail(message) {
  throw new Error(message);
}

function parseArguments(values) {
  if (values.length !== NAMES.length * 2) fail("exact packet builder arguments are required");
  const parsed = Object.create(null);
  for (let index = 0; index < values.length; index += 2) {
    const flag = values[index], value = values[index + 1];
    if (typeof flag !== "string" || !flag.startsWith("--") || !NAMES.includes(flag.slice(2)) || Object.hasOwn(parsed, flag.slice(2)) || typeof value !== "string" || value.length === 0) fail("packet builder arguments are invalid");
    parsed[flag.slice(2)] = resolve(value);
  }
  if (NAMES.some((name) => !Object.hasOwn(parsed, name))) fail("packet builder arguments are incomplete");
  return parsed;
}

async function main() {
  const values = parseArguments(process.argv.slice(2));
  const packet = await buildAcceptedDesktopReleasePacket(values.index, values.artifact, values.feed, values["tag-ref"], values["tag-object"], values.release, values["accepted-public-key"]);
  const serialized = serializeAcceptedDesktopReleasePacket(packet);
  const packetSHA256 = acceptedDesktopReleasePacketDigest(packet);
  const bytes = Buffer.from(serialized, "utf8");
  let descriptor, created = false;
  try {
    descriptor = openSync(values.output, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
    created = true;
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    const stored = fstatSync(descriptor);
    if (!stored.isFile() || stored.size !== bytes.length) fail("packet output was not written exactly");
    closeSync(descriptor);
    descriptor = undefined;
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    if (created) {
      try { unlinkSync(values.output); } catch { /* best-effort cleanup of this invocation's new file */ }
    }
    throw error;
  }
  process.stdout.write(`${JSON.stringify({ packetSHA256, packetFileName: `${packetSHA256}.packet.json` })}\n`);
}

try {
  await main();
} catch {
  process.stderr.write("accepted release packet build failed\n");
  process.exitCode = 1;
}
