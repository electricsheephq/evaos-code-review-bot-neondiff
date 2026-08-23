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
    expect(guide).toContain("appcast cannot downgrade");
    expect(guide).toContain("accepted immutable signed/notarized");
    expect(guide).toContain("one wrapper/helper worker pair");
    expect(guide).not.toContain("install-b0-worker-candidate.mjs");
    expect(guide).not.toContain("/Volumes/LEXAR");
  });

  it("guards the appcast evidence root", () => {
    const guide = read("apps/neondiff-desktop/docs/appcast-channels.md");
    expect(guide).toContain("${NEONDIFF_EVIDENCE_ROOT:?");
    expect(guide).toContain("case \"$NEONDIFF_EVIDENCE_ROOT\" in /*)");
    expect(guide).toContain('in "$CHECKOUT_ROOT/"*)');
    expect(guide).not.toContain("/Volumes/LEXAR");
  });

  it("keeps legacy release operation portable and credential-file based", () => {
    const runbook = read("docs/beta-release-runbook.md");
    const governance = read("docs/release-governance.md");
    const operator = read("docs/skills/release-operator.md");
    const profiles = read("docs/repo-profiles.md");
    const legacy = [runbook, governance, operator, profiles].join("\n");

    expect(runbook).toContain("copy the absolute --config operand from the verified plist");
    expect(runbook).toContain("copy the absolute statePath from that config");
    expect(runbook).toContain('in "$NEONDIFF_RELEASE_CHECKOUT/"*)');
    expect(runbook).toContain("release checkout origin mismatch");
    expect(runbook).toContain("absolute `WorkingDirectory`");
    expect(runbook).toContain("`EnvironmentVariables`");
    expect(runbook).toContain("absolute private-key file path");
    expect(runbook).toContain("exactly one installed worker");
    expect(operator).toContain("${HOME:?HOME is required}");
    expect(operator).toContain('cd "$NEONDIFF_RELEASE_CHECKOUT"');
    expect(governance).toContain("source reset below cannot roll it back");
    expect(legacy).not.toContain("/Volumes/LEXAR");
  });
});
