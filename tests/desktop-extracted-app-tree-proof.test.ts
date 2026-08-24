import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { buildClassicZipMetadataGraph, buildExtractedAppTreeProof, extractedAppTreeProofDigest, guardClassicZipArchive, serializeExtractedAppTreeProof, withMaterializedClassicZipApp } from "../scripts/lib/desktop-extracted-app-tree-proof.mjs";
import { acceptedDesktopReleasePacketDigest, buildAcceptedDesktopReleasePacket, serializeAcceptedDesktopReleasePacket } from "../scripts/lib/desktop-accepted-release-packet.mjs";

type Entry = { name: string; localName?: string; localOffset?: number; localExtra?: Buffer; type?: "file" | "directory" | "symlink"; data?: string | Buffer; trailing?: Buffer; flags?: number; method?: number; expanded?: number; crc?: number; descriptor?: boolean; extra?: number | Buffer; comment?: number; mode?: number };
const roots: string[] = [];
const u16 = (b: Buffer, p: number, n: number) => b.writeUInt16LE(n, p);
const u32 = (b: Buffer, p: number, n: number) => b.writeUInt32LE(n, p);
function classicZip(entries: Entry[]) {
  const locals: Buffer[] = [], central: Buffer[] = []; let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name), localName = Buffer.from(entry.localName ?? entry.name), payload = Buffer.from(entry.data ?? ""), localExtra = entry.localExtra ?? Buffer.alloc(0), extra = Buffer.isBuffer(entry.extra) ? entry.extra : Buffer.alloc(entry.extra ?? 0), comment = Buffer.alloc(entry.comment ?? 0), flags = entry.flags ?? 0x800, method = entry.method ?? 0, encoded = method === 8 ? deflateRawSync(payload) : payload, data = entry.trailing ? Buffer.concat([encoded, entry.trailing]) : encoded, expanded = entry.expanded ?? payload.length, checksum = entry.crc ?? crc32(payload), hasDescriptor = Boolean(flags & 0x8), descriptor = hasDescriptor && entry.descriptor !== false ? Buffer.alloc(16) : Buffer.alloc(0);
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
const stableFeed = "https://www.neondiff.com/updates/stable/appcast.xml", betaFeed = "https://www.neondiff.com/updates/beta/appcast.xml", defaultPublicKey = Buffer.alloc(32, 1).toString("base64");
function plist(version = "1.1.0-rc.9", extra = "", publicKey = defaultPublicKey) { const feed = version === "1.1.0" ? stableFeed : betaFeed; return `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.electricsheephq.NeonDiffDesktop</string><key>CFBundleShortVersionString</key><string>${version}</string><key>CFBundleVersion</key><string>11091</string><key>LSMinimumSystemVersion</key><string>14.0</string><key>SUFeedURL</key><string>${feed}</string><key>SUPublicEDKey</key><string>${publicKey}</string>${extra}</dict></plist>`; }
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
    const value = fixture([{ name: "NeonDiff.app/", type: "directory" }, { name: "NeonDiff.app/Contents/Info.plist", data: "plist" }, { name: "NeonDiff.app/Contents/MacOS/NeonDiff", data: "binary", method: 8, flags: 0x808, mode: 0o100755 }, { name: "NeonDiff.app/Contents/Current", type: "symlink", data: "MacOS" }, { name: "NeonDiff.app/Contents/Frameworks/Fixture.framework/Versions/A/Fixture", data: "framework" }, { name: "NeonDiff.app/Contents/Frameworks/Fixture.framework/Versions/Current", type: "symlink", data: "A" }, { name: "NeonDiff.app/Contents/Frameworks/Fixture.framework/Fixture", type: "symlink", data: "Versions/Current/Fixture" }, { name: "__MACOSX/NeonDiff.app/Contents/._Info.plist", data: "appledouble", method: 8 }]); let materializedRoot = "";
    const result = await withMaterializedClassicZipApp(value.artifact, async (appPath, graph) => {
      materializedRoot = dirname(appPath); writeFileSync(value.artifact, "changed after snapshot");
      expect(readFileSync(join(appPath, "Contents", "Info.plist"), "utf8")).toBe("plist"); expect(readFileSync(join(appPath, "Contents", "MacOS", "NeonDiff"), "utf8")).toBe("binary"); expect(readFileSync(join(materializedRoot, "__MACOSX", "NeonDiff.app", "Contents", "._Info.plist"), "utf8")).toBe("appledouble");
      expect(statSync(join(appPath, "Contents", "MacOS", "NeonDiff")).mode & 0o777).toBe(0o755); expect(readlinkSync(join(appPath, "Contents", "Current"))).toBe("MacOS"); expect(readFileSync(join(appPath, "Contents", "Frameworks", "Fixture.framework", "Fixture"), "utf8")).toBe("framework"); expect(Object.isFrozen(graph)).toBe(true); return "accepted";
    });
    expect(result).toBe("accepted"); expect(existsSync(materializedRoot)).toBe(false);
  });
  it("fails before the consumer on CRC, size, special-mode, and symlink invariant violations", async () => {
    const cases: [Entry[], string | RegExp][] = [
      [[{ name: "NeonDiff.app/a", data: "bytes", crc: 0 }], "CRC-32 mismatch"],
      [[{ name: "NeonDiff.app/a", data: "expands", method: 8, expanded: 1 }], "expanded entry size mismatch"],
      [[{ name: "NeonDiff.app/a", data: "bytes", method: 8, trailing: Buffer.from("garbage") }], /trailing|garbage/i],
      [[{ name: "NeonDiff.app/a", mode: 0o104755 }], "special permission bits unsupported"],
      [[{ name: "NeonDiff.app/link", type: "symlink", data: "" }], "unsafe symlink target"],
      [[{ name: "NeonDiff.app/link", type: "symlink", data: "bad\0target" }], "unsafe symlink target"],
      [[{ name: "NeonDiff.app/link", type: "symlink", data: "/tmp" }], "unsafe symlink target"],
      [[{ name: "NeonDiff.app/link", type: "symlink", data: Buffer.alloc(4097, 97) }], "symlink target too large"],
      [[{ name: "NeonDiff.app/link", type: "symlink", data: "../../escape" }], "unsafe symlink target"],
      [[{ name: "NeonDiff.app/link", type: "symlink", data: "missing" }], "missing symlink target"],
      [[{ name: "NeonDiff.app/a", type: "symlink", data: "b" }, { name: "NeonDiff.app/b", type: "symlink", data: "a" }], "symlink cycle"]
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
  it("restores owner directory access before removing accepted restrictive modes", async () => {
    const value = fixture([{ name: "NeonDiff.app/", type: "directory" }, { name: "NeonDiff.app/Locked/", type: "directory", mode: 0o040000 }, { name: "NeonDiff.app/Locked/file", data: "bytes" }]); let materializedRoot = "";
    await expect(withMaterializedClassicZipApp(value.artifact, (appPath) => { materializedRoot = dirname(appPath); expect(statSync(join(appPath, "Locked")).mode & 0o777).toBe(0); return "clean"; })).resolves.toBe("clean");
    expect(existsSync(materializedRoot)).toBe(false);
  });
});

describe("authenticated exact-ZIP app tree and plist proof", () => {
  const sourceSHA = "0123456789abcdef0123456789abcdef01234567";
  function proofFixture(version = "1.1.0-rc.9", extra = "", info: string | Buffer = plist(version, extra)) {
    return fixture([{ name: "NeonDiff.app/", type: "directory" }, { name: "NeonDiff.app/Contents/Info.plist", data: info }, { name: "NeonDiff.app/Contents/MacOS/NeonDiffDesktop", data: "desktop", mode: 0o100755 }, { name: "NeonDiff.app/Contents/Resources/Current", type: "symlink", data: "../MacOS/NeonDiffDesktop" }, { name: "__MACOSX/NeonDiff.app/Contents/._Info.plist", data: "appledouble" }]);
  }
  it("derives one frozen canonical proof and binds explicit AppleDouble exclusion", async () => {
    for (const version of ["1.1.0", "1.1.0-beta.87", "1.1.0-rc.9"]) {
      const value = proofFixture(version), proof = await buildExtractedAppTreeProof(value.artifact, sourceSHA);
      let canonicalTree: any;
      await withMaterializedClassicZipApp(value.artifact, (appPath) => { canonicalTree = JSON.parse(execFileSync(process.execPath, [join(process.cwd(), "scripts/hash-desktop-bundle-tree.mjs"), appPath], { encoding: "utf8" })); });
      expect(proof).toMatchObject({ schemaVersion: 1, kind: "neondiff.desktop.extracted-tree-proof-v1", verified: true, algorithm: "sha256-tree-v1", sourceSHA, treeSHA256: canonicalTree.sha256, bundleMarkers: { appPath: "NeonDiff.app", bundleID: "com.electricsheephq.NeonDiffDesktop", version, build: "11091" }, appleDouble: { policy: "artifact-bound-excluded-from-tree-v1", entryCount: 1 } });
      expect(proof.artifactSHA256).toBe(createHash("sha256").update(readFileSync(value.artifact)).digest("hex")); expect(proof.records).toHaveLength(canonicalTree.entryCount);
      expect(Object.isFrozen(proof) && Object.isFrozen(proof.records) && Object.isFrozen(proof.records[0]) && Object.isFrozen(proof.bundleMarkers) && Object.isFrozen(proof.appleDouble)).toBe(true);
      expect(serializeExtractedAppTreeProof(proof)).toMatch(/\n$/); expect(extractedAppTreeProofDigest(proof)).toMatch(/^[a-f0-9]{64}$/);
    }
  });
  it("fails closed on ambiguous plist bytes and invalid bundle markers", async () => {
    const invalid = [
      proofFixture("1.1.0", "<key>CFBundleName</key><string>A</string><key>CFBundleName</key><string>B</string>"),
      proofFixture("1.1.0", "", Buffer.from("bplist00hostile")),
      proofFixture("1.2.0"),
      proofFixture("1.1.0", "", plist("1.1.0").replace("com.electricsheephq.NeonDiffDesktop", "com.example.Wrong")),
      proofFixture("1.1.0", "", plist("1.1.0").replace("11091", "not-a-build"))
    ];
    for (const value of invalid) await expect(buildExtractedAppTreeProof(value.artifact, sourceSHA)).rejects.toThrow(/plist|marker/i);
  });
  it("accepts primitive authority only and rejects forged proof serialization without proxy reads", async () => {
    const value = proofFixture(), proof = await buildExtractedAppTreeProof(value.artifact, sourceSHA); let proxyRead = false;
    await expect(buildExtractedAppTreeProof(new Proxy({}, { get() { proxyRead = true; throw new Error("trap"); } }) as any, sourceSHA)).rejects.toThrow("artifact path"); expect(proxyRead).toBe(false);
    expect(() => serializeExtractedAppTreeProof({ ...proof } as any)).toThrow("not produced");
    expect(() => serializeExtractedAppTreeProof(new Proxy(proof, { get() { proxyRead = true; throw new Error("trap"); } }) as any)).toThrow("not produced"); expect(proxyRead).toBe(false);
    const shadow = proofFixture(), previousPythonPath = process.env.PYTHONPATH; writeFileSync(join(shadow.root, "json.py"), "raise RuntimeError('shadow')"); writeFileSync(join(shadow.root, "plistlib.py"), "raise RuntimeError('shadow')");
    try { process.env.PYTHONPATH = shadow.root; await expect(buildExtractedAppTreeProof(shadow.artifact, sourceSHA)).resolves.toMatchObject({ verified: true }); } finally { if (previousPythonPath === undefined) delete process.env.PYTHONPATH; else process.env.PYTHONPATH = previousPythonPath; }
    await expect(buildExtractedAppTreeProof(fixture([{ name: "NeonDiff.app/", type: "directory" }, { name: "NeonDiff.app/Contents/Info.plist", data: plist() }, { name: "NeonDiff.app/Foo/a" }, { name: "NeonDiff.app/Ｆｏｏ/b" }]).artifact, sourceSHA)).rejects.toThrow("tree path collision");
  });
});

describe("canonical accepted Desktop release packet", () => {
  const sourceSHA = "1".repeat(40), tagObjectSHA = "2".repeat(40), tag = "v1.1.0", version = "1.1.0", build = "11091", artifactName = `NeonDiff-${version}-build${build}-macOS.zip`;
  function packetFixture(sidecar = false, inAppSidecar = false) {
    const root = mkdtempSync(join(tmpdir(), "neondiff-packet-")); roots.push(root);
    const { publicKey, privateKey } = generateKeyPairSync("ed25519"), acceptedPublicKey = Buffer.from(publicKey.export({ format: "der", type: "spki" })).subarray(-32).toString("base64"), artifactPath = join(root, artifactName);
    const entries: Entry[] = [{ name: "NeonDiff.app/", type: "directory" }, { name: "NeonDiff.app/Contents/Info.plist", data: plist(version, "", acceptedPublicKey) }, { name: "NeonDiff.app/Contents/MacOS/NeonDiffDesktop", data: "desktop", mode: 0o100755 }]; if (sidecar) entries.push({ name: "__MACOSX/NeonDiff.app/Contents/._Info.plist", data: "appledouble" }); if (inAppSidecar) entries.push({ name: "NeonDiff.app/Contents/._Info.plist", data: Buffer.from([0x00, 0x05, 0x16, 0x07]) });
    writeFileSync(artifactPath, classicZip(entries)); const artifact = readFileSync(artifactPath), artifactSHA256 = createHash("sha256").update(artifact).digest("hex"), url = `https://github.com/electricsheephq/evaos-code-review-bot-neondiff/releases/download/${tag}/${artifactName}`, edSignature = sign(null, artifact, privateKey).toString("base64"), declarationDirectory = join(root, "declarations"); mkdirSync(declarationDirectory);
    const indexPath = join(root, "index.json"), feedPath = join(root, "appcast.xml"), tagRefPath = join(root, "tag-ref.json"), tagObjectPath = join(root, "tag-object.json"), releasePath = join(root, "release.json"), acceptedPublicKeyPath = join(root, "accepted-sparkle-public-key.txt"), declarationPath = join(declarationDirectory, `${tag}.json`);
    const declaration = { schemaVersion: 1, product: "neondiff-desktop", version, tag, channel: "stable", sequence: null, build, predecessor: null, contract: "paid-mac-ga-byo-v1", distribution: { bundleId: "com.electricsheephq.NeonDiffDesktop", appPath: "NeonDiff.app", artifactName, releaseClass: "desktop-only", origins: { github: "https://github.com/electricsheephq/evaos-code-review-bot-neondiff", site: "https://www.neondiff.com", feed: stableFeed } } };
    const tagRef = { ref: `refs/tags/${tag}`, object: { type: "tag", sha: tagObjectSHA } }, tagObject = { sha: tagObjectSHA, tag, message: `NeonDiff ${version}\n\nNeonDiff-Release-Class: desktop-only\n`, object: { type: "commit", sha: sourceSHA } }, release = { tag_name: tag, draft: false, prerelease: false, immutable: true, assets: [{ name: artifactName, size: artifact.length, digest: `sha256:${artifactSHA256}`, browser_download_url: url }] };
    writeFileSync(indexPath, JSON.stringify({ schemaVersion: 1, status: "retained", declarationDirectory: "declarations", declarationPaths: [`${tag}.json`], currentPath: `${tag}.json` })); writeFileSync(declarationPath, JSON.stringify(declaration)); writeFileSync(tagRefPath, JSON.stringify(tagRef)); writeFileSync(tagObjectPath, JSON.stringify(tagObject)); writeFileSync(releasePath, JSON.stringify(release)); writeFileSync(acceptedPublicKeyPath, acceptedPublicKey); writeFileSync(feedPath, `<?xml version="1.0"?><rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel><title>NeonDiff Desktop stable</title><link>${stableFeed}</link><description>NeonDiff Desktop stable appcast</description><item><title>NeonDiff ${version}</title><pubDate>Sun, 24 Aug 2026 00:00:00 +0000</pubDate><sparkle:minimumSystemVersion>14.0</sparkle:minimumSystemVersion><enclosure url="${url}" length="${artifact.length}" type="application/octet-stream" sparkle:version="${build}" sparkle:shortVersionString="${version}" sparkle:minimumSystemVersion="14.0" sparkle:edSignature="${edSignature}" /></item></channel></rss>`);
    return { paths: [indexPath, artifactPath, feedPath, tagRefPath, tagObjectPath, releasePath, acceptedPublicKeyPath] as const, indexPath, feedPath, tagRefPath, tagObjectPath, releasePath, acceptedPublicKeyPath, declarationPath, declaration, tagRef, tagObject, release };
  }
  it("derives one frozen exact-source/artifact/tree/feed/enclosure/npm packet", async () => {
    const value = packetFixture(), packet = await buildAcceptedDesktopReleasePacket(...value.paths);
    expect(packet).toMatchObject({ schemaVersion: 1, kind: "neondiff.desktop.accepted-release-packet-v1", channel: "stable", version, build, tag, sourceSHA, tagObjectSHA, artifactName, npmReleaseClass: "desktop-only" });
    expect(packet.artifactSHA256).toMatch(/^[a-f0-9]{64}$/); expect(packet.treeSHA256).toMatch(/^[a-f0-9]{64}$/); expect(packet.feedSHA256).toMatch(/^[a-f0-9]{64}$/); expect(packet.enclosureProofSHA256).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(packet) && Object.isFrozen(packet.feedEntry)).toBe(true); expect(serializeAcceptedDesktopReleasePacket(packet)).toMatch(/\n$/); expect(acceptedDesktopReleasePacketDigest(packet)).toMatch(/^[a-f0-9]{64}$/);
    let read = false; expect(() => serializeAcceptedDesktopReleasePacket({ ...packet } as any)).toThrow("not produced"); expect(() => serializeAcceptedDesktopReleasePacket(new Proxy(packet, { get() { read = true; throw new Error("trap"); } }) as any)).toThrow("not produced"); expect(read).toBe(false);
  });
  it("rejects cross-release, raw-feed, metadata, artifact, and caller substitutions", async () => {
    const cases: Array<(value: ReturnType<typeof packetFixture>) => void> = [
      (value) => writeFileSync(value.tagObjectPath, JSON.stringify({ ...value.tagObject, object: { type: "commit", sha: tagObjectSHA } })),
      (value) => writeFileSync(value.releasePath, JSON.stringify({ ...value.release, tag_name: "v1.1.0-rc.1" })),
      (value) => writeFileSync(value.releasePath, JSON.stringify({ ...value.release, assets: [{ ...value.release.assets[0], digest: `sha256:${"a".repeat(64)}` }] })),
      (value) => writeFileSync(value.declarationPath, JSON.stringify({ ...value.declaration, build: "11092" })),
      (value) => writeFileSync(value.feedPath, readFileSync(value.feedPath, "utf8").replace('sparkle:version="11091"', 'sparkle:version="11092"')),
      (value) => { const raw = readFileSync(value.feedPath, "utf8"), item = raw.match(/<item>.*<\/item>/s)?.[0] ?? ""; writeFileSync(value.feedPath, raw.replace("</channel>", `${item}</channel>`)); },
      (value) => writeFileSync(value.feedPath, '<!DOCTYPE rss [<!ENTITY x "hostile">]><rss>&x;</rss>'),
      (value) => writeFileSync(value.tagRefPath, `{"ref":"refs/tags/v1.1.0","ref":"refs/tags/v1.1.0-rc.1","object":{"type":"tag","sha":"${tagObjectSHA}"}}`)
    ];
    for (const mutate of cases) { const value = packetFixture(); mutate(value); await expect(buildAcceptedDesktopReleasePacket(...value.paths)).rejects.toThrow(); }
    await expect(buildAcceptedDesktopReleasePacket(...packetFixture(true).paths)).rejects.toThrow(/AppleDouble/i);
    let read = false; const paths = packetFixture().paths; await expect(buildAcceptedDesktopReleasePacket(new Proxy({}, { get() { read = true; throw new Error("trap"); } }) as any, ...paths.slice(1))).rejects.toThrow("primitive"); expect(read).toBe(false);
  });
  it("rejects untrusted updater keys, bundle/feed OS drift, and in-app AppleDouble", async () => {
    const wrongKey = packetFixture(); writeFileSync(wrongKey.acceptedPublicKeyPath, Buffer.alloc(32, 9).toString("base64")); await expect(buildAcceptedDesktopReleasePacket(...wrongKey.paths)).rejects.toThrow(/release authority/i);
    const wrongMinimum = packetFixture(); writeFileSync(wrongMinimum.feedPath, readFileSync(wrongMinimum.feedPath, "utf8").replaceAll("14.0", "13.0")); await expect(buildAcceptedDesktopReleasePacket(...wrongMinimum.paths)).rejects.toThrow(/enclosure identity/i);
    await expect(buildAcceptedDesktopReleasePacket(...packetFixture(false, true).paths)).rejects.toThrow(/AppleDouble/i);
  });
});
