import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { buildClassicZipMetadataGraph, guardClassicZipArchive, withMaterializedClassicZipApp } from "../scripts/lib/desktop-extracted-app-tree-proof.mjs";

type Entry = { name: string; localName?: string; localOffset?: number; localExtra?: Buffer; type?: "file" | "directory" | "symlink"; data?: string | Buffer; flags?: number; method?: number; expanded?: number; crc?: number; descriptor?: boolean; extra?: number | Buffer; comment?: number; mode?: number };
const roots: string[] = [];
const u16 = (b: Buffer, p: number, n: number) => b.writeUInt16LE(n, p);
const u32 = (b: Buffer, p: number, n: number) => b.writeUInt32LE(n, p);
function classicZip(entries: Entry[]) {
  const locals: Buffer[] = [], central: Buffer[] = []; let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name), localName = Buffer.from(entry.localName ?? entry.name), payload = Buffer.from(entry.data ?? ""), localExtra = entry.localExtra ?? Buffer.alloc(0), extra = Buffer.isBuffer(entry.extra) ? entry.extra : Buffer.alloc(entry.extra ?? 0), comment = Buffer.alloc(entry.comment ?? 0), flags = entry.flags ?? 0x800, method = entry.method ?? 0, data = method === 8 ? deflateRawSync(payload) : payload, expanded = entry.expanded ?? payload.length, checksum = entry.crc ?? crc32(payload), hasDescriptor = Boolean(flags & 0x8), descriptor = hasDescriptor && entry.descriptor !== false ? Buffer.alloc(16) : Buffer.alloc(0);
    const type = entry.type ?? (entry.name.endsWith("/") ? "directory" : "file"), mode = entry.mode ?? ({ file: 0o100644, directory: 0o040755, symlink: 0o120777 })[type];
    if (descriptor.length) { u32(descriptor, 0, 0x08074b50); u32(descriptor, 4, checksum); u32(descriptor, 8, data.length); u32(descriptor, 12, expanded); }
    const local = Buffer.alloc(30 + localName.length + localExtra.length + data.length + descriptor.length); u32(local, 0, 0x04034b50); u16(local, 4, 20); u16(local, 6, flags); u16(local, 8, method); u32(local, 14, hasDescriptor ? 0 : checksum); u32(local, 18, hasDescriptor ? 0 : data.length); u32(local, 22, hasDescriptor ? 0 : expanded); u16(local, 26, localName.length); u16(local, 28, localExtra.length); localName.copy(local, 30); localExtra.copy(local, 30 + localName.length); data.copy(local, 30 + localName.length + localExtra.length); descriptor.copy(local, 30 + localName.length + localExtra.length + data.length); locals.push(local);
    const record = Buffer.alloc(46 + name.length + extra.length + comment.length); u32(record, 0, 0x02014b50); u16(record, 4, (3 << 8) | 20); u16(record, 6, 20); u16(record, 8, flags); u16(record, 10, method); u32(record, 16, checksum); u32(record, 20, data.length); u32(record, 24, expanded); u16(record, 28, name.length); u16(record, 30, extra.length); u16(record, 32, comment.length); u32(record, 38, (mode << 16) >>> 0); u32(record, 42, entry.localOffset ?? offset); name.copy(record, 46); extra.copy(record, 46 + name.length); comment.copy(record, 46 + name.length + extra.length); central.push(record);
    offset += local.length;
  }
  const directory = Buffer.concat(central), eocd = Buffer.alloc(22); u32(eocd, 0, 0x06054b50); u16(eocd, 8, entries.length); u16(eocd, 10, entries.length); u32(eocd, 12, directory.length); u32(eocd, 16, offset);
  return Buffer.concat([...locals, directory, eocd]);
}
function unicodePathExtra(headerName: string, alternateName: string) { const alternate = Buffer.from(alternateName), field = Buffer.alloc(9 + alternate.length); u16(field, 0, 0x7075); u16(field, 2, 5 + alternate.length); field[4] = 1; u32(field, 5, crc32(Buffer.from(headerName))); alternate.copy(field, 9); return field; }
function fixture(entries: Entry[]) { const root = mkdtempSync(join(tmpdir(), "neondiff-zip-")); roots.push(root); const artifact = join(root, "NeonDiff.zip"); writeFileSync(artifact, classicZip(entries)); return { root, artifact }; }
function eocdPatch(artifact: string, field: number, value: number) { const bytes = readFileSync(artifact); u32(bytes, bytes.length - 22 + field, value); writeFileSync(artifact, bytes); }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("raw bounded classic-ZIP archive guard", () => {
  it("accepts a small classic ZIP and hashes the exact descriptor bytes", () => {
    const value = fixture([{ name: "NeonDiff.app/Contents/Info.plist" }]), digest = createHash("sha256").update(readFileSync(value.artifact)).digest("hex");
    const result = guardClassicZipArchive({ artifactPath: value.artifact });
    expect(result.artifactSHA256).toBe(digest); expect(result.recordCount).toBe(1); expect(result.centralDirectorySize).toBeGreaterThan(0); expect(result.artifactBytes.length).toBeLessThan(512 * 1024 * 1024);
  });
  it("rejects over-count and oversized central metadata before helper/materialization", () => {
    const overCount = fixture(Array.from({ length: 20001 }, (_, i) => ({ name: `NeonDiff.app/${i}` })));
    expect(() => guardClassicZipArchive({ artifactPath: overCount.artifact })).toThrow("archive entry bound exceeded");
    const oversized = fixture(Array.from({ length: 260 }, (_, i) => ({ name: `NeonDiff.app/${i}`, extra: 65535 })));
    expect(() => guardClassicZipArchive({ artifactPath: oversized.artifact })).toThrow("central metadata bound exceeded");
    const source = readFileSync(new URL("../scripts/lib/desktop-extracted-app-tree-proof.mjs", import.meta.url), "utf8");
    expect(source).not.toMatch(/ZipFile|infolist|execFileSync|ditto|unzip/);
  });
  it("fails closed for malformed EOCD, multi-disk, ZIP64 sentinels, and ranges", () => {
    const malformed = fixture([{ name: "NeonDiff.app/a" }]); const badSignature = readFileSync(malformed.artifact); u32(badSignature, badSignature.length - 22, 0); writeFileSync(malformed.artifact, badSignature);
    expect(() => guardClassicZipArchive({ artifactPath: malformed.artifact })).toThrow("malformed EOCD");
    const multi = fixture([{ name: "NeonDiff.app/a" }]); eocdPatch(multi.artifact, 4, 1); expect(() => guardClassicZipArchive({ artifactPath: multi.artifact })).toThrow("multi-disk archive unsupported");
    const zip64 = fixture([{ name: "NeonDiff.app/a" }]); eocdPatch(zip64.artifact, 10, 0xffff); expect(() => guardClassicZipArchive({ artifactPath: zip64.artifact })).toThrow("ZIP64 archive unsupported");
    const range = fixture([{ name: "NeonDiff.app/a" }]); eocdPatch(range.artifact, 16, readFileSync(range.artifact).length - 1); expect(() => guardClassicZipArchive({ artifactPath: range.artifact })).toThrow("central directory range invalid");
  });
  it("uses O_NOFOLLOW and rejects an artifact over the descriptor cap", () => {
    const value = fixture([{ name: "NeonDiff.app/a" }]), alias = join(value.root, "alias.zip"); symlinkSync(value.artifact, alias);
    expect(() => guardClassicZipArchive({ artifactPath: alias })).toThrow();
    const oversized = join(value.root, "oversized.zip"); writeFileSync(oversized, ""); truncateSync(oversized, 512 * 1024 * 1024 + 1);
    expect(() => guardClassicZipArchive({ artifactPath: oversized })).toThrow("artifact bytes exceed bound");
  });
});

