import { resolve } from "node:path";
import { verifyRetainedDesktopAcceptedEvidence } from "./lib/desktop-accepted-evidence-release.mjs";

const NAMES = ["packet", "bundle", "release", "tag-ref"];
function fail(message) { throw new Error(message); }
function parseArguments(values) {
  if (values.length !== NAMES.length * 2) fail("exact retained evidence arguments are required"); const parsed = Object.create(null);
  for (let index = 0; index < values.length; index += 2) { const flag = values[index], value = values[index + 1], name = typeof flag === "string" && flag.startsWith("--") ? flag.slice(2) : ""; if (!NAMES.includes(name) || Object.hasOwn(parsed, name) || typeof value !== "string" || !value) fail("retained evidence arguments are invalid"); parsed[name] = resolve(value); }
  return parsed;
}
try { const values = parseArguments(process.argv.slice(2)), receipt = verifyRetainedDesktopAcceptedEvidence({ packetPath: values.packet, bundlePath: values.bundle, releasePath: values.release, tagRefPath: values["tag-ref"] }); process.stdout.write(`${JSON.stringify(receipt)}\n`); }
catch { process.stderr.write("retained accepted evidence verification failed\n"); process.exitCode = 1; }
