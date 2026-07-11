#!/usr/bin/env node
import { lstatSync, readFileSync, readlinkSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { binarySecretScanExtension, scanSecretText } from "./shared/secret-patterns.mjs";
import { assertPacketRoot } from "./shared/packet-paths.mjs";

const flagIndex = process.argv.indexOf("--packet");
if (flagIndex < 0 || !process.argv[flagIndex + 1] || process.argv.length !== 4) {
  process.stderr.write("usage: check-desktop-evaluation-packet-secrets.mjs --packet <directory>\n");
  process.exit(2);
}
const packet = assertPacketRoot(resolve(process.argv[flagIndex + 1]));

const findings = [];
const skippedImages = [];
const skippedArtifactBinaries = [];
const skippedArtifactSymlinks = [];
const unsupportedBinaryFiles = [];
const unsupportedEntries = [];
const sensitiveFiles = [];
let scannedFiles = 0;
let scannedBytes = 0;
const maxFiles = 20_000;
const maxBytes = 512 * 1024 * 1024;
const artifactRoot = realpathSync(join(packet, "artifacts", "NeonDiffDesktop.app"));

function isWithin(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function walk(directory) {
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name);
    const rel = relative(packet, path).split(sep).join("/");
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      const target = readlinkSync(path);
      let resolvedTarget;
      try {
        resolvedTarget = realpathSync(path);
      } catch {
        throw new Error(`packet text surface contains a broken symlink: ${rel}`);
      }
      if (!rel.startsWith("artifacts/NeonDiffDesktop.app/")
        || isAbsolute(target)
        || !isWithin(artifactRoot, resolvedTarget)) {
        throw new Error(`packet text surface contains an unsafe symlink: ${rel}`);
      }
      skippedArtifactSymlinks.push(rel);
      continue;
    }
    if (rel.startsWith("artifacts/")
      && rel !== "artifacts/NeonDiffDesktop.app"
      && !rel.startsWith("artifacts/NeonDiffDesktop.app/")) {
      unsupportedEntries.push(rel);
      continue;
    }
    if (stat.isDirectory()) {
      walk(path);
      continue;
    }
    if (!stat.isFile()) throw new Error(`unsupported packet entry: ${rel}`);
    if (/((^|\/)\.env(?:\.|$)|\.(?:pem|key|sqlite|db)$)/.test(rel)) sensitiveFiles.push(rel);
    if (binarySecretScanExtension.test(rel)) {
      if (/^cases\/[a-z0-9][a-z0-9-]{0,63}\/(?:1040x680|1280x800)\/screenshot\.png$/.test(rel)) {
        skippedImages.push(rel);
      } else if (rel.startsWith("artifacts/NeonDiffDesktop.app/")) {
        skippedArtifactBinaries.push(rel);
      } else {
        unsupportedBinaryFiles.push(rel);
      }
      continue;
    }
    scannedFiles += 1;
    scannedBytes += stat.size;
    if (scannedFiles > maxFiles || scannedBytes > maxBytes) throw new Error("packet text scan bound exceeded");
    findings.push(...scanSecretText(rel, readFileSync(path, "utf8")));
  }
}

walk(packet);
const result = {
  ok: findings.length === 0
    && sensitiveFiles.length === 0
    && unsupportedBinaryFiles.length === 0
    && unsupportedEntries.length === 0,
  scannedFiles,
  scannedBytes,
  skippedImages,
  skippedArtifactBinaries,
  skippedArtifactSymlinks,
  unsupportedBinaryFiles,
  unsupportedEntries,
  imagePolicy: "Screenshots derive only from validated public-safe fixtures and are corroborated by scanned AX text; no live adapters are available.",
  findings,
  sensitiveFiles
};
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!result.ok) process.exit(1);
