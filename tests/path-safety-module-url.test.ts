import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { findPackageRoot, getInstalledPackageRoot, packageRootFromModuleUrl } from "../src/path-safety.js";

describe("installed package root", () => {
  it("resolves the package root from a module file URL", () => {
    const repoRoot = findPackageRoot(process.cwd());
    expect(repoRoot).toBeDefined();
    expect(packageRootFromModuleUrl(pathToFileURL(`${repoRoot}/src/path-safety.ts`).href)).toBe(repoRoot);
    expect(getInstalledPackageRoot()).toBe(repoRoot);
  });

  it("omits the root instead of throwing when no module file URL is available", () => {
    expect(packageRootFromModuleUrl(undefined)).toBeUndefined();
    expect(packageRootFromModuleUrl("")).toBeUndefined();
    expect(packageRootFromModuleUrl("node:sea")).toBeUndefined();
  });
});