describe("bounded classic-ZIP metadata graph", () => {
  it("normalizes explicit and implicit app topology into a frozen artifact-bound graph", () => {
    const value = fixture([{ name: "NeonDiff.app/", type: "directory" }, { name: "NeonDiff.app/Contents/MacOS/NeonDiff", data: "binary" }, { name: "NeonDiff.app/Contents/Current", type: "symlink", data: "MacOS" }]);
    const graph = buildClassicZipMetadataGraph(value.artifact);
    expect(graph.artifactSHA256).toBe(createHash("sha256").update(readFileSync(value.artifact)).digest("hex"));
    expect(graph.records.map((record) => [record.path, record.type, record.explicit])).toEqual([
      ["NeonDiff.app", "directory", true], ["NeonDiff.app/Contents", "directory", false], ["NeonDiff.app/Contents/Current", "symlink", true], ["NeonDiff.app/Contents/MacOS", "directory", false], ["NeonDiff.app/Contents/MacOS/NeonDiff", "file", true]
    ]);
    expect(Object.isFrozen(graph)).toBe(true); expect(Object.isFrozen(graph.records)).toBe(true); expect(graph.records.every(Object.isFrozen)).toBe(true);
  });
  it("rejects traversal, every-prefix path collisions, and file-parent conflicts", () => {
    expect(() => buildClassicZipMetadataGraph(fixture([{ name: "NeonDiff.app/../escape" }]).artifact)).toThrow("unsafe archive path");
    expect(() => buildClassicZipMetadataGraph(fixture([{ name: "NeonDiff.app\\escape" }]).artifact)).toThrow("unsafe archive path");
    expect(() => buildClassicZipMetadataGraph(fixture([{ name: "NeonDiff.app/Foo/a" }, { name: "NeonDiff.app/foo/b" }]).artifact)).toThrow("archive path collision");
    expect(() => buildClassicZipMetadataGraph(fixture([{ name: "NeonDiff.app/Foo" }, { name: "NeonDiff.app/foo" }]).artifact)).toThrow("archive path collision");
    expect(() => buildClassicZipMetadataGraph(fixture([{ name: "NeonDiff.app/Caf\u00e9" }, { name: "NeonDiff.app/Cafe\u0301" }]).artifact)).toThrow("archive path collision");
    expect(() => buildClassicZipMetadataGraph(fixture([{ name: "NeonDiff.app/a" }, { name: "NeonDiff.app/a" }]).artifact)).toThrow("duplicate archive path");
    expect(() => buildClassicZipMetadataGraph(fixture([{ name: "NeonDiff.app/Contents" }, { name: "NeonDiff.app/Contents/file" }]).artifact)).toThrow("archive parent is not a directory");
    expect(() => buildClassicZipMetadataGraph(fixture([{ name: "NeonDiff.app/Contents/file" }, { name: "NeonDiff.app/Contents" }]).artifact)).toThrow("archive path type conflict");
  });
  it("rejects central/local drift, encryption, unsupported types, and contradictory directories", () => {
    expect(() => buildClassicZipMetadataGraph(fixture([{ name: "NeonDiff.app/a", localName: "NeonDiff.app/b" }]).artifact)).toThrow("local/central metadata mismatch");
    expect(() => buildClassicZipMetadataGraph(fixture([{ name: "NeonDiff.app/a", flags: 0x801 }]).artifact)).toThrow("encrypted or unsupported ZIP flags");
    expect(() => buildClassicZipMetadataGraph(fixture([{ name: "NeonDiff.app/a", flags: 0x808, descriptor: false }]).artifact)).toThrow("data descriptor mismatch");
    const headerName = "NeonDiff.app/safe", override = unicodePathExtra(headerName, "../escape");
    expect(() => buildClassicZipMetadataGraph(fixture([{ name: headerName, extra: override }]).artifact)).toThrow("path-overriding ZIP extra field");
    expect(() => buildClassicZipMetadataGraph(fixture([{ name: headerName, localExtra: override }]).artifact)).toThrow("path-overriding ZIP extra field");
    expect(() => buildClassicZipMetadataGraph(fixture([{ name: headerName, extra: Buffer.from([0x08, 0x00, 0x00, 0x00]) }]).artifact)).toThrow("path-overriding ZIP extra field");
    expect(() => buildClassicZipMetadataGraph(fixture([{ name: headerName, extra: Buffer.from([0x75, 0x70, 0xff, 0xff]) }]).artifact)).toThrow("malformed ZIP extra field");
    expect(() => buildClassicZipMetadataGraph(fixture([{ name: "NeonDiff.app/a", mode: 0o010644 }]).artifact)).toThrow("unsupported archive entry type");
    expect(() => buildClassicZipMetadataGraph(fixture([{ name: "NeonDiff.app/not-a-directory", type: "directory" }]).artifact)).toThrow("directory path/type mismatch");
    expect(() => buildClassicZipMetadataGraph(fixture([{ name: "NeonDiff.app/a" }, { name: "NeonDiff.app/a", localOffset: 0 }]).artifact)).toThrow("overlapping local entry ranges");
  });
  it("rejects malformed UTF-8 and a non-directory AppleDouble root", () => {
    const malformed = fixture([{ name: "NeonDiff.app/a" }]), bytes = readFileSync(malformed.artifact), directory = bytes.readUInt32LE(bytes.length - 6); bytes[30] = 0xff; bytes[directory + 46] = 0xff; writeFileSync(malformed.artifact, bytes);
    expect(() => buildClassicZipMetadataGraph(malformed.artifact)).toThrow("archive path encoding unsupported");
    expect(() => buildClassicZipMetadataGraph(fixture([{ name: "NeonDiff.app/", type: "directory" }, { name: "__MACOSX" }]).artifact)).toThrow("unsupported AppleDouble root");
  });
  it("bounds expanded bytes and the complete implicit-node graph before extraction", () => {
    expect(() => buildClassicZipMetadataGraph(fixture([{ name: "NeonDiff.app/large", method: 8, expanded: 512 * 1024 * 1024 + 1 }]).artifact)).toThrow("expanded byte bound exceeded");
    const wide = Array.from({ length: 10000 }, (_, index) => ({ name: `NeonDiff.app/d${index}/f` }));
    expect(() => buildClassicZipMetadataGraph(fixture(wide).artifact)).toThrow("metadata node bound exceeded");
  });
  it.skipIf(process.platform !== "darwin")("accepts the canonical ditto keep-parent archive shape", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-ditto-")), app = join(root, "NeonDiff.app"), archive = join(root, "NeonDiff.zip"); roots.push(root);
    mkdirSync(join(app, "Contents", "MacOS"), { recursive: true }); writeFileSync(join(app, "Contents", "MacOS", "NeonDiff"), "binary"); symlinkSync("MacOS", join(app, "Contents", "Current"));
    execFileSync("/usr/bin/ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", app, archive]);
    const graph = buildClassicZipMetadataGraph(archive); expect(buildClassicZipMetadataGraph(archive)).toEqual(graph); expect(graph.records.some((record) => record.type === "symlink")).toBe(true);
    await withMaterializedClassicZipApp(archive, (appPath) => { expect(readFileSync(join(appPath, "Contents", "MacOS", "NeonDiff"), "utf8")).toBe("binary"); expect(readlinkSync(join(appPath, "Contents", "Current"))).toBe("MacOS"); });
  });
});

