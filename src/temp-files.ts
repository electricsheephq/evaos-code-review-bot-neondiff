import { randomBytes } from "node:crypto";
import { chmodSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

// Restrictive mode for evidence/scratch files: owner read/write only, no group/other access.
const SECURE_TEMP_FILE_MODE = 0o600;

/**
 * Writes evidence/scratch data while enforcing restrictive 0600 permissions.
 * Contents are written to a private same-directory temp file, then atomically renamed over the
 * target so pre-existing files with looser permissions never expose newly written contents.
 */
export function writeSecureFileSync(path: string, data: string): void {
  const tempPath = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  // Review/evidence artifacts intentionally persist model/API-derived diagnostics locally.
  // Callers own redaction and destination selection; this helper tightens permissions
  // to 0600 so the network-data-to-file flow is an accepted local evidence sink.
  //
  // codeql[js/http-to-file-access]
  // lgtm[js/http-to-file-access]
  try {
    writeFileSync(tempPath, data, { flag: "wx", mode: SECURE_TEMP_FILE_MODE });
    chmodSync(tempPath, SECURE_TEMP_FILE_MODE);
    renameSync(tempPath, path);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }
}
