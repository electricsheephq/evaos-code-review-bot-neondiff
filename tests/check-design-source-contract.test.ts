import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectViolations } from "../scripts/check-design-source-contract.mjs";

// Focused regression coverage for the #611 design-source contract gate. Proves
// the checker fails red on each guarded violation and stays green on a clean
// doc set — including the negated-disclaimer case, so boundary language such as
// "no WebView product UI" is not false-failed as a retired-direction claim.

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const validDesignDoc = [
  "# NeonDiff design source of truth",
  "",
  "Captured: 2026-07-15",
  "Source: https://neondiff.com",
  "The unshipped redesign is rejected.",
  "",
  "## Design authority",
  "## Token table",
  "## Type system",
  "## Component translation",
  "## Neon budget",
  "## Forbidden clones",
  "## Light mode",
  "## Accessibility floors",
  ""
].join("\n");

const cleanGuardedDoc = "The native macOS app is the human first-run surface; the local HTML dashboard is an operator/diagnostic surface.\n";

// A clean fixture: complete design doc + three guarded docs with no
// retired-direction language. `overrides` replaces or deletes files by path.
function writeFixture(overrides: Record<string, string | null> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "neondiff-design-source-"));
  roots.push(root);
  const files: Record<string, string> = {
    "docs/design/live-site-design-source.md": validDesignDoc,
    "README.md": cleanGuardedDoc,
    "docs/SETUP.md": cleanGuardedDoc,
    "docs/neondiff-desktop.md": cleanGuardedDoc
  };
  for (const [path, value] of Object.entries(overrides)) {
    if (value === null) delete files[path];
    else files[path] = value;
  }
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

describe("design-source contract gate", () => {
  it("passes clean docs (green)", () => {
    expect(collectViolations(writeFixture())).toEqual([]);
  });

  it("fails when the design doc is missing", () => {
    const violations = collectViolations(writeFixture({ "docs/design/live-site-design-source.md": null }));
    expect(violations.some((v) => v.includes("design-source document is missing"))).toBe(true);
  });

  it("fails when a required heading is stripped", () => {
    const stripped = validDesignDoc.replace("## Light mode\n", "");
    const violations = collectViolations(writeFixture({ "docs/design/live-site-design-source.md": stripped }));
    expect(violations.some((v) => v.includes('missing required section "Light mode"'))).toBe(true);
  });

  it("fails when the rejected-direction statement is stripped", () => {
    const stripped = validDesignDoc.replace("The unshipped redesign is rejected.", "The unshipped redesign is retired.");
    const violations = collectViolations(writeFixture({ "docs/design/live-site-design-source.md": stripped }));
    expect(violations.some((v) => v.includes('the rejected-direction statement'))).toBe(true);
  });

  it.each([
    ["dashboard-as-first-run", "README.md", "The HTML dashboard is the first-run surface for everyone.\n"],
    ["browser-dashboard parity", "docs/SETUP.md", "The native app maintains browser-dashboard parity with the web build.\n"],
    ["affirmative WebView claim", "docs/neondiff-desktop.md", "The app embeds a WebView product surface for onboarding.\n"]
  ])("fails on reintroduced %s language", (_label, path, content) => {
    const violations = collectViolations(writeFixture({ [path]: content }));
    expect(violations.some((v) => v.startsWith(`${path}:`))).toBe(true);
  });

  it("passes a negated WebView disclaimer (boundary language, not a claim)", () => {
    const violations = collectViolations(
      writeFixture({ "docs/neondiff-desktop.md": "There is no WebView product UI; the app is native SwiftUI.\n" })
    );
    expect(violations).toEqual([]);
  });
});
