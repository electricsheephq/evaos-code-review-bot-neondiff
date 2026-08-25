import { createHash, createPublicKey, verify } from "node:crypto";

const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const OFFICIAL_ARTIFACT_PREFIX = "https://github.com/electricsheephq/evaos-code-review-bot-neondiff/releases/download/";
const ENCLOSURE_FIELDS = ["url", "version", "build", "shortVersionString", "channel", "artifactName", "artifactSHA256", "edSignature"];
const PROOF_FIELDS = ["schemaVersion", "kind", "verified", "signatureScope", "channel", "url", "artifactName", "artifactSHA256", "version", "build", "shortVersionString", "edSignature", "publicKeyFingerprint", "signedContentSHA256"];
const KIND = "neondiff.desktop.feed-enclosure-proof-v1";
const SIGNATURE_SCOPE = "sparkle-artifact-bytes";
const verifiedProofs = new WeakSet();
const fail = (message) => { throw new Error(message); };

function exactObject(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  const keys = Object.keys(value);
  if (keys.length !== fields.length || keys.some((key) => !fields.includes(key))) fail(`${label} has undeclared fields`);
  return value;
}
function text(value, label) { if (typeof value !== "string" || value.length === 0) fail(`${label} is required`); return value; }
function base64(value, bytes, label) {
  const encoded = text(value, label);
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) fail(`${label} is malformed`);
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.length !== bytes || decoded.toString("base64") !== encoded) fail(`${label} has the wrong length`);
  return decoded;
}
function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function canonicalBytes(value) {
  if (!(Buffer.isBuffer(value) || value instanceof Uint8Array)) fail("signedContent must be bytes");
  return Buffer.from(value);
}
function validateEnclosure(enclosure) {
  const value = exactObject(enclosure, ENCLOSURE_FIELDS, "enclosure");
  const urlText = text(value.url, "enclosure.url"), url = new URL(urlText);
  if (url.toString() !== urlText || /[?#]/.test(urlText) || url.protocol !== "https:" || url.username || url.password || url.search || url.hash || !urlText.startsWith(OFFICIAL_ARTIFACT_PREFIX)) fail("enclosure.url must be the canonical official artifact URL");
  const version = text(value.version, "enclosure.version"), build = text(value.build, "enclosure.build"), shortVersionString = text(value.shortVersionString, "enclosure.shortVersionString");
  const channel = value.channel, artifactNameInput = text(value.artifactName, "enclosure.artifactName"), artifactSHA256 = text(value.artifactSHA256, "enclosure.artifactSHA256"), edSignature = text(value.edSignature, "enclosure.edSignature");
  if (!/^\d+\.\d+\.\d+(?:-(?:beta|rc)\.[1-9]\d{0,15})?$/.test(version) || !/^\d+$/.test(build)) fail("enclosure version/build is malformed");
  const prerelease = version.match(/-(beta|rc)\./)?.[1] ?? null, feedChannel = prerelease === "rc" ? "beta" : prerelease ?? "stable";
  if (shortVersionString !== version || !["beta", "stable"].includes(channel) || feedChannel !== channel) fail("enclosure identity is malformed");
  const artifactName = `NeonDiff-${version}-build${build}-macOS.zip`;
  if (artifactNameInput !== artifactName) fail("enclosure artifact name is not canonical");
  const path = url.pathname;
  const pathMatch = path.match(/^\/electricsheephq\/evaos-code-review-bot-neondiff\/releases\/download\/([^/]+)\/([^/]+)$/);
  if (!pathMatch || pathMatch[1] !== `v${version}` || pathMatch[2] !== artifactName) fail("enclosure artifact identity is not canonical");
  if (!/^[a-f0-9]{64}$/.test(artifactSHA256)) fail("enclosure artifact SHA-256 is malformed");
  const signatureBytes = base64(edSignature, 64, "enclosure.edSignature");
  return { url: urlText, version, build, shortVersionString, channel, artifactName, artifactSHA256, edSignature, signatureBytes };
}
function validateProof(proof) {
  const value = exactObject(proof, PROOF_FIELDS, "proof");
  if (!verifiedProofs.has(proof) || value.schemaVersion !== 1 || value.kind !== KIND || value.verified !== true || value.signatureScope !== SIGNATURE_SCOPE) fail("proof is not verified");
  validateEnclosure({ url: value.url, version: value.version, build: value.build, shortVersionString: value.shortVersionString, channel: value.channel, artifactName: value.artifactName, artifactSHA256: value.artifactSHA256, edSignature: value.edSignature });
  if (value.signedContentSHA256 !== value.artifactSHA256 || !/^sha256:[a-f0-9]{64}$/.test(value.publicKeyFingerprint)) fail("proof content or key identity is malformed");
  return value;
}

export function buildFeedEnclosureProof(enclosure, { acceptedPublicKey, signedContent } = {}) {
  const value = validateEnclosure(enclosure), bytes = canonicalBytes(signedContent);
  if (sha256(bytes) !== value.artifactSHA256) fail("signed content digest does not match enclosure artifact");
  const publicKey = base64(acceptedPublicKey, 32, "acceptedPublicKey"), signature = value.signatureBytes;
  const key = createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, publicKey]), format: "der", type: "spki" });
  if (!verify(null, bytes, key, signature)) fail("Sparkle EdDSA signature verification failed");
  const proof = Object.freeze({ schemaVersion: 1, kind: KIND, verified: true, signatureScope: SIGNATURE_SCOPE, channel: value.channel, url: value.url, artifactName: value.artifactName, artifactSHA256: value.artifactSHA256, version: value.version, build: value.build, shortVersionString: value.shortVersionString, edSignature: value.edSignature, publicKeyFingerprint: `sha256:${sha256(publicKey)}`, signedContentSHA256: sha256(bytes) });
  verifiedProofs.add(proof);
  return proof;
}
export function serializeFeedEnclosureProof(proof) {
  const value = validateProof(proof);
  return `${JSON.stringify(Object.fromEntries(PROOF_FIELDS.map((field) => [field, value[field]])))}\n`;
}
export function feedEnclosureProofDigest(proof) { return sha256(Buffer.from(serializeFeedEnclosureProof(proof), "utf8")); }
