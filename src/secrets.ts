const SECRET_PATTERNS: RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9_]{8,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{8,}\b/g,
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/gi,
  /https?:\/\/[^/\s@]+@[^/\s]+/gi,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/gi,
  /[?&](?:access[_-]?token|auth[_-]?token|api[_-]?key|token|secret|session|cookie)=[A-Za-z0-9._~+/=-]{16,}/gi,
  /\bcustomer[_-]?id\b\s*[:=]\s*["']?cus_[A-Za-z0-9]{8,}/gi,
  /\b(?:customer|client)[_-]?ssn\b\s*[:=]\s*["']?\d{3}-\d{2}-\d{4}\b/gi,
  /\b(?:customer|client)[_-]?phone\b\s*[:=]\s*["']?\+?\d[\d ().-]{7,}\d\b/gi,
  /\b(?:api[_-]?key|token|secret|password|cookie|session)\b\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{16,}/gi,
  /\b(?:NEONDIFF|NDL|LIC)_[A-Za-z0-9][A-Za-z0-9_-]{11,}\b/gi,
  /(?<![A-Za-z0-9_./-])(?:[Nn][Ee][Oo][Nn][Dd][Ii][Ff][Ff]|[Nn][Dd][Ll]|[Ll][Ii][Cc])-(?=[A-Za-z0-9_-]*[A-Z0-9])[A-Za-z0-9][A-Za-z0-9_-]{11,}\b/g,
  /\b[A-Za-z0-9]{3,}[-_](?:secret|token|password|cookie)[-_][A-Za-z0-9_-]{3,}\b/gi,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*/g
];

const COOKIE_HEADER_PREFIX = "cookie:";
const SENSITIVE_COOKIE_NAME_PATTERN = /(?:session|token|auth|secret|cookie)/i;
const MAX_COOKIE_ATTRIBUTE_SCAN = 1_000;
const SAFE_ENV_VAR_NAMES = [
  "NEONDIFF_GITHUB_APP_ID",
  "NEONDIFF_GITHUB_APP_PRIVATE_KEY_PATH",
  "NEONDIFF_PROTECTED_CHECKOUT_ROOT",
  "NEONDIFF_LICENSE_KEY",
  "NEONDIFF_PROVIDER_API_KEY",
  "NEONDIFF_ALLOW_REMOTE_SMOKE"
];

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
  return SAFE_ENV_VAR_NAMES.reduce((text, name, index) => {
    const pattern = new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(name)}(?![A-Za-z0-9_])`, "g");
    return text.replace(pattern, `__NEONDIFF_SAFE_ENV_${index}__`);
  }, input);
}

function restoreSafeEnvVarNames(input: string): string {
  return SAFE_ENV_VAR_NAMES.reduce(
    (text, name, index) => text.replaceAll(`__NEONDIFF_SAFE_ENV_${index}__`, name),
    input
  );
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
