import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
let Ajv2020;
try { Ajv2020 = (await import("ajv/dist/2020.js")).default; } catch { Ajv2020 = null; }
const SCHEMA_VALIDATOR_UNAVAILABLE = "schema validator unavailable";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const schemaPath = resolve(root, "docs/schema/desktop-candidate-manifest.schema.json");
const defaultManifestPath = resolve(root, "docs/release-candidates/v1.1.0-desktop-candidate-manifest.json");
const scenarios = ["clean install and launch", "customer-owned GitHub App binding", "provider verification and dry run before live review", "entitlement loss and recovery", "manual signed update and rollback with state preservation"];
const gates = ["artifact", "signing", "notarization", "feed", "site", "billing", "customer", "runtime", "rollback"];
const sha = value => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const text = value => typeof value === "string" && value.trim().length > 0;
const https = value => { try { const url = new URL(value); return url.protocol === "https:" && Boolean(url.hostname) && !url.username && !url.password && !/\s/.test(value); } catch { return false; } };
const add = (errors, path, message) => errors.push(`${path}: ${message}`);
const refs = (value, path, errors) => { if (!Array.isArray(value) || value.length === 0) add(errors, path, "evidenceRefs must be non-empty"); else value.forEach((ref, i) => { if (!text(ref)) add(errors, `${path}[${i}]`, "must not be blank"); }); };
const semver = value => { const match = typeof value === "string" && value.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/); return match && [Number(match[1]), Number(match[2]), Number(match[3]), match[4] ?? ""]; };
const older = (target, current) => { const a = semver(target), b = semver(current); if (!a || !b) return false; for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] < b[i]; return Boolean(a[3]) && !b[3]; };

