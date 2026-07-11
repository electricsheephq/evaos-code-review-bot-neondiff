import { constants, closeSync, fstatSync, openSync, readSync } from "node:fs";
import type { LicenseConfig } from "./license.js";

const MAXIMUM_LICENSE_SECRET_BYTES = 512;
const productionKeyPattern = /^nd_live_[A-Za-z0-9_-]{8,}$/;

export interface LicenseSecretReader {
  read(config: LicenseConfig): string | undefined;
}

export const productionLicenseSecretReader: LicenseSecretReader = {
  read(config) {
    if (config.storageBackend !== "file") {
      throw new Error("license secret storage is not supported for production admission; use the approved file backend");
    }
    if (!config.keyPath) return undefined;
    return readProductionFileLicenseSecret(config.keyPath);
  }
};

export function readProductionFileLicenseSecret(path: string): string {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(fd);
    if (!before.isFile()) throw new Error("license secret must be a regular file");
    if (typeof process.getuid === "function" && before.uid !== process.getuid()) {
      throw new Error("license secret must be owned by the current user");
    }
    if ((before.mode & 0o077) !== 0) throw new Error("license secret permissions must be 0600 or stricter");
    if (before.size < 1 || before.size > MAXIMUM_LICENSE_SECRET_BYTES) {
      throw new Error("license secret exceeds the supported byte bound");
    }
    const data = Buffer.alloc(before.size + 1);
    const bytesRead = readSync(fd, data, 0, data.length, 0);
    const after = fstatSync(fd);
    if (bytesRead !== before.size
      || after.dev !== before.dev
      || after.ino !== before.ino
      || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs) {
      throw new Error("license secret changed while reading");
    }
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(data.subarray(0, bytesRead));
    const key = decoded.endsWith("\r\n") ? decoded.slice(0, -2) : decoded.endsWith("\n") ? decoded.slice(0, -1) : decoded;
    if (key.includes("\0") || key.includes("\r") || key.includes("\n") || !productionKeyPattern.test(key)) {
      throw new Error("license secret is not one valid production key");
    }
    return key;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("license secret")) throw error;
    throw new Error("license secret could not be read safely");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
