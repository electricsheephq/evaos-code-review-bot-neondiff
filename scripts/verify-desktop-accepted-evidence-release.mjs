import { resolve } from "node:path";
import { verifyRetainedDesktopAcceptedEvidence, verifyRetainedDesktopAcceptedTargetEvidence } from "./lib/desktop-accepted-evidence-release.mjs";

const NAMES = ["artifact", "packet", "bundle", "release", "tag-ref"];
const TARGET = "target-release-tag", TARGET_TAG = /^v1\.1\.0-(?:beta\.[1-9][0-9]{0,3}|rc\.[1-9][0-9]{0,15})$/;
function fail(message) { throw new Error(message); }
function parseArguments(values) {
  if (values.length !== NAMES.length * 2 && values.length !== (NAMES.length + 1) * 2) fail("exact retained evidence arguments are required"); const parsed = Object.create(null);
  for (let index = 0; index < values.length; index += 2) { const flag = values[index], value = values[index + 1], name = typeof flag === "string" && flag.startsWith("--") ? flag.slice(2) : ""; if (![...NAMES, TARGET].includes(name) || Object.hasOwn(parsed, name) || typeof value !== "string" || !value) fail("retained evidence arguments are invalid"); parsed[name] = name === TARGET ? value : resolve(value); }
  if (NAMES.some((name) => !Object.hasOwn(parsed, name)) || Object.hasOwn(parsed, TARGET) !== (values.length === (NAMES.length + 1) * 2) || Object.hasOwn(parsed, TARGET) && !TARGET_TAG.test(parsed[TARGET])) fail("retained evidence arguments are invalid");
  return parsed;
}
try { const values = parseArguments(process.argv.slice(2)), input = { artifactPath: values.artifact, packetPath: values.packet, bundlePath: values.bundle, releasePath: values.release, tagRefPath: values["tag-ref"] }, receipt = values[TARGET] ? verifyRetainedDesktopAcceptedTargetEvidence(input) : verifyRetainedDesktopAcceptedEvidence(input); if (values[TARGET] && receipt.releaseTag !== `neondiff-accepted-packet-${values[TARGET]}`) fail("retained target evidence does not match the selected release"); process.stdout.write(`${JSON.stringify(receipt)}\n`); }
catch { process.stderr.write("retained accepted evidence verification failed\n"); process.exitCode = 1; }