describe("graph-authoritative ZIP materialization", () => {
  it("materializes stored/deflated bytes, modes, and symlinks before one bounded consumer", async () => {
    const value = fixture([{ name: "NeonDiff.app/", type: "directory" }, { name: "NeonDiff.app/Contents/Info.plist", data: "plist" }, { name: "NeonDiff.app/Contents/MacOS/NeonDiff", data: "binary", method: 8, flags: 0x808, mode: 0o100755 }, { name: "NeonDiff.app/Contents/Current", type: "symlink", data: "MacOS" }, { name: "__MACOSX/NeonDiff.app/Contents/._Info.plist", data: "appledouble", method: 8 }]); let materializedRoot = "";
    const result = await withMaterializedClassicZipApp(value.artifact, async (appPath, graph) => {
      materializedRoot = dirname(appPath); writeFileSync(value.artifact, "changed after snapshot");
      expect(readFileSync(join(appPath, "Contents", "Info.plist"), "utf8")).toBe("plist"); expect(readFileSync(join(appPath, "Contents", "MacOS", "NeonDiff"), "utf8")).toBe("binary"); expect(readFileSync(join(materializedRoot, "__MACOSX", "NeonDiff.app", "Contents", "._Info.plist"), "utf8")).toBe("appledouble");
      expect(statSync(join(appPath, "Contents", "MacOS", "NeonDiff")).mode & 0o777).toBe(0o755); expect(readlinkSync(join(appPath, "Contents", "Current"))).toBe("MacOS"); expect(Object.isFrozen(graph)).toBe(true); return "accepted";
    });
    expect(result).toBe("accepted"); expect(existsSync(materializedRoot)).toBe(false);
  });
  it("fails before the consumer on CRC, size, special-mode, and symlink invariant violations", async () => {
    const cases: [Entry[], string][] = [
      [[{ name: "NeonDiff.app/a", data: "bytes", crc: 0 }], "CRC-32 mismatch"],
      [[{ name: "NeonDiff.app/a", data: "expands", method: 8, expanded: 1 }], "expanded entry size mismatch"],
      [[{ name: "NeonDiff.app/a", mode: 0o104755 }], "special permission bits unsupported"],
      [[{ name: "NeonDiff.app/link", type: "symlink", data: "" }], "unsafe symlink target"],
      [[{ name: "NeonDiff.app/link", type: "symlink", data: "bad\0target" }], "unsafe symlink target"],
      [[{ name: "NeonDiff.app/link", type: "symlink", data: "/tmp" }], "unsafe symlink target"],
      [[{ name: "NeonDiff.app/link", type: "symlink", data: Buffer.alloc(4097, 97) }], "symlink target too large"],
      [[{ name: "NeonDiff.app/link", type: "symlink", data: "../../escape" }], "unsafe symlink target"],
      [[{ name: "NeonDiff.app/link", type: "symlink", data: "missing" }], "missing symlink target"]
    ];
    for (const [entries, message] of cases) {
      const value = fixture(entries), before = readdirSync(value.root).sort(), previous = process.env.TMPDIR; let called = false; process.env.TMPDIR = value.root;
      try { await expect(withMaterializedClassicZipApp(value.artifact, () => { called = true; })).rejects.toThrow(message); } finally { if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous; }
      expect(called).toBe(false); expect(readdirSync(value.root).sort()).toEqual(before);
    }
  });
  it("ignores unreferenced local headers and removes its private root after callback failure", async () => {
    const value = fixture([{ name: "NeonDiff.app/a", data: "safe" }]), original = readFileSync(value.artifact), central = original.readUInt32LE(original.length - 6), hiddenArchive = classicZip([{ name: "../escape", data: "hostile" }]), hidden = hiddenArchive.subarray(0, hiddenArchive.readUInt32LE(hiddenArchive.length - 6)), bytes = Buffer.concat([hidden, original]);
    u32(bytes, hidden.length + central + 42, original.readUInt32LE(central + 42) + hidden.length); u32(bytes, bytes.length - 6, central + hidden.length); writeFileSync(value.artifact, bytes); let materializedRoot = "";
    await expect(withMaterializedClassicZipApp(value.artifact, (appPath) => { materializedRoot = dirname(appPath); expect(readFileSync(join(appPath, "a"), "utf8")).toBe("safe"); expect(existsSync(join(materializedRoot, "escape"))).toBe(false); throw new Error("consumer failed"); })).rejects.toThrow("consumer failed");
    expect(materializedRoot).not.toBe(""); expect(existsSync(materializedRoot)).toBe(false);
  });
});
