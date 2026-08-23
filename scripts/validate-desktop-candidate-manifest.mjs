import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
const here = fileURLToPath(new URL(".", import.meta.url));
const schema = JSON.parse(readFileSync(resolve(here, "../docs/schema/desktop-release-manifest-v1.schema.json"), "utf8"));
const SCHEMA_UNAVAILABLE = "schema validator unavailable";
let ImportedAjv;
try { const ajv = await import("ajv/dist/2020.js"); ImportedAjv = ajv.Ajv2020 ?? ajv.default; } catch {}
const workflowUrl = /^https:\/\/github\.com\/electricsheephq\/evaos-code-review-bot-neondiff\/actions\/runs\/[1-9]\d*$/;
const artifactUrl = /^https:\/\/github\.com\/electricsheephq\/evaos-code-review-bot-neondiff\/actions\/runs\/[1-9]\d*\/artifacts\/[1-9]\d*$/;
const digest = /^[0-9a-f]{64}$/;
const identity = /^Developer ID Application: [^<>]+ \(([A-Z0-9]{10})\)$/;
const placeholder = /<|>|placeholder|owner-provided|teamid|example/i;
const gates = ["artifact", "signing", "notarization", "stapling", "postStapleCodeSign", "gatekeeper", "feed", "site", "billing", "customer", "runtime", "rollback"];
function fail(...errors) { return { valid: false, errors }; }
function parseSemver(value) {
  const m = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value ?? "");
  if (!m || (m[4] ?? "").split(".").some((part) => /^0\d+$/.test(part))) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ? m[4].split(".") : [] };
}
export function compareSemver(a, b) {
  const left = parseSemver(a), right = parseSemver(b);
  if (!left || !right) return null;
  for (const key of ["major", "minor", "patch"]) if (left[key] !== right[key]) return left[key] - right[key];
  if (!left.pre.length || !right.pre.length) return left.pre.length ? -1 : right.pre.length ? 1 : 0;
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i++) {
    if (i === left.pre.length) return -1;
    if (i === right.pre.length) return 1;
    const x = left.pre[i], y = right.pre[i], xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn && yn && +x !== +y) return +x - +y;
    if (xn !== yn) return xn ? -1 : 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}
