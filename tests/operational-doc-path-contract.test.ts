import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string): string => readFileSync(path, "utf8");

describe("operational documentation path contract", () => {
  it("keeps native customer adoption on the signed Desktop path", () => {
    const guide = read("apps/neondiff-desktop/docs/customer-adoption.md");
    expect(guide).toContain("Accounts/<account>/Bots/<bot>/config.local.json");
    expect(guide).toContain("state/reviews.sqlite");
    expect(guide).toContain("**Preview Start**");
    expect(guide).toContain("**Check for Updates**");
    expect(guide).toContain("signed last-known-good feed");
    expect(guide).toContain("one wrapper/helper worker pair");
    expect(guide).not.toContain("install-b0-worker-candidate.mjs");
    expect(guide).not.toContain("/Volumes/LEXAR");
  });

  it("guards the appcast evidence root", () => {
    const guide = read("apps/neondiff-desktop/docs/appcast-channels.md");
    expect(guide).toContain("${NEONDIFF_EVIDENCE_ROOT:?");
    expect(guide).not.toContain("/Volumes/LEXAR");
  });
});
