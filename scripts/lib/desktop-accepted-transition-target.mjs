import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { parseAcceptedDesktopReleasePacket } from "./desktop-accepted-release-packet.mjs";
import { verifyRetainedDesktopAcceptedTargetEvidence } from "./desktop-accepted-evidence-release.mjs";
import { buildExtractedAppTreeProof } from "./desktop-extracted-app-tree-proof.mjs";

const KIND = "neondiff.desktop.accepted-transition-target-v1";
const SHA1 = /^[a-f0-9]{40}$/, SHA256 = /^[a-f0-9]{64}$/;
const MAX_ARTIFACT = 512 * 1024 * 1024, MAX_INPUT = 4 * 1024 * 1024;
const INPUT_FIELDS = ["action", "artifactPath", "packetPath", "bundlePath", "releasePath", "tagRefPath", "currentPacketPath", "previousTargetPacketPath"];
const TARGET_FIELDS = ["tag", "version", "build", "channel", "packetSHA256", "sourceSHA", "tagObjectSHA", "artifactSHA256", "treeSHA256", "sparklePublicKeySHA256", "evidenceWorkflowSourceSHA"];
const CURRENT_FIELDS = ["tag", "version", "build", "channel", "packetSHA256", "sourceSHA", "tagObjectSHA", "artifactSHA256", "treeSHA256"];
const RECEIPT_FIELDS = ["schemaVersion", "kind", "action", "acceptedTarget", "current", "previouslyAcceptedTargetPacketSHA256"];
const authenticatedReceipts = new WeakSet(), validator = fileURLToPath(new URL("../validate-desktop-release-declaration.mjs", import.meta.url));
const fail = (message) => { throw new Error(message); }, sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function exact(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== fields.length || fields.some((field) => !Object.hasOwn(value, field))) fail(`${label} shape is invalid`);
  return value;
}
function sameFile(left, right) { return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs; }
function boundedBytes(input, label, maximum = MAX_INPUT) {
  if (typeof input !== "string" || !isAbsolute(input)) fail(`${label} path must be absolute`);
  const path = resolve(input); let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0));
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.size < 1n || before.size > BigInt(maximum)) fail(`${label} is not a bounded regular file`);
    const bytes = readFileSync(descriptor), after = fstatSync(descriptor, { bigint: true });
    if (!after.isFile() || !sameFile(before, after) || BigInt(bytes.length) !== before.size) fail(`${label} changed during read`);
    return { path, bytes, digest: sha256(bytes) };
  } catch (error) { if (error?.code === "ELOOP") fail(`${label} must not be symlinked`); throw error; }
  finally { if (descriptor !== undefined) closeSync(descriptor); }
}
function git(workspace, args, encoding) {
  const result = spawnSync("git", ["--no-replace-objects", "-C", workspace, ...args], { encoding, maxBuffer: MAX_INPUT, timeout: 5_000 });
  if (result.error || result.signal || result.status !== 0) fail("protected Git history is unavailable");
  return result.stdout;
}
function protectedContext() {
  const workspace = process.env.GITHUB_WORKSPACE, head = process.env.GITHUB_SHA;
  if (typeof workspace !== "string" || !isAbsolute(workspace) || resolve(workspace) !== workspace || !SHA1.test(head ?? "")) fail("canonical protected-main workspace is required");
  if (git(workspace, ["rev-parse", "HEAD"], "utf8").trim() !== head) fail("protected Git head is not authenticated");
  return { workspace, head, historyRoot: join(workspace, "docs/releases/desktop"), targetDirectory: join(workspace, "docs/releases/desktop/accepted-targets") };
}
function trackedAtHead(context, evidence, label) {
  const name = relative(context.workspace, evidence.path);
  if (!name || isAbsolute(name) || name.startsWith("..") || name.includes("\\")) fail(`${label} is outside protected history`);
  const blob = git(context.workspace, ["show", `${context.head}:${name}`]);
  if (!Buffer.isBuffer(blob) || !blob.equals(evidence.bytes)) fail(`${label} is not the protected-head blob`);
}
function targetRetainedAtHead(context, target) {
  const name = relative(context.workspace, join(context.targetDirectory, `${target.digest}.packet.json`)), listed = git(context.workspace, ["ls-tree", "--name-only", context.head, "--", name], "utf8").trim();
  if (!listed) return false;
  if (listed !== name) fail("protected target packet history is ambiguous");
  const blob = git(context.workspace, ["show", `${context.head}:${name}`]); if (!Buffer.isBuffer(blob) || !blob.equals(target.bytes)) fail("protected target packet disagrees with verified evidence"); return true;
}
function exactPacket(path, label) {
  const evidence = boundedBytes(path, label), packet = parseAcceptedDesktopReleasePacket(evidence.bytes);
  if (basename(evidence.path) !== `${evidence.digest}.packet.json`) fail(`${label} content address is invalid`);
  return { ...evidence, packet };
}
function protectedPacket(path, context, label) {
  const evidence = exactPacket(path, label);
  if (dirname(evidence.path) !== context.targetDirectory) fail(`${label} is outside accepted target history`);
  trackedAtHead(context, evidence, label); return evidence;
}
function declarationIdentity(packet, declaration, label) {
  const expected = [packet.version, packet.tag, packet.channel, packet.build, packet.artifactName, packet.releaseContract];
  const actual = [declaration?.version, declaration?.tag, declaration?.channel, declaration?.build, declaration?.distribution?.artifactName, declaration?.contract];
  if (!isDeepStrictEqual(actual, expected)) fail(`${label} disagrees with protected declaration history`);
}
function protectedHistory(context, target, current, previous, requestedAction) {
  const indexPath = join(context.historyRoot, "index.json"), indexEvidence = boundedBytes(indexPath, "release declaration index"); trackedAtHead(context, indexEvidence, "release declaration index");
  const checked = spawnSync(process.execPath, [validator, "--index", indexPath], { encoding: "utf8", maxBuffer: MAX_INPUT, timeout: 5_000 });
  if (checked.error || checked.signal || checked.status !== 0) fail("protected release history is invalid");
  let index; try { index = JSON.parse(indexEvidence.bytes); } catch { fail("protected release history is invalid"); }
  if (index?.status !== "retained" || index.declarationDirectory !== "declarations" || !Array.isArray(index.declarationPaths) || typeof index.currentPath !== "string") fail("protected release history is invalid");
  const records = new Map();
  for (const packetEvidence of [target, current]) {
    const name = `${packetEvidence.packet.tag}.json`, position = index.declarationPaths.indexOf(name);
    if (position < 0 || index.declarationPaths.lastIndexOf(name) !== position) fail("accepted packet is missing from protected declaration history");
    if (!records.has(name)) {
      const path = join(context.historyRoot, "declarations", name), evidence = boundedBytes(path, "release declaration"); trackedAtHead(context, evidence, "release declaration");
      let declaration; try { declaration = JSON.parse(evidence.bytes); } catch { fail("protected release declaration is malformed"); }
      records.set(name, { name, position, path, evidence, declaration });
    }
    declarationIdentity(packetEvidence.packet, records.get(name).declaration, "accepted packet");
  }
  const targetRecord = records.get(`${target.packet.tag}.json`), currentRecord = records.get(`${current.packet.tag}.json`), targetRetained = targetRetainedAtHead(context, target);
  const targetBuild = BigInt(target.packet.build), currentBuild = BigInt(current.packet.build); let action;
  if (targetRecord.position > currentRecord.position && targetRecord.name === index.currentPath && targetBuild > currentBuild) action = targetRetained ? previous?.digest === target.digest ? "reupdate" : undefined : previous === null ? "update" : undefined;
  else if (targetRecord.position < currentRecord.position && currentRecord.name === index.currentPath && targetBuild < currentBuild && previous?.digest === target.digest) action = "rollback";
  if (!action) fail("protected history does not permit the transition");
  if (action !== requestedAction) fail("requested action does not match protected history");
  if ([target.digest === current.digest, target.packet.tag === current.packet.tag, target.packet.build === current.packet.build, target.packet.artifactSHA256 === current.packet.artifactSHA256, target.packet.treeSHA256 === current.packet.treeSHA256].some(Boolean)) fail("transition target is not distinct from current release");
  return { action, snapshots: [indexEvidence, ...[...records.values()].map((record) => record.evidence)] };
}
function freeze(value) { if (value && typeof value === "object" && !Object.isFrozen(value)) { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; }
function unchanged(evidence, label) { if (!boundedBytes(evidence.path, label, evidence.bytes.length).bytes.equals(evidence.bytes)) fail(`${label} changed during receipt production`); }

export async function buildAcceptedDesktopTransitionTarget(input) {
  exact(input, INPUT_FIELDS, "transition producer input");
  const values = Object.freeze(Object.fromEntries(INPUT_FIELDS.map((field) => [field, input[field]])));
  if (!["update", "rollback", "reupdate"].includes(values.action)) fail("transition action is invalid");
  for (const field of INPUT_FIELDS.slice(1, 7)) if (typeof values[field] !== "string" || !isAbsolute(values[field])) fail("transition producer paths must be absolute");
  if (values.previousTargetPacketPath !== null && (typeof values.previousTargetPacketPath !== "string" || !isAbsolute(values.previousTargetPacketPath))) fail("previous target packet selector is invalid");
  const context = protectedContext(), targetInputs = [
    boundedBytes(values.artifactPath, "target artifact", MAX_ARTIFACT), boundedBytes(values.packetPath, "target packet"), boundedBytes(values.bundlePath, "target bundle"), boundedBytes(values.releasePath, "target release metadata"), boundedBytes(values.tagRefPath, "target tag metadata")
  ];
  const verified = verifyRetainedDesktopAcceptedTargetEvidence({ artifactPath: values.artifactPath, packetPath: values.packetPath, bundlePath: values.bundlePath, releasePath: values.releasePath, tagRefPath: values.tagRefPath });
  const target = exactPacket(values.packetPath, "target packet");
  if (verified.packetSHA256 !== target.digest || verified.artifactSourceSHA !== target.packet.sourceSHA) fail("target packet is not independently verified");
  const current = protectedPacket(values.currentPacketPath, context, "current packet"), previous = values.previousTargetPacketPath === null ? null : protectedPacket(values.previousTargetPacketPath, context, "previous target packet");
  const history = protectedHistory(context, target, current, previous, values.action), tree = await buildExtractedAppTreeProof(values.artifactPath, target.packet.sourceSHA);
  const feedURL = target.packet.channel === "stable" ? "https://www.neondiff.com/updates/stable/appcast.xml" : "https://www.neondiff.com/updates/beta/appcast.xml";
  if (tree.artifactSHA256 !== target.packet.artifactSHA256 || tree.artifactByteLength !== target.packet.artifactByteLength || tree.treeSHA256 !== target.packet.treeSHA256 || tree.appleDouble.entryCount !== 0 || tree.bundleMarkers.version !== target.packet.version || tree.bundleMarkers.build !== target.packet.build || tree.bundleMarkers.sourceSHA !== target.packet.sourceSHA || tree.bundleMarkers.feedURL !== feedURL || !isDeepStrictEqual(tree.bundleMarkers.productionContract, target.packet.productionContract)) fail("verified artifact tree disagrees with target packet");
  const publicKey = typeof tree.bundleMarkers.publicKey === "string" ? Buffer.from(tree.bundleMarkers.publicKey, "base64") : Buffer.alloc(0);
  if (publicKey.length !== 32 || publicKey.toString("base64") !== tree.bundleMarkers.publicKey) fail("accepted Sparkle public key is invalid");
  const receipt = { schemaVersion: 1, kind: KIND, action: history.action, acceptedTarget: { tag: target.packet.tag, version: target.packet.version, build: target.packet.build, channel: target.packet.channel, packetSHA256: target.digest, sourceSHA: target.packet.sourceSHA, tagObjectSHA: target.packet.tagObjectSHA, artifactSHA256: target.packet.artifactSHA256, treeSHA256: target.packet.treeSHA256, sparklePublicKeySHA256: sha256(publicKey), evidenceWorkflowSourceSHA: verified.workflowSourceSHA }, current: { tag: current.packet.tag, version: current.packet.version, build: current.packet.build, channel: current.packet.channel, packetSHA256: current.digest, sourceSHA: current.packet.sourceSHA, tagObjectSHA: current.packet.tagObjectSHA, artifactSHA256: current.packet.artifactSHA256, treeSHA256: current.packet.treeSHA256 }, previouslyAcceptedTargetPacketSHA256: previous?.digest ?? null };
  for (const evidence of [...targetInputs, current, ...(previous ? [previous] : []), ...history.snapshots]) unchanged(evidence, "transition input");
  if (git(context.workspace, ["rev-parse", "HEAD"], "utf8").trim() !== context.head) fail("protected Git head changed during receipt production");
  authenticatedReceipts.add(receipt); return freeze(receipt);
}

export function parseAcceptedDesktopTransitionTarget(input) {
  if (!(input instanceof Uint8Array) || !input.length || input.length > MAX_INPUT) fail("accepted transition target must be bounded bytes");
  const raw = Buffer.from(input); let receipt; try { receipt = exact(JSON.parse(raw), RECEIPT_FIELDS, "accepted transition target"); } catch { fail("accepted transition target is malformed"); }
  const target = exact(receipt.acceptedTarget, TARGET_FIELDS, "accepted target"), current = exact(receipt.current, CURRENT_FIELDS, "accepted current release");
  const canonical = Buffer.from(`${JSON.stringify({ schemaVersion: receipt.schemaVersion, kind: receipt.kind, action: receipt.action, acceptedTarget: Object.fromEntries(TARGET_FIELDS.map((field) => [field, target[field]])), current: Object.fromEntries(CURRENT_FIELDS.map((field) => [field, current[field]])), previouslyAcceptedTargetPacketSHA256: receipt.previouslyAcceptedTargetPacketSHA256 })}\n`);
  if (!raw.equals(canonical) || receipt.schemaVersion !== 1 || receipt.kind !== KIND || !["update", "rollback", "reupdate"].includes(receipt.action)) fail("accepted transition target is not canonical");
  for (const value of [target.packetSHA256, target.artifactSHA256, target.treeSHA256, target.sparklePublicKeySHA256, current.packetSHA256, current.artifactSHA256, current.treeSHA256]) if (!SHA256.test(value ?? "")) fail("accepted transition target digest is invalid");
  for (const value of [target.sourceSHA, target.tagObjectSHA, target.evidenceWorkflowSourceSHA, current.sourceSHA, current.tagObjectSHA]) if (!SHA1.test(value ?? "")) fail("accepted transition target source identity is invalid");
  for (const value of [target, current]) { const prerelease = typeof value.version === "string" ? value.version.match(/^1\.1\.0-(beta|rc)\.([1-9][0-9]{0,15})$/) : null, channel = prerelease?.[1] ?? (value.version === "1.1.0" ? "stable" : undefined); if (!channel || value.channel !== channel || channel === "beta" && prerelease[2].length > 4 || value.tag !== `v${value.version}` || !/^[0-9]+$/.test(value.build ?? "")) fail("accepted transition target release identity is invalid"); }
  const previous = receipt.previouslyAcceptedTargetPacketSHA256, targetBuild = BigInt(target.build), currentBuild = BigInt(current.build), forward = receipt.action !== "rollback";
  if ((previous !== null && !SHA256.test(previous ?? "")) || receipt.action === "update" && previous !== null || receipt.action !== "update" && previous !== target.packetSHA256 || forward && targetBuild <= currentBuild || !forward && targetBuild >= currentBuild || target.packetSHA256 === current.packetSHA256 || target.tag === current.tag || target.build === current.build || target.artifactSHA256 === current.artifactSHA256 || target.treeSHA256 === current.treeSHA256) fail("accepted transition target history identity is invalid");
  return freeze(receipt);
}
export function serializeAcceptedDesktopTransitionTarget(receipt) { if (!authenticatedReceipts.has(receipt)) fail("receipt was not produced by the accepted transition producer"); return `${JSON.stringify(receipt)}\n`; }
export function acceptedDesktopTransitionTargetDigest(receipt) { return sha256(Buffer.from(serializeAcceptedDesktopTransitionTarget(receipt))); }
