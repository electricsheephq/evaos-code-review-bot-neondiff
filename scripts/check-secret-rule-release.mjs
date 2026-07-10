import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = JSON.parse(readFileSync(join(root, "shared/canonical-secret-rules.json"), "utf8"));
const samples = [...source.rules, source.cookieHeader].map((fixture) => ({
  id: fixture.id,
  text: fixture.sampleParts ? fixture.sampleParts.join("") : fixture.sample
}));

if (process.argv.includes("--build")) {
  execFileSync("npm", ["run", "build"], { cwd: root, stdio: "pipe" });
}

const targets = [
  join(root, "src/generated-secret-rules.ts"),
  join(root, "dist/src/generated-secret-rules.js")
];
const temporary = mkdtempSync(join(tmpdir(), "neondiff-secret-release-"));
try {
  if (process.argv.includes("--pack")) {
    const packed = JSON.parse(execFileSync("npm", ["pack", "--json", "--pack-destination", temporary], {
      cwd: root,
      encoding: "utf8"
    }));
    const tarball = join(temporary, packed[0].filename);
    const extracted = join(temporary, "extracted");
    mkdirSync(extracted);
    execFileSync("tar", ["-xzf", tarball, "-C", extracted]);
    targets.push(...walk(join(extracted, "package")));
  }

  const leaks = [];
  for (const target of targets) {
    const bytes = readFileSync(target);
    for (const sample of samples) {
      if (bytes.includes(Buffer.from(sample.text))) {
        leaks.push(`${sample.id}:${target.startsWith(root) ? target.slice(root.length + 1) : basename(target)}`);
      }
    }
  }
  if (leaks.length > 0) {
    throw new Error(`canonical sensitive fixture leaked into production output: ${leaks.join(", ")}`);
  }
  console.log(`secret rule release content ok: ${samples.length} fixtures absent from ${targets.length} production files`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}

function walk(directory) {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}
