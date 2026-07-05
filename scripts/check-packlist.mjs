import { readFileSync } from "node:fs";

const raw = readFileSync(process.argv[2] ?? "pack.json", "utf8");
const [pack] = JSON.parse(raw);
const files = new Set(pack.files.map((file) => file.path));

const forbidden = [...files].filter((path) =>
  path.startsWith("tests/") ||
  path.startsWith("dist/tests/") ||
  path.startsWith("node_modules/") ||
  path.startsWith("apps/") ||
  path.startsWith(".git") ||
  path.includes(".env") ||
  path.endsWith(".pem") ||
  path.endsWith(".sqlite")
);

if (forbidden.length > 0) {
  console.error("Forbidden package files:");
  for (const file of forbidden) console.error(`- ${file}`);
  process.exit(1);
}

for (const required of [
  "dist/src/cli.js",
  "README.md",
  "LICENSE.md",
  "SECURITY.md",
  "CODE_OF_CONDUCT.md",
  "config.example.json",
  "docs/SETUP.md",
  "docs/github-app-setup.md",
  "docs/providers.md",
  "docs/license-boundary.md",
  "docs/pricing.md",
  "docs/schema/neondiff-config.schema.json"
]) {
  if (!files.has(required)) {
    console.error(`Missing required package file: ${required}`);
    process.exit(1);
  }
}

console.log(`packlist ok: ${files.size} files`);
