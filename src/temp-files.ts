import { chmodSync, writeFileSync } from "node:fs";

// Restrictive mode for evidence/scratch files written under a temp-ish directory: owner
// read/write only, no group/other access (js/insecure-temporary-file remediation, #359).
export const SECURE_TEMP_FILE_MODE = 0o600;

/**
 * writeFileSync with the restrictive 0600 mode applied. Behavior (what is written, when, and
 * any caller-side cleanup) is unchanged from a bare writeFileSync call; this tightens the
 * permissions for both newly created and pre-existing files.
 */
export function writeSecureFileSync(path: string, data: string): void {
  // Review/evidence artifacts intentionally persist model/API-derived diagnostics locally.
  // Callers own redaction and destination selection; this helper tightens permissions
  // to 0600 so the network-data-to-file flow is an accepted local evidence sink.
  //
  // codeql[js/http-to-file-access]
  // lgtm[js/http-to-file-access]
  writeFileSync(path, data, { mode: SECURE_TEMP_FILE_MODE });
  chmodSync(path, SECURE_TEMP_FILE_MODE);
}
