import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const canonical = JSON.parse(readFileSync(join(root, "shared/canonical-secret-rules.json"), "utf8"));
const samples = [...canonical.rules, canonical.cookieHeader].map((fixture) => ({
  id: fixture.id,
  bytes: Buffer.from(fixture.sampleParts ? fixture.sampleParts.join("") : fixture.sample)
}));
const paths = process.argv.slice(2).map((path) => resolve(root, path));

const productionSource = join(
  root,
  "apps/neondiff-desktop/Sources/NeonDiffDesktopCore/Services/CanonicalSecretRules.generated.swift"
);
scanFile(productionSource);

const pack = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json"], {
  cwd: root,
  encoding: "utf8",
  maxBuffer: 16 * 1024 * 1024
}));
for (const entry of pack[0]?.files ?? []) scanFile(join(root, entry.path));

const dockerfile = readFileSync(join(root, "Dockerfile"), "utf8");
if (!/RUN npm prune --omit=dev && rm -rf scripts shared dist\/tests/.test(dockerfile)) {
  throw new Error("Docker runtime boundary must remove scripts, shared fixture sources, and test output");
}
for (const path of [
  "dist", "package.json", "package-lock.json", "docs", "config.example.json",
  "LICENSE.md", "README.md", "SECURITY.md", "CODE_OF_CONDUCT.md", "Dockerfile"
]) scanPath(join(root, path));

for (const path of paths) scanPath(path);

console.log(`secret corpus boundary ok: ${samples.length} samples absent from npm/Docker-owned payloads${paths.length ? ` and ${paths.length} Swift artifact paths` : ""}`);

function scanPath(path) {
  if (!existsSync(path)) throw new Error(`required corpus-boundary path is missing: ${path}`);
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    for (const entry of readdirSync(path)) scanPath(join(path, entry));
    return;
  }
  if (stat.isFile()) scanFile(path);
}

function scanFile(path) {
  const content = readFileSync(path);
  const leaked = samples.filter((sample) => sample.bytes.length > 0 && content.includes(sample.bytes));
  if (leaked.length > 0) {
    throw new Error(`sensitive corpus samples leaked into ${relative(root, path)}: ${leaked.map(({ id }) => id).join(", ")}`);
  }
}
