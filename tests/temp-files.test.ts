import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SECURE_TEMP_FILE_MODE, writeSecureFileSync } from "../src/temp-files.js";

describe("temp-files helper", () => {
  const tempDirs: string[] = [];

  function makeTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "neondiff-test-"));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
  });

  it("writes files with mode 0600 and the exact given contents", () => {
    const path = join(makeTempDir(), "secure.txt");

    writeSecureFileSync(path, "hello world");

    expect(readFileSync(path, "utf8")).toBe("hello world");
    expect(statSync(path).mode & 0o777).toBe(SECURE_TEMP_FILE_MODE);
  });

  it("tightens permissions when overwriting an existing file", () => {
    const path = join(makeTempDir(), "secure-existing.txt");
    writeFileSync(path, "old contents");
    chmodSync(path, 0o644);

    writeSecureFileSync(path, "new contents");

    expect(readFileSync(path, "utf8")).toBe("new contents");
    expect(statSync(path).mode & 0o777).toBe(SECURE_TEMP_FILE_MODE);
  });
});
