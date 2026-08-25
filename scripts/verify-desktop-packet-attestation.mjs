import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { closeSync, constants, fstatSync, fsyncSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const REPOSITORY = "electricsheephq/evaos-code-review-bot-neondiff";
const SIGNER_WORKFLOW = `${REPOSITORY}/.github/workflows/desktop-accepted-release-packet.yml`;
const SOURCE_REF = "refs/heads/main";
const PREDICATE_TYPE = "https://slsa.dev/provenance/v1";
const MAX_PACKET_BYTES = 4 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;

function fail(message) {
  throw new Error(message);
}

function exactPacketBytes(input) {
  if (typeof input !== "string" || input.length === 0) fail("one packet path is required");
  const packetPath = resolve(input);
  let descriptor;
  try {
    descriptor = openSync(packetPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.size < 1 || before.size > MAX_PACKET_BYTES) fail("packet must be a bounded regular file");
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (!after.isFile() || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || bytes.length !== before.size) fail("packet changed during read");
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (!SHA256.test(digest) || basename(packetPath) !== `${digest}.packet.json`) fail("packet filename is not content-addressed");
    return { packetPath, bytes, digest };
  } catch (error) {
    if (error?.code === "ELOOP") fail("packet must not be symlinked");
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function privatePacketCopy(packetName, bytes) {
  const root = mkdtempSync(join(tmpdir(), "neondiff-packet-verification-")), packetPath = join(root, packetName);
  let descriptor;
  try {
    descriptor = openSync(packetPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    const stored = fstatSync(descriptor);
    if (!stored.isFile() || stored.size !== bytes.length) fail("private packet copy was not written exactly");
    closeSync(descriptor);
    descriptor = undefined;
    return { root, packetPath };
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function hasExactSubject(value, packetName, digest) {
  if (!Array.isArray(value) || value.length < 1) return false;
  return value.some((entry) => {
    const statement = entry?.verificationResult?.statement;
    return statement?.predicateType === PREDICATE_TYPE && Array.isArray(statement.subject) && statement.subject.some((subject) => subject?.name === packetName && subject?.digest?.sha256 === digest);
  });
}

function main() {
  const values = process.argv.slice(2);
  if (values.length !== 2 || values[0] !== "--packet") fail("usage: verify-desktop-packet-attestation --packet PATH");
  const { packetPath, bytes, digest } = exactPacketBytes(values[1]);
  const packetName = basename(packetPath);
  const stable = privatePacketCopy(packetName, bytes);
  let result;
  try {
    result = spawnSync("gh", [
      "attestation", "verify", stable.packetPath,
      "--repo", REPOSITORY,
      "--signer-workflow", SIGNER_WORKFLOW,
      "--source-ref", SOURCE_REF,
      "--deny-self-hosted-runners",
      "--format", "json"
    ], {
      encoding: "utf8",
      env: { ...process.env, GH_PAGER: "cat", PAGER: "cat", NO_COLOR: "1" },
      maxBuffer: MAX_PACKET_BYTES,
      timeout: 30_000
    });
  } finally {
    rmSync(stable.root, { recursive: true, force: true });
  }
  if (result.error || result.signal || result.status !== 0) fail("canonical packet attestation verification failed");
  let verification;
  try {
    verification = JSON.parse(result.stdout);
  } catch {
    fail("canonical packet attestation verification failed");
  }
  if (!hasExactSubject(verification, packetName, digest)) fail("canonical packet attestation verification failed");
  process.stdout.write(`${JSON.stringify({ verified: true, packetSHA256: digest, repository: REPOSITORY, signerWorkflow: SIGNER_WORKFLOW, sourceRef: SOURCE_REF })}\n`);
}

try {
  main();
} catch {
  process.stderr.write("canonical packet attestation verification failed\n");
  process.exitCode = 1;
}
