import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readDesktopInfoPlistIdentity } from "../scripts/shared/desktop-info-plist.mjs";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("portable desktop Info.plist identity", () => {
  it("reads exact version strings without macOS-only PlistBuddy", () => {
    const app = mkdtempSync(join(tmpdir(), "neondiff-plist-"));
    roots.push(app);
    mkdirSync(join(app, "Contents"));
    writeFileSync(join(app, "Contents", "Info.plist"), `<?xml version="1.0"?>
<plist><dict>
<key>CFBundleShortVersionString</key><string>1.2.3</string>
<key>CFBundleVersion</key><string>42</string>
</dict></plist>`);
    expect(readDesktopInfoPlistIdentity(app)).toEqual({ shortVersion: "1.2.3", buildVersion: "42" });
  });

  it.each([
    ["malformed wrapper", `not a plist <key>CFBundleShortVersionString</key><string>1.2.3</string><key>CFBundleVersion</key><string>42</string>`],
    ["duplicate identity key", `<?xml version="1.0"?><plist><dict>
      <key>CFBundleShortVersionString</key><string>1.2.3</string>
      <key>CFBundleShortVersionString</key><string>9.9.9</string>
      <key>CFBundleVersion</key><string>42</string>
    </dict></plist>`],
    ["oversized identity", `<?xml version="1.0"?><plist><dict>
      <key>CFBundleShortVersionString</key><string>${"1".repeat(129)}</string>
      <key>CFBundleVersion</key><string>42</string>
    </dict></plist>`]
  ])("rejects %s input", (_, contents) => {
    const app = mkdtempSync(join(tmpdir(), "neondiff-plist-"));
    roots.push(app);
    mkdirSync(join(app, "Contents"));
    writeFileSync(join(app, "Contents", "Info.plist"), contents);
    expect(() => readDesktopInfoPlistIdentity(app)).toThrow(/malformed|invalid/i);
  });
});