export function validateDesktopCandidateManifest(manifest, schema = JSON.parse(readFileSync(schemaPath, "utf8")), options = {}) {
  const errors = [];
  const ajvConstructor = options.ajv === undefined ? Ajv2020 : options.ajv;
  if (!ajvConstructor) return { valid: false, errors: [SCHEMA_VALIDATOR_UNAVAILABLE] };
  try {
    const validate = new ajvConstructor({ allErrors: true, strict: true }).compile(schema); if (!validate(manifest)) for (const error of validate.errors ?? []) add(errors, error.instancePath || "/", error.message ?? "schema violation");
  } catch { return { valid: false, errors: [SCHEMA_VALIDATOR_UNAVAILABLE] }; }
  if (errors.length > 0 || !manifest || typeof manifest !== "object") return { valid: false, errors };
  const m = manifest;
  const level = m.releaseLevel;
  if (m.contract.mode !== "byo" || m.contract.byoGitHubEnabled !== true || m.contract.managedBrokerEnabled !== false || m.contract.brokerOrigin !== null) add(errors, "/contract", "only the explicit customer-owned BYO contract is in v1");
  if (level === "stable" || m.channel === "stable") { if (level !== "stable" || m.channel !== "stable") add(errors, "/channel", "stable channel requires stable releaseLevel"); if (String(m.version).includes("-")) add(errors, "/version", "stable version must not be a prerelease"); if (m.contract.paidContract !== "paid-mac-ga-byo-v1") add(errors, "/contract/paidContract", "stable requires the explicit GA BYO contract"); } else { if (level !== "candidate" && level !== "beta") add(errors, "/releaseLevel", "beta channel requires candidate or beta releaseLevel"); if (m.contract.paidContract !== "paid-mac-beta-byo-v1") add(errors, "/contract/paidContract", "beta/candidate requires the explicit beta BYO contract"); }
  if (level === "beta" || level === "stable") for (const gate of gates) if (m[gate].state !== "proven") add(errors, `/${gate}/state`, "released beta and stable manifests require proven gates");
  if (m.channel !== m.feed.channel) add(errors, "/feed/channel", "must equal the top-level channel");
  if (m.artifact.version !== m.version) add(errors, "/artifact/version", "must equal the manifest version");
  if (m.artifact.archiveName !== `NeonDiff-${m.version}-build${m.artifact.build}-macOS.zip`) add(errors, "/artifact/archiveName", "must bind the archive to version and build");
  if (m.source.workflowRunRef !== m.artifact.workflowRunRef || m.source.artifactRef !== m.artifact.artifactRef) add(errors, "/artifact", "source and artifact workflow/artifact provenance must agree");
  for (const [name, value] of Object.entries(m)) if (name === "references") for (const [key, url] of Object.entries(value)) if (!https(url)) add(errors, `/references/${key}`, "must be a valid HTTPS URL");
  for (const [name, value] of [["feedUrl", m.feed.feedUrl], ["artifactUrl", m.feed.artifactUrl], ["downloadUrl", m.site.downloadUrl], ["releaseNotesUrl", m.site.releaseNotesUrl]]) if (value !== null && (!text(value) || !https(value))) add(errors, `/${name}`, "must be a valid HTTPS URL when present");
  for (const gate of ["artifact", "signing", "notarization", "feed", "site", "billing", "customer", "runtime", "rollback"]) refs(m[gate].evidenceRefs, `/${gate}/evidenceRefs`, errors);
  if (JSON.stringify([...m.customer.requiredScenarios].sort()) !== JSON.stringify([...scenarios].sort())) add(errors, "/customer/requiredScenarios", "must be the complete BYO scenario set");
  const digest = m.artifact.sha256;
  for (const [path, value] of [["feed", m.feed.artifactSha256], ["site", m.site.artifactSha256], ["signing", m.signing.artifactSha256], ["notarization", m.notarization.artifactSha256]]) if (value !== null && digest !== null && value !== digest) add(errors, `/${path}/artifactSha256`, "must equal artifact.sha256");
  if (m.artifact.state === "proven") { if (!sha(digest)) add(errors, "/artifact/sha256", "proven artifact requires a SHA-256"); for (const field of ["workflowRunRef", "artifactRef"]) if (!text(m.artifact[field])) add(errors, `/artifact/${field}`, "proven artifact requires identity"); }
  for (const gate of ["signing", "notarization"]) if (m[gate].state === "proven") { if (!text(m[gate].identity)) add(errors, `/${gate}/identity`, "must not be blank"); if (!sha(digest) || m[gate].artifactSha256 !== digest) add(errors, `/${gate}/artifactSha256`, "proof must bind the candidate artifact"); }
  if (m.feed.state === "proven") { for (const [key, value] of [["feedUrl", m.feed.feedUrl], ["artifactUrl", m.feed.artifactUrl]]) if (!https(value)) add(errors, `/feed/${key}`, "proven feed requires a valid HTTPS URL"); for (const key of ["publicKeyRef", "signatureRef", "rollbackRef"]) if (!text(m.feed[key])) add(errors, `/feed/${key}`, "proven feed requires evidence"); if (!sha(digest) || m.feed.artifactSha256 !== digest) add(errors, "/feed/artifactSha256", "proven feed must bind the candidate artifact"); }
  if (m.site.state === "proven") { for (const key of ["downloadUrl", "releaseNotesUrl"]) if (!https(m.site[key])) add(errors, `/site/${key}`, "proven site requires a valid HTTPS URL"); if (!sha(digest) || m.site.artifactSha256 !== digest) add(errors, "/site/artifactSha256", "proven site must bind the candidate artifact"); }
  if (m.billing.state === "proven") for (const key of ["authorityRef", "activationRef"]) if (!text(m.billing[key])) add(errors, `/billing/${key}`, "must not be blank");
  if (m.customer.state === "proven" && !text(m.customer.canaryRef)) add(errors, "/customer/canaryRef", "proven customer gate requires a canary reference");
  if (m.runtime.state === "proven") { if (!text(m.runtime.workerVersion)) add(errors, "/runtime/workerVersion", "must not be blank"); if (!sha(digest) || m.runtime.configIdentitySha256 !== digest) add(errors, "/runtime/configIdentitySha256", "must bind the candidate artifact"); }
  if (m.rollback.state === "proven") { for (const key of ["targetVersion", "targetReleaseRef", "targetSignatureRef", "targetPublicKeyRef"]) if (!text(m.rollback[key])) add(errors, `/rollback/${key}`, "proven rollback requires signed predecessor evidence"); if (!sha(m.rollback.targetArtifactSha256) || m.rollback.targetArtifactSha256 === digest) add(errors, "/rollback/targetArtifactSha256", "must identify a distinct artifact"); if (!older(m.rollback.targetVersion, m.version)) add(errors, "/rollback/targetVersion", "must be an older semver predecessor"); if (!https(m.rollback.targetReleaseRef)) add(errors, "/rollback/targetReleaseRef", "must be an immutable HTTPS release reference"); }
  return { valid: errors.length === 0, errors };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const manifestPath = resolve(process.argv[2] ?? defaultManifestPath);
  const result = validateDesktopCandidateManifest(JSON.parse(readFileSync(manifestPath, "utf8")));
  if (!result.valid) { console.error(JSON.stringify({ ok: false, manifestPath, errors: result.errors }, null, 2)); process.exitCode = 1; } else console.log(JSON.stringify({ ok: true, manifestPath }));
}
