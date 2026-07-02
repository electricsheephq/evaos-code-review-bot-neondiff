const SECRET_PATTERNS: RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/gi,
  /https?:\/\/[^/\s@]+@[^/\s]+/gi,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/gi,
  /[?&](?:access[_-]?token|auth[_-]?token|api[_-]?key|token|secret|session|cookie)=[A-Za-z0-9._~+/=-]{16,}/gi,
  /\bCookie\s*:\s*[^;\n]*(?:session|token|auth|secret|cookie)[^;\n]*=[^;\n]{16,}/gi,
  /\bcustomer[_-]?id\b\s*[:=]\s*["']?cus_[A-Za-z0-9]{8,}/gi,
  /\b(?:customer|client)[_-]?ssn\b\s*[:=]\s*["']?\d{3}-\d{2}-\d{4}\b/gi,
  /\b(?:customer|client)[_-]?phone\b\s*[:=]\s*["']?\+?\d[\d ().-]{7,}\d\b/gi,
  /\b(?:api[_-]?key|token|secret|password|cookie|session)\b\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{16,}/gi,
  /\b[A-Za-z0-9]{3,}[-_](?:secret|token|password|cookie)[-_][A-Za-z0-9_-]{3,}\b/gi,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*/g
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
