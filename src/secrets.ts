import {
  canonicalSecretRules,
  canonicalSecretSafeLiterals,
  canonicalSensitiveCookieRule
} from "./generated-secret-rules.js";

const SECRET_PATTERNS = canonicalSecretRules.map(
  (rule) => new RegExp(rule.source, rule.ignoreCase ? "gi" : "g")
);
const COOKIE_HEADER_PREFIX = canonicalSensitiveCookieRule.prefix;
const SENSITIVE_COOKIE_NAME_PATTERN = new RegExp(
  canonicalSensitiveCookieRule.sensitiveNameSource,
  "i"
);
const MAX_COOKIE_ATTRIBUTE_SCAN = canonicalSensitiveCookieRule.maximumAttributes;

export function containsSecretLikeText(input: string): boolean {
  const safeInput = protectSafeEnvVarNames(input);
  return containsSensitiveCookieHeader(safeInput) || SECRET_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(safeInput);
  });
}

export function redactSecrets(input: string): string {
  const protectedInput = protectSafeEnvVarNames(input);
  const redacted = SECRET_PATTERNS.reduce(
    (text, pattern) => text.replace(pattern, "[redacted-secret]"),
    redactSensitiveCookieHeaders(protectedInput)
  );
  return restoreSafeEnvVarNames(redacted);
}

export function stringifyRedactedJson(input: unknown): string {
  return JSON.stringify(redactJsonValue(input), null, 2);
}

function redactJsonValue(input: unknown): unknown {
  if (typeof input === "string") return redactSecrets(input);
  if (input instanceof Date) return input.toISOString();
  if (Array.isArray(input)) return input.map((item) => redactJsonValue(item));
  if (input && typeof input === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) output[key] = redactJsonValue(value);
    return output;
  }
  return input;
}

function containsSensitiveCookieHeader(input: string): boolean {
  return input.split(/\r?\n/).some((line) => readSensitiveCookieHeader(line) !== undefined);
}

function redactSensitiveCookieHeaders(input: string): string {
  return input
    .split(/(\r?\n)/)
    .map((segment) => readSensitiveCookieHeader(segment) === undefined ? segment : "[redacted-secret]")
    .join("");
}

function readSensitiveCookieHeader(line: string): string | undefined {
  const trimmedStart = line.trimStart();
  if (trimmedStart.slice(0, COOKIE_HEADER_PREFIX.length).toLowerCase() !== COOKIE_HEADER_PREFIX) {
    return undefined;
  }
  const colonIndex = line.indexOf(":");
  if (colonIndex < 0) return undefined;
  const attributes = line.slice(colonIndex + 1).split(";", MAX_COOKIE_ATTRIBUTE_SCAN + 1);
  if (attributes.length > MAX_COOKIE_ATTRIBUTE_SCAN) return line;
  for (const attribute of attributes) {
    const equalsIndex = attribute.indexOf("=");
    if (equalsIndex <= 0) continue;
    const name = attribute.slice(0, equalsIndex).trim();
    const value = attribute.slice(equalsIndex + 1).trim();
    if (value.length > 0 && SENSITIVE_COOKIE_NAME_PATTERN.test(name)) return line;
  }
  return undefined;
}

function protectSafeEnvVarNames(input: string): string {
  return canonicalSecretSafeLiterals.reduce((text, name, index) => {
    const pattern = new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(name)}(?![A-Za-z0-9_])`, "g");
    return text.replace(pattern, `__NEONDIFF_SAFE_ENV_${index}__`);
  }, input);
}

function restoreSafeEnvVarNames(input: string): string {
  return canonicalSecretSafeLiterals.reduce(
    (text, name, index) => text.replaceAll(`__NEONDIFF_SAFE_ENV_${index}__`, name),
    input
  );
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
