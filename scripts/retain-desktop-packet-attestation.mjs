import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const MAX_BUNDLE_BYTES = 4 * 1024 * 1024;
const PACKET_NAME = /^([a-f0-9]{64})\.packet\.json$/;
const NAMES = ["bundle", "packet-name", "output-directory"];

function fail(message) {
  throw new Error(message);
}

function parseArguments(values) {
  if (values.length !== NAMES.length * 2) fail("exact bundle retention arguments are required");
  const parsed = Object.create(null);
  for (let index = 0; index < values.length; index += 2) {
    const flag = values[index], value = values[index + 1];
    if (typeof flag !== "string" || !flag.startsWith("--") || !NAMES.includes(flag.slice(2)) || Object.hasOwn(parsed, flag.slice(2)) || typeof value !== "string" || value.length === 0) fail("bundle retention arguments are invalid");
    parsed[flag.slice(2)] = value;
  }
  if (NAMES.some((name) => !Object.hasOwn(parsed, name))) fail("bundle retention arguments are incomplete");
  return parsed;
}

function boundedBundle(input) {
  let descriptor;
  try {
    descriptor = openSync(resolve(input), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.size < 1 || before.size > MAX_BUNDLE_BYTES) fail("bundle must be a bounded regular file");
    const bytes = readFileSync(descriptor), after = fstatSync(descriptor);
    if (!after.isFile() || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || bytes.length !== before.size) fail("bundle changed during read");
    return bytes;
  } catch (error) {
    if (error?.code === "ELOOP") fail("bundle must not be symlinked");
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function exactStatement(bytes, packetName) {
  let bundle, statement;
  try {
    bundle = JSON.parse(bytes.toString("utf8"));
    const payload = bundle?.dsseEnvelope?.payload;
    if (typeof payload !== "string" || payload.length === 0) fail("bundle payload is missing");
    const decoded = Buffer.from(payload, "base64");
    if (decoded.toString("base64") !== payload) fail("bundle payload is not canonical base64");
    statement = JSON.parse(decoded.toString("utf8"));
  } catch {
    fail("bundle is malformed");
  }
  const packetDigest = packetName.match(PACKET_NAME)?.[1], subjects = statement?.subject;
  if (bundle?.mediaType !== "application/vnd.dev.sigstore.bundle.v0.3+json" || typeof bundle?.verificationMaterial !== "object" || bundle.verificationMaterial === null || bundle?.dsseEnvelope?.payloadType !== "application/vnd.in-toto+json" || !Array.isArray(bundle?.dsseEnvelope?.signatures) || bundle.dsseEnvelope.signatures.length < 1 || bundle.dsseEnvelope.signatures.some((item) => typeof item?.sig !== "string" || item.sig.length === 0) || statement?._type !== "https://in-toto.io/Statement/v1" || statement?.predicateType !== "https://slsa.dev/provenance/v1" || !packetDigest || !Array.isArray(subjects) || subjects.length !== 1 || subjects[0]?.name !== packetName || subjects[0]?.digest?.sha256 !== packetDigest) fail("bundle does not attest the exact packet");
}

function main() {
  const values = parseArguments(process.argv.slice(2)), packetName = values["packet-name"], bytes = boundedBundle(values.bundle);
  exactStatement(bytes, packetName);
  const directory = resolve(values["output-directory"]), bundleSHA256 = createHash("sha256").update(bytes).digest("hex"), bundleFileName = `${bundleSHA256}.attestation.json`, outputPath = resolve(directory, bundleFileName);
  let directoryDescriptor, outputDescriptor, created = false;
  try {
    directoryDescriptor = openSync(directory, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
    if (!fstatSync(directoryDescriptor).isDirectory()) fail("output directory is not a directory");
    outputDescriptor = openSync(outputPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
    created = true;
    writeFileSync(outputDescriptor, bytes);
    fsyncSync(outputDescriptor);
    const stored = fstatSync(outputDescriptor);
    if (!stored.isFile() || stored.size !== bytes.length) fail("retained bundle was not written exactly");
    closeSync(outputDescriptor);
    outputDescriptor = undefined;
  } catch (error) {
    if (outputDescriptor !== undefined) closeSync(outputDescriptor);
    if (created) {
      try { unlinkSync(outputPath); } catch { /* best-effort cleanup of this invocation's new file */ }
    }
    throw error;
  } finally {
    if (directoryDescriptor !== undefined) closeSync(directoryDescriptor);
  }
  process.stdout.write(`${JSON.stringify({ bundleSHA256, bundleFileName })}\n`);
}

try {
  main();
} catch {
  process.stderr.write("attestation bundle retention failed\n");
  process.exitCode = 1;
}
