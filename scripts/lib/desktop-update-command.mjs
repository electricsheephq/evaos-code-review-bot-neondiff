import { createHash, createPublicKey, verify } from "node:crypto";

const SHA = /^[0-9a-f]{64}$/;
const LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ACTIONS = new Set(["update", "rollback", "reupdate"]);
function fail(message) { throw new Error(message); }
function exact(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) fail(`${label} shape is invalid`);
}
function hash(value) { return createHash("sha256").update(value).digest("hex"); }
function hashes(value, keys, label) {
  for (const key of keys) if (!SHA.test(value[key] ?? "")) fail(`${label} ${key} is invalid`);
}
function base64(value, bytes, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) fail(`${label} is invalid`);
  const decoded = Buffer.from(value, "base64");
  if (decoded.byteLength !== bytes || decoded.toString("base64") !== value) fail(`${label} is invalid`);
  return decoded;
}

export function planDesktopUpdate({ action, declaration, declarationBytes, packet, packetBytes, packetSHA256, artifactBytes, expectedTeamID }) {
  if (!ACTIONS.has(action)) fail("update action is invalid");
  if (!Buffer.isBuffer(packetBytes) || !Buffer.isBuffer(artifactBytes)) fail("accepted packet and artifact must be immutable bytes");
  if (!SHA.test(packetSHA256 ?? "") || hash(packetBytes) !== packetSHA256) fail("accepted packet digest mismatch");
  if (JSON.stringify(packet) !== packetBytes.toString("utf8")) fail("accepted packet must be canonical JSON");
  exact(packet, ["schemaVersion", "declarationSHA256", "release", "sparkle", "apple", "prestate"], "accepted packet");
  if (packet.schemaVersion !== 1) fail("accepted packet schema is invalid");
  if (!Buffer.isBuffer(declarationBytes) || !SHA.test(packet.declarationSHA256 ?? "") || hash(declarationBytes) !== packet.declarationSHA256) fail("accepted declaration digest mismatch");
  exact(packet.release, ["version", "tag", "channel", "build", "artifactName", "artifactSHA256", "treeSHA256"], "release receipt");
  exact(packet.sparkle, ["publicKey", "edSignature", "feedURL", "entrySHA256"], "Sparkle receipt");
  exact(packet.apple, ["teamID", "notarized", "stapled", "gatekeeper"], "Apple receipt");
  exact(packet.prestate, ["appSHA256", "configSHA256", "databaseSHA256", "allowlistSHA256", "plistSHA256", "label", "wrapperPID", "wrapperPath", "helperPID", "helperPath"], "prestate receipt");
  const release = packet.release, expected = [declaration.version, declaration.tag, declaration.channel, declaration.build, declaration.distribution?.artifactName];
  if (JSON.stringify([release.version, release.tag, release.channel, release.build, release.artifactName]) !== JSON.stringify(expected)) fail("accepted packet disagrees with declaration identity");
  hashes(release, ["artifactSHA256", "treeSHA256"], "release receipt");
  if (hash(artifactBytes) !== release.artifactSHA256) fail("artifact digest mismatch");
  hashes(packet.sparkle, ["entrySHA256"], "Sparkle receipt");
  if (packet.sparkle.feedURL !== declaration.distribution?.origins?.feed) fail("Sparkle feed disagrees with declaration");
  const signature = base64(packet.sparkle.edSignature, 64, "Sparkle signature"), keyBytes = base64(packet.sparkle.publicKey, 44, "Sparkle public key");
  let verified = false;
  try { verified = verify(null, artifactBytes, createPublicKey({ key: keyBytes, format: "der", type: "spki" }), signature); } catch { verified = false; }
  if (!verified) fail("Sparkle signature verification failed");
  if (!/^[A-Z0-9]{10}$/.test(expectedTeamID ?? "") || packet.apple.teamID !== expectedTeamID) fail("approved Team ID mismatch");
  if (packet.apple.notarized !== true || packet.apple.stapled !== true || packet.apple.gatekeeper !== true) fail("Apple notarization, staple, and Gatekeeper proof are required");
  hashes(packet.prestate, ["appSHA256", "configSHA256", "databaseSHA256", "allowlistSHA256", "plistSHA256"], "prestate receipt");
  if (!LABEL.test(packet.prestate.label) || !Number.isInteger(packet.prestate.wrapperPID) || packet.prestate.wrapperPID < 1 || !Number.isInteger(packet.prestate.helperPID) || packet.prestate.helperPID < 1 || packet.prestate.wrapperPath !== "/Applications/NeonDiff.app/Contents/MacOS/NeonDiffDesktop" || packet.prestate.helperPath !== "/Applications/NeonDiff.app/Contents/Helpers/NeonDiffWorker") fail("prestate worker identity is invalid");
  return {
    schemaVersion: 1, dryRun: true, action, packetSHA256,
    candidate: { version: release.version, build: release.build, channel: release.channel, declarationSHA256: packet.declarationSHA256, artifactSHA256: release.artifactSHA256, treeSHA256: release.treeSHA256, feedEntrySHA256: packet.sparkle.entrySHA256 },
    prestate: { ...packet.prestate },
    steps: ["wait-for-zero-lease-cycle", "stage-and-verify", "swap-and-restart-exact-service", "verify-poststate"]
  };
}

