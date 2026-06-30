const SECRET_PATTERNS: RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/gi,
  /\b(?:api[_-]?key|token|secret|password|cookie|session)\b\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{16,}/gi,
  /\b[A-Za-z0-9]{3,}[-_](?:secret|token|password|cookie)[-_][A-Za-z0-9_-]{3,}\b/gi,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g
];

export function containsSecretLikeText(input: string): boolean {
  return SECRET_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(input);
  });
}

export function redactSecrets(input: string): string {
  return SECRET_PATTERNS.reduce((text, pattern) => text.replace(pattern, "[redacted-secret]"), input);
}
