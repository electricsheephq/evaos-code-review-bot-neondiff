import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withExtractedDesktopApp } from "../scripts/lib/desktop-extracted-app-tree-proof.mjs";

const roots: string[] = [], python = "/usr/bin/python3";
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "neondiff-tree-proof-test-")); roots.push(root); const app = join(root, "NeonDiff.app");
  mkdirSync(join(app, "Contents", "MacOS"), { recursive: true }); writeFileSync(join(app, "Contents", "MacOS", "NeonDiffDesktop"), "desktop"); chmodSync(join(app, "Contents", "MacOS", "NeonDiffDesktop"), 0o755); writeFileSync(join(app, "Contents", "plain"), "plain"); symlinkSync("MacOS/NeonDiffDesktop", join(app, "Contents", "Current"));
  const artifact = join(root, "NeonDiff.zip"); execFileSync("zip", ["-qry", artifact, "NeonDiff.app"], { cwd: root }); return { root, artifact };
}
function archive(root: string, entries: Array<[string, string, number?]>) {
  const artifact = join(root, "hostile.zip"), code = "import sys,zipfile; z=zipfile.ZipFile(sys.argv[1],'w');\nfor x in sys.argv[2:]:\n n,b,*m=x.split('\\t'); i=zipfile.ZipInfo(n); i.external_attr=((int(m[0],8) if m else 0o100644)<<16); z.writestr(i,b.encode())\nz.close()";
  execFileSync(python, ["-I", "-c", code, artifact, ...entries.map((entry) => entry.join("\t"))]); return artifact;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("bounded extracted-app archive producer", () => {
  it("acquires one descriptor, hashes exact bytes, and preserves safe modes/symlinks", () => {
    const value = fixture(), digest = createHash("sha256").update(readFileSync(value.artifact)).digest("hex"); let seen = "";
    const result = withExtractedDesktopApp({ artifactPath: value.artifact }, ({ appPath, artifactSHA256 }) => { seen = appPath; expect(artifactSHA256).toBe(digest); expect(lstatSync(join(appPath, "Contents", "Current")).isSymbolicLink()).toBe(true); expect(readlinkSync(join(appPath, "Contents", "Current"))).toBe("MacOS/NeonDiffDesktop"); expect(statSync(join(appPath, "Contents", "MacOS", "NeonDiffDesktop")).mode & 0o111).toBe(0o111); expect(statSync(join(appPath, "Contents", "plain")).mode & 0o111).toBe(0); return artifactSHA256; });
    expect(result).toBe(digest); expect(() => lstatSync(seen)).toThrow();
  });
  it("fails closed on nofollow, acquisition, traversal, duplicate, special, and symlink-write-through inputs", () => {
    const value = fixture(), alias = join(value.root, "alias.zip"); symlinkSync(value.artifact, alias); expect(() => withExtractedDesktopApp({ artifactPath: alias }, () => null)).toThrow();
    const oversized = join(value.root, "oversized.zip"); writeFileSync(oversized, ""); truncateSync(oversized, 512 * 1024 * 1024 + 1); expect(() => withExtractedDesktopApp({ artifactPath: oversized }, () => null)).toThrow(/artifact bytes exceed bound/);
    for (const entries of [[ ["../outside", "x"] ], [["NeonDiff.app/Contents/a", "x"], ["NeonDiff.app/Contents/A", "y"]], [["NeonDiff.app/Contents/fifo", "x", "0010000"]], [["NeonDiff.app/Contents/Current", "../../outside", "0120777"], ["NeonDiff.app/Contents/Current/owned", "x"]]] as Array<Array<[string, string, string?]>>) expect(() => withExtractedDesktopApp({ artifactPath: archive(value.root, entries) }, () => null)).toThrow();
  });
  it("uses isolated absolute Python helpers despite PATH and module shadows", () => {
    const value = fixture(), shadow = mkdtempSync(join(tmpdir(), "neondiff-tree-proof-shadow-")); roots.push(shadow); for (const name of ["zipfile.py", "json.py", "plistlib.py", "unicodedata.py"]) writeFileSync(join(shadow, name), "raise RuntimeError('shadowed')\n");
    const previousPath = process.env.PATH, previousCwd = process.cwd(); process.env.PATH = `${shadow}:${previousPath ?? ""}`; process.chdir(shadow);
    try { expect(withExtractedDesktopApp({ artifactPath: value.artifact }, ({ artifactSHA256 }) => artifactSHA256)).toMatch(/^[a-f0-9]{64}$/); } finally { process.chdir(previousCwd); process.env.PATH = previousPath; }
  });
});
