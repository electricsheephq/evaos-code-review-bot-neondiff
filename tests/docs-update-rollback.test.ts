import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string): string => readFileSync(path, "utf8");

describe("immutable Mac update and rollback documentation", () => {
  it("keeps signed app verification and appcast rollback fail-closed", () => {
    const guide = read("docs/mac-update-rollback.md");
    for (const text of ["shasum -a 256", "codesign --verify --deep --strict", "xcrun notarytool info", "xcrun stapler validate", "spctl -a -vv --type execute", "CFBundleShortVersionString", "CFBundleVersion", "SUFeedURL", "SUPublicEDKey", "install-b0-worker-candidate.mjs update", "install-b0-worker-candidate.mjs rollback", "--dry-run false --confirm true", "state/reviews.sqlite", "exactly one worker pair", "appcast cannot downgrade"]) expect(guide).toContain(text);
    expect(guide).not.toContain("/Volumes/");
    expect(guide).toContain("feed/channel only after");
  });

  it("removes the unsupported appcast downgrade wording and mounted path", () => {
    const guide = read("apps/neondiff-desktop/docs/appcast-channels.md");
    expect(guide).toContain("cannot downgrade");
    expect(guide).toContain("retained prior immutable artifact");
    expect(guide).not.toContain("latest to an earlier stable version");
    expect(guide).not.toContain("/Volumes/");
    expect(guide).toContain("${NEONDIFF_EVIDENCE_ROOT:?");
  });
});
