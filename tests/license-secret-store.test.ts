import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readProductionFileLicenseSecret } from "../src/license-secret-store.js";

const roots: string[] = [];
const key = () => ["nd", "live", "fixture0123456789abcdef"].join("_");

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root() {
  const value = mkdtempSync(join(tmpdir(), "neondiff-license-secret-"));
  roots.push(value);
  return value;
}

describe("production license file secret reader", () => {
  it("reports a missing secret as not configured", () => {
    expect(readProductionFileLicenseSecret(join(root(), "missing.key"))).toBeUndefined();
  });

  it("reads one bounded owner-only production key", () => {
    const directory = root();
    const path = join(directory, "license.key");
    writeFileSync(path, `${key()}\n`, { mode: 0o600 });
    expect(readProductionFileLicenseSecret(path)).toBe(key());
  });

  it.each(["symlink", "permissive", "oversized", "malformed"])("rejects a %s secret before use", (scenario) => {
    const directory = root();
    const path = join(directory, "license.key");
    if (scenario === "symlink") {
      const target = join(directory, "target.key");
      writeFileSync(target, `${key()}\n`, { mode: 0o600 });
      symlinkSync(target, path);
    } else if (scenario === "permissive") {
      writeFileSync(path, `${key()}\n`, { mode: 0o600 });
      chmodSync(path, 0o644);
    } else if (scenario === "oversized") {
      writeFileSync(path, `${["nd", "live", "x".repeat(600)].join("_")}\n`, { mode: 0o600 });
    } else {
      writeFileSync(path, "legacy-fixture-key\n", { mode: 0o600 });
    }
    expect(() => readProductionFileLicenseSecret(path)).toThrow(/license secret/i);
  });
});
