import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface PathBoundary {
  path: string;
  protectedRoot: string | undefined;
  pathLabel: string;
  protectedRootLabel: string;
}

export function getInstalledPackageRoot(): string | undefined {
  return findPackageRoot(dirname(fileURLToPath(import.meta.url)));
}

export function findPackageRoot(startPath: string): string | undefined {
  let current = resolvePathFollowingExistingSymlinks(startPath);
  while (true) {
    if (existsSync(resolve(current, "package.json"))) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export function assertPathOutsideProtectedRoot(boundary: PathBoundary): void {
  if (!boundary.protectedRoot) return;
  const root = resolvePathFollowingExistingSymlinks(boundary.protectedRoot);
  const candidate = resolvePathFollowingExistingSymlinks(boundary.path);
  const rel = relative(root, candidate);
  const insideProtectedRoot = rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  if (insideProtectedRoot) {
    throw new Error(`${boundary.pathLabel} must be outside ${boundary.protectedRootLabel}; got ${boundary.path}`);
  }
}

export function resolvePathFollowingExistingSymlinks(inputPath: string): string {
  const absolutePath = resolve(inputPath);
  if (existsSync(absolutePath)) return realpathSync.native(absolutePath);

  let current = absolutePath;
  const missingSegments: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return absolutePath;
    missingSegments.unshift(basename(current));
    current = parent;
  }

  return resolve(realpathSync.native(current), ...missingSegments);
}
