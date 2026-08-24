import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withExtractedDesktopApp } from "../scripts/lib/desktop-extracted-app-tree-proof.mjs";

const root = mkdtempSync(join(tmpdir(), "neondiff-parentless-link-test-")), artifact = join(root, "parentless.zip");
try {
  const code = "import sys,zipfile; z=zipfile.ZipFile(sys.argv[1],'w');\nfor n,b,m in [('NeonDiff.app/Contents/file','payload',0o100644),('NeonDiff.app/Resources/Current','../Contents/file',0o120777)]:\n i=zipfile.ZipInfo(n); i.external_attr=m<<16; z.writestr(i,b.encode())\nz.close()";
  execFileSync("/usr/bin/python3", ["-I", "-c", code, artifact]);
  const digest = withExtractedDesktopApp({ artifactPath: artifact }, ({ appPath, artifactSHA256 }) => { assert.equal(readlinkSync(join(appPath, "Resources", "Current")), "../Contents/file"); return artifactSHA256; });
  assert.match(digest, /^[a-f0-9]{64}$/);
} finally { rmSync(root, { recursive: true, force: true }); }
