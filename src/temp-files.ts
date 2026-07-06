import { chmodSync, writeFileSync } from "node:fs";

// Restrictive mode for evidence/scratch files: owner read/write only, no group/other access.
// If this ever gains group/other bits, re-check the write+chmod umask/race properties.
export const SECURE_TEMP_FILE_MODE = 0o600;

/**
 * Writes evidence/scratch data while enforcing restrictive 0600 permissions.
 * New files request 0600 at creation; pre-existing files are chmodded after overwrite because
 * Node's write mode option does not change permissions on an existing file.
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
