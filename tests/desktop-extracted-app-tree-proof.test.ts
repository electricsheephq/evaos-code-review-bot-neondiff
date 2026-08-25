import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { buildClassicZipMetadataGraph, buildExtractedAppTreeProof, extractedAppTreeProofDigest, guardClassicZipArchive, serializeExtractedAppTreeProof, withMaterializedClassicZipApp } from "../scripts/lib/desktop-extracted-app-tree-proof.mjs";
import { acceptedDesktopReleasePacketDigest, buildAcceptedDesktopReleasePacket, parseAcceptedDesktopReleasePacket, serializeAcceptedDesktopReleasePacket } from "../scripts/lib/desktop-accepted-release-packet.mjs";
import { buildFeedEnclosureProof, feedEnclosureProofDigest } from "../scripts/lib/desktop-feed-enclosure-proof.mjs";
import { planAcceptedDesktopTransition } from "../scripts/lib/desktop-update-command.mjs";

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
const stableFeed = "https://www.neondiff.com/updates/stable/appcast.xml", betaFeed = "https://www.neondiff.com/updates/beta/appcast.xml", defaultPublicKey = Buffer.alloc(32, 1).toString("base64"), defaultSourceSHA = "0123456789abcdef0123456789abcdef01234567", plistDoctype = '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">', byoProductionMarkers = "<key>NeonDiffPaidBetaContract</key><string>paid-mac-beta-byo-v1</string><key>NeonDiffBYOGitHubEnabled</key><true/>";
function plist(version = "1.1.0-rc.9", extra = "", publicKey = defaultPublicKey, productionMarkers = byoProductionMarkers, artifactSourceSHA = defaultSourceSHA) { const feed = version === "1.1.0" ? stableFeed : betaFeed, sourceMarker = artifactSourceSHA ? `<key>NeonDiffSourceSHA</key><string>${artifactSourceSHA}</string>` : ""; return `<?xml version="1.0" encoding="UTF-8"?>${plistDoctype}<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.electricsheephq.NeonDiffDesktop</string><key>CFBundleShortVersionString</key><string>${version}</string><key>CFBundleVersion</key><string>11091</string><key>LSMinimumSystemVersion</key><string>14.0</string><key>SUFeedURL</key><string>${feed}</string><key>SUPublicEDKey</key><string>${publicKey}</string>${sourceMarker}${productionMarkers}${extra}</dict></plist>`; }
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

