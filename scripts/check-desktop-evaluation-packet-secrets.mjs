#!/usr/bin/env node
import { isAbsolute, posix, resolve } from "node:path";
import { binarySecretScanExtension, scanCanonicalSecretText, scanSecretText } from "./shared/secret-patterns.mjs";
import { readCompletePngDimensions } from "./shared/png-evidence.mjs";
import { assertPacketRoot } from "./shared/packet-paths.mjs";
import { walkDescriptorTree } from "./shared/safe-fs.mjs";

const flagIndex = process.argv.indexOf("--packet");
if (flagIndex < 0 || !process.argv[flagIndex + 1] || process.argv.length !== 4) {
  process.stderr.write("usage: check-desktop-evaluation-packet-secrets.mjs --packet <directory>\n");
  process.exit(2);
}
const packet = assertPacketRoot(resolve(process.argv[flagIndex + 1]));

const findings = [];
const skippedImages = [];
const validatedImages = [];
const invalidImages = [];
const skippedArtifactBinaries = [];
const skippedArtifactSymlinks = [];
const unsupportedBinaryFiles = [];
const unsupportedEntries = [];
const sensitiveFiles = [];
let scannedFiles = 0;
let scannedBytes = 0;
const maxFiles = 20_000;
const maxBytes = 512 * 1024 * 1024;
const artifactRoot = "artifacts/NeonDiffDesktop.app";

function isWithin(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}/`);
}

function looksBinary(data) {
  const magic = data.subarray(0, 4).toString("hex");
  let invalidUTF8 = false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    invalidUTF8 = true;
  }
  return ["7f454c46", "feedface", "feedfacf", "cefaedfe", "cffaedfe", "cafebabe", "bebafeca"].includes(magic)
    || data.subarray(0, Math.min(data.length, 8192)).includes(0)
    || invalidUTF8;
}

const entries = [];
walkDescriptorTree(packet, (entry) => entries.push(entry));
const entryPaths = new Set([artifactRoot, ...entries.map((entry) => entry.relativePath)]);
const links = new Map(entries.filter((entry) => entry.type === "symlink").map((entry) => [entry.relativePath, entry.target]));

function resolveLinkTopology(path, seen = new Set()) {
  const parts = path.split("/");
  for (let length = 1; length <= parts.length; length += 1) {
    const prefix = parts.slice(0, length).join("/");
    if (!links.has(prefix)) continue;
    if (seen.has(prefix)) throw new Error(`packet text surface contains a symlink cycle: ${prefix}`);
    const target = links.get(prefix);
    if (isAbsolute(target)) throw new Error(`packet text surface contains an absolute symlink: ${prefix}`);
    const replaced = posix.normalize(posix.join(posix.dirname(prefix), target, ...parts.slice(length)));
    if (!isWithin(artifactRoot, replaced)) throw new Error(`packet text surface contains an escaping symlink: ${prefix}`);
    return resolveLinkTopology(replaced, new Set([...seen, prefix]));
  }
  return path;
}

for (const entry of entries) {
    const rel = entry.relativePath;
    if (entry.type === "symlink") {
      if (isAbsolute(entry.target)) {
        throw new Error(`packet text surface contains an absolute symlink: ${rel}`);
      }
      const resolvedTarget = resolveLinkTopology(posix.normalize(posix.join(posix.dirname(rel), entry.target)));
      if (!rel.startsWith(`${artifactRoot}/`)
        || !isWithin(artifactRoot, resolvedTarget)
        || !entryPaths.has(resolvedTarget)) {
        throw new Error(`packet text surface contains an unsafe or broken symlink: ${rel}`);
      }
      skippedArtifactSymlinks.push(rel);
      continue;
    }
    if (rel.startsWith("artifacts/")
      && rel !== artifactRoot
      && !rel.startsWith(`${artifactRoot}/`)) {
      const unsupportedRoot = rel.split("/").slice(0, 2).join("/");
      if (!unsupportedEntries.includes(unsupportedRoot)) unsupportedEntries.push(unsupportedRoot);
      continue;
    }
    if (entry.type === "directory") continue;
    if (/((^|\/)\.env(?:\.|$)|\.(?:pem|key|sqlite|db)$)/.test(rel)) sensitiveFiles.push(rel);
    if (rel.startsWith(`${artifactRoot}/`) && looksBinary(entry.data)) {
      skippedArtifactBinaries.push(rel);
      continue;
    }
    if (binarySecretScanExtension.test(rel)) {
      if (/^cases\/[a-z0-9][a-z0-9-]{0,63}\/(?:1040x680|1280x800)\/screenshot\.png$/.test(rel)) {
        try {
          const dimensions = readCompletePngDimensions(entry.data);
          skippedImages.push(rel);
          validatedImages.push({ path: rel, ...dimensions });
        } catch {
          invalidImages.push(rel);
        }
      } else if (rel.startsWith("artifacts/NeonDiffDesktop.app/")) {
        skippedArtifactBinaries.push(rel);
      } else {
        unsupportedBinaryFiles.push(rel);
      }
      continue;
    }
    if (looksBinary(entry.data)) {
      unsupportedBinaryFiles.push(rel);
      continue;
    }
    scannedFiles += 1;
    scannedBytes += entry.stat.size;
    if (scannedFiles > maxFiles || scannedBytes > maxBytes) throw new Error("packet text scan bound exceeded");
    findings.push(...scanSecretText(rel, entry.data.toString("utf8")));
    findings.push(...scanCanonicalSecretText(rel, entry.data.toString("utf8")));
}
const result = {
  ok: findings.length === 0
    && invalidImages.length === 0
    && sensitiveFiles.length === 0
    && unsupportedBinaryFiles.length === 0
    && unsupportedEntries.length === 0,
  scannedFiles,
  scannedBytes,
  skippedImages,
  validatedImages,
  invalidImages,
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
