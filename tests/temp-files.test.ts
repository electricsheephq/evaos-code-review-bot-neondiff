import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getProcessTempDir, randomFileSuffix, SECURE_TEMP_FILE_MODE, writeSecureFileSync } from "../src/temp-files.js";

describe("temp-files helper", () => {
  const written: string[] = [];

  afterEach(() => {
    for (const path of written.splice(0)) rmSync(path, { recursive: true, force: true });
  });

  it("creates the process temp dir under the OS tmp root with mode 0700", () => {
    const dir = getProcessTempDir();
    expect(dir.startsWith(join(tmpdir(), "neondiff-")) || dir.startsWith(tmpdir())).toBe(true);
    expect(existsSync(dir)).toBe(true);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("reuses the same process temp dir across calls", () => {
    const first = getProcessTempDir();
    const second = getProcessTempDir();
    expect(second).toBe(first);
  });

  it("produces different random suffixes across calls", () => {
    const a = randomFileSuffix();
    const b = randomFileSuffix();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f]+$/);
  });

  it("writes files with mode 0600 and the exact given contents", () => {
    const dir = getProcessTempDir();
    const path = join(dir, `secure-${randomFileSuffix()}.txt`);
    written.push(path);

    writeSecureFileSync(path, "hello world");

    expect(readFileSync(path, "utf8")).toBe("hello world");
    expect(statSync(path).mode & 0o777).toBe(SECURE_TEMP_FILE_MODE);
  });
});
