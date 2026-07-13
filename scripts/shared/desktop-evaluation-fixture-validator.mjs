import { containsCanonicalSecretLikeText } from "./secret-patterns.mjs";

const sections = new Set(["overview", "repos", "providers", "license", "logs", "policy", "settings"]);
const onboardingSteps = new Set(["welcome", "provider", "daemon", "license", "done"]);
const appearances = new Set(["dark", "light", "system"]);
const healthStates = new Set(["unknown", "healthy", "degraded", "offline"]);
const profiles = new Set(["default", "strict"]);
const adapters = new Set(["openai-compatible", "zcode"]);
const authModes = new Set(["none", "api-key-env", "zcode-app-config"]);
const verificationStates = new Set(["healthy", "configured_unverified", "blocked", "dirty", "in_progress"]);
const entitlements = new Set(["not activated", "active", "activation blocked"]);
const channels = new Set(["dev", "beta", "stable"]);
const githubConnections = new Set(["disconnected", "device_code", "connected", "recovery"]);
const actions = new Set([
  "refresh-status", "refresh-repositories", "verify-provider", "inspect-license", "copy-redacted-log",
  "preview-policy", "inspect-settings", "begin-setup", "choose-provider",
  "check-daemon", "activate-license", "finish-onboarding"
]);
const outcomes = new Set(["success", "failure", "cancelled"]);
const canonicalSizes = new Set(["1040x680", "1280x800", "1440x900", "760x560", "560x700"]);
const maximumFixtureBytes = 256 * 1024;

function fail(message) { throw new Error(`fixture schema: ${message}`); }
function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
}
function exactKeys(value, keys, label) {
  object(value, label);
  const actual = Object.keys(value).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...keys].sort())) fail(`${label} fields are invalid`);
}
function optionalKeys(value, required, optional, label) {
  object(value, label);
  for (const key of required) if (!(key in value)) fail(`${label}.${key} is missing`);
  if (Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))) fail(`${label} has an unknown field`);
}
function enumValue(value, allowed, label) {
  if (typeof value !== "string" || !allowed.has(value)) fail(`${label} is invalid`);
  return value;
}
function boolean(value, label) {
  if (typeof value !== "boolean") fail(`${label} must be boolean`);
  return value;
}
function publicSafe(value, path = "root") {
  if (typeof value === "string") {
    if (Buffer.byteLength(value) > 4096) fail(`oversized string at ${path}`);
    const lowered = value.toLowerCase();
    if (["/users/", "/volumes/", "file://", ".ssh/"].some((part) => lowered.includes(part))
      || containsCanonicalSecretLikeText(value)) fail(`unsafe content at ${path}`);
  } else if (Array.isArray(value)) value.forEach((item, index) => publicSafe(item, `${path}[${index}]`));
  else if (value && typeof value === "object") Object.entries(value).forEach(([key, item]) => publicSafe(item, `${path}.${key}`));
}
function isoDate(value, label) {
  if (typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)
    || Number.isNaN(Date.parse(value))
    || new Date(value).toISOString().replace(".000Z", "Z") !== value) {
    fail(`${label} is invalid`);
  }
  return value;
}

