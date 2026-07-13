import { readFileSync } from "node:fs";

const canonicalSource = JSON.parse(readFileSync(
  new URL("../../shared/canonical-secret-rules.json", import.meta.url),
  "utf8"
));
const canonicalRules = canonicalSource.rules.map((rule) => ({
  id: rule.id,
  pattern: new RegExp(rule.source, rule.ignoreCase ? "i" : "")
}));

export const secretPatterns = [
  ["private_key", /-----BEGIN (?:RSA |OPENSSH |EC |DSA |)?PRIVATE KEY-----/],
  ["github_token", /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/],
  ["github_pat", /\bgithub_pat_[A-Za-z0-9_]{20,}\b/],
  ["openai_key", /\bsk-[A-Za-z0-9]{20,}\b/],
  ["anthropic_key", /\bsk-ant-[A-Za-z0-9_-]{20,}\b/],
  ["stripe_secret_key", /\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/],
  ["npm_token", /\bnpm_[A-Za-z0-9]{20,}\b/]
];

export const binarySecretScanExtension = /\.(?:ico|png|jpg|jpeg|gif|woff2?|ttf|otf|pdf|zip|gz|tgz)$/i;

export function scanSecretText(file, text) {
  const findings = [];
  text.split("\n").forEach((line, index) => {
    for (const [name, pattern] of secretPatterns) {
      if (pattern.test(line)) findings.push({ file, line: index + 1, pattern: name });
    }
  });
  return findings;
}

export function scanCanonicalSecretText(file, text) {
  const findings = [];
  text.split("\n").forEach((line, index) => {
    const canonicalInput = line.replaceAll("scripts/check-secret-scan.mjs", "__NEONDIFF_SAFE_SECRET_SCAN_COMMAND__");
    const canonicalIds = canonicalSecretRuleIds(canonicalInput).filter(
      (id) => id !== "email-address" || !isKnownSparkleCopyrightLine(file, line)
    );
    if (canonicalIds.length > 0) {
      findings.push({ file, line: index + 1, pattern: "canonical_secret" });
    }
  });
  return findings;
}

function isKnownSparkleCopyrightLine(file, line) {
  const knownPaths = new Set([
    "artifacts/NeonDiffDesktop.app/Contents/Resources/NeonDiffDesktop_NeonDiffDesktop.bundle/SPARKLE-LICENSE.txt",
    "artifacts/NeonDiffDesktop.app/NeonDiffDesktop_NeonDiffDesktop.bundle/SPARKLE-LICENSE.txt"
  ]);
  return knownPaths.has(file)
    && line === "Copyright (c) 2015 Orson Peters <orsonpeters@gmail.com>";
}

export function containsCanonicalSecretLikeText(input) {
  return canonicalSecretRuleIds(input).length > 0;
}

export function canonicalSecretRuleIds(input) {
  const ids = [];
  const named = canonicalRules.find((rule) => rule.id === "named-credential");
  if (named?.pattern.test(input)) ids.push(named.id);
  const safeInput = canonicalSource.safeLiterals.reduce((text, literal, index) => {
    const pattern = new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(literal)}(?![A-Za-z0-9_])`, "g");
    return text.replace(pattern, (match, offset, whole) => {
      const before = whole.slice(0, offset);
      const after = whole.slice(offset + match.length);
      return isAssignmentPosition(before, after) ? match : `__NEONDIFF_SAFE_ENV_${index}__`;
    });
  }, input);
  if (containsSensitiveCookieHeader(safeInput)) ids.push("sensitive-cookie-header");
  for (const rule of canonicalRules) {
    if (rule.id !== "named-credential" && rule.pattern.test(safeInput)) ids.push(rule.id);
  }
  return [...new Set(ids)];
}

function isAssignmentPosition(before, after) {
  const whitespace = "[\\u0009-\\u000D \\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]*";
  const quote = "[\\\"'`]?";
  const credentialName = "(?:(?:NEONDIFF[_-]PROVIDER[_-])?api[_-]?key|token|secret|password|cookie|session)";
  return new RegExp(`^${quote}${whitespace}[:=]`).test(after)
    || new RegExp(`${credentialName}${quote}${whitespace}[:=]${whitespace}${quote}$`, "i").test(before);
}

function escapeRegExp(input) {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsSensitiveCookieHeader(input) {
  const prefix = canonicalSource.cookieHeader.prefix.toLowerCase();
  const sensitiveName = new RegExp(canonicalSource.cookieHeader.sensitiveNameSource);
  return input.split(/\r?\n/).some((line) => {
    const trimmed = line.trimStart();
    if (!trimmed.toLowerCase().startsWith(prefix)) return false;
    const colon = line.indexOf(":");
    if (colon < 0) return false;
    const attributes = line.slice(colon + 1).split(";", canonicalSource.cookieHeader.maximumAttributes + 1);
    if (attributes.length > canonicalSource.cookieHeader.maximumAttributes) return true;
    return attributes.some((attribute) => {
      const equals = attribute.indexOf("=");
      if (equals <= 0) return false;
      const name = attribute.slice(0, equals).trim();
      const value = attribute.slice(equals + 1).trim();
      return value.length > 0 && sensitiveName.test(name);
    });
  });
}