export function executeDesktopTransition({ plan, snapshot, ops }) {
  exact(snapshot, ["cycleBoundary", "timedOut", "activeLeases", "workerPairs", "label", "appSHA256", "accountIdentitySHA256", "botIdentitySHA256", "configSHA256", "databaseSHA256", "allowlistSHA256", "keychainIdentitySHA256", "plistSHA256", "destinationDevice", "stageDevice"], "transition snapshot");
  exact(ops, ["stage", "verifyStage", "stopExactService", "exchange", "startExactService", "inspectPoststate"], "transition operations");
  if (plan?.schemaVersion !== 1 || plan?.dryRun !== true) fail("accepted dry plan is required");
  if (snapshot.timedOut || snapshot.cycleBoundary !== true || snapshot.activeLeases !== 0) fail("bounded zero-lease cycle boundary is required");
  if (snapshot.workerPairs !== 1 || snapshot.label !== plan.prestate.label) fail("exactly one selected worker service is required");
  for (const key of ["appSHA256", "accountIdentitySHA256", "botIdentitySHA256", "configSHA256", "databaseSHA256", "allowlistSHA256", "keychainIdentitySHA256", "plistSHA256"]) if (snapshot[key] !== plan.prestate[key]) fail(`prestate ${key} drifted`);
  if (!Number.isInteger(snapshot.destinationDevice) || snapshot.destinationDevice !== snapshot.stageDevice) fail("stage and destination must share one filesystem");
  for (const name of Object.keys(ops)) if (typeof ops[name] !== "function") fail(`transition operation ${name} is invalid`);
  ops.stage(plan.candidate); ops.verifyStage(plan.candidate);
  let stopped = false, swapped = false;
  try {
    ops.stopExactService(snapshot.label); stopped = true;
    ops.exchange(); swapped = true;
    ops.startExactService(snapshot.label);
    const poststate = ops.inspectPoststate();
    exact(poststate, ["version", "build", "appSHA256", "accountIdentitySHA256", "botIdentitySHA256", "configSHA256", "databaseSHA256", "allowlistSHA256", "keychainIdentitySHA256", "plistSHA256", "label", "workerPairs", "heartbeatFresh", "statusAccepted"], "poststate receipt");
    if (poststate.version !== plan.candidate.version || poststate.build !== plan.candidate.build || poststate.appSHA256 !== plan.candidate.treeSHA256 || poststate.label !== snapshot.label || poststate.workerPairs !== 1 || poststate.heartbeatFresh !== true || poststate.statusAccepted !== true) fail("installed app or worker poststate is not accepted");
    for (const key of ["accountIdentitySHA256", "botIdentitySHA256", "configSHA256", "databaseSHA256", "allowlistSHA256", "keychainIdentitySHA256", "plistSHA256"]) if (poststate[key] !== plan.prestate[key]) fail(`poststate ${key} drifted`);
    return poststate;
  } catch (error) {
    if (!stopped) throw error;
    try { if (swapped) { ops.stopExactService(snapshot.label); ops.exchange(); } ops.startExactService(snapshot.label); }
    catch (recovery) { fail(`Desktop transition failed and recovery was incomplete: ${error instanceof Error ? error.message : error}; ${recovery instanceof Error ? recovery.message : recovery}`); }
    throw error;
  }
}
