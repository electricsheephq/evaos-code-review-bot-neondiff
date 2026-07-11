import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function canonicalSampleFromFragments(): string {
  const canonical = JSON.parse(readFileSync("shared/canonical-secret-rules.json", "utf8")) as {
    rules: Array<{ sample?: string; sampleParts?: string[] }>;
  };
  const fixture = canonical.rules.find((rule) => (rule.sampleParts?.length ?? 0) > 1) ?? canonical.rules[0];
  return fixture.sampleParts?.join("") ?? fixture.sample ?? "";
}

function artifactRoot() {
  const root = mkdtempSync(join(tmpdir(), "neondiff-secret-corpus-boundary-"));
  roots.push(root);
  const appCoreBuild = join(root, "NeonDiffDesktopAppCore.build");
  const appCoreModule = join(root, "Modules", "NeonDiffDesktopAppCore.swiftmodule");
  mkdirSync(appCoreBuild, { recursive: true });
  mkdirSync(appCoreModule, { recursive: true });
  return { root, appCoreBuild, appCoreModule };
}

function scan(paths: string[]) {
  return spawnSync("node", ["scripts/check-secret-corpus-boundary.mjs", ...paths], { encoding: "utf8" });
}

describe("secret corpus AppCore artifact boundary", () => {
  it("accepts clean AppCore object and module artifacts", () => {
    const artifacts = artifactRoot();
    const object = join(artifacts.appCoreBuild, "NeonDiffDesktopModel.swift.o");
    const module = join(artifacts.appCoreModule, "arm64-apple-macos.swiftmodule");
    writeFileSync(object, "release desktop object");
    writeFileSync(module, "release desktop module");

    const result = scan([artifacts.appCoreBuild, artifacts.appCoreModule]);
    expect(result.status).toBe(0);
  });

  it.each([
    ["AppCore object", "NeonDiffDesktopAppCore.build", "NeonDiffDesktopModel.swift.o"],
    ["AppCore swiftmodule", "Modules/NeonDiffDesktopAppCore.swiftmodule", "arm64-apple-macos.swiftmodule"]
  ])("rejects a canonical corpus sample in a %s", (_surface, directory, filename) => {
    const artifacts = artifactRoot();
    const path = join(artifacts.appCoreBuild, "..", directory, filename);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, canonicalSampleFromFragments());

    const result = scan([artifacts.appCoreBuild, artifacts.appCoreModule]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/sensitive corpus samples leaked/);
  });

  it("refuses an AppCore artifact symlink that escapes its requested root", () => {
    const artifacts = artifactRoot();
    const outside = mkdtempSync(join(tmpdir(), "neondiff-secret-corpus-outside-"));
    roots.push(outside);
    const payload = join(outside, "payload");
    writeFileSync(payload, "release desktop object");
    symlinkSync(payload, join(artifacts.appCoreBuild, "escape"));

    const result = scan([artifacts.appCoreBuild]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/symlink escapes artifact root/);
  });
});
