import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { closeSync, constants, fstatSync, fsyncSync, mkdtempSync, openSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const REPOSITORY = "electricsheephq/evaos-code-review-bot-neondiff";
const SIGNER_WORKFLOW = `${REPOSITORY}/.github/workflows/desktop-accepted-release-packet.yml`;
const SOURCE_REF = "refs/heads/main";
const PREDICATE_TYPE = "https://slsa.dev/provenance/v1";
const MAX_INPUT_BYTES = 4 * 1024 * 1024;
const PACKET_NAME = /^([a-f0-9]{64})\.packet\.json$/;
const NAMES = ["bundle", "packet", "output-directory"];

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

function boundedBytes(input, label) {
  const path = resolve(input);
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.size < 1 || before.size > MAX_INPUT_BYTES) fail(`${label} must be a bounded regular file`);
    const bytes = readFileSync(descriptor), after = fstatSync(descriptor);
    if (!after.isFile() || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || bytes.length !== before.size) fail(`${label} changed during read`);
    return { path, bytes };
  } catch (error) {
    if (error?.code === "ELOOP") fail(`${label} must not be symlinked`);
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function exactPacket(input) {
  const value = boundedBytes(input, "packet"), digest = createHash("sha256").update(value.bytes).digest("hex"), name = basename(value.path);
  if (name !== `${digest}.packet.json`) fail("packet filename is not content-addressed");
  return { ...value, digest, name };
}

function exactStatement(bytes, packetName, packetDigest) {
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
  const subjects = statement?.subject, signatures = bundle?.dsseEnvelope?.signatures;
  if (!PACKET_NAME.test(packetName) || bundle?.mediaType !== "application/vnd.dev.sigstore.bundle.v0.3+json" || typeof bundle?.verificationMaterial !== "object" || bundle.verificationMaterial === null || Object.keys(bundle.verificationMaterial).length < 1 || bundle?.dsseEnvelope?.payloadType !== "application/vnd.in-toto+json" || !Array.isArray(signatures) || signatures.length < 1 || signatures.some((item) => { if (typeof item?.sig !== "string" || item.sig.length === 0) return true; const decoded = Buffer.from(item.sig, "base64"); return decoded.length === 0 || decoded.toString("base64") !== item.sig; }) || statement?._type !== "https://in-toto.io/Statement/v1" || statement?.predicateType !== PREDICATE_TYPE || !Array.isArray(subjects) || subjects.length !== 1 || subjects[0]?.name !== packetName || subjects[0]?.digest?.sha256 !== packetDigest) fail("bundle does not attest the exact packet");
}

function writePrivate(path, bytes) {
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    const stored = fstatSync(descriptor);
    if (!stored.isFile() || stored.size !== bytes.length) fail("private verification input was not written exactly");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function cryptographicallyVerify(packet, bundle) {
  const root = mkdtempSync(join(tmpdir(), "neondiff-bundle-verification-")), packetPath = join(root, packet.name), bundlePath = join(root, "attestation.json");
  let result;
  try {
    writePrivate(packetPath, packet.bytes);
    writePrivate(bundlePath, bundle.bytes);
    result = spawnSync("gh", [
      "attestation", "verify", packetPath,
      "--bundle", bundlePath,
      "--repo", REPOSITORY,
      "--signer-workflow", SIGNER_WORKFLOW,
      "--source-ref", SOURCE_REF,
      "--deny-self-hosted-runners",
      "--format", "json"
    ], {
      encoding: "utf8",
      env: { ...process.env, GH_PAGER: "cat", PAGER: "cat", NO_COLOR: "1" },
      maxBuffer: MAX_INPUT_BYTES,
      timeout: 30_000
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  if (result.error || result.signal || result.status !== 0) fail("canonical bundle verification failed");
  let verification;
  try { verification = JSON.parse(result.stdout); } catch { fail("canonical bundle verification failed"); }
  if (!Array.isArray(verification) || !verification.some((entry) => { const statement = entry?.verificationResult?.statement; return statement?.predicateType === PREDICATE_TYPE && Array.isArray(statement.subject) && statement.subject.some((subject) => subject?.name === packet.name && subject?.digest?.sha256 === packet.digest); })) fail("canonical bundle verification failed");
}

function main() {
  const values = parseArguments(process.argv.slice(2)), packet = exactPacket(values.packet), bundle = boundedBytes(values.bundle, "bundle");
  exactStatement(bundle.bytes, packet.name, packet.digest);
  cryptographicallyVerify(packet, bundle);
  const directory = resolve(values["output-directory"]), bundleSHA256 = createHash("sha256").update(bundle.bytes).digest("hex"), bundleFileName = `${bundleSHA256}.attestation.json`, outputPath = resolve(directory, bundleFileName);
  let directoryDescriptor, outputDescriptor, created = false;
  try {
    directoryDescriptor = openSync(directory, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
    if (!fstatSync(directoryDescriptor).isDirectory()) fail("output directory is not a directory");
    outputDescriptor = openSync(outputPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
    created = true;
    writeFileSync(outputDescriptor, bundle.bytes);
    fsyncSync(outputDescriptor);
    const stored = fstatSync(outputDescriptor);
    if (!stored.isFile() || stored.size !== bundle.bytes.length) fail("retained bundle was not written exactly");
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
