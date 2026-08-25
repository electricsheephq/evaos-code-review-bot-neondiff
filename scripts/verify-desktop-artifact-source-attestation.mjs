import { verifyAndRetainDesktopArtifactSourceAttestation } from "./lib/desktop-artifact-source-attestation.mjs";

const NAMES = ["artifact", "bundle", "tag-ref", "tag-object", "release", "output-directory"];
function fail(message) { throw new Error(message); }
function parseArguments(values) {
  if (values.length !== NAMES.length * 2) fail("exact artifact attestation arguments are required");
  const parsed = Object.create(null);
  for (let index = 0; index < values.length; index += 2) {
    const flag = values[index], value = values[index + 1], name = typeof flag === "string" && flag.startsWith("--") ? flag.slice(2) : "";
    if (!NAMES.includes(name) || Object.hasOwn(parsed, name) || typeof value !== "string" || !value) fail("artifact attestation arguments are invalid"); parsed[name] = value;
  }
  return parsed;
}
try {
  const values = parseArguments(process.argv.slice(2));
  const receipt = verifyAndRetainDesktopArtifactSourceAttestation({ artifactPath: values.artifact, bundlePath: values.bundle, tagRefPath: values["tag-ref"], tagObjectPath: values["tag-object"], releasePath: values.release, outputDirectory: values["output-directory"] });
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
} catch {
  process.stderr.write("artifact source attestation verification failed\n");
  process.exitCode = 1;
}
