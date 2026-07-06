import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeSecureFileSync } from "../src/temp-files.js";

const SECURE_TEMP_FILE_MODE = 0o600;

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
    const dir = makeTempDir();
    const path = join(dir, "secure.txt");

    writeSecureFileSync(path, "hello world");

    expect(readFileSync(path, "utf8")).toBe("hello world");
    expect(statSync(path).mode & 0o777).toBe(SECURE_TEMP_FILE_MODE);
    expect(readdirSync(dir).filter((entry) => entry.includes(".tmp"))).toEqual([]);
  });

  it("tightens permissions when overwriting an existing file", () => {
    const dir = makeTempDir();
    const path = join(dir, "secure-existing.txt");
    writeFileSync(path, "old contents");
    chmodSync(path, 0o644);

    writeSecureFileSync(path, "new contents");

    expect(readFileSync(path, "utf8")).toBe("new contents");
    expect(statSync(path).mode & 0o777).toBe(SECURE_TEMP_FILE_MODE);
    expect(readdirSync(dir).filter((entry) => entry.includes(".tmp"))).toEqual([]);
  });
});