export function validateDesktopEvaluationFixture(input) {
  publicSafe(input);
  exactKeys(input, ["schemaVersion", "id", "surface", "environment", "state", "scriptedOutcomes", "expectedActions", "safeCopy"], "root");
  if (input.schemaVersion !== 1 || typeof input.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(input.id)) fail("identity is invalid");
  optionalKeys(input.surface, ["section"], ["onboardingStep"], "surface");
  const step = input.surface.onboardingStep;
  if (step !== null && step !== undefined) enumValue(step, onboardingSteps, "surface.onboardingStep");
  optionalKeys(input.environment, ["clock", "locale", "appearance", "disableAnimations"], ["contentSize"], "environment");
  isoDate(input.environment.clock, "environment.clock");
  if (typeof input.environment.locale !== "string" || !/^[A-Za-z0-9_@.-]{2,48}$/.test(input.environment.locale)) fail("environment.locale is invalid");
  enumValue(input.environment.appearance, appearances, "environment.appearance");
  if (input.environment.disableAnimations !== true) fail("animations must be disabled");
  const contentSize = input.environment.contentSize ?? null;
  if (contentSize !== null) {
    exactKeys(contentSize, ["width", "height"], "environment.contentSize");
    if (!Number.isInteger(contentSize.width) || !Number.isInteger(contentSize.height)
      || !canonicalSizes.has(`${contentSize.width}x${contentSize.height}`)) fail("environment.contentSize is invalid");
  }

  optionalKeys(input.state, ["health", "repositories", "license", "github", "logText"], ["runtimeReady", "provider"], "state");
  enumValue(input.state.health, healthStates, "state.health");
  const runtimeReady = input.state.runtimeReady ?? null;
  if (runtimeReady !== null) boolean(runtimeReady, "state.runtimeReady");
  if (!Array.isArray(input.state.repositories) || input.state.repositories.length > 100) fail("state.repositories is invalid");
  const repositories = input.state.repositories.map((repository, index) => {
    exactKeys(repository, ["name", "enabled", "profile", "lastReview"], `state.repositories[${index}]`);
    if (typeof repository.name !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository.name)) fail("repository name is invalid");
    boolean(repository.enabled, "repository.enabled");
    enumValue(repository.profile, profiles, "repository.profile");
    isoDate(repository.lastReview, "repository.lastReview");
    return repository;
  });
  let provider = null;
  if (input.state.provider !== null && input.state.provider !== undefined) {
    provider = input.state.provider;
    exactKeys(provider, ["id", "displayName", "adapter", "authMode", "baseURL", "model", "credentialPresent", "verification"], "state.provider");
    if (typeof provider.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(provider.id) || typeof provider.displayName !== "string" || !provider.displayName || Buffer.byteLength(provider.displayName) > 128 || typeof provider.model !== "string" || !provider.model || Buffer.byteLength(provider.model) > 256) fail("provider identity is invalid");
    enumValue(provider.adapter, adapters, "provider.adapter");
    enumValue(provider.authMode, authModes, "provider.authMode");
    enumValue(provider.verification, verificationStates, "provider.verification");
    boolean(provider.credentialPresent, "provider.credentialPresent");
    if (typeof provider.baseURL !== "string") fail("provider.baseURL is invalid");
    let url;
    try { url = new URL(provider.baseURL); } catch { fail("provider.baseURL is invalid"); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) fail("provider.baseURL is invalid");
  }
  exactKeys(input.state.license, ["entitlement", "credentialPresent", "updateChannel"], "state.license");
  enumValue(input.state.license.entitlement, entitlements, "license.entitlement");
  boolean(input.state.license.credentialPresent, "license.credentialPresent");
  enumValue(input.state.license.updateChannel, channels, "license.updateChannel");
  optionalKeys(input.state.github, ["connection", "repositoryCount"], ["login"], "state.github");
  enumValue(input.state.github.connection, githubConnections, "github.connection");
  const login = input.state.github.login ?? null;
  if (login !== null && (typeof login !== "string" || !/^[A-Za-z0-9-]{1,39}$/.test(login))) fail("github.login is invalid");
  if (!Number.isInteger(input.state.github.repositoryCount) || input.state.github.repositoryCount < 0) fail("github.repositoryCount is invalid");
  if (typeof input.state.logText !== "string") fail("state.logText is invalid");

  if (["daemon", "license", "done"].includes(step) && provider?.credentialPresent !== true) fail("onboarding provider prerequisite is incomplete");
  if (["license", "done"].includes(step) && runtimeReady === null) fail("onboarding daemon prerequisite is incomplete");
  if (!Array.isArray(input.scriptedOutcomes) || input.scriptedOutcomes.length > 50) fail("scriptedOutcomes is invalid");
  const scriptedOutcomes = input.scriptedOutcomes.map((outcome, index) => {
    exactKeys(outcome, ["action", "result", "delayMilliseconds"], `scriptedOutcomes[${index}]`);
    enumValue(outcome.action, actions, "outcome.action");
    enumValue(outcome.result, outcomes, "outcome.result");
    if (!Number.isInteger(outcome.delayMilliseconds) || outcome.delayMilliseconds < 0 || outcome.delayMilliseconds > 30_000) fail("outcome.delayMilliseconds is invalid");
    return outcome;
  });
  if (!Array.isArray(input.expectedActions) || input.expectedActions.length > 50) fail("expectedActions is invalid");
  input.expectedActions.forEach((action) => enumValue(action, actions, "expected action"));
  if (step === "license"
    && (input.state.license.entitlement !== "not activated"
      || input.state.license.credentialPresent
      || input.expectedActions.length !== 1
      || input.expectedActions[0] !== "activate-license")) {
    fail("license onboarding must be blocked on API-backed activation");
  }
  if (step === "done"
    && (input.state.license.entitlement !== "active" || !input.state.license.credentialPresent)) {
    fail("done onboarding requires API-backed activation");
  }
  if ((step === null || step === undefined)
    && (input.state.license.entitlement !== "active" || !input.state.license.credentialPresent)) {
    fail("post-onboarding state requires API-backed activation");
  }
  if (!Array.isArray(input.safeCopy) || input.safeCopy.length > 100 || input.safeCopy.some((value) => typeof value !== "string")) fail("safeCopy is invalid");

  return {
    schemaVersion: 1,
    id: input.id,
    surface: { section: enumValue(input.surface.section, sections, "surface.section"), onboardingStep: step ?? null },
    environment: { clock: input.environment.clock, locale: input.environment.locale, appearance: input.environment.appearance, disableAnimations: true, contentSize },
    state: { health: input.state.health, runtimeReady, repositories, provider, license: input.state.license, github: { ...input.state.github, login }, logText: input.state.logText },
    scriptedOutcomes,
    expectedActions: input.expectedActions,
    safeCopy: input.safeCopy
  };
}

export function decodeDesktopEvaluationFixtureData(data) {
  const input = decodeDesktopEvaluationPublicSafeJSON(data, maximumFixtureBytes, "fixture");
  return validateDesktopEvaluationFixture(input);
}

export function decodeDesktopEvaluationPublicSafeJSON(data, maximumBytes, label) {
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (bytes.byteLength > maximumBytes) fail(`${label} exceeds ${maximumBytes}-byte limit`);
  let input;
  try {
    input = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail(`${label} is not valid JSON`);
  }
  publicSafe(input);
  return input;
}

export function canonicalDesktopEvaluationFixtureJSON(value) {
  return JSON.stringify(sortObjectKeys(value));
}

function sortObjectKeys(value) {
  if (Array.isArray(value)) return value.map(sortObjectKeys);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, sortObjectKeys(value[key])])
  );
}
