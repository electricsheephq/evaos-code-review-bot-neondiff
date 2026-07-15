import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Contract guard for issue #611: the live production website
// (https://neondiff.com) is the single approved visual source for the native
// macOS app. This check fails the build if the design-source document is
// missing or stripped, or if retired browser-dashboard/WebView-parity language
// reappears in the public-facing product docs. Follows the style of
// scripts/check-public-claims.mjs (Node, no dependencies).
//
// `collectViolations(root)` is exported so the focused regression test
// (tests/check-design-source-contract.test.ts) can exercise the gate against
// fixture docs without spawning a subprocess; the CLI entrypoint below runs it
// against the repo root and exits non-zero on any violation.

const designDoc = "docs/design/live-site-design-source.md";

// Files that previously carried the retired "dashboard is the first-run
// product surface" / browser-parity direction. Only these three are scanned;
// eval and boundary docs legitimately keep parity disclaimers.
const guardedDocs = ["README.md", "docs/SETUP.md", "docs/neondiff-desktop.md"];

const requiredSubstrings = ["https://neondiff.com"];

const requiredLinePatterns = [/Captured: 2026-07-15/];

const requiredHeadings = [
  "Design authority",
  "Token table",
  "Type system",
  "Component translation",
  "Neon budget",
  "Forbidden clones",
  "Light mode",
  "Accessibility floors"
];

// Retired-direction language that must not reappear as an affirmative claim.
// `exempt` (optional) matches negated/boundary phrasing on the same line that
// is legitimate — e.g. "no WebView product UI" is a disclaimer of the rejected
// direction, not a reintroduction of it, so it must pass.
const forbiddenDocPatterns = [
  { pattern: /dashboard is the (human )?first-run/i },
  { pattern: /browser[- ]dashboard parity/i },
  {
    pattern: /webview/i,
    exempt: /\b(no|not|never|without|no longer|isn'?t|aren'?t|does not|do not|don'?t|drop(?:ped|s)?|reject(?:ed|s)?|avoid)\b[^.]*\bwebview\b/i
  }
];

export function collectViolations(root = process.cwd()) {
  const violations = [];

  // (A) + (C) design-source document must exist and stay complete.
  const designPath = join(root, designDoc);
  if (!existsSync(designPath)) {
    violations.push(`${designDoc}: design-source document is missing`);
  } else {
    const doc = readFileSync(designPath, "utf8");
    for (const needle of requiredSubstrings) {
      if (!doc.includes(needle)) {
        violations.push(`${designDoc}: missing required reference "${needle}"`);
      }
    }
    for (const pattern of requiredLinePatterns) {
      if (!pattern.test(doc)) {
        violations.push(`${designDoc}: missing required line matching ${pattern}`);
      }
    }
    for (const heading of requiredHeadings) {
      if (!doc.includes(heading)) {
        violations.push(`${designDoc}: missing required section "${heading}"`);
      }
    }
    // (C) the rejected-direction statement must survive.
    if (!doc.includes("rejected")) {
      violations.push(`${designDoc}: missing the rejected-direction statement ("rejected")`);
    }
  }

  // (B) retired-direction language must not reappear in the guarded product docs.
  for (const path of guardedDocs) {
    const full = join(root, path);
    if (!existsSync(full)) {
      violations.push(`${path}: guarded doc is missing`);
      continue;
    }
    const lines = readFileSync(full, "utf8").split("\n");
    lines.forEach((line, index) => {
      for (const { pattern, exempt } of forbiddenDocPatterns) {
        if (pattern.test(line) && !(exempt && exempt.test(line))) {
          violations.push(`${path}:${index + 1}: retired-direction language matches ${pattern}: ${line.trim()}`);
        }
      }
    });
  }

  return violations;
}

function main() {
  const violations = collectViolations();
  if (violations.length > 0) {
    console.error("design-source contract violations:");
    for (const violation of violations) {
      console.error(`  - ${violation}`);
    }
    process.exit(1);
  }
  console.log("live-site design-source contract ok");
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
