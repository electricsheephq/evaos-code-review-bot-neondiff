import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const directory = realpathSync(mkdtempSync(join(tmpdir(), "neondiff-phase1-verified-loader-")));
try {
  const marker = join(directory, "unverified-executed");
  const modulePath = join(directory, "payload.js");
  const replacementPath = join(directory, "replacement.js");
  const source = "export const provenance = 'verified';\n";
  writeFileSync(modulePath, source);
  writeFileSync(replacementPath, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "executed"); export const provenance = "replacement";\n`);
  const { importVerifiedModule } = await import(pathToFileURL(join(process.cwd(), "dist", "src", "phase1-characterization-cli.js")).href);
  const loaded = await importVerifiedModule(modulePath, createHash("sha256").update(source).digest("hex"), "payload", () => {
    unlinkSync(modulePath);
    symlinkSync(replacementPath, modulePath);
  });
  if (loaded.provenance !== "verified" || existsSync(marker)) throw new Error("verified module loader executed path-replacement bytes");
  process.stdout.write("phase1 verified loader check passed\n");
} finally {
  rmSync(directory, { recursive: true, force: true });
}