function https(value) {
  if (typeof value !== "string" || !value || /[\s\\\u0000-\u001f]/.test(value)) return false;
  try { const url = new URL(value); return url.protocol === "https:" && !!url.hostname && !url.username && !url.password && !url.search && !url.hash; } catch { return false; }
}
function refs(value) { return Array.isArray(value) && value.length > 0 && value.every((ref) => typeof ref === "string" && /\S/.test(ref)); }
function nonblank(value) { return typeof value === "string" && /\S/.test(value); }
function immutable(value, kind) { return (kind === "workflow" ? workflowUrl : artifactUrl).test(value); }
function sameDigest(value, expected) { return typeof value === "string" && digest.test(value) && value === expected; }
function checkGate(manifest, name, errors) {
  const value = manifest[name];
  if (value.state === "proven" && (!refs(value.evidenceRefs) || ("artifactSha256" in value && !sameDigest(value.artifactSha256, manifest.artifact.sha256)))) errors.push(`${name}: proven gate lacks artifact and evidence proof`);
}
function checkIdentity(manifest, name, errors) {
  checkGate(manifest, name, errors);
  const value = manifest[name];
  if (value.state !== "proven") return;
  if (!identity.test(value.identity ?? "") || placeholder.test(value.identity) || !/^[A-Z0-9]{10}$/.test(value.teamIdentifier ?? "") || placeholder.test(value.teamIdentifier) || value.identity.slice(-11, -1) !== value.teamIdentifier) errors.push(`${name}: concrete Developer ID identity and team identifier required`);
}
export function validateDesktopReleaseManifest(manifest, options = {}) {
  const Ajv = Object.prototype.hasOwnProperty.call(options, "ajv") ? options.ajv : ImportedAjv;
  if (!Ajv) return fail(SCHEMA_UNAVAILABLE);
  let valid;
  try {
    const instance = typeof Ajv === "function" ? new Ajv({ allErrors: true, strict: true, allowUnionTypes: true }) : Ajv;
    valid = instance.compile(schema)(manifest);
  } catch { return fail(SCHEMA_UNAVAILABLE); }
  if (!valid) return fail("schema validation failed");
  const errors = [], version = parseSemver(manifest.version);
  if (!version || (manifest.releaseLevel === "stable") !== !version.pre.length) errors.push("version: stable must be a release, and template/candidate/beta must be prereleases");
  if (manifest.releaseLevel === "stable" ? manifest.channel !== "stable" : manifest.channel !== "beta") errors.push("channel: does not match release level");
  if (manifest.contract.paidContract !== (manifest.releaseLevel === "stable" ? "paid-mac-ga-byo-v1" : "paid-mac-beta-byo-v1")) errors.push("contract: BYO contract does not match release level");
  if (manifest.source.ref !== `sha:${manifest.source.commit}` && manifest.source.ref !== `refs/tags/v${manifest.version}`) errors.push("source: ref must be an exact SHA ref or version-pinned tag");
  if (manifest.artifact.version !== manifest.version || manifest.artifact.archiveName !== `NeonDiff-${manifest.version}-build${manifest.artifact.build}-macOS.zip`) errors.push("artifact: version/build/archive identity mismatch");
  for (const [value, kind] of [[manifest.source.workflowRunRef, "workflow"], [manifest.artifact.workflowRunRef, "workflow"], [manifest.source.artifactRef, "artifact"], [manifest.artifact.artifactRef, "artifact"]]) if (value !== null && !immutable(value, kind)) errors.push("provenance: supported immutable workflow/artifact URL required");
  if (manifest.source.workflowRunRef !== manifest.artifact.workflowRunRef || manifest.source.artifactRef !== manifest.artifact.artifactRef) errors.push("provenance: source and artifact refs disagree");
  for (const value of [...Object.values(manifest.references), manifest.site.productUrl, manifest.site.downloadUrl, manifest.site.releaseNotesUrl, manifest.feed.embeddedFeedUrl, manifest.feed.feedUrl, manifest.feed.artifactUrl, manifest.feed.publicKeyRef, manifest.feed.signatureRef, manifest.rollback.targetReleaseRef, manifest.rollback.targetSignatureRef, manifest.rollback.targetPublicKeyRef].filter((x) => x !== null)) if (!https(value)) errors.push("url: credential-free HTTPS URL required");
  for (const name of ["artifact", ...gates]) if (!refs(manifest[name].evidenceRefs)) errors.push(`${name}: evidence references must be nonblank`);
  for (const name of gates) checkGate(manifest, name, errors);
  checkIdentity(manifest, "signing", errors); checkIdentity(manifest, "postStapleCodeSign", errors);
  if (manifest.releaseLevel === "template") {
    for (const name of gates) if (!["pending", "not-performed"].includes(manifest[name].state)) errors.push("template: every gate must remain pending or not-performed");
    if (!manifest.proofBoundary.excludes.some((item) => /not a release candidate/i.test(item))) errors.push("template: proof boundary must exclude release-candidate claims");
  }
  if (["beta", "stable"].includes(manifest.releaseLevel)) { for (const name of gates) if (manifest[name].state !== "proven") errors.push(`${name}: released manifest requires proof`); if (manifest.proofBoundary.excludes.some((item) => /\b(?:not|no|without|pending|unproven|excluded)\b.*\b(?:candidate|signed|notarized|stapled|gatekeeper|feed|site|billing|customer|runtime|rollback)\b/i.test(item))) errors.push("proof boundary: released proof cannot be excluded"); }
  if (manifest.artifact.state === "proven" && (!digest.test(manifest.artifact.sha256 ?? "") || !refs(manifest.artifact.evidenceRefs))) errors.push("artifact: proven artifact requires digest and evidence");
  if (manifest.feed.state === "proven" && (manifest.feed.channel !== manifest.channel || manifest.feed.embeddedFeedUrl !== manifest.feed.feedUrl || !nonblank(manifest.feed.publicKeyIdentity) || !nonblank(manifest.feed.publicKeyRef) || !nonblank(manifest.feed.signatureRef) || !sameDigest(manifest.feed.artifactSha256, manifest.artifact.sha256))) errors.push("feed: embedded URL, key identity, signature, and artifact binding are incomplete");
  if (manifest.site.state === "proven" && (!https(manifest.site.downloadUrl) || !https(manifest.site.releaseNotesUrl) || !sameDigest(manifest.site.artifactSha256, manifest.artifact.sha256))) errors.push("site: proven URL and artifact binding are incomplete");
  if (manifest.customer.state === "proven" && !nonblank(manifest.customer.canaryRef)) errors.push("customer: proven canary reference required");
  if (manifest.runtime.state === "proven" && (!nonblank(manifest.runtime.workerVersion) || !sameDigest(manifest.runtime.artifactSha256, manifest.artifact.sha256) || !digest.test(manifest.runtime.configIdentitySha256 ?? ""))) errors.push("runtime: artifact and independent config identity proof required");
  if (manifest.rollback.state === "proven") {
    const target = manifest.rollback.targetVersion;
    if (!target || compareSemver(target, manifest.version) === null || compareSemver(target, manifest.version) >= 0 || !digest.test(manifest.rollback.targetArtifactSha256 ?? "") || manifest.rollback.targetArtifactSha256 === manifest.artifact.sha256 || manifest.rollback.targetReleaseRef !== `https://github.com/electricsheephq/evaos-code-review-bot-neondiff/releases/tag/v${target}` || !https(manifest.rollback.targetReleaseRef) || !manifest.rollback.targetSignatureRef || !manifest.rollback.targetPublicKeyRef) errors.push("rollback: older immutable signed artifact proof required");
  }
  return errors.length ? fail(...errors) : { valid: true, errors: [] };
}
export function validateManifestIndex(indexPath, options = {}) {
  const Ajv = Object.prototype.hasOwnProperty.call(options, "ajv") ? options.ajv : ImportedAjv;
  if (!Ajv) return fail(SCHEMA_UNAVAILABLE);
  let index;
  try { index = JSON.parse(readFileSync(resolve(indexPath), "utf8")); } catch { return fail("manifest index unreadable or invalid"); }
  if (!index || typeof index !== "object" || Array.isArray(index)) return fail("manifest index shape invalid");
  const errors = [], expectedKeys = ["manifestPaths", "reason", "schemaVersion", "status"];
  if (JSON.stringify(Object.keys(index).sort()) !== JSON.stringify(expectedKeys)) errors.push("index: unexpected or missing fields");
  if (index.schemaVersion !== "desktop-release-manifest-index.v1" || !["no-versioned-manifest", "current"].includes(index.status) || !Array.isArray(index.manifestPaths) || index.manifestPaths.some((path) => typeof path !== "string" || !/^v\d+\.\d+\.\d+(?:-[^/]+)?-desktop-[^/]+\.json$/.test(path))) errors.push("index: strict versioned manifest index shape required");
  if (!nonblank(index.reason)) errors.push("index: reason is required");
  let discovered = [];
  try { discovered = readdirSync(resolve(indexPath, ".."), { withFileTypes: true }).filter((entry) => entry.isFile() && /^v\d+\.\d+\.\d+(?:-[^/]+)?-desktop-[^/]+\.json$/.test(entry.name)).map((entry) => entry.name).sort(); } catch { errors.push("index: candidate directory unreadable"); }
  const listed = Array.isArray(index.manifestPaths) ? [...index.manifestPaths].sort() : [];
  if (JSON.stringify(discovered) !== JSON.stringify(listed)) errors.push("index: does not enumerate every versioned Desktop manifest");
  if (index.status === "no-versioned-manifest" && (listed.length || !/defer|frozen|not a release candidate/i.test(index.reason ?? ""))) errors.push("index: pending status must explain deferred non-candidate state");
  if (index.status === "current" && !listed.length) errors.push("index: current status requires a manifest");
  for (const path of listed) {
    try { const result = validateDesktopReleaseManifest(JSON.parse(readFileSync(resolve(indexPath, "..", path), "utf8")), options); if (!result.valid) errors.push(`${path}: ${result.errors.join("; ")}`); } catch { errors.push(`${path}: manifest unreadable or invalid`); }
  }
  return errors.length ? fail(...errors) : { valid: true, errors: [] };
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const mode = process.argv[2], path = mode === "--index" ? process.argv[3] : mode;
  if (!path) { console.error("usage: node scripts/validate-desktop-candidate-manifest.mjs [--index] <path>"); process.exitCode = 64; }
  else { const result = mode === "--index" ? validateManifestIndex(path) : (() => { try { return validateDesktopReleaseManifest(JSON.parse(readFileSync(resolve(path), "utf8"))); } catch { return fail("manifest input unreadable or invalid"); } })(); if (!result.valid) { for (const error of result.errors) console.error(error); process.exitCode = 1; } }
}