describe("canonical accepted Desktop release packet", () => {
  const sourceSHA = "1".repeat(40), tagObjectSHA = "2".repeat(40), tag = "v1.1.0", version = "1.1.0", build = "11091", artifactName = `NeonDiff-${version}-build${build}-macOS.zip`;
  function packetFixture(sidecar = false, inAppSidecar = false, productionMarkers = byoProductionMarkers, artifactSourceSHA = sourceSHA) {
    const root = mkdtempSync(join(tmpdir(), "neondiff-packet-")); roots.push(root);
    const { publicKey, privateKey } = generateKeyPairSync("ed25519"), acceptedPublicKey = Buffer.from(publicKey.export({ format: "der", type: "spki" })).subarray(-32).toString("base64"), artifactPath = join(root, artifactName);
    const entries: Entry[] = [{ name: "NeonDiff.app/", type: "directory" }, { name: "NeonDiff.app/Contents/Info.plist", data: plist(version, "", acceptedPublicKey, productionMarkers, artifactSourceSHA) }, { name: "NeonDiff.app/Contents/MacOS/NeonDiffDesktop", data: "desktop", mode: 0o100755 }]; if (sidecar) entries.push({ name: "__MACOSX/NeonDiff.app/Contents/._Info.plist", data: "appledouble" }); if (inAppSidecar) entries.push({ name: "NeonDiff.app/Contents/._Info.plist", data: Buffer.from([0x00, 0x05, 0x16, 0x07]) });
    writeFileSync(artifactPath, classicZip(entries)); const artifact = readFileSync(artifactPath), artifactSHA256 = createHash("sha256").update(artifact).digest("hex"), url = `https://github.com/electricsheephq/evaos-code-review-bot-neondiff/releases/download/${tag}/${artifactName}`, edSignature = sign(null, artifact, privateKey).toString("base64"), declarationDirectory = join(root, "declarations"); mkdirSync(declarationDirectory);
    const indexPath = join(root, "index.json"), feedPath = join(root, "appcast.xml"), tagRefPath = join(root, "tag-ref.json"), tagObjectPath = join(root, "tag-object.json"), releasePath = join(root, "release.json"), acceptedPublicKeyPath = join(root, "accepted-sparkle-public-key.txt"), declarationPath = join(declarationDirectory, `${tag}.json`);
    const declaration = { schemaVersion: 1, product: "neondiff-desktop", version, tag, channel: "stable", sequence: null, build, predecessor: null, contract: "paid-mac-ga-byo-v1", distribution: { bundleId: "com.electricsheephq.NeonDiffDesktop", appPath: "NeonDiff.app", artifactName, releaseClass: "desktop-only", origins: { github: "https://github.com/electricsheephq/evaos-code-review-bot-neondiff", site: "https://www.neondiff.com", feed: stableFeed } } };
    const tagRef = { ref: `refs/tags/${tag}`, object: { type: "tag", sha: tagObjectSHA } }, tagObject = { sha: tagObjectSHA, tag, message: `NeonDiff ${version}\n\nNeonDiff-Release-Class: desktop-only\n`, object: { type: "commit", sha: sourceSHA } }, release = { tag_name: tag, draft: false, prerelease: false, immutable: true, assets: [{ name: artifactName, size: artifact.length, digest: `sha256:${artifactSHA256}`, browser_download_url: url }] };
    writeFileSync(indexPath, JSON.stringify({ schemaVersion: 1, status: "retained", declarationDirectory: "declarations", declarationPaths: [`${tag}.json`], currentPath: `${tag}.json` })); writeFileSync(declarationPath, JSON.stringify(declaration)); writeFileSync(tagRefPath, JSON.stringify(tagRef)); writeFileSync(tagObjectPath, JSON.stringify(tagObject)); writeFileSync(releasePath, JSON.stringify(release)); writeFileSync(acceptedPublicKeyPath, acceptedPublicKey); writeFileSync(feedPath, `<?xml version="1.0"?><rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel><title>NeonDiff Desktop stable</title><link>${stableFeed}</link><description>NeonDiff Desktop stable appcast</description><item><title>NeonDiff ${version}</title><pubDate>Sun, 24 Aug 2026 00:00:00 +0000</pubDate><sparkle:minimumSystemVersion>14.0</sparkle:minimumSystemVersion><enclosure url="${url}" length="${artifact.length}" type="application/octet-stream" sparkle:version="${build}" sparkle:shortVersionString="${version}" sparkle:minimumSystemVersion="14.0" sparkle:edSignature="${edSignature}" /></item></channel></rss>`);
    return { root, artifactPath, artifactSHA256, artifactName, acceptedPublicKey, privateKey, paths: [indexPath, artifactPath, feedPath, tagRefPath, tagObjectPath, releasePath, acceptedPublicKeyPath] as const, indexPath, feedPath, tagRefPath, tagObjectPath, releasePath, acceptedPublicKeyPath, declarationPath, declaration, tagRef, tagObject, release };
  }
  async function transitionAuthorityFixture(action: "update" | "rollback" | "reupdate" = "reupdate") {
    const value = packetFixture(), packet = await buildAcceptedDesktopReleasePacket(...value.paths), packetBytes = Buffer.from(serializeAcceptedDesktopReleasePacket(packet)), packetSHA256 = createHash("sha256").update(packetBytes).digest("hex"), repository = "electricsheephq/evaos-code-review-bot-neondiff", workflow = `${repository}/.github/workflows/desktop-accepted-release-packet.yml`, sourceRef = "refs/heads/main", evidenceTag = "neondiff-accepted-packet-v1.1.0", evidenceRoot = join(value.root, "evidence-download"), workspace = join(value.root, "workspace"), historyRoot = join(workspace, "docs/releases/desktop"), declarations = join(historyRoot, "declarations"), targets = join(historyRoot, "accepted-targets"); let workflowSHA = ""; mkdirSync(evidenceRoot); mkdirSync(declarations, { recursive: true }); mkdirSync(targets);
    const acceptedArtifactPath = join(evidenceRoot, value.artifactName), acceptedPacketPath = join(evidenceRoot, `${packetSHA256}.packet.json`); writeFileSync(acceptedArtifactPath, readFileSync(value.artifactPath)); writeFileSync(acceptedPacketPath, packetBytes);
    const betaTag = "v1.1.0-beta.87", betaVersion = "1.1.0-beta.87", betaBuild = "11087", betaArtifactName = `NeonDiff-${betaVersion}-build${betaBuild}-macOS.zip`, betaDeclaration = { ...value.declaration, version: betaVersion, tag: betaTag, channel: "beta", sequence: "87", build: betaBuild, predecessor: null, contract: "paid-mac-beta-byo-v1", distribution: { ...value.declaration.distribution, artifactName: betaArtifactName, releaseClass: "paid-beta", origins: { ...value.declaration.distribution.origins, feed: betaFeed } } }, stableDeclaration = { ...value.declaration, predecessor: `${betaTag}.json` }; writeFileSync(join(declarations, `${betaTag}.json`), JSON.stringify(betaDeclaration)); writeFileSync(join(declarations, `${tag}.json`), JSON.stringify(stableDeclaration)); const indexPath = join(historyRoot, "index.json"); writeFileSync(indexPath, JSON.stringify({ schemaVersion: 1, status: "retained", declarationDirectory: "declarations", declarationPaths: [`${betaTag}.json`, `${tag}.json`], currentPath: `${tag}.json` }));
    const betaArtifactPath = join(value.root, betaArtifactName); writeFileSync(betaArtifactPath, classicZip([{ name: "NeonDiff.app/", type: "directory" }, { name: "NeonDiff.app/Contents/Info.plist", data: plist(betaVersion, "", value.acceptedPublicKey, byoProductionMarkers, sourceSHA).replace("<string>11091</string>", `<string>${betaBuild}</string>`) }, { name: "NeonDiff.app/Contents/MacOS/NeonDiffDesktop", data: "desktop", mode: 0o100755 }])); const betaArtifactBytes = readFileSync(betaArtifactPath), betaArtifactSHA256 = createHash("sha256").update(betaArtifactBytes).digest("hex"), betaURL = `https://github.com/${repository}/releases/download/${betaTag}/${betaArtifactName}`, betaSignature = sign(null, betaArtifactBytes, value.privateKey).toString("base64"), betaFeedPath = join(value.root, "beta-appcast.xml"); writeFileSync(betaFeedPath, `<?xml version="1.0"?><rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel><title>NeonDiff Desktop beta</title><link>${betaFeed}</link><description>NeonDiff Desktop beta appcast</description><item><title>NeonDiff ${betaVersion}</title><pubDate>Sun, 24 Aug 2026 00:00:00 +0000</pubDate><sparkle:minimumSystemVersion>14.0</sparkle:minimumSystemVersion><sparkle:channel>beta</sparkle:channel><enclosure url="${betaURL}" length="${betaArtifactBytes.length}" type="application/octet-stream" sparkle:version="${betaBuild}" sparkle:shortVersionString="${betaVersion}" sparkle:minimumSystemVersion="14.0" sparkle:edSignature="${betaSignature}" /></item></channel></rss>`);
    const betaFeedBytes = readFileSync(betaFeedPath), betaTree = await buildExtractedAppTreeProof(betaArtifactPath, sourceSHA), betaEntry = { url: betaURL, length: betaArtifactBytes.length, type: "application/octet-stream", version: betaVersion, build: betaBuild, shortVersionString: betaVersion, minimumSystemVersion: "14.0", channel: "beta", edSignature: betaSignature }, betaEnclosure = buildFeedEnclosureProof({ url: betaURL, version: betaVersion, build: betaBuild, shortVersionString: betaVersion, channel: "beta", artifactName: betaArtifactName, artifactSHA256: betaArtifactSHA256, edSignature: betaSignature }, { acceptedPublicKey: value.acceptedPublicKey, signedContent: betaArtifactBytes }), betaPacket = { ...packet, channel: "beta", version: betaVersion, build: betaBuild, tag: betaTag, artifactURL: betaURL, artifactName: betaArtifactName, artifactByteLength: betaArtifactBytes.length, artifactSHA256: betaArtifactSHA256, treeSHA256: betaTree.treeSHA256, feedSHA256: createHash("sha256").update(betaFeedBytes).digest("hex"), feedEntry: betaEntry, enclosureProofSHA256: feedEnclosureProofDigest(betaEnclosure), releaseContract: "paid-mac-beta-byo-v1", npmReleaseClass: "paid-beta" }, betaPacketBytes = Buffer.from(`${JSON.stringify(betaPacket)}\n`), betaPacketSHA256 = createHash("sha256").update(betaPacketBytes).digest("hex"), betaPacketPath = join(targets, `${betaPacketSHA256}.packet.json`); writeFileSync(betaPacketPath, betaPacketBytes);
    const selected = action === "rollback" ? betaPacket : packet, selectedPacketSHA256 = action === "rollback" ? betaPacketSHA256 : packetSHA256, selectedPacketPath = action === "rollback" ? betaPacketPath : acceptedPacketPath, selectedArtifactPath = action === "rollback" ? betaArtifactPath : acceptedArtifactPath, selectedFeedPath = action === "rollback" ? betaFeedPath : value.feedPath, current = action === "rollback" ? { tag: packet.tag, build: packet.build, artifactSHA256: packet.artifactSHA256, treeSHA256: packet.treeSHA256, packetSHA256 } : { tag: betaTag, build: betaBuild, artifactSHA256: betaArtifactSHA256, treeSHA256: betaTree.treeSHA256, packetSHA256: betaPacketSHA256 };
    const target = { schemaVersion: 1, kind: "neondiff.desktop.accepted-transition-target-v1", acceptedRootPacketSHA256: packetSHA256, acceptedTarget: { packetSHA256: selectedPacketSHA256, sourceSHA: selected.sourceSHA, tagObjectSHA: selected.tagObjectSHA, sparklePublicKeySHA256: createHash("sha256").update(Buffer.from(value.acceptedPublicKey, "base64")).digest("hex") }, current, previouslyAcceptedTargetPacketSHA256: action === "update" ? null : selectedPacketSHA256 }, targetBytes = Buffer.from(`${JSON.stringify(target)}\n`), targetPath = join(targets, `${createHash("sha256").update(targetBytes).digest("hex")}.target.json`); writeFileSync(targetPath, targetBytes);
    execFileSync("git", ["init", "-b", "main"], { cwd: workspace, stdio: "ignore" }); execFileSync("git", ["config", "user.email", "accepted-history@example.invalid"], { cwd: workspace }); execFileSync("git", ["config", "user.name", "Accepted History Test"], { cwd: workspace }); execFileSync("git", ["add", "docs"], { cwd: workspace }); execFileSync("git", ["commit", "-m", "accepted history"], { cwd: workspace, stdio: "ignore" }); workflowSHA = execFileSync("git", ["rev-parse", "HEAD"], { cwd: workspace, encoding: "utf8" }).trim();
    const predicateType = "https://neondiff.com/attestations/desktop-artifact-source-promotion/v1", statement = { _type: "https://in-toto.io/Statement/v1", subject: [{ name: value.artifactName, digest: { sha256: value.artifactSHA256 } }], predicateType, predicate: { schemaVersion: 1, claimClass: "neondiff.desktop.artifact-source-promotion.v1", repository, signerWorkflow: workflow, workflowSourceRef: sourceRef, workflowSourceSHA: workflowSHA, releaseTag: tag, artifactSourceSHA: sourceSHA, acceptedPacketSHA256: packetSHA256, developerIDTeamID: "TC6MS3T6NN" } }, bundleBytes = Buffer.from(JSON.stringify({ mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json", verificationMaterial: { tlogEntries: [{}] }, dsseEnvelope: { payload: Buffer.from(JSON.stringify(statement)).toString("base64"), payloadType: "application/vnd.in-toto+json", signatures: [{ sig: Buffer.alloc(64, 1).toString("base64") }] } })), bundleSHA256 = createHash("sha256").update(bundleBytes).digest("hex"), bundleName = `${bundleSHA256}.artifact-source-attestation.json`, bundlePath = join(evidenceRoot, bundleName); writeFileSync(bundlePath, bundleBytes);
    const evidenceReleasePath = join(value.root, "evidence-release.json"), evidenceTagRefPath = join(value.root, "evidence-tag-ref.json"), packetName = `${packetSHA256}.packet.json`, asset = (name: string, bytes: Buffer, digest: string) => ({ name, size: bytes.length, digest: `sha256:${digest}`, browser_download_url: `https://github.com/${repository}/releases/download/${evidenceTag}/${name}` }); writeFileSync(evidenceReleasePath, JSON.stringify({ tag_name: evidenceTag, name: "NeonDiff accepted packet evidence v1.1.0", draft: false, prerelease: true, immutable: true, target_commitish: sourceSHA, html_url: `https://github.com/${repository}/releases/tag/${evidenceTag}`, assets: [asset(packetName, packetBytes, packetSHA256), asset(bundleName, bundleBytes, bundleSHA256)] })); writeFileSync(evidenceTagRefPath, JSON.stringify({ ref: `refs/tags/${evidenceTag}`, object: { type: "commit", sha: sourceSHA } }));
    const fakeGh = join(value.root, "gh"); writeFileSync(fakeGh, `#!/usr/bin/env node\nconst args=process.argv.slice(2);process.stdout.write(args[0]==="attestation"?process.env.FAKE_ATTESTATION_RESULT+"\\n":"{}\\n");\n`); chmodSync(fakeGh, 0o755);
    const input = { action, acceptedArtifactPath, acceptedPacketPath, acceptedBundlePath: bundlePath, acceptedReleasePath: evidenceReleasePath, acceptedTagRefPath: evidenceTagRefPath, targetArtifactPath: selectedArtifactPath, targetPacketPath: selectedPacketPath, targetFeedPath: selectedFeedPath, targetReceiptPath: targetPath }, environment = { PATH: `${value.root}:${process.env.PATH}`, FAKE_ATTESTATION_RESULT: JSON.stringify([{ verificationResult: { statement } }]), GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: repository, GITHUB_REF: sourceRef, GITHUB_SHA: workflowSHA, GITHUB_WORKFLOW_REF: `${workflow}@${sourceRef}`, RUNNER_ENVIRONMENT: "github-hosted", GITHUB_WORKSPACE: workspace }, command = ["scripts/desktop-update-command.mjs", action, "--accepted-artifact", acceptedArtifactPath, "--accepted-packet", acceptedPacketPath, "--accepted-bundle", bundlePath, "--accepted-release", evidenceReleasePath, "--accepted-tag-ref", evidenceTagRefPath, "--target-artifact", selectedArtifactPath, "--target-packet", selectedPacketPath, "--target-feed", selectedFeedPath, "--target-receipt", targetPath], env = { ...process.env, ...environment };
    const run = (requestedAction = action, overrides: Record<string, string> = {}, mutate: (args: string[]) => string[] = (args) => args) => spawnSync(process.execPath, mutate([...command.slice(0, 1), requestedAction, ...command.slice(2)]), { cwd: process.cwd(), encoding: "utf8", env: { ...env, ...overrides } });
    return { action, environment, indexPath, input, packetSHA256: selectedPacketSHA256, run, selectedArtifactPath, selectedFeedPath, selectedPacketPath, targetPath };
  }
  it("roots transition authority in #1083 and rejects re-update relabeling", async () => {
    const value = await transitionAuthorityFixture(), valid = value.run("reupdate"); expect(valid.status, valid.stderr).toBe(0); expect(JSON.parse(valid.stdout)).toMatchObject({ action: "reupdate", packetSHA256: value.packetSHA256 });
    const relabeled = value.run("update"); expect(relabeled.status).not.toBe(0); expect(relabeled.stderr).toMatch(/action.*authenticated history/i);
    expect(value.run("reupdate", { GITHUB_REPOSITORY: "attacker/example" }).status).not.toBe(0); expect(value.run("reupdate", { GITHUB_WORKFLOW_REF: "attacker/example/.github/workflows/release.yml@refs/heads/main" }).status).not.toBe(0);
  });
  it("emits redacted non-mutating update, rollback, and exact re-update plans", async () => {
    for (const action of ["update", "rollback", "reupdate"] as const) { const value = await transitionAuthorityFixture(action), watched = [value.indexPath, value.selectedArtifactPath, value.selectedFeedPath, value.selectedPacketPath, value.targetPath], before = watched.map((path) => readFileSync(path)), result = value.run(); expect(result.status, result.stderr).toBe(0); const plan = JSON.parse(result.stdout); expect(plan).toMatchObject({ action, packetSHA256: value.packetSHA256 }); expect(Object.keys(plan)).toEqual(["action", "target", "packetSHA256", "nextSteps"]); expect(plan.nextSteps).toEqual(["quiescence-and-entitlement-gates", "stage-exact-target", "atomic-transition", "poststate-and-feed-proof"]); expect(JSON.stringify(plan)).not.toMatch(/signature|publicKey|path|receipt|prestate|customer/i); expect(watched.map((path) => readFileSync(path))).toEqual(before); }
  }, 15_000);
  it("rejects noncanonical CLI syntax, alternate history roots, and changed receipts", async () => {
    const syntax = await transitionAuthorityFixture("update"); expect(syntax.run(undefined, {}, (args) => args.map((value) => value === "--target-feed" ? "target-feed" : value)).status).not.toBe(0);
    const alternate = await transitionAuthorityFixture("reupdate"), outside = join(dirname(dirname(alternate.targetPath)), basename(alternate.targetPath)); writeFileSync(outside, readFileSync(alternate.targetPath)); expect(alternate.run(undefined, {}, (args) => args.map((value) => value === alternate.targetPath ? outside : value)).status).not.toBe(0);
    const changed = await transitionAuthorityFixture("rollback"); writeFileSync(changed.targetPath, `${readFileSync(changed.targetPath, "utf8")} `); expect(changed.run().status).not.toBe(0);
  });
  it("rejects cross-release packet substitution and a current target", async () => {
    const cross = await transitionAuthorityFixture("update"), packet = { ...parseAcceptedDesktopReleasePacket(readFileSync(cross.selectedPacketPath)), sourceSHA: "3".repeat(40), artifactSourceSHA: "3".repeat(40) }, packetBytes = Buffer.from(`${JSON.stringify(packet)}\n`), packetDigest = createHash("sha256").update(packetBytes).digest("hex"), packetPath = join(dirname(cross.targetPath), `${packetDigest}.packet.json`), receipt = JSON.parse(readFileSync(cross.targetPath, "utf8")); writeFileSync(packetPath, packetBytes); receipt.acceptedTarget.packetSHA256 = packetDigest; receipt.acceptedTarget.sourceSHA = packet.sourceSHA; const receiptBytes = Buffer.from(`${JSON.stringify(receipt)}\n`), receiptPath = join(dirname(cross.targetPath), `${createHash("sha256").update(receiptBytes).digest("hex")}.target.json`); writeFileSync(receiptPath, receiptBytes); expect(cross.run(undefined, {}, (args) => args.map((value) => value === cross.selectedPacketPath ? packetPath : value === cross.targetPath ? receiptPath : value)).status).not.toBe(0);
    const current = await transitionAuthorityFixture("update"), selected = parseAcceptedDesktopReleasePacket(readFileSync(current.selectedPacketPath)), currentReceipt = JSON.parse(readFileSync(current.targetPath, "utf8")); currentReceipt.current = { tag: selected.tag, build: selected.build, artifactSHA256: selected.artifactSHA256, treeSHA256: selected.treeSHA256, packetSHA256: current.packetSHA256 }; const currentBytes = Buffer.from(`${JSON.stringify(currentReceipt)}\n`), currentPath = join(dirname(current.targetPath), `${createHash("sha256").update(currentBytes).digest("hex")}.target.json`); writeFileSync(currentPath, currentBytes); expect(current.run(undefined, {}, (args) => args.map((value) => value === current.targetPath ? currentPath : value)).status).not.toBe(0);
  }, 10_000);
  it("rejects a protected-history change after awaited verification", async () => {
    const value = await transitionAuthorityFixture("update"), saved = Object.fromEntries(Object.keys(value.environment).map((key) => [key, process.env[key]])); Object.assign(process.env, value.environment);
    try { const pending = planAcceptedDesktopTransition(value.input); writeFileSync(value.indexPath, `${readFileSync(value.indexPath, "utf8")} `); await expect(pending).rejects.toThrow(/changed during preflight/i); }
    finally { for (const [key, prior] of Object.entries(saved)) if (prior === undefined) delete process.env[key]; else process.env[key] = prior; }
  }, 10_000);
  it("derives one frozen exact-source/artifact/tree/feed/enclosure/npm packet", async () => {
    const value = packetFixture(), packet = await buildAcceptedDesktopReleasePacket(...value.paths);
    expect(packet).toMatchObject({ schemaVersion: 3, kind: "neondiff.desktop.accepted-release-packet-v3", channel: "stable", version, build, tag, sourceSHA, artifactSourceSHA: sourceSHA, tagObjectSHA, artifactName, releaseContract: "paid-mac-ga-byo-v1", productionContract: { contract: "paid-mac-beta-byo-v1", byoGitHubEnabled: true, managedGitHubBrokerEnabledPresent: false, githubBrokerOriginPresent: false }, npmReleaseClass: "desktop-only" });
    expect(packet.artifactSHA256).toMatch(/^[a-f0-9]{64}$/); expect(packet.treeSHA256).toMatch(/^[a-f0-9]{64}$/); expect(packet.feedSHA256).toMatch(/^[a-f0-9]{64}$/); expect(packet.enclosureProofSHA256).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(packet) && Object.isFrozen(packet.feedEntry) && Object.isFrozen(packet.productionContract)).toBe(true); const serialized = serializeAcceptedDesktopReleasePacket(packet), serializedPacket = JSON.parse(serialized), parsed = parseAcceptedDesktopReleasePacket(Buffer.from(serialized)); expect(serialized).toMatch(/\n$/); expect(serializedPacket.productionContract).toEqual(packet.productionContract); expect(serializedPacket.artifactSourceSHA).toBe(sourceSHA); expect(acceptedDesktopReleasePacketDigest(packet)).toMatch(/^[a-f0-9]{64}$/); expect(parsed).toEqual(packet); expect(Object.isFrozen(parsed) && Object.isFrozen(parsed.feedEntry) && Object.isFrozen(parsed.productionContract)).toBe(true); expect(() => serializeAcceptedDesktopReleasePacket(parsed)).toThrow("not produced");
    for (const raw of [Buffer.from(serialized.trim()), Buffer.from(serialized.replace('"kind":', '"kind":"duplicate","kind":')), Buffer.from(serialized.replace('"verified":true', '"verified":true,"extra":false'))]) expect(() => parseAcceptedDesktopReleasePacket(raw)).toThrow();
    let read = false; expect(() => serializeAcceptedDesktopReleasePacket({ ...packet } as any)).toThrow("not produced"); expect(() => serializeAcceptedDesktopReleasePacket(new Proxy(packet, { get() { read = true; throw new Error("trap"); } }) as any)).toThrow("not produced"); expect(read).toBe(false);
  });
  it("admits one exact artifact attestation before writing a content-addressed packet", async () => {
    const value = packetFixture(), repository = "electricsheephq/evaos-code-review-bot-neondiff", workflow = `${repository}/.github/workflows/desktop-accepted-release-packet.yml`, sourceRef = "refs/heads/main", workflowSHA = "4".repeat(40), predicateType = "https://neondiff.com/attestations/desktop-artifact-source-promotion/v1", bundlePath = join(value.root, "artifact-attestation.json"), retained = join(value.root, "retained"), output = join(value.root, "packet.pending.json"), capture = join(value.root, "gh-args.json"); mkdirSync(retained);
    const acceptedPacketSHA256 = acceptedDesktopReleasePacketDigest(await buildAcceptedDesktopReleasePacket(...value.paths));
    const statement = { _type: "https://in-toto.io/Statement/v1", subject: [{ name: value.artifactName, digest: { sha256: value.artifactSHA256 } }], predicateType, predicate: { schemaVersion: 1, claimClass: "neondiff.desktop.artifact-source-promotion.v1", repository, signerWorkflow: workflow, workflowSourceRef: sourceRef, workflowSourceSHA: workflowSHA, releaseTag: tag, artifactSourceSHA: sourceSHA, acceptedPacketSHA256, developerIDTeamID: "TC6MS3T6NN" } }, bundle = Buffer.from(JSON.stringify({ mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json", verificationMaterial: { tlogEntries: [{}] }, dsseEnvelope: { payload: Buffer.from(JSON.stringify(statement)).toString("base64"), payloadType: "application/vnd.in-toto+json", signatures: [{ sig: Buffer.alloc(64, 1).toString("base64") }] } })); writeFileSync(bundlePath, bundle);
    const fakeGh = join(value.root, "gh"); writeFileSync(fakeGh, `#!/usr/bin/env node
const { readFileSync, writeFileSync } = require("node:fs"); const args = process.argv.slice(2); writeFileSync(process.env.CAPTURE_PATH, JSON.stringify(args)); if (process.env.FAKE_GH_MODE === "fail") process.exit(1); const document = JSON.parse(readFileSync(args[args.indexOf("--bundle") + 1], "utf8")), statement = JSON.parse(Buffer.from(document.dsseEnvelope.payload, "base64").toString("utf8")); process.stdout.write(JSON.stringify([{ verificationResult: { statement } }]));
`); chmodSync(fakeGh, 0o755);
    const args = ["scripts/build-desktop-accepted-release-packet.mjs", "--index", value.indexPath, "--artifact", value.artifactPath, "--feed", value.feedPath, "--tag-ref", value.tagRefPath, "--tag-object", value.tagObjectPath, "--release", value.releasePath, "--accepted-public-key", value.acceptedPublicKeyPath, "--artifact-attestation", bundlePath, "--attestation-output-directory", retained, "--output", output], env = { ...process.env, PATH: `${value.root}:${process.env.PATH}`, CAPTURE_PATH: capture, GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: repository, GITHUB_REF: sourceRef, GITHUB_SHA: workflowSHA, GITHUB_WORKFLOW_REF: `${workflow}@${sourceRef}`, RUNNER_ENVIRONMENT: "github-hosted" };
    const rejected = spawnSync(process.execPath, args, { cwd: process.cwd(), encoding: "utf8", env: { ...env, FAKE_GH_MODE: "fail" } }); expect(rejected.status).not.toBe(0); expect(existsSync(output)).toBe(false); expect(readdirSync(retained)).toEqual([]);
    const accepted = spawnSync(process.execPath, args, { cwd: process.cwd(), encoding: "utf8", env }); expect(accepted.status).toBe(0); const receipt = JSON.parse(accepted.stdout), packetPath = join(value.root, receipt.packetFileName), retainedPath = join(retained, receipt.artifactAttestationBundleFileName); expect(existsSync(packetPath)).toBe(false); renameSync(output, packetPath); expect(createHash("sha256").update(readFileSync(packetPath)).digest("hex")).toBe(receipt.packetSHA256); expect(readFileSync(retainedPath)).toEqual(bundle); expect(receipt.artifactAttestationBundleSHA256).toBe(createHash("sha256").update(bundle).digest("hex"));
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
      (value) => writeFileSync(value.feedPath, Buffer.from('<?xml version="1.0" encoding="UTF-16"?><rss/>', "utf16le")),
      (value) => writeFileSync(value.tagRefPath, `{"ref":"refs/tags/v1.1.0","ref":"refs/tags/v1.1.0-rc.1","object":{"type":"tag","sha":"${tagObjectSHA}"}}`)
    ];
    for (const mutate of cases) { const value = packetFixture(); mutate(value); await expect(buildAcceptedDesktopReleasePacket(...value.paths)).rejects.toThrow(); }
    await expect(buildAcceptedDesktopReleasePacket(...packetFixture(true).paths)).rejects.toThrow(/AppleDouble/i);
    await expect(buildAcceptedDesktopReleasePacket(...packetFixture(false, false, byoProductionMarkers, "3".repeat(40)).paths)).rejects.toThrow(/source/i);
    let read = false; const paths = packetFixture().paths; await expect(buildAcceptedDesktopReleasePacket(new Proxy({}, { get() { read = true; throw new Error("trap"); } }) as any, ...paths.slice(1))).rejects.toThrow("primitive"); expect(read).toBe(false);
  }, 10_000);
  it("rejects untrusted updater keys, bundle/feed OS drift, and in-app AppleDouble", async () => {
    const wrongKey = packetFixture(); writeFileSync(wrongKey.acceptedPublicKeyPath, Buffer.alloc(32, 9).toString("base64")); await expect(buildAcceptedDesktopReleasePacket(...wrongKey.paths)).rejects.toThrow(/release authority/i);
    const wrongMinimum = packetFixture(); writeFileSync(wrongMinimum.feedPath, readFileSync(wrongMinimum.feedPath, "utf8").replaceAll("14.0", "13.0")); await expect(buildAcceptedDesktopReleasePacket(...wrongMinimum.paths)).rejects.toThrow(/enclosure identity/i);
    await expect(buildAcceptedDesktopReleasePacket(...packetFixture(false, false, "").paths)).rejects.toThrow(/production contract/i);
    await expect(buildAcceptedDesktopReleasePacket(...packetFixture(false, true).paths)).rejects.toThrow(/AppleDouble/i);
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
  const sourceSHA = defaultSourceSHA;
  function proofFixture(version = "1.1.0-rc.9", extra = "", info: string | Buffer = plist(version, extra)) {
    return fixture([{ name: "NeonDiff.app/", type: "directory" }, { name: "NeonDiff.app/Contents/Info.plist", data: info }, { name: "NeonDiff.app/Contents/MacOS/NeonDiffDesktop", data: "desktop", mode: 0o100755 }, { name: "NeonDiff.app/Contents/Resources/Current", type: "symlink", data: "../MacOS/NeonDiffDesktop" }, { name: "__MACOSX/NeonDiff.app/Contents/._Info.plist", data: "appledouble" }]);
  }
  it("derives one frozen canonical proof and binds explicit AppleDouble exclusion", async () => {
    for (const version of ["1.1.0", "1.1.0-beta.87", "1.1.0-rc.9"]) {
      const value = proofFixture(version), proof = await buildExtractedAppTreeProof(value.artifact, sourceSHA);
      let canonicalTree: any;
      await withMaterializedClassicZipApp(value.artifact, (appPath) => { canonicalTree = JSON.parse(execFileSync(process.execPath, [join(process.cwd(), "scripts/hash-desktop-bundle-tree.mjs"), appPath], { encoding: "utf8" })); });
      expect(proof).toMatchObject({ schemaVersion: 3, kind: "neondiff.desktop.extracted-tree-proof-v3", verified: true, algorithm: "sha256-tree-v1", sourceSHA, treeSHA256: canonicalTree.sha256, bundleMarkers: { appPath: "NeonDiff.app", bundleID: "com.electricsheephq.NeonDiffDesktop", version, build: "11091", sourceSHA, productionContract: { contract: "paid-mac-beta-byo-v1", byoGitHubEnabled: true, managedGitHubBrokerEnabledPresent: false, githubBrokerOriginPresent: false } }, appleDouble: { policy: "artifact-bound-excluded-from-tree-v1", entryCount: 1 } });
      expect(proof.artifactSHA256).toBe(createHash("sha256").update(readFileSync(value.artifact)).digest("hex")); expect(proof.records).toHaveLength(canonicalTree.entryCount);
      expect(Object.isFrozen(proof) && Object.isFrozen(proof.records) && Object.isFrozen(proof.records[0]) && Object.isFrozen(proof.bundleMarkers) && Object.isFrozen(proof.bundleMarkers.productionContract) && Object.isFrozen(proof.appleDouble)).toBe(true);
      const serialized = serializeExtractedAppTreeProof(proof), serializedProof = JSON.parse(serialized); expect(serialized).toMatch(/\n$/); expect(serializedProof.bundleMarkers.productionContract).toEqual(proof.bundleMarkers.productionContract); expect(serializedProof.bundleMarkers.sourceSHA).toBe(sourceSHA); expect(extractedAppTreeProofDigest(proof)).toMatch(/^[a-f0-9]{64}$/);
    }
  });
  it("fails closed on ambiguous plist bytes and invalid bundle markers", async () => {
    const invalid = [
      proofFixture("1.1.0", "<key>CFBundleName</key><string>A</string><key>CFBundleName</key><string>B</string>"),
      proofFixture("1.1.0", "", Buffer.from("bplist00hostile")),
      proofFixture("1.1.0", "", plist("1.1.0").replace(plistDoctype, '<!DOCTYPE plist [<!ENTITY x "hostile">]>')),
      proofFixture("1.1.0", "", Buffer.from(plist("1.1.0"), "utf16le")),
      proofFixture("1.1.0", "", plist("1.1.0").replace('encoding="UTF-8"', 'encoding="ISO-8859-1"')),
      proofFixture("1.1.0", "", plist("1.1.0").replace('encoding="UTF-8"', 'encoding="windows-1252"')),
      proofFixture("1.2.0"),
      proofFixture("1.1.0", "", plist("1.1.0").replace("com.electricsheephq.NeonDiffDesktop", "com.example.Wrong")),
      proofFixture("1.1.0", "", plist("1.1.0").replace("11091", "not-a-build"))
    ];
    for (const value of invalid) await expect(buildExtractedAppTreeProof(value.artifact, sourceSHA)).rejects.toThrow(/plist|marker/i);
  });
  it("rejects artifacts outside the exact BYO production contract", async () => {
    const mixedManaged = `${byoProductionMarkers}<key>NeonDiffManagedGitHubBrokerEnabled</key><true/>`;
    const presentManaged = `${byoProductionMarkers}<key>NeonDiffManagedGitHubBrokerEnabled</key><false/>`;
    const managedOrigin = `${byoProductionMarkers}<key>NeonDiffGitHubBrokerOrigin</key><string>https://neondiff-license.fly.dev</string>`;
    const invalid = [
      plist("1.1.0", "", defaultPublicKey, ""),
      plist("1.1.0", "", defaultPublicKey, byoProductionMarkers.replace("<true/>", "<false/>")),
      plist("1.1.0", "", defaultPublicKey, byoProductionMarkers.replace("paid-mac-beta-byo-v1", "paid-mac-beta-v1")),
      plist("1.1.0", "", defaultPublicKey, mixedManaged),
      plist("1.1.0", "", defaultPublicKey, presentManaged),
      plist("1.1.0", "", defaultPublicKey, managedOrigin)
    ];
    for (const info of invalid) await expect(buildExtractedAppTreeProof(proofFixture("1.1.0", "", info).artifact, sourceSHA)).rejects.toThrow(/production contract/i);
    const duplicateBYO = `${byoProductionMarkers}<key>NeonDiffBYOGitHubEnabled</key><true/>`;
    await expect(buildExtractedAppTreeProof(proofFixture("1.1.0", "", plist("1.1.0", "", defaultPublicKey, duplicateBYO)).artifact, sourceSHA)).rejects.toThrow(/plist/i);
  });
  it("rejects missing, malformed, duplicate, or mismatched artifact source identity", async () => {
    const invalid = [
      plist("1.1.0", "", defaultPublicKey, byoProductionMarkers, ""),
      plist("1.1.0", "", defaultPublicKey, byoProductionMarkers, sourceSHA.toUpperCase()),
      plist("1.1.0", "", defaultPublicKey, byoProductionMarkers, "f".repeat(40)),
      plist("1.1.0", `<key>NeonDiffSourceSHA</key><string>${sourceSHA}</string>`)
    ];
    for (const info of invalid) await expect(buildExtractedAppTreeProof(proofFixture("1.1.0", "", info).artifact, sourceSHA)).rejects.toThrow(/source|plist/i);
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
