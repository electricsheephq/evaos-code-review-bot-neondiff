import { lstatSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

function assertContained(packet, candidate, label) {
  const root = resolve(packet);
  const path = resolve(candidate);
  if (path !== root && !path.startsWith(`${root}${sep}`)) {
    throw new Error(`${label} escapes packet root`);
  }
  return { root, path };
}

export function assertPacketRoot(packet) {
  const root = resolve(packet);
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("packet must be a regular directory");
  }
  return root;
}

export function packetEntry(packet, candidate, label, expectedType = "file") {
  const { root, path } = assertContained(packet, candidate, label);
  const rel = relative(root, path);
  let current = root;
  const segments = rel ? rel.split(sep) : [];
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) {
      throw new Error(`${label} contains a symlink component`);
    }
    if (index < segments.length - 1 && !stat.isDirectory()) {
      throw new Error(`${label} has a non-directory path component`);
    }
    if (index === segments.length - 1) {
      const valid = expectedType === "directory" ? stat.isDirectory() : stat.isFile();
      if (!valid) throw new Error(`${label} has the wrong file type`);
    }
  }
  return path;
}

export function packetRelativeEntry(packet, value, label, expectedType = "file") {
  if (typeof value !== "string"
    || value.startsWith("/")
    || value.includes("\\")
    || value.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`${label} is not packet-relative`);
  }
  return packetEntry(packet, resolve(packet, value), label, expectedType);
}
