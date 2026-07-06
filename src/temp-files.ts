import { randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Restrictive mode for evidence/scratch files written under a temp-ish directory: owner
// read/write only, no group/other access (js/insecure-temporary-file remediation, #359).
export const SECURE_TEMP_FILE_MODE = 0o600;

let processTempDir: string | undefined;

/**
 * Lazily creates (once per process) a private temp directory via mkdtempSync, which both
 * randomizes the directory name and creates it with mode 0700. Callers that need a scratch
 * location not tied to a caller-supplied evidence/output dir should use this instead of writing
 * directly under os.tmpdir() with a predictable name.
 */
export function getProcessTempDir(): string {
  if (!processTempDir) {
    processTempDir = mkdtempSync(join(tmpdir(), "neondiff-"));
  }
  return processTempDir;
}

/**
 * Appends an unpredictable suffix to a filename so repeated writes (or concurrent processes)
 * can't collide on, or be pre-staged at, a guessable path.
 */
export function randomFileSuffix(): string {
  return randomBytes(8).toString("hex");
}

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
