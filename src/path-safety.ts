import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export interface PathBoundary {
  path: string;
  protectedRoot: string | undefined;
  protectedRoots?: string[];
  pathLabel: string;
  protectedRootLabel: string;
}

interface SinglePathBoundary {
  path: string;
  protectedRoot: string;
  pathLabel: string;
  protectedRootLabel: string;
}

export function getProtectedCheckoutRoots(): string[] {
  return uniqueDefinedPaths([
    process.env.EVAOS_REVIEW_BOT_PROTECTED_CHECKOUT_ROOT,
    findPackageRoot(process.cwd()),
    getInstalledPackageRoot()
  ]);
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
  const roots = uniqueDefinedPaths([boundary.protectedRoot, ...(boundary.protectedRoots ?? [])]);
  for (const protectedRoot of roots) {
    assertPathOutsideSingleProtectedRoot({
      path: boundary.path,
      protectedRoot,
      pathLabel: boundary.pathLabel,
      protectedRootLabel: boundary.protectedRootLabel
    });
  }
}

function assertPathOutsideSingleProtectedRoot(boundary: SinglePathBoundary): void {
  const root = resolvePathFollowingExistingSymlinks(boundary.protectedRoot);
  const candidate = resolvePathFollowingExistingSymlinks(boundary.path);
  const rel = relative(root, candidate);
  const reverseRel = relative(candidate, root);
  const overlapsProtectedRoot = isSameOrChildRelativePath(rel) || isSameOrChildRelativePath(reverseRel);
  if (overlapsProtectedRoot) {
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

function isSameOrChildRelativePath(rel: string): boolean {
  return rel === "" || (!isParentRelativePath(rel) && !isAbsolute(rel));
}

function isParentRelativePath(rel: string): boolean {
  return rel === ".." || rel.startsWith(`..${sep}`);
}

function uniqueDefinedPaths(paths: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const path of paths) {
    if (!path) continue;
    const normalized = resolvePathFollowingExistingSymlinks(path);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(normalized);
  }
  return output;
}
